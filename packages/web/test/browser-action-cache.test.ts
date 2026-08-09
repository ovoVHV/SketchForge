import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BrowserActionCache,
  BrowserCacheStorageActionCache,
} from '../public/ck-browser-executor.js';

function entry(key: string, size = 4) {
  return {
    actionKey: key,
    outputs: [{
      path: `${key}.o`,
      sha256: key.padEnd(64, '0').slice(0, 64),
      bytes: new Uint8Array(size).fill(key.charCodeAt(0)),
    }],
  };
}

class FakeCache {
  readonly entries = new Map<string, Response>();

  async match(input: RequestInfo | URL) {
    return this.entries.get(String(input instanceof Request ? input.url : input))?.clone();
  }

  async put(input: RequestInfo | URL, response: Response) {
    const url = String(input instanceof Request ? input.url : input);
    this.entries.set(url, response.clone());
  }

  async delete(input: RequestInfo | URL) {
    return this.entries.delete(String(input instanceof Request ? input.url : input));
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

class FakeLockManager {
  readonly requests: Array<{ name: string; mode: string | undefined }> = [];
  readonly queues = new Map<string, Promise<void>>();

  request<T>(
    name: string,
    options: { mode?: string },
    callback: () => Promise<T> | T,
  ): Promise<T> {
    this.requests.push({ name, mode: options.mode });
    const previous = this.queues.get(name) ?? Promise.resolve();
    const result = previous.then(callback);
    this.queues.set(name, result.then(() => undefined, () => undefined));
    return result;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('browser Action cache limits', () => {
  it('evicts the least recently used in-memory entry', async () => {
    const cache = new BrowserActionCache({ maxEntries: 2, maxTotalBytes: 1_024, maxEntryBytes: 512 });
    await cache.put(entry('a'));
    await cache.put(entry('b'));
    await cache.get('a');
    await cache.put(entry('c'));

    await expect(cache.get('a')).resolves.not.toBeNull();
    await expect(cache.get('b')).resolves.toBeNull();
    await expect(cache.get('c')).resolves.not.toBeNull();
  });

  it('does not retain an entry larger than its byte quota', async () => {
    const cache = new BrowserActionCache({ maxEntries: 4, maxTotalBytes: 128, maxEntryBytes: 64 });
    await cache.put(entry('a', 256));
    await expect(cache.get('a')).resolves.toBeNull();
  });

  it('persists the LRU index and prunes CacheStorage across instances', async () => {
    const storage = new FakeCache();
    vi.stubGlobal('caches', { open: async () => storage });
    const limits = { maxEntries: 2, maxTotalBytes: 4_096, maxEntryBytes: 2_048 };
    const first = new BrowserCacheStorageActionCache('bounded-actions', limits);
    await first.put(entry('a'));
    await first.put(entry('b'));
    await first.get('a');
    await first.put(entry('c'));

    const restored = new BrowserCacheStorageActionCache('bounded-actions', limits);
    await expect(restored.get('a')).resolves.not.toBeNull();
    await expect(restored.get('b')).resolves.toBeNull();
    await expect(restored.get('c')).resolves.not.toBeNull();
  });

  it('serializes same-name CacheStorage updates and refreshes the index inside the lock', async () => {
    const storage = new FakeCache();
    const locks = new FakeLockManager();
    vi.stubGlobal('caches', { open: async () => storage });
    vi.stubGlobal('navigator', { locks });
    const limits = { maxEntries: 4, maxTotalBytes: 4_096, maxEntryBytes: 2_048 };
    const first = new BrowserCacheStorageActionCache('shared-actions', limits);
    const second = new BrowserCacheStorageActionCache('shared-actions', limits);

    await Promise.all([first.get('missing-a'), second.get('missing-b')]);
    await Promise.all([first.put(entry('a')), second.put(entry('b'))]);

    const response = await storage.match('https://ck.invalid/__ck_action_cache_index_v1__');
    const index = await response?.json() as { entries?: Array<{ key: string }> } | undefined;
    expect(index?.entries?.map(({ key }) => key)).toEqual(['a', 'b']);
    expect(new Set(locks.requests.map(({ name }) => name))).toEqual(
      new Set(['ck-browser-action-cache:shared-actions']),
    );
    expect(locks.requests.every(({ mode }) => mode === 'exclusive')).toBe(true);
  });
});
