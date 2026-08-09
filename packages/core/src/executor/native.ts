import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';

import { canonicalJson, sha256Hex } from '../build-ir/canonical.js';
import { mapDiagnostics } from '../build-ir/rust-planner.js';
import {
  deadlineRemainingMs,
  interruptionReason,
  raceWithDeadline,
  throwIfInterrupted,
} from '../deadline.js';
import type {
  BuildAction,
  BuildIR,
  BuildPacks,
  MappedBuildDiagnostic,
  RawBuildDiagnostic,
  Sha256,
} from '../build-ir/types.js';
import { validateBuildIRForExecution } from '../build-ir/validate.js';
import {
  DEFAULT_LIMITS,
  type ExecResult,
  type SandboxExecutor,
} from '../sandbox/types.js';
import type {
  ActionCache,
  ActionExecutionResult,
  ActionOutputBlob,
  BuildExecutionOptions,
  BuildExecutionResult,
  BuildExecutor,
} from './types.js';
import {
  runNativeInternalAction,
  validateNativePostLinkActions,
} from './native-post-link.js';

const SHA256 = /^[a-f0-9]{64}$/;
const GCC_DIAGNOSTIC = /^(.*?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning|note):\s*(.*)$/;
export const CK_NATIVE_EXECUTOR_POLICY_IDENTITY = sha256Hex(
  'ck-native-executor-cache-policy-v4',
);

export interface NativeToolResolver {
  /** Stable resolver/tool-integrity identity folded into every Action cache key. */
  readonly policyIdentity?: Sha256;
  /** Resolve a logical IR tool id to a native executable. */
  resolve(tool: string, packs: BuildPacks): string | Promise<string>;
  /** Verify the complete host-private tool grant before any Action cache access. */
  verifyForExecution?(
    packs: BuildPacks,
    execution?: BuildExecutionOptions,
  ): void | Promise<void>;
  /**
   * Resolve the host-private execution grant for a tool. Implementations may
   * expose only roots selected from trusted server configuration; IR fields
   * are never mount sources.
   */
  resolveForExecution?(
    tool: string,
    packs: BuildPacks,
    execution?: BuildExecutionOptions,
  ): NativeToolResolution | Promise<NativeToolResolution>;
}

export interface NativeToolResolution {
  command: string;
  /** Host-private arguments inserted before the environment-neutral IR argv. */
  argumentsPrefix?: readonly string[];
  /** Optional script/launcher identity used to validate a read-only mount. */
  entrypoint?: string;
  /** Read-only dependency roots required by this verified native tool. */
  readOnlyPaths?: readonly string[];
}

export interface NativePackProvider {
  /**
   * Materialize verified Pack contents into logical workspace paths expected
   * by the IR. Host paths stay private to this adapter.
   */
  materialize(
    packs: BuildPacks,
    workspace: string,
    execution?: BuildExecutionOptions,
  ): void | Promise<void>;
}

export interface NativeActionRunnerContext {
  action: BuildAction;
  workspace: string;
  signal?: AbortSignal;
  deadlineAt?: number;
  readFile(path: string): Uint8Array;
  writeFile(path: string, bytes: Uint8Array): void;
}

export interface NativeActionRunnerResult {
  ok?: boolean;
  outputs?: ActionOutputBlob[];
  diagnostics?: RawBuildDiagnostic[];
  message?: string;
  cacheable?: boolean;
}

export interface NativeExecutorOptions {
  sandbox: SandboxExecutor;
  tools: NativeToolResolver;
  workspaceRoot: string;
  packs?: NativePackProvider;
  cache?: ActionCache;
  /** Trusted executor/resolver/materializer identity used to namespace Action cache entries. */
  policyIdentity?: Sha256;
  keepWorkspace?: boolean;
  parseDiagnostics?: (output: string, action: BuildAction) => RawBuildDiagnostic[];
  /**
   * Optional shared-contract validation performed after the local structural
   * check. Production callers use the Rust ck-build-core validator so native
   * and browser adapters reject the same serialized Build IR.
   */
  validateIR?: (ir: BuildIR, execution?: BuildExecutionOptions) => void | Promise<void>;
  /**
   * Compatibility/adapter hook used while an existing compiler is migrated
   * Action by Action. Returning `undefined` delegates the Action to the
   * logical-tool resolver below; this is useful for special CK Actions such
   * as `.ino` preprocessing while native compiler Actions remain standard.
   */
  runAction?: (context: NativeActionRunnerContext) => NativeActionRunnerResult | undefined | Promise<NativeActionRunnerResult | undefined>;
}

export class NativeExecutor implements BuildExecutor {
  readonly kind = 'native' as const;
  private readonly options: NativeExecutorOptions;
  private readonly policyIdentity: Sha256;

  constructor(options: NativeExecutorOptions) {
    const executorPolicyIdentity = options.policyIdentity ?? CK_NATIVE_EXECUTOR_POLICY_IDENTITY;
    if (!SHA256.test(executorPolicyIdentity)) {
      throw new TypeError('NativeExecutor policyIdentity must be a SHA-256 identity');
    }
    const toolPolicyIdentity = options.tools.policyIdentity;
    if (toolPolicyIdentity !== undefined && !SHA256.test(toolPolicyIdentity)) {
      throw new TypeError('Native tool resolver policyIdentity must be a SHA-256 identity');
    }
    this.options = options;
    this.policyIdentity = toolPolicyIdentity === undefined
      ? executorPolicyIdentity
      : sha256Hex(canonicalJson({
          kind: 'ck-native-executor-tool-policy',
          schemaVersion: 1,
          executorPolicyIdentity,
          toolPolicyIdentity,
        }));
  }

  async execute(ir: BuildIR, execution: BuildExecutionOptions = {}): Promise<BuildExecutionResult> {
    const started = Date.now();
    const completed: ActionExecutionResult[] = [];
    const allDiagnostics: MappedBuildDiagnostic[] = [];
    const initialInterruption = interruptedFailure(execution, completed, started);
    if (initialInterruption) return initialInterruption;
    const validation = validateBuildIRForExecution(ir);
    if (!validation.valid || !validation.value) {
      return failure('invalid_ir', validation.errors.map((error) => (
        `${error.path || 'ir'}: ${error.message}`
      )).join('; '), completed, started);
    }
    if (this.options.validateIR) {
      try {
        await raceWithDeadline(
          Promise.resolve().then(() => this.options.validateIR!(validation.value!, execution)),
          execution,
        );
        const interrupted = interruptedFailure(execution, completed, started);
        if (interrupted) return interrupted;
      } catch (error) {
        const interrupted = interruptedFailure(execution, completed, started);
        if (interrupted) return interrupted;
        return failure('invalid_ir', `shared Build IR validation failed: ${errorMessage(error)}`, completed, started);
      }
    }

    const normalized = validation.value;
    const postLinkError = validateNativePostLinkActions(normalized.graph.actions);
    if (postLinkError) {
      return failure('invalid_ir', postLinkError, completed, started);
    }

    if (this.options.tools.verifyForExecution) {
      try {
        await raceWithDeadline(
          Promise.resolve().then(() => (
            this.options.tools.verifyForExecution!(normalized.packs, execution)
          )),
          execution,
        );
      } catch (error) {
        const interrupted = interruptedFailure(execution, completed, started);
        if (interrupted) return interrupted;
        return failure('tool', `Native tool integrity preflight failed: ${errorMessage(error)}`, completed, started);
      }
    }
    const toolPreflightInterruption = interruptedFailure(execution, completed, started);
    if (toolPreflightInterruption) return toolPreflightInterruption;

    mkdirSync(this.options.workspaceRoot, { recursive: true });
    const workspace = mkdtempSync(resolve(this.options.workspaceRoot, 'ck-native-'));
    try {
      for (const file of normalized.project.files) {
        throwIfInterrupted(execution);
        const bytes = new TextEncoder().encode(file.content);
        if (sha256Hex(bytes) !== file.sha256) {
          return failure('integrity', `project file hash mismatch: ${file.path}`, completed, started);
        }
        writeWorkspaceFile(workspace, file.path, bytes);
      }
      if (this.options.packs) {
        await raceWithDeadline(
          Promise.resolve().then(() => this.options.packs!.materialize(normalized.packs, workspace, execution)),
          execution,
        );
      }
      const materializeInterruption = interruptedFailure(execution, completed, started);
      if (materializeInterruption) return materializeInterruption;

      const nonCacheableActions = new Set<string>();
      for (const action of topologicalActions(normalized)) {
        const actionInterruption = interruptedFailure(execution, completed, started, action.id);
        if (actionInterruption) return actionInterruption;

        const actionStarted = Date.now();
        const dependencyIsNonCacheable = action.dependencies.some((id) => nonCacheableActions.has(id));
        let actionIsCacheable = !dependencyIsNonCacheable;
        const inputError = verifyInputs(workspace, action);
        if (inputError) return failure('integrity', inputError, completed, started, action.id);

        const cacheKey = this.effectiveCacheKey(action);
        const cachedEntry = dependencyIsNonCacheable
          ? null
          : await this.readCache(action, cacheKey, workspace, execution);
        const cacheInterruption = interruptedFailure(execution, completed, started, action.id);
        if (cacheInterruption) return cacheInterruption;
        if (cachedEntry) {
          allDiagnostics.push(...cachedEntry.diagnostics);
          const result = actionResult(action, cachedEntry.outputs, true, Date.now() - actionStarted);
          completed.push(result);
          execution.onProgress?.({
            completed: completed.length,
            total: normalized.graph.actions.length,
            action,
            cached: true,
          });
          continue;
        }

        // Compilers and archivers do not create nested output directories
        // themselves (GCC also emits a sibling `.d` file for `-MMD`). The
        // Action contract declares every output path, so prepare its parent
        // directories before invoking the host tool.
        try {
          for (const output of action.outputs) {
            mkdirSync(resolve(workspacePath(workspace, output.path), '..'), { recursive: true });
          }
        } catch (error) {
          return failure('integrity', errorMessage(error), completed, started, action.id);
        }

        const actionRunner = action.tool === 'ck:copy'
          ? runNativeInternalAction
          : this.options.runAction;
        if (actionRunner) {
          let custom: NativeActionRunnerResult | undefined;
          try {
            const limited = await raceWithDeadline(
              runCustomActionWithLimits(
                actionRunner,
                {
                  action,
                  workspace,
                  readFile: (path) => new Uint8Array(readFileSync(workspacePath(workspace, path))),
                  writeFile: (path, bytes) => writeWorkspaceFile(workspace, path, bytes),
                  deadlineAt: execution.deadlineAt,
                },
                execution.signal,
              ),
              execution,
            );
            if (limited.status === 'completed') custom = limited.result;
            else if (limited.status === 'cancelled') {
              return interruptedFailure(execution, completed, started, action.id)
                ?? failure('cancelled', 'build execution was cancelled', completed, started, action.id);
            } else {
              return failure('timeout', `action ${action.id} timed out`, completed, started, action.id);
            }
          } catch (error) {
            const interrupted = interruptedFailure(execution, completed, started, action.id);
            if (interrupted) return interrupted;
            return failure('internal', errorMessage(error), completed, started, action.id);
          }
          const customInterruption = interruptedFailure(execution, completed, started, action.id);
          if (customInterruption) return customInterruption;
          if (custom !== undefined) {
            const diagnostics = await mapDiagnostics(
              custom.diagnostics ?? [],
              normalized.diagnosticMap,
              execution,
            );
            const diagnosticInterruption = interruptedFailure(execution, completed, started, action.id);
            if (diagnosticInterruption) return diagnosticInterruption;
            allDiagnostics.push(...diagnostics);
            if (custom.ok === false) {
              return {
                ...failure('compile', custom.message ?? `action ${action.id} failed`, completed, started, action.id),
                diagnostics,
              };
            }
            let outputs: ActionOutputBlob[];
            try {
              outputs = custom.outputs?.length
                ? materializeRunnerOutputs(workspace, action, custom.outputs)
                : readActionOutputs(workspace, action);
            } catch (error) {
              return failure('integrity', errorMessage(error), completed, started, action.id);
            }
            const outputLimitError = verifyOutputLimit(action, outputs);
            if (outputLimitError) {
              return failure('resource_limit', outputLimitError, completed, started, action.id);
            }
            if (custom.cacheable === false) actionIsCacheable = false;
            if (actionIsCacheable) {
              if (this.options.cache) {
                await raceWithDeadline(
                  Promise.resolve().then(() => this.options.cache!.put({
                    actionKey: cacheKey, outputs, diagnostics,
                  })),
                  execution,
                );
              }
              const cacheWriteInterruption = interruptedFailure(execution, completed, started, action.id);
              if (cacheWriteInterruption) return cacheWriteInterruption;
            }
            if (!actionIsCacheable) nonCacheableActions.add(action.id);
            const result = actionResult(action, outputs, false, Date.now() - actionStarted);
            completed.push(result);
            execution.onProgress?.({ completed: completed.length, total: normalized.graph.actions.length, action, cached: false });
            continue;
          }
        }

        let toolResolution: NormalizedNativeToolResolution;
        try {
          const resolvedTool = await raceWithDeadline(
            Promise.resolve().then(() => (
                this.options.tools.resolveForExecution
                ? this.options.tools.resolveForExecution(action.tool, normalized.packs, execution)
                : this.options.tools.resolve(action.tool, normalized.packs)
            )),
            execution,
          );
          toolResolution = normalizeNativeToolResolution(resolvedTool, action.tool);
        } catch (error) {
          const interrupted = interruptedFailure(execution, completed, started, action.id);
          if (interrupted) return interrupted;
          return failure('tool', errorMessage(error), completed, started, action.id);
        }

        let executionResult: ExecResult;
        try {
          const actionTimeoutMs = action.resourceLimits?.cpuMs ?? DEFAULT_LIMITS.cpuSeconds * 1_000;
          executionResult = await this.options.sandbox.exec({
            command: toolResolution.command,
            args: [...toolResolution.argumentsPrefix, ...action.arguments],
            cwd: workspace,
            timeoutMs: execution.deadlineAt === undefined
              ? actionTimeoutMs
              : Math.max(1, Math.min(actionTimeoutMs, deadlineRemainingMs(execution.deadlineAt))),
            limits: {
              memoryBytes: action.resourceLimits?.memoryBytes ?? DEFAULT_LIMITS.memoryBytes,
              cpuSeconds: Math.max(1, Math.ceil((action.resourceLimits?.cpuMs ?? DEFAULT_LIMITS.cpuSeconds * 1_000) / 1_000)),
              fileSizeBytes: action.resourceLimits?.outputBytes ?? DEFAULT_LIMITS.fileSizeBytes,
              processes: DEFAULT_LIMITS.processes,
            },
            env: { ...action.environment },
            readOnlyPaths: [...toolResolution.readOnlyPaths],
            readWritePaths: [workspace],
            signal: execution.signal,
          });
        } catch (error) {
          const interrupted = interruptedFailure(execution, completed, started, action.id);
          if (interrupted) return interrupted;
          return failure('internal', errorMessage(error), completed, started, action.id);
        }

        const commandInterruption = interruptedFailure(execution, completed, started, action.id);
        if (commandInterruption) return commandInterruption;

        const rawOutput = `${executionResult.stderr}\n${executionResult.stdout}`;
        const diagnostics = await mapDiagnostics(
          (this.options.parseDiagnostics ?? parseGccDiagnostics)(rawOutput, action),
          normalized.diagnosticMap,
          execution,
        );
        const diagnosticInterruption = interruptedFailure(execution, completed, started, action.id);
        if (diagnosticInterruption) return diagnosticInterruption;
        if (executionResult.code !== 0 || executionResult.timedOut || executionResult.truncated) {
          const reason = executionResult.timedOut
            ? 'timeout'
            : executionResult.truncated
              ? 'resource_limit'
              : 'compile';
          return {
            ...failure(reason, summarizeFailure(action, executionResult), completed, started, action.id),
            diagnostics,
          };
        }

        let outputs: ActionOutputBlob[];
        try {
          outputs = readActionOutputs(workspace, action);
        } catch (error) {
          return failure('integrity', errorMessage(error), completed, started, action.id);
        }
        allDiagnostics.push(...diagnostics);
        if (actionIsCacheable && this.options.cache) {
          await raceWithDeadline(
            Promise.resolve().then(() => this.options.cache!.put({
              actionKey: cacheKey, outputs, diagnostics,
            })),
            execution,
          );
        }
        const cacheWriteInterruption = interruptedFailure(execution, completed, started, action.id);
        if (cacheWriteInterruption) return cacheWriteInterruption;
        if (!actionIsCacheable) nonCacheableActions.add(action.id);
        const result = actionResult(action, outputs, false, Date.now() - actionStarted);
        completed.push(result);
        execution.onProgress?.({
          completed: completed.length,
          total: normalized.graph.actions.length,
          action,
          cached: false,
        });
      }

      const graphInterruption = interruptedFailure(execution, completed, started);
      if (graphInterruption) return graphInterruption;
      const artifacts = normalized.artifacts.map((artifact) => {
        throwIfInterrupted(execution);
        const path = workspacePath(workspace, artifact.path);
        if (!existsSync(path)) throw new Error(`build artifact is missing: ${artifact.path}`);
        const bytes = new Uint8Array(readFileSync(path));
        return {
          ...artifact,
          bytes,
          size: bytes.byteLength,
          sha256: sha256Hex(bytes),
        };
      });
      const artifactInterruption = interruptedFailure(execution, completed, started);
      if (artifactInterruption) return artifactInterruption;
      return {
        status: 'success',
        executor: this.kind,
        actions: completed,
        artifacts,
        diagnostics: allDiagnostics,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      const interrupted = interruptedFailure(execution, completed, started);
      if (interrupted) return interrupted;
      return failure('internal', errorMessage(error), completed, started);
    } finally {
      if (!this.options.keepWorkspace) rmSync(workspace, { recursive: true, force: true });
    }
  }

  private async readCache(
    action: BuildAction,
    cacheKey: Sha256,
    workspace: string,
    execution: BuildExecutionOptions,
  ): Promise<{ outputs: ActionOutputBlob[]; diagnostics: MappedBuildDiagnostic[] } | null> {
    if (!this.options.cache) return null;
    const entry = await raceWithDeadline(
      Promise.resolve().then(() => this.options.cache!.get(cacheKey)),
      execution,
    );
    if (!entry || entry.actionKey !== cacheKey) return null;
    const expectedOutputs = new Map(action.outputs.map((output) => [output.path, output]));
    const expected = [...expectedOutputs.keys()].sort();
    const actual = entry.outputs.map((output) => output.path).sort();
    if (expected.length !== actual.length || expected.some((path, index) => path !== actual[index])) return null;
    for (const output of entry.outputs) {
      throwIfInterrupted(execution);
      if (!SHA256.test(output.sha256) || sha256Hex(output.bytes) !== output.sha256) return null;
      const declaredSha256 = expectedOutputs.get(output.path)?.sha256;
      if (declaredSha256 !== undefined && output.sha256 !== declaredSha256) return null;
    }
    const diagnostics = normalizeCachedDiagnostics(entry.diagnostics);
    if (diagnostics === null) return null;
    for (const output of entry.outputs) {
      throwIfInterrupted(execution);
      writeWorkspaceFile(workspace, output.path, output.bytes);
    }
    return {
      outputs: entry.outputs.map((output) => ({ ...output, bytes: new Uint8Array(output.bytes) })),
      diagnostics,
    };
  }

  private effectiveCacheKey(action: BuildAction): Sha256 {
    return sha256Hex(canonicalJson({
      kind: 'ck-action-execution-key',
      schemaVersion: 1,
      actionKey: action.cacheKey,
      policyIdentity: this.policyIdentity,
    }));
  }
}

interface NormalizedNativeToolResolution {
  command: string;
  argumentsPrefix: string[];
  entrypoint?: string;
  readOnlyPaths: string[];
}

/**
 * Validate a resolver-issued mount grant before it reaches a sandbox. A
 * mounted root must be a narrow, existing ancestor of the executable or its
 * trusted script entrypoint. This prevents a resolver selected by logical IR
 * tool ids from attaching an unrelated host directory.
 */
export function normalizeNativeToolResolution(
  value: string | NativeToolResolution,
  tool: string,
): NormalizedNativeToolResolution {
  const command = typeof value === 'string' ? value : value?.command;
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError(`tool resolver returned no command for ${tool}`);
  }
  const requested = typeof value === 'string' ? [] : value.readOnlyPaths ?? [];
  const requestedPrefix = typeof value === 'string' ? [] : value.argumentsPrefix ?? [];
  const requestedEntrypoint = typeof value === 'string' ? undefined : value.entrypoint;
  if (!Array.isArray(requested)) {
    throw new TypeError(`native tool read-only roots must be an array: ${tool}`);
  }
  if (!Array.isArray(requestedPrefix)
    || requestedPrefix.some((argument) => typeof argument !== 'string')) {
    throw new TypeError(`native tool argument prefix must be an array of strings: ${tool}`);
  }
  let argumentsPrefix = [...requestedPrefix];
  let entrypointPath: string | undefined;
  if (requestedEntrypoint !== undefined) {
    if (typeof requestedEntrypoint !== 'string' || !isAbsolute(requestedEntrypoint)) {
      throw new TypeError(`native tool entrypoint must be absolute: ${tool}`);
    }
    entrypointPath = verifiedRegularPath(requestedEntrypoint, `native tool entrypoint ${tool}`);
    const entrypointIndex = argumentsPrefix.findIndex((argument) => (
      isAbsolute(argument) && resolve(argument) === resolve(requestedEntrypoint)
    ));
    if (entrypointIndex >= 0) argumentsPrefix[entrypointIndex] = entrypointPath;
    else if (!isAbsolute(command) || resolve(command) !== resolve(requestedEntrypoint)) {
      throw new TypeError(`native tool entrypoint is not its command or argument prefix: ${tool}`);
    }
  }
  if (requested.length === 0) return {
    command,
    argumentsPrefix,
    ...(entrypointPath === undefined ? {} : { entrypoint: entrypointPath }),
    readOnlyPaths: [],
  };

  const commandPath = isAbsolute(command)
    ? verifiedRegularPath(command, `native tool command ${tool}`)
    : undefined;
  if (!commandPath && !entrypointPath) {
    throw new TypeError(`native tool command must be absolute when requesting mounts: ${tool}`);
  }
  const seen = new Set<string>();
  const readOnlyPaths: string[] = [];
  for (const requestedRoot of requested) {
    if (typeof requestedRoot !== 'string' || !isAbsolute(requestedRoot)) {
      throw new TypeError(`native tool read-only root must be absolute: ${tool}`);
    }
    const root = verifiedDirectoryPath(requestedRoot, `native tool read-only root ${tool}`);
    if (isBroadNativeToolRoot(root)) {
      throw new TypeError(`native tool read-only root is too broad: ${tool}`);
    }
    if ((!commandPath || !pathContains(root, commandPath))
      && (!entrypointPath || !pathContains(root, entrypointPath))) {
      throw new TypeError(`native tool command or entrypoint is outside its approved read-only root: ${tool}`);
    }
    const key = nativePathObjectKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    readOnlyPaths.push(root);
  }
  return {
    command: commandPath ?? command,
    argumentsPrefix,
    ...(entrypointPath === undefined ? {} : { entrypoint: entrypointPath }),
    readOnlyPaths,
  };
}

function verifiedRegularPath(path: string, label: string): string {
  const absolute = resolve(path);
  let stat;
  try { stat = lstatSync(absolute); } catch { throw new TypeError(`${label} does not exist: ${path}`); }
  if (!stat.isFile()) throw new TypeError(`${label} is not a regular file: ${path}`);
  return realpathSync(absolute);
}

function verifiedDirectoryPath(path: string, label: string): string {
  const absolute = resolve(path);
  let stat;
  try { stat = lstatSync(absolute); } catch { throw new TypeError(`${label} does not exist: ${path}`); }
  if (!stat.isDirectory()) throw new TypeError(`${label} is not a directory: ${path}`);
  return realpathSync(absolute);
}

interface NativePathObjectIdentity {
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
}

function nativePathIdentity(path: string): NativePathObjectIdentity {
  let canonicalPath: string;
  try { canonicalPath = realpathSync(resolve(path)); } catch {
    throw new TypeError(`native tool path cannot be resolved: ${path}`);
  }
  let stat;
  try { stat = lstatSync(canonicalPath, { bigint: true }); } catch {
    throw new TypeError(`native tool path does not exist: ${path}`);
  }
  return { canonicalPath, dev: stat.dev, ino: stat.ino };
}

function nativePathObjectKey(path: string): string {
  const identity = nativePathIdentity(path);
  return `${identity.dev.toString(16)}:${identity.ino.toString(16)}`;
}

function pathContains(root: string, path: string): boolean {
  const rootIdentity = nativePathIdentity(root);
  let current = nativePathIdentity(path);
  const visited = new Set<string>();
  for (;;) {
    if (current.dev === rootIdentity.dev && current.ino === rootIdentity.ino) return true;
    const key = `${current.dev.toString(16)}:${current.ino.toString(16)}`;
    if (visited.has(key)) return false;
    visited.add(key);
    const parent = dirname(current.canonicalPath);
    if (parent === current.canonicalPath) return false;
    current = nativePathIdentity(parent);
  }
}

function isBroadNativeToolRoot(path: string): boolean {
  const root = parse(path).root;
  if (path === root) return true;
  return process.platform !== 'win32' && path === '/opt';
}

type CustomActionLimitResult =
  | { status: 'completed'; result: NativeActionRunnerResult | undefined }
  | { status: 'cancelled' | 'timeout' };

async function runCustomActionWithLimits(
  runAction: NonNullable<NativeExecutorOptions['runAction']>,
  context: Omit<NativeActionRunnerContext, 'signal'>,
  externalSignal?: AbortSignal,
): Promise<CustomActionLimitResult> {
  const controller = new AbortController();
  const cpuMs = context.action.resourceLimits?.cpuMs ?? DEFAULT_LIMITS.cpuSeconds * 1_000;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;
  const interrupted = new Promise<CustomActionLimitResult>((resolveInterrupted) => {
    onExternalAbort = () => {
      controller.abort();
      resolveInterrupted({ status: 'cancelled' });
    };
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    timeout = setTimeout(() => {
      controller.abort();
      resolveInterrupted({ status: 'timeout' });
    }, cpuMs);
  });
  const running = Promise.resolve()
    .then(() => runAction({ ...context, signal: controller.signal }))
    .then((result): CustomActionLimitResult => ({ status: 'completed', result }));
  try {
    return await Promise.race([running, interrupted]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

function verifyOutputLimit(action: BuildAction, outputs: readonly ActionOutputBlob[]): string | null {
  const limit = action.resourceLimits?.outputBytes;
  if (limit === undefined) return null;
  const size = outputs.reduce((total, output) => total + output.bytes.byteLength, 0);
  return size > limit
    ? `action ${action.id} produced ${size} bytes, exceeding its ${limit} byte output limit`
    : null;
}

function normalizeCachedDiagnostics(
  diagnostics: readonly MappedBuildDiagnostic[] | undefined,
): MappedBuildDiagnostic[] | null {
  if (diagnostics === undefined) return [];
  if (!Array.isArray(diagnostics)) return null;
  const normalized: MappedBuildDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (!diagnostic || !['error', 'warning', 'info'].includes(diagnostic.severity)
      || typeof diagnostic.file !== 'string' || !positiveInteger(diagnostic.line)
      || (diagnostic.column !== undefined && !positiveInteger(diagnostic.column))
      || typeof diagnostic.message !== 'string'
      || (diagnostic.raw !== undefined && typeof diagnostic.raw !== 'string')
      || typeof diagnostic.sourceFile !== 'string' || !positiveInteger(diagnostic.sourceLine)
      || (diagnostic.sourceColumn !== undefined && !positiveInteger(diagnostic.sourceColumn))
      || (diagnostic.generatedFile !== undefined && typeof diagnostic.generatedFile !== 'string')
      || (diagnostic.generatedLine !== undefined && !positiveInteger(diagnostic.generatedLine))
      || (diagnostic.generatedColumn !== undefined && !positiveInteger(diagnostic.generatedColumn))
      || typeof diagnostic.fromGenerated !== 'boolean') return null;
    normalized.push({ ...diagnostic });
  }
  return normalized;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function parseGccDiagnostics(output: string): RawBuildDiagnostic[] {
  const diagnostics: RawBuildDiagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = GCC_DIAGNOSTIC.exec(raw);
    if (!match) continue;
    const label = match[4] ?? 'error';
    diagnostics.push({
      severity: label === 'warning' ? 'warning' : label === 'note' ? 'info' : 'error',
      file: normalizeDiagnosticPath(match[1] ?? ''),
      line: Number(match[2]),
      ...(match[3] === undefined ? {} : { column: Number(match[3]) }),
      message: match[5] ?? raw,
      raw,
    });
  }
  return diagnostics;
}

function topologicalActions(ir: BuildIR): BuildAction[] {
  const byId = new Map(ir.graph.actions.map((action) => [action.id, action] as const));
  const result: BuildAction[] = [];
  const visited = new Set<string>();
  const visit = (action: BuildAction): void => {
    if (visited.has(action.id)) return;
    for (const dependency of action.dependencies) visit(byId.get(dependency)!);
    visited.add(action.id);
    result.push(action);
  };
  for (const action of ir.graph.actions) visit(action);
  return result;
}

function verifyInputs(workspace: string, action: BuildAction): string | null {
  for (const input of action.inputs) {
    const path = workspacePath(workspace, input.path);
    if (!existsSync(path)) return `action ${action.id} input is missing: ${input.path}`;
    if (input.sha256) {
      const actual = sha256Hex(new Uint8Array(readFileSync(path)));
      if (actual !== input.sha256) return `action ${action.id} input hash mismatch: ${input.path}`;
    }
  }
  return null;
}

function readActionOutputs(workspace: string, action: BuildAction): ActionOutputBlob[] {
  return action.outputs.map((output) => {
    const path = workspacePath(workspace, output.path);
    if (!existsSync(path)) throw new Error(`action ${action.id} did not produce ${output.path}`);
    const bytes = new Uint8Array(readFileSync(path));
    const sha256 = sha256Hex(bytes);
    if (output.sha256 !== undefined && output.sha256 !== sha256) {
      throw new Error(`action ${action.id} output contract mismatch: ${output.path}`);
    }
    return { path: output.path, bytes, sha256 };
  });
}

function materializeRunnerOutputs(workspace: string, action: BuildAction, outputs: ActionOutputBlob[]): ActionOutputBlob[] {
  const expected = new Map(action.outputs.map((output) => [output.path, output]));
  const seen = new Set<string>();
  for (const output of outputs) {
    const declared = expected.get(output.path);
    if (!declared || seen.has(output.path)) throw new Error(`action ${action.id} returned an unexpected output: ${output.path}`);
    if (sha256Hex(output.bytes) !== output.sha256) throw new Error(`action ${action.id} output hash mismatch: ${output.path}`);
    if (declared.sha256 !== undefined && declared.sha256 !== output.sha256) {
      throw new Error(`action ${action.id} output contract mismatch: ${output.path}`);
    }
    seen.add(output.path);
    writeWorkspaceFile(workspace, output.path, output.bytes);
  }
  if (seen.size !== expected.size) throw new Error(`action ${action.id} returned an incomplete output set`);
  return outputs.map((output) => ({ ...output, bytes: new Uint8Array(output.bytes) }));
}

function writeWorkspaceFile(workspace: string, logicalPath: string, bytes: Uint8Array): void {
  const path = workspacePath(workspace, logicalPath);
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
}

function workspacePath(workspace: string, logicalPath: string): string {
  if (!logicalPath || logicalPath.includes('\\') || logicalPath.startsWith('/') || /^[A-Za-z]:/.test(logicalPath)) {
    throw new TypeError(`executor path must be a relative POSIX path: ${logicalPath}`);
  }
  const segments = logicalPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError(`executor path contains an invalid segment: ${logicalPath}`);
  }
  const root = resolve(workspace);
  const path = resolve(root, ...segments);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new TypeError(`executor path escapes workspace: ${logicalPath}`);
  return path;
}

function actionResult(
  action: BuildAction,
  outputs: ActionOutputBlob[],
  cached: boolean,
  durationMs: number,
): ActionExecutionResult {
  return {
    actionId: action.id,
    actionKey: action.cacheKey,
    cached,
    durationMs,
    outputs: outputs.map(({ path, sha256, bytes }) => ({ path, sha256, size: bytes.byteLength })),
  };
}

function failure(
  reason: Extract<BuildExecutionResult, { status: 'error' }>['reason'],
  message: string,
  actions: ActionExecutionResult[],
  started: number,
  actionId?: string,
): Extract<BuildExecutionResult, { status: 'error' }> {
  return {
    status: 'error',
    executor: 'native',
    ...(actionId === undefined ? {} : { actionId }),
    reason,
    message,
    actions,
    diagnostics: [],
    durationMs: Date.now() - started,
  };
}

function interruptedFailure(
  execution: BuildExecutionOptions,
  actions: ActionExecutionResult[],
  started: number,
  actionId?: string,
): Extract<BuildExecutionResult, { status: 'error' }> | null {
  const reason = interruptionReason(execution);
  if (!reason) return null;
  return failure(
    reason,
    reason === 'timeout'
      ? 'compile job wall-clock deadline exceeded'
      : 'build execution was cancelled',
    actions,
    started,
    actionId,
  );
}

function summarizeFailure(action: BuildAction, result: ExecResult): string {
  if (result.timedOut) return `action ${action.id} timed out`;
  if (result.truncated) return `action ${action.id} exceeded its output limit`;
  return `action ${action.id} failed with exit code ${String(result.code)}`;
}

function normalizeDiagnosticPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
