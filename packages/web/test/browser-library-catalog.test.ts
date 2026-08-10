import { describe, expect, it } from 'vitest';
import {
  reconcileEsp32BrowserLibraryCatalog,
  reconcileEsp32BrowserLibraryReferences,
  resolveEsp32BrowserCatalogLibrary,
} from '../public/browser-library-catalog.js';

function registryFixture() {
  const version = {
    version: '3.3.7',
    architectures: Object.freeze(['esp32']),
    depends: Object.freeze([]),
    pack: Object.freeze({
      id: 'arduino-lib-wifi',
      revision: 'a'.repeat(64),
      manifestUrl: 'https://example.test/wifi/toolchain.json',
      artifact: 'sources',
    }),
  };
  const wifi = Object.freeze({
    name: 'WiFi',
    defaultVersion: version.version,
    versions: Object.freeze([version]),
    byVersion: new Map([[version.version, version]]),
  });
  return Object.freeze({ libraries: Object.freeze([wifi]), byName: new Map([['wifi', wifi]]) });
}

describe('ESP32 browser library catalog reconciliation', () => {
  it('replaces an unavailable server version with the published Pack version', () => {
    expect(reconcileEsp32BrowserLibraryCatalog([
      { name: 'WiFi', version: '1.2.7', architectures: ['esp32'], description: 'Server catalog' },
    ], registryFixture())).toEqual([
      expect.objectContaining({ name: 'WiFi', version: '3.3.7', browserPack: true }),
    ]);
  });

  it('adds published Packs missing from the server catalog and retains unrelated libraries', () => {
    const rows = reconcileEsp32BrowserLibraryCatalog([
      { name: 'ServerOnly', version: '1.0.0', architectures: ['esp32'] },
    ], registryFixture());
    expect(rows.map(({ name, version }) => `${name}@${version}`)).toEqual([
      'ServerOnly@1.0.0',
      'WiFi@3.3.7',
    ]);
  });

  it('migrates saved unavailable versions and resolves only exact published rows', () => {
    const registry = registryFixture();
    expect(reconcileEsp32BrowserLibraryReferences([
      { name: 'WiFi', version: '1.2.7' },
      { name: 'ServerOnly', version: '1.0.0' },
    ], registry)).toEqual([
      { name: 'WiFi', version: '3.3.7' },
      { name: 'ServerOnly', version: '1.0.0' },
    ]);
    expect(resolveEsp32BrowserCatalogLibrary(registry, { name: 'WiFi', version: '3.3.7' }))
      .toMatchObject({ supported: true });
    expect(resolveEsp32BrowserCatalogLibrary(registry, { name: 'WiFi', version: '1.2.7' })).toBeNull();
  });
});
