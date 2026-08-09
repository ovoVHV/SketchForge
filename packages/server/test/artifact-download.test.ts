import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerArtifactDownloadRoute } from '../src/artifact-download.js';
import {
  ArtifactStoreUnavailableError,
  type ArtifactStore,
} from '../src/artifact-store.js';

function fakeStore(overrides: Partial<ArtifactStore> = {}): ArtifactStore {
  return {
    kind: 'local',
    externalize: async (result) => result,
    open: async () => null,
    ...overrides,
  };
}

describe('artifact download response', () => {
  it('streams firmware with stable size and content-address metadata', async () => {
    const bytes = Buffer.from(':00000001FF\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let consumed = false;
    const app = Fastify();
    registerArtifactDownloadRoute(app, fakeStore({
      open: async () => ({
        sha256,
        size: bytes.length,
        body: Readable.from((async function* firmware() {
          consumed = true;
          yield bytes.subarray(0, 5);
          yield bytes.subarray(5);
        })()),
      }),
    }));

    try {
      expect(consumed).toBe(false);
      const response = await app.inject({
        method: 'GET',
        url: `/v1/artifacts/${sha256}/firmware.hex`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(bytes);
      expect(consumed).toBe(true);
      expect(response.headers).toMatchObject({
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="firmware.hex"',
        'content-length': String(bytes.length),
        'cache-control': 'public, max-age=31536000, immutable',
        etag: `"${sha256}"`,
      });
    } finally {
      await app.close();
    }
  });

  it('preserves missing and unavailable storage responses', async () => {
    const sha256 = 'a'.repeat(64);
    const missing = Fastify();
    registerArtifactDownloadRoute(missing, fakeStore());
    try {
      const response = await missing.inject(`/v1/artifacts/${sha256}/firmware.bin`);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'not_found', message: '固件不存在或已过期' });
    } finally {
      await missing.close();
    }

    const unavailable = Fastify();
    registerArtifactDownloadRoute(unavailable, fakeStore({
      open: async () => { throw new ArtifactStoreUnavailableError('offline'); },
    }));
    try {
      const response = await unavailable.inject(`/v1/artifacts/${sha256}/firmware.bin`);
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('2');
      expect(response.json()).toEqual({
        error: 'artifact_storage_unavailable',
        message: 'artifact storage is temporarily unavailable',
      });
    } finally {
      await unavailable.close();
    }
  });

  it('keeps private object-store redirects out of immutable caches', async () => {
    const sha256 = 'b'.repeat(64);
    const open = vi.fn(async () => null);
    const app = Fastify();
    registerArtifactDownloadRoute(app, fakeStore({
      open,
      redirectUrl: async () => 'https://signed.example.test/object?signature=fresh',
    }));

    try {
      const response = await app.inject(`/v1/artifacts/${sha256}/firmware.bin`);
      expect(response.statusCode).toBe(307);
      expect(response.headers.location).toBe('https://signed.example.test/object?signature=fresh');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(open).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
