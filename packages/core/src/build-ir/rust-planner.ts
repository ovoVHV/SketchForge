import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type {
  ActionGraph,
  BuildAction,
  BuildActionDraft,
  BuildIR,
  BuildIRInput,
  DiagnosticMap,
  DiagnosticMapEntry,
  LibraryPackRef,
  LibraryPackSet,
  LibraryResolutionInput,
  MappedBuildDiagnostic,
  PlatformPackRef,
  ProjectFileInput,
  ProjectSnapshot,
  RawBuildDiagnostic,
  TargetInput,
  TargetSpec,
} from './types.js';
import type { BuildActionPlan, BuildPlannerInput } from './planner.js';
import type {
  ResolvePlatformManifestInput,
  ResolvedPlatformManifest,
} from '../platform-pack/types.js';
import { resolveLibraries as validateLibraryPacks } from './builder.js';
import { sha256Hex } from './canonical.js';
import {
  DeadlineExceededError,
  deadlineRemainingMs,
  interruptionError,
  interruptionReason,
  throwIfInterrupted,
  type DeadlineOptions,
} from '../deadline.js';

type RustPlannerOperation =
  | 'resolve-project'
  | 'resolve-target'
  | 'resolve-platform'
  | 'resolve-platform-manifest'
  | 'resolve-libraries'
  | 'create-action-graph'
  | 'create-build-ir'
  | 'plan-build-actions'
  | 'plan-build-ir'
  | 'calculate-action-keys'
  | 'map-diagnostics'
  | 'migrate-build-ir'
  | 'validate-build-ir';

interface RustPlannerBackend {
  invoke(operation: RustPlannerOperation, input: string, options?: DeadlineOptions): Promise<string>;
}

interface RustWasmBindings {
  initSync(input: { module: Uint8Array }): unknown;
  resolveProject(input: string): string;
  resolveTarget(input: string): string;
  resolvePlatform(input: string): string;
  resolveLibraries(input: string): string;
  createActionGraph(input: string): string;
  createBuildIR(input: string): string;
  planBuildActions(input: string): string;
  planBuildIR(input: string): string;
  resolvePlatformManifest(input: string): string;
  calculateActionKeys(input: string): string;
  mapDiagnostics(input: string): string;
  migrateBuildIR(input: string): string;
  validateBuildIR(input: string): void;
}

const MAX_NATIVE_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_NATIVE_ERROR_BYTES = 1024 * 1024;
const NATIVE_TIMEOUT_MS = 120_000;
let backendPromise: Promise<RustPlannerBackend> | undefined;

async function loadBackend(): Promise<RustPlannerBackend> {
  if (!backendPromise) backendPromise = createBackend();
  return backendPromise;
}

async function createBackend(): Promise<RustPlannerBackend> {
  const mode = process.env.AF_CK_BUILD_CORE_BACKEND?.trim().toLowerCase() || 'auto';
  if (!['auto', 'native', 'wasm'].includes(mode)) {
    throw new TypeError(`unsupported AF_CK_BUILD_CORE_BACKEND: ${mode}`);
  }
  if (mode !== 'wasm') {
    const executable = await resolveNativeExecutable();
    if (executable) return createNativeBackend(executable);
    if (mode === 'native') {
      throw new Error('AF_CK_BUILD_CORE_BACKEND=native but the ck-build-core executable is unavailable');
    }
  }
  return loadWasmBackend();
}

async function resolveNativeExecutable(): Promise<string | null> {
  const configured = process.env.AF_CK_BUILD_CORE_NATIVE?.trim();
  if (configured) {
    try {
      await access(configured, constants.F_OK);
      return configured;
    } catch {
      return null;
    }
  }

  const executableName = `ck-build-core${process.platform === 'win32' ? '.exe' : ''}`;
  const bundledCandidates = [
    {
      path: fileURLToPath(new URL(
        `../../native/${process.platform}-${process.arch}/${executableName}`,
        import.meta.url,
      )),
      requiresManifest: true,
    },
    {
      // Keep the original flat layout as a transition path for local bundles.
      path: fileURLToPath(new URL(`../../native/${executableName}`, import.meta.url)),
      requiresManifest: false,
    },
  ];
  for (const candidate of bundledCandidates) {
    try {
      await access(candidate.path, constants.F_OK);
    } catch {
      continue;
    }
    try {
      await verifyBundledNativeArtifact(candidate.path, candidate.requiresManifest);
      return candidate.path;
    } catch (error) {
      if (candidate.requiresManifest) {
        throw new Error('bundled ck-build-core native artifact failed integrity verification', { cause: error });
      }
      // The flat layout is a local transition path; an invalid one is ignored
      // so package upgrades can still use the shared WASM backend.
    }
  }
  return null;
}

interface NativeArtifactManifest {
  schemaVersion: 1;
  artifacts: Array<{
    platform: string;
    arch: string;
    path: string;
    bytes: number;
    sha256: string;
  }>;
}

async function verifyBundledNativeArtifact(
  executable: string,
  requiresManifest: boolean,
): Promise<void> {
  const manifestPath = fileURLToPath(new URL('../../native/build-manifest.json', import.meta.url));
  let manifest: NativeArtifactManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as NativeArtifactManifest;
  } catch {
    if (requiresManifest) throw new Error('bundled ck-build-core native manifest is missing or invalid');
    return;
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts)) {
    throw new Error('bundled ck-build-core native manifest schema is unsupported');
  }
  const expectedPath = normalizeNativeArtifactPath(
    `${process.platform}-${process.arch}/ck-build-core${process.platform === 'win32' ? '.exe' : ''}`,
  );
  const record = manifest.artifacts.find((artifact) => (
    artifact.platform === process.platform
    && artifact.arch === process.arch
    && normalizeNativeArtifactPath(artifact.path) === expectedPath
  ));
  if (!record) {
    if (requiresManifest) throw new Error('bundled ck-build-core native artifact is not listed in its manifest');
    return;
  }
  const bytes = new Uint8Array(await readFile(executable));
  if (bytes.byteLength !== record.bytes || sha256Hex(bytes) !== record.sha256) {
    throw new Error('bundled ck-build-core native artifact checksum mismatch');
  }
  const nativeRoot = fileURLToPath(new URL('../../native/', import.meta.url));
  const recordPath = normalizeNativeArtifactPath(record.path);
  if (resolve(nativeRoot, ...recordPath.split('/')) !== resolve(executable)) {
    throw new Error('bundled ck-build-core native artifact path is invalid');
  }
}

function normalizeNativeArtifactPath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)) {
    throw new TypeError('native artifact path must be relative POSIX syntax');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError('native artifact path contains an invalid segment');
  }
  return parts.join('/');
}

function createNativeBackend(executable: string): RustPlannerBackend {
  return {
    invoke: (operation, input, options) => invokeNative(executable, operation, input, options),
  };
}

async function loadWasmBackend(): Promise<RustPlannerBackend> {
  const moduleUrl = new URL('../../wasm/ck_build_core.js', import.meta.url);
  const wasmUrl = new URL('../../wasm/ck_build_core_bg.wasm', import.meta.url);
  const bindings = await import(moduleUrl.href) as RustWasmBindings;
  bindings.initSync({ module: await readFile(wasmUrl) });
  return {
    async invoke(operation, input, options = {}) {
      throwIfInterrupted(options);
      let output: string;
      switch (operation) {
        case 'resolve-project': output = bindings.resolveProject(input); break;
        case 'resolve-target': output = bindings.resolveTarget(input); break;
        case 'resolve-platform': output = bindings.resolvePlatform(input); break;
        case 'resolve-platform-manifest': output = bindings.resolvePlatformManifest(input); break;
        case 'resolve-libraries': output = bindings.resolveLibraries(input); break;
        case 'create-action-graph': output = bindings.createActionGraph(input); break;
        case 'create-build-ir': output = bindings.createBuildIR(input); break;
        case 'plan-build-actions': output = bindings.planBuildActions(input); break;
        case 'plan-build-ir': output = bindings.planBuildIR(input); break;
        case 'calculate-action-keys': output = bindings.calculateActionKeys(input); break;
        case 'map-diagnostics': output = bindings.mapDiagnostics(input); break;
        case 'migrate-build-ir': output = bindings.migrateBuildIR(input); break;
        case 'validate-build-ir':
          bindings.validateBuildIR(input);
          output = 'null';
          break;
      }
      throwIfInterrupted(options);
      return output;
    },
  };
}

function invokeNative(
  executable: string,
  operation: RustPlannerOperation,
  input: string,
  options: DeadlineOptions = {},
): Promise<string> {
  throwIfInterrupted(options);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [operation], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let settled = false;
    const remaining = options.deadlineAt === undefined
      ? NATIVE_TIMEOUT_MS
      : Math.min(NATIVE_TIMEOUT_MS, deadlineRemainingMs(options.deadlineAt));
    const timer = setTimeout(() => {
      child.kill();
      finish(interruptionReason(options) === 'timeout'
        ? new DeadlineExceededError()
        : new Error(`ck-build-core ${operation} timed out`));
    }, remaining);
    timer.unref();
    const onAbort = (): void => {
      child.kill();
      finish(interruptionError(options));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value ?? '');
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_NATIVE_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill();
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_NATIVE_ERROR_BYTES) return;
      const remaining = MAX_NATIVE_ERROR_BYTES - stderrBytes;
      const value = chunk.subarray(0, remaining);
      stderrBytes += value.byteLength;
      stderr.push(Buffer.from(value));
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (outputExceeded) {
        finish(new Error(`ck-build-core ${operation} output exceeds 256 MiB`));
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        finish(new Error(detail || `ck-build-core ${operation} exited with ${String(code ?? signal)}`));
        return;
      }
      finish(undefined, Buffer.concat(stdout).toString('utf8'));
    });
    child.stdin.on('error', (error) => {
      if (!child.killed) finish(error);
    });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    child.stdin.end(input, 'utf8');
  });
}

async function invokeJson<T>(
  operation: RustPlannerOperation,
  input: unknown,
  options: DeadlineOptions = {},
): Promise<T> {
  throwIfInterrupted(options);
  const serialized = JSON.stringify(input);
  if (serialized === undefined) throw new TypeError(`ck-build-core ${operation} input is not JSON serializable`);
  const backend = await loadBackend();
  throwIfInterrupted(options);
  const output = await backend.invoke(operation, serialized, options);
  throwIfInterrupted(options);
  return JSON.parse(output) as T;
}

async function invokeCanonical(
  operation: RustPlannerOperation,
  input: unknown,
  options: DeadlineOptions = {},
): Promise<string> {
  throwIfInterrupted(options);
  const serialized = JSON.stringify(input);
  if (serialized === undefined) throw new TypeError(`ck-build-core ${operation} input is not JSON serializable`);
  const backend = await loadBackend();
  throwIfInterrupted(options);
  return backend.invoke(operation, serialized, options);
}

export async function resolveProject(
  input: ProjectSnapshot | readonly ProjectFileInput[],
): Promise<ProjectSnapshot> {
  return invokeJson<ProjectSnapshot>('resolve-project', input);
}

export async function resolveTarget(input: TargetSpec | TargetInput): Promise<TargetSpec> {
  return invokeJson<TargetSpec>('resolve-target', input);
}

export async function resolvePlatform(input: PlatformPackRef): Promise<PlatformPackRef> {
  return invokeJson<PlatformPackRef>('resolve-platform', input);
}

export async function resolvePlatformManifest(
  input: ResolvePlatformManifestInput,
  options: DeadlineOptions = {},
): Promise<ResolvedPlatformManifest> {
  return invokeJson<ResolvedPlatformManifest>('resolve-platform-manifest', input, options);
}

export async function resolveLibraries(
  input: LibraryResolutionInput | readonly LibraryPackRef[],
): Promise<LibraryPackSet> {
  const validated = validateLibraryPacks(input);
  return invokeJson<LibraryPackSet>('resolve-libraries', validated);
}

export async function createActionGraph(
  actions: readonly (BuildAction | BuildActionDraft)[],
): Promise<ActionGraph> {
  return invokeJson<ActionGraph>('create-action-graph', [...actions]);
}

export async function createBuildIR(input: BuildIRInput): Promise<BuildIR> {
  validateLibraryPacks(input.packs.libraries);
  return invokeJson<BuildIR>('create-build-ir', input);
}

export async function planBuildActions(input: BuildPlannerInput): Promise<BuildActionPlan> {
  validateLibraryPacks(input.packs.libraries);
  return invokeJson<BuildActionPlan>('plan-build-actions', input);
}

/** Plan with the native Rust artifact in workers and the same crate's WASM artifact elsewhere. */
export async function planBuildIR(
  input: BuildPlannerInput,
  options: DeadlineOptions = {},
): Promise<BuildIR> {
  validateLibraryPacks(input.packs.libraries);
  return invokeJson<BuildIR>('plan-build-ir', input, options);
}

export async function calculateActionKeys(ir: BuildIR): Promise<BuildIR> {
  return invokeJson<BuildIR>('calculate-action-keys', ir);
}

export async function mapDiagnostics(
  diagnostics: readonly RawBuildDiagnostic[],
  map: DiagnosticMap | readonly DiagnosticMapEntry[],
  options: DeadlineOptions = {},
): Promise<MappedBuildDiagnostic[]> {
  return invokeJson<MappedBuildDiagnostic[]>('map-diagnostics', {
    diagnostics,
    map: isDiagnosticMapEntries(map) ? { entries: [...map] } : map,
  }, options);
}

export async function migrateBuildIR(value: unknown): Promise<BuildIR> {
  return invokeJson<BuildIR>('migrate-build-ir', value);
}

export async function normalizeBuildIR(ir: BuildIR): Promise<BuildIR> {
  return invokeJson<BuildIR>('migrate-build-ir', ir);
}

function isDiagnosticMapEntries(
  value: DiagnosticMap | readonly DiagnosticMapEntry[],
): value is readonly DiagnosticMapEntry[] {
  return Array.isArray(value);
}

export async function serializeBuildIR(ir: BuildIR): Promise<string> {
  return invokeCanonical('migrate-build-ir', ir);
}

/** Validate serialized Build IR through the selected artifact of the shared Rust core. */
export async function validateBuildIR(ir: unknown, options: DeadlineOptions = {}): Promise<void> {
  await invokeCanonical('validate-build-ir', ir, options);
}

// Explicit aliases retained for existing service code while the canonical
// public names above make the Rust ownership of planning transparent.
export const planBuildIRWithRust = planBuildIR;
export const resolvePlatformManifestWithRust = resolvePlatformManifest;
export const validateBuildIRWithRust = validateBuildIR;
