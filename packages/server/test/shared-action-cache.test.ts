import { describe, expect, it } from 'vitest';
import { MemoryActionCache, sha256Hex, type ActionCacheEntry } from '@arduinofast/core';
import { RedisActionCache, TieredActionCache } from '../src/shared-action-cache.js';

class FakeRedis {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async set(key: string, value: string): Promise<'OK'> { this.values.set(key, value); return 'OK'; }
}

function entry(): ActionCacheEntry {
  const bytes = new TextEncoder().encode('shared action output');
  return {
    actionKey: 'a'.repeat(64),
    outputs: [{ path: 'build/out.o', bytes, sha256: sha256Hex(bytes) }],
    diagnostics: [{
      severity: 'warning', file: 'src/main.cpp', line: 1, message: 'shared warning',
      sourceFile: 'src/main.cpp', sourceLine: 1, fromGenerated: false,
    }],
  };
}

describe('Redis Action cache', () => {
  it('round-trips verified content and uses a namespace', async () => {
    const redis = new FakeRedis();
    const cache = new RedisActionCache(redis as never, { namespace: 'test-bundle' });
    await cache.put(entry());
    expect([...redis.values.keys()][0]).toBe(`test-bundle:action:${'a'.repeat(64)}`);
    await expect(cache.get('a'.repeat(64))).resolves.toMatchObject({
      actionKey: 'a'.repeat(64),
      diagnostics: [expect.objectContaining({ message: 'shared warning' })],
    });
  });

  it('treats corrupted remote bytes as a miss', async () => {
    const redis = new FakeRedis();
    const cache = new RedisActionCache(redis as never, { namespace: 'test-bundle' });
    const key = `test-bundle:action:${'a'.repeat(64)}`;
    redis.values.set(key, JSON.stringify({
      schema: 1,
      actionKey: 'a'.repeat(64),
      outputs: [{ path: 'build/out.o', sha256: 'b'.repeat(64), bytes: 'bad' }],
    }));
    await expect(cache.get('a'.repeat(64))).resolves.toBeNull();
  });

  it('fills the local tier after a remote hit', async () => {
    const local = new MemoryActionCache();
    const redis = new FakeRedis();
    const remote = new RedisActionCache(redis as never, { namespace: 'test-bundle' });
    await remote.put(entry());
    const tiered = new TieredActionCache(local, remote);
    await expect(tiered.get('a'.repeat(64))).resolves.toBeTruthy();
    await expect(local.get('a'.repeat(64))).resolves.toBeTruthy();
  });
});
