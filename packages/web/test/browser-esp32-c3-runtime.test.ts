import { createHash, webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEsp32C3RuntimeDescriptorLoader,
  createEsp32C3RuntimePackLoaders,
  ESP32_C3_RUNTIME_PACK_LIMITS,
  esp32C3RuntimePackPlan,
  esp32C6RuntimePackPlan,
  validateEsp32C3RuntimeDescriptor,
  validateEsp32C6RuntimeDescriptor,
} from '../public/esp32/v1/c3-runtime.js';

const descriptorUrl = 'https://cdn.example.test/esp32/c3/v1/runtime.json';

function descriptor() {
  return {
    schema: 2,
    id: 'esp32-c3-arduino',
    abi: 1,
    board: 'esp32:esp32:esp32c3',
    packs: [
      {
        role: 'compiler',
        id: 'riscv32-esp-elf-wasm',
        revision: 'a'.repeat(64),
        manifest: 'packs/compiler/toolchain.json',
      },
      {
        role: 'sdk',
        id: 'arduino-esp32c3-sdk',
        revision: 'b'.repeat(64),
        manifest: 'packs/sdk/toolchain.json',
      },
      {
        role: 'board',
        id: 'arduino-esp32c3-board',
        revision: 'c'.repeat(64),
        manifest: 'packs/board/toolchain.json',
      },
    ],
  };
}

function descriptorBytes(value = descriptor()) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}


afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ESP32-C3 browser runtime descriptor', () => {
  it('accepts only the fixed C3 ABI and produces pinned pack-loader inputs', () => {
    const value = descriptor();
    expect(validateEsp32C3RuntimeDescriptor(value)).toMatchObject({
      id: 'esp32-c3-arduino',
      board: 'esp32:esp32:esp32c3',
      packs: [{ role: 'compiler' }, { role: 'sdk' }, { role: 'board' }],
    });

    expect(esp32C3RuntimePackPlan(value, descriptorUrl)).toEqual([
      {
        role: 'compiler',
        id: 'riscv32-esp-elf-wasm',
        revision: 'a'.repeat(64),
        manifestUrl: 'https://cdn.example.test/esp32/c3/v1/packs/compiler/toolchain.json',
      },
      {
        role: 'sdk',
        id: 'arduino-esp32c3-sdk',
        revision: 'b'.repeat(64),
        manifestUrl: 'https://cdn.example.test/esp32/c3/v1/packs/sdk/toolchain.json',
      },
      {
        role: 'board',
        id: 'arduino-esp32c3-board',
        revision: 'c'.repeat(64),
        manifestUrl: 'https://cdn.example.test/esp32/c3/v1/packs/board/toolchain.json',
      },
    ]);
  });

  it('applies Board-specific limits to the independent Board Pack', () => {
    const value = descriptor();
    expect(validateEsp32C3RuntimeDescriptor(value)).toMatchObject({
      schema: 2,
      packs: [{ role: 'compiler' }, { role: 'sdk' }, { role: 'board' }],
    });
    expect(esp32C3RuntimePackPlan(value, descriptorUrl)[2]).toMatchObject({
      role: 'board',
      id: 'arduino-esp32c3-board',
      manifestUrl: 'https://cdn.example.test/esp32/c3/v1/packs/board/toolchain.json',
    });

    const calls: Array<Record<string, unknown>> = [];
    const loaders = createEsp32C3RuntimePackLoaders({
      descriptor: value,
      descriptorUrl,
      createPackLoader(config) {
        calls.push(config);
        return { loadArtifact: vi.fn() };
      },
    });
    expect(Object.keys(loaders)).toEqual(['compiler', 'sdk', 'board']);
    expect(calls[2]?.limits).toBe(ESP32_C3_RUNTIME_PACK_LIMITS.board);
  });

  it('resolves C3 and C6 to one content-addressed compiler URL', () => {
    const revision = 'a'.repeat(64);
    const compilerManifest = `../toolchains/riscv32-esp-elf-wasm/${revision}/toolchain.json`;
    const c3 = descriptor();
    c3.packs[0]!.manifest = compilerManifest;
    const c6 = {
      ...descriptor(),
      id: 'esp32-c6-arduino',
      board: 'esp32:esp32:esp32c6',
      packs: descriptor().packs.map((pack) => ({
        ...pack,
        id: pack.role === 'sdk'
          ? 'arduino-esp32c6-sdk'
          : pack.role === 'board' ? 'arduino-esp32c6-board' : pack.id,
        manifest: pack.role === 'compiler' ? compilerManifest : pack.manifest,
      })),
    };
    expect(validateEsp32C3RuntimeDescriptor(c3).packs[0]!.manifest).toBe(compilerManifest);
    expect(validateEsp32C6RuntimeDescriptor(c6).packs[0]!.manifest).toBe(compilerManifest);

    const c3Plan = esp32C3RuntimePackPlan(
      c3,
      'https://cdn.example.test/esp32/v2/runtime/runtime.json',
    );
    const c6Plan = esp32C6RuntimePackPlan(
      c6,
      'https://cdn.example.test/esp32/v2/runtime-c6/runtime.json',
    );
    expect(c3Plan[0]!.manifestUrl).toBe(
      `https://cdn.example.test/esp32/v2/toolchains/riscv32-esp-elf-wasm/${revision}/toolchain.json`,
    );
    expect(c6Plan[0]!.manifestUrl).toBe(c3Plan[0]!.manifestUrl);
    for (const plan of [c3Plan, c6Plan]) {
      expect(plan.every((pack) => !('offset' in pack) && !('staticArtifacts' in pack))).toBe(true);
    }

    const contentAddressedSdk = `../packs/arduino-esp32c3-sdk/${'b'.repeat(64)}/toolchain.json`;
    const contentAddressedBoard = `../packs/arduino-esp32c3-board/${'c'.repeat(64)}/toolchain.json`;
    const v2 = descriptor();
    v2.packs[1]!.manifest = contentAddressedSdk;
    v2.packs[2]!.manifest = contentAddressedBoard;
    const v2Plan = esp32C3RuntimePackPlan(v2, 'https://cdn.example.test/esp32/v2/runtime/runtime.json');
    expect(v2Plan[1]!.manifestUrl)
      .toBe(`https://cdn.example.test/esp32/v2/packs/arduino-esp32c3-sdk/${'b'.repeat(64)}/toolchain.json`);
    expect(v2Plan[2]!.manifestUrl)
      .toBe(`https://cdn.example.test/esp32/v2/packs/arduino-esp32c3-board/${'c'.repeat(64)}/toolchain.json`);
  });

  it('rejects descriptor shape changes and pack path escapes before they reach a loader', () => {
    const extra = { ...descriptor(), enabled: true };
    expect(() => validateEsp32C3RuntimeDescriptor(extra)).toThrow(/invalid shape/);

    const pathEscape = descriptor();
    pathEscape.packs[0]!.manifest = '../compiler/toolchain.json';
    expect(() => validateEsp32C3RuntimeDescriptor(pathEscape)).toThrow(/manifest path/);

    const wrongContentAddress = descriptor();
    wrongContentAddress.packs[0]!.manifest = `../toolchains/riscv32-esp-elf-wasm/${'0'.repeat(64)}/toolchain.json`;
    expect(() => validateEsp32C3RuntimeDescriptor(wrongContentAddress)).toThrow(/manifest path/);

    const sharedBoardPack = descriptor();
    sharedBoardPack.packs[1]!.manifest = `../toolchains/arduino-esp32c3-sdk/${'b'.repeat(64)}/toolchain.json`;
    expect(() => validateEsp32C3RuntimeDescriptor(sharedBoardPack)).toThrow(/manifest path/);

    const wrongSdkRevision = descriptor();
    wrongSdkRevision.packs[1]!.manifest = `../packs/arduino-esp32c3-sdk/${'0'.repeat(64)}/toolchain.json`;
    expect(() => validateEsp32C3RuntimeDescriptor(wrongSdkRevision)).toThrow(/manifest path/);

    const wrongBoard = descriptor();
    wrongBoard.board = 'esp32:esp32:esp32c6';
    expect(() => validateEsp32C3RuntimeDescriptor(wrongBoard)).toThrow(/unexpected board/);

    expect(() => createEsp32C3RuntimeDescriptorLoader({
      descriptorUrl: 'http://cdn.example.test/esp32/c3/v1/runtime.json',
      expectedSha256: 'a'.repeat(64),
    })).toThrow(/must use HTTPS/);
  });

  it('loads and caches a release-pinned descriptor', async () => {
    const bytes = descriptorBytes();
    const fetch = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    }));
    const loader = createEsp32C3RuntimeDescriptorLoader({
      descriptorUrl,
      expectedSha256: sha256(bytes),
      fetchFn: fetch,
      cryptoRef: webcrypto,
    });

    await expect(loader.load()).resolves.toMatchObject({ id: 'esp32-c3-arduino' });
    await loader.load();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(new URL(descriptorUrl), { cache: 'no-cache' });
  });

  it.each([
    'network',
    408,
    429,
    503,
    'read',
    'checksum',
  ])('retries a first %s descriptor failure with cache reload', async (failure) => {
    const bytes = descriptorBytes();
    const tampered = descriptor();
    tampered.packs[0]!.id = 'different-compiler';
    const badBytes = descriptorBytes(tampered);
    let attempt = 0;
    const fetch = vi.fn(async () => {
      attempt += 1;
      if (attempt > 1) return new Response(bytes, { status: 200 });
      if (failure === 'network') throw new TypeError('temporary network failure');
      if (failure === 'read') {
        const response = new Response(bytes, { status: 200 });
        vi.spyOn(response, 'arrayBuffer').mockRejectedValueOnce(new Error('temporary read failure'));
        return response;
      }
      if (failure === 'checksum') return new Response(badBytes, { status: 200 });
      return new Response('', { status: typeof failure === 'number' ? failure : 500 });
    });
    const loader = createEsp32C3RuntimeDescriptorLoader({
      descriptorUrl,
      expectedSha256: sha256(bytes),
      fetchFn: fetch,
      cryptoRef: webcrypto,
    });

    await expect(loader.load()).resolves.toMatchObject({ id: 'esp32-c3-arduino' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, new URL(descriptorUrl), { cache: 'no-cache' });
    expect(fetch).toHaveBeenNthCalledWith(2, new URL(descriptorUrl), { cache: 'reload' });
  });

  it('clears a rejected descriptor promise after its reload retry is exhausted', async () => {
    const bytes = descriptorBytes();
    const tampered = descriptor();
    tampered.packs[0]!.id = 'different-compiler';
    const badBytes = descriptorBytes(tampered);
    let attempt = 0;
    const fetch = vi.fn(async () => new Response(++attempt <= 2 ? badBytes : bytes, { status: 200 }));
    const loader = createEsp32C3RuntimeDescriptorLoader({
      descriptorUrl,
      expectedSha256: sha256(bytes),
      fetchFn: fetch,
      cryptoRef: webcrypto,
    });

    await expect(loader.load()).rejects.toThrow(/checksum mismatch/);
    await expect(loader.load()).resolves.toMatchObject({ id: 'esp32-c3-arduino' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(1, new URL(descriptorUrl), { cache: 'no-cache' });
    expect(fetch).toHaveBeenNthCalledWith(2, new URL(descriptorUrl), { cache: 'reload' });
    expect(fetch).toHaveBeenNthCalledWith(3, new URL(descriptorUrl), { cache: 'no-cache' });
  });

  it('does not reload retry a non-transient descriptor HTTP failure', async () => {
    const bytes = descriptorBytes();
    const fetch = vi.fn(async () => new Response('', { status: 404 }));
    const loader = createEsp32C3RuntimeDescriptorLoader({
      descriptorUrl,
      expectedSha256: sha256(bytes),
      fetchFn: fetch,
      cryptoRef: webcrypto,
    });

    await expect(loader.load()).rejects.toThrow(/returned HTTP 404/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(new URL(descriptorUrl), { cache: 'no-cache' });
  });

  it('passes every pack through the injected generic verified-pack boundary', () => {
    const calls: Array<Record<string, unknown>> = [];
    const progress: Array<Record<string, unknown>> = [];
    const loaders = createEsp32C3RuntimePackLoaders({
      descriptor: descriptor(),
      descriptorUrl,
      createPackLoader(config) {
        calls.push(config);
        return { loadArtifact: vi.fn() };
      },
      onProgress(value) { progress.push(value); },
    });

    expect(Object.keys(loaders)).toEqual(['compiler', 'sdk', 'board']);
    expect(calls.map((call) => call.expectedId)).toEqual([
      'riscv32-esp-elf-wasm',
      'arduino-esp32c3-sdk',
      'arduino-esp32c3-board',
    ]);
    expect(calls[0]!.manifestUrl).toBe('https://cdn.example.test/esp32/c3/v1/packs/compiler/toolchain.json');
    expect(calls.map((call) => call.limits)).toEqual([
      ESP32_C3_RUNTIME_PACK_LIMITS.compiler,
      ESP32_C3_RUNTIME_PACK_LIMITS.sdk,
      ESP32_C3_RUNTIME_PACK_LIMITS.board,
    ]);
    (calls[1]!.onProgress as (value: object) => void)({ artifactId: 'sdk-pack' });
    expect(progress).toEqual([{ role: 'sdk', artifactId: 'sdk-pack' }]);
  });
});
