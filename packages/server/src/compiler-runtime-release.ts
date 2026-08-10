import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  UNVERIFIED_COMPILE_RELEASE_ID,
  isCompileReleaseId,
} from './compile-namespace.js';
import { WORKER_POOLS, type WorkerPool } from './worker-pools.js';

export const COMPILER_RUNTIME_RELEASE_SCHEMA = 1 as const;
export const COMPILER_RUNTIME_RELEASE_KIND = 'sketchforge-compiler-runtime-release';
export const UNVERIFIED_HOST_RUNTIME_IDENTITY = 'unverified-local';

const MAX_RELEASE_BYTES = 64 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const OCI_COMPONENT = '[a-z0-9]+(?:[._-][a-z0-9]+)*';
const OCI_REPOSITORY = new RegExp(
  `^(?:${OCI_COMPONENT}(?::[0-9]{1,5})?/)?(?:${OCI_COMPONENT}/)*${OCI_COMPONENT}$`,
);

export interface CompilerRuntimeShard {
  readonly schema: 1;
  readonly pool: WorkerPool;
  readonly platform: 'linux/amd64';
  readonly imageRepository: string;
  readonly imageDigest: string;
}

export interface CompilerHostRuntime {
  readonly pool: WorkerPool;
  readonly mode: 'oci-image';
  readonly platform: 'linux/amd64';
  readonly imageRepository: string;
  readonly imageDigest: string;
  readonly hostRuntimeIdentity: string;
}

export interface CompilerRuntimeRelease {
  readonly schema: 1;
  readonly kind: typeof COMPILER_RUNTIME_RELEASE_KIND;
  readonly trust: 'accepted';
  readonly compilerBundleId: string;
  readonly runtimes: readonly CompilerHostRuntime[];
  readonly releaseId: string;
}

export interface CompilerRuntimeConfiguration {
  readonly trust: 'accepted' | 'unverified-local';
  readonly compilerBundleId: string;
  readonly releaseId: string;
  readonly runtimes: Readonly<Record<WorkerPool, {
    readonly hostRuntimeIdentity: string;
    readonly imageReference: string | null;
  }>>;
  readonly manifest: CompilerRuntimeRelease | null;
}

export interface CompilerRuntimeEvidence {
  readonly compileReleaseId: string;
  readonly pool: WorkerPool;
  readonly hostRuntimeIdentity: string;
  readonly imageDigest: string;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validBundleId(value: unknown): value is string {
  return typeof value === 'string' && BUNDLE_ID.test(value);
}

function validRepository(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 512
    && OCI_REPOSITORY.test(value)
    && !value.includes('@');
}

function canonicalHostIdentityPayload(runtime: Omit<CompilerHostRuntime, 'hostRuntimeIdentity' | 'imageRepository'>) {
  return {
    schema: COMPILER_RUNTIME_RELEASE_SCHEMA,
    kind: 'sketchforge-host-runtime',
    mode: runtime.mode,
    pool: runtime.pool,
    platform: runtime.platform,
    imageDigest: runtime.imageDigest,
  };
}

export function compilerHostRuntimeIdentity(
  runtime: Omit<CompilerHostRuntime, 'hostRuntimeIdentity' | 'imageRepository'>,
): string {
  return sha256(JSON.stringify(canonicalHostIdentityPayload(runtime)));
}

function canonicalReleasePayload(
  compilerBundleId: string,
  runtimes: readonly CompilerHostRuntime[],
) {
  return {
    schema: COMPILER_RUNTIME_RELEASE_SCHEMA,
    kind: COMPILER_RUNTIME_RELEASE_KIND,
    trust: 'accepted' as const,
    compilerBundleId,
    runtimes: runtimes.map((runtime) => ({
      pool: runtime.pool,
      mode: runtime.mode,
      platform: runtime.platform,
      imageRepository: runtime.imageRepository,
      imageDigest: runtime.imageDigest,
      hostRuntimeIdentity: runtime.hostRuntimeIdentity,
    })),
  } as const;
}

function freezeRuntime(runtime: CompilerHostRuntime): CompilerHostRuntime {
  return Object.freeze({ ...runtime });
}

function parseHostRuntime(value: unknown): CompilerHostRuntime {
  if (!object(value) || !exactKeys(value, [
    'pool',
    'mode',
    'platform',
    'imageRepository',
    'imageDigest',
    'hostRuntimeIdentity',
  ])) {
    throw new Error('compiler runtime entry must use the exact schema');
  }
  if (!WORKER_POOLS.includes(value.pool as WorkerPool)) {
    throw new Error('compiler runtime entry has an invalid worker pool');
  }
  if (value.mode !== 'oci-image' || value.platform !== 'linux/amd64') {
    throw new Error('compiler runtime entry must identify a linux/amd64 OCI image');
  }
  if (!validRepository(value.imageRepository)) {
    throw new Error('compiler runtime entry has an invalid OCI repository');
  }
  if (typeof value.imageDigest !== 'string' || !SHA256.test(value.imageDigest)) {
    throw new Error('compiler runtime entry has an invalid OCI digest');
  }
  const runtime = {
    pool: value.pool as WorkerPool,
    mode: value.mode,
    platform: value.platform,
    imageRepository: value.imageRepository,
    imageDigest: value.imageDigest,
    hostRuntimeIdentity: String(value.hostRuntimeIdentity),
  } satisfies CompilerHostRuntime;
  const expectedIdentity = compilerHostRuntimeIdentity(runtime);
  if (runtime.hostRuntimeIdentity !== expectedIdentity) {
    throw new Error(`compiler runtime identity mismatch for pool ${runtime.pool}`);
  }
  return freezeRuntime(runtime);
}

export function parseCompilerRuntimeShard(value: unknown): CompilerRuntimeShard {
  if (!object(value) || !exactKeys(value, [
    'schema',
    'pool',
    'platform',
    'imageRepository',
    'imageDigest',
  ])) {
    throw new Error('compiler runtime shard must use the exact schema');
  }
  if (value.schema !== COMPILER_RUNTIME_RELEASE_SCHEMA) {
    throw new Error('unsupported compiler runtime shard schema');
  }
  if (!WORKER_POOLS.includes(value.pool as WorkerPool)) {
    throw new Error('compiler runtime shard has an invalid worker pool');
  }
  if (value.platform !== 'linux/amd64') {
    throw new Error('compiler runtime shard must target linux/amd64');
  }
  if (!validRepository(value.imageRepository)) {
    throw new Error('compiler runtime shard has an invalid OCI repository');
  }
  if (typeof value.imageDigest !== 'string' || !SHA256.test(value.imageDigest)) {
    throw new Error('compiler runtime shard has an invalid OCI digest');
  }
  return Object.freeze({
    schema: COMPILER_RUNTIME_RELEASE_SCHEMA,
    pool: value.pool as WorkerPool,
    platform: value.platform,
    imageRepository: value.imageRepository,
    imageDigest: value.imageDigest,
  });
}

export function createCompilerRuntimeRelease(
  compilerBundleId: string,
  shards: readonly CompilerRuntimeShard[],
): CompilerRuntimeRelease {
  if (!validBundleId(compilerBundleId)) throw new Error('invalid compiler bundle id');
  if (shards.length !== WORKER_POOLS.length) {
    throw new Error(`compiler runtime release requires exactly ${WORKER_POOLS.length} worker pools`);
  }
  const byPool = new Map<WorkerPool, CompilerRuntimeShard>();
  for (const rawShard of shards) {
    const shard = parseCompilerRuntimeShard(rawShard);
    if (byPool.has(shard.pool)) throw new Error(`duplicate compiler runtime pool: ${shard.pool}`);
    byPool.set(shard.pool, shard);
  }
  const runtimes = WORKER_POOLS.map((pool) => {
    const shard = byPool.get(pool);
    if (!shard) throw new Error(`missing compiler runtime pool: ${pool}`);
    const base = {
      pool,
      mode: 'oci-image' as const,
      platform: shard.platform,
      imageRepository: shard.imageRepository,
      imageDigest: shard.imageDigest,
    };
    return freezeRuntime({
      ...base,
      hostRuntimeIdentity: compilerHostRuntimeIdentity(base),
    });
  });
  const payload = canonicalReleasePayload(compilerBundleId, runtimes);
  return Object.freeze({
    ...payload,
    runtimes: Object.freeze(runtimes),
    releaseId: sha256(JSON.stringify(payload)),
  });
}

export function parseCompilerRuntimeRelease(value: unknown): CompilerRuntimeRelease {
  if (!object(value) || !exactKeys(value, [
    'schema',
    'kind',
    'trust',
    'compilerBundleId',
    'runtimes',
    'releaseId',
  ])) {
    throw new Error('compiler runtime release must use the exact schema');
  }
  if (value.schema !== COMPILER_RUNTIME_RELEASE_SCHEMA
    || value.kind !== COMPILER_RUNTIME_RELEASE_KIND
    || value.trust !== 'accepted') {
    throw new Error('unsupported compiler runtime release schema');
  }
  if (!validBundleId(value.compilerBundleId)) throw new Error('invalid compiler bundle id');
  if (!Array.isArray(value.runtimes) || value.runtimes.length !== WORKER_POOLS.length) {
    throw new Error(`compiler runtime release requires exactly ${WORKER_POOLS.length} worker pools`);
  }
  const parsed = value.runtimes.map(parseHostRuntime);
  const byPool = new Map(parsed.map((runtime) => [runtime.pool, runtime]));
  if (byPool.size !== WORKER_POOLS.length) throw new Error('compiler runtime release has duplicate pools');
  const runtimes = WORKER_POOLS.map((pool) => {
    const runtime = byPool.get(pool);
    if (!runtime) throw new Error(`missing compiler runtime pool: ${pool}`);
    return runtime;
  });
  const payload = canonicalReleasePayload(value.compilerBundleId, runtimes);
  const expectedReleaseId = sha256(JSON.stringify(payload));
  if (value.releaseId !== expectedReleaseId) throw new Error('compiler runtime release id mismatch');
  return Object.freeze({
    ...payload,
    runtimes: Object.freeze(runtimes),
    releaseId: expectedReleaseId,
  });
}

export function canonicalCompilerRuntimeReleaseJson(release: CompilerRuntimeRelease): string {
  const parsed = parseCompilerRuntimeRelease(release);
  return `${JSON.stringify({
    ...canonicalReleasePayload(parsed.compilerBundleId, parsed.runtimes),
    releaseId: parsed.releaseId,
  }, null, 2)}\n`;
}

export function parseCompilerRuntimeReleaseJson(source: string): CompilerRuntimeRelease {
  if (Buffer.byteLength(source, 'utf8') > MAX_RELEASE_BYTES) {
    throw new Error('compiler runtime release exceeds the maximum size');
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error('compiler runtime release is not valid JSON');
  }
  const release = parseCompilerRuntimeRelease(value);
  if (source !== canonicalCompilerRuntimeReleaseJson(release)) {
    throw new Error('compiler runtime release JSON is not canonical');
  }
  return release;
}

export function readCompilerRuntimeRelease(path: string): CompilerRuntimeRelease {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('compiler runtime release path must be a regular non-symlink file');
  }
  if (stat.size > MAX_RELEASE_BYTES) throw new Error('compiler runtime release exceeds the maximum size');
  return parseCompilerRuntimeReleaseJson(readFileSync(absolute, 'utf8'));
}

export function compilerRuntimeConfigurationFromRelease(
  release: CompilerRuntimeRelease,
): CompilerRuntimeConfiguration {
  const entries = release.runtimes.map((runtime) => [runtime.pool, Object.freeze({
    hostRuntimeIdentity: runtime.hostRuntimeIdentity,
    imageReference: `${runtime.imageRepository}@${runtime.imageDigest}`,
  })] as const);
  return Object.freeze({
    trust: 'accepted',
    compilerBundleId: release.compilerBundleId,
    releaseId: release.releaseId,
    runtimes: Object.freeze(Object.fromEntries(entries)) as CompilerRuntimeConfiguration['runtimes'],
    manifest: release,
  });
}

export function createUnverifiedLocalRuntimeConfiguration(
  compilerBundleId: string,
): CompilerRuntimeConfiguration {
  if (!validBundleId(compilerBundleId)) throw new Error('invalid compiler bundle id');
  const runtimes = Object.fromEntries(WORKER_POOLS.map((pool) => [pool, Object.freeze({
    hostRuntimeIdentity: UNVERIFIED_HOST_RUNTIME_IDENTITY,
    imageReference: null,
  })])) as CompilerRuntimeConfiguration['runtimes'];
  return Object.freeze({
    trust: 'unverified-local',
    compilerBundleId,
    releaseId: UNVERIFIED_COMPILE_RELEASE_ID,
    runtimes: Object.freeze(runtimes),
    manifest: null,
  });
}

export function loadCompilerRuntimeConfiguration(
  env: NodeJS.ProcessEnv,
  compilerBundleId: string,
  production = env.NODE_ENV === 'production',
): CompilerRuntimeConfiguration {
  if (!validBundleId(compilerBundleId)) throw new Error('invalid compiler bundle id');
  const releasePath = env.AF_COMPILER_RUNTIME_RELEASE_PATH?.trim() ?? '';
  const requestedReleaseId = env.AF_COMPILE_RELEASE_ID?.trim() ?? '';
  if (!releasePath) {
    if (production) throw new Error('AF_COMPILER_RUNTIME_RELEASE_PATH is required in production');
    if (requestedReleaseId && requestedReleaseId !== UNVERIFIED_COMPILE_RELEASE_ID) {
      throw new Error('an accepted AF_COMPILE_RELEASE_ID requires a compiler runtime release manifest');
    }
    return createUnverifiedLocalRuntimeConfiguration(compilerBundleId);
  }
  if (!requestedReleaseId || !isCompileReleaseId(requestedReleaseId)
    || requestedReleaseId === UNVERIFIED_COMPILE_RELEASE_ID) {
    throw new Error('an accepted compiler runtime manifest requires AF_COMPILE_RELEASE_ID=sha256:<digest>');
  }
  const release = readCompilerRuntimeRelease(releasePath);
  if (release.compilerBundleId !== compilerBundleId) {
    throw new Error('compiler runtime release bundle does not match AF_COMPILER_BUNDLE_ID');
  }
  if (release.releaseId !== requestedReleaseId) {
    throw new Error('compiler runtime release does not match AF_COMPILE_RELEASE_ID');
  }
  return compilerRuntimeConfigurationFromRelease(release);
}

export function workerHostRuntimeIdentity(
  configuration: CompilerRuntimeConfiguration,
  pool: WorkerPool,
  env: NodeJS.ProcessEnv,
): string {
  const expected = configuration.runtimes[pool].hostRuntimeIdentity;
  const supplied = env.AF_HOST_RUNTIME_IDENTITY?.trim() ?? '';
  if (configuration.trust === 'accepted') {
    if (!supplied || supplied !== expected) {
      throw new Error(`AF_HOST_RUNTIME_IDENTITY does not match accepted runtime pool ${pool}`);
    }
    return supplied;
  }
  if (supplied && supplied !== UNVERIFIED_HOST_RUNTIME_IDENTITY) {
    throw new Error('unverified-local runtime cannot advertise an accepted host runtime identity');
  }
  return UNVERIFIED_HOST_RUNTIME_IDENTITY;
}

export function compilerHostRuntimeIdentities(
  configuration: CompilerRuntimeConfiguration,
): Readonly<Record<WorkerPool, string>> {
  return Object.freeze(Object.fromEntries(WORKER_POOLS.map((pool) => [
    pool,
    configuration.runtimes[pool].hostRuntimeIdentity,
  ])) as Record<WorkerPool, string>);
}

export function parseCompilerRuntimeEvidence(value: unknown): CompilerRuntimeEvidence {
  if (!object(value) || !exactKeys(value, [
    'compileReleaseId',
    'pool',
    'hostRuntimeIdentity',
    'imageDigest',
  ])) {
    throw new Error('compiler runtime evidence must use the exact schema');
  }
  if (typeof value.compileReleaseId !== 'string'
    || !isCompileReleaseId(value.compileReleaseId)
    || value.compileReleaseId === UNVERIFIED_COMPILE_RELEASE_ID) {
    throw new Error('compiler runtime evidence requires an accepted compile release');
  }
  if (!WORKER_POOLS.includes(value.pool as WorkerPool)) {
    throw new Error('compiler runtime evidence has an invalid worker pool');
  }
  if (typeof value.imageDigest !== 'string' || !SHA256.test(value.imageDigest)) {
    throw new Error('compiler runtime evidence has an invalid OCI digest');
  }
  if (typeof value.hostRuntimeIdentity !== 'string'
    || value.hostRuntimeIdentity !== compilerHostRuntimeIdentity({
      pool: value.pool as WorkerPool,
      mode: 'oci-image',
      platform: 'linux/amd64',
      imageDigest: value.imageDigest,
    })) {
    throw new Error('compiler runtime evidence identity does not match its pool and image digest');
  }
  return Object.freeze({
    compileReleaseId: value.compileReleaseId,
    pool: value.pool as WorkerPool,
    hostRuntimeIdentity: value.hostRuntimeIdentity,
    imageDigest: value.imageDigest,
  });
}

export function normalizeCompilerRuntimeEvidence(
  values: readonly CompilerRuntimeEvidence[],
): readonly CompilerRuntimeEvidence[] {
  if (values.length === 0 || values.length > 10_000) {
    throw new Error('compiler runtime evidence count is invalid');
  }
  const byPool = new Map<WorkerPool, CompilerRuntimeEvidence>();
  let releaseId: string | undefined;
  for (const value of values) {
    const evidence = parseCompilerRuntimeEvidence(value);
    releaseId ??= evidence.compileReleaseId;
    if (evidence.compileReleaseId !== releaseId) {
      throw new Error('compiler runtime evidence mixes compile releases');
    }
    const previous = byPool.get(evidence.pool);
    if (previous && (previous.hostRuntimeIdentity !== evidence.hostRuntimeIdentity
      || previous.imageDigest !== evidence.imageDigest)) {
      throw new Error(`compiler runtime evidence drift for pool ${evidence.pool}`);
    }
    byPool.set(evidence.pool, evidence);
  }
  return Object.freeze(WORKER_POOLS.flatMap((pool) => {
    const evidence = byPool.get(pool);
    return evidence ? [evidence] : [];
  }));
}

export function compilerRuntimeEvidenceFromEnvironment(
  env: NodeJS.ProcessEnv,
  compilerBundleId: string,
): CompilerRuntimeEvidence {
  const configuration = loadCompilerRuntimeConfiguration(env, compilerBundleId, true);
  const pool = env.AF_WORKER_POOL as WorkerPool;
  if (!WORKER_POOLS.includes(pool)) throw new Error('AF_WORKER_POOL is invalid');
  const hostRuntimeIdentity = workerHostRuntimeIdentity(configuration, pool, env);
  const imageDigest = env.AF_WORKER_IMAGE_DIGEST?.trim() ?? '';
  const runtime = configuration.manifest?.runtimes.find((candidate) => candidate.pool === pool);
  if (!runtime || imageDigest !== runtime.imageDigest) {
    throw new Error(`AF_WORKER_IMAGE_DIGEST does not match accepted runtime pool ${pool}`);
  }
  return parseCompilerRuntimeEvidence({
    compileReleaseId: configuration.releaseId,
    pool,
    hostRuntimeIdentity,
    imageDigest,
  });
}

export function assertRuntimeConfigurationNamespace(
  configuration: CompilerRuntimeConfiguration,
  namespace: { bundleId: string; releaseId: string },
): void {
  if (configuration.compilerBundleId !== namespace.bundleId
    || configuration.releaseId !== namespace.releaseId) {
    throw new Error('compiler runtime configuration does not match its compile namespace');
  }
}
