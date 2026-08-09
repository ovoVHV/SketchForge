import { describe, expect, it, vi } from 'vitest';
import {
  browserAvrCacheRegistrationConfig,
  registerBrowserAvrCache,
} from '../public/browser-avr-cache.js';

describe('browser AVR cache registration', () => {
  it('keeps the worker scope within a path-prefixed application', () => {
    expect(browserAvrCacheRegistrationConfig('https://example.test/studio/browser-avr-cache.js')).toEqual({
      workerUrl: 'https://example.test/studio/avr-compiler-sw.js',
      scope: '/studio/',
    });
  });

  it('does nothing when service workers are unavailable', async () => {
    await expect(registerBrowserAvrCache({
      navigatorRef: {},
      moduleUrl: 'https://example.test/browser-avr-cache.js',
    })).resolves.toBeNull();
  });

  it('registers the cache worker without widening its scope', async () => {
    const registration = { scope: 'https://example.test/studio/' };
    const register = vi.fn().mockResolvedValue(registration);

    await expect(registerBrowserAvrCache({
      navigatorRef: { serviceWorker: { register } },
      moduleUrl: 'https://example.test/studio/browser-avr-cache.js',
    })).resolves.toBe(registration);

    expect(register).toHaveBeenCalledWith(
      'https://example.test/studio/avr-compiler-sw.js',
      { scope: '/studio/', updateViaCache: 'none' },
    );
  });

  it('treats registration failures as an optional-cache failure', async () => {
    const register = vi.fn().mockRejectedValue(new Error('storage disabled'));

    await expect(registerBrowserAvrCache({
      navigatorRef: { serviceWorker: { register } },
      moduleUrl: 'https://example.test/browser-avr-cache.js',
    })).resolves.toBeNull();
  });
});
