import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileActionCache } from '@sketchforge/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  workerRuntimeCacheDirectory,
  workerRuntimeCacheNamespace,
} from '../src/worker-runtime-cache.js';
import { seedPrewarmedCache } from '../src/prewarm-cache-seed.js';

const roots: string[] = [];
const releaseA = `sha256:${'a'.repeat(64)}`;
const releaseB = `sha256:${'b'.repeat(64)}`;
const hostA = `sha256:${'c'.repeat(64)}`;
const hostB = `sha256:${'d'.repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('worker runtime cache namespace', () => {
  it('binds bundle, compile release, pool, and host runtime identity', () => {
    const baseline = workerRuntimeCacheNamespace('bundle-v1', releaseA, 'avr', hostA);
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    expect(workerRuntimeCacheNamespace('bundle-v1', releaseA, 'avr', hostA)).toBe(baseline);
    expect(workerRuntimeCacheNamespace('bundle-v2', releaseA, 'avr', hostA)).not.toBe(baseline);
    expect(workerRuntimeCacheNamespace('bundle-v1', releaseB, 'avr', hostA)).not.toBe(baseline);
    expect(workerRuntimeCacheNamespace('bundle-v1', releaseA, 'esp32-riscv', hostA))
      .not.toBe(baseline);
    expect(workerRuntimeCacheNamespace('bundle-v1', releaseA, 'avr', hostB)).not.toBe(baseline);
  });

  it('keeps unverified-local explicit and rejects accepted impersonation', () => {
    expect(workerRuntimeCacheNamespace(
      'development',
      'unverified-local',
      'avr',
      'unverified-local',
    )).toMatch(/^[a-f0-9]{64}$/);
    expect(() => workerRuntimeCacheNamespace(
      'development',
      'unverified-local',
      'avr',
      hostA,
    )).toThrow(/does not match compile release trust/);
  });

  it('prevents the same Action key from hitting across releases or host identities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-worker-runtime-cache-'));
    roots.push(root);
    const options = { ttlMs: 0, maxEntries: 100, maxTotalBytes: 1024 * 1024, pruneIntervalMs: 0 };
    const firstDirectory = workerRuntimeCacheDirectory(root, 'bundle-v1', releaseA, 'avr', hostA);
    const otherReleaseDirectory = workerRuntimeCacheDirectory(root, 'bundle-v1', releaseB, 'avr', hostA);
    const otherHostDirectory = workerRuntimeCacheDirectory(root, 'bundle-v1', releaseA, 'avr', hostB);
    expect(workerRuntimeCacheDirectory(firstDirectory, 'bundle-v1', releaseA, 'avr', hostA))
      .toBe(firstDirectory);
    const first = new FileActionCache(firstDirectory, options);
    const otherRelease = new FileActionCache(otherReleaseDirectory, options);
    const otherHost = new FileActionCache(otherHostDirectory, options);
    const actionKey = '1'.repeat(64);
    const bytes = new TextEncoder().encode('runtime-bound output');
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    await first.put({
      actionKey,
      outputs: [{ path: 'build/output.bin', sha256, bytes }],
    });

    await expect(new FileActionCache(firstDirectory, options).get(actionKey))
      .resolves.toMatchObject({ actionKey });
    await expect(otherRelease.get(actionKey)).resolves.toBeNull();
    await expect(otherHost.get(actionKey)).resolves.toBeNull();
  });

  it('seeds only the runtime-specific cache directory selected by the entrypoint', () => {
    const root = mkdtempSync(join(tmpdir(), 'af-worker-runtime-seed-'));
    roots.push(root);
    const seedDir = join(root, 'seed');
    mkdirSync(join(seedDir, 'actions'), { recursive: true });
    writeFileSync(join(seedDir, 'actions', 'sentinel'), 'prewarmed');
    const firstDirectory = workerRuntimeCacheDirectory(root, 'bundle-v1', releaseA, 'avr', hostA);
    const otherDirectory = workerRuntimeCacheDirectory(root, 'bundle-v1', releaseB, 'avr', hostA);

    expect(seedPrewarmedCache({
      cacheDir: firstDirectory,
      seedDir,
      runtimeBundleId: 'bundle-v1',
      seedBundleId: 'bundle-v1',
      seedVersion: 'avr/default',
    })).toMatchObject({ status: 'seeded' });
    expect(existsSync(join(firstDirectory, 'actions', 'sentinel'))).toBe(true);
    expect(existsSync(join(otherDirectory, 'actions', 'sentinel'))).toBe(false);
  });
});
