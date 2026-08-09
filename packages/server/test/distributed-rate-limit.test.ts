import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisCompileRateLimiter } from '../src/distributed-rate-limit.js';

class FakeRedisRateStore {
  readonly counters = new Map<string, number>();

  async eval(_script: string, keyCount: number, ...args: Array<string | number>): Promise<number> {
    const keys = args.slice(0, keyCount).map(String);
    const [cost, globalLimit, ipLimit, visitorLimit] = args.slice(keyCount).map(Number);
    const limits = [globalLimit!, ipLimit!, visitorLimit!];
    if (keys.some((key, index) => (this.counters.get(key) ?? 0) + cost! > limits[index]!)) return 0;
    for (const key of keys) this.counters.set(key, (this.counters.get(key) ?? 0) + cost!);
    return 1;
  }
}

describe('RedisCompileRateLimiter', () => {
  it('charges weighted CPU units and does not let rejected requests burn global capacity', async () => {
    const redis = new FakeRedisRateStore();
    const limiter = new RedisCompileRateLimiter(redis as unknown as Redis, {
      // Keep the bucket stable for the duration of this weighted-cost test.
      windowMs: 60 * 60_000,
      globalLimit: 10,
      ipLimit: 10,
      visitorLimit: 4,
      keySalt: 'test-only',
    });

    expect((await limiter.take('192.0.2.1', 'visitor-0000000001', 3)).allowed).toBe(true);
    expect((await limiter.take('192.0.2.1', 'visitor-0000000001', 2)).allowed).toBe(false);
    expect((await limiter.take('192.0.2.2', 'visitor-0000000002', 4)).allowed).toBe(true);
    expect((await limiter.take('192.0.2.3', 'visitor-0000000003', 3)).allowed).toBe(true);

    const global = [...redis.counters.entries()].find(([key]) => key.includes(':global:'));
    expect(global?.[1]).toBe(10);
  });

  it('rejects invalid costs before touching Redis', async () => {
    const redis = new FakeRedisRateStore();
    const limiter = new RedisCompileRateLimiter(redis as unknown as Redis);
    await expect(limiter.take('192.0.2.1', undefined, 0)).rejects.toThrow(/positive integer/);
    expect(redis.counters.size).toBe(0);
  });

  it('rejects nonsensical limiter configuration', () => {
    const redis = new FakeRedisRateStore();
    expect(() => new RedisCompileRateLimiter(redis as unknown as Redis, { globalLimit: 0 }))
      .toThrow(/globalLimit/);
  });
});
