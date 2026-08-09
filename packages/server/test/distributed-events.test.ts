import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { createCompileRedisNamespace } from '../src/compile-namespace.js';
import { compileEventKeys, RedisCompileEventStore } from '../src/distributed-events.js';

class FakeEventRedis {
  private readonly numbers = new Map<string, number>();
  private readonly strings = new Map<string, string>();
  readonly lists = new Map<string, string[]>();

  async eval(script: string, keyCount: number, ...values: string[]) {
    const [list, sequence, terminal] = values.slice(0, keyCount);
    const args = values.slice(keyCount);
    if (!list || !sequence || !terminal) throw new Error('missing script keys');

    if (script.includes('local found = 0')) {
      const existing = this.strings.get(terminal);
      const rows = this.lists.get(list) ?? [];
      const retained = existing
        ? rows.filter((row) => row !== existing)
        : rows.filter((row) => {
          try {
            const decoded = JSON.parse(row) as { event?: { event?: string } };
            return decoded.event?.event !== 'done';
          } catch {
            return true;
          }
        });
      const removed = rows.length - retained.length;
      const found = Boolean(existing) || removed > 0;
      if (found) {
        this.lists.delete(list);
        this.numbers.delete(sequence);
        this.strings.delete(terminal);
      }
      return Number(found);
    }

    if (script.includes('local existing')) {
      const existing = this.strings.get(terminal);
      if (existing) {
        const rows = this.lists.get(list) ?? [];
        if (!rows.includes(existing)) this.lists.set(list, [...rows, existing]);
        return existing;
      }
      const encoded = this.appendEnvelope(list, sequence, args);
      this.strings.set(terminal, encoded);
      return encoded;
    }

    if (this.strings.has(terminal)) throw new Error('compile event stream is already terminal');
    return this.appendEnvelope(list, sequence, args);
  }

  async lrange(key: string) { return this.lists.get(key) ?? []; }

  async del(...keys: string[]) {
    let removed = 0;
    for (const key of keys) {
      removed += Number(this.lists.delete(key));
      removed += Number(this.numbers.delete(key));
      removed += Number(this.strings.delete(key));
    }
    return removed;
  }

  private appendEnvelope(list: string, sequence: string, args: string[]): string {
    const value = (this.numbers.get(sequence) ?? 0) + 1;
    this.numbers.set(sequence, value);
    const encoded = JSON.stringify({ id: String(value), event: JSON.parse(args[0]!) });
    if (Buffer.byteLength(encoded, 'utf8') > Number(args[3])) throw new Error('compile event exceeds byte limit');
    const rows = [...(this.lists.get(list) ?? []), encoded];
    this.lists.set(list, rows.slice(-Number(args[2])));
    return encoded;
  }
}

describe('RedisCompileEventStore', () => {
  it('keeps a bounded ordered replay buffer and ignores corrupt rows', async () => {
    const redis = new FakeEventRedis();
    const namespace = createCompileRedisNamespace('test-compile', 'bundle-v1');
    const store = new RedisCompileEventStore(redis as unknown as Redis, { namespace, maxEvents: 2 });
    const jobId = 'avr_' + 'a'.repeat(64);
    await store.append(jobId, { event: 'progress', stage: 'queued', percent: 0 });
    await store.append(jobId, { event: 'progress', stage: 'compiling', percent: 50 });
    await store.append(jobId, { event: 'progress', stage: 'linking', percent: 80 });
    redis.lists.get(compileEventKeys(namespace, jobId).list)!.push('{');

    const replay = await store.list(jobId, '1');
    expect(replay.map((event) => event.id)).toEqual(['2', '3']);
  });

  it('rejects oversized events and unsafe job IDs', async () => {
    const redis = new FakeEventRedis();
    const store = new RedisCompileEventStore(redis as unknown as Redis, {
      namespace: createCompileRedisNamespace('test-compile', 'bundle-v1'),
      maxEventBytes: 128,
    });
    await expect(store.append('../job', { event: 'progress', stage: 'queued', percent: 0 }))
      .rejects.toThrow(/invalid compile job id/);
    await expect(store.append('safe-job', {
      event: 'progress', stage: 'queued', percent: 0, detail: 'x'.repeat(256),
    })).rejects.toThrow(/exceeds/);
  });

  it('atomically commits one terminal frame under concurrent recovery', async () => {
    const redis = new FakeEventRedis();
    const namespace = createCompileRedisNamespace('test-compile', 'bundle-v1');
    const store = new RedisCompileEventStore(redis as unknown as Redis, { namespace });
    const jobId = 'avr_' + 'b'.repeat(64);
    const result = {
      status: 'error' as const,
      reason: 'cancelled' as const,
      message: 'cancelled',
      diagnostics: [],
      timings: {},
    };

    const recovered = await Promise.all(Array.from({ length: 12 }, () => (
      store.appendTerminal(jobId, result)
    )));

    expect(new Set(recovered.map((event) => event.id))).toEqual(new Set(['1']));
    expect(await store.list(jobId)).toHaveLength(1);
    expect((await store.list(jobId))[0]?.event).toEqual({ event: 'done', result });
    await expect(store.append(jobId, { event: 'progress', stage: 'linking', percent: 90 }))
      .rejects.toThrow(/already terminal/);
    await expect(store.append(jobId, { event: 'done', result }))
      .rejects.toThrow(/terminal compile events/);
  });

  it('clears the complete event generation before a BullMQ retry', async () => {
    const redis = new FakeEventRedis();
    const namespace = createCompileRedisNamespace('test-compile', 'bundle-v1');
    const store = new RedisCompileEventStore(redis as unknown as Redis, { namespace });
    const jobId = 'avr_' + 'c'.repeat(64);
    await store.append(jobId, { event: 'progress', stage: 'compiling', percent: 50 });
    await store.appendTerminal(jobId, {
      status: 'error', reason: 'internal', message: 'failed', diagnostics: [], timings: {},
    });

    await expect(store.resetTerminal(jobId)).resolves.toBe(true);
    await expect(store.list(jobId)).resolves.toEqual([]);
    await expect(store.resetTerminal(jobId)).resolves.toBe(false);
    await expect(store.append(jobId, { event: 'progress', stage: 'queued', percent: 0 }))
      .resolves.toMatchObject({ id: '1' });

    const keys = compileEventKeys(namespace, jobId);
    await store.clear(jobId);
    expect(redis.lists.has(keys.list)).toBe(false);
  });
});
