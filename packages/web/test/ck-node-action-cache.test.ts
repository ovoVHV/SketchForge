import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeFilesystemActionCache } from '../../../scripts/ck-node-action-cache.mjs';

const KEY = '1'.repeat(64);
const DIGEST = '2'.repeat(64);

describe('Node browser Action cache', () => {
  it('round-trips content-addressed outputs without sharing mutable bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ck-node-action-cache-'));
    try {
      const cache = new NodeFilesystemActionCache(directory);
      await cache.put({
        actionKey: KEY,
        outputs: [{ path: 'build/unit.o', sha256: DIGEST, bytes: new Uint8Array([1, 2, 3]) }],
      });
      const first = await cache.get(KEY);
      expect([...first!.outputs[0]!.bytes]).toEqual([1, 2, 3]);
      first!.outputs[0]!.bytes[0] = 9;
      expect([...(await cache.get(KEY))!.outputs[0]!.bytes]).toEqual([1, 2, 3]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('treats malformed and oversized entries as cache misses', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ck-node-action-cache-bad-'));
    try {
      const cache = new NodeFilesystemActionCache(directory, { maxEntryBytes: 128 });
      const shard = join(directory, KEY.slice(0, 2));
      await cache.put({
        actionKey: KEY,
        outputs: [{ path: 'build/unit.o', sha256: DIGEST, bytes: new Uint8Array(256) }],
      });
      expect(await cache.get(KEY)).toBeNull();
      mkdirSync(shard, { recursive: true });
      writeFileSync(join(shard, `${KEY}.json`), '{bad json', 'utf8');
      expect(readFileSync(join(shard, `${KEY}.json`), 'utf8')).toContain('bad json');
      expect(await cache.get(KEY)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
