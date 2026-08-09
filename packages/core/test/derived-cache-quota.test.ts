import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DERIVED_CACHE_QUOTA,
  DerivedCacheManager,
  discardDerivedCacheEntry,
  derivedCacheQuotaFromEnv,
  isDerivedCacheEntryReady,
  markDerivedCacheEntryReady,
  type DerivedCacheQuota,
} from '../src/cache/derived.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'af-derived-quota-'));
  roots.push(root);
  return root;
}

function cacheEntry(
  root: string,
  namespace: 'cores' | 'libs' | 'esp32' | 'esp32-pch' | 'esp32-static',
  name: string,
  bytes: number,
  mtimeMs: number,
): string {
  const dir = join(root, namespace, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'payload.bin'), Buffer.alloc(bytes, name.charCodeAt(0)));
  const time = new Date(mtimeMs);
  utimesSync(dir, time, time);
  return dir;
}

function manager(root: string, quota: Partial<DerivedCacheQuota>): DerivedCacheManager {
  return new DerivedCacheManager(root, {
    maxTotalBytes: quota.maxTotalBytes ?? Number.MAX_SAFE_INTEGER,
    maxEntries: quota.maxEntries ?? Number.MAX_SAFE_INTEGER,
  });
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('derived cache quota configuration', () => {
  it('accepts zero and positive environment overrides', () => {
    expect(derivedCacheQuotaFromEnv({
      AF_DERIVED_CACHE_MAX_BYTES: '4096',
      AF_DERIVED_CACHE_MAX_ENTRIES: '12',
    })).toEqual({ maxTotalBytes: 4096, maxEntries: 12 });

    expect(derivedCacheQuotaFromEnv({
      AF_DERIVED_CACHE_MAX_BYTES: '0',
      AF_DERIVED_CACHE_MAX_ENTRIES: '0',
    })).toEqual({ maxTotalBytes: 0, maxEntries: 0 });
  });

  it('falls back to conservative defaults for invalid overrides', () => {
    expect(derivedCacheQuotaFromEnv({
      AF_DERIVED_CACHE_MAX_BYTES: '-1',
      AF_DERIVED_CACHE_MAX_ENTRIES: 'many',
    })).toEqual(DEFAULT_DERIVED_CACHE_QUOTA);
  });
});

describe('derived cache completion markers', () => {
  it('only accepts entries published with all required artifacts', () => {
    const root = tempRoot();
    const entry = join(root, 'cores', 'entry');
    const archive = join(entry, 'core.a');
    mkdirSync(entry, { recursive: true });
    writeFileSync(archive, 'archive', 'utf8');

    expect(isDerivedCacheEntryReady(entry, [archive])).toBe(false);
    expect(markDerivedCacheEntryReady(entry)).toBe(true);
    expect(isDerivedCacheEntryReady(entry, [archive])).toBe(true);

    rmSync(archive);
    expect(isDerivedCacheEntryReady(entry, [archive])).toBe(false);
  });

  it('discards incomplete entries without surfacing cleanup errors', () => {
    const root = tempRoot();
    const entry = cacheEntry(root, 'libs', 'partial', 10, Date.now());

    expect(() => discardDerivedCacheEntry(entry)).not.toThrow();
    expect(existsSync(entry)).toBe(false);
    expect(() => discardDerivedCacheEntry(entry)).not.toThrow();
  });
});

describe('DerivedCacheManager eviction', () => {
  it('evicts oldest entries across all derived namespaces', () => {
    const root = tempRoot();
    const oldest = cacheEntry(root, 'cores', 'oldest', 10, 1_700_000_000_000);
    const middle = cacheEntry(root, 'libs', 'middle', 10, 1_700_000_001_000);
    const newest = cacheEntry(root, 'esp32-pch', 'newest', 10, 1_700_000_002_000);
    const unrelated = cacheEntry(root, 'esp32-static', 'also-new', 10, 1_700_000_003_000);
    mkdirSync(join(root, 'l0', 'keep-me'), { recursive: true });

    const result = manager(root, { maxEntries: 2 }).prune();

    expect(result).toMatchObject({
      scannedEntries: 4,
      removedEntries: 2,
      totalEntries: 2,
      quotaSatisfied: true,
    });
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(join(root, 'l0', 'keep-me'))).toBe(true);
  });

  it('evicts enough oldest entries to meet the byte quota', () => {
    const root = tempRoot();
    const first = cacheEntry(root, 'cores', 'first', 40, 1_700_000_000_000);
    const second = cacheEntry(root, 'esp32', 'second', 40, 1_700_000_001_000);
    const third = cacheEntry(root, 'esp32-static', 'third', 40, 1_700_000_002_000);

    const result = manager(root, { maxTotalBytes: 75 }).prune();

    expect(result).toMatchObject({ removedEntries: 2, totalBytes: 40, quotaSatisfied: true });
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(existsSync(third)).toBe(true);
  });

  it('uses touch time as LRU recency', () => {
    const root = tempRoot();
    const touched = cacheEntry(root, 'cores', 'touched', 10, 1_700_000_000_000);
    const other = cacheEntry(root, 'libs', 'other', 10, 1_700_000_001_000);
    const quota = manager(root, { maxEntries: 1 });

    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_010_000);
    quota.touch(touched);
    vi.advanceTimersByTime(5_001);
    quota.prune();

    expect(existsSync(touched)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });

  it('retries pruning after the reader handoff window without another cache request', () => {
    const root = tempRoot();
    const touched = cacheEntry(root, 'cores', 'touched', 10, 1_700_000_000_000);
    const victim = cacheEntry(root, 'libs', 'victim', 10, 1_700_000_001_000);
    const quota = manager(root, { maxEntries: 0, maxTotalBytes: 0 });

    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_010_000);
    quota.touch(touched);

    const during = quota.prune();
    expect(existsSync(touched)).toBe(true);
    expect(existsSync(victim)).toBe(false);
    expect(during.quotaSatisfied).toBe(false);

    vi.advanceTimersByTime(5_001);
    expect(existsSync(touched)).toBe(false);
  });

  it('keeps concurrently leased entries and retries after the last reader releases', async () => {
    const root = tempRoot();
    const active = cacheEntry(root, 'esp32-pch', 'active', 20, 1_700_000_000_000);
    const victim = cacheEntry(root, 'libs', 'victim', 20, 1_700_000_001_000);
    const quota = manager(root, { maxEntries: 0, maxTotalBytes: 0 });
    vi.useFakeTimers();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstReader = quota.withLease(active, async () => gate);
    const secondReader = quota.withLease(active, async () => gate);

    const during = quota.prune();
    expect(existsSync(active)).toBe(true);
    expect(existsSync(victim)).toBe(false);
    expect(during.quotaSatisfied).toBe(false);

    release();
    await Promise.all([firstReader, secondReader]);
    vi.runOnlyPendingTimers();
    expect(existsSync(active)).toBe(false);
  });

  it('treats inaccessible cache roots as a best-effort no-op', () => {
    const root = tempRoot();
    const file = join(root, 'not-a-directory');
    writeFileSync(file, 'occupied', 'utf8');
    const quota = manager(file, { maxEntries: 0, maxTotalBytes: 0 });

    expect(() => quota.touch(join(file, 'cores', 'entry'))).not.toThrow();
    expect(quota.prune()).toEqual({
      scannedEntries: 0,
      removedEntries: 0,
      totalBytes: 0,
      totalEntries: 0,
      quotaSatisfied: true,
    });
  });
});
