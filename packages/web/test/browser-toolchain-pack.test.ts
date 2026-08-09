import { createHash, webcrypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import {
  browserToolchainPackRevisionInput,
  createBrowserToolchainPackLoader,
  validateBrowserToolchainPackManifest,
} from '../browser-toolchain/toolchain-pack.js';
import { createVerifiedEmscriptenModule } from '../browser-toolchain/verified-emscripten.js';
import {
  createBrowserToolchainPackLoader as createPublishedBrowserToolchainPackLoader,
} from '../public/avr/v3/toolchain-pack.js';

function sha256(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

function artifact(
  id: string,
  chunks: Array<{ path: string; bytes: Uint8Array }>,
  kind = 'asset-pack',
) {
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.bytes)));
  return {
    id,
    kind,
    size: body.byteLength,
    sha256: sha256(body),
    chunks: chunks.map((chunk) => ({
      path: chunk.path,
      size: chunk.bytes.byteLength,
      sha256: sha256(chunk.bytes),
    })),
  };
}

function treeArtifact(
  id: string,
  files: Array<{ path: string; bytes: Uint8Array }>,
) {
  let offset = 0;
  const body = Buffer.concat(files.map((file) => Buffer.from(file.bytes)));
  const value = artifact(id, [{
    path: `chunks/${id}.bin`,
    bytes: new Uint8Array(body),
  }], 'tree') as TestArtifact & { files?: unknown[] };
  value.files = files.map((file) => {
    const entry = {
      path: file.path,
      offset,
      length: file.bytes.byteLength,
      sha256: sha256(file.bytes),
    };
    offset += file.bytes.byteLength;
    return entry;
  });
  return value;
}

type TestArtifact = ReturnType<typeof artifact>;
type TestManifest = {
  schema: number;
  id: string;
  version: string;
  revision: string;
  artifacts: TestArtifact[];
};

function manifest(artifacts: TestArtifact[], schema = 1): TestManifest {
  const value: TestManifest = {
    schema,
    id: 'esp32-c3-runtime',
    version: '0.1.0',
    revision: '0'.repeat(64),
    artifacts,
  };
  value.revision = sha256(browserToolchainPackRevisionInput(value));
  return value;
}

function compressedManifest(raw: Uint8Array, decoded = raw) {
  const compressed = new Uint8Array(gzipSync(decoded, { level: 9 }));
  const value = manifest([{
    id: 'core',
    kind: 'asset-pack',
    size: raw.byteLength,
    sha256: sha256(raw),
    chunks: [{
      path: `chunks/core-${sha256(compressed).slice(0, 16)}.bin.gz`,
      size: raw.byteLength,
      sha256: sha256(raw),
      compression: 'gzip',
      compressedSize: compressed.byteLength,
      compressedSha256: sha256(compressed),
    }],
  } as TestArtifact]);
  return { value, compressed };
}

function arrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function jsonResponse(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => arrayBuffer(bytes),
    json: async () => value,
  };
}

function httpErrorResponse(status: number) {
  return { ok: false, status };
}

const packLoaders = [
  { name: 'source loader', createLoader: createBrowserToolchainPackLoader },
  { name: 'published ESP Worker loader', createLoader: createPublishedBrowserToolchainPackLoader },
] as const;

describe('browser toolchain pack manifest', () => {
  it('requires sorted, safe chunks with bounded aggregate sizes', () => {
    const valid = manifest([artifact('core', [{ path: 'chunks/000-core.bin', bytes: new Uint8Array([1, 2]) }])]);

    expect(validateBrowserToolchainPackManifest(valid)).toMatchObject({
      id: 'esp32-c3-runtime',
      version: '0.1.0',
    });
    expect(() => validateBrowserToolchainPackManifest({
      ...valid,
      artifacts: [{
        ...valid.artifacts[0]!,
        chunks: [{ path: '../core.bin', size: 2, sha256: sha256(new Uint8Array([1, 2])) }],
      }],
    })).toThrow(/artifact path/);
    expect(() => validateBrowserToolchainPackManifest(valid, { maxArtifactBytes: 1 })).toThrow(/artifact size/);
  });

  it('validates schema-2 tree file indexes and their byte layout', () => {
    const valid = manifest([treeArtifact('core', [
      { path: 'include/a.h', bytes: new Uint8Array([1, 2]) },
      { path: 'src/main.cpp', bytes: new Uint8Array([3, 4, 5]) },
    ])], 2);

    expect(validateBrowserToolchainPackManifest(valid).artifacts[0]?.files).toEqual([
      { path: 'include/a.h', offset: 0, length: 2, sha256: sha256(new Uint8Array([1, 2])) },
      { path: 'src/main.cpp', offset: 2, length: 3, sha256: sha256(new Uint8Array([3, 4, 5])) },
    ]);

    const cxxHeaders = manifest([treeArtifact('runtime', [
      { path: 'include/c++/14.2.0/algorithm', bytes: new Uint8Array([1]) },
    ])], 2);
    expect(validateBrowserToolchainPackManifest(cxxHeaders).artifacts[0]?.files[0]?.path)
      .toBe('include/c++/14.2.0/algorithm');

    const unsorted = structuredClone(valid) as any;
    unsorted.artifacts[0].files.reverse();
    expect(() => validateBrowserToolchainPackManifest(unsorted)).toThrow(/sorted unique paths/);

    const gapped = structuredClone(valid) as any;
    gapped.artifacts[0].files[1].offset = 4;
    expect(() => validateBrowserToolchainPackManifest(gapped)).toThrow(/invalid browser toolchain artifact file range/);

    const wrongFileHash = structuredClone(valid) as any;
    wrongFileHash.artifacts[0].files[0].sha256 = 'invalid';
    expect(() => validateBrowserToolchainPackManifest(wrongFileHash)).toThrow(/file checksum/);
  });

  it('rejects files on legacy or non-tree artifacts', () => {
    const tree = treeArtifact('core', [{ path: 'a.h', bytes: new Uint8Array([1]) }]);
    expect(() => validateBrowserToolchainPackManifest(manifest([tree], 1))).toThrow(/legacy.*files/);

    const nonTree = artifact('core', [{ path: 'chunks/core.bin', bytes: new Uint8Array([1]) }]);
    expect(() => validateBrowserToolchainPackManifest(manifest([
      { ...nonTree, files: [{ path: 'a.h', offset: 0, length: 1, sha256: sha256(new Uint8Array([1])) }] },
    ], 2))).toThrow(/non-tree.*files/);
  });
});

describe('browser toolchain pack loader', () => {
  it('rejects an oversized declared manifest before materializing its body', async () => {
    const arrayBufferSpy = vi.fn();
    const loader = createBrowserToolchainPackLoader({
      manifestUrl: 'https://cdn.example.test/toolchains/esp32-c3/v1/toolchain.json',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => String(8 * 1024 * 1024 + 1) },
        arrayBuffer: arrayBufferSpy,
      }),
      cryptoRef: webcrypto,
    });

    await expect(loader.loadManifest()).rejects.toThrow(/manifest exceeds its size limit/);
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it.each(packLoaders)('$name revalidates its manifest and force-caches verified chunks', async ({ createLoader }) => {
    const first = new Uint8Array([1, 2]);
    const second = new Uint8Array([3, 4]);
    const value = manifest([artifact('core', [
      { path: 'chunks/000-core.bin', bytes: first },
      { path: 'chunks/001-core.bin', bytes: second },
    ])]);
    const progress: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn(async (input: URL) => {
      const path = input.pathname;
      if (path.endsWith('/toolchain.json')) {
        return jsonResponse(value);
      }
      if (path.endsWith('/000-core.bin')) {
        return { ok: true, status: 200, arrayBuffer: async () => arrayBuffer(first) };
      }
      if (path.endsWith('/001-core.bin')) {
        return {
          ok: true,
          status: 200,
          body: {
            getReader() {
              const parts = [second.subarray(0, 1), second.subarray(1)];
              let index = 0;
              return {
                async read() {
                  if (index >= parts.length) return { done: true, value: undefined };
                  return { done: false, value: parts[index++] };
                },
                releaseLock() {},
              };
            },
          },
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const manifestUrl = new URL('https://cdn.example.test/toolchains/esp32-c3/v1/toolchain.json');
    const loader = createLoader({
      manifestUrl,
      expectedId: 'esp32-c3-runtime',
      expectedRevision: value.revision,
      fetchFn,
      cryptoRef: webcrypto,
      onProgress: (event) => progress.push(event),
    });

    const loaded = await loader.loadArtifact('core');
    expect([...loaded.bytes]).toEqual([1, 2, 3, 4]);
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactId: 'core', completedBytes: 2, totalBytes: 4 }),
      expect.objectContaining({ artifactId: 'core', completedBytes: 3, totalBytes: 4 }),
      expect.objectContaining({ artifactId: 'core', completedBytes: 4, totalBytes: 4, complete: true }),
    ]));
    expect(fetchFn).toHaveBeenNthCalledWith(1, manifestUrl, { cache: 'no-cache' });
    expect(fetchFn).toHaveBeenNthCalledWith(2, new URL('chunks/000-core.bin', manifestUrl), { cache: 'force-cache' });
    expect(fetchFn).toHaveBeenNthCalledWith(3, new URL('chunks/001-core.bin', manifestUrl), { cache: 'force-cache' });

    await loader.loadArtifact('core');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it.each(packLoaders)('$name retries a transient manifest 503 with reload', async ({ createLoader }) => {
    const bytes = new Uint8Array([1, 2]);
    const value = manifest([artifact('core', [{ path: 'chunks/000-core.bin', bytes }])]);
    const manifestUrl = new URL('https://cdn.example.test/toolchains/esp32-c3/v1/toolchain.json');
    let attempt = 0;
    const fetchFn = vi.fn(async () => {
      attempt += 1;
      return attempt === 1 ? httpErrorResponse(503) : jsonResponse(value);
    });
    const loader = createLoader({ manifestUrl, fetchFn, cryptoRef: webcrypto });

    await expect(loader.loadManifest()).resolves.toMatchObject({ revision: value.revision });
    expect(fetchFn).toHaveBeenNthCalledWith(1, manifestUrl, { cache: 'no-cache' });
    expect(fetchFn).toHaveBeenNthCalledWith(2, manifestUrl, { cache: 'reload' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each(packLoaders)('$name falls back to the application manifest when the CDN stays unavailable', async ({ createLoader }) => {
    const bytes = new Uint8Array([1, 2]);
    const value = manifest([artifact('core', [{ path: 'chunks/000-core.bin', bytes }])]);
    const manifestUrl = new URL('https://cdn.example.test/esp32/packs/core/toolchain.json');
    const fallbackManifestUrl = new URL('https://app.example.test/arduino/esp32/packs/core/toolchain.json');
    const fetchFn = vi.fn(async (input: URL) => (
      input.origin === manifestUrl.origin ? httpErrorResponse(503) : jsonResponse(value)
    ));
    const loader = createLoader({ manifestUrl, fallbackManifestUrl, fetchFn, cryptoRef: webcrypto });

    await expect(loader.loadManifest()).resolves.toMatchObject({ revision: value.revision });
    expect(fetchFn).toHaveBeenNthCalledWith(1, manifestUrl, { cache: 'no-cache' });
    expect(fetchFn).toHaveBeenNthCalledWith(2, manifestUrl, { cache: 'reload' });
    expect(fetchFn).toHaveBeenNthCalledWith(3, fallbackManifestUrl, { cache: 'no-cache' });
  });

  it.each(packLoaders)('$name falls back to the matching application chunk after a CDN miss', async ({ createLoader }) => {
    const bytes = new Uint8Array([1, 2]);
    const value = manifest([artifact('core', [{ path: 'chunks/000-core.bin', bytes }])]);
    const manifestUrl = new URL('https://cdn.example.test/esp32/packs/core/toolchain.json');
    const fallbackManifestUrl = new URL('https://app.example.test/arduino/esp32/packs/core/toolchain.json');
    const cdnChunkUrl = new URL('chunks/000-core.bin', manifestUrl);
    const fallbackChunkUrl = new URL('chunks/000-core.bin', fallbackManifestUrl);
    const fetchFn = vi.fn(async (input: URL) => {
      if (input.href === manifestUrl.href) return jsonResponse(value);
      if (input.origin === manifestUrl.origin) return httpErrorResponse(404);
      return { ok: true, status: 200, arrayBuffer: async () => arrayBuffer(bytes) };
    });
    const loader = createLoader({ manifestUrl, fallbackManifestUrl, fetchFn, cryptoRef: webcrypto });

    await expect(loader.loadArtifact('core')).resolves.toMatchObject({ bytes });
    expect(fetchFn).toHaveBeenNthCalledWith(1, manifestUrl, { cache: 'no-cache' });
    expect(fetchFn).toHaveBeenNthCalledWith(2, cdnChunkUrl, { cache: 'force-cache' });
    expect(fetchFn).toHaveBeenNthCalledWith(3, fallbackChunkUrl, { cache: 'force-cache' });
  });

  it.each(packLoaders)('$name reloads a chunk after a bad first length', async ({ createLoader }) => {
    const bytes = new Uint8Array([1, 2]);
    const truncated = bytes.subarray(0, 1);
    const value = manifest([artifact('core', [{ path: 'chunks/000-core.bin', bytes }])]);
    const manifestUrl = new URL('https://cdn.example.test/toolchains/esp32-c3/v1/toolchain.json');
    const chunkUrl = new URL('chunks/000-core.bin', manifestUrl);
    let chunkAttempt = 0;
    const fetchFn = vi.fn(async (input: URL) => {
      if (input.pathname.endsWith('/toolchain.json')) return jsonResponse(value);
      chunkAttempt += 1;
      const responseBytes = chunkAttempt === 1 ? truncated : bytes;
      return { ok: true, status: 200, arrayBuffer: async () => arrayBuffer(responseBytes) };
    });
    const loader = createLoader({ manifestUrl, fetchFn, cryptoRef: webcrypto });

    await expect(loader.loadArtifact('core')).resolves.toMatchObject({ bytes });
    expect(fetchFn).toHaveBeenNthCalledWith(1, manifestUrl, { cache: 'no-cache' });
    expect(fetchFn).toHaveBeenNthCalledWith(2, chunkUrl, { cache: 'force-cache' });
    expect(fetchFn).toHaveBeenNthCalledWith(3, chunkUrl, { cache: 'reload' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it.each(packLoaders)('$name reloads a chunk after a bad first SHA', async ({ createLoader }) => {
    const bytes = new Uint8Array([1, 2]);
    const corrupted = new Uint8Array([9, 9]);
    const value = manifest([artifact('core', [{ path: 'chunks/000-core.bin', bytes }])]);
    const manifestUrl = new URL('https://cdn.example.test/toolchains/esp32-c3/v1/toolchain.json');
    const chunkUrl = new URL('chunks/000-core.bin', manifestUrl);
    let chunkAttempt = 0;
    const fetchFn = vi.fn(async (input: URL) => {
      if (input.pathname.endsWith('/toolchain.json')) return jsonResponse(value);
      chunkAttempt += 1;
      const responseBytes = chunkAttempt === 1 ? corrupted : bytes;
      return { ok: true, status: 200, arrayBuffer: async () => arrayBuffer(responseBytes) };
    });
    const loader = createLoader({ manifestUrl, fetchFn, cryptoRef: webcrypto });

    await expect(loader.loadArtifact('core')).resolves.toMatchObject({ bytes });
    expect(fetchFn).toHaveBeenNthCalledWith(1, manifestUrl, { cache: 'no-cache' });
    expect(fetchFn).toHaveBeenNthCalledWith(2, chunkUrl, { cache: 'force-cache' });
    expect(fetchFn).toHaveBeenNthCalledWith(3, chunkUrl, { cache: 'reload' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it.each(packLoaders)('$name does not retry a manifest 404', async ({ createLoader }) => {
    const manifestUrl = new URL('https://cdn.example.test/toolchains/esp32-c3/v1/toolchain.json');
    const fetchFn = vi.fn(async () => httpErrorResponse(404));
    const loader = createLoader({ manifestUrl, fetchFn, cryptoRef: webcrypto });

    await expect(loader.loadManifest()).rejects.toThrow(/HTTP 404/);
    expect(fetchFn).toHaveBeenCalledWith(manifestUrl, { cache: 'no-cache' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each(packLoaders)('$name does not retry a chunk 404', async ({ createLoader }) => {
    const bytes = new Uint8Array([1, 2]);
    const value = manifest([artifact('core', [{ path: 'chunks/000-core.bin', bytes }])]);
    const manifestUrl = new URL('https://cdn.example.test/toolchains/esp32-c3/v1/toolchain.json');
    const chunkUrl = new URL('chunks/000-core.bin', manifestUrl);
    const fetchFn = vi.fn(async (input: URL) => input.pathname.endsWith('/toolchain.json')
      ? jsonResponse(value)
      : httpErrorResponse(404));
    const loader = createLoader({ manifestUrl, fetchFn, cryptoRef: webcrypto });

    await expect(loader.loadArtifact('core')).rejects.toThrow(/HTTP 404/);
    expect(fetchFn).toHaveBeenNthCalledWith(1, manifestUrl, { cache: 'no-cache' });
    expect(fetchFn).toHaveBeenNthCalledWith(2, chunkUrl, { cache: 'force-cache' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each(packLoaders)('$name verifies, decompresses, and reports gzip transport bytes', async ({ createLoader }) => {
    const raw = new TextEncoder().encode('repeatable browser pack payload '.repeat(32));
    const { value, compressed } = compressedManifest(raw);
    const progress: Array<Record<string, unknown>> = [];
    const loader = createLoader({
      manifestUrl: 'https://cdn.example.test/toolchains/esp32-c3/v2/toolchain.json',
      expectedRevision: value.revision,
      fetchFn: async (input: URL) => input.pathname.endsWith('/toolchain.json')
        ? jsonResponse(value)
        : { ok: true, status: 200, arrayBuffer: async () => arrayBuffer(compressed) },
      cryptoRef: webcrypto,
      onProgress: (event: Record<string, unknown>) => progress.push(event),
    });

    await expect(loader.loadArtifact('core')).resolves.toMatchObject({ bytes: raw });
    expect(progress.at(-1)).toMatchObject({
      completedBytes: compressed.byteLength,
      totalBytes: compressed.byteLength,
      artifactBytes: raw.byteLength,
      complete: true,
    });
  });

  it.each(packLoaders)('$name rejects gzip transport tampering before decompression', async ({ createLoader }) => {
    const raw = new TextEncoder().encode('compressible payload '.repeat(32));
    const { value, compressed } = compressedManifest(raw);
    const tampered = new Uint8Array(compressed);
    tampered[tampered.length - 1] ^= 1;
    const loader = createLoader({
      manifestUrl: 'https://cdn.example.test/toolchains/esp32-c3/v2/toolchain.json',
      fetchFn: async (input: URL) => input.pathname.endsWith('/toolchain.json')
        ? jsonResponse(value)
        : { ok: true, status: 200, arrayBuffer: async () => arrayBuffer(tampered) },
      cryptoRef: webcrypto,
    });

    await expect(loader.loadArtifact('core')).rejects.toThrow(/chunk checksum mismatch/);
  });

  it.each(packLoaders)('$name bounds gzip output and fails closed without a decompressor', async ({ createLoader }) => {
    const declared = new Uint8Array(64);
    const decoded = new Uint8Array(128);
    const { value, compressed } = compressedManifest(declared, decoded);
    const fetchFn = async (input: URL) => input.pathname.endsWith('/toolchain.json')
      ? jsonResponse(value)
      : { ok: true, status: 200, arrayBuffer: async () => arrayBuffer(compressed) };
    const bounded = createLoader({
      manifestUrl: 'https://cdn.example.test/toolchains/esp32-c3/v2/toolchain.json',
      fetchFn,
      cryptoRef: webcrypto,
    });
    const unavailable = createLoader({
      manifestUrl: 'https://cdn.example.test/toolchains/esp32-c3/v2/toolchain.json',
      fetchFn,
      cryptoRef: webcrypto,
      DecompressionStreamClass: null,
    });

    await expect(bounded.loadArtifact('core')).rejects.toThrow(/exceeds its declared size/);
    await expect(unavailable.loadArtifact('core')).rejects.toThrow(/compression is unavailable/);
  });

  it('rejects an oversized declared chunk before calling arrayBuffer', async () => {
    const declared = new Uint8Array([1, 2]);
    const value = manifest([artifact('core', [{ path: 'chunks/000-core.bin', bytes: declared }])]);
    const arrayBufferSpy = vi.fn();
    const fetchFn = vi.fn(async (input: URL) => {
      if (input.pathname.endsWith('/toolchain.json')) return jsonResponse(value);
      return {
        ok: true,
        status: 200,
        headers: { get: () => '3' },
        arrayBuffer: arrayBufferSpy,
      };
    });
    const loader = createBrowserToolchainPackLoader({
      manifestUrl: 'https://cdn.example.test/toolchains/esp32-c3/v1/toolchain.json',
      fetchFn,
      cryptoRef: webcrypto,
    });

    await expect(loader.loadArtifact('core')).rejects.toThrow(/artifact core exceeds its size limit/);
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it('cancels each stream attempt before retaining a chunk that crosses its declared limit', async () => {
    const declared = new Uint8Array([1, 2]);
    const value = manifest([artifact('core', [{ path: 'chunks/000-core.bin', bytes: declared }])]);
    const cancel = vi.fn(async () => {});
    const fetchFn = vi.fn(async (input: URL) => {
      if (input.pathname.endsWith('/toolchain.json')) return jsonResponse(value);
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            let sent = false;
            return {
              async read() {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: new Uint8Array([1, 2, 3]) };
              },
              cancel,
              releaseLock() {},
            };
          },
        },
      };
    });
    const loader = createBrowserToolchainPackLoader({
      manifestUrl: 'https://cdn.example.test/toolchains/esp32-c3/v1/toolchain.json',
      fetchFn,
      cryptoRef: webcrypto,
    });

    await expect(loader.loadArtifact('core')).rejects.toThrow(/artifact core exceeds its size limit/);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('rejects a payload whose byte content does not match its declared chunk digest', async () => {
    const declared = new Uint8Array([1, 2]);
    const value = manifest([artifact('core', [{ path: 'chunks/000-core.bin', bytes: declared }])]);
    const fetchFn = vi.fn(async (input: URL) => {
      if (input.pathname.endsWith('/toolchain.json')) {
        return jsonResponse(value);
      }
      return { ok: true, status: 200, arrayBuffer: async () => arrayBuffer(new Uint8Array([9, 9])) };
    });
    const loader = createBrowserToolchainPackLoader({
      manifestUrl: 'https://cdn.example.test/toolchains/esp32-c3/v1/toolchain.json',
      fetchFn,
      cryptoRef: webcrypto,
    });

    await expect(loader.loadArtifact('core')).rejects.toThrow(/chunk checksum mismatch/);
  });

  it('rejects a manifest whose self-consistent revision differs from the pinned release', async () => {
    const value = manifest([artifact('core', [{ path: 'chunks/000-core.bin', bytes: new Uint8Array([1, 2]) }])]);
    const loader = createBrowserToolchainPackLoader({
      manifestUrl: 'https://cdn.example.test/toolchains/esp32-c3/v1/toolchain.json',
      expectedRevision: 'f'.repeat(64),
      fetchFn: async () => jsonResponse(value),
      cryptoRef: webcrypto,
    });

    await expect(loader.loadManifest()).rejects.toThrow(/unexpected browser toolchain pack revision/);
  });

  it('does not call Emscripten glue until the WASM digest has been verified', async () => {
    const declared = new Uint8Array([0, 97, 115, 109]);
    const tampered = new Uint8Array([0, 97, 115, 110]);
    const value = manifest([artifact('compiler-wasm', [
      { path: 'tools/compiler.wasm', bytes: declared },
    ], 'wasm')]);
    const fetchFn = vi.fn(async (input: URL) => {
      if (input.pathname.endsWith('/toolchain.json')) {
        return jsonResponse(value);
      }
      return { ok: true, status: 200, arrayBuffer: async () => arrayBuffer(tampered) };
    });
    const loader = createBrowserToolchainPackLoader({
      manifestUrl: 'https://cdn.example.test/toolchains/avr/v3/toolchain.json',
      expectedId: value.id,
      expectedRevision: value.revision,
      fetchFn,
      cryptoRef: webcrypto,
    });
    const factory = vi.fn();

    await expect(createVerifiedEmscriptenModule({
      loader,
      artifactId: 'compiler-wasm',
      factory,
      moduleOptions: { noInitialRun: true },
    })).rejects.toThrow(/chunk checksum mismatch/);
    expect(factory).not.toHaveBeenCalled();
  });

  it('passes only the verified WASM bytes to same-origin Emscripten glue', async () => {
    const declared = new Uint8Array([0, 97, 115, 109]);
    const value = manifest([artifact('compiler-wasm', [
      { path: 'tools/compiler.wasm', bytes: declared },
    ], 'wasm')]);
    const fetchFn = vi.fn(async (input: URL) => {
      if (input.pathname.endsWith('/toolchain.json')) {
        return jsonResponse(value);
      }
      return { ok: true, status: 200, arrayBuffer: async () => arrayBuffer(declared) };
    });
    const loader = createBrowserToolchainPackLoader({
      manifestUrl: 'https://cdn.example.test/toolchains/avr/v3/toolchain.json',
      expectedId: value.id,
      expectedRevision: value.revision,
      fetchFn,
      cryptoRef: webcrypto,
    });
    const runtime = { ready: true };
    const factory = vi.fn().mockResolvedValue(runtime);

    await expect(createVerifiedEmscriptenModule({
      loader,
      artifactId: 'compiler-wasm',
      factory,
      moduleOptions: { noInitialRun: true, wasmBinary: new Uint8Array([9]) },
    })).resolves.toBe(runtime);
    expect(factory).toHaveBeenCalledWith({ noInitialRun: true, wasmBinary: declared });
  });
});
