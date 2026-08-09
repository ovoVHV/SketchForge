#!/usr/bin/env node

import { webcrypto } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DefaultNativeToolResolver,
  LocalExecutor,
  NativeExecutor,
  canonicalJson,
  createNativeToolIntegrityManifest,
  detectLocalToolchain,
  sha256Hex,
  type BuildAction,
  type BuildIR,
  type BuildPacks,
  type NativeActionRunnerResult,
  type NativePackProvider,
  type NativePythonInterpreter,
  type NativeToolClosureIdentity,
  type SandboxExecutor,
  type ToolchainConfig,
} from '../packages/core/src/index.js';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

const ROOT = resolve(import.meta.dirname, '..');
const RUNNER = fileURLToPath(import.meta.url);
const SHA256 = /^[a-f0-9]{64}$/;
const NATIVE_TOOL_IDENTITY_SCHEMA = 3;
const NATIVE_TOOL_IDENTITY_MODE = 'strict-pack-bound-recursive-closure-and-python-sha256-v2';
const NATIVE_TOOL_IDS = Object.freeze([
  'toolchain:ar',
  'toolchain:cc',
  'toolchain:cxx',
  'toolchain:objcopy',
]);
const EXPECTED_NATIVE_TOOL_IDENTITY = 'CK_NATIVE_TOOL_IDENTITY_SHA256';
const NATIVE_PYTHON_ENV = 'CK_NATIVE_PYTHON';
const NATIVE_LIBRARY_REQUEST_SCHEMA = 2;
const NATIVE_LIBRARY_SNAPSHOT_SCHEMA = 1;
const NATIVE_LIBRARY_FINGERPRINT_SCHEMA = 2;
const NATIVE_LIBRARY_CLOSURE_ENV = 'CK_NATIVE_LIBRARY_CLOSURE_SHA256';
const NATIVE_LIBRARY_SNAPSHOT_ROOT_ENV = 'CK_NATIVE_LIBRARY_SNAPSHOT_ROOT';
const NATIVE_LIBRARY_RESULT_PREFIX = 'CK_NATIVE_LIBRARY_RESULT ';
const MAX_NATIVE_LIBRARY_SNAPSHOT_DESCRIPTOR_BYTES = 4 * 1024 * 1024;

const TARGETS = Object.freeze({
  esp32: Object.freeze({
    board: 'esp32:esp32:esp32',
    architecture: 'xtensa',
    runtime: 'esp32-xtensa',
    defaultRoot: 'packages/web/public/esp32/v5/xtensa',
    descriptor: 'esp32.json',
    imageBuilder: 'buildEsp32Image',
  }),
  s2: Object.freeze({
    board: 'esp32:esp32:esp32s2',
    architecture: 'xtensa',
    runtime: 'esp32-xtensa',
    defaultRoot: 'packages/web/public/esp32/v5/xtensa',
    descriptor: 'esp32s2.json',
    imageBuilder: 'buildEsp32S2Image',
  }),
  s3: Object.freeze({
    board: 'esp32:esp32:esp32s3',
    architecture: 'xtensa',
    runtime: 'esp32-xtensa',
    defaultRoot: 'packages/web/public/esp32/v5/xtensa',
    descriptor: 'esp32s3.json',
    imageBuilder: 'buildEsp32S3Image',
  }),
  c3: Object.freeze({
    board: 'esp32:esp32:esp32c3',
    architecture: 'riscv32',
    runtime: 'esp32-riscv',
    defaultRoot: 'packages/web/public/esp32/v2/runtime',
    descriptor: 'runtime.json',
    imageBuilder: 'buildEsp32C3Image',
  }),
  c6: Object.freeze({
    board: 'esp32:esp32:esp32c6',
    architecture: 'riscv32',
    runtime: 'esp32-riscv',
    defaultRoot: 'packages/web/public/esp32/v2/runtime-c6',
    descriptor: 'runtime.json',
    imageBuilder: 'buildEsp32C6Image',
  }),
});

type TargetName = keyof typeof TARGETS;

interface SmokeOptions {
  projectFiles: readonly { name: string; content: string }[];
  macros: Readonly<Record<string, true | string>>;
  registry?: string;
  onlyAction?: string;
  traceCompiler: boolean;
}

interface NativeLibraryRootIdentity {
  readonly library: string;
  readonly version: string;
  readonly packId: string;
  readonly revision: string;
  readonly artifact: string;
}

interface NativeLibraryVerifierRequest {
  readonly schema: 2;
  readonly snapshot: {
    readonly root: string;
    readonly descriptor: string;
    readonly closureSha256: string;
  };
  readonly expectedRoot: NativeLibraryRootIdentity;
  readonly header: string;
  readonly target: TargetName;
  readonly projectFiles: readonly { name: string; content: string }[];
  readonly macros: Readonly<Record<string, true | string>>;
  readonly onlyAction?: string;
  readonly traceCompiler: boolean;
}

interface LibrarySelection {
  name: string;
  version: string;
  packId: string;
  revision: string;
  manifestUrl: string;
  artifact: string;
  dependencies: readonly { name: string; version: string }[];
}

interface NativeIdentityPackInput {
  role: 'compiler' | 'sdk' | 'board';
  id: string;
  revision: string;
  version: string;
  schema: number;
}

interface NativeIdentityTargetInput {
  target: TargetName;
  board: string;
  packs: readonly NativeIdentityPackInput[];
}

interface NativeExecutionIdentityRequest {
  schema: number;
  hostPlatform: NodeJS.Platform;
  pythonInterpreter?: NativePythonInterpreter;
  targets: readonly NativeIdentityTargetInput[];
}

interface NativeToolBindingOptions {
  hostPlatform?: NodeJS.Platform;
  pythonInterpreter?: NativePythonInterpreter;
}

function packIdentity(pack: BuildPacks['toolchain'] | BuildPacks['platform'] | BuildPacks['board']) {
  return Object.freeze({ id: pack.id, revision: pack.sha256 });
}

function nativeTargetIdentityBody(
  targetName: TargetName,
  packs: BuildPacks,
  tools: readonly {
  id: string;
  packSha256: string;
  command: string;
  commandSha256: string;
  closure: NativeToolClosureIdentity;
  }[],
  hostPlatform: NodeJS.Platform,
  pythonInterpreter?: NativePythonInterpreter,
) {
  return Object.freeze({
    schema: NATIVE_TOOL_IDENTITY_SCHEMA,
    mode: NATIVE_TOOL_IDENTITY_MODE,
    hostPlatform,
    toolSource: 'host-native-substitution',
    packToolEquivalence: false,
    target: targetName,
    board: packs.board.fqbn,
    packs: Object.freeze({
      compiler: packIdentity(packs.toolchain),
      sdk: packIdentity(packs.platform),
      board: packIdentity(packs.board),
    }),
    tools: Object.freeze(tools),
    ...(pythonInterpreter === undefined ? {} : { pythonInterpreter: Object.freeze(pythonInterpreter) }),
  });
}

/**
 * Capture the host commands once, then execute through a resolver that verifies
 * those command bytes against their exact IR Pack identities on every resolve.
 */
export function createVerifiedNativeToolBinding(
  config: ToolchainConfig,
  packs: BuildPacks,
  targetName: TargetName,
  options: NativeToolBindingOptions = {},
) {
  const hostPlatform = options.hostPlatform ?? process.platform;
  const pythonInterpreter = normalizeNativePythonInterpreter(options.pythonInterpreter, hostPlatform);
  const integrity = createNativeToolIntegrityManifest({ config }, packs, NATIVE_TOOL_IDS);
  const resolver = new DefaultNativeToolResolver({
    config,
    integrity,
    hostPlatform,
    pythonInterpreter,
  });
  const tools = NATIVE_TOOL_IDS.map((id) => {
    const command = resolver.resolve(id, packs);
    if (!isAbsolute(command)) throw new Error(`native tool command must be absolute: ${id}`);
    const entry = integrity[id];
    if (!entry) throw new Error(`native tool integrity manifest is missing: ${id}`);
    return Object.freeze({
      id,
      packSha256: entry.packSha256,
      command: resolve(command),
      commandSha256: entry.commandSha256,
      closure: entry.closure,
    });
  });
  const body = nativeTargetIdentityBody(targetName, packs, tools, hostPlatform, pythonInterpreter);
  const evidence = Object.freeze({
    ...body,
    sha256: sha256Hex(canonicalJson(body)),
  });
  return Object.freeze({ integrity, resolver, evidence });
}

/** Build the no-compile identity document consumed by the Native Matrix runner. */
export function createNativeExecutionIdentity(
  value: unknown,
  config: ToolchainConfig = detectLocalToolchain(),
) {
  const request = validateNativeExecutionIdentityRequest(value);
  const targets = request.targets
    .map((input) => createVerifiedNativeToolBinding(
      config,
      identityBuildPacks(input),
      input.target,
      { hostPlatform: request.hostPlatform, pythonInterpreter: request.pythonInterpreter },
    ).evidence)
    .sort((left, right) => left.target.localeCompare(right.target));
  const body = Object.freeze({
    schema: NATIVE_TOOL_IDENTITY_SCHEMA,
    mode: NATIVE_TOOL_IDENTITY_MODE,
    hostPlatform: request.hostPlatform,
    ...(request.pythonInterpreter === undefined ? {} : { pythonInterpreter: request.pythonInterpreter }),
    targets: Object.freeze(targets),
  });
  return Object.freeze({
    ...body,
    sha256: sha256Hex(canonicalJson(body)),
  });
}

function validateNativeExecutionIdentityRequest(value: unknown): NativeExecutionIdentityRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('native execution identity request must be an object');
  }
  const candidate = value as {
    schema?: unknown;
    hostPlatform?: unknown;
    pythonInterpreter?: unknown;
    targets?: unknown;
  };
  rejectUnknownKeys(candidate, ['schema', 'hostPlatform', 'pythonInterpreter', 'targets'], 'native execution identity request');
  if (
    candidate.schema !== NATIVE_TOOL_IDENTITY_SCHEMA
    || !isNodePlatform(candidate.hostPlatform)
    || !Array.isArray(candidate.targets)
    || !candidate.targets.length
  ) {
    throw new TypeError('native execution identity request is invalid');
  }
  const pythonInterpreter = normalizeNativePythonInterpreter(
    candidate.pythonInterpreter,
    candidate.hostPlatform,
  );
  const seenTargets = new Set<string>();
  const targets = candidate.targets.map((entry, index): NativeIdentityTargetInput => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`native execution identity target ${index} is invalid`);
    }
    const target = entry as { target?: unknown; board?: unknown; packs?: unknown };
    rejectUnknownKeys(target, ['target', 'board', 'packs'], `native execution identity target ${index}`);
    if (typeof target.target !== 'string' || !(target.target in TARGETS)) {
      throw new TypeError(`native execution identity target ${index} has an invalid name`);
    }
    const targetName = target.target as TargetName;
    if (seenTargets.has(targetName)) throw new TypeError(`duplicate native execution identity target: ${targetName}`);
    seenTargets.add(targetName);
    if (target.board !== TARGETS[targetName].board || !Array.isArray(target.packs)) {
      throw new TypeError(`native execution identity target ${targetName} does not match its board`);
    }
    const packs = target.packs.map((pack, packIndex): NativeIdentityPackInput => {
      if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
        throw new TypeError(`native execution identity target ${targetName} Pack ${packIndex} is invalid`);
      }
      const item = pack as Record<string, unknown>;
      rejectUnknownKeys(
        item,
        ['role', 'id', 'revision', 'version', 'schema'],
        `native execution identity target ${targetName} Pack ${packIndex}`,
      );
      if (
        !['compiler', 'sdk', 'board'].includes(String(item.role))
        || typeof item.id !== 'string'
        || !item.id
        || typeof item.revision !== 'string'
        || !SHA256.test(item.revision)
        || typeof item.version !== 'string'
        || !item.version
        || !Number.isSafeInteger(item.schema)
        || Number(item.schema) < 1
      ) throw new TypeError(`native execution identity target ${targetName} Pack ${packIndex} is invalid`);
      return Object.freeze({
        role: item.role as NativeIdentityPackInput['role'],
        id: item.id,
        revision: item.revision,
        version: item.version,
        schema: Number(item.schema),
      });
    });
    for (const role of ['compiler', 'sdk', 'board'] as const) {
      if (packs.filter((pack) => pack.role === role).length !== 1) {
        throw new TypeError(`native execution identity target ${targetName} requires one ${role} Pack`);
      }
    }
    if (packs.length !== 3) throw new TypeError(`native execution identity target ${targetName} has extra Packs`);
    return Object.freeze({ target: targetName, board: target.board, packs: Object.freeze(packs) });
  });
  return Object.freeze({
    schema: NATIVE_TOOL_IDENTITY_SCHEMA,
    hostPlatform: candidate.hostPlatform,
    ...(pythonInterpreter === undefined ? {} : { pythonInterpreter }),
    targets: Object.freeze(targets),
  });
}

function isNodePlatform(value: unknown): value is NodeJS.Platform {
  return typeof value === 'string' && new Set([
    'aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd',
  ]).has(value);
}

function rejectUnknownKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

/**
 * Normalize the host interpreter once and bind both its bytes and its narrow
 * directory. The verifier never falls back to a PATH lookup for this tool.
 */
function normalizeNativePythonInterpreter(
  value: unknown,
  hostPlatform: NodeJS.Platform,
): NativePythonInterpreter | undefined {
  if (hostPlatform === 'win32') {
    if (value !== undefined) throw new TypeError('Windows native identity must not contain a POSIX Python interpreter');
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('POSIX native identity requires an explicit Python interpreter');
  }
  const candidate = value as Record<string, unknown>;
  rejectUnknownKeys(candidate, ['command', 'commandSha256', 'authorizedDirectory'], 'POSIX Python interpreter');
  if (
    typeof candidate.command !== 'string'
    || !isAbsolute(candidate.command)
    || typeof candidate.commandSha256 !== 'string'
    || !SHA256.test(candidate.commandSha256)
    || typeof candidate.authorizedDirectory !== 'string'
    || !isAbsolute(candidate.authorizedDirectory)
  ) throw new TypeError('POSIX Python interpreter identity is invalid');
  let command: string;
  let authorizedDirectory: string;
  try {
    command = realpathSync(resolve(candidate.command));
    authorizedDirectory = realpathSync(resolve(candidate.authorizedDirectory));
  } catch {
    throw new TypeError('POSIX Python interpreter identity path does not exist');
  }
  let commandStat;
  try { commandStat = lstatSync(command); } catch { throw new TypeError('POSIX Python interpreter is missing'); }
  if (!commandStat.isFile()) throw new TypeError('POSIX Python interpreter is not a regular file');
  let directoryStat;
  try { directoryStat = lstatSync(authorizedDirectory); } catch {
    throw new TypeError('POSIX Python interpreter authorization directory is missing');
  }
  if (!directoryStat.isDirectory()) {
    throw new TypeError('POSIX Python interpreter authorization path is not a directory');
  }
  if (authorizedDirectory !== dirname(command)) {
    throw new TypeError('POSIX Python interpreter authorization directory must be its executable directory');
  }
  if (!pathContains(authorizedDirectory, command)) {
    throw new TypeError('POSIX Python interpreter is outside its authorized directory');
  }
  const commandSha256 = sha256Hex(readFileSync(command));
  if (commandSha256 !== candidate.commandSha256) {
    throw new TypeError('POSIX Python interpreter command hash mismatch');
  }
  return Object.freeze({ command, commandSha256, authorizedDirectory });
}

function nativePythonInterpreterFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NativePythonInterpreter | undefined {
  if (process.platform === 'win32') return undefined;
  const command = environment[NATIVE_PYTHON_ENV];
  if (typeof command !== 'string' || !command) {
    throw new Error(`${NATIVE_PYTHON_ENV} is required for POSIX native partition execution`);
  }
  if (!isAbsolute(command)) throw new Error(`${NATIVE_PYTHON_ENV} must be an absolute path`);
  const canonical = realpathSync(resolve(command));
  const stat = lstatSync(canonical);
  if (!stat.isFile()) throw new Error(`${NATIVE_PYTHON_ENV} is not a regular file`);
  return normalizeNativePythonInterpreter({
    command: canonical,
    commandSha256: sha256Hex(readFileSync(canonical)),
    authorizedDirectory: dirname(canonical),
  }, process.platform);
}

function pathContains(root: string, candidate: string): boolean {
  const left = resolve(root);
  const right = resolve(candidate);
  const remainder = relative(left, right);
  return remainder === '' || (
    remainder !== '..'
    && !remainder.startsWith(`..${sep}`)
    && !isAbsolute(remainder)
  );
}

function identityBuildPacks(input: NativeIdentityTargetInput): BuildPacks {
  const compiler = input.packs.find((pack) => pack.role === 'compiler')!;
  const sdk = input.packs.find((pack) => pack.role === 'sdk')!;
  const board = input.packs.find((pack) => pack.role === 'board')!;
  const target = TARGETS[input.target];
  return Object.freeze({
    toolchain: Object.freeze({
      kind: 'toolchain' as const,
      id: compiler.id,
      version: compiler.version,
      sha256: compiler.revision,
      abi: target.architecture === 'riscv32' ? 'riscv32-esp-elf' : 'xtensa-esp-elf',
      instructionSet: input.target,
    }),
    platform: Object.freeze({
      kind: 'platform' as const,
      id: sdk.id,
      version: sdk.version,
      sha256: sdk.revision,
      platform: 'arduino-esp32',
    }),
    board: Object.freeze({
      kind: 'board' as const,
      id: board.id,
      version: board.version,
      sha256: board.revision,
      fqbn: input.board,
      variant: input.target,
    }),
    libraries: Object.freeze({ roots: Object.freeze([]), packs: Object.freeze([]) }),
  });
}

export function validateNativeLibraryVerifierRequest(value: unknown): NativeLibraryVerifierRequest {
  const candidate = exactSnapshotRecord(value, [
    'schema', 'snapshot', 'expectedRoot', 'header', 'target', 'projectFiles', 'macros', 'onlyAction',
    'traceCompiler',
  ], 'native Library Pack verifier request', ['onlyAction']);
  if (candidate.schema !== NATIVE_LIBRARY_REQUEST_SCHEMA) {
    throw new Error('unsupported native Library Pack verifier request schema');
  }
  const snapshot = exactSnapshotRecord(candidate.snapshot, [
    'root', 'descriptor', 'closureSha256',
  ], 'native Library Pack verifier snapshot');
  if (
    typeof snapshot.root !== 'string'
    || !isAbsolute(snapshot.root)
    || typeof snapshot.descriptor !== 'string'
    || !isAbsolute(snapshot.descriptor)
    || typeof snapshot.closureSha256 !== 'string'
    || !SHA256.test(snapshot.closureSha256)
  ) throw new Error('native Library Pack verifier snapshot is invalid');
  const expectedRoot = validateNativeLibraryRootIdentity(candidate.expectedRoot, 'request expected root');
  if (typeof candidate.header !== 'string' || !candidate.header || candidate.header.includes('\0')) {
    throw new Error('native Library Pack verifier request header is invalid');
  }
  if (typeof candidate.target !== 'string' || !(candidate.target in TARGETS)) {
    throw new Error('native Library Pack verifier request target is invalid');
  }
  if (!Array.isArray(candidate.projectFiles) || candidate.projectFiles.length > 256) {
    throw new Error('native Library Pack verifier request projectFiles are invalid');
  }
  const names = new Set<string>();
  const projectFiles = candidate.projectFiles.map((input, index) => {
    const file = exactSnapshotRecord(input, ['name', 'content'], `native Library Pack project file ${index}`);
    if (
      typeof file.name !== 'string'
      || !file.name
      || file.name.length > 512
      || file.name.includes('\0')
      || /^[\\/]/.test(file.name)
      || /^[A-Za-z]:[\\/]/.test(file.name)
      || file.name.split(/[\\/]/).includes('..')
      || typeof file.content !== 'string'
      || names.has(file.name)
    ) throw new Error(`native Library Pack project file ${index} is invalid`);
    names.add(file.name);
    return Object.freeze({ name: file.name, content: file.content });
  });
  if (!candidate.macros || typeof candidate.macros !== 'object' || Array.isArray(candidate.macros)) {
    throw new Error('native Library Pack verifier request macros are invalid');
  }
  const macros: Record<string, true | string> = {};
  for (const [name, macro] of Object.entries(candidate.macros)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || (macro !== true && typeof macro !== 'string')) {
      throw new Error('native Library Pack verifier request macros are invalid');
    }
    macros[name] = macro;
  }
  if (candidate.onlyAction !== undefined && (typeof candidate.onlyAction !== 'string' || !candidate.onlyAction)) {
    throw new Error('native Library Pack verifier request onlyAction is invalid');
  }
  if (typeof candidate.traceCompiler !== 'boolean') {
    throw new Error('native Library Pack verifier request traceCompiler is invalid');
  }
  return Object.freeze({
    schema: NATIVE_LIBRARY_REQUEST_SCHEMA,
    snapshot: Object.freeze({
      root: snapshot.root as string,
      descriptor: snapshot.descriptor as string,
      closureSha256: snapshot.closureSha256 as string,
    }),
    expectedRoot,
    header: candidate.header,
    target: candidate.target as TargetName,
    projectFiles: Object.freeze(projectFiles),
    macros: Object.freeze(macros),
    ...(candidate.onlyAction === undefined ? {} : { onlyAction: candidate.onlyAction as string }),
    traceCompiler: candidate.traceCompiler,
  });
}

export async function loadNativeLibraryPackSnapshot(
  input: unknown,
  options: { expectedClosureSha256?: string; expectedSnapshotRoot?: string } = {},
) {
  const request = validateNativeLibraryVerifierRequest(input);
  const expectedClosure = options.expectedClosureSha256 ?? process.env[NATIVE_LIBRARY_CLOSURE_ENV];
  if (typeof expectedClosure !== 'string' || !SHA256.test(expectedClosure)) {
    throw new Error('native Library Pack expected closure SHA-256 is missing');
  }
  if (request.snapshot.closureSha256 !== expectedClosure) {
    throw new Error('native Library Pack request closure SHA-256 mismatch');
  }
  const expectedRoot = resolve(options.expectedSnapshotRoot ?? process.env[NATIVE_LIBRARY_SNAPSHOT_ROOT_ENV] ?? '');
  if (!isAbsolute(expectedRoot) || resolve(request.snapshot.root) !== expectedRoot) {
    throw new Error('native Library Pack snapshot root does not match the authorized root');
  }
  const descriptorRelative = relative(expectedRoot, resolve(request.snapshot.descriptor)).split(sep).join('/');
  if (descriptorRelative !== `snapshots/${expectedClosure}/snapshot.json`) {
    throw new Error('native Library Pack snapshot descriptor path is not content-addressed');
  }
  const descriptorBytes = await readCanonicalSnapshotFile(
    expectedRoot,
    request.snapshot.descriptor,
    'native Library Pack snapshot descriptor',
  );
  if (descriptorBytes.byteLength > MAX_NATIVE_LIBRARY_SNAPSHOT_DESCRIPTOR_BYTES) {
    throw new Error('native Library Pack snapshot descriptor exceeds its byte limit');
  }
  let descriptorValue: unknown;
  try {
    descriptorValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(descriptorBytes));
  } catch {
    throw new Error('native Library Pack snapshot descriptor is not valid UTF-8 JSON');
  }
  const descriptor = exactSnapshotRecord(
    descriptorValue,
    ['schema', 'closure', 'registry', 'packs'],
    'native Library Pack snapshot descriptor',
  );
  if (descriptor.schema !== NATIVE_LIBRARY_SNAPSHOT_SCHEMA) {
    throw new Error('unsupported native Library Pack snapshot schema');
  }
  const closure = exactSnapshotRecord(
    descriptor.closure,
    ['schema', 'registry', 'root', 'packs', 'sha256'],
    'native Library Pack snapshot closure',
  );
  if (closure.schema !== NATIVE_LIBRARY_FINGERPRINT_SCHEMA || closure.sha256 !== expectedClosure) {
    throw new Error('native Library Pack snapshot closure identity mismatch');
  }
  const registryIdentity = validateSnapshotByteIdentity(closure.registry, 'snapshot Registry identity');
  const rootIdentity = validateNativeLibraryRootIdentity(closure.root, 'snapshot root identity');
  if (canonicalJson(rootIdentity) !== canonicalJson(request.expectedRoot)) {
    throw new Error('native Library Pack snapshot root identity mismatch');
  }
  if (!Array.isArray(closure.packs) || !closure.packs.length) {
    throw new Error('native Library Pack snapshot closure packs are invalid');
  }
  const closurePacks = Object.freeze(closure.packs.map((pack, index) => {
    const value = exactSnapshotRecord(pack, [
      'library', 'id', 'version', 'revision', 'artifact', 'sha256',
    ], `native Library Pack closure pack ${index}`);
    for (const field of ['library', 'id', 'version', 'artifact']) {
      if (typeof value[field] !== 'string' || !value[field]) {
        throw new Error(`native Library Pack closure pack ${index} identity is invalid`);
      }
    }
    if (typeof value.revision !== 'string' || !SHA256.test(value.revision)
      || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
      throw new Error(`native Library Pack closure pack ${index} digest is invalid`);
    }
    return Object.freeze({
      library: value.library as string,
      id: value.id as string,
      version: value.version as string,
      revision: value.revision as string,
      artifact: value.artifact as string,
      sha256: value.sha256 as string,
    });
  }));
  const closureBody = Object.freeze({
    schema: NATIVE_LIBRARY_FINGERPRINT_SCHEMA,
    registry: registryIdentity,
    root: rootIdentity,
    packs: closurePacks,
  });
  if (sha256Hex(canonicalJson(closureBody)) !== expectedClosure) {
    throw new Error('native Library Pack snapshot closure SHA-256 mismatch');
  }

  const objectCache = new Map<string, Buffer>();
  const readObject = async (inputObject: unknown, label: string): Promise<Buffer> => {
    const object = validateSnapshotObjectReference(inputObject, label);
    const cached = objectCache.get(object.sha256);
    if (cached) {
      if (cached.byteLength !== object.bytes) throw new Error(`${label} byte length conflicts with cached object`);
      return cached;
    }
    const bytes = await readCanonicalSnapshotFile(expectedRoot, join(expectedRoot, ...object.path.split('/')), label);
    if (bytes.byteLength !== object.bytes || sha256Hex(bytes) !== object.sha256) {
      throw new Error(`${label} content digest mismatch`);
    }
    objectCache.set(object.sha256, bytes);
    return bytes;
  };

  const registryDescriptor = exactSnapshotRecord(
    descriptor.registry,
    ['path', 'object'],
    'native Library Pack snapshot Registry',
  );
  if (registryDescriptor.path !== 'registry.json') {
    throw new Error('native Library Pack snapshot Registry path is invalid');
  }
  const registryBytes = await readObject(registryDescriptor.object, 'native Library Pack snapshot Registry object');
  if (registryBytes.byteLength !== registryIdentity.bytes || sha256Hex(registryBytes) !== registryIdentity.sha256) {
    throw new Error('native Library Pack snapshot Registry identity mismatch');
  }
  if (!Array.isArray(descriptor.packs) || descriptor.packs.length !== closurePacks.length) {
    throw new Error('native Library Pack snapshot materialized pack set is invalid');
  }

  const virtualRegistryUrl = new URL('file:///__ck_native_library_snapshot__/registry.json');
  const virtualFiles = new Map<string, Buffer>([[virtualRegistryUrl.href, registryBytes]]);
  const decodedObjects = new Map<string, Buffer>();
  const snapshotPacks = [];
  const addVirtualFile = (logicalPath: unknown, bytes: Buffer, label: string): URL => {
    const path = validateSnapshotLogicalPath(logicalPath, label);
    const url = new URL(path, virtualRegistryUrl);
    const previous = virtualFiles.get(url.href);
    if (previous && sha256Hex(previous) !== sha256Hex(bytes)) {
      throw new Error(`${label} collides with another snapshot file`);
    }
    virtualFiles.set(url.href, bytes);
    return url;
  };
  for (let index = 0; index < descriptor.packs.length; index += 1) {
    const pack = exactSnapshotRecord(descriptor.packs[index], [
      'library', 'version', 'packId', 'revision', 'artifact', 'identitySha256', 'manifest', 'chunks',
      'decodedArtifact',
    ], `native Library Pack snapshot pack ${index}`);
    for (const field of ['library', 'version', 'packId', 'artifact']) {
      if (typeof pack[field] !== 'string' || !pack[field]) {
        throw new Error(`native Library Pack snapshot pack ${index} identity is invalid`);
      }
    }
    if (typeof pack.revision !== 'string' || !SHA256.test(pack.revision)
      || typeof pack.identitySha256 !== 'string' || !SHA256.test(pack.identitySha256)) {
      throw new Error(`native Library Pack snapshot pack ${index} digest is invalid`);
    }
    const manifest = exactSnapshotRecord(pack.manifest, ['path', 'object'], `snapshot pack ${index} manifest`);
    const manifestBytes = await readObject(manifest.object, `snapshot pack ${index} manifest object`);
    const manifestUrl = addVirtualFile(manifest.path, manifestBytes, `snapshot pack ${index} manifest path`);
    if (!Array.isArray(pack.chunks)) throw new Error(`native Library Pack snapshot pack ${index} chunks are invalid`);
    const chunks = [];
    for (let chunkIndex = 0; chunkIndex < pack.chunks.length; chunkIndex += 1) {
      const chunk = exactSnapshotRecord(pack.chunks[chunkIndex], ['path', 'object'], `snapshot pack ${index} chunk ${chunkIndex}`);
      const bytes = await readObject(chunk.object, `snapshot pack ${index} chunk ${chunkIndex} object`);
      const url = addVirtualFile(chunk.path, bytes, `snapshot pack ${index} chunk ${chunkIndex} path`);
      chunks.push(Object.freeze({ path: chunk.path as string, url, bytes }));
    }
    const decodedArtifact = await readObject(pack.decodedArtifact, `snapshot pack ${index} decoded artifact`);
    const key = `${String(pack.library).toLowerCase()}\0${pack.version}`;
    if (decodedObjects.has(key)) throw new Error('native Library Pack snapshot has a duplicate library identity');
    decodedObjects.set(key, decodedArtifact);
    snapshotPacks.push(Object.freeze({
      library: pack.library as string,
      version: pack.version as string,
      packId: pack.packId as string,
      revision: pack.revision as string,
      artifact: pack.artifact as string,
      identitySha256: pack.identitySha256 as string,
      manifestUrl,
      manifestBytes,
      chunks: Object.freeze(chunks),
    }));
  }

  const snapshotFetch = async (inputValue: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const fetchRequest = inputValue instanceof Request ? inputValue : undefined;
    const method = String(init.method ?? fetchRequest?.method ?? 'GET').toUpperCase();
    const url = new URL(typeof inputValue === 'string' || inputValue instanceof URL ? inputValue : inputValue.url);
    if (method !== 'GET') return new Response('method not allowed', { status: 405 });
    const bytes = virtualFiles.get(url.href);
    if (!bytes) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': url.pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        'content-length': String(bytes.byteLength),
      },
    });
  };
  const {
    resolveEsp32BrowserLibraries,
    validateEsp32BrowserLibraryRegistry,
    ESP32_BROWSER_LIBRARY_PACK_LIMITS,
  } = await import('../packages/web/public/esp32/v1/library-registry.js');
  const { createBrowserToolchainPackLoader } = await import('../packages/web/public/avr/v3/toolchain-pack.js');
  const registry = validateEsp32BrowserLibraryRegistry(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(registryBytes)),
    virtualRegistryUrl,
  );
  const resolved = resolveEsp32BrowserLibraries(
    registry,
    [{ name: rootIdentity.library, version: rootIdentity.version }],
    'esp32',
  );
  if (!resolved.supported) {
    throw new Error(`native Library Pack snapshot Registry cannot resolve ${rootIdentity.library}@${rootIdentity.version}`);
  }
  const computedPacks = [];
  let rootSource: unknown;
  let rootManifest: unknown;
  let rootManifestUrl: URL | undefined;
  for (const selection of resolved.libraries as readonly LibrarySelection[]) {
    const materialized = snapshotPacks.find((pack) => (
      pack.library === selection.name && pack.version === selection.version
    ));
    if (
      !materialized
      || materialized.packId !== selection.packId
      || materialized.revision !== selection.revision
      || materialized.artifact !== selection.artifact
      || materialized.manifestUrl.href !== selection.manifestUrl
    ) throw new Error(`native Library Pack snapshot selection identity mismatch: ${selection.name}@${selection.version}`);
    const loader = createBrowserToolchainPackLoader({
      manifestUrl: materialized.manifestUrl,
      expectedId: selection.packId,
      expectedRevision: selection.revision,
      limits: ESP32_BROWSER_LIBRARY_PACK_LIMITS,
      fetchFn: snapshotFetch,
    });
    try {
      const manifest = await loader.loadManifest();
      if (manifest.version !== selection.version) {
        throw new Error(`native Library Pack snapshot version mismatch: ${selection.name}@${selection.version}`);
      }
      const loaded = await loader.loadArtifact(selection.artifact);
      if (loaded.artifact.kind !== 'library-source-json') {
        throw new Error(`native Library Pack snapshot source kind is invalid: ${selection.name}@${selection.version}`);
      }
      const decoded = decodedObjects.get(`${selection.name.toLowerCase()}\0${selection.version}`);
      if (!decoded || decoded.byteLength !== loaded.bytes.byteLength || sha256Hex(decoded) !== sha256Hex(loaded.bytes)) {
        throw new Error(`native Library Pack snapshot decoded artifact mismatch: ${selection.name}@${selection.version}`);
      }
      const source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
      if (source?.name !== selection.name || source?.version !== selection.version) {
        throw new Error(`native Library Pack snapshot decoded source identity mismatch: ${selection.name}@${selection.version}`);
      }
      const chunkIdentity = loaded.artifact.chunks.map((chunk: {
        path: string; size: number; sha256: string; compression?: string;
      }) => {
        const url = new URL(chunk.path, new URL('./', materialized.manifestUrl));
        const transport = virtualFiles.get(url.href);
        const logical = materialized.chunks.find((candidate) => candidate.url.href === url.href)?.path;
        if (!transport || !logical) throw new Error(`native Library Pack snapshot chunk is missing: ${chunk.path}`);
        return Object.freeze({
          path: logical,
          transportBytes: transport.byteLength,
          transportSha256: sha256Hex(transport),
          decodedBytes: chunk.size,
          decodedSha256: chunk.sha256,
          ...(chunk.compression === undefined ? {} : { compression: chunk.compression }),
        });
      });
      const packBody = Object.freeze({
        schema: NATIVE_LIBRARY_FINGERPRINT_SCHEMA,
        library: selection.name,
        id: manifest.id,
        version: manifest.version,
        revision: manifest.revision,
        manifest: Object.freeze({
          bytes: materialized.manifestBytes.byteLength,
          sha256: sha256Hex(materialized.manifestBytes),
        }),
        artifact: Object.freeze({
          id: loaded.artifact.id,
          kind: loaded.artifact.kind,
          bytes: loaded.bytes.byteLength,
          sha256: sha256Hex(loaded.bytes),
          chunks: Object.freeze(chunkIdentity),
        }),
      });
      const packSha256 = sha256Hex(canonicalJson(packBody));
      if (packSha256 !== materialized.identitySha256) {
        throw new Error(`native Library Pack snapshot Pack identity mismatch: ${selection.name}@${selection.version}`);
      }
      computedPacks.push(Object.freeze({
        library: selection.name,
        id: manifest.id,
        version: manifest.version,
        revision: manifest.revision,
        artifact: loaded.artifact.id,
        sha256: packSha256,
      }));
      if (selection.name === rootIdentity.library && selection.version === rootIdentity.version) {
        rootSource = source;
        rootManifest = manifest;
        rootManifestUrl = materialized.manifestUrl;
      }
    } finally {
      loader.reset?.();
    }
  }
  computedPacks.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (canonicalJson(computedPacks) !== canonicalJson(closurePacks)
    || resolved.libraries.length !== snapshotPacks.length) {
    throw new Error('native Library Pack snapshot dependency closure mismatch');
  }
  if (!rootSource || !rootManifest || !rootManifestUrl) {
    throw new Error('native Library Pack snapshot root payload is missing');
  }
  return Object.freeze({
    closureSha256: expectedClosure,
    rootIdentity,
    source: rootSource,
    rootManifest,
    rootManifestUrl,
    selections: resolved.libraries as readonly LibrarySelection[],
    fetch: snapshotFetch,
    hasUrl(url: URL) {
      return virtualFiles.has(url.href);
    },
  });
}

function exactSnapshotRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must use the exact schema`);
  }
  const required = fields.filter((field) => !optional.includes(field));
  const keys = Object.keys(value);
  if (required.some((field) => !keys.includes(field)) || keys.some((field) => !fields.includes(field))) {
    throw new Error(`${label} must use the exact schema`);
  }
  return value as Record<string, unknown>;
}

function validateNativeLibraryRootIdentity(value: unknown, label: string): NativeLibraryRootIdentity {
  const identity = exactSnapshotRecord(
    value,
    ['library', 'version', 'packId', 'revision', 'artifact'],
    `native Library Pack ${label}`,
  );
  for (const field of ['library', 'version', 'packId', 'artifact']) {
    if (typeof identity[field] !== 'string' || !identity[field] || String(identity[field]).includes('\0')) {
      throw new Error(`native Library Pack ${label} is invalid`);
    }
  }
  if (typeof identity.revision !== 'string' || !SHA256.test(identity.revision)) {
    throw new Error(`native Library Pack ${label} revision is invalid`);
  }
  return Object.freeze({
    library: identity.library as string,
    version: identity.version as string,
    packId: identity.packId as string,
    revision: identity.revision,
    artifact: identity.artifact as string,
  });
}

function validateSnapshotByteIdentity(value: unknown, label: string): { bytes: number; sha256: string } {
  const identity = exactSnapshotRecord(value, ['bytes', 'sha256'], label);
  if (!Number.isSafeInteger(identity.bytes) || Number(identity.bytes) < 0
    || typeof identity.sha256 !== 'string' || !SHA256.test(identity.sha256)) {
    throw new Error(`${label} is invalid`);
  }
  return Object.freeze({ bytes: Number(identity.bytes), sha256: identity.sha256 });
}

function validateSnapshotObjectReference(value: unknown, label: string): {
  path: string; bytes: number; sha256: string;
} {
  const reference = exactSnapshotRecord(value, ['path', 'bytes', 'sha256'], label);
  if (typeof reference.sha256 !== 'string' || !SHA256.test(reference.sha256)
    || reference.path !== `objects/${reference.sha256}`
    || !Number.isSafeInteger(reference.bytes) || Number(reference.bytes) < 0) {
    throw new Error(`${label} reference is invalid`);
  }
  return Object.freeze({
    path: reference.path,
    bytes: Number(reference.bytes),
    sha256: reference.sha256,
  });
}

function validateSnapshotLogicalPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} is invalid`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..') || isAbsolute(value)) {
    throw new Error(`${label} is not canonical`);
  }
  return value;
}

async function readCanonicalSnapshotFile(rootArgument: string, pathArgument: string, label: string): Promise<Buffer> {
  const root = resolve(rootArgument);
  const path = resolve(pathArgument);
  if (!pathContains(root, path)) throw new Error(`${label} is outside the snapshot root`);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} snapshot root is a symbolic link, junction, or reparse point`);
  }
  let current = root;
  const segments = relative(root, path).split(sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} traverses a symbolic link, junction, or reparse point`);
    }
    if (index === segments.length - 1 ? !entry.isFile() : !entry.isDirectory()) {
      throw new Error(`${label} is not a regular snapshot file`);
    }
  }
  const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(path)]);
  if (!pathContains(canonicalRoot, canonicalPath)) throw new Error(`${label} canonical path escapes snapshot root`);
  if (relative(root, path).split(sep).join('/') !== relative(canonicalRoot, canonicalPath).split(sep).join('/')) {
    throw new Error(`${label} canonical path differs through a junction or reparse point`);
  }
  const before = await lstat(path);
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
  ) throw new Error(`${label} changed while being read`);
  return bytes;
}

export async function verifyNativeLibraryPack(
  manifestArgument: string,
  requestedHeader?: string,
  targetName: TargetName = 'c3',
  smokeOptions: SmokeOptions = Object.freeze({
    projectFiles: Object.freeze([]),
    macros: Object.freeze({}),
    traceCompiler: false,
  }),
  librarySnapshot?: Awaited<ReturnType<typeof loadNativeLibraryPackSnapshot>>,
) {
  const target = TARGETS[targetName];
  if (!target) throw new Error(`native Library Pack target must be one of ${Object.keys(TARGETS).join(', ')}`);

  const libraryManifestUrl = librarySnapshot?.rootManifestUrl ?? pathToFileURL(resolve(manifestArgument));
  const libraryManifest = librarySnapshot?.rootManifest
    ?? JSON.parse(await readFile(fileURLToPath(libraryManifestUrl), 'utf8'));
  const expectedArtifact = librarySnapshot?.rootIdentity.artifact;
  const sourceArtifact = (libraryManifest as { artifacts?: readonly { id?: string; kind?: string }[] }).artifacts
    ?.find((artifact) => (
      artifact.kind === 'library-source-json'
      && (expectedArtifact === undefined || artifact.id === expectedArtifact)
    ));
  if (!sourceArtifact) throw new Error('library Pack does not contain a library-source-json artifact');

  const { createBrowserToolchainPackLoader } = await import('../packages/web/public/avr/v3/toolchain-pack.js');
  const { ESP32_BROWSER_LIBRARY_PACK_LIMITS } = await import('../packages/web/public/esp32/v1/library-registry.js');
  const packFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (librarySnapshot?.hasUrl(url)) return librarySnapshot.fetch(input, init);
    return fileFetch(input, init);
  };
  const createPackLoader = (options: Record<string, unknown>) => createBrowserToolchainPackLoader({
    ...options,
    fetchFn: packFetch,
  });
  const sourceLoader = createPackLoader({
    manifestUrl: libraryManifestUrl,
    expectedId: librarySnapshot?.rootIdentity.packId ?? (libraryManifest as { id?: string }).id,
    expectedRevision: librarySnapshot?.rootIdentity.revision ?? (libraryManifest as { revision?: string }).revision,
    limits: ESP32_BROWSER_LIBRARY_PACK_LIMITS,
  });
  const sourceBytes = (await sourceLoader.loadArtifact(sourceArtifact.id as string)).bytes;
  sourceLoader.reset?.();
  const source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes));
  if (librarySnapshot && (
    source.name !== librarySnapshot.rootIdentity.library
    || source.version !== librarySnapshot.rootIdentity.version
  )) throw new Error('native Library Pack execution root identity mismatch');
  const header = requestedHeader ?? source.files
    ?.find((file: { path?: string }) => /\.(?:h|hh|hpp|hxx)$/i.test(file.path ?? ''))
    ?.path?.replace(/^src\//, '');
  if (!header) throw new Error('library Pack does not expose a header for its smoke sketch');

  const selections = librarySnapshot?.selections ?? await resolveLibrarySelections({
    source,
    libraryManifest: libraryManifest as { id: string; revision: string },
    libraryManifestUrl,
    sourceArtifact: sourceArtifact as { id: string },
    registryArgument: smokeOptions.registry,
  });
  const runtimeRoot = resolve(process.env.CK_RUNTIME_ROOT ?? target.defaultRoot);
  const descriptorUrl = pathToFileURL(resolve(
    process.env.CK_RUNTIME_DESCRIPTOR ?? resolve(runtimeRoot, target.descriptor),
  ));
  const descriptor = JSON.parse(await readFile(fileURLToPath(descriptorUrl), 'utf8'));
  if (descriptor.board !== target.board) {
    throw new Error(`runtime descriptor board mismatch: expected ${target.board}, got ${descriptor.board}`);
  }

  const { createEsp32BrowserBuildIR } = await import('../packages/web/public/ck-build-ir-envelope.js');
  const {
    loadEsp32BrowserBuildPlanning,
    materializeEsp32PackArtifactTrees,
  } = await import('../packages/web/public/esp32/v2/c3-compiler.js');
  const { createEsp32BrowserPackProvider } = await import('../packages/web/public/esp32/v2/ck-pack-provider.js');
  const {
    ESP32_C3_RUNTIME_PACK_LIMITS,
    resolveEsp32RuntimePackManifestUrl,
  } = await import('../packages/web/public/esp32/v1/c3-runtime.js');
  const { preprocess } = await import('../packages/web/public/avr/v3/preprocess.js');
  const imageBuilder = (await import('../packages/web/public/esp32/v2/image-builder.js'))[target.imageBuilder];
  if (typeof imageBuilder !== 'function') throw new Error(`missing image builder ${target.imageBuilder}`);

  const planning = await loadEsp32BrowserBuildPlanning({
    descriptor,
    descriptorUrl: descriptorUrl.href,
    libraries: selections,
    createPackLoader,
  });
  const capability = {
    profile: {
      board: descriptor.board,
      architecture: target.architecture,
      runtime: target.runtime,
      imageBuilder: true,
    },
    pinnedRuntime: { descriptor, descriptorUrl: descriptorUrl.href },
    pinnedLibraries: selections,
  };
  const request = {
    board: descriptor.board,
    options: {},
    libraries: [{ name: source.name, version: source.version }],
    macros: smokeOptions.macros,
    files: [
      { name: 'main.ino', content: `#include <${header}>\nvoid setup() {}\nvoid loop() {}\n` },
      ...smokeOptions.projectFiles,
    ],
  };
  const ir = await createEsp32BrowserBuildIR(request, capability, planning) as BuildIR;
  const executionIr = selectSmokeActions(ir, smokeOptions.onlyAction);
  const browserPacks = createEsp32BrowserPackProvider({
    capability,
    planning,
    ir: executionIr,
    dependencies: { createPackLoader },
  });

  const detected = detectLocalToolchain();
  if (!detected.esp32) throw new Error('ESP32 native toolchain is required');
  if (target.architecture === 'riscv32' && !detected.esp32.riscvBinDir) {
    throw new Error('ESP32 RISC-V native toolchain is required');
  }
  if (target.architecture === 'xtensa' && !detected.esp32.xtensaBinDir) {
    throw new Error('ESP32 Xtensa native toolchain is required');
  }

  const nativePythonInterpreter = nativePythonInterpreterFromEnvironment();
  const nativeToolBinding = createVerifiedNativeToolBinding(
    detected,
    executionIr.packs,
    targetName,
    { hostPlatform: process.platform, pythonInterpreter: nativePythonInterpreter },
  );
  const expectedNativeToolIdentity = process.env[EXPECTED_NATIVE_TOOL_IDENTITY];
  if (expectedNativeToolIdentity !== undefined) {
    if (!SHA256.test(expectedNativeToolIdentity)) {
      throw new Error(`${EXPECTED_NATIVE_TOOL_IDENTITY} must be a SHA-256 digest`);
    }
    if (nativeToolBinding.evidence.sha256 !== expectedNativeToolIdentity) {
      throw new Error(`native tool identity changed after Matrix preflight for ${targetName}`);
    }
  }
  const baseTools = nativeToolBinding.resolver;
  const tools = {
    policyIdentity: baseTools.policyIdentity,
    verifyForExecution(packs: BuildPacks) {
      return baseTools.verifyForExecution(packs);
    },
    resolve(tool: string, packs: BuildPacks): string {
      const mapped = logicalNativeTool(tool);
      if (!mapped) throw new Error(`unsupported native browser-IR tool: ${tool}`);
      return baseTools.resolve(mapped, packs);
    },
    resolveForExecution(tool: string, packs: BuildPacks) {
      const mapped = logicalNativeTool(tool);
      if (!mapped) throw new Error(`unsupported native browser-IR tool: ${tool}`);
      return baseTools.resolveForExecution(mapped, packs);
    },
  };
  const packs = adaptBrowserPackProvider(browserPacks, async (workspace) => {
    const materializeRole = async (
      role: 'sdk' | 'board',
      artifactIds: readonly unknown[],
      destination: string,
    ) => {
      if (!artifactIds.length) return;
      const pack = descriptor.packs.find((candidate: { role?: string }) => candidate.role === role);
      if (!pack) {
        throw new Error(`ESP32 runtime Pack is missing: ${role}`);
      }
      const loader = createPackLoader({
        manifestUrl: resolveEsp32RuntimePackManifestUrl(pack, descriptorUrl.href),
        expectedId: pack.id,
        expectedRevision: pack.revision,
        limits: ESP32_C3_RUNTIME_PACK_LIMITS[role],
      });
      try {
        const tree = await materializeEsp32PackArtifactTrees(
          artifactIds,
          loader,
          `ESP32 ${role} native Pack adapter`,
        );
        writeVfsTree(workspace, destination, tree);
      } finally {
        loader.reset?.();
      }
    };
    await materializeRole(
      'sdk',
      planning.platformManifest.compile.artifactIds ?? [],
      'packs/platform',
    );
    await materializeRole(
      'sdk',
      planning.platformManifest.link.artifactIds ?? [],
      'packs/platform',
    );
    await materializeRole(
      'board',
      planning.platformManifest.boardPack?.artifactIds ?? [],
      'packs/board',
    );
  });
  const local = new LocalExecutor();
  const sandbox: SandboxExecutor = {
    name: 'ck-native-browser-ir',
    isolationLevel: local.isolationLevel,
    exec: async (execution) => {
      const lowered = { ...execution, args: lowerBrowserClangArguments(execution.args) };
      if (smokeOptions.traceCompiler) {
        console.error(JSON.stringify({ command: lowered.command, args: lowered.args }, null, 2));
      }
      const result = await local.exec(lowered);
      if (smokeOptions.traceCompiler) {
        if (result.stdout) process.stderr.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      }
      return result;
    },
  };
  const executor = new NativeExecutor({
    sandbox,
    tools,
    packs,
    workspaceRoot: resolve(ROOT, 'var/work/ck-native-library-matrix'),
    runAction: ({ action, readFile }) => runCkAction(action, readFile, preprocess, imageBuilder),
  });

  const started = Date.now();
  const result = await executor.execute(executionIr, {
    onProgress: ({ completed, total, action, cached }) => {
      console.log(`${completed}/${total} ${action.id} ${cached ? 'cached' : 'run'}`);
    },
  });
  return Object.freeze({
    result,
    ir: executionIr,
    summary: Object.freeze({
      status: result.status,
      ...(result.status === 'error' ? { reason: result.reason, message: result.message } : {}),
      library: `${source.name}@${source.version}`,
      resolvedLibraries: selections.map(({ name, version }: LibrarySelection) => `${name}@${version}`),
      header,
      target: descriptor.board,
      executor: result.executor,
      schemaVersion: executionIr.schemaVersion,
      irSha256: sha256Hex(canonicalJson(executionIr)),
      ...(librarySnapshot ? {
        libraryPackClosureSha256: librarySnapshot.closureSha256,
        libraryPackRootIdentitySha256: sha256Hex(canonicalJson(librarySnapshot.rootIdentity)),
      } : {}),
      nativeToolEvidence: nativeToolBinding.evidence,
      actionCount: result.actions.length,
      failedAction: result.status === 'error' ? result.actionId : undefined,
      diagnostics: result.diagnostics,
      elapsedMs: Date.now() - started,
    }),
  });
}

async function resolveLibrarySelections({
  source,
  libraryManifest,
  libraryManifestUrl,
  sourceArtifact,
  registryArgument,
}: {
  source: { name: string; version: string };
  libraryManifest: { id: string; revision: string };
  libraryManifestUrl: URL;
  sourceArtifact: { id: string };
  registryArgument?: string;
}): Promise<readonly LibrarySelection[]> {
  const {
    resolveEsp32BrowserLibraries,
    validateEsp32BrowserLibraryRegistry,
  } = await import('../packages/web/public/esp32/v1/library-registry.js');
  const root = resolve(dirname(fileURLToPath(libraryManifestUrl)), '..', '..');
  const registryPaths = registryArgument
    ? [resolve(registryArgument)]
    : ['registry.json', 'registry.staging.json'].map((name) => resolve(root, name));
  for (const registryPath of registryPaths) {
    const url = pathToFileURL(registryPath);
    try {
      const registry = validateEsp32BrowserLibraryRegistry(
        JSON.parse(await readFile(fileURLToPath(url), 'utf8')),
        url,
      );
      const result = resolveEsp32BrowserLibraries(registry, [{ name: source.name, version: source.version }]);
      if (!result.supported) throw new Error(`Registry cannot resolve ${source.name}@${source.version}`);
      const requested = result.libraries.find((library: LibrarySelection) => (
        library.name === source.name && library.version === source.version
      ));
      if (!requested || requested.manifestUrl !== libraryManifestUrl.href) {
        throw new Error(`Registry Pack does not match ${libraryManifestUrl.href}`);
      }
      return result.libraries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }
  return [Object.freeze({
    name: source.name,
    version: source.version,
    packId: libraryManifest.id,
    revision: libraryManifest.revision,
    manifestUrl: libraryManifestUrl.href,
    artifact: sourceArtifact.id,
    dependencies: Object.freeze([]),
  })];
}

function adaptBrowserPackProvider(browserPacks: {
  materialize(packs: BuildPacks, context: {
    hasFile(path: string): boolean;
    readFile(path: string): Uint8Array | undefined;
    writeFile(path: string, bytes: Uint8Array, expectedSha256?: string): Promise<void>;
  }): Promise<void>;
}, materializeRuntimeVfs: (workspace: string) => Promise<void>): NativePackProvider {
  return {
    async materialize(packs, workspace) {
      await browserPacks.materialize(packs, {
        hasFile: (path) => existsSync(workspacePath(workspace, path)),
        readFile: (path) => {
          const absolute = workspacePath(workspace, path);
          return existsSync(absolute) ? new Uint8Array(readFileSync(absolute)) : undefined;
        },
        writeFile: async (path, bytes, expectedSha256) => {
          const absolute = workspacePath(workspace, path);
          if (existsSync(absolute)) throw new TypeError(`Pack file collides with an existing file: ${path}`);
          const owned = new Uint8Array(bytes);
          if (expectedSha256 !== undefined) {
            if (!SHA256.test(expectedSha256) || sha256Hex(owned) !== expectedSha256) {
              throw new TypeError(`Pack file hash mismatch: ${path}`);
            }
          }
          mkdirSync(resolve(absolute, '..'), { recursive: true });
          writeFileSync(absolute, owned);
        },
      });
      await materializeRuntimeVfs(workspace);
    },
  };
}

function writeVfsTree(workspace: string, prefix: string, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw new TypeError(`ESP32 native VFS root is invalid: ${prefix}`);
  }
  const visit = (node: unknown, path: string): void => {
    if (node instanceof Uint8Array || typeof node === 'string') {
      const bytes = typeof node === 'string' ? new TextEncoder().encode(node) : new Uint8Array(node);
      const absolute = workspacePath(workspace, path);
      if (existsSync(absolute)) {
        const previous = new Uint8Array(readFileSync(absolute));
        if (sha256Hex(previous) !== sha256Hex(bytes)) {
          throw new TypeError(`ESP32 native VFS file conflicts with a materialized Pack input: ${path}`);
        }
        return;
      }
      mkdirSync(resolve(absolute, '..'), { recursive: true });
      writeFileSync(absolute, bytes);
      return;
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new TypeError(`ESP32 native VFS entry is invalid: ${path}`);
    }
    for (const [name, child] of Object.entries(node)) visit(child, `${path}/${name}`);
  };
  visit(value, prefix);
}

function logicalNativeTool(tool: string): string | null {
  if (tool.endsWith(':clang')) return 'toolchain:cc';
  if (tool.endsWith(':clang++')) return 'toolchain:cxx';
  if (tool.endsWith(':llvm-ar')) return 'toolchain:ar';
  if (tool.endsWith(':objcopy')) return 'toolchain:objcopy';
  return null;
}

/** Lower Browser Clang-only spelling at the NativeExecutor boundary without mutating the Build IR. */
export function lowerBrowserClangArguments(arguments_: readonly string[]): string[] {
  const lowered: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if ((argument === '--target' || argument === '-target') && arguments_[index + 1] !== undefined) {
      index += 1;
      continue;
    }
    if (
      argument.startsWith('--target=')
      || /^-mcpu=esp32(?:s2|s3)?$/.test(argument)
      || argument === '-nostdinc'
      || argument === '-nostdinc++'
      || argument === '-fuse-ld=lld'
      || argument.startsWith('--sysroot=packs/toolchain/runtime/')
    ) continue;
    if (argument === '-isystem' && arguments_[index + 1]?.startsWith('packs/toolchain/runtime/')) {
      index += 1;
      continue;
    }
    lowered.push(argument);
  }
  return lowered;
}

async function runCkAction(
  action: BuildAction,
  readFile: (path: string) => Uint8Array,
  preprocess: (source: string, options: { sourceName: string }) => { cpp: string },
  buildImage: (elf: Uint8Array, options: Record<string, string>) => Promise<{
    image: Uint8Array;
    elfSha256Embedded?: boolean;
  }>,
): Promise<NativeActionRunnerResult | undefined> {
  if (action.kind !== 'transform') return undefined;
  if (action.tool === 'ck:arduino-preprocess') {
    const processed = preprocess(
      new TextDecoder().decode(readFile(action.transform.input)),
      { sourceName: action.transform.input },
    );
    const bytes = new TextEncoder().encode(processed.cpp);
    return { outputs: [{ path: action.transform.output, bytes, sha256: sha256Hex(bytes) }] };
  }
  if (action.tool === 'ck:esp32-image') {
    const built = await buildImage(readFile(action.transform.input), parseImageFlags(action.transform.flags));
    if (!(built?.image instanceof Uint8Array) || !built.image.byteLength) {
      return { ok: false, message: 'ESP32 image builder returned no firmware image' };
    }
    if (built.elfSha256Embedded !== true) {
      return { ok: false, message: 'ESP32 image does not contain the required ELF SHA-256 descriptor' };
    }
    const bytes = new Uint8Array(built.image);
    return { outputs: [{ path: action.transform.output, bytes, sha256: sha256Hex(bytes) }] };
  }
  if (action.tool === 'ck:pack-copy') {
    const bytes = readFile(action.transform.input);
    return { outputs: [{ path: action.transform.output, bytes, sha256: sha256Hex(bytes) }] };
  }
  return undefined;
}

function parseImageFlags(flags: readonly string[]): Record<string, string> {
  const image: Record<string, string> = {};
  for (const flag of flags ?? []) {
    const match = /^--([^=]+)=(.*)$/.exec(flag);
    if (match) image[match[1]!] = match[2]!;
  }
  return image;
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
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new TypeError(`executor path escapes workspace: ${logicalPath}`);
  }
  return path;
}

async function fileFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const request = input instanceof Request ? input : undefined;
  const method = String(init.method ?? request?.method ?? 'GET').toUpperCase();
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'file:') return fetch(input, init);
  if (method !== 'GET') return new Response('method not allowed', { status: 405 });
  if (url.host || url.username || url.password || url.port) {
    throw new Error('native verifier refuses file URL authority');
  }
  if (url.search || url.hash) throw new Error('native verifier refuses file URL query or fragment data');
  const path = resolve(fileURLToPath(url));
  if (pathToFileURL(path).href !== url.href) throw new Error('native verifier file URL is not canonical');
  try {
    const bytes = await readCanonicalSnapshotFile(ROOT, path, 'native verifier repository file');
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': url.pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        'content-length': String(bytes.byteLength),
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return new Response('not found', { status: 404 });
  }
}

export function parseNativeSmokeOptions(values: readonly string[]): SmokeOptions {
  const projectFiles: { name: string; content: string }[] = [];
  const macros: Record<string, true | string> = {};
  let registry: string | undefined;
  let onlyAction: string | undefined;
  let traceCompiler = false;
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--only-action') {
      onlyAction = values[++index];
      if (!onlyAction) throw new Error('--only-action requires an id substring');
      continue;
    }
    if (argument === '--project-file' || argument === '--project-file-base64') {
      const name = values[++index];
      const content = values[++index];
      if (!name || content === undefined) throw new Error(`${argument} requires <name> and <content>`);
      projectFiles.push({
        name,
        content: argument === '--project-file-base64' ? Buffer.from(content, 'base64').toString('utf8') : content,
      });
      continue;
    }
    if (argument === '--registry') {
      registry = values[++index];
      if (!registry) throw new Error('--registry requires <registry.json>');
      continue;
    }
    if (argument === '--macro') {
      const definition = values[++index];
      if (!definition) throw new Error('--macro requires <name>[=<value>]');
      const separator = definition.indexOf('=');
      const name = separator < 0 ? definition : definition.slice(0, separator);
      assertMacroName(name);
      macros[name] = separator < 0 ? true : definition.slice(separator + 1);
      continue;
    }
    if (argument === '--macro-base64') {
      const name = values[++index];
      const value = values[++index];
      if (!name || value === undefined) throw new Error('--macro-base64 requires <name> and <base64-value>');
      assertMacroName(name);
      macros[name] = Buffer.from(value, 'base64').toString('utf8');
      continue;
    }
    if (argument === '--trace-compiler') {
      traceCompiler = true;
      continue;
    }
    throw new Error(`unknown native smoke option: ${String(argument)}`);
  }
  return Object.freeze({
    projectFiles: Object.freeze(projectFiles),
    macros: Object.freeze(macros),
    ...(registry ? { registry } : {}),
    ...(onlyAction ? { onlyAction } : {}),
    traceCompiler,
  });
}

function assertMacroName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid macro name: ${name}`);
}

function selectSmokeActions(ir: BuildIR, substring?: string): BuildIR {
  if (!substring) return ir;
  const matches = ir.graph.actions.filter((action) => action.id.includes(substring));
  if (matches.length !== 1) {
    throw new Error(`--only-action must match exactly one Build IR Action, received ${matches.length}`);
  }
  if (matches[0]!.dependencies.length) {
    throw new Error('--only-action currently requires an Action without generated dependencies');
  }
  return Object.freeze({
    ...ir,
    graph: Object.freeze({ ...ir.graph, actions: Object.freeze(matches) }),
    artifacts: Object.freeze([]),
  }) as unknown as BuildIR;
}

async function main(): Promise<void> {
  if (process.argv[2] === '--describe-execution-identity') {
    const identityRequest = process.argv[3];
    if (!identityRequest || process.argv.length !== 4) {
      throw new Error('--describe-execution-identity requires exactly one JSON path');
    }
    const identity = createNativeExecutionIdentity(
      JSON.parse(await readFile(resolve(identityRequest), 'utf8')),
    );
    console.log(JSON.stringify(identity, null, 2));
    return;
  }
  const requestFile = process.argv[2] === '--request-file' ? process.argv[3] : undefined;
  if (process.argv[2] === '--request-file' && (!requestFile || process.argv.length !== 4)) {
    throw new Error('--request-file requires exactly one JSON path');
  }
  const requestPayload = requestFile
    ? validateNativeLibraryVerifierRequest(JSON.parse(await readFile(resolve(requestFile), 'utf8')))
    : undefined;
  const librarySnapshot = requestPayload
    ? await loadNativeLibraryPackSnapshot(requestPayload)
    : undefined;
  const manifest = librarySnapshot?.rootManifestUrl.href ?? process.argv[2];
  if (!manifest) {
    throw new Error(
      'usage: tsx scripts/verify-ck-native-library-pack.ts <toolchain.json> [header] [esp32|s2|s3|c3|c6] '
        + '[--project-file <name> <content>]... [--project-file-base64 <name> <base64>]... '
        + '[--macro <name>[=<value>]]... [--macro-base64 <name> <base64-value>]... '
        + '[--registry <registry.json>] [--only-action <id-substring>] [--trace-compiler] '
        + '| --request-file <request.json>',
    );
  }
  const targetName = (requestPayload?.target ?? process.argv[4] ?? 'c3') as TargetName;
  const smokeOptions: SmokeOptions = requestPayload
    ? Object.freeze({
      projectFiles: requestPayload.projectFiles,
      macros: requestPayload.macros,
      ...(requestPayload.onlyAction ? { onlyAction: requestPayload.onlyAction } : {}),
      traceCompiler: requestPayload.traceCompiler,
    })
    : parseNativeSmokeOptions(process.argv.slice(5));
  const verification = await verifyNativeLibraryPack(
    manifest,
    requestPayload?.header ?? process.argv[3],
    targetName,
    smokeOptions,
    librarySnapshot,
  );
  console.log(JSON.stringify(verification.summary, null, 2));
  if (librarySnapshot) {
    console.log(`${NATIVE_LIBRARY_RESULT_PREFIX}${JSON.stringify({
      schema: 1,
      closureSha256: librarySnapshot.closureSha256,
      rootIdentitySha256: sha256Hex(canonicalJson(librarySnapshot.rootIdentity)),
    })}`);
  }
  if (verification.result.status !== 'success') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === RUNNER) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
