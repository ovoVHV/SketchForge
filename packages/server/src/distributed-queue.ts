import type { BoardDefinition, CompileRequest, CompileResult } from '@sketchforge/core';
import { Queue, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  RedisCompileCancellationStore,
  type CompileCancellationStore,
  type CompileConsumerLease,
} from './compile-cancellation.js';
import {
  assertCompileRedisNamespace,
  compileRedisKey,
  createCompileRedisNamespace,
  type CompileRedisNamespace,
} from './compile-namespace.js';
import { compileEventKeys } from './distributed-events.js';
import {
  CompileQueueCoordinationBusyError,
  RedisCompileQueueLock,
} from './queue-terminal.js';
import { WORKER_POOLS, type WorkerPool } from './worker-pools.js';
import {
  assertRuntimeConfigurationNamespace,
  compilerHostRuntimeIdentities,
  createUnverifiedLocalRuntimeConfiguration,
  type CompilerRuntimeConfiguration,
} from './compiler-runtime-release.js';

export { WORKER_POOLS, type WorkerPool } from './worker-pools.js';
export const DEFAULT_JOB_WALL_TIMEOUT_MS: Readonly<Record<WorkerPool, number>> = {
  avr: 120_000,
  'esp32-xtensa': 300_000,
  'esp32-riscv': 300_000,
};

export interface CompileJobData {
  /** Removed before BullMQ retains a terminal job. */
  request?: CompileRequest;
  /** UTF-8 bytes occupied by request while it is queued or active. */
  requestBytes: number;
  bundleId: string;
  compileReleaseId: string;
  hostRuntimeIdentity: string;
  pool: WorkerPool;
  /** Gateway acceptance time; queue wait is part of the wall-clock budget. */
  submittedAt: number;
  /** Absolute Unix epoch. Optional only for jobs queued by an older gateway. */
  deadlineAt?: number;
}

export interface DistributedCompileQueueOptions {
  namespace: CompileRedisNamespace;
  maxQueuedPerPool?: number | Partial<Record<WorkerPool, number>>;
  maxQueuedRequestBytes?: number;
  jobWallTimeoutMs?: number | Partial<Record<WorkerPool, number>>;
  completedRetentionSeconds?: number;
  completedRetentionCount?: number;
  failedRetentionSeconds?: number;
  failedRetentionCount?: number;
  submissionLockTtlMs?: number;
  submissionLockWaitMs?: number;
  consumerLeaseTtlMs?: number;
  maxConsumersPerJob?: number;
  cancellationStore?: CompileCancellationStore;
  coordination?: RedisCompileQueueLock;
  runtimeConfiguration?: CompilerRuntimeConfiguration;
}

export interface DistributedCompileSubmission {
  id: string;
  pool: WorkerPool;
  reused: boolean;
  /** Present only while the shared BullMQ job is still in flight. */
  cancellation?: CompileConsumerLease;
}

export interface DistributedCompileCancellation {
  cancelled: boolean;
  jobCancelled: boolean;
  state: string;
  remainingConsumers: number;
}

export class DistributedQueueFullError extends Error {
  constructor(readonly pool: WorkerPool) {
    super(`compile queue ${pool} is full`);
    this.name = 'DistributedQueueFullError';
  }
}

export class DistributedQueueBusyError extends Error {
  constructor(readonly pool: WorkerPool) {
    super(`compile queue ${pool} admission is busy`);
    this.name = 'DistributedQueueBusyError';
  }
}

export function workerPoolForBoard(board: BoardDefinition): WorkerPool {
  if (board.arch === 'avr') return 'avr';
  if (board.arch === 'esp32') {
    return board.build.tarch?.startsWith('riscv') ? 'esp32-riscv' : 'esp32-xtensa';
  }
  throw new Error(`unsupported board architecture: ${board.arch}`);
}

export function queueName(
  prefix: string,
  pool: WorkerPool,
  bundleId: string,
  releaseId?: string,
): string {
  return queueNameForNamespace(createCompileRedisNamespace(prefix, bundleId, releaseId), pool);
}

export function queueNameForNamespace(
  namespace: CompileRedisNamespace,
  pool: WorkerPool,
): string {
  assertCompileRedisNamespace(namespace);
  if (!WORKER_POOLS.includes(pool)) throw new Error('invalid compile worker pool');
  return `${namespace.bullQueueStem}-${pool}`;
}

export interface BullQueueIdentity {
  readonly name: string;
  readonly prefix: string;
  readonly qualifiedName: string;
}

export function bullQueueIdentityForNamespace(
  namespace: CompileRedisNamespace,
  pool: WorkerPool,
): BullQueueIdentity {
  const name = queueNameForNamespace(namespace, pool);
  return Object.freeze({
    name,
    prefix: namespace.bullPrefix,
    qualifiedName: `${namespace.bullPrefix}:${name}`,
  });
}

export function compileRequestByteLedgerKey(namespace: CompileRedisNamespace): string {
  return compileRedisKey(namespace, 'request-bytes');
}

export function retainedCompileJobData(data: CompileJobData): CompileJobData {
  const { request: _request, ...retained } = data;
  return { ...retained, requestBytes: 0 };
}

/** Resolve rolling-upgrade jobs and cap untrusted data to this worker's policy. */
export function resolveCompileJobDeadlineAt(
  data: Pick<CompileJobData, 'submittedAt' | 'deadlineAt'>,
  fallbackTimeoutMs: number,
  now = Date.now(),
): number {
  if (!Number.isSafeInteger(fallbackTimeoutMs) || fallbackTimeoutMs <= 0) {
    throw new TypeError('fallbackTimeoutMs must be a positive safe integer');
  }
  const submittedAt = Number.isSafeInteger(data.submittedAt) && data.submittedAt >= 0
    ? data.submittedAt
    : now;
  const fallbackDeadline = submittedAt + fallbackTimeoutMs;
  if (!Number.isSafeInteger(fallbackDeadline)) throw new TypeError('compile job deadline is out of range');
  const stamped = data.deadlineAt;
  return stamped !== undefined && Number.isSafeInteger(stamped) && stamped >= submittedAt
    ? Math.min(stamped, fallbackDeadline)
    : fallbackDeadline;
}

/** Completed infrastructure failures are transient and must never become cache hits. */
export function isReusableCompileResult(result: CompileResult | undefined | null): boolean {
  if (!result) return false;
  if (result.status === 'success') return true;
  return result.reason === 'compile_error'
    || result.reason === 'preprocess_error'
    || result.reason === 'invalid_request'
    || result.reason === 'rejected'
    || result.reason === 'resource_limit';
}

/** BullMQ facade with deterministic job IDs for global singleflight. */
export class DistributedCompileQueue {
  private readonly namespace: CompileRedisNamespace;
  private readonly prefix: string;
  private readonly bundleId: string;
  private readonly hostRuntimeIdentities: Readonly<Record<WorkerPool, string>>;
  private readonly maxQueuedPerPool: Record<WorkerPool, number>;
  private readonly maxQueuedRequestBytes: number;
  private readonly jobWallTimeoutMs: Record<WorkerPool, number>;
  private readonly requestByteLedgerKey: string;
  private readonly completedRetentionSeconds: number;
  private readonly completedRetentionCount: number;
  private readonly failedRetentionSeconds: number;
  private readonly failedRetentionCount: number;
  private readonly coordination: RedisCompileQueueLock;
  private readonly cancellations: CompileCancellationStore;
  private readonly queues = new Map<WorkerPool, Queue<CompileJobData, CompileResult, 'compile'>>();

  constructor(
    private readonly redis: Redis,
    options: DistributedCompileQueueOptions,
  ) {
    this.namespace = options.namespace;
    assertCompileRedisNamespace(this.namespace);
    this.prefix = this.namespace.queuePrefix;
    this.bundleId = this.namespace.bundleId;
    const runtimeConfiguration = options.runtimeConfiguration
      ?? createUnverifiedLocalRuntimeConfiguration(this.namespace.bundleId);
    assertRuntimeConfigurationNamespace(runtimeConfiguration, this.namespace);
    this.hostRuntimeIdentities = compilerHostRuntimeIdentities(runtimeConfiguration);
    for (const pool of WORKER_POOLS) {
      const identity = this.hostRuntimeIdentities[pool];
      const valid = this.namespace.releaseId === 'unverified-local'
        ? identity === 'unverified-local'
        : /^sha256:[a-f0-9]{64}$/.test(identity);
      if (!valid) throw new Error(`invalid host runtime identity for pool ${pool}`);
    }
    const configuredCapacity = options.maxQueuedPerPool ?? 100;
    this.maxQueuedPerPool = Object.fromEntries(WORKER_POOLS.map((pool) => [
      pool,
      typeof configuredCapacity === 'number' ? configuredCapacity : configuredCapacity[pool] ?? 100,
    ])) as Record<WorkerPool, number>;
    this.maxQueuedRequestBytes = options.maxQueuedRequestBytes ?? 128 * 1024 * 1024;
    const configuredWallTimeout = options.jobWallTimeoutMs;
    this.jobWallTimeoutMs = Object.fromEntries(WORKER_POOLS.map((pool) => [
      pool,
      typeof configuredWallTimeout === 'number'
        ? configuredWallTimeout
        : configuredWallTimeout?.[pool] ?? DEFAULT_JOB_WALL_TIMEOUT_MS[pool],
    ])) as Record<WorkerPool, number>;
    this.requestByteLedgerKey = compileRequestByteLedgerKey(this.namespace);
    this.completedRetentionSeconds = options.completedRetentionSeconds ?? 24 * 60 * 60;
    this.completedRetentionCount = options.completedRetentionCount ?? 20_000;
    this.failedRetentionSeconds = options.failedRetentionSeconds ?? 60 * 60;
    this.failedRetentionCount = options.failedRetentionCount ?? 250;
    // The gateway command timeout applies to each Redis round trip in the
    // count/remove/add critical section. Keep the lease comfortably above the
    // worst bounded sequence so it cannot expire midway through admission.
    this.coordination = options.coordination ?? new RedisCompileQueueLock(redis, {
      namespace: this.namespace,
      ttlMs: options.submissionLockTtlMs,
      waitMs: options.submissionLockWaitMs,
    });
    this.cancellations = options.cancellationStore ?? new RedisCompileCancellationStore(redis, {
      namespace: this.namespace,
      ...(options.consumerLeaseTtlMs === undefined ? {} : { leaseTtlMs: options.consumerLeaseTtlMs }),
      ...(options.maxConsumersPerJob === undefined ? {} : { maxConsumersPerJob: options.maxConsumersPerJob }),
    });
    for (const [pool, capacity] of Object.entries(this.maxQueuedPerPool)) {
      if (!Number.isInteger(capacity) || capacity <= 0) {
        throw new Error(`max queued capacity for ${pool} must be a positive integer`);
      }
    }
    for (const [pool, timeoutMs] of Object.entries(this.jobWallTimeoutMs)) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`job wall timeout for ${pool} must be a positive safe integer`);
      }
    }
    for (const [name, value] of [
      ['maxQueuedRequestBytes', this.maxQueuedRequestBytes],
      ['completedRetentionSeconds', this.completedRetentionSeconds],
      ['completedRetentionCount', this.completedRetentionCount],
      ['failedRetentionSeconds', this.failedRetentionSeconds],
      ['failedRetentionCount', this.failedRetentionCount],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    }
  }

  async submit(
    board: BoardDefinition,
    request: CompileRequest,
    fingerprint: string,
    bundleId: string,
    resultReusable = true,
    submittedAt = Date.now(),
  ): Promise<DistributedCompileSubmission> {
    if (bundleId !== this.bundleId) throw new Error('compile queue bundle id mismatch');
    const pool = workerPoolForBoard(board);
    if (!Number.isSafeInteger(submittedAt) || submittedAt < 0) {
      throw new TypeError('compile submission time must be a non-negative safe integer');
    }
    const deadlineAt = submittedAt + this.jobWallTimeoutMs[pool];
    if (!Number.isSafeInteger(deadlineAt)) throw new TypeError('compile job deadline is out of range');
    const id = this.jobId(pool, fingerprint);
    const queue = this.queue(pool);

    return this.withSubmissionLock(pool, async () => {
      // Recheck under the lock. This is what makes simultaneous submissions on
      // different gateway instances collapse to one BullMQ job.
      const existing = await queue.getJob(id);
      if (existing) {
        const state = await this.reusableState(existing, resultReusable);
        if (state) {
          if (state === 'completed') {
            await this.cancellations.clear(id);
            return { id, pool, reused: true };
          }
          const cancellation = await this.cancellations.acquire(id);
          if (cancellation) return { id, pool, reused: true, cancellation };
          if (await this.cancellations.hasCancellationMarker(id)) {
            throw new DistributedQueueBusyError(pool);
          }
          throw new DistributedQueueFullError(pool);
        }
      }
      if (existing) {
        await existing.remove();
        await this.redis.hdel(this.requestByteLedgerKey, id);
      }

      // A non-deterministic request reuses its ID only while in flight. Clear
      // the previous generation before publishing the replacement job.
      const staleEventKeys = compileEventKeys(this.namespace, id);
      await this.redis.del(staleEventKeys.list, staleEventKeys.sequence, staleEventKeys.terminal);
      await this.cancellations.clear(id);

      // The pool-wide submission lock makes this count + add boundary strict
      // across every gateway instance.
      const counts = await queue.getJobCounts('wait', 'waiting-children', 'delayed', 'paused');
      const queued = Object.values(counts).reduce((sum, value) => sum + value, 0);
      if (queued >= this.maxQueuedPerPool[pool]) throw new DistributedQueueFullError(pool);

      const cancellation = await this.cancellations.acquire(id, true);
      if (!cancellation) throw new Error('failed to create compile consumer lease');
      const requestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
      const jobData: CompileJobData = {
        request,
        requestBytes,
        bundleId,
        compileReleaseId: this.namespace.releaseId,
        hostRuntimeIdentity: this.hostRuntimeIdentities[pool],
        pool,
        submittedAt,
        deadlineAt,
      };
      try {
        let storedRequestBytes = await this.requestByteLedgerTotal();
        if (requestBytes > this.maxQueuedRequestBytes - storedRequestBytes) {
          // A gateway can die after reserving bytes but before Queue.add().
          // Reconcile only on pressure so normal admission remains one Redis
          // hash read rather than one round trip per queued job.
          storedRequestBytes = await this.reconcileRequestByteLedger();
        }
        if (requestBytes > this.maxQueuedRequestBytes - storedRequestBytes) {
          throw new DistributedQueueFullError(pool);
        }
        // Reserve before publishing the BullMQ job so a fast worker cannot
        // finish and release an entry that the gateway has not created yet.
        await this.redis.hset(this.requestByteLedgerKey, id, String(requestBytes));
        await queue.add('compile', jobData, {
          jobId: id,
          timestamp: submittedAt,
          attempts: 1,
          removeOnComplete: {
            age: this.completedRetentionSeconds,
            count: this.completedRetentionCount,
          },
          removeOnFail: {
            age: this.failedRetentionSeconds,
            count: this.failedRetentionCount,
          },
        });
      } catch (error) {
        await this.redis.hdel(this.requestByteLedgerKey, id).catch(() => {});
        await this.cancellations.clear(id).catch(() => {});
        throw error;
      }
      return { id, pool, reused: false, cancellation };
    });
  }

  async get(jobId: string): Promise<Job<CompileJobData, CompileResult, 'compile'> | null> {
    const pool = this.poolFromJobId(jobId);
    if (!pool) return null;
    return (await this.queue(pool).getJob(jobId)) ?? null;
  }

  async cancelRequest(
    jobId: string,
    requestId: string,
    token: string,
  ): Promise<DistributedCompileCancellation | null> {
    const pool = this.poolFromJobId(jobId);
    if (!pool) return null;
    return this.withSubmissionLock(pool, async () => {
      const job = await this.queue(pool).getJob(jobId);
      if (!job) return null;

      let state = await job.getState();
      if (state === 'completed' || state === 'failed') {
        const released = await this.cancellations.release(jobId, requestId, token);
        if (!released.found) return null;
        return {
          cancelled: false,
          jobCancelled: false,
          state,
          remainingConsumers: released.remaining,
        };
      }

      const cancelled = await this.cancellations.cancel(jobId, requestId, token);
      if (!cancelled.found) return null;
      if (cancelled.remaining > 0) {
        return {
          cancelled: true,
          jobCancelled: false,
          state,
          remainingConsumers: cancelled.remaining,
        };
      }

      state = await job.getState();
      if (state === 'completed' || state === 'failed') {
        return {
          cancelled: false,
          jobCancelled: false,
          state,
          remainingConsumers: 0,
        };
      }

      const removable = state === 'waiting'
        || state === 'waiting-children'
        || state === 'delayed'
        || state === 'prioritized';
      if (removable) {
        try {
          await job.remove();
          await this.redis.hdel(this.requestByteLedgerKey, jobId);
          const staleEventKeys = compileEventKeys(this.namespace, jobId);
          await this.redis.del(staleEventKeys.list, staleEventKeys.sequence, staleEventKeys.terminal);
          await this.cancellations.clear(jobId);
          return {
            cancelled: true,
            jobCancelled: true,
            state: 'cancelled',
            remainingConsumers: 0,
          };
        } catch {
          state = await job.getState();
          if (state === 'completed' || state === 'failed') {
            return {
              cancelled: false,
              jobCancelled: false,
              state,
              remainingConsumers: 0,
            };
          }
        }
      }

      return {
        cancelled: true,
        jobCancelled: true,
        state: state === 'active' ? 'cancelling' : state,
        remainingConsumers: 0,
      };
    });
  }

  async stats(): Promise<Record<WorkerPool, Record<string, number>>> {
    const rows = await Promise.all(WORKER_POOLS.map(async (pool) => {
      const counts = await this.queue(pool).getJobCounts('active', 'wait', 'completed', 'failed', 'delayed');
      return [pool, counts] as const;
    }));
    return Object.fromEntries(rows) as Record<WorkerPool, Record<string, number>>;
  }

  getPrefix(): string {
    return this.prefix;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }

  private queue(pool: WorkerPool): Queue<CompileJobData, CompileResult, 'compile'> {
    let queue = this.queues.get(pool);
    if (!queue) {
      const identity = bullQueueIdentityForNamespace(this.namespace, pool);
      queue = new Queue<CompileJobData, CompileResult, 'compile'>(identity.name, {
        connection: this.redis,
        prefix: identity.prefix,
      });
      this.queues.set(pool, queue);
    }
    return queue;
  }

  private async reconcileRequestByteLedger(): Promise<number> {
    const rows = await this.redis.hgetall(this.requestByteLedgerKey);
    let total = 0;
    const stale: string[] = [];
    for (const [jobId, encodedBytes] of Object.entries(rows)) {
      const pool = this.poolFromJobId(jobId);
      const job = pool ? await this.queue(pool).getJob(jobId) : null;
      if (!job || !job.data.request) {
        stale.push(jobId);
        continue;
      }
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') {
        await job.updateData(retainedCompileJobData(job.data));
        stale.push(jobId);
        continue;
      }
      const storedBytes = Number(encodedBytes);
      total += Number.isSafeInteger(storedBytes) && storedBytes > 0
        ? storedBytes
        : Buffer.byteLength(JSON.stringify(job.data.request), 'utf8');
    }
    if (stale.length > 0) await this.redis.hdel(this.requestByteLedgerKey, ...stale);
    return total;
  }

  private async requestByteLedgerTotal(): Promise<number> {
    const rows = await this.redis.hgetall(this.requestByteLedgerKey);
    let total = 0;
    for (const value of Object.values(rows)) {
      const bytes = Number(value);
      if (!Number.isSafeInteger(bytes) || bytes <= 0) return this.maxQueuedRequestBytes;
      total += bytes;
      if (!Number.isSafeInteger(total) || total >= this.maxQueuedRequestBytes) {
        return this.maxQueuedRequestBytes;
      }
    }
    return total;
  }

  private jobId(pool: WorkerPool, fingerprint: string): string {
    if (!/^[a-f0-9]{64}(?:_[A-Za-z0-9_-]{1,40})?$/.test(fingerprint)) {
      throw new Error('invalid compile request fingerprint');
    }
    return `${pool.replaceAll('-', '_')}_${fingerprint}`;
  }

  private poolFromJobId(jobId: string): WorkerPool | null {
    for (const pool of WORKER_POOLS) {
      const prefix = `${pool.replaceAll('-', '_')}_`;
      if (
        jobId.startsWith(prefix)
        && /^[a-f0-9]{64}(?:_[A-Za-z0-9_-]{1,40})?$/.test(jobId.slice(prefix.length))
      ) return pool;
    }
    return null;
  }

  private async reusableState(
    job: Job<CompileJobData, CompileResult, 'compile'>,
    resultReusable: boolean,
  ): Promise<string | null> {
    const state = await job.getState();
    const inFlight = state === 'active'
      || state === 'waiting'
      || state === 'waiting-children'
      || state === 'delayed'
      || state === 'prioritized';
    return inFlight || (
      resultReusable
      && state === 'completed'
      && isReusableCompileResult(job.returnvalue)
    ) ? state : null;
  }

  private async withSubmissionLock<T>(pool: WorkerPool, task: () => Promise<T>): Promise<T> {
    try {
      return await this.coordination.run(task);
    } catch (error) {
      if (error instanceof CompileQueueCoordinationBusyError) {
        throw new DistributedQueueBusyError(pool);
      }
      throw error;
    }
  }
}
