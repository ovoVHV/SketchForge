import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../src/rate-limit.js';

describe('FixedWindowRateLimiter', () => {
  it('限制单个来源并返回剩余等待时间', () => {
    const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, globalLimit: 10, keyLimit: 2 });

    expect(limiter.take('a', 100).allowed).toBe(true);
    expect(limiter.take('a', 200).allowed).toBe(true);
    expect(limiter.take('a', 300)).toEqual({ allowed: false, retryAfterMs: 800, scope: 'client' });
    expect(limiter.take('b', 300).allowed).toBe(true);
  });

  it('全局限制对所有来源共同生效', () => {
    const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, globalLimit: 2, keyLimit: 2 });

    expect(limiter.take('a', 100).allowed).toBe(true);
    expect(limiter.take('b', 200).allowed).toBe(true);
    expect(limiter.take('c', 300)).toEqual({ allowed: false, retryAfterMs: 800, scope: 'global' });
  });

  it('窗口到期后恢复额度', () => {
    const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, globalLimit: 1, keyLimit: 1 });

    expect(limiter.take('a', 100).allowed).toBe(true);
    expect(limiter.take('a', 1_099).allowed).toBe(false);
    expect(limiter.take('a', 1_100).allowed).toBe(true);
  });

  it('限制来源计数器基数，避免伪造来源撑爆内存', () => {
    const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, globalLimit: 100, keyLimit: 10, maxKeys: 2 });

    limiter.take('a', 100);
    limiter.take('b', 100);
    expect(limiter.take('c', 200)).toMatchObject({ allowed: false, scope: 'cardinality' });
    expect(limiter.trackedKeys).toBe(2);

    expect(limiter.take('c', 1_100).allowed).toBe(true);
    expect(limiter.trackedKeys).toBe(1);
  });
});
