import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PREWARM_CACHE_SEED_STATE_FILE,
  prewarmCacheSeedStatePath,
  seedPrewarmedCache,
} from '../src/prewarm-cache-seed.js';

const temporaryRoots: string[] = [];

function writeDerivedEntry(root: string, name: string, content: string): void {
  const entry = join(root, 'esp32', name);
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, 'core.a'), content);
  writeFileSync(join(entry, '.arduinofast-ready'), 'ready\n');
}

function makeFixture(): { root: string; seedDir: string; cacheDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'arduinofast-prewarm-seed-'));
  temporaryRoots.push(root);
  const seedDir = join(root, 'seed');
  const cacheDir = join(root, 'cache');
  writeDerivedEntry(seedDir, 'core-bundle-a', 'trusted-prebuilt-core-a');
  mkdirSync(join(seedDir, 'l0', 'ab'), { recursive: true });
  writeFileSync(join(seedDir, 'l0', 'ab', 'ab-new.json'), '{"seed":true}');
  return { root, seedDir, cacheDir };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('prewarmed cache volume seed', () => {
  it('seeds an empty named volume once for one bundle and seed version', () => {
    const { seedDir, cacheDir } = makeFixture();
    const options = {
      seedDir,
      cacheDir,
      runtimeBundleId: 'bundle-a',
      seedBundleId: 'bundle-a',
      seedVersion: 'xtensa/default-boards',
    };

    expect(seedPrewarmedCache(options)).toEqual({
      status: 'seeded',
      resumed: false,
      merged: false,
    });
    expect(readFileSync(join(cacheDir, 'esp32', 'core-bundle-a', 'core.a'), 'utf8'))
      .toBe('trusted-prebuilt-core-a');
    expect(JSON.parse(readFileSync(
      prewarmCacheSeedStatePath(cacheDir, 'bundle-a', 'xtensa/default-boards'),
      'utf8',
    ))).toMatchObject({
      version: 2,
      status: 'complete',
      bundleId: 'bundle-a',
      seedVersion: 'xtensa/default-boards',
    });
    expect(seedPrewarmedCache(options)).toEqual({ status: 'already-seeded' });
  });

  it('merges a new bundle into an unmarked production cache without replacing entries', () => {
    const { seedDir, cacheDir } = makeFixture();
    writeDerivedEntry(cacheDir, 'core-production', 'keep-production-core');

    expect(seedPrewarmedCache({
      seedDir,
      cacheDir,
      runtimeBundleId: 'bundle-a',
      seedBundleId: 'bundle-a',
      seedVersion: 'xtensa/default-boards',
    })).toEqual({ status: 'seeded', resumed: false, merged: true });
    expect(readFileSync(join(cacheDir, 'esp32', 'core-production', 'core.a'), 'utf8'))
      .toBe('keep-production-core');
    expect(readFileSync(join(cacheDir, 'esp32', 'core-bundle-a', 'core.a'), 'utf8'))
      .toBe('trusted-prebuilt-core-a');
  });

  it('treats an existing content-addressed entry as opaque and never overwrites it', () => {
    const { seedDir, cacheDir } = makeFixture();
    writeDerivedEntry(cacheDir, 'core-bundle-a', 'existing-production-bytes');

    expect(seedPrewarmedCache({ seedDir, cacheDir })).toEqual({
      status: 'seeded',
      resumed: false,
      merged: true,
    });
    expect(readFileSync(join(cacheDir, 'esp32', 'core-bundle-a', 'core.a'), 'utf8'))
      .toBe('existing-production-bytes');
  });

  it('merges L0 files inside an existing shard without replacing an existing file', () => {
    const { seedDir, cacheDir } = makeFixture();
    mkdirSync(join(cacheDir, 'l0', 'ab'), { recursive: true });
    writeFileSync(join(cacheDir, 'l0', 'ab', 'ab-existing.json'), '{"keep":true}');
    writeFileSync(join(cacheDir, 'l0', 'ab', 'ab-new.json'), '{"production":true}');

    expect(seedPrewarmedCache({ seedDir, cacheDir })).toMatchObject({ status: 'seeded' });
    expect(readFileSync(join(cacheDir, 'l0', 'ab', 'ab-existing.json'), 'utf8'))
      .toBe('{"keep":true}');
    expect(readFileSync(join(cacheDir, 'l0', 'ab', 'ab-new.json'), 'utf8'))
      .toBe('{"production":true}');
  });

  it('resumes a v2 interrupted merge and publishes the remaining immutable entries', () => {
    const { seedDir, cacheDir } = makeFixture();
    writeDerivedEntry(cacheDir, 'core-bundle-a', 'trusted-prebuilt-core-a');
    writeDerivedEntry(seedDir, 'core-second', 'trusted-prebuilt-core-second');
    const statePath = prewarmCacheSeedStatePath(cacheDir, 'bundle-a', 'xtensa/default-boards');
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      status: 'in-progress',
      bundleId: 'bundle-a',
      seedVersion: 'xtensa/default-boards',
    }));

    expect(seedPrewarmedCache({
      seedDir,
      cacheDir,
      runtimeBundleId: 'bundle-a',
      seedBundleId: 'bundle-a',
      seedVersion: 'xtensa/default-boards',
    })).toEqual({ status: 'seeded', resumed: true, merged: true });
    expect(readFileSync(join(cacheDir, 'esp32', 'core-second', 'core.a'), 'utf8'))
      .toBe('trusted-prebuilt-core-second');
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ status: 'complete' });
  });

  it('migrates a legacy interrupted seed by merging without overwriting partial paths', () => {
    const { seedDir, cacheDir } = makeFixture();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, PREWARM_CACHE_SEED_STATE_FILE), JSON.stringify({
      version: 1,
      status: 'in-progress',
      bundleId: 'bundle-a',
    }));
    writeDerivedEntry(cacheDir, 'core-production', 'keep');

    expect(seedPrewarmedCache({
      seedDir,
      cacheDir,
      runtimeBundleId: 'bundle-a',
      seedBundleId: 'bundle-a',
      seedVersion: 'xtensa/default-boards',
    })).toEqual({ status: 'seeded', resumed: true, merged: true });
    expect(readFileSync(join(cacheDir, 'esp32', 'core-production', 'core.a'), 'utf8')).toBe('keep');
    expect(readFileSync(join(cacheDir, 'esp32', 'core-bundle-a', 'core.a'), 'utf8'))
      .toBe('trusted-prebuilt-core-a');
  });

  it('merges an upgraded bundle into a volume completed by an older bundle', () => {
    const { seedDir, cacheDir } = makeFixture();
    expect(seedPrewarmedCache({
      seedDir,
      cacheDir,
      runtimeBundleId: 'bundle-old',
      seedBundleId: 'bundle-old',
      seedVersion: 'xtensa/default-boards',
    })).toMatchObject({ status: 'seeded' });
    writeDerivedEntry(seedDir, 'core-bundle-new', 'trusted-prebuilt-core-new');

    expect(seedPrewarmedCache({
      seedDir,
      cacheDir,
      runtimeBundleId: 'bundle-new',
      seedBundleId: 'bundle-new',
      seedVersion: 'xtensa/default-boards',
    })).toEqual({ status: 'seeded', resumed: false, merged: true });
    expect(readFileSync(join(cacheDir, 'esp32', 'core-bundle-a', 'core.a'), 'utf8'))
      .toBe('trusted-prebuilt-core-a');
    expect(readFileSync(join(cacheDir, 'esp32', 'core-bundle-new', 'core.a'), 'utf8'))
      .toBe('trusted-prebuilt-core-new');
  });

  it('uses seed version independently inside one compiler bundle', () => {
    const { seedDir, cacheDir } = makeFixture();
    const base = {
      seedDir,
      cacheDir,
      runtimeBundleId: 'bundle-a',
      seedBundleId: 'bundle-a',
    };
    expect(seedPrewarmedCache({ ...base, seedVersion: 'xtensa/board-set-a' }))
      .toMatchObject({ status: 'seeded' });
    writeDerivedEntry(seedDir, 'core-extra-board', 'extra-board-core');

    expect(seedPrewarmedCache({ ...base, seedVersion: 'xtensa/board-set-b' }))
      .toEqual({ status: 'seeded', resumed: false, merged: true });
    expect(readFileSync(join(cacheDir, 'esp32', 'core-extra-board', 'core.a'), 'utf8'))
      .toBe('extra-board-core');
  });

  it('does not seed when exactly one identity is missing or identities differ', () => {
    const fixtures = [makeFixture(), makeFixture(), makeFixture()];
    const identities = [
      { runtimeBundleId: 'bundle-runtime', seedBundleId: 'bundle-seed' },
      { runtimeBundleId: 'bundle-runtime' },
      { seedBundleId: 'bundle-seed' },
    ];

    fixtures.forEach(({ seedDir, cacheDir }, index) => {
      expect(seedPrewarmedCache({ seedDir, cacheDir, ...identities[index] }))
        .toEqual({ status: 'identity-mismatch' });
      expect(existsSync(join(cacheDir, 'esp32', 'core-bundle-a', 'core.a'))).toBe(false);
      expect(existsSync(prewarmCacheSeedStatePath(cacheDir))).toBe(false);
    });
  });
});
