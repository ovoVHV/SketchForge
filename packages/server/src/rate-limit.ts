export interface FixedWindowRateLimiterOptions {
  windowMs: number;
  globalLimit: number;
  keyLimit: number;
  maxKeys?: number;
}

interface Counter {
  windowStartedAt: number;
  count: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
  scope?: 'global' | 'client' | 'cardinality';
}

/**
 * 进程内固定窗口准入器。
 *
 * 它位于编译队列之前，用来挡住缓存命中风暴和单来源刷队列。多实例部署时
 * 仍需把同一规则下沉到 API 网关或 Redis；这里的职责是保证单机不会裸奔。
 */
export class FixedWindowRateLimiter {
  private readonly counters = new Map<string, Counter>();
  private readonly global: Counter = { windowStartedAt: 0, count: 0 };
  private readonly maxKeys: number;

  constructor(private readonly opts: FixedWindowRateLimiterOptions) {
    if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) throw new Error('windowMs 必须大于 0');
    if (!Number.isFinite(opts.globalLimit) || opts.globalLimit <= 0) throw new Error('globalLimit 必须大于 0');
    if (!Number.isFinite(opts.keyLimit) || opts.keyLimit <= 0) throw new Error('keyLimit 必须大于 0');
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  take(key: string, now = Date.now()): RateLimitDecision {
    this.rotate(this.global, now);

    let counter = this.counters.get(key);
    if (!counter) {
      if (this.counters.size >= this.maxKeys) this.pruneExpired(now);
      if (this.counters.size >= this.maxKeys) {
        return { allowed: false, retryAfterMs: this.opts.windowMs, scope: 'cardinality' };
      }
      counter = { windowStartedAt: now, count: 0 };
      this.counters.set(key, counter);
    } else {
      this.rotate(counter, now);
    }

    if (this.global.count >= this.opts.globalLimit) {
      return {
        allowed: false,
        retryAfterMs: this.retryAfter(this.global, now),
        scope: 'global',
      };
    }
    if (counter.count >= this.opts.keyLimit) {
      return {
        allowed: false,
        retryAfterMs: this.retryAfter(counter, now),
        scope: 'client',
      };
    }

    this.global.count++;
    counter.count++;
    return { allowed: true, retryAfterMs: 0 };
  }

  get trackedKeys(): number {
    return this.counters.size;
  }

  private rotate(counter: Counter, now: number): void {
    if (counter.windowStartedAt === 0 || now - counter.windowStartedAt >= this.opts.windowMs) {
      counter.windowStartedAt = now;
      counter.count = 0;
    }
  }

  private retryAfter(counter: Counter, now: number): number {
    return Math.max(1, counter.windowStartedAt + this.opts.windowMs - now);
  }

  private pruneExpired(now: number): void {
    for (const [key, counter] of this.counters) {
      if (now - counter.windowStartedAt >= this.opts.windowMs) this.counters.delete(key);
    }
  }
}
