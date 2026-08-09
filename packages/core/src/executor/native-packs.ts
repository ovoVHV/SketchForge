import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { canonicalJson, sha256Hex } from '../build-ir/canonical.js';
import { contentIdentity } from '../cache/identity.js';
import { throwIfInterrupted } from '../deadline.js';
import type {
  BoardPackRef,
  BuildPacks,
  PackRef,
  Sha256,
} from '../build-ir/types.js';
import type { ToolchainConfig, ArchToolchain, Esp32Toolchain } from '../toolchain/config.js';
import { toolPath } from '../toolchain/config.js';
import { esp32PartitionToolInvocation } from '../toolchain/esp32.js';
import {
  normalizeNativeToolResolution,
  type NativePackProvider,
  type NativeToolResolution,
  type NativeToolResolver,
} from './native.js';
import type { BuildExecutionOptions } from './types.js';
import { resolveLibraries } from '../build-ir/builder.js';

const SHA256 = /^[a-f0-9]{64}$/;
const WINDOWS_EXE = process.platform === 'win32' ? '.exe' : '';
const VERIFIED_CAS_BLOBS = new Map<string, FileSnapshot>();
const ACTIVE_CAS_BLOBS = new Map<string, number>();
const CAS_BLOB_TOUCHES = new Map<string, number>();
const CAS_SHARD = /^[a-f0-9]{2}$/;
const CAS_TEMPORARY = /^[a-f0-9]{64}\.\d+\.[0-9a-f-]{36}\.tmp$/;
const CAS_TEMPORARY_GRACE_MS = 5 * 60 * 1_000;
const CAS_TOUCH_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_CAS_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_CAS_MAX_ENTRIES = 250_000;
const DEFAULT_CAS_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_CAS_PRUNE_INTERVAL_MS = 5 * 60 * 1_000;
const NATIVE_TOOL_CLOSURE_SCHEMA_VERSION = 1 as const;
const NATIVE_TOOL_CLOSURE_HARD_LIMITS = Object.freeze({
  maxFileBytes: 512 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxFiles: 100_000,
  maxDirectories: 25_000,
  maxEntries: 125_000,
  maxDirectoryEntries: 16_384,
  maxDepth: 64,
  maxPathBytes: 4 * 1024,
  maxManifestBytes: 64 * 1024 * 1024,
});
const NATIVE_TOOL_HASH_BUFFER_BYTES = 1024 * 1024;
type NativePackKind = 'toolchain' | 'platform' | 'board' | 'library';

export interface NativeToolClosureLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxDirectories: number;
  maxEntries: number;
  maxDirectoryEntries: number;
  maxDepth: number;
  /** Maximum UTF-8 bytes in one canonical relative file path. */
  maxPathBytes: number;
  /** Maximum UTF-8 bytes in the serialized closure manifest. */
  maxManifestBytes: number;
}

export interface NativeToolClosureScanOptions extends BuildExecutionOptions {
  /** Tests and stricter deployments may lower, but never raise, the hard scanner limits. */
  limits?: Partial<NativeToolClosureLimits>;
}

interface NativeClosureVerificationContext {
  forceScan: boolean;
  boundaryClosures: Set<string>;
  execution: BuildExecutionOptions;
}

interface FileSystemObjectIdentity {
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
}

interface FileSnapshot {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

/** A host directory that can be materialised for one immutable Pack ref. */
export interface NativePackSource {
  /** Host directory. It is never written to and never exposed in the IR. */
  root: string;
  /** Logical workspace destination. Defaults to the Pack-specific destination. */
  destination?: string;
  /** Exact immutable Pack identity asserted before copying. */
  sha256: Sha256;
  /** Deterministic digest captured while this unpacked Pack was planned. */
  contentSha256: Sha256;
  /** Root covered by contentSha256. Defaults to root; may bind sibling Pack artifacts together. */
  contentRoot?: string;
  /** Complete allowlist of files copied from this source tree. */
  files: readonly NativePackFile[];
}

export interface NativePackFile {
  path: string;
  sha256: Sha256;
}

export interface NativePackCasLimits {
  /** Blob lifetime since its last materialization. Zero disables TTL expiry. */
  ttlMs?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
  /** Minimum delay between background scans. Zero scans after every materialization. */
  pruneIntervalMs?: number;
}

export interface NativePackCasPruneResult {
  scannedEntries: number;
  removedEntries: number;
  totalEntries: number;
  totalBytes: number;
  quotaSatisfied: boolean;
}

export interface NativePackProviderOptions {
  /** Platform/Core and Variant sources. Multiple entries may target distinct roots. */
  platform?: NativePackSource | readonly NativePackSource[];
  board?: NativePackSource | readonly NativePackSource[];
  toolchain?: NativePackSource | readonly NativePackSource[];
  /** Library sources keyed by the exact Pack id. */
  libraries?: ReadonlyMap<string, NativePackSource> | Record<string, NativePackSource>;
  /** Optional custom destination for a Pack kind. */
  destinationFor?: (pack: PackRef, kind: NativePackKind) => string;
  /** Persistent content-addressed blob store used to avoid repeated Pack copies. */
  casRoot?: string;
  /** Retention limits for casRoot. */
  casLimits?: NativePackCasLimits;
}

/**
 * Native Pack adapter for unpacked, content-addressed host bundles.
 *
 * The IR only carries Pack identities. This adapter is the private host-side
 * registry that turns those identities into logical files inside the executor
 * workspace. It intentionally copies regular files and rejects symlinks so a
 * Pack cannot escape its declared root during materialisation.
 */
export class FileSystemNativePackProvider implements NativePackProvider {
  private readonly cas: NativePackCasStore | undefined;

  constructor(private readonly options: NativePackProviderOptions = {}) {
    this.cas = options.casRoot ? new NativePackCasStore(options.casRoot, options.casLimits) : undefined;
  }

  materialize(
    packs: BuildPacks,
    workspace: string,
    execution: BuildExecutionOptions = {},
  ): void {
    throwIfInterrupted(execution);
    assertDirectory(workspace, 'executor workspace');
    resolveLibraries(packs.libraries);
    const verifiedContent = new Set<string>();
    this.materializeSources(
      packs.toolchain, 'toolchain', normalizeSources(this.options.toolchain), workspace, verifiedContent, execution,
    );
    this.materializeSources(
      packs.platform, 'platform', normalizeSources(this.options.platform), workspace, verifiedContent, execution,
    );
    this.materializeSources(
      packs.board, 'board', normalizeSources(this.options.board), workspace, verifiedContent, execution,
    );

    const libraries = this.options.libraries;
    for (const pack of packs.libraries.packs) {
      throwIfInterrupted(execution);
      const source = libraries === undefined
        ? undefined
        : isPackSourceMap(libraries)
          ? libraries.get(pack.id)
          : libraries[pack.id];
      if (!source) continue;
      this.materializeSources(pack, 'library', [source], workspace, verifiedContent, execution);
    }
    throwIfInterrupted(execution);
    this.cas?.maybePrune();
    throwIfInterrupted(execution);
  }

  /** Run Pack CAS housekeeping immediately. Primarily used by worker maintenance and tests. */
  async pruneCas(): Promise<NativePackCasPruneResult | null> {
    return this.cas ? this.cas.prune() : null;
  }

  private materializeSources(
    pack: PackRef,
    kind: NativePackKind,
    sources: readonly NativePackSource[],
    workspace: string,
    verifiedContent: Set<string>,
    execution: BuildExecutionOptions,
  ): void {
    for (const source of sources) {
      throwIfInterrupted(execution);
      const root = assertDirectory(source.root, `${kind} Pack ${pack.id}`);
      assertSourceIdentity(pack, source);
      const copied = source.files.map((file) => normalizeFileSpec(file, root));
      if (!SHA256.test(source.contentSha256)) {
        throw new TypeError(`missing or invalid content hash for ${kind} Pack ${pack.id}`);
      }
      const contentRoot = assertDirectory(source.contentRoot ?? root, `${kind} Pack ${pack.id} content`);
      if (root !== contentRoot && !root.startsWith(`${contentRoot}${sep}`)) {
        throw new TypeError(`content root does not contain ${kind} Pack source ${pack.id}`);
      }
      const contentKey = `${contentRoot}\0${source.contentSha256}`;
      if (!verifiedContent.has(contentKey)) {
        const casAlreadyVerified = this.cas !== undefined
          && copied.length > 0
          && copied.every((file) => this.cas!.hasVerifiedBlob(file));
        if (!casAlreadyVerified && contentIdentity(contentRoot) !== source.contentSha256) {
          throw new TypeError(`content hash mismatch for ${kind} Pack ${pack.id}`);
        }
        throwIfInterrupted(execution);
        verifiedContent.add(contentKey);
      }
      const destination = source.destination
        ?? this.options.destinationFor?.(pack, kind)
        ?? defaultDestination(pack, kind);
      const logicalDestination = normalizeLogicalPath(destination, `${kind} Pack destination`);

      const seen = new Set<string>();
      for (const file of copied) {
        throwIfInterrupted(execution);
        const logicalPath = joinLogical(logicalDestination, file.path);
        if (seen.has(logicalPath)) throw new TypeError(`duplicate ${kind} Pack file: ${file.path}`);
        seen.add(logicalPath);
        if (this.cas) {
          this.cas.materialize(
            file,
            `${kind} Pack ${pack.id} file ${file.path}`,
            workspace,
            logicalPath,
          );
          throwIfInterrupted(execution);
          continue;
        }
        const bytes = readRegularFile(file.absolute, `${kind} Pack ${pack.id}`);
        if (sha256Hex(bytes) !== file.sha256) {
          throw new TypeError(`hash mismatch for ${kind} Pack ${pack.id} file ${file.path}`);
        }
        writeWorkspaceFile(workspace, logicalPath, bytes);
        throwIfInterrupted(execution);
      }
    }
  }
}

/** Short alias used by server wiring and tests. */
export class NativePackProviderImpl extends FileSystemNativePackProvider {}

export function createNativePackProvider(options: NativePackProviderOptions = {}): FileSystemNativePackProvider {
  return new FileSystemNativePackProvider(options);
}

export interface NativeToolResolverOptions {
  /** Explicit logical tool map wins over all inferred mappings. */
  commands?: Readonly<Record<string, string>>;
  /** A full local configuration is convenient for server workers. */
  config?: ToolchainConfig;
  avr?: ArchToolchain;
  esp32?: Esp32Toolchain;
  /** Permit resolving custom IR tools by exact logical name. */
  allowAbsoluteCommands?: boolean;
  /** Host-private command hashes captured for the exact Packs in the IR. */
  integrity?: NativeToolIntegrityManifest;
  /** Explicit compatibility escape hatch for adapters that replace Pack tools. */
  allowUnverifiedPackTools?: boolean;
  /** Host override used by cross-platform resolver tests. */
  hostPlatform?: NodeJS.Platform;
  /**
   * Explicit host Python identity used by the POSIX ESP32 partition tool.
   * The interpreter is deliberately not resolved through PATH at execution
   * time; its bytes and narrow authorization directory are bound here.
   */
  pythonInterpreter?: NativePythonInterpreter;
}

export interface NativeToolIntegrity {
  packSha256: Sha256;
  commandSha256: Sha256;
  closure: NativeToolClosureIdentity;
}

export interface NativeToolClosureFile {
  /** Canonical POSIX path relative to the authorized tool root. */
  path: string;
  type: 'file';
  size: number;
  sha256: Sha256;
}

export interface NativeToolClosureIdentity {
  schemaVersion: typeof NATIVE_TOOL_CLOSURE_SCHEMA_VERSION;
  fileCount: number;
  totalBytes: number;
  sha256: Sha256;
}

export interface NativeToolClosureManifest extends NativeToolClosureIdentity {
  files: readonly NativeToolClosureFile[];
}

export interface NativePythonInterpreter {
  /** Canonical absolute interpreter executable. */
  command: string;
  /** SHA-256 of the interpreter executable bytes. */
  commandSha256: Sha256;
  /** Canonical absolute directory explicitly authorized for the executable. */
  authorizedDirectory: string;
}

export type NativeToolIntegrityManifest = Readonly<Record<string, NativeToolIntegrity>>;

/**
 * Resolves planner tool ids (`toolchain:cc`, `toolchain:ld`, ...) without
 * leaking host paths into the Build IR or the browser UI.
 */
export class DefaultNativeToolResolver implements NativeToolResolver {
  readonly policyIdentity: Sha256 | undefined;
  private readonly commands: Readonly<Record<string, string>>;
  private readonly avr?: ArchToolchain;
  private readonly esp32?: Esp32Toolchain;
  private readonly allowAbsoluteCommands: boolean;
  private readonly integrity: NativeToolIntegrityManifest;
  private readonly allowUnverifiedPackTools: boolean;
  private readonly hostPlatform: NodeJS.Platform;
  private readonly pythonInterpreter?: NativePythonInterpreter;
  private readonly verifiedClosures = new Set<string>();

  constructor(options: NativeToolResolverOptions = {}) {
    this.commands = options.commands ?? {};
    this.avr = options.avr ?? options.config?.avr;
    this.esp32 = options.esp32 ?? options.config?.esp32;
    this.allowAbsoluteCommands = options.allowAbsoluteCommands ?? false;
    this.integrity = options.integrity ?? {};
    this.allowUnverifiedPackTools = options.allowUnverifiedPackTools ?? false;
    this.hostPlatform = options.hostPlatform ?? process.platform;
    this.pythonInterpreter = options.pythonInterpreter;
    this.policyIdentity = Object.keys(this.integrity).length === 0
      ? undefined
      : nativeToolIntegrityIdentity(this.integrity);
  }

  resolve(tool: string, packs: BuildPacks): string {
    const command = this.resolveCommand(tool, packs);
    this.verifyIntegrity(tool, command, packs);
    return command;
  }

  resolveForExecution(
    tool: string,
    packs: BuildPacks,
    execution: BuildExecutionOptions = {},
  ): NativeToolResolution {
    const command = this.resolveCommand(tool, packs);
    // The resolver preflight protects cache reads, but the filesystem can
    // still change while Packs are materialized. Re-scan the grant immediately
    // before returning the command that will be handed to the sandbox.
    const verifiedPackTool = this.verifyIntegrity(tool, command, packs, {
      forceScan: true,
      boundaryClosures: new Set<string>(),
      execution,
    });
    if (!verifiedPackTool) return { command };
    const approvedRoot = this.approvedReadOnlyRoot(tool, packs);
    if (!approvedRoot) {
      throw new Error(`verified native tool has no approved read-only root: ${tool}`);
    }
    if (tool === 'platform:gen-esp32part') {
      if (!this.esp32) throw new Error('ESP32 native platform tools are not configured');
      const invocation = esp32PartitionToolInvocation(this.esp32.platformDir, this.hostPlatform);
      if (this.hostPlatform === 'win32') {
        return normalizeNativeToolResolution({
          command: invocation.command,
          argumentsPrefix: invocation.argsPrefix,
          entrypoint: invocation.identityPath,
          readOnlyPaths: [approvedRoot],
        }, tool);
      }
      const interpreter = this.resolvePythonInterpreter();
      return normalizeNativeToolResolution({
        command: interpreter.command,
        argumentsPrefix: invocation.argsPrefix,
        entrypoint: invocation.identityPath,
        readOnlyPaths: [approvedRoot, interpreter.authorizedDirectory],
      }, tool);
    }
    return normalizeNativeToolResolution({ command, readOnlyPaths: [approvedRoot] }, tool);
  }

  /** Verify every Pack-backed tool before the executor reads or writes Action cache entries. */
  verifyForExecution(packs: BuildPacks, execution: BuildExecutionOptions = {}): void {
    // A resolver may have been used while evidence was prepared. Never let
    // those earlier scans satisfy a later execution-boundary preflight.
    this.verifiedClosures.clear();
    const verification: NativeClosureVerificationContext = {
      forceScan: true,
      boundaryClosures: new Set<string>(),
      execution,
    };
    try {
      for (const tool of Object.keys(this.integrity).sort(compareText)) {
        throwIfInterrupted(execution);
        const command = this.resolveCommand(tool, packs);
        this.verifyIntegrity(tool, command, packs, verification);
      }
    } catch (error) {
      this.verifiedClosures.clear();
      throw error;
    }
  }

  private resolveCommand(tool: string, packs: BuildPacks): string {
    const explicit = this.commands[tool];
    if (explicit !== undefined) {
      if (!explicit) throw new Error(`native tool mapping is empty: ${tool}`);
      if (!this.allowAbsoluteCommands && isAbsoluteHostPath(explicit)) {
        // Explicit host paths are useful for the server, but are opt-in so a
        // serialized/remote resolver cannot accidentally trust an IR value.
        throw new Error(`absolute native command is disabled: ${tool}`);
      }
      return explicit;
    }

    if (tool === 'platform:gen-esp32part') {
      if (!this.esp32) throw new Error('ESP32 native platform tools are not configured');
      return esp32PartitionToolInvocation(
        this.esp32.platformDir,
        this.hostPlatform,
      ).identityPath;
    }

    const actionName = logicalToolName(tool);
    if (!actionName) throw new Error(`unsupported native tool: ${tool}`);
    const arch = boardArchitecture(packs.board);
    if (arch === 'avr') {
      if (!this.avr) throw new Error('AVR native toolchain is not configured');
      return toolPath(this.avr, avrTool(actionName));
    }
    if (!this.esp32) throw new Error('ESP32 native toolchain is not configured');
    return esp32ToolPath(this.esp32, packs, actionName);
  }

  private approvedReadOnlyRoot(tool: string, packs: BuildPacks): string | null {
    return approvedNativeToolRoot(tool, packs, this.avr, this.esp32);
  }

  private verifyIntegrity(
    tool: string,
    command: string,
    packs: BuildPacks,
    verification?: NativeClosureVerificationContext,
  ): boolean {
    const packSha256 = nativeToolPackSha256(tool, packs);
    if (packSha256 === null || this.allowUnverifiedPackTools) return false;
    const integrity = this.integrity[tool];
    if (!integrity) throw new Error(`native tool integrity manifest is missing: ${tool}`);
    if (!SHA256.test(integrity.packSha256) || !SHA256.test(integrity.commandSha256)
      || !validNativeToolClosureIdentity(integrity.closure)) {
      throw new Error(`native tool integrity manifest is invalid: ${tool}`);
    }
    if (integrity.packSha256 !== packSha256) {
      throw new Error(`native tool Pack identity mismatch: ${tool}`);
    }
    if (hashNativeCommand(command, tool, verification?.execution) !== integrity.commandSha256) {
      throw new Error(`native tool command hash mismatch: ${tool}`);
    }
    this.verifyClosure(tool, command, packs, integrity.closure, verification);
    return true;
  }

  private verifyClosure(
    tool: string,
    command: string,
    packs: BuildPacks,
    expected: NativeToolClosureIdentity,
    verification?: NativeClosureVerificationContext,
  ): void {
    const configuredRoot = this.approvedReadOnlyRoot(tool, packs);
    if (!configuredRoot) throw new Error(`verified native tool has no approved read-only root: ${tool}`);
    const root = canonicalNativeToolClosureRoot(configuredRoot, tool);
    assertNativeCommandInClosure(command, root, tool);
    const key = `${nativeFileSystemObjectKey(root, 'directory')}\0${expected.sha256}`;
    if (verification?.boundaryClosures.has(key)) return;
    if (!verification?.forceScan && this.verifiedClosures.has(key)) return;
    const actual = createNativeToolClosureManifest(root, verification?.execution);
    if (!sameNativeToolClosureIdentity(actual, expected)) {
      throw new Error(`native tool closure hash mismatch: ${tool}`);
    }
    verification?.boundaryClosures.add(key);
    this.verifiedClosures.add(key);
  }

  private resolvePythonInterpreter(): NativePythonInterpreter {
    if (this.hostPlatform === 'win32') {
      throw new Error('Windows ESP32 partition tools must use gen_esp32part.exe');
    }
    const identity = this.pythonInterpreter;
    if (!identity) {
      throw new Error('POSIX ESP32 partition tool requires an explicit Python interpreter identity');
    }
    if (!SHA256.test(identity.commandSha256)) {
      throw new Error('POSIX Python interpreter identity has an invalid SHA-256');
    }
    if (!isAbsoluteHostPath(identity.command) || !isAbsoluteHostPath(identity.authorizedDirectory)) {
      throw new Error('POSIX Python interpreter identity must use absolute paths');
    }
    let command: string;
    let authorizedDirectory: string;
    try {
      command = realpathSync(resolve(identity.command));
      authorizedDirectory = realpathSync(resolve(identity.authorizedDirectory));
    } catch {
      throw new Error('POSIX Python interpreter identity path does not exist');
    }
    let commandStat;
    try { commandStat = lstatSync(command); } catch { throw new Error('POSIX Python interpreter is missing'); }
    if (!commandStat.isFile()) throw new Error('POSIX Python interpreter is not a regular file');
    let directoryStat;
    try { directoryStat = lstatSync(authorizedDirectory); } catch {
      throw new Error('POSIX Python interpreter authorization directory is missing');
    }
    if (!directoryStat.isDirectory()) {
      throw new Error('POSIX Python interpreter authorization path is not a directory');
    }
    if (authorizedDirectory !== dirname(command)) {
      throw new Error('POSIX Python interpreter authorization directory must be its executable directory');
    }
    if (!pathContains(authorizedDirectory, command)) {
      throw new Error('POSIX Python interpreter is outside its authorized directory');
    }
    if (hashNativeCommand(command, 'python3') !== identity.commandSha256) {
      throw new Error('POSIX Python interpreter command hash mismatch');
    }
    return Object.freeze({
      command,
      commandSha256: identity.commandSha256,
      authorizedDirectory,
    });
  }
}

/** Short alias that reads naturally in executor construction. */
export class NativeToolResolverImpl extends DefaultNativeToolResolver {}

export function createNativeToolResolver(options: NativeToolResolverOptions = {}): DefaultNativeToolResolver {
  return new DefaultNativeToolResolver(options);
}

/** Capture the host-private command manifest used by a verified resolver. */
export function createNativeToolIntegrityManifest(
  options: NativeToolResolverOptions,
  packs: BuildPacks,
  tools: readonly string[],
): NativeToolIntegrityManifest {
  const resolver = new DefaultNativeToolResolver({
    ...options,
    integrity: {},
    allowUnverifiedPackTools: true,
  });
  const manifest: Record<string, NativeToolIntegrity> = {};
  const closures = new Map<string, NativeToolClosureIdentity>();
  for (const tool of [...new Set(tools)].sort(compareText)) {
    const packSha256 = nativeToolPackSha256(tool, packs);
    if (packSha256 === null) continue;
    const command = resolver.resolve(tool, packs);
    const configuredRoot = approvedNativeToolRoot(
      tool,
      packs,
      options.avr ?? options.config?.avr,
      options.esp32 ?? options.config?.esp32,
    );
    if (!configuredRoot) throw new Error(`verified native tool has no approved read-only root: ${tool}`);
    const root = canonicalNativeToolClosureRoot(configuredRoot, tool);
    assertNativeCommandInClosure(command, root, tool);
    const rootKey = nativeFileSystemObjectKey(root, 'directory');
    let closure = closures.get(rootKey);
    if (!closure) {
      closure = nativeToolClosureIdentity(createNativeToolClosureManifest(root));
      closures.set(rootKey, closure);
    }
    manifest[tool] = {
      packSha256,
      commandSha256: hashNativeCommand(command, tool),
      closure,
    };
  }
  return Object.freeze(manifest);
}

/**
 * Capture a relocation-independent manifest for one authorized Native tool root.
 *
 * This API is synchronous so callers can capture one atomic host snapshot.
 * It polls deadlines/cancellation between directory entries and hash chunks;
 * hard file/tree limits cap its event-loop and memory impact.
 */
export function createNativeToolClosureManifest(
  root: string,
  options: NativeToolClosureScanOptions = {},
): NativeToolClosureManifest {
  throwIfInterrupted(options);
  const canonicalRoot = canonicalNativeToolClosureRoot(root, 'closure');
  const limits = nativeToolClosureLimits(options.limits);
  const files: NativeToolClosureFile[] = [];
  const visitedDirectories = new Set<string>();
  const hashBuffer = Buffer.allocUnsafe(Math.min(NATIVE_TOOL_HASH_BUFFER_BYTES, limits.maxFileBytes));
  const state = {
    directories: 0,
    entries: 0,
    files: 0,
    totalBytes: 0,
    manifestBytes: manifestEnvelopeBytes(),
  };

  const visit = (directory: string, depth: number): void => {
    throwIfInterrupted(options);
    if (depth > limits.maxDepth) {
      throw new Error('native tool closure exceeded its directory depth limit');
    }
    state.directories++;
    if (state.directories > limits.maxDirectories) {
      throw new Error('native tool closure exceeded its directory count limit');
    }
    const directoryKey = nativeFileSystemObjectKey(directory, 'directory');
    if (visitedDirectories.has(directoryKey)) {
      throw new Error(`native tool closure contains a directory cycle: ${directory}`);
    }
    visitedDirectories.add(directoryKey);
    const before = nativeClosureSnapshot(directory, 'directory');
    let handle;
    try {
      handle = opendirSync(directory);
    } catch {
      throw new Error(`native tool closure directory cannot be read: ${directory}`);
    }
    const entries = [];
    try {
      for (;;) {
        throwIfInterrupted(options);
        let entry;
        try { entry = handle.readSync(); } catch {
          throw new Error(`native tool closure directory cannot be read: ${directory}`);
        }
        if (entry === null) break;
        state.entries++;
        if (state.entries > limits.maxEntries) {
          throw new Error('native tool closure exceeded its total entry limit');
        }
        if (entries.length >= limits.maxDirectoryEntries) {
          throw new Error(`native tool closure exceeded its per-directory entry limit: ${directory}`);
        }
        entries.push(entry);
      }
    } finally {
      handle.closeSync();
    }
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      throwIfInterrupted(options);
      validateNativeClosureSegment(entry.name);
      const absolute = join(directory, entry.name);
      let stat;
      try { stat = lstatSync(absolute); } catch {
        throw new Error(`native tool closure entry disappeared: ${absolute}`);
      }
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error(`native tool closure contains a symbolic link: ${absolute}`);
      }
      let canonical;
      try { canonical = realpathSync(absolute); } catch {
        throw new Error(`native tool closure entry cannot be resolved: ${absolute}`);
      }
      if (!pathContains(canonicalRoot, canonical)) {
        throw new Error(`native tool closure entry escapes its authorized root: ${absolute}`);
      }
      if (!sameHostPath(absolute, canonical)) {
        throw new Error(`native tool closure entry resolves through unsafe indirection: ${absolute}`);
      }
      if (entry.isDirectory() && stat.isDirectory()) {
        visit(canonical, depth + 1);
        continue;
      }
      if (!entry.isFile() || !stat.isFile()) {
        throw new Error(`native tool closure contains an unsupported filesystem entry: ${absolute}`);
      }
      const beforeFile = nativeClosureSnapshot(canonical, 'file');
      if (beforeFile.size > limits.maxFileBytes) {
        throw new Error(`native tool closure exceeded its single-file byte limit: ${absolute}`);
      }
      if (state.files >= limits.maxFiles) {
        throw new Error('native tool closure exceeded its file count limit');
      }
      if (state.totalBytes + beforeFile.size > limits.maxTotalBytes) {
        throw new Error('native tool closure exceeded its total byte limit');
      }
      const sha256 = hashNativeClosureFile(canonical, beforeFile, hashBuffer, options);
      state.files++;
      state.totalBytes += beforeFile.size;
      const path = nativeClosureRelativePath(canonicalRoot, canonical, limits.maxPathBytes);
      const file = Object.freeze({
        path,
        type: 'file' as const,
        size: beforeFile.size,
        sha256,
      });
      const nextManifestBytes = state.manifestBytes
        + (state.files === 1 ? 0 : 1)
        + Buffer.byteLength(canonicalJson(file), 'utf8');
      if (nextManifestBytes > limits.maxManifestBytes) {
        throw new Error('native tool closure exceeded its serialized manifest byte limit');
      }
      state.manifestBytes = nextManifestBytes;
      files.push(file);
    }
    const after = nativeClosureSnapshot(directory, 'directory');
    if (!sameFileSnapshot(before, after)) {
      throw new Error(`native tool closure directory changed while scanning: ${directory}`);
    }
  };

  visit(canonicalRoot, 0);
  files.sort((left, right) => compareText(left.path, right.path));
  const frozenFiles = Object.freeze(files.slice());
  const body = Object.freeze({
    kind: 'ck-native-tool-closure',
    schemaVersion: NATIVE_TOOL_CLOSURE_SCHEMA_VERSION,
    files: frozenFiles,
  });
  const serializedBody = canonicalJson(body);
  const serializedBytes = Buffer.byteLength(serializedBody, 'utf8');
  if (serializedBytes > limits.maxManifestBytes) {
    throw new Error('native tool closure exceeded its serialized manifest byte limit');
  }
  return Object.freeze({
    schemaVersion: NATIVE_TOOL_CLOSURE_SCHEMA_VERSION,
    fileCount: frozenFiles.length,
    totalBytes: state.totalBytes,
    sha256: sha256Hex(serializedBody),
    files: frozenFiles,
  });
}

/** Stable policy/cache identity for a Pack-bound Native integrity manifest. */
export function nativeToolIntegrityIdentity(integrity: NativeToolIntegrityManifest): Sha256 {
  return sha256Hex(canonicalJson({
    kind: 'ck-native-tool-integrity',
    schemaVersion: 2,
    tools: integrity,
  }));
}

function approvedNativeToolRoot(
  tool: string,
  packs: BuildPacks,
  avr: ArchToolchain | undefined,
  esp32: Esp32Toolchain | undefined,
): string | null {
  if (tool === 'platform:gen-esp32part') {
    if (!esp32) throw new Error('ESP32 native platform tools are not configured');
    return join(esp32.platformDir, 'tools');
  }
  if (tool === 'toolchain:esptool') {
    if (!esp32) throw new Error('ESP32 native toolchain is not configured');
    return dirname(esp32.esptool);
  }
  if (!logicalToolName(tool)) return null;
  if (boardArchitecture(packs.board) === 'avr') {
    if (!avr) throw new Error('AVR native toolchain is not configured');
    return avr.rootDir ?? dirname(avr.binDir);
  }
  if (!esp32) throw new Error('ESP32 native toolchain is not configured');
  const riscv = packs.toolchain.abi.toLowerCase().includes('riscv');
  const binDir = riscv ? esp32.riscvBinDir : esp32.xtensaBinDir;
  const rootDir = riscv ? esp32.riscvRootDir : esp32.xtensaRootDir;
  if (!binDir) throw new Error(`ESP32 ${riscv ? 'RISC-V' : 'Xtensa'} toolchain is not configured`);
  return rootDir ?? dirname(binDir);
}

function canonicalNativeToolClosureRoot(root: string, label: string): string {
  if (!isAbsoluteHostPath(root)) {
    throw new Error(`native tool closure root must be absolute: ${label}`);
  }
  const absolute = resolve(root);
  let stat;
  try { stat = lstatSync(absolute); } catch {
    throw new Error(`native tool closure root does not exist: ${label}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`native tool closure root is a symbolic link: ${label}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`native tool closure root is not a directory: ${label}`);
  }
  let canonical;
  try { canonical = realpathSync(absolute); } catch {
    throw new Error(`native tool closure root cannot be resolved: ${label}`);
  }
  assertNarrowNativeToolClosureRoot(canonical, label);
  const canonicalStat = nativeClosureSnapshot(canonical, 'directory');
  if (!sameFileSnapshot(nativeClosureSnapshot(absolute, 'directory'), canonicalStat)) {
    throw new Error(`native tool closure root changed while resolving: ${label}`);
  }
  return canonical;
}

function assertNarrowNativeToolClosureRoot(root: string, label: string): void {
  const filesystemRoot = parse(root).root;
  if (!filesystemRoot || sameHostPath(root, filesystemRoot)) {
    throw new Error(`native tool closure root is too broad: ${label}`);
  }
  if (process.platform === 'win32' && filesystemRoot.startsWith('\\\\')) {
    throw new Error(`native tool closure root must be on a local filesystem: ${label}`);
  }
  const segments = relative(filesystemRoot, root).split(sep).filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`native tool closure root is too broad: ${label}`);
  }
}

function assertNativeCommandInClosure(command: string, root: string, tool: string): void {
  if (!isAbsoluteHostPath(command)) {
    throw new Error(`native tool command must be absolute: ${tool}`);
  }
  let stat;
  try { stat = lstatSync(command); } catch {
    throw new Error(`native tool command is missing: ${tool}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`native tool command is not a regular file: ${tool}`);
  }
  let canonical;
  try { canonical = realpathSync(command); } catch {
    throw new Error(`native tool command cannot be resolved: ${tool}`);
  }
  if (!pathContains(root, canonical) || canonical === root) {
    throw new Error(`native tool command is outside its authorized closure: ${tool}`);
  }
}

function validateNativeClosureSegment(segment: string): void {
  if (!segment || segment === '.' || segment === '..' || segment.includes('\\')
    || segment.includes('/') || segment.includes('\0')) {
    throw new Error(`native tool closure contains an unsafe path segment: ${JSON.stringify(segment)}`);
  }
}

function nativeClosureRelativePath(root: string, candidate: string, maxPathBytes: number): string {
  const remainder = relative(root, candidate);
  if (!remainder || remainder === '..' || remainder.startsWith(`..${sep}`)
    || isAbsoluteHostPath(remainder)) {
    throw new Error(`native tool closure file escapes its authorized root: ${candidate}`);
  }
  const segments = remainder.split(sep);
  for (const segment of segments) validateNativeClosureSegment(segment);
  const result = segments.join('/');
  if (Buffer.byteLength(result, 'utf8') > maxPathBytes) {
    throw new Error(`native tool closure exceeded its relative path byte limit: ${candidate}`);
  }
  return result;
}

function manifestEnvelopeBytes(): number {
  const empty = canonicalJson({
    kind: 'ck-native-tool-closure',
    schemaVersion: NATIVE_TOOL_CLOSURE_SCHEMA_VERSION,
    files: [],
  });
  return Buffer.byteLength(empty, 'utf8') - 2;
}

function nativeToolClosureLimits(
  requested: Partial<NativeToolClosureLimits> | undefined,
): NativeToolClosureLimits {
  const limits: NativeToolClosureLimits = { ...NATIVE_TOOL_CLOSURE_HARD_LIMITS };
  if (!requested) return limits;
  for (const name of Object.keys(limits) as Array<keyof NativeToolClosureLimits>) {
    const value = requested[name];
    if (value === undefined) continue;
    const minimum = name === 'maxDepth' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > NATIVE_TOOL_CLOSURE_HARD_LIMITS[name]) {
      throw new RangeError(`native tool closure limit is invalid: ${name}`);
    }
    limits[name] = value;
  }
  return limits;
}

function hashNativeClosureFile(
  path: string,
  expected: FileSnapshot,
  buffer: Buffer,
  options: BuildExecutionOptions,
): Sha256 {
  throwIfInterrupted(options);
  let descriptor: number;
  try { descriptor = openSync(path, 'r'); } catch {
    throw new Error(`native tool closure file cannot be read: ${path}`);
  }
  const hash = createHash('sha256');
  let observed = 0;
  try {
    const opened = nativeClosureDescriptorSnapshot(descriptor, 'file');
    if (!sameFileSnapshot(expected, opened)) {
      throw new Error(`native tool closure file changed while opening: ${path}`);
    }
    for (;;) {
      throwIfInterrupted(options);
      const remainingWithSentinel = Math.max(1, expected.size - observed + 1);
      const requested = Math.min(buffer.byteLength, remainingWithSentinel);
      let count: number;
      try { count = readSync(descriptor, buffer, 0, requested, null); } catch {
        throw new Error(`native tool closure file cannot be read: ${path}`);
      }
      if (count === 0) break;
      observed += count;
      if (observed > expected.size) {
        throw new Error(`native tool closure file changed while hashing: ${path}`);
      }
      hash.update(buffer.subarray(0, count));
    }
    const afterRead = nativeClosureDescriptorSnapshot(descriptor, 'file');
    if (observed !== expected.size || !sameFileSnapshot(expected, afterRead)) {
      throw new Error(`native tool closure file changed while hashing: ${path}`);
    }
  } finally {
    closeSync(descriptor);
  }
  const after = nativeClosureSnapshot(path, 'file');
  if (!sameFileSnapshot(expected, after)) {
    throw new Error(`native tool closure file changed while hashing: ${path}`);
  }
  return hash.digest('hex') as Sha256;
}

function nativeClosureDescriptorSnapshot(
  descriptor: number,
  expected: 'file' | 'directory',
): FileSnapshot {
  let stat;
  try { stat = fstatSync(descriptor); } catch {
    throw new Error(`native tool closure ${expected} descriptor cannot be read`);
  }
  if (expected === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(`native tool closure descriptor is not a regular ${expected}`);
  }
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
  };
}

function nativeClosureSnapshot(path: string, expected: 'file' | 'directory'): FileSnapshot {
  let stat;
  try { stat = lstatSync(path); } catch {
    throw new Error(`native tool closure ${expected} is missing: ${path}`);
  }
  if (stat.isSymbolicLink()
    || (expected === 'file' ? !stat.isFile() : !stat.isDirectory())) {
    throw new Error(`native tool closure entry is not a regular ${expected}: ${path}`);
  }
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
  };
}

function nativeToolClosureIdentity(manifest: NativeToolClosureManifest): NativeToolClosureIdentity {
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    sha256: manifest.sha256,
  });
}

function validNativeToolClosureIdentity(value: unknown): value is NativeToolClosureIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<NativeToolClosureIdentity>;
  return candidate.schemaVersion === NATIVE_TOOL_CLOSURE_SCHEMA_VERSION
    && Number.isSafeInteger(candidate.fileCount) && Number(candidate.fileCount) >= 0
    && Number.isSafeInteger(candidate.totalBytes) && Number(candidate.totalBytes) >= 0
    && typeof candidate.sha256 === 'string' && SHA256.test(candidate.sha256)
    && Object.keys(candidate).every((key) => (
      key === 'schemaVersion' || key === 'fileCount' || key === 'totalBytes' || key === 'sha256'
    ));
}

function sameNativeToolClosureIdentity(
  left: NativeToolClosureIdentity,
  right: NativeToolClosureIdentity,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.fileCount === right.fileCount
    && left.totalBytes === right.totalBytes
    && left.sha256 === right.sha256;
}

function sameHostPath(left: string, right: string): boolean {
  const leftIdentity = nativeFileSystemObjectIdentity(left);
  const rightIdentity = nativeFileSystemObjectIdentity(right);
  return leftIdentity.canonicalPath === rightIdentity.canonicalPath
    && sameFileSystemObject(leftIdentity, rightIdentity);
}

function nativeFileSystemObjectKey(
  path: string,
  expected?: 'file' | 'directory',
): string {
  const identity = nativeFileSystemObjectIdentity(path, expected);
  return `${identity.canonicalPath}\0${identity.dev.toString(16)}:${identity.ino.toString(16)}`;
}

function nativeFileSystemObjectIdentity(
  path: string,
  expected?: 'file' | 'directory',
): FileSystemObjectIdentity {
  const absolute = resolve(path);
  let canonicalPath: string;
  try { canonicalPath = realpathSync(absolute); } catch {
    throw new Error(`native tool filesystem object cannot be resolved: ${path}`);
  }
  let stat;
  try { stat = lstatSync(canonicalPath, { bigint: true }); } catch {
    throw new Error(`native tool filesystem object is missing: ${path}`);
  }
  if (stat.isSymbolicLink()
    || (expected === 'file' && !stat.isFile())
    || (expected === 'directory' && !stat.isDirectory())) {
    throw new Error(`native tool filesystem object has an invalid type: ${path}`);
  }
  return { canonicalPath, dev: stat.dev, ino: stat.ino };
}

function sameFileSystemObject(
  left: FileSystemObjectIdentity,
  right: FileSystemObjectIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function logicalToolName(tool: string): 'cc' | 'cxx' | 'as' | 'ar' | 'ld' | 'objcopy' | 'esptool' | null {
  if (tool === 'toolchain:cc') return 'cc';
  if (tool === 'toolchain:cxx') return 'cxx';
  if (tool === 'toolchain:as') return 'as';
  if (tool === 'toolchain:ar') return 'ar';
  if (tool === 'toolchain:ld') return 'ld';
  if (tool === 'toolchain:objcopy') return 'objcopy';
  if (tool === 'toolchain:esptool') return 'esptool';
  return null;
}

function avrTool(name: ReturnType<typeof logicalToolName>): string {
  switch (name) {
    case 'cc':
    case 'as': return 'avr-gcc';
    case 'cxx': return 'avr-g++';
    case 'ar': return 'avr-gcc-ar';
    case 'ld': return 'avr-g++';
    case 'objcopy': return 'avr-objcopy';
    default: throw new Error(`unsupported AVR tool: ${String(name)}`);
  }
}

function esp32ToolPath(config: Esp32Toolchain, packs: BuildPacks, name: ReturnType<typeof logicalToolName>): string {
  if (name === 'esptool') return config.esptool;
  const tarch = packs.toolchain.abi.toLowerCase();
  const riscv = tarch.includes('riscv');
  const binDir = riscv ? config.riscvBinDir : config.xtensaBinDir;
  if (!binDir) throw new Error(`ESP32 ${riscv ? 'RISC-V' : 'Xtensa'} toolchain is not configured`);
  const boardId = packs.board.fqbn.split(':').pop() ?? 'esp32';
  const prefixes = riscv ? ['riscv32-esp-elf-'] : [`xtensa-${boardId}-elf-`, 'xtensa-esp-elf-'];
  const executable = name === 'cc' || name === 'as'
    ? 'gcc'
    : name === 'cxx' || name === 'ld'
      ? 'g++'
      : name === 'ar'
        ? 'gcc-ar'
        : 'objcopy';
  // Prefer a target-specific launcher when installed, then fall back to the
  // generic Xtensa launcher. If neither is present, still return the stable
  // first candidate so configuration inspection remains deterministic.
  const paths = prefixes.map((prefix) => join(binDir, `${prefix}${executable}${WINDOWS_EXE}`));
  return paths.find((path) => existsSync(path)) ?? paths[0]!;
}

function boardArchitecture(board: BoardPackRef): 'avr' | 'esp32' {
  const architecture = board.fqbn.split(':')[1]?.toLowerCase() ?? '';
  return architecture.includes('avr') ? 'avr' : 'esp32';
}

function nativeToolPackSha256(tool: string, packs: BuildPacks): Sha256 | null {
  if (tool.startsWith('toolchain:')) return packs.toolchain.sha256;
  if (tool.startsWith('platform:')) return packs.platform.sha256;
  return null;
}

function hashNativeCommand(
  command: string,
  tool: string,
  execution: BuildExecutionOptions = {},
): Sha256 {
  let stat;
  try { stat = lstatSync(command); } catch { throw new Error(`native tool command is missing: ${tool}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`native tool command is not a regular file: ${tool}`);
  }
  if (stat.size > NATIVE_TOOL_CLOSURE_HARD_LIMITS.maxFileBytes) {
    throw new Error(`native tool command exceeds its byte limit: ${tool}`);
  }
  return hashNativeClosureFile(
    command,
    nativeClosureSnapshot(command, 'file'),
    Buffer.allocUnsafe(Math.min(NATIVE_TOOL_HASH_BUFFER_BYTES, Math.max(1, stat.size))),
    execution,
  );
}

function normalizeSources(source: NativePackSource | readonly NativePackSource[] | undefined): NativePackSource[] {
  if (!source) return [];
  if (Array.isArray(source)) return source.slice() as NativePackSource[];
  return [source as NativePackSource];
}

function assertSourceIdentity(pack: PackRef, source: NativePackSource): void {
  if (!SHA256.test(source.sha256)) throw new TypeError(`missing or invalid source hash for Pack ${pack.id}`);
  if (source.sha256 !== pack.sha256) {
    throw new TypeError(`Pack identity mismatch for ${pack.id}`);
  }
  if (!Array.isArray(source.files)) throw new TypeError(`missing file manifest for Pack ${pack.id}`);
  for (const file of source.files) {
    if (!SHA256.test(file.sha256)) {
      throw new TypeError(`invalid file hash for Pack ${pack.id}: ${file.path}`);
    }
  }
}

function defaultDestination(pack: PackRef, kind: NativePackKind): string {
  if (kind === 'platform') return 'packs/platform';
  if (kind === 'board') return `packs/board/${slug(pack.id)}`;
  if (kind === 'toolchain') return 'packs/toolchain';
  return `packs/libraries/${slug(pack.id)}`;
}

function slug(value: string): string {
  const clean = value.replaceAll('\\', '/').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+|\.+$/g, '');
  return `${clean || 'pack'}-${sha256Hex(value).slice(0, 8)}`;
}

function assertDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  let stat;
  try { stat = lstatSync(absolute); } catch { throw new Error(`${label} root does not exist: ${path}`); }
  if (!stat.isDirectory()) throw new Error(`${label} root is not a directory: ${path}`);
  return absolute;
}

interface CopiedPackFile {
  path: string;
  absolute: string;
  sha256: Sha256;
}

function normalizeFileSpec(file: NativePackFile, root: string): CopiedPackFile {
  const path = normalizeLogicalPath(file.path, 'Pack file');
  const absolute = resolve(root, ...path.split('/'));
  const rootPrefix = `${root}${sep}`;
  if (absolute !== root && !absolute.startsWith(rootPrefix)) throw new TypeError(`Pack file escapes source root: ${file.path}`);
  return { path, absolute, sha256: file.sha256 };
}

function isPackSourceMap(
  value: ReadonlyMap<string, NativePackSource> | Record<string, NativePackSource>,
): value is ReadonlyMap<string, NativePackSource> {
  return typeof (value as ReadonlyMap<string, NativePackSource>).get === 'function';
}

function readRegularFile(path: string, label: string): Uint8Array {
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error(`${label} file is missing: ${path}`); }
  if (!stat.isFile()) throw new Error(`${label} file is not regular: ${path}`);
  return new Uint8Array(readFileSync(path));
}

function writeWorkspaceFile(workspace: string, logicalPath: string, bytes: Uint8Array): void {
  const root = resolve(workspace);
  const path = resolve(root, ...logicalPath.split('/'));
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new TypeError(`workspace path escapes root: ${logicalPath}`);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const existing = readRegularFile(path, 'workspace');
    if (sha256Hex(existing) !== sha256Hex(bytes)) throw new Error(`workspace path collision: ${logicalPath}`);
    return;
  }
  writeFileSync(path, bytes);
}

interface CasEntryUsage {
  path: string;
  bytes: number;
  lastUsedMs: number;
}

class NativePackCasStore {
  private readonly root: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly pruneIntervalMs: number;
  private lastPruneAt = 0;
  private pendingPrune: Promise<NativePackCasPruneResult> | undefined;

  constructor(root: string, limits: NativePackCasLimits = {}) {
    this.root = resolve(root);
    this.ttlMs = nonNegativeCasInteger(limits.ttlMs, DEFAULT_CAS_TTL_MS, 'Pack CAS ttlMs');
    this.maxEntries = positiveCasInteger(limits.maxEntries, DEFAULT_CAS_MAX_ENTRIES, 'Pack CAS maxEntries');
    this.maxTotalBytes = positiveCasInteger(
      limits.maxTotalBytes,
      DEFAULT_CAS_MAX_TOTAL_BYTES,
      'Pack CAS maxTotalBytes',
    );
    this.pruneIntervalMs = nonNegativeCasInteger(
      limits.pruneIntervalMs,
      DEFAULT_CAS_PRUNE_INTERVAL_MS,
      'Pack CAS pruneIntervalMs',
    );
    mkdirSync(join(this.root, 'sha256'), { recursive: true });
  }

  hasVerifiedBlob(file: CopiedPackFile): boolean {
    const blob = casBlobPath(this.root, file.sha256);
    if (!existsSync(blob)) return false;
    return withCasBlobLease(blob, () => {
      ensureCasBlob(this.root, file.absolute, file.sha256, `Pack CAS file ${file.path}`);
      this.touch(blob);
      return true;
    });
  }

  materialize(
    file: CopiedPackFile,
    label: string,
    workspace: string,
    logicalPath: string,
  ): void {
    const blob = casBlobPath(this.root, file.sha256);
    withCasBlobLease(blob, () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const available = ensureCasBlob(this.root, file.absolute, file.sha256, label);
        try {
          linkWorkspaceFile(workspace, logicalPath, available, file.sha256);
          this.touch(available);
          return;
        } catch (error) {
          forgetCasBlob(available);
          if (attempt === 0 && !existsSync(available)) continue;
          throw error;
        }
      }
    });
  }

  maybePrune(): void {
    if (this.pendingPrune || Date.now() - this.lastPruneAt < this.pruneIntervalMs) return;
    void this.prune();
  }

  prune(): Promise<NativePackCasPruneResult> {
    if (this.pendingPrune) return this.pendingPrune;
    this.lastPruneAt = Date.now();
    const pending = this.pruneEntries()
      .catch(() => ({
        scannedEntries: 0,
        removedEntries: 0,
        totalEntries: 0,
        totalBytes: 0,
        quotaSatisfied: false,
      }))
      .finally(() => {
        if (this.pendingPrune === pending) this.pendingPrune = undefined;
      });
    this.pendingPrune = pending;
    return pending;
  }

  private touch(blob: string): void {
    const now = Date.now();
    if (now - (CAS_BLOB_TOUCHES.get(blob) ?? 0) < CAS_TOUCH_INTERVAL_MS) return;
    try {
      const date = new Date(now);
      regularFileSnapshot(blob, 'Pack CAS');
      utimesSync(blob, date, date);
      rememberVerifiedCasBlob(blob, regularFileSnapshot(blob, 'Pack CAS'));
      rememberCasTouch(blob, now);
    } catch {
      // Recency is advisory. Integrity is checked again if the snapshot changes.
    }
  }

  private async pruneEntries(): Promise<NativePackCasPruneResult> {
    const now = Date.now();
    const entries: CasEntryUsage[] = [];
    let scannedEntries = 0;
    let removedEntries = 0;
    const shaRoot = join(this.root, 'sha256');
    let shards;
    try { shards = await readdir(shaRoot, { withFileTypes: true }); } catch {
      return { scannedEntries, removedEntries, totalEntries: 0, totalBytes: 0, quotaSatisfied: true };
    }

    for (const shard of shards) {
      if (!shard.isDirectory() || shard.isSymbolicLink() || !CAS_SHARD.test(shard.name)) continue;
      const shardPath = join(shaRoot, shard.name);
      let children;
      try { children = await readdir(shardPath, { withFileTypes: true }); } catch { continue; }
      for (const child of children) {
        const path = join(shardPath, child.name);
        if (CAS_TEMPORARY.test(child.name)) {
          const modified = await casModifiedTime(path);
          if (modified !== null && modified <= now - CAS_TEMPORARY_GRACE_MS) {
            await removeCasPath(path);
          }
          continue;
        }
        if (!SHA256.test(child.name) || child.name.slice(0, 2) !== shard.name) continue;
        scannedEntries++;
        let stat;
        try { stat = await lstat(path); } catch { continue; }
        if (!stat.isFile() || stat.isSymbolicLink()) {
          if (await removeCasPath(path)) removedEntries++;
          continue;
        }
        const entry = { path, bytes: stat.size, lastUsedMs: stat.mtimeMs };
        if (this.ttlMs > 0 && stat.mtimeMs <= now - this.ttlMs && !ACTIVE_CAS_BLOBS.has(path)) {
          if (await removeCasPath(path)) removedEntries++;
          continue;
        }
        entries.push(entry);
      }
    }

    entries.sort((left, right) => left.lastUsedMs - right.lastUsedMs || left.path.localeCompare(right.path));
    let totalEntries = entries.length;
    let totalBytes = entries.reduce(
      (sum, entry) => Math.min(Number.MAX_SAFE_INTEGER, sum + entry.bytes),
      0,
    );
    for (const entry of entries) {
      if (totalEntries <= this.maxEntries && totalBytes <= this.maxTotalBytes) break;
      if (ACTIVE_CAS_BLOBS.has(entry.path)) continue;
      if (await removeCasPath(entry.path)) {
        removedEntries++;
        totalEntries--;
        totalBytes = Math.max(0, totalBytes - entry.bytes);
      }
    }
    return {
      scannedEntries,
      removedEntries,
      totalEntries,
      totalBytes,
      quotaSatisfied: totalEntries <= this.maxEntries && totalBytes <= this.maxTotalBytes,
    };
  }
}

function ensureCasBlob(
  casRoot: string,
  sourcePath: string,
  expectedSha256: Sha256,
  label: string,
): string {
  const root = resolve(casRoot);
  const directory = join(root, 'sha256', expectedSha256.slice(0, 2));
  const blob = join(directory, expectedSha256);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(blob)) {
    const bytes = readRegularFile(sourcePath, label);
    if (sha256Hex(bytes) !== expectedSha256) throw new TypeError(`hash mismatch for ${label}`);
    const temporary = `${blob}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, bytes, { flag: 'wx' });
    try {
      renameSync(temporary, blob);
    } catch (error) {
      if (!existsSync(blob)) throw error;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  const snapshot = regularFileSnapshot(blob, 'Pack CAS');
  const verified = VERIFIED_CAS_BLOBS.get(blob);
  if (!verified || !sameFileSnapshot(verified, snapshot)) {
    const bytes = readRegularFile(blob, 'Pack CAS');
    if (sha256Hex(bytes) !== expectedSha256) {
      forgetCasBlob(blob);
      try {
        const current = regularFileSnapshot(blob, 'Pack CAS');
        if (sameFileSnapshot(snapshot, current)) rmSync(blob, { force: true });
      } catch {
        // A concurrent replacement or cleanup already changed the bad address.
      }
      throw new TypeError(`Pack CAS hash mismatch: ${expectedSha256}`);
    }
    rememberVerifiedCasBlob(blob, regularFileSnapshot(blob, 'Pack CAS'));
  }
  return blob;
}

function regularFileSnapshot(path: string, label: string): FileSnapshot {
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error(`${label} file is missing: ${path}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} file is not regular: ${path}`);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
  };
}

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.dev === right.dev
    && left.ino === right.ino;
}

function withCasBlobLease<T>(blob: string, task: () => T): T {
  ACTIVE_CAS_BLOBS.set(blob, (ACTIVE_CAS_BLOBS.get(blob) ?? 0) + 1);
  try {
    return task();
  } finally {
    const count = ACTIVE_CAS_BLOBS.get(blob) ?? 0;
    if (count <= 1) ACTIVE_CAS_BLOBS.delete(blob);
    else ACTIVE_CAS_BLOBS.set(blob, count - 1);
  }
}

function rememberVerifiedCasBlob(blob: string, snapshot: FileSnapshot): void {
  rememberBoundedCasValue(VERIFIED_CAS_BLOBS, blob, snapshot);
}

function rememberCasTouch(blob: string, touchedAt: number): void {
  rememberBoundedCasValue(CAS_BLOB_TOUCHES, blob, touchedAt);
}

function rememberBoundedCasValue<T>(map: Map<string, T>, key: string, value: T): void {
  if (!map.has(key) && map.size >= DEFAULT_CAS_MAX_ENTRIES) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function forgetCasBlob(blob: string): void {
  VERIFIED_CAS_BLOBS.delete(blob);
  CAS_BLOB_TOUCHES.delete(blob);
}

async function casModifiedTime(path: string): Promise<number | null> {
  try { return (await lstat(path)).mtimeMs; } catch { return null; }
}

async function removeCasPath(path: string): Promise<boolean> {
  if (ACTIVE_CAS_BLOBS.has(path)) return false;
  try {
    await rm(path, { recursive: true, force: true });
    forgetCasBlob(path);
    return true;
  } catch {
    return false;
  }
}

function positiveCasInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new TypeError(`${label} must be a positive integer`);
  return resolved;
}

function nonNegativeCasInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return resolved;
}

function casBlobPath(casRoot: string, sha256: Sha256): string {
  return join(resolve(casRoot), 'sha256', sha256.slice(0, 2), sha256);
}

function linkWorkspaceFile(
  workspace: string,
  logicalPath: string,
  blob: string,
  expectedSha256: Sha256,
): void {
  const root = resolve(workspace);
  const path = resolve(root, ...logicalPath.split('/'));
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new TypeError(`workspace path escapes root: ${logicalPath}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const existing = readRegularFile(path, 'workspace');
    if (sha256Hex(existing) !== expectedSha256) throw new Error(`workspace path collision: ${logicalPath}`);
    return;
  }
  try {
    linkSync(blob, path);
  } catch {
    copyFileSync(blob, path);
  }
}

function normalizeLogicalPath(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new TypeError(`${label} must be relative: ${value}`);
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new TypeError(`${label} contains an invalid segment: ${value}`);
  return segments.join('/');
}

function joinLogical(left: string, right: string): string {
  return normalizeLogicalPath(`${left}/${right}`, 'Pack logical path');
}

function isAbsoluteHostPath(value: string): boolean {
  return isAbsolute(value);
}

function pathContains(root: string, candidate: string): boolean {
  const rootIdentity = nativeFileSystemObjectIdentity(root, 'directory');
  let current = nativeFileSystemObjectIdentity(candidate);
  const visited = new Set<string>();
  for (;;) {
    if (sameFileSystemObject(rootIdentity, current)) return true;
    const objectKey = `${current.dev.toString(16)}:${current.ino.toString(16)}`;
    if (visited.has(objectKey)) return false;
    visited.add(objectKey);
    const parent = dirname(current.canonicalPath);
    if (parent === current.canonicalPath) return false;
    current = nativeFileSystemObjectIdentity(parent, 'directory');
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
