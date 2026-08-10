import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const workerSource = readFileSync(
  fileURLToPath(new URL('../public/avr-compiler-sw.js', import.meta.url)),
  'utf8',
);

type FetchHandler = (event: {
  request: {
    method: string;
    url: string;
    cache?: string;
    headers?: { has: (name: string) => boolean };
  };
  respondWith: (response: Promise<unknown>) => void;
  waitUntil: (work: Promise<unknown>) => void;
}) => void;

type LifecycleHandler = (event: {
  waitUntil: (work: Promise<unknown>) => void;
}) => void;

function createWorkerHarness(scope = 'https://studio.example.test/') {
  const listeners = new Map<string, FetchHandler>();
  const cache = {
    match: vi.fn(),
    put: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
  };
  const caches = {
    open: vi.fn().mockResolvedValue(cache),
    keys: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
  };
  const fetch = vi.fn();
  const self = {
    location: { origin: 'https://studio.example.test' },
    registration: { scope },
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    clients: { claim: vi.fn().mockResolvedValue(undefined) },
    addEventListener(type: string, handler: FetchHandler) { listeners.set(type, handler); },
  };

  runInNewContext(workerSource, { URL, Promise, caches, fetch, self });
  return { cache, caches, fetch, listeners, self };
}

function dispatchFetch(handler: FetchHandler, request: {
  method: string;
  url: string;
  cache?: string;
  headers?: { has: (name: string) => boolean };
}) {
  let response: Promise<unknown> | undefined;
  let background: Promise<unknown> | undefined;
  handler({
    request,
    respondWith: (value) => { response = Promise.resolve(value); },
    waitUntil: (value) => { background = Promise.resolve(value); },
  });
  return { response, background };
}

function dispatchLifecycle(handler: LifecycleHandler) {
  let background: Promise<unknown> | undefined;
  handler({
    waitUntil: (value) => { background = Promise.resolve(value); },
  });
  return background;
}

describe('AVR compiler service worker', () => {
  it('only intercepts same-origin current AVR toolchain requests', () => {
    const { listeners } = createWorkerHarness();
    const handler = listeners.get('fetch')!;

    expect(dispatchFetch(handler, {
      method: 'GET',
      url: 'https://studio.example.test/v1/compile',
    }).response).toBeUndefined();
    expect(dispatchFetch(handler, {
      method: 'POST',
      url: 'https://studio.example.test/avr/v4/tools/cc1plus.wasm',
    }).response).toBeUndefined();
    expect(dispatchFetch(handler, {
      method: 'GET',
      url: 'https://other.example.test/avr/v4/tools/cc1plus.wasm',
    }).response).toBeUndefined();
    expect(dispatchFetch(handler, {
      method: 'GET',
      url: 'https://studio.example.test/avr/v4/tools/cc1plus.wasm',
      headers: { has: (name) => name.toLowerCase() === 'range' },
    }).response).toBeUndefined();
    expect(dispatchFetch(handler, {
      method: 'GET',
      url: 'https://studio.example.test/avr/v4/assets/manifest.json',
    }).response).toBeUndefined();
    expect(dispatchFetch(handler, {
      method: 'GET',
      url: 'https://studio.example.test/avr/v4/tools/cc1plus.mjs',
    }).response).toBeUndefined();
  });

  it('does not intercept legacy AVR v2 requests', () => {
    const { caches, fetch, listeners } = createWorkerHarness();
    const handler = listeners.get('fetch')!;

    const { response, background } = dispatchFetch(handler, {
      method: 'GET',
      url: 'https://studio.example.test/avr/v2/tools/cc1plus.wasm',
    });

    expect(response).toBeUndefined();
    expect(background).toBeUndefined();
    expect(caches.open).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the current AVR cache inside a deployment path prefix', async () => {
    const { cache, fetch, listeners } = createWorkerHarness('https://studio.example.test/arduino/');
    const networkResponse = { status: 200, type: 'basic', clone: vi.fn(() => ({})) };
    cache.match.mockResolvedValue(undefined);
    cache.put.mockResolvedValue(undefined);
    fetch.mockResolvedValue(networkResponse);
    const handler = listeners.get('fetch')!;

    const matching = dispatchFetch(handler, {
      method: 'GET',
      url: 'https://studio.example.test/arduino/avr/v4/tools/cc1plus.wasm',
    });
    const root = dispatchFetch(handler, {
      method: 'GET',
      url: 'https://studio.example.test/avr/v4/tools/cc1plus.wasm',
    });

    await expect(matching.response).resolves.toBe(networkResponse);
    await expect(matching.background).resolves.toBeUndefined();
    expect(root.response).toBeUndefined();
  });

  it('deletes previous namespaces while preserving the current v3 cache', async () => {
    const { caches, listeners, self } = createWorkerHarness();
    caches.keys.mockResolvedValue([
      'sketchforge-avr-toolchain-v1',
      'sketchforge-avr-toolchain-v2',
      'arduinofast-avr-toolchain-v3',
      'sketchforge-avr-toolchain-v3',
      'unrelated-cache',
    ]);
    const handler = listeners.get('activate') as unknown as LifecycleHandler;

    const background = dispatchLifecycle(handler);

    await expect(background).resolves.toBeUndefined();
    expect(caches.delete).toHaveBeenCalledTimes(3);
    expect(caches.delete).toHaveBeenCalledWith('sketchforge-avr-toolchain-v1');
    expect(caches.delete).toHaveBeenCalledWith('sketchforge-avr-toolchain-v2');
    expect(caches.delete).toHaveBeenCalledWith('arduinofast-avr-toolchain-v3');
    expect(caches.delete).not.toHaveBeenCalledWith('sketchforge-avr-toolchain-v3');
    expect(caches.delete).not.toHaveBeenCalledWith('unrelated-cache');
    expect(self.clients.claim).toHaveBeenCalledOnce();
  });

  it('uses a previously cached toolchain response without touching the network', async () => {
    const { cache, caches, fetch, listeners } = createWorkerHarness();
    const cached = { cached: true };
    cache.match.mockResolvedValue(cached);
    const handler = listeners.get('fetch')!;

    const { response, background } = dispatchFetch(handler, {
      method: 'GET',
      url: 'https://studio.example.test/avr/v4/tools/cc1plus.wasm',
    });

    await expect(response).resolves.toBe(cached);
    await expect(background).resolves.toBeUndefined();
    expect(caches.open).toHaveBeenCalledWith('sketchforge-avr-toolchain-v3');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('caches a successful first toolchain fetch in the background', async () => {
    const { cache, fetch, listeners } = createWorkerHarness();
    const request = {
      method: 'GET',
      url: 'https://studio.example.test/avr/v4/assets/avr-toolchain-assets-deadbeef.pack',
    };
    const cachedCopy = { cachedCopy: true };
    const networkResponse = { status: 200, type: 'basic', clone: vi.fn(() => cachedCopy) };
    let finishPut: (() => void) | undefined;
    cache.match.mockResolvedValue(undefined);
    cache.put.mockImplementation(() => new Promise<void>((resolve) => { finishPut = resolve; }));
    fetch.mockResolvedValue(networkResponse);
    const handler = listeners.get('fetch')!;

    const { response, background } = dispatchFetch(handler, request);

    await expect(response).resolves.toBe(networkResponse);
    expect(cache.put).toHaveBeenCalledWith(request, cachedCopy);
    expect(finishPut).toBeTypeOf('function');
    finishPut?.();
    await expect(background).resolves.toBeUndefined();
  });

  it.each(['no-cache', 'reload'])('bypasses cached responses and refreshes them for cache mode %s', async (cacheMode) => {
    const { cache, fetch, listeners } = createWorkerHarness();
    const request = {
      method: 'GET',
      url: 'https://studio.example.test/avr/v4/tools/cc1plus.wasm',
      cache: cacheMode,
    };
    const cachedCopy = { refreshed: true };
    const networkResponse = { status: 200, type: 'basic', clone: vi.fn(() => cachedCopy) };
    cache.match.mockResolvedValue({ stale: true });
    cache.put.mockResolvedValue(undefined);
    fetch.mockResolvedValue(networkResponse);
    const handler = listeners.get('fetch')!;

    const { response, background } = dispatchFetch(handler, request);

    await expect(response).resolves.toBe(networkResponse);
    await expect(background).resolves.toBeUndefined();
    expect(cache.match).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(request);
    expect(cache.put).toHaveBeenCalledWith(request, cachedCopy);
  });

  it('falls back to the network when Cache Storage is unavailable', async () => {
    const { caches, fetch, listeners } = createWorkerHarness();
    const networkResponse = { status: 200, type: 'basic', clone: vi.fn() };
    caches.open.mockRejectedValue(new Error('storage disabled'));
    fetch.mockResolvedValue(networkResponse);
    const handler = listeners.get('fetch')!;
    const request = {
      method: 'GET',
      url: 'https://studio.example.test/avr/v4/tools/cc1plus.wasm',
    };

    const { response, background } = dispatchFetch(handler, request);

    await expect(response).resolves.toBe(networkResponse);
    await expect(background).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(request);
  });
});
