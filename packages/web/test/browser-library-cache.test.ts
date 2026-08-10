import { describe, expect, it, vi } from 'vitest';
import {
  browserLibraryPackKey,
  createBrowserLibraryCacheCoordinator,
} from '../public/browser-library-cache.js';

function selection(name = 'WiFi', revision = 'a'.repeat(64)) {
  return {
    name,
    version: '3.3.7',
    packId: `arduino-lib-${name.toLowerCase()}`,
    revision,
    manifestUrl: `https://example.test/${name}/toolchain.json`,
    artifact: 'sources',
  };
}

describe('browser library cache coordinator', () => {
  it('uses the full pinned identity as its cache key', () => {
    expect(browserLibraryPackKey(selection())).toContain('|arduino-lib-wifi|');
    expect(browserLibraryPackKey(selection('WiFi', 'b'.repeat(64)))).not.toBe(
      browserLibraryPackKey(selection()),
    );
    expect(browserLibraryPackKey({ name: 'WiFi', version: '3.3.7' })).toBeNull();
  });

  it('deduplicates concurrent shared dependency installs and remembers success', async () => {
    const install = vi.fn(async ({ selection: value }) => ({ selection: value }));
    const cache = createBrowserLibraryCacheCoordinator({ install });
    const shared = selection('BusIO');
    const [first, second] = await Promise.all([cache.ensure(shared), cache.ensure({ ...shared })]);
    expect(first).toEqual(second);
    expect(install).toHaveBeenCalledTimes(1);
    expect(cache.has(shared)).toBe(true);
    expect(cache.hasAll([shared])).toBe(true);
    await cache.ensure(shared);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('allows a failed Pack to be retried', async () => {
    const install = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ cached: true });
    const cache = createBrowserLibraryCacheCoordinator({ install });
    await expect(cache.ensure(selection())).rejects.toThrow('network');
    expect(cache.has(selection())).toBe(false);
    await cache.ensure(selection());
    expect(install).toHaveBeenCalledTimes(2);
    expect(cache.has(selection())).toBe(true);
  });

  it('restores exact installed selections from CacheStorage metadata', () => {
    const cache = createBrowserLibraryCacheCoordinator({ install: vi.fn() });
    const installed = selection();
    cache.remember([{ selection: installed }]);
    expect(cache.has(installed)).toBe(true);
    expect(cache.has(selection('WiFi', 'b'.repeat(64)))).toBe(false);
  });
});
