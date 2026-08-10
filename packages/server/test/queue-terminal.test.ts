import type { CompileResult } from '@sketchforge/core';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { createCompileRedisNamespace } from '../src/compile-namespace.js';
import type { SequencedCompileEvent } from '../src/distributed-events.js';
import {
  CompileTerminalCoordinator,
  RedisCompileQueueLock,
  compileQueueCoordinationLockKey,
  type CompileTerminalEventStore,
  type CompileTerminalJob,
} from '../src/queue-terminal.js';

class FakeLockRedis {
  private readonly locks = new Map<string, { token: string; expiresAt: number }>();

  async set(key: string, token: string, _px: string, ttlMs: number, _nx: string) {
    const current = this.locks.get(key);
    if (current && current.expiresAt > Date.now()) return null;
    this.locks.set(key, { token, expiresAt: Date.now() + ttlMs });
    return 'OK';
  }

  async eval(_script: string, _keys: number, key: string, token: string) {
    if (this.locks.get(key)?.token !== token) return 0;
    this.locks.delete(key);
    return 1;
  }
}

class MemoryTerminalEvents implements CompileTerminalEventStore {
  readonly rows = new Map<string, SequencedCompileEvent>();
  appendCalls = 0;
  resetCalls = 0;

  async appendTerminal(jobId: string, result: CompileResult): Promise<SequencedCompileEvent> {
    this.appendCalls++;
    const existing = this.rows.get(jobId);
    if (existing) return existing;
    const event: SequencedCompileEvent = { id: '1', event: { event: 'done', result } };
    this.rows.set(jobId, event);
    return event;
  }

  async resetTerminal(jobId: string): Promise<boolean> {
    this.resetCalls++;
    return this.rows.delete(jobId);
  }
}

class FakeJob implements CompileTerminalJob {
  readonly updateProgress = vi.fn(async (_event: SequencedCompileEvent) => {});

  constructor(
    readonly id: string,
    public state: string,
    public returnvalue: CompileResult | null = null,
  ) {}

  async getState(): Promise<string> { return this.state; }
}

const success: CompileResult = {
  status: 'success',
  artifacts: [],
  staticArtifacts: [],
  diagnostics: [],
  timings: {},
  cached: false,
};

const cancelled: CompileResult = {
  status: 'error',
  reason: 'cancelled',
  message: 'compile was cancelled',
  diagnostics: [],
  timings: {},
};

function harness() {
  const namespace = createCompileRedisNamespace('test-compile', 'bundle-v1');
  const redis = new FakeLockRedis();
  const lock = new RedisCompileQueueLock(redis as unknown as Redis, {
    namespace,
    ttlMs: 5_000,
    waitMs: 1_000,
  });
  const events = new MemoryTerminalEvents();
  const jobs = new Map<string, FakeJob>();
  const coordinator = new CompileTerminalCoordinator(
    lock,
    events,
    async (jobId) => jobs.get(jobId) ?? null,
  );
  return { namespace, lock, events, jobs, coordinator };
}

describe('CompileTerminalCoordinator', () => {
  it('never writes done for active or waiting BullMQ jobs and clears retry residue', async () => {
    const { events, jobs, coordinator } = harness();
    const job = new FakeJob('job-active', 'completed', success);
    jobs.set(job.id, job);
    await coordinator.reconcile(job.id);
    expect(events.rows.has(job.id)).toBe(true);

    job.state = 'waiting';
    await expect(coordinator.reconcile(job.id)).resolves.toBeNull();
    expect(events.rows.has(job.id)).toBe(false);
    job.state = 'active';
    await expect(coordinator.prepareInFlight(job.id)).resolves.toBeUndefined();
    expect(events.appendCalls).toBe(1);
    expect(events.resetCalls).toBe(2);
  });

  it('persists one completed result under concurrent recovery attempts', async () => {
    const { events, jobs, coordinator } = harness();
    const job = new FakeJob('job-complete', 'completed', success);
    jobs.set(job.id, job);

    const recovered = await Promise.all(Array.from({ length: 20 }, () => coordinator.reconcile(job.id)));

    expect(events.rows.size).toBe(1);
    expect(recovered.every((row) => row?.state === 'completed')).toBe(true);
    expect(recovered[0]?.result).toEqual(success);
    expect(job.updateProgress).toHaveBeenCalledTimes(20);
  });

  it('maps BullMQ failure to one internal error and preserves completed cancellation', async () => {
    const { events, jobs, coordinator } = harness();
    const failed = new FakeJob('job-failed', 'failed', success);
    const stopped = new FakeJob('job-cancelled', 'completed', cancelled);
    jobs.set(failed.id, failed);
    jobs.set(stopped.id, stopped);

    await expect(coordinator.reconcile(failed.id)).resolves.toMatchObject({
      state: 'failed',
      result: { status: 'error', reason: 'internal' },
    });
    await expect(coordinator.reconcile(stopped.id)).resolves.toMatchObject({
      state: 'completed',
      result: { status: 'error', reason: 'cancelled' },
    });
    expect(events.rows.size).toBe(2);
  });

  it('reloads the current job after replacement instead of publishing a stale callback', async () => {
    const { lock, events, jobs, coordinator } = harness();
    const jobId = 'job-replaced';
    jobs.set(jobId, new FakeJob(jobId, 'failed'));
    let replacementReady!: () => void;
    const ready = new Promise<void>((resolve) => { replacementReady = resolve; });
    let releaseReplacement!: () => void;
    const release = new Promise<void>((resolve) => { releaseReplacement = resolve; });

    const replacing = lock.run(async () => {
      jobs.set(jobId, new FakeJob(jobId, 'waiting'));
      await events.resetTerminal(jobId);
      replacementReady();
      await release;
    });
    await ready;
    const lateFailedCallback = coordinator.reconcile(jobId);
    releaseReplacement();
    await replacing;

    await expect(lateFailedCallback).resolves.toBeNull();
    expect(events.rows.has(jobId)).toBe(false);
  });

  it('recovers a durable terminal after notification failure without duplicating it', async () => {
    const { lock, events, jobs } = harness();
    const job = new FakeJob('job-recovery', 'completed', success);
    job.updateProgress.mockRejectedValueOnce(new Error('connection closed'));
    jobs.set(job.id, job);
    const notificationErrors: unknown[] = [];
    const first = new CompileTerminalCoordinator(
      lock,
      events,
      async (jobId) => jobs.get(jobId) ?? null,
      (error) => notificationErrors.push(error),
    );
    await first.reconcile(job.id);

    const afterRestart = new CompileTerminalCoordinator(
      lock,
      events,
      async (jobId) => jobs.get(jobId) ?? null,
    );
    await afterRestart.reconcile(job.id);

    expect(notificationErrors).toHaveLength(1);
    expect(events.rows.size).toBe(1);
    expect(job.updateProgress).toHaveBeenCalledTimes(2);
  });

  it('uses the same bundle-scoped key as queue admission and cancellation', () => {
    const { namespace } = harness();
    expect(compileQueueCoordinationLockKey(namespace))
      .toBe(`${namespace.redisPrefix}:request-bytes:submit-lock`);
  });
});
