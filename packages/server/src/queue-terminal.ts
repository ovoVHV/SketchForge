import type { CompileResult } from '@arduinofast/core';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  assertCompileRedisNamespace,
  compileRedisKey,
  type CompileRedisNamespace,
} from './compile-namespace.js';
import {
  type RedisCompileEventStore,
  type SequencedCompileEvent,
} from './distributed-events.js';

const IN_FLIGHT_STATES = new Set([
  'active',
  'waiting',
  'waiting-children',
  'delayed',
  'prioritized',
  'paused',
]);

const FAILED_RESULT: CompileResult = {
  status: 'error',
  reason: 'internal',
  message: 'compile worker exited before completion; please retry',
  diagnostics: [],
  timings: {},
};

export interface CompileQueueLockOptions {
  namespace: CompileRedisNamespace;
  ttlMs?: number;
  waitMs?: number;
}

export interface CompileTerminalJob {
  readonly id?: string;
  readonly returnvalue?: CompileResult | null;
  getState(): Promise<string>;
  updateProgress(progress: SequencedCompileEvent): Promise<unknown>;
}

export interface CompileTerminalReconciliation {
  state: 'completed' | 'failed';
  result: CompileResult;
  event: SequencedCompileEvent;
}

export type LoadCompileTerminalJob = (jobId: string) => Promise<CompileTerminalJob | null>;
export type CompileTerminalEventStore = Pick<
  RedisCompileEventStore,
  'appendTerminal' | 'resetTerminal'
>;

export class CompileQueueCoordinationBusyError extends Error {
  constructor() {
    super('compile queue coordination lock is busy');
    this.name = 'CompileQueueCoordinationBusyError';
  }
}

/** Kept identical to the former submission lock key for rolling upgrades. */
export function compileQueueCoordinationLockKey(namespace: CompileRedisNamespace): string {
  assertCompileRedisNamespace(namespace);
  return `${compileRedisKey(namespace, 'request-bytes')}:submit-lock`;
}

/** Serializes job replacement/removal with publication of its durable terminal result. */
export class RedisCompileQueueLock {
  private readonly key: string;
  private readonly ttlMs: number;
  private readonly waitMs: number;

  constructor(
    private readonly redis: Redis,
    options: CompileQueueLockOptions,
  ) {
    this.key = compileQueueCoordinationLockKey(options.namespace);
    this.ttlMs = options.ttlMs ?? 15_000;
    this.waitMs = options.waitMs ?? 2_000;
    for (const [name, value] of [
      ['ttlMs', this.ttlMs],
      ['waitMs', this.waitMs],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      if (await this.redis.set(this.key, token, 'PX', this.ttlMs, 'NX') === 'OK') break;
      if (Date.now() >= deadline) throw new CompileQueueCoordinationBusyError();
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)));
    }
    try {
      return await task();
    } finally {
      try {
        await this.redis.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
          1,
          this.key,
          token,
        );
      } catch {
        // The TTL is the fallback. Do not mask a completed queue operation.
      }
    }
  }
}

/**
 * Projects BullMQ's authoritative terminal state into the durable SSE result.
 * The job is always reloaded while holding the queue lock, so a late callback
 * from a replaced job ID cannot publish its stale return value.
 */
export class CompileTerminalCoordinator {
  constructor(
    private readonly lock: RedisCompileQueueLock,
    private readonly events: CompileTerminalEventStore,
    private readonly loadJob: LoadCompileTerminalJob,
    private readonly onNotificationError: (error: unknown, jobId: string) => void = () => {},
  ) {}

  async prepareInFlight(jobId: string): Promise<void> {
    await this.lock.run(async () => {
      const job = await this.loadJob(jobId);
      if (!job) throw new Error(`compile job ${jobId} disappeared before processing`);
      const state = await job.getState();
      if (!IN_FLIGHT_STATES.has(state)) {
        throw new Error(`compile job ${jobId} cannot start from ${state}`);
      }
      // A manually retried failed job keeps the same BullMQ ID. Remove the old
      // terminal generation before the retried processor can emit progress.
      await this.events.resetTerminal(jobId);
    });
  }

  async reconcile(
    jobId: string,
    onTerminal?: (job: CompileTerminalJob) => Promise<void>,
  ): Promise<CompileTerminalReconciliation | null> {
    return this.lock.run(async () => {
      const job = await this.loadJob(jobId);
      if (!job) return null;
      const state = await job.getState();
      if (IN_FLIGHT_STATES.has(state)) {
        // Repairs a terminal frame left by an explicit BullMQ retry before a
        // reconnecting client is allowed to replay it.
        await this.events.resetTerminal(jobId);
        return null;
      }
      if (state !== 'completed' && state !== 'failed') return null;

      const result = state === 'completed' && isCompileResult(job.returnvalue)
        ? job.returnvalue
        : FAILED_RESULT;
      const event = await this.events.appendTerminal(jobId, result);
      try {
        await job.updateProgress(event);
      } catch (error) {
        // Redis replay is authoritative; QueueEvents is only a low-latency wakeup.
        this.onNotificationError(error, jobId);
      }
      await onTerminal?.(job);
      return { state, result, event };
    });
  }
}

function isCompileResult(value: unknown): value is CompileResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<CompileResult>;
  if (result.status !== 'success' && result.status !== 'error') return false;
  return Array.isArray(result.diagnostics)
    && Boolean(result.timings)
    && typeof result.timings === 'object';
}
