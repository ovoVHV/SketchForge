import { createHash, webcrypto } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createBrowserToolchainPackLoader } from '../browser-toolchain/toolchain-pack.js';
import {
  compressBrowserToolchainPack,
  manifestRevision,
} from '../../../scripts/compress-browser-toolchain-pack.mjs';

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('browser Pack gzip migration', () => {
  it('refuses to mutate an already published Pack in place', () => {
    const published = new URL('../public/esp32/example/toolchain.json', import.meta.url);
    expect(() => compressBrowserToolchainPack(fileURLToPath(published))).toThrow(/published Pack in place/);
  });

  it('is deterministic, content-addressed, idempotent, and loader-compatible', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-pack-gzip-'));
    try {
      const chunks = join(root, 'chunks');
      mkdirSync(chunks);
      const raw = Buffer.from('compressible Pack payload\n'.repeat(4096));
      const rawDigest = sha256(raw);
      const rawPath = `chunks/core-${rawDigest.slice(0, 16)}.bin`;
      writeFileSync(join(root, ...rawPath.split('/')), raw);
      const manifest = {
        schema: 1,
        id: 'test-pack',
        version: '1.0.0',
        revision: '0'.repeat(64),
        artifacts: [{
          id: 'core',
          kind: 'asset-pack',
          size: raw.byteLength,
          sha256: rawDigest,
          chunks: [{ path: rawPath, size: raw.byteLength, sha256: rawDigest }],
        }],
      };
      manifest.revision = manifestRevision(manifest);
      const manifestPath = join(root, 'toolchain.json');
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const first = compressBrowserToolchainPack(manifestPath);
      const migrated = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const compressedPath = migrated.artifacts[0].chunks[0].path;
      expect(compressedPath).toMatch(/^chunks\/core-[a-f0-9]{16}\.bin\.gz$/);
      expect(migrated.artifacts[0].chunks[0]).toMatchObject({ compression: 'gzip' });
      expect(first.downloadBytes).toBeLessThan(first.rawBytes);
      expect(() => readFileSync(join(root, ...rawPath.split('/')))).toThrow();

      const second = compressBrowserToolchainPack(manifestPath);
      expect(second.revision).toBe(first.revision);
      expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual(migrated);

      const loader = createBrowserToolchainPackLoader({
        manifestUrl: pathToFileURL(manifestPath),
        expectedRevision: first.revision,
        cryptoRef: webcrypto,
        fetchFn: async (input: URL) => {
          const bytes = readFileSync(input);
          return new Response(bytes, { status: 200 });
        },
      });
      const loaded = await loader.loadArtifact('core');
      expect(Buffer.from(loaded.bytes)).toEqual(raw);
      expect(relative(root, join(root, ...compressedPath.split('/')))).not.toMatch(/^\.\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
