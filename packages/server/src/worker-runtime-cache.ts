import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { isCompileReleaseId, UNVERIFIED_COMPILE_RELEASE_ID } from './compile-namespace.js';
import { UNVERIFIED_HOST_RUNTIME_IDENTITY } from './compiler-runtime-release.js';
import { WORKER_POOLS, type WorkerPool } from './worker-pools.js';

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ACCEPTED_IDENTITY = /^sha256:[a-f0-9]{64}$/;

export function workerRuntimeCacheNamespace(
  compilerBundleId: string,
  compileReleaseId: string,
  pool: WorkerPool,
  hostRuntimeIdentity: string,
): string {
  if (!BUNDLE_ID.test(compilerBundleId)) throw new Error('invalid compiler bundle id');
  if (!isCompileReleaseId(compileReleaseId)) throw new Error('invalid compile release id');
  if (!WORKER_POOLS.includes(pool)) throw new Error('invalid worker pool');
  const local = compileReleaseId === UNVERIFIED_COMPILE_RELEASE_ID;
  if (local
    ? hostRuntimeIdentity !== UNVERIFIED_HOST_RUNTIME_IDENTITY
    : !ACCEPTED_IDENTITY.test(hostRuntimeIdentity)) {
    throw new Error('host runtime identity does not match compile release trust');
  }
  return createHash('sha256')
    .update('sketchforge-worker-runtime-cache-v1\0')
    .update(compilerBundleId)
    .update('\0')
    .update(compileReleaseId)
    .update('\0')
    .update(pool)
    .update('\0')
    .update(hostRuntimeIdentity)
    .digest('hex');
}

export function workerRuntimeCacheDirectory(
  cacheRoot: string,
  compilerBundleId: string,
  compileReleaseId: string,
  pool: WorkerPool,
  hostRuntimeIdentity: string,
): string {
  if (!cacheRoot.trim()) throw new Error('worker cache root is required');
  const root = resolve(cacheRoot);
  const namespace = workerRuntimeCacheNamespace(
    compilerBundleId,
    compileReleaseId,
    pool,
    hostRuntimeIdentity,
  );
  if (basename(root) === namespace && basename(dirname(root)) === 'runtime-v1') return root;
  return join(root, 'runtime-v1', namespace);
}
