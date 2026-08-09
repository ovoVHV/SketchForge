import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisCompileCapacity, compileHostCapacityKey } from '../src/compile-lease.js';

class FakeRedis {
  private readonly entries = new Map<string, { token: string; expiresAt: number }>();

  async set(key: string, token: string, _mode: 'PX', ttlMs: number, _condition: 'NX') {
    const current = this.entries.get(key);
    if (current && current.expiresAt > Date.now()) return null;
    this.entries.set(key, { token, expiresAt: Date.now() + ttlMs });
    return 'OK';
  }

  async eval(script: string, _keyCount: number, key: string, token: string, ttlMs?: number) {
    const current = this.entries.get(key);
    if (!current || current.token !== token) return 0;
    if (script.includes('PEXPIRE')) {
      this.entries.set(key, { token, expiresAt: Date.now() + (ttlMs ?? 0) });
      return 1;
    }
    this.entries.delete(key);
    return 1;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => { resolve = done; }),
    resolve: () => resolve(),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('RedisCompileCapacity', () => {
  it('names capacity separately for each worker host', () => {
    expect(compileHostCapacityKey('af:compile-capacity', 'worker-a'))
      .toBe('af:compile-capacity:v1:worker-a');
    expect(compileHostCapacityKey('af:compile-capacity', 'worker-a'))
      .not.toBe(compileHostCapacityKey('af:compile-capacity', 'worker-b'));
    expect(() => compileHostCapacityKey('af:compile-capacity', 'bad host')).toThrow(/host id/);
  });

  it('allows up to the configured number of jobs on one host', async () => {
    const redis = new FakeRedis();
    const capacity = new RedisCompileCapacity(
      redis as unknown as Redis,
      compileHostCapacityKey('af:compile-capacity', 'worker-a'),
      { capacity: 2, ttlMs: 10_000, maxWaitMs: 1_000 },
    );
    const release = deferred();
    const bothStarted = deferred();
    let active = 0;
    let peakActive = 0;

    const run = () => capacity.run(async () => {
      active++;
      peakActive = Math.max(peakActive, active);
      if (active === 2) bothStarted.resolve();
      await release.promise;
      active--;
    });

    const first = run();
    const second = run();
    await bothStarted.promise;
    expect(peakActive).toBe(2);
    release.resolve();
    await Promise.all([first, second]);
  });

  it('does not throttle workers running on different configured hosts', async () => {
    const redis = new FakeRedis();
    const firstHost = new RedisCompileCapacity(
      redis as unknown as Redis,
      compileHostCapacityKey('af:compile-capacity', 'worker-a'),
      { capacity: 1, ttlMs: 10_000, maxWaitMs: 1_000 },
    );
    const secondHost = new RedisCompileCapacity(
      redis as unknown as Redis,
      compileHostCapacityKey('af:compile-capacity', 'worker-b'),
      { capacity: 1, ttlMs: 10_000, maxWaitMs: 1_000 },
    );
    const release = deferred();
    const bothStarted = deferred();
    let active = 0;

    const run = (capacity: RedisCompileCapacity) => capacity.run(async () => {
      active++;
      if (active === 2) bothStarted.resolve();
      await release.promise;
      active--;
    });

    const first = run(firstHost);
    const second = run(secondHost);
    await bothStarted.promise;
    release.resolve();
    await Promise.all([first, second]);
  });

  it('does not let one host consume more than its configured token count', async () => {
    const redis = new FakeRedis();
    const capacity = new RedisCompileCapacity(
      redis as unknown as Redis,
      compileHostCapacityKey('af:compile-capacity', 'worker-a'),
      { capacity: 1, ttlMs: 10_000, maxWaitMs: 1_000 },
    );
    const releaseFirst = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    let secondRan = false;

    const first = capacity.run(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;

    const second = capacity.run(async () => {
      secondRan = true;
      secondStarted.resolve();
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondRan).toBe(false);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    await secondStarted.promise;
  });

  it('reports a host-capacity wait before the assigned job begins', async () => {
    const redis = new FakeRedis();
    const capacity = new RedisCompileCapacity(
      redis as unknown as Redis,
      compileHostCapacityKey('af:compile-capacity', 'worker-a'),
      { capacity: 1, ttlMs: 10_000, maxWaitMs: 1_000 },
    );
    const release = deferred();
    const firstStarted = deferred();
    const reports: number[] = [];

    const first = capacity.run(async () => {
      firstStarted.resolve();
      await release.promise;
    });
    await firstStarted.promise;

    const second = capacity.run(async () => {}, (waitedMs) => reports.push(waitedMs));
    await waitFor(() => reports.length > 0);
    expect(reports[0]).toBeGreaterThanOrEqual(0);

    release.resolve();
    await Promise.all([first, second]);
  });

  it('stops waiting for host capacity when the compile request is cancelled', async () => {
    const redis = new FakeRedis();
    const capacity = new RedisCompileCapacity(
      redis as unknown as Redis,
      compileHostCapacityKey('af:compile-capacity', 'worker-a'),
      { capacity: 1, ttlMs: 10_000, maxWaitMs: 10_000 },
    );
    const release = deferred();
    const firstStarted = deferred();
    const first = capacity.run(async () => {
      firstStarted.resolve();
      await release.promise;
    });
    await firstStarted.promise;

    const controller = new AbortController();
    let secondRan = false;
    const second = capacity.run(async () => { secondRan = true; }, undefined, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(secondRan).toBe(false);

    release.resolve();
    await first;
  });
});
