import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import {
  RedisCompileCancellationStore,
  compileCancellationNamespace,
} from '../src/compile-cancellation.js';
import { createCompileRedisNamespace } from '../src/compile-namespace.js';

class FakeRedis {
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly zsets = new Map<string, Map<string, number>>();
  private readonly strings = new Map<string, { value: string; expiresAt: number }>();

  async eval(script: string, keyCount: number, ...values: Array<string | number>): Promise<unknown> {
    const keys = values.slice(0, keyCount).map(String);
    const args = values.slice(keyCount).map(String);
    if (keyCount === 3 && script.includes("ARGV[6] ~= '1'")) {
      const [requests, expirations, cancelled] = keys as [string, string, string];
      const [now, expiresAt, requestId, tokenHash, ttlMs, reset, maxConsumers] = args;
      if (this.hasString(cancelled) && reset !== '1') return 0;
      this.removeExpired(requests, expirations, Number(now));
      if (this.zset(expirations).size >= Number(maxConsumers)) return -1;
      this.hash(requests).set(requestId!, tokenHash!);
      this.zset(expirations).set(requestId!, Number(expiresAt));
      if (reset === '1') this.strings.delete(cancelled);
      void ttlMs;
      return this.zset(expirations).size;
    }
    if (keyCount === 3 && script.includes("ARGV[4])") && script.includes('local actual')) {
      const [requests, expirations, cancelled] = keys as [string, string, string];
      const [now, requestId, tokenHash, ttlMs] = args;
      this.removeExpired(requests, expirations, Number(now));
      if (this.hash(requests).get(requestId!) !== tokenHash) {
        return [0, this.zset(expirations).size];
      }
      this.hash(requests).delete(requestId!);
      this.zset(expirations).delete(requestId!);
      const remaining = this.zset(expirations).size;
      if (remaining === 0) {
        this.strings.set(cancelled, { value: '1', expiresAt: Date.now() + Number(ttlMs) });
      }
      return [1, remaining];
    }
    if (keyCount === 3 && script.includes("redis.call('EXISTS', KEYS[3])")) {
      const [requests, expirations, cancelled] = keys as [string, string, string];
      const [now, ttlMs] = args;
      if (this.hasString(cancelled)) return 1;
      this.removeExpired(requests, expirations, Number(now));
      if (this.zset(expirations).size === 0) {
        this.strings.set(cancelled, { value: '1', expiresAt: Date.now() + Number(ttlMs) });
        return 1;
      }
      return 0;
    }
    if (keyCount === 2 && script.includes('local actual')) {
      const [requests, expirations] = keys as [string, string];
      const [now, requestId, tokenHash] = args;
      this.removeExpired(requests, expirations, Number(now));
      if (this.hash(requests).get(requestId!) !== tokenHash) {
        return [0, this.zset(expirations).size];
      }
      this.hash(requests).delete(requestId!);
      this.zset(expirations).delete(requestId!);
      return [1, this.zset(expirations).size];
    }
    throw new Error('unexpected Lua script');
  }

  async exists(key: string): Promise<number> {
    return this.hasString(key) ? 1 : 0;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.hashes.delete(key)) removed++;
      if (this.zsets.delete(key)) removed++;
      if (this.strings.delete(key)) removed++;
    }
    return removed;
  }

  private hash(key: string): Map<string, string> {
    let value = this.hashes.get(key);
    if (!value) {
      value = new Map();
      this.hashes.set(key, value);
    }
    return value;
  }

  private zset(key: string): Map<string, number> {
    let value = this.zsets.get(key);
    if (!value) {
      value = new Map();
      this.zsets.set(key, value);
    }
    return value;
  }

  private hasString(key: string): boolean {
    const value = this.strings.get(key);
    if (!value) return false;
    if (value.expiresAt <= Date.now()) {
      this.strings.delete(key);
      return false;
    }
    return true;
  }

  private removeExpired(requests: string, expirations: string, now: number): void {
    for (const [requestId, expiresAt] of this.zset(expirations)) {
      if (expiresAt > now) continue;
      this.zset(expirations).delete(requestId);
      this.hash(requests).delete(requestId);
    }
  }
}

function store(redis = new FakeRedis(), leaseTtlMs = 60_000, maxConsumersPerJob = 1_024) {
  return new RedisCompileCancellationStore(redis as unknown as Redis, {
    namespace: createCompileRedisNamespace('test-compile', 'bundle-v1'),
    leaseTtlMs,
    maxConsumersPerJob,
  });
}

describe('RedisCompileCancellationStore', () => {
  it('names leases by queue prefix and compiler bundle', () => {
    expect(compileCancellationNamespace(createCompileRedisNamespace('compile', 'bundle-v1')))
      .not.toBe(compileCancellationNamespace(createCompileRedisNamespace('compile', 'bundle-v2')));
    expect(() => createCompileRedisNamespace('bad prefix', 'bundle-v1')).toThrow(/prefix/);
  });

  it('marks cancellation only after the last authenticated consumer leaves', async () => {
    const cancellations = store();
    const jobId = `avr_${'a'.repeat(64)}`;
    const first = await cancellations.acquire(jobId, true);
    const second = await cancellations.acquire(jobId);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    await expect(cancellations.cancel(jobId, first!.requestId, 'x'.repeat(43)))
      .resolves.toEqual({ found: false, remaining: 2 });
    await expect(cancellations.cancel(jobId, first!.requestId, first!.token))
      .resolves.toEqual({ found: true, remaining: 1 });
    await expect(cancellations.isCancellationRequested(jobId)).resolves.toBe(false);
    await expect(cancellations.cancel(jobId, second!.requestId, second!.token))
      .resolves.toEqual({ found: true, remaining: 0 });
    await expect(cancellations.isCancellationRequested(jobId)).resolves.toBe(true);
    await expect(cancellations.acquire(jobId)).resolves.toBeNull();
    await expect(cancellations.acquire(jobId, true)).resolves.not.toBeNull();
  });

  it('releases a completed request without creating a cancellation marker', async () => {
    const cancellations = store();
    const jobId = `avr_${'b'.repeat(64)}`;
    const lease = await cancellations.acquire(jobId, true);
    await expect(cancellations.release(jobId, lease!.requestId, lease!.token))
      .resolves.toEqual({ found: true, remaining: 0 });
    await expect(cancellations.hasCancellationMarker(jobId)).resolves.toBe(false);
  });

  it('treats a job with only expired leases as cancelled', async () => {
    const cancellations = store(new FakeRedis(), 5);
    const jobId = `avr_${'c'.repeat(64)}`;
    await cancellations.acquire(jobId, true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await expect(cancellations.isCancellationRequested(jobId)).resolves.toBe(true);
  });

  it('bounds the number of active consumers attached to one job', async () => {
    const cancellations = store(new FakeRedis(), 60_000, 2);
    const jobId = `avr_${'d'.repeat(64)}`;
    await expect(cancellations.acquire(jobId, true)).resolves.not.toBeNull();
    await expect(cancellations.acquire(jobId)).resolves.not.toBeNull();
    await expect(cancellations.acquire(jobId)).resolves.toBeNull();
  });
});
