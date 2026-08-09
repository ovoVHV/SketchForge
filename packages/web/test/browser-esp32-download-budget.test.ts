import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const MAX_COLD_DOWNLOAD_BYTES = 150 * 1024 * 1024;
// Keep the cold-start budget actionable: a board descriptor may only pull the
// shared compiler, its SDK, and a tiny Board/flash Pack. These limits leave headroom
// over the current releases while preventing a monolithic SDK from returning.
const MAX_PACK_DOWNLOAD_BYTES = Object.freeze({
  compiler: 32 * 1024 * 1024,
  sdk: 40 * 1024 * 1024,
  board: 1 * 1024 * 1024,
  flash: 1 * 1024 * 1024,
});
const targets = [
  ['ESP32', '../public/esp32/v5/xtensa/esp32.json'],
  ['ESP32-S2', '../public/esp32/v5/xtensa/esp32s2.json'],
  ['ESP32-S3', '../public/esp32/v5/xtensa/esp32s3.json'],
  ['ESP32-C3', '../public/esp32/v2/runtime/runtime.json'],
  ['ESP32-C6', '../public/esp32/v2/runtime-c6/runtime.json'],
] as const;

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('ESP32 browser cold-download budget', () => {
  it.each(targets)('%s stays below the release download ceiling', (_name, relativeDescriptor) => {
    const descriptorUrl = new URL(relativeDescriptor, import.meta.url);
    const descriptor = JSON.parse(readFileSync(descriptorUrl, 'utf8'));
    let rawBytes = 0;
    let downloadBytes = 0;
    const packDownloads = new Map<string, number>();

    for (const pack of descriptor.packs) {
      const manifestUrl = new URL(pack.manifest, descriptorUrl);
      const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
      expect(manifest.id).toBe(pack.id);
      expect(manifest.revision).toBe(pack.revision);
      let packDownloadBytes = 0;
      for (const artifact of manifest.artifacts) {
        const decodedChunks: Buffer[] = [];
        for (const chunk of artifact.chunks) {
          const transportSize = chunk.compressedSize ?? chunk.size;
          const transportSha256 = chunk.compressedSha256 ?? chunk.sha256;
          const path = fileURLToPath(new URL(chunk.path, manifestUrl));
          const transport = readFileSync(path);
          expect(statSync(path).size).toBe(transportSize);
          expect(transport.byteLength).toBe(transportSize);
          expect(sha256(transport)).toBe(transportSha256);
          if (chunk.compression === 'gzip') {
            expect(chunk.path).toContain(`-${transportSha256.slice(0, 16)}.bin.gz`);
            decodedChunks.push(gunzipSync(transport));
          } else {
            expect(chunk.compression).toBeUndefined();
            decodedChunks.push(transport);
          }
          packDownloadBytes += transportSize;
          downloadBytes += transportSize;
        }
        const decoded = Buffer.concat(decodedChunks);
        expect(decoded.byteLength).toBe(artifact.size);
        expect(sha256(decoded)).toBe(artifact.sha256);
        rawBytes += decoded.byteLength;
      }
      packDownloads.set(pack.role, (packDownloads.get(pack.role) ?? 0) + packDownloadBytes);
    }

    expect(downloadBytes).toBeLessThan(rawBytes);
    expect(downloadBytes).toBeLessThanOrEqual(MAX_COLD_DOWNLOAD_BYTES);
    expect([...packDownloads.keys()].sort()).toEqual(
      descriptor.schema === 2 ? ['board', 'compiler', 'sdk'] : ['compiler', 'flash', 'sdk'],
    );
    for (const [role, bytes] of packDownloads) {
      const limit = MAX_PACK_DOWNLOAD_BYTES[role as keyof typeof MAX_PACK_DOWNLOAD_BYTES];
      expect(limit, `${_name} ${role} Pack budget is defined`).toBeDefined();
      expect(bytes, `${_name} ${role} Pack cold download`).toBeLessThanOrEqual(limit);
    }
  });
});
