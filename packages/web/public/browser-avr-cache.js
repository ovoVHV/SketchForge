const DEFAULT_MODULE_URL = import.meta.url;

/**
 * Keep the service worker next to the web entrypoint so deployments under a
 * path prefix only control that application, never a wider origin by mistake.
 */
export function browserAvrCacheRegistrationConfig(moduleUrl = DEFAULT_MODULE_URL) {
  const base = new URL('./', moduleUrl);
  return {
    workerUrl: new URL('avr-compiler-sw.js', base).href,
    scope: base.pathname,
  };
}

/**
 * Registering this cache is deliberately best-effort. The compiler still has
 * its normal HTTP-cache and server-fallback paths when a browser does not
 * support service workers or storage is unavailable.
 */
export async function registerBrowserAvrCache({
  navigatorRef = globalThis.navigator,
  moduleUrl = DEFAULT_MODULE_URL,
} = {}) {
  if (typeof navigatorRef?.serviceWorker?.register !== 'function') return null;

  const { workerUrl, scope } = browserAvrCacheRegistrationConfig(moduleUrl);
  try {
    return await navigatorRef.serviceWorker.register(workerUrl, {
      scope,
      updateViaCache: 'none',
    });
  } catch {
    return null;
  }
}
