#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  arch as operatingSystemArch,
  platform as operatingSystemPlatform,
  release as operatingSystemRelease,
  version as operatingSystemVersion,
} from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MATRIX_TARGETS,
  acquireReportLock,
  classifyMatrixFailure,
  createMatrixJobs,
  createChildTerminationController,
  createVerifierRequest,
  hashFingerprintEntries,
  matrixJobKey,
  parseMatrixArgs,
  summarizeMatrixResults,
  validateFixtureManifest,
} from './verify-ck-browser-library-matrix.mjs';
import {
  ESP32_BROWSER_LIBRARY_PACK_LIMITS,
  resolveEsp32BrowserLibraries,
  validateEsp32BrowserLibraryRegistry,
} from '../packages/web/public/esp32/v1/library-registry.js';
import { createBrowserToolchainPackLoader } from '../packages/web/public/avr/v3/toolchain-pack.js';

const ROOT = resolve(import.meta.dirname, '..');
const RUNNER = fileURLToPath(import.meta.url);
const NATIVE_VERIFIER = resolve(ROOT, 'scripts/verify-ck-native-library-pack.ts');
const DEFAULT_REPORT = resolve(ROOT, 'var/reports/ck-native-library-matrix.json');
const REPORT_SCHEMA = 2;
const VERIFICATION_SCHEMA = 7;
const EVIDENCE_SCHEMA = 5;
const LIBRARY_PACK_FINGERPRINT_SCHEMA = 2;
const LIBRARY_PACK_SNAPSHOT_SCHEMA = 1;
const NATIVE_LIBRARY_REQUEST_SCHEMA = 2;
const NATIVE_LIBRARY_RESULT_PREFIX = 'CK_NATIVE_LIBRARY_RESULT ';
const NATIVE_LIBRARY_CLOSURE_ENV = 'CK_NATIVE_LIBRARY_CLOSURE_SHA256';
const NATIVE_LIBRARY_SNAPSHOT_ROOT_ENV = 'CK_NATIVE_LIBRARY_SNAPSHOT_ROOT';
const COMPILER_RUNTIME_RELEASE_SCHEMA = 1;
const COMPILER_RUNTIME_RELEASE_KIND = 'arduinofast-compiler-runtime-release';
const COMPILER_RUNTIME_POOLS = Object.freeze(['avr', 'esp32-xtensa', 'esp32-riscv']);
const MAX_COMPILER_RUNTIME_RELEASE_BYTES = 64 * 1024;
const SHA256_ID = /^sha256:[a-f0-9]{64}$/;
const LIBRARY_PACK_FINGERPRINT_CONCURRENCY = 4;
const NATIVE_AUTHORIZATION_SCHEMA = 3;
const NATIVE_AUTHORIZATION_MODE = 'strict-pack-bound-recursive-closure-and-python-sha256-v2';
const NATIVE_TOOL_IDENTITY_MODE = 'strict-pack-bound-static-and-gcc-closure-and-python-sha256-v4';
const NATIVE_EXECUTION_ENVIRONMENT_SCHEMA = 2;
const NATIVE_EXECUTION_ENVIRONMENT_POLICY = 'ck-native-gcc-python-hermetic-environment-v2';
const NATIVE_EXECUTION_ENVIRONMENT_PASSTHROUGH = Object.freeze([
  'AF_ESP32_CORE',
  'AF_ESP32_ESPTOOL',
  'AF_ESP32_PLATFORM',
  'AF_ESP32_RISCV_BIN',
  'AF_ESP32_RISCV_ROOT',
  'AF_ESP32_SDK_ROOT',
  'AF_ESP32_VARIANTS',
  'AF_ESP32_XTENSA_BIN',
  'AF_ESP32_XTENSA_ROOT',
  'ARDUINO15_DIR',
  'ComSpec',
  'HOME',
  'LOCALAPPDATA',
  'PATHEXT',
  'SystemRoot',
  'USERPROFILE',
  'WINDIR',
]);
const NATIVE_EXECUTION_ENVIRONMENT_FIXED = Object.freeze({
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
});
const NATIVE_EXECUTION_ENVIRONMENT_BLOCKED = Object.freeze([
  'CPATH',
  'CPLUS_INCLUDE_PATH',
  'C_INCLUDE_PATH',
  'OBJC_INCLUDE_PATH',
  'OBJCPLUS_INCLUDE_PATH',
  'LIBRARY_PATH',
  'COMPILER_PATH',
  'GCC_EXEC_PREFIX',
  'DEPENDENCIES_OUTPUT',
  'SUNPRO_DEPENDENCIES',
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'SHLIB_PATH',
  'LIBPATH',
  'INCLUDE',
  'LIB',
  'SOURCE_DATE_EPOCH',
  'ZERO_AR_DATE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONINSPECT',
  'PYTHONSTARTUP',
  'PYTHONUSERBASE',
  'PYTHON*',
  'GCC_*',
  'COLLECT_GCC*',
  'LC_*',
]);
const NATIVE_TOOL_IDS = Object.freeze([
  'toolchain:ar',
  'toolchain:cc',
  'toolchain:cxx',
  'toolchain:objcopy',
]);
const NATIVE_HELPER_QUERIES = Object.freeze([
  Object.freeze({ role: 'helper:cc1', tool: 'toolchain:cc', argument: '-print-prog-name=cc1' }),
  Object.freeze({ role: 'helper:cc1plus', tool: 'toolchain:cxx', argument: '-print-prog-name=cc1plus' }),
  Object.freeze({ role: 'helper:collect2', tool: 'toolchain:cxx', argument: '-print-prog-name=collect2' }),
  Object.freeze({ role: 'helper:assembler', tool: 'toolchain:cc', argument: '-print-prog-name=as' }),
  Object.freeze({ role: 'helper:linker', tool: 'toolchain:cxx', argument: '-print-prog-name=ld' }),
  Object.freeze({ role: 'helper:archiver', tool: 'toolchain:cc', argument: '-print-prog-name=ar' }),
  Object.freeze({ role: 'helper:lto-wrapper', tool: 'toolchain:cxx', argument: '-print-prog-name=lto-wrapper' }),
  Object.freeze({ role: 'helper:lto1', tool: 'toolchain:cxx', argument: '-print-prog-name=lto1' }),
]);
export const NATIVE_TOOLCHAIN_CLOSURE_LIMITS = Object.freeze({
  maxFileBytes: 512 * 1024 * 1024,
  maxTreeBytes: 2 * 1024 * 1024 * 1024,
  maxTreeFiles: 8_192,
  maxTreeEntries: 16_384,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxTotalFiles: 16_384,
  maxTotalEntries: 32_768,
  maxQueryOutputBytes: 1024 * 1024,
  queryTimeoutMs: 10_000,
  hashConcurrency: 4,
});
const NATIVE_TOOL_IDENTITY_ENV = 'CK_NATIVE_TOOL_IDENTITY_SHA256';
const NATIVE_PYTHON_ENV = 'CK_NATIVE_PYTHON';
const PLANNER_PUBLICATIONS = Object.freeze([
  Object.freeze({ id: 'rust-dist', directory: 'crates/ck-build-core/dist/web' }),
  Object.freeze({ id: 'core-wasm', directory: 'packages/core/wasm' }),
  Object.freeze({ id: 'web-runtime', directory: 'packages/web/public/ck-build-core-wasm' }),
]);
// Planning runs in the contracts job before the reproducible Rust publication
// job. The checked-in core WASM is the authoritative planning input there;
// execution evidence still requires all three independently published copies.
const COMMITTED_PLANNER_PUBLICATIONS = Object.freeze([
  Object.freeze({ id: 'core-wasm', directory: 'packages/core/wasm' }),
]);
const REUSABLE_STATUSES = new Set(['success', 'not-recommended', 'unsupported']);

export function nativeMatrixOptions(values) {
  const forwarded = [];
  let runtimeReleaseManifest;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--runtime-release-manifest') {
      if (runtimeReleaseManifest !== undefined) throw new Error('--runtime-release-manifest may only be specified once');
      runtimeReleaseManifest = values[++index];
      if (!runtimeReleaseManifest) throw new Error('--runtime-release-manifest requires one JSON path');
      continue;
    }
    forwarded.push(values[index]);
  }
  const parsed = parseMatrixArgs(forwarded);
  return Object.freeze({
    ...parsed,
    report: parsed.reportExplicit ? parsed.report : DEFAULT_REPORT,
    ...(runtimeReleaseManifest === undefined ? {} : { runtimeReleaseManifest: resolve(runtimeReleaseManifest) }),
  });
}

export function evaluateNativeLibraryPolicy() {
  return null;
}

export async function readCompilerRuntimeReleaseIdentity(path, options = {}) {
  const hostExecution = createHostExecutionIdentity(options.host ?? {});
  if (path === undefined || path === null || String(path).trim() === '') {
    if (options.requireAccepted) {
      throw new Error('native Matrix execution requires --runtime-release-manifest or AF_COMPILER_RUNTIME_RELEASE_PATH');
    }
    const body = Object.freeze({
      schema: COMPILER_RUNTIME_RELEASE_SCHEMA,
      status: 'unverified-local',
      trust: 'unverified-local',
      runtimeIdentity: 'unverified-local',
      hostExecution,
    });
    return Object.freeze({ ...body, sha256: identitySha256(body) });
  }
  const absolute = resolve(String(path).trim());
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('compiler runtime release path must be a regular non-symlink file');
  }
  if (before.size > MAX_COMPILER_RUNTIME_RELEASE_BYTES) {
    throw new Error('compiler runtime release exceeds the maximum size');
  }
  const bytes = await readFile(absolute);
  const after = await lstat(absolute);
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
  ) throw new Error('compiler runtime release changed while being read');
  const source = bytes.toString('utf8');
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('compiler runtime release is not valid JSON');
  }
  const release = validateCompilerRuntimeRelease(value);
  const canonical = `${JSON.stringify(release, null, 2)}\n`;
  if (source !== canonical) throw new Error('compiler runtime release JSON is not canonical');
  const declaredReleaseId = String(options.declaredReleaseId ?? '').trim();
  if (declaredReleaseId && declaredReleaseId !== release.releaseId) {
    throw new Error('compiler runtime release does not match declared releaseId');
  }
  const body = Object.freeze({
    schema: COMPILER_RUNTIME_RELEASE_SCHEMA,
    status: 'verified',
    trust: 'accepted',
    runtimeIdentity: release.releaseId,
    releaseId: release.releaseId,
    manifestSha256: sha256(bytes),
    compilerBundleId: release.compilerBundleId,
    runtimes: release.runtimes,
    hostExecution,
  });
  return Object.freeze({ ...body, sha256: identitySha256(body) });
}

function createHostExecutionIdentity(overrides = {}) {
  const body = Object.freeze({
    schema: 1,
    platform: overrides.platform ?? operatingSystemPlatform(),
    architecture: overrides.architecture ?? operatingSystemArch(),
    operatingSystemRelease: overrides.operatingSystemRelease ?? operatingSystemRelease(),
    operatingSystemVersion: overrides.operatingSystemVersion ?? operatingSystemVersion(),
    nodeVersion: overrides.nodeVersion ?? process.version,
  });
  for (const [name, value] of Object.entries(body)) {
    if (name !== 'schema' && (typeof value !== 'string' || !value || value.includes('\0'))) {
      throw new Error(`compiler host execution identity ${name} is invalid`);
    }
  }
  return Object.freeze({ ...body, runtimeIdentity: `sha256:${identitySha256(body)}` });
}

function validateCompilerRuntimeRelease(value) {
  exactRuntimeKeys(value, [
    'schema', 'kind', 'trust', 'compilerBundleId', 'runtimes', 'releaseId',
  ], 'compiler runtime release');
  if (
    value.schema !== COMPILER_RUNTIME_RELEASE_SCHEMA
    || value.kind !== COMPILER_RUNTIME_RELEASE_KIND
    || value.trust !== 'accepted'
  ) throw new Error('unsupported compiler runtime release schema');
  if (
    typeof value.compilerBundleId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value.compilerBundleId)
  ) throw new Error('compiler runtime release has an invalid bundle id');
  if (!Array.isArray(value.runtimes) || value.runtimes.length !== COMPILER_RUNTIME_POOLS.length) {
    throw new Error(`compiler runtime release requires exactly ${COMPILER_RUNTIME_POOLS.length} worker pools`);
  }
  const byPool = new Map();
  for (const input of value.runtimes) {
    exactRuntimeKeys(input, [
      'pool', 'mode', 'platform', 'imageRepository', 'imageDigest', 'hostRuntimeIdentity',
    ], 'compiler runtime entry');
    if (!COMPILER_RUNTIME_POOLS.includes(input.pool) || byPool.has(input.pool)) {
      throw new Error('compiler runtime release has an invalid or duplicate pool');
    }
    if (input.mode !== 'oci-image' || input.platform !== 'linux/amd64') {
      throw new Error('compiler runtime entry must identify a linux/amd64 OCI image');
    }
    if (
      typeof input.imageRepository !== 'string'
      || !input.imageRepository
      || input.imageRepository.length > 512
      || input.imageRepository.includes('@')
    ) throw new Error('compiler runtime entry has an invalid OCI repository');
    if (typeof input.imageDigest !== 'string' || !SHA256_ID.test(input.imageDigest)) {
      throw new Error('compiler runtime entry has an invalid OCI digest');
    }
    const hostPayload = {
      schema: COMPILER_RUNTIME_RELEASE_SCHEMA,
      kind: 'arduinofast-host-runtime',
      mode: input.mode,
      pool: input.pool,
      platform: input.platform,
      imageDigest: input.imageDigest,
    };
    const expectedHostIdentity = `sha256:${sha256(Buffer.from(JSON.stringify(hostPayload)))}`;
    if (input.hostRuntimeIdentity !== expectedHostIdentity) {
      throw new Error(`compiler runtime identity mismatch for pool ${input.pool}`);
    }
    byPool.set(input.pool, Object.freeze({
      pool: input.pool,
      mode: input.mode,
      platform: input.platform,
      imageRepository: input.imageRepository,
      imageDigest: input.imageDigest,
      hostRuntimeIdentity: input.hostRuntimeIdentity,
    }));
  }
  const runtimes = Object.freeze(COMPILER_RUNTIME_POOLS.map((pool) => byPool.get(pool)));
  const payload = {
    schema: COMPILER_RUNTIME_RELEASE_SCHEMA,
    kind: COMPILER_RUNTIME_RELEASE_KIND,
    trust: 'accepted',
    compilerBundleId: value.compilerBundleId,
    runtimes,
  };
  const releaseId = `sha256:${sha256(Buffer.from(JSON.stringify(payload)))}`;
  if (value.releaseId !== releaseId) throw new Error('compiler runtime release id mismatch');
  return Object.freeze({ ...payload, releaseId });
}

function exactRuntimeKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must use the exact schema`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must use the exact schema`);
  }
}

export async function createNativeMatrixPlan(options, dependencies = {}) {
  const plannerIdentity = dependencies.plannerIdentity ?? (
    dependencies.requireNativeTools === true
      ? readPlannerPublicationIdentity()
      : readCommittedPlannerPublicationIdentity()
  );
  const compilerRuntime = dependencies.compilerRuntimeIdentity ?? await readCompilerRuntimeReleaseIdentity(
    options.runtimeReleaseManifest ?? process.env.AF_COMPILER_RUNTIME_RELEASE_PATH,
    {
      requireAccepted: dependencies.requireNativeTools === true,
      declaredReleaseId: process.env.AF_COMPILE_RELEASE_ID,
    },
  );
  if (
    dependencies.requireNativeTools === true
    && (
      compilerRuntime.trust !== 'accepted'
      || !SHA256_ID.test(compilerRuntime.runtimeIdentity)
      || !SHA256_ID.test(compilerRuntime.hostExecution?.runtimeIdentity)
    )
  ) throw new Error('native Matrix execution requires an accepted SHA-256 compiler runtime identity');
  const [registryBytes, fixtureBytes, contexts, planner] = await Promise.all([
    readFile(options.registry),
    readFile(options.fixtures),
    readTargetContexts(options.targets),
    plannerIdentity,
  ]);
  const registry = validateEsp32BrowserLibraryRegistry(
    JSON.parse(registryBytes.toString('utf8')),
    pathToFileURL(options.registry),
  );
  const fixtures = validateFixtureManifest(JSON.parse(fixtureBytes.toString('utf8')));
  const platformVersions = new Map([...contexts].map(([target, context]) => [target, context.platformVersion]));
  const plan = createMatrixJobs({
    registry,
    targets: options.targets,
    platformVersions,
    fixtures,
    options,
    policyEvaluator: evaluateNativeLibraryPolicy,
  });
  const targetPacks = createTargetPackEvidence(contexts);
  const executionEnvironment = createNativeExecutionEnvironmentEvidence();
  let nativeIdentity = dependencies.nativeExecutionIdentity;
  let nativePythonInterpreter = dependencies.nativePythonInterpreter;
  if (!nativeIdentity && dependencies.requireNativeTools) {
    nativePythonInterpreter ??= await resolveNativePythonInterpreter();
    nativeIdentity = await probeNativeExecutionIdentity(targetPacks, nativePythonInterpreter);
  }
  const nativeBinding = nativeIdentity
    ? await validateNativeExecutionIdentity(nativeIdentity, targetPacks, dependencies.nativeClosureOptions)
    : undefined;
  const nativeTools = nativeBinding?.evidence;
  const libraryPacks = nativeTools
    ? await createNativeLibraryPackClosureEvidence(
      registry,
      plan.jobs,
      {
        ...dependencies.libraryPackFingerprintOptions,
        registryBytes,
      },
    )
    : Object.freeze({
      evidence: Object.freeze({
        schema: LIBRARY_PACK_FINGERPRINT_SCHEMA,
        status: 'not-probed',
        reason: 'plan-only',
      }),
      jobs: Object.freeze([]),
      packs: Object.freeze([]),
    });
  const evidenceBody = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    fingerprintScope: nativeTools ? 'execution' : 'planning',
    planner,
    compilerRuntime,
    targetPacks,
    executionEnvironment,
    nativeTools: nativeTools ?? Object.freeze({
      schema: EVIDENCE_SCHEMA,
      status: 'not-probed',
      reason: 'plan-only',
    }),
  });
  const evidence = Object.freeze({
    ...evidenceBody,
    sha256: identitySha256(evidenceBody),
  });
  const fingerprint = await verificationFingerprint(registryBytes, fixtureBytes, contexts, evidence);
  return Object.freeze({
    registryBytes,
    fixtureBytes,
    registry,
    fixtures,
    contexts,
    plan,
    fingerprint,
    fingerprintScope: evidence.fingerprintScope,
    evidence,
    compilerRuntime,
    libraryPacks,
    nativeExecutionAuthorization: nativeBinding?.authorization,
    registryStats: Object.freeze({
      libraries: registry.libraries.length,
      versions: registry.libraries.reduce((sum, library) => sum + library.versions.length, 0),
      publicHeaders: registry.libraries.reduce((sum, library) => (
        sum + library.versions.reduce((versionSum, version) => versionSum + version.publicHeaders.length, 0)
      ), 0),
    }),
  });
}

/** Resolve a file URL to one regular file below a canonical, link-free root. */
export async function assertNativeLibraryLocalFileUrl(input, allowedRoot, label = 'native Library Pack file') {
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.protocol !== 'file:' || url.host || url.username || url.password || url.port) {
    throw new Error(`${label} refuses a file URL authority or non-local protocol`);
  }
  if (url.search || url.hash) throw new Error(`${label} refuses URL query or fragment data`);
  const root = resolve(allowedRoot);
  const candidate = resolve(fileURLToPath(url));
  if (pathToFileURL(candidate).href !== url.href) throw new Error(`${label} path is not canonical`);
  if (!pathWithin(root, candidate)) throw new Error(`${label} is outside allowed root`);

  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${label} allowed root is a symbolic link, junction, or reparse point`);
  }
  let current = root;
  const segments = relative(root, candidate).split(sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} traverses a symbolic link, junction, or reparse point`);
    }
    if (index === segments.length - 1 ? !entry.isFile() : !entry.isDirectory()) {
      throw new Error(`${label} is not a regular file below its allowed root`);
    }
  }
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!pathWithin(canonicalRoot, canonicalFile)) throw new Error(`${label} canonical path is outside allowed root`);
  if (relative(root, candidate).split(sep).join('/') !== relative(canonicalRoot, canonicalFile).split(sep).join('/')) {
    throw new Error(`${label} canonical path differs through a junction or reparse point`);
  }
  return canonicalFile;
}

/**
 * Bind each selected Matrix job to verified bytes and materialize those bytes
 * into a content-addressed snapshot. Evidence deliberately contains no host path.
 */
export async function createNativeLibraryPackClosureEvidence(registry, jobs, options = {}) {
  if (!Array.isArray(jobs)) throw new TypeError('native Library Pack fingerprint jobs must be an array');
  const concurrency = options?.concurrency ?? LIBRARY_PACK_FINGERPRINT_CONCURRENCY;
  if (
    !Number.isSafeInteger(concurrency)
    || concurrency < 1
    || concurrency > LIBRARY_PACK_FINGERPRINT_CONCURRENCY
  ) {
    throw new TypeError(`native Library Pack fingerprint concurrency must be 1..${LIBRARY_PACK_FINGERPRINT_CONCURRENCY}`);
  }
  const fingerprintPack = options?.fingerprintPack ?? fingerprintLocalNativeLibraryPack;
  if (typeof fingerprintPack !== 'function') {
    throw new TypeError('native Library Pack fingerprinter must be a function');
  }
  if (typeof registry?.registryUrl !== 'string') throw new TypeError('native Library Pack Registry URL is missing');

  const allowedRoot = resolve(options.allowedRoot ?? ROOT);
  const registryUrl = new URL(registry.registryUrl);
  const registryPath = await assertNativeLibraryLocalFileUrl(registryUrl, allowedRoot, 'native Library Pack Registry');
  const registryBytes = options.registryBytes === undefined
    ? await readFile(registryPath)
    : Buffer.from(options.registryBytes);
  const snapshotRegistry = validateEsp32BrowserLibraryRegistry(
    JSON.parse(registryBytes.toString('utf8')),
    registryUrl,
  );
  const registryDirectory = dirname(registryPath);
  const registryIdentity = Object.freeze({ bytes: registryBytes.byteLength, sha256: sha256(registryBytes) });

  const resolvedRoots = new Map();
  const packSources = new Map();
  const jobSources = [];
  const seenJobs = new Set();
  for (const job of jobs) {
    const key = matrixJobKey(job);
    if (seenJobs.has(key)) throw new Error(`duplicate native Library Pack fingerprint job: ${key}`);
    seenJobs.add(key);
    const rootKey = `${String(job.library).toLowerCase()}\0${job.version}`;
    let selections = resolvedRoots.get(rootKey);
    if (!selections) {
      const resolved = resolveEsp32BrowserLibraries(
        snapshotRegistry,
        [{ name: job.library, version: job.version }],
        'esp32',
      );
      if (!resolved.supported) {
        throw new Error(`native Library Pack dependency closure cannot resolve ${job.library}@${job.version}`);
      }
      selections = resolved.libraries;
      resolvedRoots.set(rootKey, selections);
    }
    const rootSelection = selections.find((selection) => (
      selection.name === job.library && selection.version === job.version
    ));
    if (
      !rootSelection
      || rootSelection.packId !== job.packId
      || rootSelection.revision !== job.packRevision
      || fileURLToPath(rootSelection.manifestUrl) !== resolve(job.manifest)
    ) throw new Error(`native Library Pack root identity mismatch: ${job.library}@${job.version}`);
    const rootIdentity = Object.freeze({
      library: rootSelection.name,
      version: rootSelection.version,
      packId: rootSelection.packId,
      revision: rootSelection.revision,
      artifact: rootSelection.artifact,
    });
    const sourceKeys = [];
    for (const selection of selections) {
      const manifestUrl = new URL(selection.manifestUrl);
      await assertNativeLibraryLocalFileUrl(
        manifestUrl,
        allowedRoot,
        `native Library Pack manifest ${selection.name}@${selection.version}`,
      );
      const sourceKey = `${manifestUrl.href}\0${selection.artifact}`;
      const existing = packSources.get(sourceKey);
      if (existing && (
        existing.packId !== selection.packId
        || existing.revision !== selection.revision
        || existing.version !== selection.version
        || existing.name !== selection.name
      )) {
        throw new Error(`native Library Pack location has conflicting identities: ${selection.name}@${selection.version}`);
      }
      if (!existing) packSources.set(sourceKey, selection);
      sourceKeys.push(sourceKey);
    }
    jobSources.push(Object.freeze({ key, rootIdentity, sourceKeys: Object.freeze(sourceKeys) }));
  }

  const records = new Map();
  const sources = [...packSources.entries()].sort((left, right) => compareText(left[0], right[0]));
  await mapWithConcurrency(sources, concurrency, async ([sourceKey, selection]) => {
    const result = await fingerprintPack(selection, { allowedRoot, registryDirectory });
    const record = result?.identity ? result : Object.freeze({ identity: result });
    if (!record.identity || !/^[a-f0-9]{64}$/.test(record.identity.sha256)) {
      throw new Error(`native Library Pack fingerprint is invalid: ${selection.name}@${selection.version}`);
    }
    records.set(sourceKey, record);
  });

  const jobIdentities = jobSources.map(({ key, rootIdentity, sourceKeys }) => {
    const packs = sourceKeys.map((sourceKey) => {
      const identity = records.get(sourceKey)?.identity;
      if (!identity || !/^[a-f0-9]{64}$/.test(identity.sha256)) {
        throw new Error(`native Library Pack fingerprint is missing for ${key}`);
      }
      return Object.freeze({
        library: identity.library,
        id: identity.id,
        version: identity.version,
        revision: identity.revision,
        artifact: identity.artifact.id,
        sha256: identity.sha256,
      });
    }).sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
    const body = Object.freeze({
      schema: LIBRARY_PACK_FINGERPRINT_SCHEMA,
      registry: registryIdentity,
      root: rootIdentity,
      packs: Object.freeze(packs),
    });
    return Object.freeze({
      key,
      root: rootIdentity,
      packCount: packs.length,
      packs: Object.freeze(packs),
      sha256: identitySha256(body),
    });
  }).sort((left, right) => compareText(left.key, right.key));
  const packIdentities = [...records.values()]
    .map((record) => record.identity)
    .sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));

  const snapshotStore = await createNativeLibrarySnapshotStore(options.snapshotRoot);
  const snapshots = new Map();
  const uniqueClosures = new Map(jobIdentities.map((job) => [job.sha256, job]));
  await mapWithConcurrency([...uniqueClosures.values()], concurrency, async (jobIdentity) => {
    const source = jobSources.find((candidate) => candidate.key === jobIdentity.key);
    if (!source) throw new Error(`native Library Pack snapshot source is missing for ${jobIdentity.key}`);
    const snapshotRecords = source.sourceKeys.map((sourceKey) => records.get(sourceKey));
    if (snapshotRecords.some((record) => !record?.snapshot)) {
      throw new Error(`native Library Pack snapshot bytes are missing for ${jobIdentity.key}`);
    }
    const snapshot = await materializeNativeLibraryPackSnapshot({
      store: snapshotStore,
      closure: jobIdentity,
      registryBytes,
      registryIdentity,
      records: snapshotRecords,
    });
    snapshots.set(jobIdentity.sha256, snapshot);
  });

  const setBody = Object.freeze({
    schema: LIBRARY_PACK_FINGERPRINT_SCHEMA,
    jobs: Object.freeze(jobIdentities.map(({ key, sha256: jobSha256 }) => Object.freeze({
      key,
      sha256: jobSha256,
    }))),
  });
  return Object.freeze({
    evidence: Object.freeze({
      schema: LIBRARY_PACK_FINGERPRINT_SCHEMA,
      status: 'verified',
      jobCount: jobIdentities.length,
      packCount: packIdentities.length,
      sha256: identitySha256(setBody),
    }),
    jobs: Object.freeze(jobIdentities),
    packs: Object.freeze(packIdentities),
    snapshots,
    snapshotRoot: snapshotStore.root,
    ownsSnapshotRoot: snapshotStore.owned,
  });
}

async function fingerprintLocalNativeLibraryPack(selection, { allowedRoot, registryDirectory }) {
  const manifestUrl = new URL(selection.manifestUrl);
  const captures = new Map();
  const fetchFn = async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    const method = String(init.method ?? request?.method ?? 'GET').toUpperCase();
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (method !== 'GET') throw new Error('native Library Pack fingerprint only permits GET');
    const path = await assertNativeLibraryLocalFileUrl(url, allowedRoot, 'native Library Pack payload');
    const before = await lstat(path);
    const data = await readFile(path);
    const after = await lstat(path);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) throw new Error('native Library Pack content changed during fingerprinting');
    const capture = Object.freeze({ data, bytes: data.byteLength, sha256: sha256(data) });
    const previous = captures.get(url.href);
    if (previous && (previous.bytes !== capture.bytes || previous.sha256 !== capture.sha256)) {
      throw new Error('native Library Pack content changed during fingerprinting');
    }
    captures.set(url.href, capture);
    return new Response(data, {
      status: 200,
      headers: {
        'content-type': url.pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        'content-length': String(data.byteLength),
      },
    });
  };
  const loader = createBrowserToolchainPackLoader({
    manifestUrl,
    expectedId: selection.packId,
    expectedRevision: selection.revision,
    limits: ESP32_BROWSER_LIBRARY_PACK_LIMITS,
    fetchFn,
  });
  try {
    const manifest = await loader.loadManifest();
    if (manifest.version !== selection.version) {
      throw new Error(`native Library Pack version mismatch: ${selection.name}@${selection.version}`);
    }
    const loaded = await loader.loadArtifact(selection.artifact);
    if (loaded.artifact.kind !== 'library-source-json') {
      throw new Error(`native Library Pack source artifact kind is invalid: ${selection.name}@${selection.version}`);
    }
    const source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes));
    if (source?.name !== selection.name || source?.version !== selection.version) {
      throw new Error(`native Library Pack decoded source identity mismatch: ${selection.name}@${selection.version}`);
    }
    const manifestCapture = captures.get(manifestUrl.href);
    if (!manifestCapture) throw new Error('native Library Pack manifest bytes were not captured');
    const baseUrl = new URL('./', manifestUrl);
    const chunks = loaded.artifact.chunks.map((chunk) => {
      const chunkUrl = new URL(chunk.path, baseUrl);
      const transport = captures.get(chunkUrl.href);
      if (!transport) throw new Error(`native Library Pack chunk bytes were not captured: ${chunk.path}`);
      return Object.freeze({
        path: snapshotRelativePath(registryDirectory, fileURLToPath(chunkUrl), 'Library Pack chunk'),
        transportBytes: transport.bytes,
        transportSha256: transport.sha256,
        decodedBytes: chunk.size,
        decodedSha256: chunk.sha256,
        ...(chunk.compression === undefined ? {} : { compression: chunk.compression }),
        data: transport.data,
      });
    });
    const body = Object.freeze({
      schema: LIBRARY_PACK_FINGERPRINT_SCHEMA,
      library: selection.name,
      id: manifest.id,
      version: manifest.version,
      revision: manifest.revision,
      manifest: Object.freeze({ bytes: manifestCapture.bytes, sha256: manifestCapture.sha256 }),
      artifact: Object.freeze({
        id: loaded.artifact.id,
        kind: loaded.artifact.kind,
        bytes: loaded.bytes.byteLength,
        sha256: sha256(loaded.bytes),
        chunks: Object.freeze(chunks.map(({ data: _data, ...chunk }) => Object.freeze(chunk))),
      }),
    });
    const identity = Object.freeze({ ...body, sha256: identitySha256(body) });
    return Object.freeze({
      identity,
      snapshot: Object.freeze({
        library: selection.name,
        version: selection.version,
        packId: selection.packId,
        revision: selection.revision,
        artifact: selection.artifact,
        manifest: Object.freeze({
          path: snapshotRelativePath(registryDirectory, fileURLToPath(manifestUrl), 'Library Pack manifest'),
          data: manifestCapture.data,
        }),
        chunks: Object.freeze(chunks.map((chunk) => Object.freeze({ path: chunk.path, data: chunk.data }))),
        decodedArtifact: Buffer.from(loaded.bytes),
      }),
    });
  } finally {
    loader.reset?.();
  }
}

function snapshotRelativePath(root, path, label) {
  const value = relative(root, resolve(path)).split(sep).join('/');
  if (!value || value === '.' || value === '..' || value.startsWith('../') || isAbsolute(value)) {
    throw new Error(`${label} is outside the Registry root`);
  }
  if (value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${label} path is not canonical`);
  }
  return value;
}

async function createNativeLibrarySnapshotStore(requestedRoot) {
  let root;
  const owned = false;
  if (requestedRoot === undefined) {
    root = resolve(ROOT, 'var/tmp/ck-native-library-snapshots-v1');
    await mkdir(root, { recursive: true });
  } else {
    root = resolve(requestedRoot);
    await mkdir(root, { recursive: true });
  }
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('native Library Pack snapshot root is a symbolic link, junction, or reparse point');
  }
  root = await realpath(root);
  await mkdir(join(root, 'objects'), { recursive: true });
  await mkdir(join(root, 'snapshots'), { recursive: true });
  await Promise.all([
    assertNativeLibrarySnapshotDirectory(root, join(root, 'objects')),
    assertNativeLibrarySnapshotDirectory(root, join(root, 'snapshots')),
  ]);
  return Object.freeze({ root, owned });
}

async function writeImmutableSnapshotFile(root, relativePath, bytes) {
  const path = resolve(root, ...relativePath.split('/'));
  if (!pathWithin(root, path)) throw new Error('native Library Pack snapshot path escapes its root');
  await mkdir(dirname(path), { recursive: true });
  await assertNativeLibrarySnapshotDirectory(root, dirname(path));
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error('native Library Pack snapshot entry is not an immutable regular file');
    }
    const current = await readFile(path);
    if (current.byteLength !== bytes.byteLength || sha256(current) !== sha256(bytes)) {
      throw new Error('native Library Pack snapshot content-address collision');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o444 });
    await chmod(temporary, 0o444).catch(() => {});
    try {
      await rename(temporary, path);
    } catch (renameError) {
      await rm(temporary, { force: true }).catch(() => {});
      if (!['EEXIST', 'EACCES', 'EPERM'].includes(renameError?.code)) throw renameError;
      const existing = await lstat(path);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error('native Library Pack snapshot entry is not an immutable regular file');
      }
      const current = await readFile(path);
      if (current.byteLength !== bytes.byteLength || sha256(current) !== sha256(bytes)) {
        throw new Error('native Library Pack snapshot content-address collision');
      }
    }
    await chmod(path, 0o444).catch(() => {});
  }
  return path;
}

async function assertNativeLibrarySnapshotDirectory(root, path) {
  if (!pathWithin(root, path)) throw new Error('native Library Pack snapshot directory escapes its root');
  let current = root;
  const segments = relative(root, path).split(sep).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('native Library Pack snapshot directory is a symbolic link, junction, or reparse point');
    }
  }
  const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(path)]);
  if (!pathWithin(canonicalRoot, canonicalPath)
    || relative(root, path).split(sep).join('/') !== relative(canonicalRoot, canonicalPath).split(sep).join('/')) {
    throw new Error('native Library Pack snapshot directory differs through a junction or reparse point');
  }
}

async function snapshotObject(store, bytes) {
  const data = Buffer.from(bytes);
  const digest = sha256(data);
  const path = `objects/${digest}`;
  await writeImmutableSnapshotFile(store.root, path, data);
  return Object.freeze({ path, bytes: data.byteLength, sha256: digest });
}

async function materializeNativeLibraryPackSnapshot({ store, closure, registryBytes, registryIdentity, records }) {
  const registryObject = await snapshotObject(store, registryBytes);
  const packs = [];
  for (const record of records) {
    const manifest = await snapshotObject(store, record.snapshot.manifest.data);
    const chunks = [];
    for (const chunk of record.snapshot.chunks) {
      chunks.push(Object.freeze({ path: chunk.path, object: await snapshotObject(store, chunk.data) }));
    }
    packs.push(Object.freeze({
      library: record.snapshot.library,
      version: record.snapshot.version,
      packId: record.snapshot.packId,
      revision: record.snapshot.revision,
      artifact: record.snapshot.artifact,
      identitySha256: record.identity.sha256,
      manifest: Object.freeze({ path: record.snapshot.manifest.path, object: manifest }),
      chunks: Object.freeze(chunks),
      decodedArtifact: await snapshotObject(store, record.snapshot.decodedArtifact),
    }));
  }
  packs.sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
  const closureBody = Object.freeze({
    schema: LIBRARY_PACK_FINGERPRINT_SCHEMA,
    registry: registryIdentity,
    root: closure.root,
    packs: closure.packs,
  });
  if (identitySha256(closureBody) !== closure.sha256) {
    throw new Error(`native Library Pack snapshot closure changed for ${closure.key}`);
  }
  const descriptor = Object.freeze({
    schema: LIBRARY_PACK_SNAPSHOT_SCHEMA,
    closure: Object.freeze({ ...closureBody, sha256: closure.sha256 }),
    registry: Object.freeze({ path: 'registry.json', object: registryObject }),
    packs: Object.freeze(packs),
  });
  const descriptorPath = await writeImmutableSnapshotFile(
    store.root,
    `snapshots/${closure.sha256}/snapshot.json`,
    Buffer.from(`${canonicalJson(descriptor)}\n`),
  );
  return Object.freeze({
    root: store.root,
    descriptor: descriptorPath,
    closureSha256: closure.sha256,
    rootIdentity: closure.root,
  });
}

async function readTargetContexts(targets) {
  const contexts = new Map();
  for (const target of targets) {
    const definition = MATRIX_TARGETS[target];
    const descriptorPath = resolve(ROOT, definition.descriptor);
    const descriptorBytes = await readFile(descriptorPath);
    const descriptor = JSON.parse(descriptorBytes.toString('utf8'));
    if (descriptor.board !== definition.board) throw new Error(`${target} runtime descriptor targets ${descriptor.board}`);
    const manifests = [];
    const seenRoles = new Set();
    for (const pack of descriptor.packs ?? []) {
      if (!['compiler', 'sdk', 'board'].includes(pack?.role) || seenRoles.has(pack.role)) {
        throw new Error(`${target} runtime descriptor has an invalid or duplicate Pack role`);
      }
      seenRoles.add(pack.role);
      const manifestPath = resolve(dirname(descriptorPath), ...String(pack.manifest).split('/'));
      const bytes = await readFile(manifestPath);
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (manifest.id !== pack.id || manifest.revision !== pack.revision) {
        throw new Error(`${target} ${pack.role} Pack does not match its runtime descriptor`);
      }
      manifests.push({ role: pack.role, path: manifestPath, bytes, manifest });
    }
    if (manifests.length !== 3 || ['compiler', 'sdk', 'board'].some((role) => !seenRoles.has(role))) {
      throw new Error(`${target} runtime descriptor must bind compiler, sdk, and board Packs`);
    }
    const sdk = manifests.find(({ role }) => role === 'sdk');
    if (!sdk || typeof sdk.manifest.version !== 'string') throw new Error(`${target} SDK Pack version is missing`);
    contexts.set(target, Object.freeze({
      target,
      descriptorPath,
      descriptorBytes,
      manifests: Object.freeze(manifests),
      platformVersion: sdk.manifest.version,
    }));
  }
  return contexts;
}

function createTargetPackEvidence(contexts) {
  const targets = [...contexts.values()]
    .sort((left, right) => left.target.localeCompare(right.target))
    .map((context) => Object.freeze({
      target: context.target,
      board: JSON.parse(context.descriptorBytes.toString('utf8')).board,
      descriptorSha256: sha256(context.descriptorBytes),
      packs: Object.freeze(context.manifests
        .map(({ role, bytes, manifest }) => Object.freeze({
          role,
          id: manifest.id,
          revision: manifest.revision,
          schema: manifest.schema,
          version: manifest.version,
          manifestSha256: sha256(bytes),
        }))
        .sort((left, right) => packRoleOrder(left.role) - packRoleOrder(right.role))),
    }));
  const body = Object.freeze({ schema: EVIDENCE_SCHEMA, targets: Object.freeze(targets) });
  return Object.freeze({ ...body, sha256: identitySha256(body) });
}

function packRoleOrder(role) {
  return ['compiler', 'sdk', 'board'].indexOf(role);
}

export function createNativeExecutionEnvironment(
  source = process.env,
  { toolDirectories = [] } = {},
) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('native execution environment source is invalid');
  }
  if (!Array.isArray(toolDirectories) || toolDirectories.some((path) => typeof path !== 'string' || !isAbsolute(path))) {
    throw new TypeError('native execution environment tool directories are invalid');
  }
  const environment = {};
  for (const name of NATIVE_EXECUTION_ENVIRONMENT_PASSTHROUGH) {
    const value = environmentValue(source, name);
    if (value !== undefined && value !== '') environment[name] = value;
  }
  Object.assign(environment, NATIVE_EXECUTION_ENVIRONMENT_FIXED);
  environment.PYTHONNOUSERSITE = '1';
  environment.PYTHONHASHSEED = '0';
  const temporaryRoot = resolve(ROOT, 'var/tmp');
  environment.TEMP = temporaryRoot;
  environment.TMP = temporaryRoot;
  environment.TMPDIR = temporaryRoot;
  const paths = [...new Set(toolDirectories.map((path) => resolve(path)))];
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (process.platform === 'win32' && systemRoot) paths.push(resolve(systemRoot, 'System32'));
  environment.PATH = [...new Set(paths)].join(delimiter);
  return Object.freeze(environment);
}

export function createNativeExecutionEnvironmentEvidence(source = process.env) {
  const allowed = [];
  for (const name of NATIVE_EXECUTION_ENVIRONMENT_PASSTHROUGH) {
    const value = environmentValue(source, name);
    if (value === undefined || value === '') continue;
    allowed.push(Object.freeze({
      name,
      bytes: Buffer.byteLength(value),
      valueSha256: sha256(Buffer.from(value)),
    }));
  }
  allowed.sort((left, right) => compareText(left.name, right.name));
  const body = Object.freeze({
    schema: NATIVE_EXECUTION_ENVIRONMENT_SCHEMA,
    policy: NATIVE_EXECUTION_ENVIRONMENT_POLICY,
    default: 'deny',
    allowed: Object.freeze(allowed),
    fixed: Object.freeze({
      ...NATIVE_EXECUTION_ENVIRONMENT_FIXED,
      PATH: 'authorized-tool-directories-plus-windows-system32',
      TEMP: 'workspace:var/tmp',
      TMP: 'workspace:var/tmp',
      TMPDIR: 'workspace:var/tmp',
      PYTHONNOUSERSITE: '1',
      PYTHONHASHSEED: '0',
      [NATIVE_PYTHON_ENV]: 'target-authorized-absolute-interpreter',
      [NATIVE_TOOL_IDENTITY_ENV]: 'target-authorization-sha256',
      [NATIVE_LIBRARY_CLOSURE_ENV]: 'per-job-library-pack-closure-sha256',
      [NATIVE_LIBRARY_SNAPSHOT_ROOT_ENV]: 'ephemeral-authorized-snapshot-root',
    }),
    blocked: NATIVE_EXECUTION_ENVIRONMENT_BLOCKED,
  });
  return Object.freeze({ ...body, sha256: identitySha256(body) });
}

function environmentValue(source, name) {
  if (typeof source[name] === 'string') return source[name];
  const match = Object.keys(source).find((key) => key.toUpperCase() === name.toUpperCase());
  return match && typeof source[match] === 'string' ? source[match] : undefined;
}

export async function readPlannerPublicationIdentity(
  workspaceRoot = ROOT,
  publicationDefinitions = PLANNER_PUBLICATIONS,
) {
  if (!Array.isArray(publicationDefinitions) || publicationDefinitions.length === 0) {
    throw new TypeError('planner publication definitions must be non-empty');
  }
  const publicationRecords = [];
  let expectedArtifactSet;
  for (const definition of publicationDefinitions) {
    const directory = resolve(workspaceRoot, definition.directory);
    const manifestPath = resolve(directory, 'build-manifest.json');
    const manifestBytes = await readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const artifactSet = await validatePlannerPublicationManifest(manifest, directory, definition.id);
    const serialized = JSON.stringify(artifactSet);
    if (expectedArtifactSet !== undefined && serialized !== JSON.stringify(expectedArtifactSet)) {
      throw new Error(`ck-build-core WASM publication ${definition.id} does not match the other publications`);
    }
    expectedArtifactSet ??= artifactSet;
    publicationRecords.push(Object.freeze({
      id: definition.id,
      manifest: `${definition.directory}/build-manifest.json`,
      manifestSha256: sha256(manifestBytes),
    }));
  }
  const artifactSetSha256 = identitySha256(expectedArtifactSet);
  return Object.freeze({
    schema: EVIDENCE_SCHEMA,
    artifactSetSha256,
    ...expectedArtifactSet,
    publications: Object.freeze(publicationRecords),
  });
}

export async function readCommittedPlannerPublicationIdentity(workspaceRoot = ROOT) {
  return readPlannerPublicationIdentity(workspaceRoot, COMMITTED_PLANNER_PUBLICATIONS);
}

async function validatePlannerPublicationManifest(manifest, directory, publicationId) {
  if (
    !manifest
    || typeof manifest !== 'object'
    || Array.isArray(manifest)
    || manifest.schemaVersion !== 1
    || typeof manifest.rustToolchain !== 'string'
    || !manifest.rustToolchain
    || manifest.target !== 'wasm32-unknown-unknown'
    || typeof manifest.wasmBindgen !== 'string'
    || !manifest.wasmBindgen
    || !Array.isArray(manifest.files)
    || !manifest.files.length
  ) throw new Error(`ck-build-core WASM publication ${publicationId} has an invalid manifest`);
  const seen = new Set();
  const files = [];
  for (const file of manifest.files) {
    if (
      !file
      || typeof file !== 'object'
      || Array.isArray(file)
      || typeof file.path !== 'string'
      || !/^[A-Za-z0-9._-]+$/.test(file.path)
      || seen.has(file.path)
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || typeof file.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(file.sha256)
    ) throw new Error(`ck-build-core WASM publication ${publicationId} has an invalid file entry`);
    seen.add(file.path);
    const bytes = await readFile(resolve(directory, file.path));
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new Error(`ck-build-core WASM publication ${publicationId} file identity mismatch: ${file.path}`);
    }
    files.push(Object.freeze({ path: file.path, bytes: file.bytes, sha256: file.sha256 }));
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (!seen.has('ck_build_core.js') || !seen.has('ck_build_core_bg.wasm')) {
    throw new Error(`ck-build-core WASM publication ${publicationId} is missing its runtime artifacts`);
  }
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    rustToolchain: manifest.rustToolchain,
    target: manifest.target,
    wasmBindgen: manifest.wasmBindgen,
    files: Object.freeze(files),
  });
}

function nativeIdentityRequest(targetPacks, pythonInterpreter) {
  return Object.freeze({
    schema: NATIVE_AUTHORIZATION_SCHEMA,
    hostPlatform: process.platform,
    ...(pythonInterpreter === undefined ? {} : {
      pythonInterpreter: Object.freeze({
        command: pythonInterpreter.command,
        commandSha256: pythonInterpreter.commandSha256,
        authorizedDirectory: pythonInterpreter.authorizedDirectory,
      }),
    }),
    targets: Object.freeze(targetPacks.targets.map((target) => Object.freeze({
      target: target.target,
      board: target.board,
      packs: Object.freeze(target.packs.map(({ role, id, revision, schema, version }) => Object.freeze({
        role, id, revision, schema, version,
      }))),
    }))),
  });
}

/**
 * Resolve Python before the deny-by-default child environment is created.
 * The returned command is canonical and its directory becomes an explicit
 * authorization root; execution never asks PATH to find `python3` again.
 */
export async function resolveNativePythonInterpreter(
  source = process.env,
  hostPlatform = process.platform,
) {
  if (hostPlatform === 'win32') return undefined;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('native Python resolution environment is invalid');
  }
  const explicit = environmentValue(source, NATIVE_PYTHON_ENV);
  const pathValue = environmentValue(source, 'PATH');
  const candidates = [];
  if (explicit !== undefined && explicit !== '') {
    if (!isAbsolute(explicit)) throw new Error(`${NATIVE_PYTHON_ENV} must be an absolute path`);
    candidates.push(explicit);
  } else {
    for (const directory of String(pathValue ?? '').split(delimiter).filter(Boolean)) {
      if (!isAbsolute(directory)) continue;
      candidates.push(join(directory, 'python3'));
    }
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    let canonical;
    try { canonical = await realpath(absolute); } catch { continue; }
    let stat;
    try { stat = await lstat(canonical); } catch { continue; }
    if (!stat.isFile()) {
      if (explicit !== undefined && explicit !== '') {
        throw new Error(`${NATIVE_PYTHON_ENV} is not a regular file`);
      }
      continue;
    }
    const identity = await hashClosureFile(canonical, NATIVE_TOOLCHAIN_CLOSURE_LIMITS, createClosureProbeState());
    return Object.freeze({
      command: canonical,
      commandSha256: identity.sha256,
      authorizedDirectory: dirname(canonical),
    });
  }
  throw new Error('POSIX native Matrix requires an explicit python3 interpreter; set CK_NATIVE_PYTHON or provide it on PATH');
}

async function probeNativeExecutionIdentity(targetPacks, pythonInterpreter) {
  const temporaryRoot = resolve(ROOT, 'var/tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'ck-native-identity-'));
  try {
    const requestPath = join(directory, 'identity-request.json');
    await writeFile(requestPath, `${JSON.stringify(nativeIdentityRequest(targetPacks, pythonInterpreter), null, 2)}\n`, 'utf8');
    const result = await runIdentityProbe(requestPath);
    return JSON.parse(result);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function runIdentityProbe(requestPath) {
  return new Promise((resolveResult, reject) => {
    const environment = createNativeExecutionEnvironment();
    const child = spawn(process.execPath, [
      '--import', 'tsx', NATIVE_VERIFIER, '--describe-execution-identity', requestPath,
    ], {
      cwd: ROOT,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const maximum = 2 * 1024 * 1024;
    const capture = (previous, chunk) => {
      const next = previous + Buffer.from(chunk).toString('utf8');
      if (Buffer.byteLength(next) > maximum) {
        child.kill();
        throw new Error('native execution identity probe exceeded its output limit');
      }
      return next;
    };
    child.stdout.on('data', (chunk) => {
      try { stdout = capture(stdout, chunk); } catch (error) { rejectOnce(error); }
    });
    child.stderr.on('data', (chunk) => {
      try { stderr = capture(stderr, chunk); } catch (error) { rejectOnce(error); }
    });
    const timeout = setTimeout(() => {
      child.kill();
      rejectOnce(new Error('native execution identity probe timed out'));
    }, 30_000);
    timeout.unref?.();
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    child.once('error', rejectOnce);
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0 || signal) {
        reject(new Error(`native execution identity probe failed: ${summarizeFailure(stderr || stdout)}`));
        return;
      }
      resolveResult(stdout);
    });
  });
}

async function validateNativePythonIdentity(value, hostPlatform) {
  if (hostPlatform === 'win32') {
    if (value !== undefined) throw new Error('Windows native identity must not contain a POSIX Python interpreter');
    return undefined;
  }
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof value.command !== 'string'
    || !isAbsolute(value.command)
    || typeof value.commandSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.commandSha256)
    || typeof value.authorizedDirectory !== 'string'
    || !isAbsolute(value.authorizedDirectory)
  ) throw new Error('POSIX native identity requires a valid Python interpreter binding');
  rejectUnknownKeys(value, ['command', 'commandSha256', 'authorizedDirectory'], 'native Python interpreter');
  const command = await realpath(resolve(value.command));
  const authorizedDirectory = await realpath(resolve(value.authorizedDirectory));
  const commandStat = await lstat(command);
  const directoryStat = await lstat(authorizedDirectory);
  if (!commandStat.isFile()) throw new Error('native Python interpreter is not a regular file');
  if (!directoryStat.isDirectory()) throw new Error('native Python interpreter authorization directory is not a directory');
  if (authorizedDirectory !== dirname(command)) {
    throw new Error('native Python interpreter authorization directory must be its executable directory');
  }
  if (!pathWithin(authorizedDirectory, command)) {
    throw new Error('native Python interpreter is outside its authorization directory');
  }
  const commandSha256 = sha256(await readFile(command));
  if (commandSha256 !== value.commandSha256) {
    throw new Error('native Python interpreter command hash mismatch');
  }
  return Object.freeze({ command, commandSha256, authorizedDirectory });
}

function isNativeHostPlatform(value) {
  return typeof value === 'string' && [
    'aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd',
  ].includes(value);
}

function rejectUnknownKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

async function validateNativeExecutionIdentity(value, targetPacks, closureOptions = {}) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schema !== NATIVE_AUTHORIZATION_SCHEMA
    || value.mode !== NATIVE_AUTHORIZATION_MODE
    || !isNativeHostPlatform(value.hostPlatform)
    || !Array.isArray(value.targets)
  ) throw new Error('native execution identity probe returned an invalid document');
  rejectUnknownKeys(
    value,
    ['schema', 'mode', 'hostPlatform', 'pythonInterpreter', 'targets', 'sha256'],
    'native execution identity',
  );
  const hostPlatform = value.hostPlatform;
  const pythonInterpreter = await validateNativePythonIdentity(value.pythonInterpreter, hostPlatform);
  const pythonEvidence = pythonInterpreter === undefined ? undefined : Object.freeze({
    id: 'python3',
    bytes: (await lstat(pythonInterpreter.command)).size,
    sha256: pythonInterpreter.commandSha256,
  });
  const expectedTargets = new Map(targetPacks.targets.map((target) => [target.target, target]));
  if (value.targets.length !== expectedTargets.size) {
    throw new Error('native execution identity target set does not match the Matrix');
  }
  const seenTargets = new Set();
  const authorizationTargets = [];
  const authorizationIdentities = [];
  const targets = [];
  const probeState = createClosureProbeState();
  for (const candidate of value.targets) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('native execution identity target is invalid');
    }
    rejectUnknownKeys(
      candidate,
      ['schema', 'mode', 'hostPlatform', 'toolSource', 'packToolEquivalence', 'target', 'board', 'packs', 'tools', 'pythonInterpreter', 'sha256'],
      `native execution identity target ${candidate.target ?? '<unknown>'}`,
    );
    const expected = expectedTargets.get(candidate?.target);
    if (
      !expected
      || seenTargets.has(candidate.target)
      || candidate.schema !== NATIVE_AUTHORIZATION_SCHEMA
      || candidate.mode !== NATIVE_AUTHORIZATION_MODE
      || candidate.board !== expected.board
      || candidate.hostPlatform !== hostPlatform
      || candidate.toolSource !== 'host-native-substitution'
      || candidate.packToolEquivalence !== false
    ) {
      throw new Error('native execution identity contains an unknown, duplicate, or mismatched target');
    }
    seenTargets.add(candidate.target);
    const candidatePythonInterpreter = await validateNativePythonIdentity(
      candidate.pythonInterpreter,
      hostPlatform,
    );
    if (!sameNativePythonIdentity(candidatePythonInterpreter, pythonInterpreter)) {
      throw new Error(`native execution identity Python binding mismatch: ${candidate.target}`);
    }
    const expectedPacks = Object.fromEntries(expected.packs.map((pack) => [pack.role, {
      id: pack.id,
      revision: pack.revision,
    }]));
    if (JSON.stringify(candidate.packs) !== JSON.stringify(expectedPacks)) {
      throw new Error(`native execution identity Pack binding mismatch: ${candidate.target}`);
    }
    if (!Array.isArray(candidate.tools) || candidate.tools.length !== NATIVE_TOOL_IDS.length) {
      throw new Error(`native execution identity tool set is incomplete: ${candidate.target}`);
    }
    const tools = [];
    const seenTools = new Set();
    for (const tool of candidate.tools) {
      if (
        !tool
        || typeof tool !== 'object'
        || !NATIVE_TOOL_IDS.includes(tool.id)
        || seenTools.has(tool.id)
        || tool.packSha256 !== expectedPacks.compiler.revision
        || typeof tool.command !== 'string'
        || !isAbsolute(tool.command)
        || typeof tool.commandSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(tool.commandSha256)
      ) throw new Error(`native execution identity tool is invalid: ${candidate.target}`);
      rejectUnknownKeys(
        tool,
        ['id', 'packSha256', 'command', 'commandSha256', 'closure'],
        `native execution identity tool ${candidate.target}`,
      );
      const staticClosure = validateNativeStaticClosureIdentity(
        tool.closure,
        `${candidate.target} ${tool.id}`,
      );
      seenTools.add(tool.id);
      const command = resolve(tool.command);
      const stat = await lstat(command);
      if (!stat.isFile()) throw new Error(`native execution identity command is not a regular file: ${tool.id}`);
      const commandSha256 = sha256(await readFile(command));
      if (commandSha256 !== tool.commandSha256) {
        throw new Error(`native execution identity command hash mismatch: ${candidate.target} ${tool.id}`);
      }
      tools.push(Object.freeze({
        id: tool.id,
        packSha256: tool.packSha256,
        command,
        commandSha256,
        commandBytes: stat.size,
        closure: staticClosure,
      }));
    }
    tools.sort((left, right) => compareText(left.id, right.id));
    const authorizationBody = Object.freeze({
      schema: NATIVE_AUTHORIZATION_SCHEMA,
      mode: NATIVE_AUTHORIZATION_MODE,
      hostPlatform,
      toolSource: 'host-native-substitution',
      packToolEquivalence: false,
      target: candidate.target,
      board: candidate.board,
      packs: Object.freeze(expectedPacks),
      tools: Object.freeze(tools.map(({ commandBytes: _commandBytes, ...tool }) => tool)),
      ...(pythonInterpreter === undefined ? {} : { pythonInterpreter }),
    });
    const authorizationIdentity = Object.freeze({
      ...authorizationBody,
      sha256: identitySha256(authorizationBody),
    });
    if (candidate.sha256 !== authorizationIdentity.sha256) {
      throw new Error(`native execution identity digest mismatch: ${candidate.target}`);
    }
    authorizationIdentities.push(authorizationIdentity);
    authorizationTargets.push(Object.freeze({
      target: candidate.target,
      sha256: candidate.sha256,
      hostPlatform,
      ...(pythonInterpreter === undefined ? {} : { pythonInterpreter }),
      pathDirectories: Object.freeze([...new Set([
        ...tools.map((tool) => dirname(tool.command)),
        ...(pythonInterpreter === undefined ? [] : [pythonInterpreter.authorizedDirectory]),
      ])].sort(compareText)),
    }));
    const closure = await createNativeToolchainClosure({
      target: candidate.target,
      tools,
    }, { ...closureOptions, state: probeState });
    const body = Object.freeze({
      schema: EVIDENCE_SCHEMA,
      mode: NATIVE_TOOL_IDENTITY_MODE,
      toolSource: 'host-native-substitution',
      packToolEquivalence: false,
      target: candidate.target,
      board: candidate.board,
      packs: Object.freeze(expectedPacks),
      tools: Object.freeze(tools.map((tool) => Object.freeze({
        id: tool.id,
        packSha256: tool.packSha256,
        bytes: tool.commandBytes,
        sha256: tool.commandSha256,
        closure: tool.closure,
      }))),
      closure,
      ...(pythonEvidence === undefined ? {} : { pythonInterpreter: pythonEvidence }),
    });
    const targetIdentity = Object.freeze({ ...body, sha256: identitySha256(body) });
    targets.push(targetIdentity);
  }
  targets.sort((left, right) => compareText(left.target, right.target));
  authorizationIdentities.sort((left, right) => compareText(left.target, right.target));
  const authorizationDocumentBody = Object.freeze({
    schema: NATIVE_AUTHORIZATION_SCHEMA,
    mode: NATIVE_AUTHORIZATION_MODE,
    hostPlatform,
    ...(pythonInterpreter === undefined ? {} : { pythonInterpreter }),
    targets: Object.freeze(authorizationIdentities),
  });
  if (value.sha256 !== identitySha256(authorizationDocumentBody)) {
    throw new Error('native execution identity document digest mismatch');
  }
  authorizationTargets.sort((left, right) => compareText(left.target, right.target));
  const evidenceBody = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    mode: NATIVE_TOOL_IDENTITY_MODE,
    targets: Object.freeze(targets),
  });
  return Object.freeze({
    evidence: Object.freeze({ ...evidenceBody, sha256: identitySha256(evidenceBody) }),
    authorization: Object.freeze({
      schema: NATIVE_AUTHORIZATION_SCHEMA,
      mode: NATIVE_AUTHORIZATION_MODE,
      hostPlatform,
      targets: Object.freeze(authorizationTargets),
    }),
  });
}

function sameNativePythonIdentity(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.command === right.command
    && left.commandSha256 === right.commandSha256
    && left.authorizedDirectory === right.authorizedDirectory;
}

function validateNativeStaticClosureIdentity(value, label) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.fileCount)
    || value.fileCount < 0
    || !Number.isSafeInteger(value.totalBytes)
    || value.totalBytes < 0
    || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sha256)
  ) throw new Error(`native execution identity static closure is invalid: ${label}`);
  rejectUnknownKeys(
    value,
    ['schemaVersion', 'fileCount', 'totalBytes', 'sha256'],
    `native execution identity static closure ${label}`,
  );
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    fileCount: value.fileCount,
    totalBytes: value.totalBytes,
    sha256: value.sha256,
  });
}

export async function createNativeToolchainClosure(input, options = {}) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.tools)) {
    throw new TypeError('native toolchain closure input is invalid');
  }
  const limits = normalizeClosureLimits(options.limits);
  const state = options.state ?? createClosureProbeState();
  const tools = new Map(input.tools.map((tool) => [tool.id, tool]));
  if (tools.size !== NATIVE_TOOL_IDS.length || NATIVE_TOOL_IDS.some((id) => !tools.has(id))) {
    throw new Error(`native toolchain closure tool set is incomplete: ${input.target}`);
  }

  const cc = tools.get('toolchain:cc');
  const binRoot = await requireDirectory(dirname(cc.command), 'compiler bin');
  const toolchainRoot = await requireDirectory(dirname(binRoot), 'toolchain root');
  for (const tool of tools.values()) {
    const command = await realpath(tool.command);
    if (!pathWithin(binRoot, command)) {
      throw new Error(`native toolchain command escapes compiler bin: ${input.target} ${tool.id}`);
    }
  }
  const queryEnvironment = createNativeExecutionEnvironment(process.env, {
    toolDirectories: [binRoot],
  });
  const boundedRunQuery = options.runQuery ?? ((command, arguments_, queryLimits) => (
    runBoundedToolQuery(command, arguments_, queryLimits, queryEnvironment)
  ));

  const sysrootOutput = await singleLineToolQuery(
    boundedRunQuery,
    cc.command,
    ['-print-sysroot'],
    limits,
    'tree:sysroot',
  );
  const sysroot = await requireDirectory(sysrootOutput, 'compiler sysroot');
  if (!pathWithin(toolchainRoot, sysroot) || sysroot === toolchainRoot) {
    throw new Error(`native toolchain sysroot is outside or aliases its root: ${input.target}`);
  }
  const treeDefinitions = [
    await controlledTreeDefinition('tree:bin', binRoot, toolchainRoot),
    await controlledTreeDefinition('tree:lib', join(toolchainRoot, 'lib'), toolchainRoot),
    await controlledTreeDefinition('tree:libexec', join(toolchainRoot, 'libexec'), toolchainRoot),
    await controlledTreeDefinition('tree:sysroot', sysroot, toolchainRoot),
  ];
  assertDisjointTreeRoots(treeDefinitions, input.target);

  const helpers = [];
  const seenHelperPaths = new Set();
  for (const definition of NATIVE_HELPER_QUERIES) {
    const driver = tools.get(definition.tool);
    const output = await singleLineToolQuery(
      boundedRunQuery,
      driver.command,
      [definition.argument],
      limits,
      definition.role,
    );
    const resolved = await requireControlledTreeFile(output, treeDefinitions, definition.role);
    if (seenHelperPaths.has(resolved.path)) {
      throw new Error(`native toolchain helper resolution is ambiguous: ${input.target} ${definition.role}`);
    }
    seenHelperPaths.add(resolved.path);
    const identity = await hashClosureFile(resolved.path, limits, state);
    helpers.push(Object.freeze({
      role: definition.role,
      treeRole: resolved.treeRole,
      path: resolved.relativePath,
      bytes: identity.bytes,
      sha256: identity.sha256,
    }));
  }
  const libgccOutput = await singleLineToolQuery(
    boundedRunQuery,
    cc.command,
    ['-print-libgcc-file-name'],
    limits,
    'runtime:libgcc',
  );
  const libgccResolved = await requireControlledTreeFile(libgccOutput, treeDefinitions, 'runtime:libgcc');
  const libgcc = await hashClosureFile(libgccResolved.path, limits, state);

  const specsOutput = await queryToolBytes(boundedRunQuery, cc.command, ['-dumpspecs'], limits, 'specs:builtin');
  if (!specsOutput.byteLength || specsOutput.includes(0)) {
    throw new Error(`native toolchain builtin specs are empty or invalid: ${input.target}`);
  }
  const printedSpecs = await singleLineToolQuery(
    boundedRunQuery,
    cc.command,
    ['-print-file-name=specs'],
    limits,
    'specs:external-default',
  );
  let externalSpecs = Object.freeze({ status: 'not-present' });
  if (printedSpecs !== 'specs') {
    const resolved = await requireControlledTreeFile(printedSpecs, treeDefinitions, 'specs:external-default');
    const identity = await hashClosureFile(resolved.path, limits, state);
    externalSpecs = Object.freeze({
      status: 'present',
      treeRole: resolved.treeRole,
      path: resolved.relativePath,
      bytes: identity.bytes,
      sha256: identity.sha256,
    });
  }
  const builtinSpecs = Object.freeze({
    source: 'gcc-dumpspecs',
    bytes: specsOutput.byteLength,
    sha256: sha256(specsOutput),
  });
  const specsBody = Object.freeze({ builtin: builtinSpecs, externalDefault: externalSpecs });
  const specs = Object.freeze({ ...specsBody, sha256: identitySha256(specsBody) });

  const trees = [];
  for (const definition of treeDefinitions) {
    const identity = await hashDirectoryTree(definition.path, limits, state, treeDefinitions);
    trees.push(Object.freeze({ role: definition.role, path: definition.relativePath, ...identity }));
  }

  helpers.sort((left, right) => compareText(left.role, right.role));
  trees.sort((left, right) => compareText(left.role, right.role));
  const body = Object.freeze({
    schema: 2,
    policy: 'gcc-resolved-bounded-toolchain-closure-v2',
    coverage: Object.freeze({
      helpers: 'gcc-print-prog-name',
      specs: 'gcc-dumpspecs-and-default-specs',
      trees: Object.freeze(['bin', 'lib', 'libexec', 'sysroot']),
      dynamicLibraries: Object.freeze({
        toolchainLocal: 'covered-by-bin-lib-and-libexec-trees',
        hostOperatingSystem: 'bound-by-compiler-runtime-release-and-host-execution-identities',
      }),
    }),
    limits,
    helpers: Object.freeze(helpers),
    runtimeFiles: Object.freeze([Object.freeze({
      role: 'runtime:libgcc',
      treeRole: libgccResolved.treeRole,
      path: libgccResolved.relativePath,
      bytes: libgcc.bytes,
      sha256: libgcc.sha256,
    })]),
    specs,
    trees: Object.freeze(trees),
  });
  return Object.freeze({ ...body, sha256: identitySha256(body) });
}

function normalizeClosureLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('native toolchain closure limits are invalid');
  }
  const limits = {};
  for (const [name, maximum] of Object.entries(NATIVE_TOOLCHAIN_CLOSURE_LIMITS)) {
    const value = overrides[name] ?? maximum;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new RangeError(`native toolchain closure limit is invalid: ${name}`);
    }
    limits[name] = value;
  }
  return Object.freeze(limits);
}

function createClosureProbeState() {
  return {
    fileCache: new Map(),
    treeCache: new Map(),
    totalBytes: 0,
    totalFiles: 0,
    totalEntries: 0,
  };
}

async function requireDirectory(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error(`native toolchain ${label} path is missing or ambiguous`);
  }
  const canonical = await realpath(resolve(path));
  const stat = await lstat(canonical);
  if (!stat.isDirectory()) throw new Error(`native toolchain ${label} is not a directory`);
  return canonical;
}

async function controlledTreeDefinition(role, path, toolchainRoot) {
  const canonical = await requireDirectory(path, role);
  if (!pathWithin(toolchainRoot, canonical) || canonical === toolchainRoot) {
    throw new Error(`native toolchain ${role} escapes its controlled root`);
  }
  return Object.freeze({
    role,
    path: canonical,
    relativePath: posixRelative(toolchainRoot, canonical),
  });
}

async function requireControlledTreeFile(path, trees, role) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error(`native toolchain ${role} path is missing or ambiguous`);
  }
  const canonical = await realpath(resolve(path));
  const owner = trees.find((tree) => pathWithin(tree.path, canonical) && canonical !== tree.path);
  if (!owner) throw new Error(`native toolchain ${role} is outside controlled closure trees`);
  const stat = await lstat(canonical);
  if (!stat.isFile()) throw new Error(`native toolchain ${role} is not a regular file`);
  return Object.freeze({
    path: canonical,
    treeRole: owner.role,
    relativePath: posixRelative(owner.path, canonical),
  });
}

function posixRelative(root, candidate) {
  const value = relative(root, candidate).split(sep).join('/');
  if (!value || value === '.' || value.startsWith('../') || value === '..' || isAbsolute(value)) {
    throw new Error(`native toolchain closure path is outside its tree: ${candidate}`);
  }
  return value;
}

function pathWithin(root, candidate) {
  const remainder = relative(root, candidate);
  return remainder === '' || (
    remainder !== '..'
    && !remainder.startsWith(`..${sep}`)
    && !isAbsolute(remainder)
  );
}

function assertDisjointTreeRoots(definitions, target) {
  const seen = new Set();
  for (const definition of definitions) {
    if (seen.has(definition.path)) {
      throw new Error(`native toolchain closure has duplicate roots: ${target}`);
    }
    seen.add(definition.path);
  }
  for (let left = 0; left < definitions.length; left += 1) {
    for (let right = left + 1; right < definitions.length; right += 1) {
      if (
        pathWithin(definitions[left].path, definitions[right].path)
        || pathWithin(definitions[right].path, definitions[left].path)
      ) throw new Error(`native toolchain closure has overlapping roots: ${target}`);
    }
  }
}

async function queryToolBytes(runQuery, command, arguments_, limits, role) {
  const result = await runQuery(command, arguments_, limits);
  const bytes = Buffer.isBuffer(result)
    ? result
    : typeof result === 'string'
      ? Buffer.from(result)
      : undefined;
  if (!bytes || bytes.byteLength > limits.maxQueryOutputBytes) {
    throw new Error(`native toolchain query returned invalid or excessive output: ${role}`);
  }
  return bytes;
}

async function singleLineToolQuery(runQuery, command, arguments_, limits, role) {
  const bytes = await queryToolBytes(runQuery, command, arguments_, limits, role);
  const text = bytes.toString('utf8').replace(/\r?\n$/, '');
  if (!text || text !== text.trim() || /[\0\r\n]/.test(text)) {
    throw new Error(`native toolchain query returned missing or ambiguous output: ${role}`);
  }
  return text;
}

async function runBoundedToolQuery(command, arguments_, limits, environment) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, arguments_, {
      cwd: dirname(command),
      env: environment ?? createNativeExecutionEnvironment(process.env, {
        toolDirectories: [dirname(command)],
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      rejectOnce(new Error('native toolchain query timed out'));
    }, limits.queryTimeoutMs);
    timeout.unref?.();
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const capture = (chunks, chunk) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > limits.maxQueryOutputBytes) {
        child.kill();
        rejectOnce(new Error('native toolchain query exceeded its output limit'));
        return;
      }
      chunks.push(bytes);
    };
    child.stdout.on('data', (chunk) => capture(stdout, chunk));
    child.stderr.on('data', (chunk) => capture(stderr, chunk));
    child.once('error', rejectOnce);
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const errorBytes = Buffer.concat(stderr);
      if (code !== 0 || signal || errorBytes.byteLength) {
        reject(new Error(`native toolchain query failed: ${summarizeFailure(errorBytes.toString('utf8'))}`));
        return;
      }
      resolveResult(Buffer.concat(stdout));
    });
  });
}

async function hashClosureFile(path, limits, state) {
  const canonical = await realpath(path);
  const before = await lstat(canonical);
  if (!before.isFile()) throw new Error(`native toolchain closure entry is not a regular file: ${path}`);
  if (before.size > limits.maxFileBytes) throw new Error('native toolchain closure exceeded its single-file byte limit');
  const cached = state.fileCache.get(canonical);
  if (cached && cached.size === before.size && cached.mtimeMs === before.mtimeMs) return cached.identity;
  if (state.totalFiles + 1 > limits.maxTotalFiles) {
    throw new Error('native toolchain closure exceeded its total file limit');
  }
  if (state.totalBytes + before.size > limits.maxTotalBytes) {
    throw new Error('native toolchain closure exceeded its total byte limit');
  }
  state.totalFiles += 1;
  state.totalBytes += before.size;
  const hash = createHash('sha256');
  let observed = 0;
  for await (const chunk of createReadStream(canonical, { highWaterMark: 4 * 1024 * 1024 })) {
    observed += chunk.byteLength;
    if (observed > before.size || observed > limits.maxFileBytes) {
      throw new Error('native toolchain closure file changed or exceeded its byte limit while hashing');
    }
    hash.update(chunk);
  }
  const after = await lstat(canonical);
  if (observed !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error('native toolchain closure file changed while hashing');
  }
  const identity = Object.freeze({ bytes: observed, sha256: hash.digest('hex') });
  state.fileCache.set(canonical, { size: before.size, mtimeMs: before.mtimeMs, identity });
  return identity;
}

async function hashDirectoryTree(path, limits, state, controlledTrees) {
  const root = await requireDirectory(path, 'closure tree');
  const cached = state.treeCache.get(root);
  if (cached) return cached;
  const entries = [];
  const files = [];
  let fileCount = 0;
  let totalBytes = 0;
  const walk = async (directory, prefix = '') => {
    const names = await readdir(directory);
    names.sort(compareText);
    for (const name of names) {
      const entryPath = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(entryPath);
      state.totalEntries += 1;
      if (entries.length + 1 > limits.maxTreeEntries || state.totalEntries > limits.maxTotalEntries) {
        throw new Error('native toolchain closure exceeded its directory entry limit');
      }
      if (stat.isDirectory()) {
        entries.push(Object.freeze({ type: 'directory', path: relativePath }));
        await walk(entryPath, relativePath);
      } else if (stat.isFile()) {
        fileCount += 1;
        totalBytes += stat.size;
        if (fileCount > limits.maxTreeFiles) {
          throw new Error('native toolchain closure exceeded its tree file limit');
        }
        if (totalBytes > limits.maxTreeBytes) {
          throw new Error('native toolchain closure exceeded its tree byte limit');
        }
        const index = entries.length;
        entries.push(undefined);
        files.push({ index, entryPath, relativePath, expectedBytes: stat.size });
      } else if (stat.isSymbolicLink()) {
        await readlink(entryPath);
        const target = await realpath(entryPath);
        const owner = controlledTrees.find((tree) => pathWithin(tree.path, target));
        if (!owner) throw new Error('native toolchain closure symlink escapes its controlled trees');
        const targetPath = relative(owner.path, target).split(sep).join('/');
        entries.push(Object.freeze({
          type: 'symlink',
          path: relativePath,
          target: targetPath ? `${owner.role}/${targetPath}` : owner.role,
        }));
      } else {
        throw new Error('native toolchain closure contains an unsupported filesystem entry');
      }
    }
  };
  await walk(root);
  await mapWithConcurrency(files, limits.hashConcurrency, async (file) => {
    const identity = await hashClosureFile(file.entryPath, limits, state);
    if (identity.bytes !== file.expectedBytes) {
      throw new Error('native toolchain closure file changed after directory enumeration');
    }
    entries[file.index] = Object.freeze({
      type: 'file',
      path: file.relativePath,
      bytes: identity.bytes,
      sha256: identity.sha256,
    });
  });
  const body = Object.freeze({ schema: 1, entries: Object.freeze(entries) });
  const identity = Object.freeze({
    schema: 1,
    entryCount: entries.length,
    fileCount,
    bytes: totalBytes,
    sha256: identitySha256(body),
  });
  state.treeCache.set(root, identity);
  return identity;
}

async function mapWithConcurrency(values, concurrency, callback) {
  let cursor = 0;
  let failure;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failure) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        await callback(values[index], index);
      } catch (error) {
        failure = error;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function verificationFingerprint(registryBytes, fixtureBytes, contexts, evidence) {
  const entries = [
    { id: 'inputs/registry.json', bytes: registryBytes },
    { id: 'inputs/fixture-manifest.json', bytes: fixtureBytes },
    { id: 'inputs/execution-evidence.json', bytes: Buffer.from(JSON.stringify(evidence)) },
  ];
  for (const [id, path] of [
    ['scripts/verify-ck-native-library-matrix.mjs', RUNNER],
    ['scripts/verify-ck-native-library-pack.ts', NATIVE_VERIFIER],
    ['scripts/verify-ck-browser-library-matrix.mjs', resolve(ROOT, 'scripts/verify-ck-browser-library-matrix.mjs')],
    ['scripts/ck-browser-library-request.mjs', resolve(ROOT, 'scripts/ck-browser-library-request.mjs')],
    ['packages/web/public/avr/v3/toolchain-pack.js', resolve(ROOT, 'packages/web/public/avr/v3/toolchain-pack.js')],
    ['packages/web/public/avr/v3/preprocess.js', resolve(ROOT, 'packages/web/public/avr/v3/preprocess.js')],
    ['packages/web/public/esp32/v1/library-registry.js', resolve(ROOT, 'packages/web/public/esp32/v1/library-registry.js')],
    ['packages/web/public/esp32/v1/c3-runtime.js', resolve(ROOT, 'packages/web/public/esp32/v1/c3-runtime.js')],
    ['packages/web/public/ck-build-ir-envelope.js', resolve(ROOT, 'packages/web/public/ck-build-ir-envelope.js')],
    ['packages/web/public/ck-rust-build-core.js', resolve(ROOT, 'packages/web/public/ck-rust-build-core.js')],
    ['packages/web/public/ck-project-resolver.js', resolve(ROOT, 'packages/web/public/ck-project-resolver.js')],
    ['packages/web/public/esp32/v2/c3-compiler.js', resolve(ROOT, 'packages/web/public/esp32/v2/c3-compiler.js')],
    ['packages/web/public/esp32/v2/ck-pack-provider.js', resolve(ROOT, 'packages/web/public/esp32/v2/ck-pack-provider.js')],
    ['packages/web/public/esp32/v2/image-builder.js', resolve(ROOT, 'packages/web/public/esp32/v2/image-builder.js')],
    ['packages/core/src/executor/native.ts', resolve(ROOT, 'packages/core/src/executor/native.ts')],
    ['packages/core/src/executor/native-packs.ts', resolve(ROOT, 'packages/core/src/executor/native-packs.ts')],
    ['packages/core/src/sandbox/local.ts', resolve(ROOT, 'packages/core/src/sandbox/local.ts')],
    ['packages/core/src/toolchain/config.ts', resolve(ROOT, 'packages/core/src/toolchain/config.ts')],
  ]) entries.push({ id, bytes: await readFile(path) });
  for (const context of [...contexts.values()].sort((left, right) => left.target.localeCompare(right.target))) {
    entries.push({ id: `targets/${context.target}/descriptor.json`, bytes: context.descriptorBytes });
    for (const pack of context.manifests) {
      entries.push({ id: `targets/${context.target}/packs/${pack.role}/manifest.json`, bytes: pack.bytes });
    }
  }
  return hashFingerprintEntries(entries, `ck-native-library-matrix-v${VERIFICATION_SCHEMA}`);
}

export function nativeLibraryMatrixJobFingerprint(globalFingerprint, job, libraryPackClosureSha256) {
  if (!/^[a-f0-9]{64}$/.test(globalFingerprint)) {
    throw new TypeError('native Matrix global fingerprint must be a SHA-256 digest');
  }
  if (!/^[a-f0-9]{64}$/.test(libraryPackClosureSha256)) {
    throw new TypeError('native Matrix Library Pack closure fingerprint must be a SHA-256 digest');
  }
  return sha256(Buffer.from([
    globalFingerprint,
    matrixJobKey(job),
    job.packId,
    job.packRevision,
    libraryPackClosureSha256,
    JSON.stringify(job.fixture),
  ].join('\0')));
}

export function createNativeVerifierRequest(job, options) {
  const snapshot = options?.libraryPackSnapshot;
  if (
    !snapshot
    || typeof snapshot.root !== 'string'
    || !isAbsolute(snapshot.root)
    || typeof snapshot.descriptor !== 'string'
    || !isAbsolute(snapshot.descriptor)
    || !/^[a-f0-9]{64}$/.test(snapshot.closureSha256)
  ) throw new Error(`native Library Pack snapshot is missing for ${matrixJobKey(job)}`);
  const expectedRoot = Object.freeze({
    library: job.library,
    version: job.version,
    packId: job.packId,
    revision: job.packRevision,
    artifact: snapshot.rootIdentity?.artifact,
  });
  if (
    typeof expectedRoot.library !== 'string'
    || typeof expectedRoot.version !== 'string'
    || typeof expectedRoot.packId !== 'string'
    || !/^[a-f0-9]{64}$/.test(expectedRoot.revision)
    || typeof expectedRoot.artifact !== 'string'
    || canonicalJson(expectedRoot) !== canonicalJson(snapshot.rootIdentity)
  ) throw new Error(`native Library Pack snapshot root identity mismatch for ${matrixJobKey(job)}`);
  const fixture = createVerifierRequest(job, {
    ...options,
    registry: options?.registry ?? 'snapshot-registry.json',
  });
  return Object.freeze({
    schema: NATIVE_LIBRARY_REQUEST_SCHEMA,
    snapshot: Object.freeze({
      root: snapshot.root,
      descriptor: snapshot.descriptor,
      closureSha256: snapshot.closureSha256,
    }),
    expectedRoot,
    header: fixture.header,
    target: fixture.target,
    projectFiles: fixture.projectFiles,
    macros: fixture.macros,
    ...(fixture.onlyAction === undefined ? {} : { onlyAction: fixture.onlyAction }),
    traceCompiler: fixture.traceCompiler,
  });
}

export function nativeVerifierArguments(requestPath) {
  return [NATIVE_VERIFIER, '--request-file', requestPath];
}

async function writeNativeVerifierRequest(job, options) {
  const temporaryRoot = resolve(ROOT, 'var/tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'ck-native-library-matrix-'));
  try {
    const path = join(directory, 'request.json');
    const value = createNativeVerifierRequest(job, options);
    await writeFile(path, `${canonicalJson(value)}\n`, { encoding: 'utf8', mode: 0o400 });
    await chmod(path, 0o400).catch(() => {});
    return Object.freeze({ directory, path, value });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function runNativeVerifier(job, options) {
  if (
    options?.compilerRuntime?.trust !== 'accepted'
    || !SHA256_ID.test(options.compilerRuntime.runtimeIdentity)
    || !SHA256_ID.test(options.compilerRuntime.hostExecution?.runtimeIdentity)
  ) throw new Error('native verifier execution requires accepted SHA-256 runtime identities');
  const request = await writeNativeVerifierRequest(job, options);
  try {
    return await new Promise((resolveResult, reject) => {
      const targetIdentity = options.nativeExecutionIdentity?.targets
        ?.find((candidate) => candidate.target === job.target);
      if (!targetIdentity || !/^[a-f0-9]{64}$/.test(targetIdentity.sha256)) {
        reject(new Error(`native execution identity is missing for ${job.target}`));
        return;
      }
      if (targetIdentity.hostPlatform !== process.platform) {
        reject(new Error(`native execution identity host platform changed for ${job.target}`));
        return;
      }
      const environment = {
        ...createNativeExecutionEnvironment(process.env, {
          toolDirectories: targetIdentity.pathDirectories ?? [],
        }),
      };
      environment[NATIVE_TOOL_IDENTITY_ENV] = targetIdentity.sha256;
      environment[NATIVE_LIBRARY_CLOSURE_ENV] = request.value.snapshot.closureSha256;
      environment[NATIVE_LIBRARY_SNAPSHOT_ROOT_ENV] = request.value.snapshot.root;
      if (targetIdentity.pythonInterpreter !== undefined) {
        if (
          typeof targetIdentity.pythonInterpreter.command !== 'string'
          || !isAbsolute(targetIdentity.pythonInterpreter.command)
          || targetIdentity.hostPlatform === 'win32'
        ) {
          reject(new Error(`native execution identity Python binding is invalid for ${job.target}`));
          return;
        }
        environment[NATIVE_PYTHON_ENV] = targetIdentity.pythonInterpreter.command;
      } else if (targetIdentity.hostPlatform !== 'win32') {
        reject(new Error(`native execution identity Python binding is missing for ${job.target}`));
        return;
      }
      const child = spawn(process.execPath, ['--import', 'tsx', ...nativeVerifierArguments(request.path)], {
        cwd: ROOT,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      options.activeChildren?.add(child);
      let tail = '';
      let outputBytes = 0;
      const outputHash = createHash('sha256');
      let settled = false;
      const termination = createChildTerminationController(child, {
        graceMs: options.terminationGraceMs,
      });
      const capture = (chunk, stream) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += bytes.byteLength;
        outputHash.update(bytes);
        tail = appendTail(tail, bytes.toString('utf8'), 64 * 1024);
        if (options.verbose) stream.write(bytes);
      };
      child.stdout.on('data', (chunk) => capture(chunk, process.stdout));
      child.stderr.on('data', (chunk) => capture(chunk, process.stderr));
      const timeout = setTimeout(() => termination.timeout(), options.timeoutMs);
      timeout.unref?.();
      const abort = () => termination.abort();
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => {
        clearTimeout(timeout);
        termination.close();
        options.signal?.removeEventListener('abort', abort);
        options.activeChildren?.delete(child);
      };
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        let exitCode = termination.timedOut || termination.aborted || signal ? 1 : (code ?? 1);
        let internal = false;
        let resultBinding;
        if (!termination.timedOut && !termination.aborted && !signal) {
          try {
            resultBinding = parseNativeLibraryResultBinding(tail);
            if (
              resultBinding.closureSha256 !== request.value.snapshot.closureSha256
              || resultBinding.rootIdentitySha256 !== identitySha256(request.value.expectedRoot)
            ) throw new Error('native Library Pack verifier result identity mismatch');
          } catch (error) {
            internal = true;
            exitCode = 1;
            tail = appendTail(
              tail,
              `\n${error instanceof Error ? error.message : String(error)}\n`,
              64 * 1024,
            );
          }
        }
        resolveResult(Object.freeze({
          exitCode,
          signal,
          timedOut: termination.timedOut,
          aborted: termination.aborted,
          outputBytes,
          outputSha256: outputHash.digest('hex'),
          outputTail: tail,
          ...(internal ? { internal: true } : {}),
          ...(resultBinding ? {
            libraryPackClosureSha256: resultBinding.closureSha256,
            libraryPackRootIdentitySha256: resultBinding.rootIdentitySha256,
          } : {}),
        }));
      });
    });
  } finally {
    await rm(request.directory, { recursive: true, force: true }).catch(() => {});
  }
}

function parseNativeLibraryResultBinding(output) {
  const lines = String(output).split(/\r?\n/)
    .filter((line) => line.startsWith(NATIVE_LIBRARY_RESULT_PREFIX));
  if (lines.length !== 1) throw new Error('native Library Pack verifier result binding is missing or ambiguous');
  let value;
  try {
    value = JSON.parse(lines[0].slice(NATIVE_LIBRARY_RESULT_PREFIX.length));
  } catch {
    throw new Error('native Library Pack verifier result binding is invalid JSON');
  }
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'closureSha256,rootIdentitySha256,schema'
    || value.schema !== 1
    || !/^[a-f0-9]{64}$/.test(value.closureSha256)
    || !/^[a-f0-9]{64}$/.test(value.rootIdentitySha256)
  ) throw new Error('native Library Pack verifier result binding has an invalid schema');
  return value;
}

function resultEvidence(job, evidence, libraryPackClosureSha256) {
  const nativeTarget = evidence.nativeTools.targets.find((target) => target.target === job.target);
  const packTarget = evidence.targetPacks.targets.find((target) => target.target === job.target);
  if (!nativeTarget || !packTarget) throw new Error(`result evidence is missing for ${job.target}`);
  return Object.freeze({
    plannerArtifactSetSha256: evidence.planner.artifactSetSha256,
    compilerRuntimeIdentity: evidence.compilerRuntime.runtimeIdentity,
    compilerRuntimeEvidenceSha256: evidence.compilerRuntime.sha256,
    nativeToolIdentitySha256: nativeTarget.sha256,
    targetPackIdentitySha256: identitySha256(packTarget),
    libraryPackClosureSha256,
  });
}

function reportResult(job, fingerprint, verification, evidence, libraryPackClosureSha256) {
  const succeeded = verification.exitCode === 0;
  return Object.freeze({
    key: matrixJobKey(job),
    jobFingerprint: fingerprint,
    library: job.library,
    version: job.version,
    target: job.target,
    board: job.board,
    header: job.header,
    packId: job.packId,
    packRevision: job.packRevision,
    platformVersion: job.platformVersion,
    executor: 'native',
    evidence: resultEvidence(job, evidence, libraryPackClosureSha256),
    status: succeeded ? 'success' : 'failed',
    elapsedMs: verification.elapsedMs,
    exitCode: verification.exitCode,
    outputBytes: verification.outputBytes,
    outputSha256: verification.outputSha256,
    ...(succeeded ? {} : {
      failureClass: classifyMatrixFailure(verification.outputTail, verification),
      failureOutput: summarizeFailure(verification.outputTail),
      ...(verification.signal ? { signal: verification.signal } : {}),
    }),
  });
}

function policyResult(job, fingerprint, evidence, libraryPackClosureSha256) {
  return Object.freeze({
    key: matrixJobKey(job),
    jobFingerprint: fingerprint,
    library: job.library,
    version: job.version,
    target: job.target,
    board: job.board,
    header: job.header,
    packId: job.packId,
    packRevision: job.packRevision,
    platformVersion: job.platformVersion,
    executor: 'native',
    evidence: resultEvidence(job, evidence, libraryPackClosureSha256),
    ...job.policy,
  });
}

function summarizeFailure(output) {
  const lines = String(output ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-10).join('\n').slice(-4096) || undefined;
}

async function saveReport(path, report) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function selectReusableNativeResults(previous, context) {
  if (
    !previous
    || previous.schema !== REPORT_SCHEMA
    || previous.verificationSchema !== VERIFICATION_SCHEMA
    || previous.fingerprintScope !== 'execution'
    || context.fingerprintScope !== 'execution'
    || previous.fingerprint !== context.fingerprint
    || previous.evidence?.sha256 !== context.evidence.sha256
    || previous.evidence?.planner?.artifactSetSha256 !== context.evidence.planner.artifactSetSha256
    || previous.compilerRuntime?.sha256 !== context.compilerRuntime?.sha256
    || previous.evidence?.compilerRuntime?.sha256 !== context.evidence.compilerRuntime?.sha256
    || previous.evidence?.targetPacks?.sha256 !== context.evidence.targetPacks.sha256
    || previous.evidence?.nativeTools?.sha256 !== context.evidence.nativeTools.sha256
    || previous.libraryPacks?.schema !== LIBRARY_PACK_FINGERPRINT_SCHEMA
    || previous.libraryPacks?.status !== 'verified'
    || context.libraryPacks?.evidence?.status !== 'verified'
    || previous.integrity?.stable !== true
    || previous.integrity?.startFingerprint !== context.fingerprint
    || previous.integrity?.endFingerprint !== context.fingerprint
    || previous.integrity?.startLibraryPackSetSha256 !== previous.libraryPacks.sha256
    || previous.integrity?.endLibraryPackSetSha256 !== previous.libraryPacks.sha256
    || !Array.isArray(previous.results)
  ) return [];
  return previous.results;
}

async function main() {
  const options = nativeMatrixOptions(process.argv.slice(2));
  if (options.help) {
    console.log([
      'Usage: npm run verify:ck-native-library-matrix -- [options]',
      '  --plan                         print the deterministic native plan',
      '  --target all|esp32,s2,s3,c3,c6 select targets (default: all)',
      '  --library <exact name>         select a Registry library (repeatable)',
      '  --version <exact version>      select a Registry version (repeatable)',
      '  --headers primary|all          verify one primary or every public header',
      '  --shard INDEX/TOTAL            run one deterministic shard',
      '  --max-jobs <count>             cap jobs; useful for low-disk smoke runs',
      '  --concurrency <1..4>           native verifier concurrency (default: 1)',
      '  --no-resume                    do not reuse successful report entries',
      '  --force-unlock                 reclaim a stale report lock',
      '  --ignore-policy                execute policy-classified jobs too',
      '  --report <path>                native report path',
      '  --runtime-release-manifest <path> bind accepted compiler OCI runtime release identity',
    ].join('\n'));
    return;
  }
  const context = await createNativeMatrixPlan(options, { requireNativeTools: !options.plan });
  const {
    plan,
    fingerprint,
    fingerprintScope,
    evidence,
    compilerRuntime,
    libraryPacks,
    nativeExecutionAuthorization,
    registryBytes,
    fixtureBytes,
    registryStats,
  } = context;
  const planSummary = {
    status: 'planned',
    executor: 'native',
    fingerprint,
    fingerprintScope,
    evidence,
    compilerRuntime,
    libraryPacks: libraryPacks.evidence,
    registry: registryStats,
    headers: options.headers,
    targets: options.targets,
    filters: { libraries: options.libraries, versions: options.versions },
    shard: options.shard,
    unshardedJobs: plan.unsharded,
    selectedJobs: plan.jobs.length,
    executableJobs: plan.jobs.filter((job) => !job.policy).length,
    classifiedJobs: plan.jobs.filter((job) => job.policy).length,
    estimatedSerialMinutesAt30SecondsPerJob: Math.ceil(plan.jobs.filter((job) => !job.policy).length * 30 / 60),
  };
  if (options.plan) {
    console.log(JSON.stringify(planSummary, null, 2));
    return;
  }

  const reportLock = await acquireReportLock(options.report, { forceUnlock: options.forceUnlock });
  try {
    const previous = options.resume ? await readOptionalJson(options.report) : undefined;
    const previousResults = selectReusableNativeResults(previous, context);
    const resultsByKey = new Map(previousResults.map((result) => [result.key ?? matrixJobKey(result), result]));
    const reusable = new Map(previousResults
      .filter((result) => REUSABLE_STATUSES.has(result.status))
      .map((result) => [result.key ?? matrixJobKey(result), result]));
    const selectedKeys = new Set(plan.jobs.map(matrixJobKey));
    const report = {
      schema: REPORT_SCHEMA,
      verificationSchema: VERIFICATION_SCHEMA,
      scope: 'native-library-compile',
      compatibilityClaim: 'same-ck-build-ir-and-library-pack-with-evidenced-host-native-tool-substitution',
      fingerprint,
      fingerprintScope,
      evidence,
      compilerRuntime,
      libraryPacks: libraryPacks.evidence,
      generatedAt: new Date().toISOString(),
      executor: 'native',
      registry: { path: options.registry, sha256: sha256(registryBytes), ...registryStats },
      fixtureManifest: { path: options.fixtures, sha256: sha256(fixtureBytes) },
      configuration: {
        headers: options.headers,
        targets: options.targets,
        shard: options.shard,
        concurrency: options.concurrency,
        timeoutMs: options.timeoutMs,
        maxJobs: options.maxJobs,
        libraries: options.libraries,
        versions: options.versions,
        ignorePolicy: options.ignorePolicy,
      },
      results: [...resultsByKey.values()],
    };
    let saveChain = Promise.resolve();
    const persist = () => {
      report.generatedAt = new Date().toISOString();
      report.results = [...resultsByKey.values()].sort((left, right) => (
        (left.key ?? matrixJobKey(left)).localeCompare(right.key ?? matrixJobKey(right))
      ));
      const selected = report.results.filter((result) => selectedKeys.has(result.key ?? matrixJobKey(result)));
      report.scopeSummary = summarizeMatrixResults(selected, plan.jobs.length);
      saveChain = saveChain.then(() => saveReport(options.report, report));
      return saveChain;
    };
    let cursor = 0;
    let stopped = false;
    const abortController = new AbortController();
    const activeChildren = new Set();
    const executionOptions = {
      ...options,
      signal: abortController.signal,
      activeChildren,
      nativeExecutionIdentity: nativeExecutionAuthorization,
      compilerRuntime,
    };
    const libraryPackJobs = new Map(libraryPacks.jobs.map((job) => [job.key, job]));
    async function worker() {
      while (!stopped) {
        const index = cursor++;
        if (index >= plan.jobs.length) return;
        const job = plan.jobs[index];
        const key = matrixJobKey(job);
        const libraryPackClosure = libraryPackJobs.get(key);
        if (!libraryPackClosure || !/^[a-f0-9]{64}$/.test(libraryPackClosure.sha256)) {
          throw new Error(`native Library Pack closure fingerprint is missing for ${key}`);
        }
        const libraryPackSnapshot = libraryPacks.snapshots?.get(libraryPackClosure.sha256);
        if (!libraryPackSnapshot) {
          throw new Error(`native Library Pack immutable snapshot is missing for ${key}`);
        }
        const fingerprintForJob = nativeLibraryMatrixJobFingerprint(
          fingerprint,
          job,
          libraryPackClosure.sha256,
        );
        if (job.policy) {
          const result = policyResult(job, fingerprintForJob, evidence, libraryPackClosure.sha256);
          resultsByKey.set(key, result);
          console.log(`[${index + 1}/${plan.jobs.length}] ${key}: ${result.status}`);
          await persist();
          continue;
        }
        const cached = reusable.get(key);
        if (cached?.jobFingerprint === fingerprintForJob) {
          resultsByKey.set(key, { ...cached, resumed: true });
          console.log(`[${index + 1}/${plan.jobs.length}] ${key}: resume ${cached.status}`);
          continue;
        }
        console.log(`[${index + 1}/${plan.jobs.length}] ${key}: start`);
        const started = Date.now();
        let verification;
        try {
          verification = await runNativeVerifier(job, {
            ...executionOptions,
            libraryPackSnapshot,
          });
        } catch (error) {
          const output = error instanceof Error ? error.stack ?? error.message : String(error);
          verification = {
            exitCode: 1,
            signal: undefined,
            timedOut: false,
            outputBytes: Buffer.byteLength(output),
            outputSha256: sha256(Buffer.from(output)),
            outputTail: output,
            internal: true,
          };
        }
        verification = { ...verification, elapsedMs: Date.now() - started };
        const result = reportResult(
          job,
          fingerprintForJob,
          verification,
          evidence,
          libraryPackClosure.sha256,
        );
        resultsByKey.set(key, result);
        await persist();
        console.log(`[${index + 1}/${plan.jobs.length}] ${key}: ${result.status} (${result.elapsedMs} ms)`);
        if (result.status === 'failed' && options.failFast) {
          stopped = true;
          abortController.abort();
        }
      }
    }
    const workers = Array.from({ length: Math.min(options.concurrency, plan.jobs.length) }, () => worker());
    try {
      await Promise.all(workers);
    } catch (error) {
      stopped = true;
      abortController.abort();
      await Promise.allSettled(workers);
      throw error;
    }
    const finalContext = await createNativeMatrixPlan(options, { requireNativeTools: true });
    const libraryPacksStable = finalContext.libraryPacks.evidence.sha256 === libraryPacks.evidence.sha256;
    report.integrity = {
      startFingerprint: fingerprint,
      endFingerprint: finalContext.fingerprint,
      startLibraryPackSetSha256: libraryPacks.evidence.sha256,
      endLibraryPackSetSha256: finalContext.libraryPacks.evidence.sha256,
      stable: finalContext.fingerprint === fingerprint && libraryPacksStable,
    };
    await persist();
    await saveChain;
    const selected = report.results.filter((result) => selectedKeys.has(result.key ?? matrixJobKey(result)));
    const summary = summarizeMatrixResults(selected, plan.jobs.length);
    const failures = selected.filter((result) => result.status === 'failed');
    console.log(JSON.stringify({
      status: failures.length || summary.pending || !report.integrity.stable ? 'failed' : 'success',
      report: options.report,
      fingerprint,
      summary,
    }, null, 2));
    if (failures.length || summary.pending || !report.integrity.stable) process.exitCode = 1;
  } finally {
    await reportLock.release();
  }
}

function appendTail(previous, next, maximum) {
  const joined = previous + next;
  return joined.length <= maximum ? joined : joined.slice(joined.length - maximum);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function identitySha256(value) {
  return sha256(Buffer.from(canonicalJson(value)));
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('identity JSON cannot contain a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') {
    throw new TypeError(`identity JSON cannot contain ${typeof value}`);
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

if (process.argv[1] && resolve(process.argv[1]) === RUNNER) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
