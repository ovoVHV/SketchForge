import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { decodePackArtifact } from '../../../scripts/publish-ck-platform-manifests.mjs';
import { ESP32_BROWSER_RELEASE } from '../public/esp32/v1/release.js';
import {
  loadEsp32BrowserPlatformManifest,
  loadEsp32BrowserPlatformRegistry,
  validateEsp32BrowserPlatformRegistry,
} from '../public/esp32/v1/platform-registry.js';

const releaseUrl = new URL('../public/esp32/v1/release.js', import.meta.url);
const registryUrl = new URL('../public/esp32/v1/platform-manifests/registry.json', import.meta.url);
const c3DescriptorUrl = new URL('../public/esp32/v2/runtime/runtime.json', import.meta.url);

async function localFetch(input: URL | string) {
  const url = new URL(String(input));
  return new Response(await readFile(fileURLToPath(url)), { status: 200 });
}

async function loadPublishedRegistry(fetchFn = vi.fn(localFetch)) {
  return loadEsp32BrowserPlatformRegistry({
    release: ESP32_BROWSER_RELEASE,
    baseUrl: releaseUrl,
    fetchFn,
    cryptoRef: webcrypto,
  });
}

describe('ESP32 browser Platform registry', () => {
  it('loads the release-pinned registry and its C3 Manifest', async () => {
    const fetchFn = vi.fn(localFetch);
    const registry = await loadPublishedRegistry(fetchFn);
    expect(registry.registryUrl).toBe(registryUrl.href);
    expect(registry.entries.map((entry: { fqbn: string }) => entry.fqbn)).toEqual([
      'esp32:esp32:esp32',
      'esp32:esp32:esp32c3',
      'esp32:esp32:esp32c6',
      'esp32:esp32:esp32s2',
      'esp32:esp32:esp32s3',
    ]);

    const descriptor = JSON.parse(await readFile(fileURLToPath(c3DescriptorUrl), 'utf8'));
    const sdkPack = descriptor.packs.find((pack: { role: string }) => pack.role === 'sdk');
    const compilerPack = descriptor.packs.find((pack: { role: string }) => pack.role === 'compiler');
    const loaded = await loadEsp32BrowserPlatformManifest({
      registry,
      fqbn: descriptor.board,
      sdkPack,
      fetchFn,
      cryptoRef: webcrypto,
    });
    expect(loaded).toMatchObject({
      entry: {
        fqbn: descriptor.board,
        sdkPack: { id: sdkPack.id, revision: sdkPack.revision },
      },
      manifest: {
        kind: 'ck-platform-pack',
        id: 'espressif-arduino',
        version: '3.3.7',
        tools: [],
      },
    });
    const sdkManifestUrl = new URL(sdkPack.manifest, c3DescriptorUrl);
    const sdkManifest = JSON.parse(await readFile(fileURLToPath(sdkManifestUrl), 'utf8'));
    const profile = JSON.parse(decodePackArtifact(
      sdkManifest,
      'profile-v5',
      fileURLToPath(sdkManifestUrl),
    ).toString('utf8'));
    expect(profile.sdkVariant.compilerPack).toMatchObject({
      id: compilerPack.id,
      sha256: compilerPack.revision,
    });
    expect(fetchFn).toHaveBeenCalledWith(registryUrl, { cache: 'no-cache' });
    expect(fetchFn).toHaveBeenCalledWith(loaded.manifestUrl, { cache: 'no-cache' });
  });

  it('rejects registry bytes that do not match the executable release pin', async () => {
    await expect(loadEsp32BrowserPlatformRegistry({
      release: {
        platforms: { path: 'platform-manifests/registry.json', sha256: '0'.repeat(64) },
      },
      baseUrl: releaseUrl,
      fetchFn: localFetch,
      cryptoRef: webcrypto,
    })).rejects.toThrow(/checksum mismatch/);
  });

  it('rejects non-content-addressed, unsorted, and weak SDK entries', () => {
    const entry = {
      fqbn: 'esp32:esp32:esp32c3',
      id: 'espressif-arduino',
      version: '3.3.7',
      sha256: 'a'.repeat(64),
      path: `espressif-arduino/${'a'.repeat(64)}/manifest.json`,
      sdkPack: { id: 'arduino-esp32c3-sdk', revision: 'b'.repeat(64) },
    };
    const registry = (entries: unknown[]) => ({
      kind: 'ck-platform-manifest-registry',
      schemaVersion: 1,
      entries,
    });

    expect(() => validateEsp32BrowserPlatformRegistry(
      registry([{ ...entry, path: 'mutable/manifest.json' }]),
      registryUrl,
    )).toThrow(/entry is invalid/);
    expect(() => validateEsp32BrowserPlatformRegistry(
      registry([{ ...entry, sdkPack: { id: entry.sdkPack.id, revision: 'latest' } }]),
      registryUrl,
    )).toThrow(/entry is invalid/);
    expect(() => validateEsp32BrowserPlatformRegistry(
      registry([{ ...entry, fqbn: 'esp32:esp32:esp32c6' }, entry]),
      registryUrl,
    )).toThrow(/sorted and unique/);
  });

  it('rejects a runtime descriptor paired with another SDK Pack', async () => {
    const registry = await loadPublishedRegistry();
    const fetchFn = vi.fn(localFetch);
    await expect(loadEsp32BrowserPlatformManifest({
      registry,
      fqbn: 'esp32:esp32:esp32c3',
      sdkPack: { id: 'arduino-esp32c3-sdk', revision: 'f'.repeat(64) },
      fetchFn,
      cryptoRef: webcrypto,
    })).rejects.toThrow(/does not match the runtime descriptor/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a changed Manifest even when it is served from the pinned path', async () => {
    const registry = await loadPublishedRegistry();
    const entry = registry.byFqbn.get('esp32:esp32:esp32c3');
    const manifest = JSON.parse(await readFile(fileURLToPath(entry.manifestUrl), 'utf8'));
    manifest.vendor = 'Changed';

    await expect(loadEsp32BrowserPlatformManifest({
      registry,
      fqbn: entry.fqbn,
      sdkPack: entry.sdkPack,
      fetchFn: vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200 })),
      cryptoRef: webcrypto,
    })).rejects.toThrow(/Manifest hash mismatch/);
  });
});
