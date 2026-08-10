/*
 * The current browser AVR toolchain is published under /avr/v4/. This worker
 * caches only immutable WASM and Pack resources after they are requested.
 * It intentionally does not prefetch the roughly 25 MB toolchain and never
 * handles API, artifact, navigation, or editor requests.
 */
const CACHE_PREFIX = 'sketchforge-avr-toolchain-';
const LEGACY_CACHE_PREFIX = 'arduinofast-avr-toolchain-';
const CACHE_NAME = `${CACHE_PREFIX}v3`;
const CURRENT_AVR_PATH = new URL('avr/v4/', self.registration.scope).pathname;

function isToolchainRequest(request) {
  if (request.method !== 'GET') return false;
  if (request.headers?.has('range')) return false;

  const url = new URL(request.url);
  return url.origin === self.location.origin
    && url.pathname.startsWith(CURRENT_AVR_PATH)
    && (url.pathname.endsWith('.wasm') || url.pathname.endsWith('.pack'));
}

function isPreviousCacheName(name) {
  return name !== CACHE_NAME
    && (name.startsWith(CACHE_PREFIX) || name.startsWith(LEGACY_CACHE_PREFIX));
}

async function matchPreviousCache(request) {
  const names = await caches.keys();
  for (const name of names.filter(isPreviousCacheName)) {
    const previous = await caches.open(name);
    const response = await previous.match(request);
    if (response) return response;
  }
  return null;
}

async function migratePreviousCache(name, current) {
  const previous = await caches.open(name);
  const requests = await previous.keys();
  for (const request of requests) {
    if (!isToolchainRequest(request) || await current.match(request)) continue;
    const response = await previous.match(request);
    if (response) await current.put(request, response.clone());
  }
}

async function cacheFirst(request, finishCaching) {
  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
    const refresh = request.cache === 'no-cache' || request.cache === 'reload';
    if (!refresh) {
      const cached = await cache.match(request);
      if (cached) {
        finishCaching();
        return cached;
      }
      const previous = await matchPreviousCache(request);
      if (previous) {
        try {
          void Promise.resolve(cache.put(request, previous.clone()))
            .catch(() => {})
            .finally(finishCaching);
        } catch {
          finishCaching();
        }
        return previous;
      }
    }
  } catch {
    // Cache Storage is an optimization. A quota or privacy-mode failure must
    // not turn a successful toolchain fetch into a failed browser compile.
    finishCaching();
    return fetch(request);
  }

  try {
    const response = await fetch(request);
    if (response.status === 200 && response.type === 'basic') {
      // Keep the cache write alive without delaying streaming/instantiation of
      // the original response. A failed write simply means a later reload will
      // fetch again.
      void Promise.resolve(cache.put(request, response.clone()))
        .catch(() => {})
        .finally(finishCaching);
    } else {
      finishCaching();
    }
    return response;
  } catch (error) {
    finishCaching();
    throw error;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    let current = null;
    try { current = await caches.open(CACHE_NAME); } catch { /* preserve old caches */ }
    if (current) {
      await Promise.all(names.filter(isPreviousCacheName).map(async (name) => {
        try {
          await migratePreviousCache(name, current);
          await caches.delete(name);
        } catch { /* retry lazily on a later fetch or activation */ }
      }));
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (!isToolchainRequest(event.request)) return;

  let settled = false;
  let resolveCaching;
  const caching = new Promise((resolve) => { resolveCaching = resolve; });
  const finishCaching = () => {
    if (settled) return;
    settled = true;
    resolveCaching();
  };

  event.waitUntil(caching);
  event.respondWith(cacheFirst(event.request, finishCaching));
});
