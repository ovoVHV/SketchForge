import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import {
  ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
  createEsp32BrowserLibraryPackLoader,
  hasEsp32BrowserLibraryRegistryPin,
  loadEsp32BrowserLibraryRegistry,
  normalizeEsp32WorkerLibrarySelections,
  installEsp32BrowserLibraryPack,
  isEsp32BrowserLibraryImmutableManifestPath,
  listInstalledEsp32BrowserLibraryPacks,
  loadInstalledEsp32BrowserLibraryPack,
  removeInstalledEsp32BrowserLibraryPack,
  resolveEsp32BrowserLibraryHeader,
  resolveEsp32BrowserLibraries,
  validateEsp32BrowserLibraryRegistry,
} from '../public/esp32/v1/library-registry.js';
import { ESP32_BROWSER_RELEASE } from '../public/esp32/v1/release.js';
import {
  browserToolchainPackRevisionInput,
  createBrowserToolchainPackLoader,
} from '../public/avr/v3/toolchain-pack.js';

const publishedRegistryUrl = new URL('../public/esp32/v1/libraries-catalog/registry.json', import.meta.url);
const publishedPubSubPackUrl = new URL(
  '../public/esp32/v1/libraries-catalog/pubsubclient/2.8/toolchain.json',
  import.meta.url,
);
const publishedPubSubLockUrl = new URL(
  '../public/esp32/v1/libraries-catalog/pubsubclient/2.8/source-lock.json',
  import.meta.url,
);
const publishedGfxPackUrl = new URL(
  '../public/esp32/v1/libraries-catalog/adafruit-gfx/1.12.6/toolchain.json',
  import.meta.url,
);
const publishedGfxLockUrl = new URL(
  '../public/esp32/v1/libraries-catalog/adafruit-gfx/1.12.6/source-lock.json',
  import.meta.url,
);
const syntheticRegistryUrl = new URL('https://app.example.test/esp32/v1/libraries/registry.json');

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function version(
  name: string,
  slug: string,
  value = '1.0.0',
  depends: Array<{ name: string; version: string }> = [],
  architectures = ['esp32'],
) {
  return {
    version: value,
    architectures,
    publicHeaders: [`${slug}.h`],
    depends,
    pack: {
      id: `arduino-lib-${slug}`,
      revision: sha256(new TextEncoder().encode(`${name}@${value}`)),
      manifest: `${slug}/${value}/toolchain.json`,
      artifact: 'sources',
    },
  };
}

function library(name: string, slug: string, versions: ReturnType<typeof version>[]) {
  return { name, defaultVersion: versions[0]!.version, versions };
}

describe('ESP32 browser library registry', () => {
  it('installs a registry-pinned pack into CacheStorage and reads it offline', async () => {
    const registry = await loadEsp32BrowserLibraryRegistry({
      release: ESP32_BROWSER_RELEASE,
      fetchFn: async () => new Response(await readFile(fileURLToPath(publishedRegistryUrl)), { status: 200 }),
      cryptoRef: webcrypto,
    });
    const selection = resolveEsp32BrowserLibraries(registry, [{ name: 'PubSubClient' }]).libraries[0];
    expect(selection).toBeTruthy();
    const memory = new Map();
    const cache = {
      async put(request: string | Request, response: Response) {
        memory.set(typeof request === 'string' ? request : request.url, response.clone());
      },
      async match(request: string | Request) {
        return memory.get(typeof request === 'string' ? request : request.url)?.clone();
      },
      async keys() {
        return [...memory.keys()].map((url) => new Request(url));
      },
      async delete(request: string | Request) {
        return memory.delete(typeof request === 'string' ? request : request.url);
      },
    };
    const cacheStorage = { open: async () => cache };
    const fetchFn = async (input: URL | string) => {
      const url = new URL(String(input));
      return new Response(await readFile(fileURLToPath(url)), { status: 200 });
    };
    const installed = await installEsp32BrowserLibraryPack({
      registry,
      selection,
      cacheStorage,
      fetchFn,
      cryptoRef: webcrypto,
    });
    expect(installed.cached).toBe(true);
    expect((await listInstalledEsp32BrowserLibraryPacks({ cacheStorage }))).toHaveLength(1);
    const cached = await loadInstalledEsp32BrowserLibraryPack({ selection, cacheStorage, cryptoRef: webcrypto });
    expect(cached?.bytes.byteLength).toBeGreaterThan(0);
    const offlineFetch = vi.fn(async () => {
      throw new Error('network is unavailable');
    });
    const offlineLoader = createEsp32BrowserLibraryPackLoader({
      manifestUrl: selection.manifestUrl,
      expectedId: selection.packId,
      expectedRevision: selection.revision,
      cacheStorage,
      fetchFn: offlineFetch,
      cryptoRef: webcrypto,
    });
    const offlineArtifact = await offlineLoader.loadArtifact(selection.artifact);
    expect(offlineArtifact.bytes.byteLength).toBe(cached?.bytes.byteLength);
    expect(offlineFetch).not.toHaveBeenCalled();
    expect(await removeInstalledEsp32BrowserLibraryPack({ selection, cacheStorage })).toBe(true);
    expect((await listInstalledEsp32BrowserLibraryPacks({ cacheStorage }))).toHaveLength(0);
  });

  it('preserves compressed transport chunks for fully offline Pack loading', async () => {
    const payload = new TextEncoder().encode(JSON.stringify({
      schema: 1,
      name: 'Compressed Library',
      version: '1.0.0',
      architectures: ['esp32'],
      includeDirs: ['src'],
      files: [{ path: 'src/compressed.h', content: '#pragma once\n'.repeat(1000) }],
    }));
    const decodedChunks = [payload.slice(0, Math.floor(payload.length / 2)), payload.slice(Math.floor(payload.length / 2))];
    const transport = decodedChunks.map((bytes) => gzipSync(bytes, { level: 9, mtime: 0 }));
    const artifact = {
      id: 'sources',
      kind: 'library-source-json',
      size: payload.byteLength,
      sha256: sha256(payload),
      chunks: decodedChunks.map((bytes, index) => ({
        path: `chunks/sources-${index}.bin.gz`,
        size: bytes.byteLength,
        sha256: sha256(bytes),
        compression: 'gzip',
        compressedSize: transport[index]!.byteLength,
        compressedSha256: sha256(transport[index]!),
      })),
    };
    const manifest = {
      schema: 1,
      id: 'arduino-lib-compressed',
      version: '1.0.0',
      revision: '0'.repeat(64),
      artifacts: [artifact],
    };
    manifest.revision = sha256(new TextEncoder().encode(browserToolchainPackRevisionInput(manifest)));
    const registry = validateEsp32BrowserLibraryRegistry({
      schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
      libraries: [{
        name: 'Compressed Library',
        defaultVersion: '1.0.0',
        versions: [{
          version: '1.0.0',
          architectures: ['esp32'],
          publicHeaders: ['compressed.h'],
          depends: [],
          pack: {
            id: manifest.id,
            revision: manifest.revision,
            manifest: 'compressed/1.0.0/toolchain.json',
            artifact: 'sources',
          },
        }],
      }],
    }, syntheticRegistryUrl);
    const selection = resolveEsp32BrowserLibraries(registry, [{ name: 'Compressed Library' }]).libraries[0];
    const memory = new Map<string, Response>();
    const cache = {
      async put(request: string | Request, response: Response) {
        memory.set(typeof request === 'string' ? request : request.url, response.clone());
      },
      async match(request: string | Request) {
        return memory.get(typeof request === 'string' ? request : request.url)?.clone();
      },
      async keys() { return [...memory.keys()].map((url) => new Request(url)); },
      async delete(request: string | Request) {
        return memory.delete(typeof request === 'string' ? request : request.url);
      },
    };
    const cacheStorage = { open: async () => cache };
    const responses = new Map([
      [selection.manifestUrl, new TextEncoder().encode(JSON.stringify(manifest))],
      ...artifact.chunks.map((chunk, index) => [
        new URL(chunk.path, new URL('./', selection.manifestUrl)).href,
        transport[index]!,
      ] as const),
    ]);
    await installEsp32BrowserLibraryPack({
      registry,
      selection,
      cacheStorage,
      fetchFn: async (input: URL | string) => {
        const bytes = responses.get(new URL(String(input)).href);
        return bytes ? new Response(bytes, { status: 200 }) : new Response(null, { status: 404 });
      },
      cryptoRef: webcrypto,
    });

    const offlineFetch = vi.fn(async () => { throw new Error('network is unavailable'); });
    const loader = createEsp32BrowserLibraryPackLoader({
      manifestUrl: selection.manifestUrl,
      expectedId: selection.packId,
      expectedRevision: selection.revision,
      cacheStorage,
      fetchFn: offlineFetch,
      cryptoRef: webcrypto,
    });
    const loaded = await loader.loadArtifact('sources');
    expect(Buffer.from(loaded.bytes).equals(Buffer.from(payload))).toBe(true);
    expect(offlineFetch).not.toHaveBeenCalled();
    expect(await removeInstalledEsp32BrowserLibraryPack({ selection, cacheStorage })).toBe(true);
    expect(memory.size).toBe(0);
  });

  it('loads the checked-in registry only through its executable release hash', async () => {
    const bytes = new Uint8Array(await readFile(fileURLToPath(publishedRegistryUrl)));
    const fetchFn = vi.fn(async (input: URL) => {
      expect(new URL(String(input)).href).toBe(publishedRegistryUrl.href);
      return new Response(bytes, { status: 200 });
    });

    expect(hasEsp32BrowserLibraryRegistryPin(ESP32_BROWSER_RELEASE)).toBe(true);
    expect(ESP32_BROWSER_RELEASE.libraries.sha256).toBe(sha256(bytes));
    const registry = await loadEsp32BrowserLibraryRegistry({
      release: ESP32_BROWSER_RELEASE,
      fetchFn,
      cryptoRef: webcrypto,
    });

    expect(registry.schema).toBe(ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA);
    expect(registry.byName.get('pubsubclient')?.byVersion.get('2.8')?.publicHeaders)
      .toEqual(['PubSubClient.h']);
    expect(registry.headerIndex.get('pubsubclient.h')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'PubSubClient', version: '2.8' }),
      expect.objectContaining({ name: 'PubSubClient', version: '2.8.0' }),
    ]));
    expect(resolveEsp32BrowserLibraryHeader(registry, 'PUBSUBCLIENT.H'))
      .toEqual({ name: 'PubSubClient', version: '2.8' });
    expect(registry.libraries.length).toBeGreaterThanOrEqual(100);
    expect(registry.libraries.length).toBeLessThanOrEqual(200);
    expect(registry.libraries.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'AccelStepper',
      'AceButton',
      'Adafruit BusIO',
      'Adafruit GFX Library',
      'Adafruit SSD1306',
      'Adafruit TinyUSB Library',
      'Adafruit Unified Sensor',
      'ArduinoJson',
      'DallasTemperature',
      'DHT sensor library',
      'ESP8266Audio',
      'ESP32Servo',
      'FastLED',
      'FS',
      'GxEPD2',
      'IRremoteESP8266',
      'OneWire',
      'PubSubClient',
      'SPI',
      'SPIFFS',
      'TFT_eSPI',
      'U8g2',
      'Wire',
      'WiFiManager',
      'lvgl',
    ]));
    expect(resolveEsp32BrowserLibraries(registry, [{ name: 'Adafruit SSD1306' }])).toMatchObject({
      supported: true,
      libraries: [
        { name: 'SPI', version: '3.3.7' },
        { name: 'Wire', version: '3.3.7' },
        { name: 'Adafruit BusIO', version: '1.17.4' },
        { name: 'Adafruit GFX Library', version: '1.12.6' },
        { name: 'Adafruit SSD1306', version: '2.5.17' },
      ],
    });
    expect(resolveEsp32BrowserLibraries(registry, [{ name: 'DHT sensor library' }])).toMatchObject({
      supported: true,
      libraries: [
        { name: 'Adafruit Unified Sensor', version: '1.1.15' },
        { name: 'DHT sensor library', version: '1.4.7' },
      ],
    });
    expect(resolveEsp32BrowserLibraries(registry, [{ name: 'Wire' }], 'avr'))
      .toEqual({ supported: false, reason: 'libraries' });
    expect(resolveEsp32BrowserLibraries(registry, [{ name: 'DallasTemperature' }])).toMatchObject({
      supported: true,
      libraries: [
        {
          name: 'OneWire',
          version: '2.3.8',
          packId: 'arduino-lib-onewire',
          manifestUrl: expect.stringMatching(/\/libraries-catalog\/onewire\/2\.3\.8\/toolchain\.json$/),
        },
        {
          name: 'DallasTemperature',
          version: '4.0.6',
          packId: 'arduino-lib-dallas-temperature',
          manifestUrl: expect.stringMatching(/\/libraries-catalog\/dallas-temperature\/4\.0\.6\/toolchain\.json$/),
        },
      ],
    });
    expect(resolveEsp32BrowserLibraries(registry, [{ name: 'PubSubClient' }])).toMatchObject({
      supported: true,
      libraries: [{
        name: 'PubSubClient',
        version: '2.8',
        packId: 'arduino-lib-pubsubclient',
        manifestUrl: expect.stringMatching(/\/libraries-catalog\/pubsubclient\/2\.8\/toolchain\.json$/),
        artifact: 'sources',
      }],
    });
    expect(resolveEsp32BrowserLibraries(registry, [{ name: 'ESP32Servo' }])).toMatchObject({
      supported: true,
      libraries: [{
        name: 'ESP32Servo',
        version: '3.2.1',
        packId: 'arduino-lib-esp32servo',
        manifestUrl: expect.stringMatching(/\/libraries-catalog\/esp32servo\/3\.2\.1\/toolchain\.json$/),
        artifact: 'sources',
      }],
    });
    expect(resolveEsp32BrowserLibraries(registry, [{ name: 'FastLED' }])).toMatchObject({
      supported: true,
      libraries: [
        { name: 'SPI', version: '3.3.7' },
        {
          name: 'FastLED',
          version: '3.9.4',
          packId: 'arduino-lib-fastled',
          manifestUrl: expect.stringMatching(/\/libraries-catalog\/fastled\/3\.9\.4\/toolchain\.json$/),
          artifact: 'sources',
          dependencies: [{
            id: 'arduino-lib-spi',
            version: '3.3.7',
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          }],
        },
      ],
    });
    const latestFastLed = resolveEsp32BrowserLibraries(registry, [{ name: 'FastLED', version: '3.10.5' }]);
    expect(latestFastLed).toMatchObject({ supported: true });
    expect(latestFastLed.supported && latestFastLed.libraries.find(({ name }) => name === 'FastLED')).toMatchObject({
        name: 'FastLED',
        version: '3.10.5',
        packId: 'arduino-lib-fastled',
        manifestUrl: expect.stringMatching(/\/libraries-catalog\/fastled\/3\.10\.5\/toolchain\.json$/),
        artifact: 'sources',
    });
    const wifiResolution = resolveEsp32BrowserLibraries(registry, [{ name: 'WiFi' }]);
    expect(wifiResolution).toMatchObject({ supported: true });
    expect(wifiResolution.supported && wifiResolution.libraries.find(({ name }) => name === 'WiFi')).toMatchObject({
        name: 'WiFi',
        version: '3.3.7',
        packId: 'arduino-lib-wifi',
        dependencies: [{
          id: 'arduino-lib-networking',
          version: '3.3.7',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }],
    });
    expect(fetchFn).toHaveBeenCalledWith(publishedRegistryUrl, { cache: 'no-cache' });
  });

  it('loads the published PubSubClient chunk through the integrity-checking pack loader', async () => {
    const manifest = JSON.parse(await readFile(fileURLToPath(publishedPubSubPackUrl), 'utf8'));
    const sourceLock = JSON.parse(await readFile(fileURLToPath(publishedPubSubLockUrl), 'utf8'));
    const fetchFn = vi.fn(async (input: URL) => new Response(await readFile(fileURLToPath(input)), { status: 200 }));
    const loader = createBrowserToolchainPackLoader({
      manifestUrl: publishedPubSubPackUrl,
      expectedId: 'arduino-lib-pubsubclient',
      expectedRevision: manifest.revision,
      fetchFn,
      cryptoRef: webcrypto,
      limits: {
        maxArtifacts: 4,
        maxChunksPerArtifact: 16,
        maxArtifactBytes: 2 * 1024 * 1024,
        maxTotalBytes: 2 * 1024 * 1024,
      },
    });

    const loaded = await loader.loadArtifact('sources');
    const payload = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(loaded.bytes));
    expect(payload).toMatchObject({
      schema: 1,
      name: 'PubSubClient',
      version: '2.8',
      architectures: ['*'],
      includeDirs: ['src'],
      files: [
        { path: 'src/PubSubClient.cpp' },
        { path: 'src/PubSubClient.h' },
      ],
    });
    const lockedFiles = new Map(sourceLock.files.map((file: { path: string; sha256: string }) => [
      file.path,
      file.sha256,
    ]));
    for (const file of payload.files as Array<{ path: string; content: string }>) {
      expect(sha256(new TextEncoder().encode(file.content))).toBe(lockedFiles.get(file.path));
    }
    expect(fetchFn).toHaveBeenNthCalledWith(1, publishedPubSubPackUrl, { cache: 'no-cache' });
    expect(fetchFn.mock.calls[1]?.[1]).toEqual({ cache: 'force-cache' });
  });

  it('loads and revalidates the complete published Adafruit GFX source tree', async () => {
    const manifest = JSON.parse(await readFile(fileURLToPath(publishedGfxPackUrl), 'utf8'));
    const sourceLock = JSON.parse(await readFile(fileURLToPath(publishedGfxLockUrl), 'utf8'));
    const fetchFn = vi.fn(async (input: URL) => new Response(await readFile(fileURLToPath(input)), { status: 200 }));
    const loader = createBrowserToolchainPackLoader({
      manifestUrl: publishedGfxPackUrl,
      expectedId: 'arduino-lib-adafruit-gfx',
      expectedRevision: manifest.revision,
      fetchFn,
      cryptoRef: webcrypto,
      limits: {
        maxArtifacts: 4,
        maxChunksPerArtifact: 16,
        maxArtifactBytes: 2 * 1024 * 1024,
        maxTotalBytes: 2 * 1024 * 1024,
      },
    });

    const loaded = await loader.loadArtifact('sources');
    const payload = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(loaded.bytes));
    expect(loaded.bytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(payload).toMatchObject({
      schema: 1,
      name: 'Adafruit GFX Library',
      version: '1.12.6',
      architectures: ['*'],
      includeDirs: ['src', 'src/Fonts'],
    });
    expect(payload.files).toHaveLength(61);
    expect(payload.files).toEqual(expect.arrayContaining([
      { path: 'src/Adafruit_GFX.cpp', content: expect.any(String) },
      { path: 'src/Fonts/FreeMono9pt7b.h', content: expect.any(String) },
    ]));
    expect(sourceLock.sourceTrees).toHaveLength(2);
    const lockedFiles = new Map(sourceLock.files.map((file: { publishedPath: string; sha256: string }) => [
      file.publishedPath,
      file.sha256,
    ]));
    for (const file of payload.files as Array<{ path: string; content: string }>) {
      expect(sha256(new TextEncoder().encode(file.content))).toBe(lockedFiles.get(file.path));
    }
  });

  it('expands exact transitive dependencies and fails closed on unsupported selections', () => {
    const registry = validateEsp32BrowserLibraryRegistry({
      schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
      libraries: [
        library('Adafruit GFX Library', 'adafruit-gfx', [version('Adafruit GFX Library', 'adafruit-gfx')]),
        library('Adafruit SSD1306', 'adafruit-ssd1306', [version(
          'Adafruit SSD1306',
          'adafruit-ssd1306',
          '2.5.7',
          [{ name: 'Adafruit GFX Library', version: '1.0.0' }],
        )]),
      ],
    }, syntheticRegistryUrl);

    expect(resolveEsp32BrowserLibraries(registry, [{ name: 'Adafruit SSD1306' }])).toMatchObject({
      supported: true,
      libraries: [
        { name: 'Adafruit GFX Library', version: '1.0.0' },
        { name: 'Adafruit SSD1306', version: '2.5.7' },
      ],
    });
    expect(resolveEsp32BrowserLibraries(registry, [{ name: 'Adafruit SSD1306', version: '9.9.9' }]))
      .toEqual({ supported: false, reason: 'libraries' });
    expect(resolveEsp32BrowserLibraries(registry, [{ name: 'Unknown' }]))
      .toEqual({ supported: false, reason: 'libraries' });
    expect(resolveEsp32BrowserLibraries(registry, [{ name: 'Adafruit SSD1306' }], 'avr'))
      .toEqual({ supported: false, reason: 'libraries' });
  });

  it('rejects incomplete dependency graphs, escaping pack paths, and dependency cycles at resolution', () => {
    expect(() => validateEsp32BrowserLibraryRegistry({
      schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
      libraries: [library('Display', 'display', [version(
        'Display', 'display', '1.0.0', [{ name: 'Missing', version: '1.0.0' }],
      )])],
    }, syntheticRegistryUrl)).toThrow(/dependency is missing/);

    const escaping = library('Display', 'display', [version('Display', 'display')]);
    escaping.versions[0]!.pack.manifest = '../toolchain.json';
    expect(() => validateEsp32BrowserLibraryRegistry({
      schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
      libraries: [escaping],
    }, syntheticRegistryUrl))
      .toThrow(/manifest path/);

    const cyclic = validateEsp32BrowserLibraryRegistry({
      schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
      libraries: [
        library('Alpha', 'alpha', [version('Alpha', 'alpha', '1.0.0', [{ name: 'Beta', version: '1.0.0' }])]),
        library('Beta', 'beta', [version('Beta', 'beta', '1.0.0', [{ name: 'Alpha', version: '1.0.0' }])]),
      ],
    }, syntheticRegistryUrl);
    expect(resolveEsp32BrowserLibraries(cyclic, [{ name: 'Alpha' }]))
      .toEqual({ supported: false, reason: 'libraries' });
  });

  it('accepts legacy manifests but binds revision-addressed paths to the Pack revision', () => {
    const legacy = library('Alpha', 'alpha', [version('Alpha', 'alpha')]);
    expect(() => validateEsp32BrowserLibraryRegistry({
      schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
      libraries: [legacy],
    }, syntheticRegistryUrl)).not.toThrow();

    const immutable = library('Alpha', 'alpha', [version('Alpha', 'alpha')]);
    const pack = immutable.versions[0]!.pack;
    pack.manifest = `alpha/1.0.0/${pack.revision}/toolchain.json`;
    expect(isEsp32BrowserLibraryImmutableManifestPath(pack.manifest, pack.revision)).toBe(true);
    expect(() => validateEsp32BrowserLibraryRegistry({
      schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
      libraries: [immutable],
    }, syntheticRegistryUrl)).not.toThrow();

    pack.manifest = `alpha/1.0.0/${'f'.repeat(64)}/toolchain.json`;
    expect(() => validateEsp32BrowserLibraryRegistry({
      schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
      libraries: [immutable],
    }, syntheticRegistryUrl)).toThrow(/revision path does not match/);

    pack.manifest = `alpha/1.0.0/${pack.revision.toUpperCase()}/toolchain.json`;
    expect(() => validateEsp32BrowserLibraryRegistry({
      schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
      libraries: [immutable],
    }, syntheticRegistryUrl)).toThrow(/revision path does not match/);
  });

  it('rejects unsafe, unsorted, and cross-library ambiguous public header metadata', () => {
    const invalidPath = library('Alpha', 'alpha', [version('Alpha', 'alpha')]);
    invalidPath.versions[0]!.publicHeaders = ['../Alpha.h'];
    expect(() => validateEsp32BrowserLibraryRegistry({
      schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
      libraries: [invalidPath],
    }, syntheticRegistryUrl)).toThrow(/public headers/);

    const unsorted = library('Alpha', 'alpha', [version('Alpha', 'alpha')]);
    unsorted.versions[0]!.publicHeaders = ['Zulu.h', 'Alpha.h'];
    expect(() => validateEsp32BrowserLibraryRegistry({
      schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
      libraries: [unsorted],
    }, syntheticRegistryUrl)).toThrow(/public headers/);

    const alpha = library('Alpha', 'alpha', [version('Alpha', 'alpha')]);
    const beta = library('Beta', 'beta', [version('Beta', 'beta')]);
    alpha.versions[0]!.publicHeaders = ['Shared.h'];
    beta.versions[0]!.publicHeaders = ['shared.h'];
    expect(() => validateEsp32BrowserLibraryRegistry({
      schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
      libraries: [alpha, beta],
    }, syntheticRegistryUrl)).toThrow(/ambiguous/);
  });

  it('revalidates Worker selections and confines packs to the runtime origin', () => {
    const selection = {
      name: 'PubSubClient',
      version: '2.8',
      packId: 'arduino-lib-pubsubclient',
      revision: 'a'.repeat(64),
      manifestUrl: 'https://cdn.example.test/esp32/libraries/pubsubclient/2.8/toolchain.json',
      artifact: 'sources',
    };
    expect(normalizeEsp32WorkerLibrarySelections(
      [selection],
      'https://cdn.example.test/esp32/runtime.json',
    )).toEqual([selection]);
    expect(() => normalizeEsp32WorkerLibrarySelections(
      [{ ...selection, manifestUrl: 'https://evil.example.test/toolchain.json' }],
      'https://cdn.example.test/esp32/runtime.json',
    )).toThrow(/share the runtime origin/);
    expect(() => normalizeEsp32WorkerLibrarySelections(
      [selection, selection],
      'https://cdn.example.test/esp32/runtime.json',
    )).toThrow(/duplicated/);
  });

  it('rejects a registry body that does not match its release pin', async () => {
    await expect(loadEsp32BrowserLibraryRegistry({
      release: { libraries: { path: 'libraries/registry.json', sha256: '0'.repeat(64) } },
      baseUrl: 'https://app.example.test/esp32/v1/release.js',
      fetchFn: async () => new Response('{"schema":1,"libraries":[]}', { status: 200 }),
      cryptoRef: webcrypto,
    })).rejects.toThrow(/checksum mismatch/);
  });
});
