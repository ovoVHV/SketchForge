import { vi } from 'vitest';

const fakeBull = vi.hoisted(() => ({
  queues: new Map<string, {
    jobs: Map<string, any>;
    adds: number;
    lastOptions?: Record<string, unknown>;
  }>(),
}));

vi.mock('bullmq', () => {
  class FakeJob {
    id: string;
    data: unknown;
    returnvalue: unknown = null;
    state = 'waiting';

    constructor(
      id: string,
      data: unknown,
      private readonly jobs: Map<string, FakeJob>,
    ) {
      this.id = id;
      this.data = data;
    }

    async getState() { return this.state; }
    async remove() { this.jobs.delete(this.id); }
    async updateData(data: unknown) { this.data = data; }
  }

  class Queue {
    private readonly store: {
      jobs: Map<string, FakeJob>;
      adds: number;
      lastOptions?: Record<string, unknown>;
    };

    constructor(readonly name: string, options: { prefix?: string } = {}) {
      const qualifiedName = `${options.prefix ?? 'bull'}:${name}`;
      let store = fakeBull.queues.get(qualifiedName);
      if (!store) {
        store = { jobs: new Map(), adds: 0 };
        fakeBull.queues.set(qualifiedName, store);
      }
      this.store = store;
    }

    async getJob(id: string) { return this.store.jobs.get(id) ?? null; }

    async getJobCounts(...states: string[]) {
      const snapshot = Object.fromEntries(states.map((state) => [state, 0]));
      for (const job of this.store.jobs.values()) {
        const key = job.state === 'waiting' ? 'wait' : job.state;
        if (key in snapshot) snapshot[key]++;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      return snapshot;
    }

    async add(_name: string, data: unknown, options: Record<string, unknown> & { jobId: string }) {
      const existing = this.store.jobs.get(options.jobId);
      if (existing) return existing;
      const job = new FakeJob(options.jobId, data, this.store.jobs);
      this.store.jobs.set(options.jobId, job);
      this.store.adds++;
      this.store.lastOptions = options;
      return job;
    }

    async close() {}
  }

  return { Queue };
});

import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardDefinition, CompileRequest, CompileResult } from '@sketchforge/core';
import type { Redis } from 'ioredis';
import { createCompileRedisNamespace } from '../src/compile-namespace.js';
import {
  DistributedCompileQueue,
  DistributedQueueBusyError,
  DistributedQueueFullError,
  bullQueueIdentityForNamespace,
  compileRequestByteLedgerKey,
  retainedCompileJobData,
  resolveCompileJobDeadlineAt,
  isReusableCompileResult,
  queueName,
  type WorkerPool,
} from '../src/distributed-queue.js';
import type {
  CompileCancellationStore,
  CompileConsumerLease,
  CompileLeaseCancellation,
} from '../src/compile-cancellation.js';

class MemoryCancellationStore implements CompileCancellationStore {
  private sequence = 0;
  private readonly rows = new Map<string, {
    marker: boolean;
    leases: Map<string, string>;
  }>();

  async acquire(jobId: string, resetCancellation = false): Promise<CompileConsumerLease | null> {
    const row = this.row(jobId);
    if (row.marker && !resetCancellation) return null;
    if (resetCancellation) row.marker = false;
    const requestId = `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, '0')}`;
    const token = `token-${String(this.sequence).padStart(64, '0')}`;
    row.leases.set(requestId, token);
    return { requestId, token, expiresAt: Date.now() + 60_000 };
  }

  async cancel(jobId: string, requestId: string, token: string): Promise<CompileLeaseCancellation> {
    const row = this.row(jobId);
    if (row.leases.get(requestId) !== token) return { found: false, remaining: row.leases.size };
    row.leases.delete(requestId);
    if (row.leases.size === 0) row.marker = true;
    return { found: true, remaining: row.leases.size };
  }

  async release(jobId: string, requestId: string, token: string): Promise<CompileLeaseCancellation> {
    const row = this.row(jobId);
    if (row.leases.get(requestId) !== token) return { found: false, remaining: row.leases.size };
    row.leases.delete(requestId);
    return { found: true, remaining: row.leases.size };
  }

  async isCancellationRequested(jobId: string): Promise<boolean> {
    const row = this.row(jobId);
    if (row.leases.size === 0) row.marker = true;
    return row.marker;
  }

  async hasCancellationMarker(jobId: string): Promise<boolean> {
    return this.row(jobId).marker;
  }

  async clear(jobId: string): Promise<void> {
    this.rows.delete(jobId);
  }

  private row(jobId: string) {
    let row = this.rows.get(jobId);
    if (!row) {
      row = { marker: false, leases: new Map() };
      this.rows.set(jobId, row);
    }
    return row;
  }
}

class FakeRedisLocks {
  private readonly locks = new Map<string, { token: string; expiresAt: number }>();
  private readonly hashes = new Map<string, Map<string, string>>();
  readonly cancellations = new MemoryCancellationStore();

  async set(key: string, token: string, _px: string, ttlMs: number, _nx: string) {
    const current = this.locks.get(key);
    if (current && current.expiresAt > Date.now()) return null;
    this.locks.set(key, { token, expiresAt: Date.now() + ttlMs });
    return 'OK';
  }

  async eval(_script: string, _keyCount: number, key: string, token: string) {
    if (this.locks.get(key)?.token !== token) return 0;
    this.locks.delete(key);
    return 1;
  }

  async hgetall(key: string) {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hset(key: string, field: string, value: string) {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    hash.set(field, value);
    this.hashes.set(key, hash);
    return 1;
  }

  async hdel(key: string, ...fields: string[]) {
    const hash = this.hashes.get(key);
    if (!hash) return 0;
    let deleted = 0;
    for (const field of fields) deleted += Number(hash.delete(field));
    if (hash.size === 0) this.hashes.delete(key);
    return deleted;
  }

  async del(...keys: string[]) {
    let deleted = 0;
    for (const key of keys) deleted += Number(this.hashes.delete(key));
    return deleted;
  }
}

const board: BoardDefinition = {
  fqbn: 'arduino:avr:uno',
  name: 'Uno',
  arch: 'avr',
  pins: [],
  options: [],
  flashTotal: 32_768,
  ramTotal: 2_048,
  upload: { protocol: 'stk500v1' },
  build: { mcu: 'atmega328p', fCpu: '16000000L', variant: 'standard', defines: [] },
};

const espBoard: BoardDefinition = {
  ...board,
  fqbn: 'esp32:esp32:esp32',
  name: 'ESP32',
  arch: 'esp32',
  build: { ...board.build, tarch: 'xtensa' },
};

function request(source: string): CompileRequest {
  return { board: board.fqbn, files: [{ name: 'main.ino', content: source }] };
}

function queue(redis: FakeRedisLocks, capacity = 10, maxQueuedRequestBytes?: number) {
  return new DistributedCompileQueue(redis as unknown as Redis, {
    namespace: createCompileRedisNamespace('test-compile', 'bundle-v1'),
    maxQueuedPerPool: capacity,
    ...(maxQueuedRequestBytes === undefined ? {} : { maxQueuedRequestBytes }),
    submissionLockWaitMs: 1_000,
    cancellationStore: redis.cancellations,
  });
}

function bullQueueKey(prefix: string, pool: WorkerPool, bundleId: string): string {
  const namespace = createCompileRedisNamespace(prefix, bundleId);
  return bullQueueIdentityForNamespace(namespace, pool).qualifiedName;
}

describe('DistributedCompileQueue behavior', () => {
  beforeEach(() => fakeBull.queues.clear());

  it('collapses the same request across gateway instances', async () => {
    const redis = new FakeRedisLocks();
    const first = queue(redis);
    const second = queue(redis);
    const fingerprint = 'a'.repeat(64);

    const results = await Promise.all([
      first.submit(board, request('void setup(){}'), fingerprint, 'bundle-v1'),
      second.submit(board, request('void setup(){}'), fingerprint, 'bundle-v1'),
    ]);

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    const store = fakeBull.queues.get(bullQueueKey('test-compile', 'avr', 'bundle-v1'))!;
    expect(store.jobs.size).toBe(1);
    expect(store.adds).toBe(1);
    expect(results[0]!.cancellation.requestId).not.toBe(results[1]!.cancellation.requestId);
  });

  it('passes explicit completed and failed retention bounds to BullMQ', async () => {
    const redis = new FakeRedisLocks();
    const compileQueue = new DistributedCompileQueue(redis as unknown as Redis, {
      namespace: createCompileRedisNamespace('test-compile', 'bundle-v1'),
      maxQueuedPerPool: 10,
      completedRetentionSeconds: 7_200,
      completedRetentionCount: 75,
      failedRetentionSeconds: 3_600,
      failedRetentionCount: 25,
      cancellationStore: redis.cancellations,
    });

    await compileQueue.submit(board, request('void setup(){}'), '8'.repeat(64), 'bundle-v1');

    const store = fakeBull.queues.get(bullQueueKey('test-compile', 'avr', 'bundle-v1'))!;
    expect(store.lastOptions).toMatchObject({
      removeOnComplete: { age: 7_200, count: 75 },
      removeOnFail: { age: 3_600, count: 25 },
    });
  });

  it('stamps one absolute deadline at gateway acceptance before queue wait', async () => {
    const redis = new FakeRedisLocks();
    const compileQueue = new DistributedCompileQueue(redis as unknown as Redis, {
      namespace: createCompileRedisNamespace('test-compile', 'bundle-v1'),
      maxQueuedPerPool: 10,
      jobWallTimeoutMs: { avr: 1_234 },
      cancellationStore: redis.cancellations,
    });

    await compileQueue.submit(
      board,
      request('void setup(){}'),
      '7'.repeat(64),
      'bundle-v1',
      true,
      10_000,
    );

    const store = fakeBull.queues.get(bullQueueKey('test-compile', 'avr', 'bundle-v1'))!;
    const data = [...store.jobs.values()][0]!.data;
    expect(data).toMatchObject({ submittedAt: 10_000, deadlineAt: 11_234 });
    expect(store.lastOptions).toMatchObject({ timestamp: 10_000 });
  });

  it('resolves rolling-upgrade jobs and never widens the worker policy', () => {
    expect(resolveCompileJobDeadlineAt({ submittedAt: 1_000 }, 500, 2_000)).toBe(1_500);
    expect(resolveCompileJobDeadlineAt({ submittedAt: 1_000, deadlineAt: 1_200 }, 500)).toBe(1_200);
    expect(resolveCompileJobDeadlineAt({ submittedAt: 1_000, deadlineAt: 9_000 }, 500)).toBe(1_500);
  });

  it('cancels only the caller lease until the last shared consumer leaves', async () => {
    const redis = new FakeRedisLocks();
    const firstGateway = queue(redis);
    const secondGateway = queue(redis);
    const fingerprint = 'e'.repeat(64);
    const first = await firstGateway.submit(board, request('void setup(){}'), fingerprint, 'bundle-v1');
    const second = await secondGateway.submit(board, request('void setup(){}'), fingerprint, 'bundle-v1');

    await expect(firstGateway.cancelRequest(
      first.id,
      first.cancellation.requestId,
      first.cancellation.token,
    )).resolves.toMatchObject({
      cancelled: true,
      jobCancelled: false,
      remainingConsumers: 1,
    });
    await expect(secondGateway.get(first.id)).resolves.not.toBeNull();

    await expect(secondGateway.cancelRequest(
      second.id,
      second.cancellation.requestId,
      second.cancellation.token,
    )).resolves.toMatchObject({
      cancelled: true,
      jobCancelled: true,
      state: 'cancelled',
      remainingConsumers: 0,
    });
    await expect(firstGateway.get(first.id)).resolves.toBeNull();
  });

  it('does not attach a new consumer to an active job already being cancelled', async () => {
    const redis = new FakeRedisLocks();
    const compileQueue = queue(redis);
    const fingerprint = 'f'.repeat(64);
    const submission = await compileQueue.submit(board, request('void setup(){}'), fingerprint, 'bundle-v1');
    const store = fakeBull.queues.get(bullQueueKey('test-compile', 'avr', 'bundle-v1'))!;
    store.jobs.get(submission.id)!.state = 'active';

    await expect(compileQueue.cancelRequest(
      submission.id,
      submission.cancellation.requestId,
      submission.cancellation.token,
    )).resolves.toMatchObject({ state: 'cancelling', jobCancelled: true });
    await expect(compileQueue.submit(
      board,
      request('void setup(){}'),
      fingerprint,
      'bundle-v1',
    )).rejects.toBeInstanceOf(DistributedQueueBusyError);
  });

  it('reuses a completed result without allocating persistent consumer leases', async () => {
    const redis = new FakeRedisLocks();
    const firstGateway = queue(redis);
    const secondGateway = queue(redis);
    const fingerprint = '9'.repeat(64);
    const initial = await firstGateway.submit(board, request('void setup(){}'), fingerprint, 'bundle-v1');
    const store = fakeBull.queues.get(bullQueueKey('test-compile', 'avr', 'bundle-v1'))!;
    const job = store.jobs.get(initial.id)!;
    job.state = 'completed';
    job.returnvalue = {
      status: 'success', artifacts: [], staticArtifacts: [], diagnostics: [], timings: {}, cached: false,
    };

    const [first, second] = await Promise.all([
      firstGateway.submit(board, request('void setup(){}'), fingerprint, 'bundle-v1'),
      secondGateway.submit(board, request('void setup(){}'), fingerprint, 'bundle-v1'),
    ]);

    expect(first).toMatchObject({ id: initial.id, reused: true });
    expect(second).toMatchObject({ id: initial.id, reused: true });
    expect(first.cancellation).toBeUndefined();
    expect(second.cancellation).toBeUndefined();
    expect(store.adds).toBe(1);
  });

  it('strictly bounds simultaneous submissions with different fingerprints', async () => {
    const redis = new FakeRedisLocks();
    const first = queue(redis, 1);
    const second = queue(redis, 1);

    const settled = await Promise.allSettled([
      first.submit(board, request('void setup(){digitalWrite(1,1);}'), 'a'.repeat(64), 'bundle-v1'),
      second.submit(board, request('void setup(){digitalWrite(2,1);}'), 'b'.repeat(64), 'bundle-v1'),
    ]);

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: expect.any(DistributedQueueFullError) });
    expect(fakeBull.queues.get(bullQueueKey('test-compile', 'avr', 'bundle-v1'))?.jobs.size).toBe(1);
  });

  it('bounds aggregate queued request bytes across gateway instances', async () => {
    const redis = new FakeRedisLocks();
    const firstRequest = request('a'.repeat(128));
    const requestBytes = Buffer.byteLength(JSON.stringify(firstRequest), 'utf8');
    const first = queue(redis, 10, requestBytes + 16);
    const second = queue(redis, 10, requestBytes + 16);

    await first.submit(board, firstRequest, '1'.repeat(64), 'bundle-v1');
    await expect(second.submit(
      board,
      request('b'.repeat(128)),
      '2'.repeat(64),
      'bundle-v1',
    )).rejects.toBeInstanceOf(DistributedQueueFullError);
  });

  it('applies the request-byte budget across worker pools', async () => {
    const redis = new FakeRedisLocks();
    const avrRequest = request('a'.repeat(128));
    const espRequest = { ...request('b'.repeat(128)), board: espBoard.fqbn };
    const requestBytes = Buffer.byteLength(JSON.stringify(avrRequest), 'utf8');
    const first = queue(redis, 10, requestBytes + 16);
    const second = queue(redis, 10, requestBytes + 16);

    const settled = await Promise.allSettled([
      first.submit(board, avrRequest, '5'.repeat(64), 'bundle-v1'),
      second.submit(espBoard, espRequest, '6'.repeat(64), 'bundle-v1'),
    ]);

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.find((result) => result.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: expect.any(DistributedQueueFullError),
    });
  });

  it('removes source from retained terminal job metadata', () => {
    const data = {
      request: request('void setup(){}'),
      requestBytes: 123,
      bundleId: 'bundle-v1',
      compileReleaseId: 'unverified-local',
      hostRuntimeIdentity: 'unverified-local',
      pool: 'avr' as const,
      submittedAt: 1,
      deadlineAt: 2,
    };
    expect(retainedCompileJobData(data)).toEqual({
      requestBytes: 0,
      bundleId: 'bundle-v1',
      compileReleaseId: 'unverified-local',
      hostRuntimeIdentity: 'unverified-local',
      pool: 'avr',
      submittedAt: 1,
      deadlineAt: 2,
    });
  });

  it('releases queued request bytes when the last consumer cancels the job', async () => {
    const redis = new FakeRedisLocks();
    const compileRequest = request('a'.repeat(128));
    const requestBytes = Buffer.byteLength(JSON.stringify(compileRequest), 'utf8');
    const compileQueue = queue(redis, 10, requestBytes + 16);
    const first = await compileQueue.submit(board, compileRequest, '3'.repeat(64), 'bundle-v1');

    await compileQueue.cancelRequest(
      first.id,
      first.cancellation.requestId,
      first.cancellation.token,
    );
    await expect(compileQueue.submit(
      board,
      request('b'.repeat(128)),
      '4'.repeat(64),
      'bundle-v1',
    )).resolves.toMatchObject({ reused: false });
  });

  it('reclaims a stale byte reservation left before Queue.add()', async () => {
    const redis = new FakeRedisLocks();
    const compileRequest = request('a'.repeat(128));
    const requestBytes = Buffer.byteLength(JSON.stringify(compileRequest), 'utf8');
    await redis.hset(
      compileRequestByteLedgerKey(createCompileRedisNamespace('test-compile', 'bundle-v1')),
      `avr_${'7'.repeat(64)}`,
      String(requestBytes),
    );
    const compileQueue = queue(redis, 10, requestBytes + 16);

    await expect(compileQueue.submit(
      board,
      compileRequest,
      '8'.repeat(64),
      'bundle-v1',
    )).resolves.toMatchObject({ reused: false });
  });

  it('reclaims and compacts a terminal job missed by the worker event', async () => {
    const redis = new FakeRedisLocks();
    const compileRequest = request('a'.repeat(128));
    const requestBytes = Buffer.byteLength(JSON.stringify(compileRequest), 'utf8');
    const compileQueue = queue(redis, 10, requestBytes + 16);
    const first = await compileQueue.submit(
      board, compileRequest, '9'.repeat(64), 'bundle-v1',
    );
    const store = fakeBull.queues.get(bullQueueKey('test-compile', 'avr', 'bundle-v1'))!;
    const terminal = store.jobs.get(first.id)!;
    terminal.state = 'completed';
    terminal.returnvalue = {
      status: 'success', artifacts: [], staticArtifacts: [], diagnostics: [], timings: {}, cached: false,
    };

    await expect(compileQueue.submit(
      board, request('b'.repeat(128)), '0'.repeat(64), 'bundle-v1',
    )).resolves.toMatchObject({ reused: false });
    expect(terminal.data).not.toHaveProperty('request');
    expect(terminal.data).toMatchObject({ requestBytes: 0 });
  });

  it('uses distinct BullMQ queues for compiler bundle revisions', () => {
    expect(queueName('compile', 'avr', 'bundle-v1')).not.toBe(queueName('compile', 'avr', 'bundle-v2'));
  });

  it('only reuses deterministic completed results', () => {
    const success: CompileResult = {
      status: 'success', artifacts: [], staticArtifacts: [], diagnostics: [], timings: {}, cached: false,
    };
    const compileError: CompileResult = {
      status: 'error', reason: 'compile_error', message: 'bad source', diagnostics: [], timings: {},
    };
    const timeout: CompileResult = {
      status: 'error', reason: 'timeout', message: 'worker timed out', diagnostics: [], timings: {},
    };
    const resourceLimit: CompileResult = {
      status: 'error', reason: 'resource_limit', message: 'firmware is too large', diagnostics: [], timings: {},
    };
    const internal: CompileResult = {
      status: 'error', reason: 'internal', message: 'worker failed', diagnostics: [], timings: {},
    };

    expect(isReusableCompileResult(success)).toBe(true);
    expect(isReusableCompileResult(compileError)).toBe(true);
    expect(isReusableCompileResult(resourceLimit)).toBe(true);
    expect(isReusableCompileResult(timeout)).toBe(false);
    expect(isReusableCompileResult(internal)).toBe(false);
  });

  it('replaces a completed transient failure instead of serving it as a cache hit', async () => {
    const redis = new FakeRedisLocks();
    const compileQueue = queue(redis);
    const fingerprint = 'c'.repeat(64);
    const first = await compileQueue.submit(board, request('void setup(){}'), fingerprint, 'bundle-v1');
    const store = fakeBull.queues.get(bullQueueKey('test-compile', 'avr', 'bundle-v1'))!;
    const job = store.jobs.get(first.id)!;
    job.state = 'completed';
    job.returnvalue = {
      status: 'error', reason: 'internal', message: 'temporary worker failure', diagnostics: [], timings: {},
    };

    const replacement = await compileQueue.submit(
      board,
      request('void setup(){}'),
      fingerprint,
      'bundle-v1',
    );
    expect(replacement.reused).toBe(false);
    expect(store.adds).toBe(2);
  });

  it('does not hide a successful admission when lock cleanup loses Redis', async () => {
    class ReleaseFailRedis extends FakeRedisLocks {
      override async eval(): Promise<number> { throw new Error('Connection is closed.'); }
    }
    const compileQueue = queue(new ReleaseFailRedis());
    await expect(compileQueue.submit(
      board,
      request('void setup(){}'),
      'd'.repeat(64),
      'bundle-v1',
    )).resolves.toMatchObject({ reused: false });
  });
});
