import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileL0Cache, type CachedEntry } from '../src/cache/l0.js';

const temporaryDirectories: string[] = [];

function makeTempDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arduinofast-l0-'));
  temporaryDirectories.push(dir);
  return dir;
}

function key(character: string): string {
  return character.repeat(64);
}

function cachePath(dir: string, cacheKey: string): string {
  return join(dir, cacheKey.slice(0, 2), `${cacheKey}.json`);
}

function entry(createdAt = Date.now(), payload = 'firmware'): CachedEntry {
  return {
    artifacts: [{ name: payload }],
    staticArtifacts: [],
    diagnostics: [],
    createdAt,
  };
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('FileL0Cache', () => {
  it('round-trips entries and treats a null key as a no-op', () => {
    const dir = makeTempDirectory();
    const cache = new FileL0Cache(dir);
    const value = entry();

    cache.set(null, value);
    expect(cache.get(null)).toBeNull();

    const cacheKey = key('a');
    cache.set(cacheKey, value);
    expect(cache.get(cacheKey)).toEqual(value);
  });

  it('atomically replaces an existing entry without leaving temporary files', () => {
    const dir = makeTempDirectory();
    const cache = new FileL0Cache(dir);
    const cacheKey = key('b');

    for (let index = 0; index < 40; index += 1) {
      cache.set(cacheKey, entry(Date.now(), `firmware-${index}`));
      expect(() => JSON.parse(readFileSync(cachePath(dir, cacheKey), 'utf8'))).not.toThrow();
    }

    expect(cache.get(cacheKey)?.artifacts).toEqual([{ name: 'firmware-39' }]);
    expect(readdirSync(join(dir, cacheKey.slice(0, 2))).filter((name) => name.endsWith('.tmp')))
      .toEqual([]);
  });

  it('deletes expired entries on read', () => {
    const dir = makeTempDirectory();
    const cache = new FileL0Cache(dir, { ttlMs: 50 });
    const cacheKey = key('c');
    const path = cachePath(dir, cacheKey);
    mkdirSync(join(dir, cacheKey.slice(0, 2)), { recursive: true });
    writeFileSync(path, JSON.stringify(entry(Date.now() - 1_000)), 'utf8');

    expect(cache.get(cacheKey)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it('deletes malformed and structurally invalid entries on read', () => {
    const dir = makeTempDirectory();
    const cache = new FileL0Cache(dir);
    const malformedKey = key('d');
    const invalidKey = key('e');
    const shard = join(dir, malformedKey.slice(0, 2));
    mkdirSync(shard, { recursive: true });

    const malformedPath = cachePath(dir, malformedKey);
    writeFileSync(malformedPath, '{broken json', 'utf8');
    expect(cache.get(malformedKey)).toBeNull();
    expect(existsSync(malformedPath)).toBe(false);

    const invalidPath = cachePath(dir, invalidKey);
    mkdirSync(join(dir, invalidKey.slice(0, 2)), { recursive: true });
    writeFileSync(invalidPath, JSON.stringify({ ...entry(), diagnostics: 'not-an-array' }), 'utf8');
    expect(cache.get(invalidKey)).toBeNull();
    expect(existsSync(invalidPath)).toBe(false);
  });

  it('evicts the oldest entry when maxEntries is exceeded', () => {
    const dir = makeTempDirectory();
    const cache = new FileL0Cache(dir, {
      ttlMs: 60_000,
      maxEntries: 2,
      maxTotalBytes: 1024 * 1024,
    });
    const now = Date.now();
    const oldest = key('f');
    const middle = key('1');
    const newest = key('2');

    cache.set(oldest, entry(now - 3_000, 'oldest'));
    cache.set(middle, entry(now - 2_000, 'middle'));
    cache.set(newest, entry(now - 1_000, 'newest'));

    expect(cache.get(oldest)).toBeNull();
    expect(cache.get(middle)).not.toBeNull();
    expect(cache.get(newest)).not.toBeNull();
  });

  it('evicts oldest entries until maxTotalBytes is satisfied', () => {
    const dir = makeTempDirectory();
    const now = Date.now();
    const values = [
      entry(now - 3_000, 'a'.repeat(160)),
      entry(now - 2_000, 'b'.repeat(160)),
      entry(now - 1_000, 'c'.repeat(160)),
    ];
    const twoEntryBytes = Buffer.byteLength(JSON.stringify(values[1]), 'utf8')
      + Buffer.byteLength(JSON.stringify(values[2]), 'utf8');
    const cache = new FileL0Cache(dir, {
      ttlMs: 60_000,
      maxEntries: 10,
      maxTotalBytes: twoEntryBytes,
    });
    const keys = [key('3'), key('4'), key('5')];

    values.forEach((value, index) => cache.set(keys[index]!, value));

    expect(cache.get(keys[0]!)).toBeNull();
    expect(cache.get(keys[1]!)).not.toBeNull();
    expect(cache.get(keys[2]!)).not.toBeNull();
  });

  it('does not cache an entry larger than maxTotalBytes', () => {
    const dir = makeTempDirectory();
    const value = entry(Date.now(), 'x'.repeat(256));
    const serializedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    const cache = new FileL0Cache(dir, { maxTotalBytes: serializedBytes - 1 });
    const cacheKey = key('6');

    cache.set(cacheKey, value);

    expect(cache.get(cacheKey)).toBeNull();
    expect(existsSync(cachePath(dir, cacheKey))).toBe(false);
  });

  it('rejects invalid capacity and lifetime options', () => {
    const dir = makeTempDirectory();

    expect(() => new FileL0Cache(join(dir, 'ttl'), { ttlMs: -1 })).toThrow(RangeError);
    expect(() => new FileL0Cache(join(dir, 'entries'), { maxEntries: 1.5 })).toThrow(RangeError);
    expect(() => new FileL0Cache(join(dir, 'bytes'), { maxTotalBytes: Number.POSITIVE_INFINITY }))
      .toThrow(RangeError);
  });

  it('does not let unavailable storage fail cache operations', () => {
    const path = join(makeTempDirectory(), 'not-a-directory');
    writeFileSync(path, 'occupied', 'utf8');

    expect(() => {
      const cache = new FileL0Cache(path);
      cache.set(key('7'), entry());
      expect(cache.get(key('7'))).toBeNull();
    }).not.toThrow();
  });

  it('rejects keys that could escape the cache directory', () => {
    const dir = makeTempDirectory();
    const cache = new FileL0Cache(dir);

    cache.set('../outside', entry());

    expect(cache.get('../outside')).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });
});
