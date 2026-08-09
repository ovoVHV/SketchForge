import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

function cancellationError(): Error {
  const error = new Error('compile capacity wait was cancelled');
  error.name = 'AbortError';
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancellationError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(cancellationError());
    };
    function finish() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export interface RedisCompileCapacityOptions {
  /** Maximum number of compiles this host may execute at once. */
  capacity: number;
  /** Token lifetime. Keep this longer than the enforced job wall timeout. */
  ttlMs: number;
  /** How long a worker may wait after BullMQ has assigned it a job. */
  maxWaitMs: number;
}

/** Raised only after an assigned worker could not obtain a host-wide slot. */
export class CompileCapacityTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super('timed out waiting for compile capacity');
    this.name = 'CompileCapacityTimeoutError';
  }
}

export type CompileCapacityWaitReporter = (waitedMs: number) => void;

// Keep queue progress useful without filling the bounded Redis event replay
// buffer during a long, intentionally conservative host-capacity wait.
const WAIT_REPORT_INTERVAL_MS = 30_000;

const CAPACITY_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/;
const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * Builds a capacity namespace shared only by worker containers on one host.
 * Operators must set a distinct host ID before spreading workers across hosts.
 */
export function compileHostCapacityKey(prefix: string, hostId: string): string {
  if (!CAPACITY_KEY_PATTERN.test(prefix)) throw new Error('invalid compile capacity key prefix');
  if (!HOST_ID_PATTERN.test(hostId)) throw new Error('invalid compile worker host id');
  return `${prefix}:v1:${hostId}`;
}

/**
 * Redis-backed, expiring capacity tokens for an explicitly configured worker
 * host. Board queues remain independent, while the shared host cannot exceed
 * its configured total number of simultaneous compiles.
 */
export class RedisCompileCapacity {
  private readonly slotKeys: readonly string[];

  constructor(
    private readonly redis: Redis,
    key: string,
    private readonly options: RedisCompileCapacityOptions,
  ) {
    if (!Number.isInteger(options.capacity) || options.capacity <= 0 || options.capacity > 64) {
      throw new Error('compile capacity must be an integer between 1 and 64');
    }
    if (!Number.isInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('compile capacity token TTL must be a positive integer');
    }
    if (!Number.isInteger(options.maxWaitMs) || options.maxWaitMs <= 0) {
      throw new Error('compile capacity wait time must be a positive integer');
    }
    this.slotKeys = Array.from(
      { length: options.capacity },
      (_unused, slot) => `${key}:slot:${slot}`,
    );
  }

  async run<T>(
    task: () => Promise<T>,
    onWaiting?: CompileCapacityWaitReporter,
    signal?: AbortSignal,
  ): Promise<T> {
    const token = randomUUID();
    const slotKey = await this.acquire(token, onWaiting, signal);
    const renew = setInterval(() => {
      // The job executor's deadline is shorter than the token TTL. A failed
      // renewal therefore cannot create overlap during a normally bounded job;
      // the TTL remains the fallback when a worker is killed.
      void this.redis.eval(RENEW_SCRIPT, 1, slotKey, token, this.options.ttlMs).catch(() => {});
    }, Math.max(1_000, Math.floor(this.options.ttlMs / 3)));
    renew.unref();

    try {
      return await task();
    } finally {
      clearInterval(renew);
      try { await this.redis.eval(RELEASE_SCRIPT, 1, slotKey, token); } catch { /* TTL is the fallback */ }
    }
  }

  private async acquire(
    token: string,
    onWaiting?: CompileCapacityWaitReporter,
    signal?: AbortSignal,
  ): Promise<string> {
    const startedAt = Date.now();
    const deadline = startedAt + this.options.maxWaitMs;
    let nextSlot = Math.floor(Math.random() * this.slotKeys.length);
    let lastReportedAt = Number.NEGATIVE_INFINITY;
    for (;;) {
      if (signal?.aborted) throw cancellationError();
      for (let offset = 0; offset < this.slotKeys.length; offset++) {
        const slotKey = this.slotKeys[(nextSlot + offset) % this.slotKeys.length]!;
        const acquired = await this.redis.set(slotKey, token, 'PX', this.options.ttlMs, 'NX');
        if (acquired === 'OK') return slotKey;
      }
      const now = Date.now();
      const waitedMs = now - startedAt;
      if (onWaiting && now - lastReportedAt >= WAIT_REPORT_INTERVAL_MS) {
        lastReportedAt = now;
        try { onWaiting(waitedMs); } catch { /* status delivery must not affect capacity control */ }
      }
      if (now >= deadline) throw new CompileCapacityTimeoutError(waitedMs);
      nextSlot = (nextSlot + 1) % this.slotKeys.length;
      await delay(200 + Math.floor(Math.random() * 100), signal);
    }
  }
}
