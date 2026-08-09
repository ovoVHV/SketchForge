import { createHash } from 'node:crypto';

const QUEUE_PREFIX = /^[A-Za-z0-9_-]{1,80}$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const REDIS_KEY_PART = /^[A-Za-z0-9._-]{1,256}$/;
const ACCEPTED_RELEASE_ID = /^sha256:[a-f0-9]{64}$/;

export const UNVERIFIED_COMPILE_RELEASE_ID = 'unverified-local';

export interface CompileRedisNamespace {
  readonly queuePrefix: string;
  readonly bundleId: string;
  readonly bundleHash: string;
  readonly releaseId: string;
  readonly releaseHash: string;
  readonly redisPrefix: string;
  readonly bullPrefix: string;
  readonly bullQueueStem: string;
}

export function createCompileRedisNamespace(
  queuePrefix: string,
  bundleId: string,
  releaseId = UNVERIFIED_COMPILE_RELEASE_ID,
): CompileRedisNamespace {
  if (!QUEUE_PREFIX.test(queuePrefix)) throw new Error('invalid compile queue prefix');
  if (!BUNDLE_ID.test(bundleId)) throw new Error('invalid compiler bundle id');
  if (!isCompileReleaseId(releaseId)) throw new Error('invalid compile release id');
  const bundleHash = createHash('sha256').update(bundleId, 'utf8').digest('hex').slice(0, 24);
  const releaseHash = createHash('sha256').update(releaseId, 'utf8').digest('hex').slice(0, 24);
  return Object.freeze({
    queuePrefix,
    bundleId,
    bundleHash,
    releaseId,
    releaseHash,
    redisPrefix: `${queuePrefix}:b${bundleHash}:r${releaseHash}`,
    bullPrefix: `${queuePrefix}:bullmq:b${bundleHash}:r${releaseHash}`,
    bullQueueStem: `${queuePrefix}-b${bundleHash}-r${releaseHash}`,
  });
}

export function isCompileReleaseId(value: string): boolean {
  return value === UNVERIFIED_COMPILE_RELEASE_ID || ACCEPTED_RELEASE_ID.test(value);
}

export function assertCompileRedisNamespace(namespace: CompileRedisNamespace): void {
  const expected = createCompileRedisNamespace(
    namespace.queuePrefix,
    namespace.bundleId,
    namespace.releaseId,
  );
  if (
    namespace.bundleHash !== expected.bundleHash
    || namespace.releaseHash !== expected.releaseHash
    || namespace.redisPrefix !== expected.redisPrefix
    || namespace.bullPrefix !== expected.bullPrefix
    || namespace.bullQueueStem !== expected.bullQueueStem
  ) {
    throw new Error('inconsistent compile Redis namespace');
  }
}

export function compileRedisKey(
  namespace: CompileRedisNamespace,
  ...parts: string[]
): string {
  assertCompileRedisNamespace(namespace);
  if (parts.length === 0 || parts.some((part) => !REDIS_KEY_PART.test(part))) {
    throw new Error('invalid compile Redis key part');
  }
  return `${namespace.redisPrefix}:${parts.join(':')}`;
}
