import { describe, expect, it } from 'vitest';
import {
  assertFeaturedFirmwareManifest,
  createFeaturedFirmwareManifest,
  mergeFeaturedFirmwareManifests,
} from '../src/prebuild-featured-firmware.js';
import { compilerHostRuntimeIdentity } from '../src/compiler-runtime-release.js';
import type { WorkerPool } from '../src/worker-pools.js';

const digest = (value: string) => value.repeat(64);
const releaseId = `sha256:${digest('9')}`;

function runtime(pool: WorkerPool = 'avr', value = '1') {
  const imageDigest = `sha256:${digest(value)}`;
  return {
    compileReleaseId: releaseId,
    pool,
    imageDigest,
    hostRuntimeIdentity: compilerHostRuntimeIdentity({
      pool,
      mode: 'oci-image',
      platform: 'linux/amd64',
      imageDigest,
    }),
  };
}

function entry(id = 'featured-a', identity = digest('a')) {
  return {
    id,
    combinationId: 'dht-sensor',
    combinationName: 'DHT sensor',
    fqbn: 'arduino:avr:uno',
    options: { cpu: 'atmega328p', lto: 'on' },
    combinationIdentity: identity,
    sourceSha256: digest('b'),
    buildIrSha256: digest('c'),
    packSetSha256: digest('d'),
    resolvedLibraries: [
      { name: 'DHT sensor library', version: '1.4.7', sha256: digest('e') },
      { name: 'Adafruit Unified Sensor', version: '1.1.15', sha256: digest('f') },
    ],
    cacheReplay: { actions: 8, cachedActions: 8, allCached: true as const },
    artifacts: [{
      name: 'firmware.hex', offset: null, sha256: digest('1'), size: 128,
      url: 'https://cdn.test/firmware.hex',
    }],
  };
}

describe('featured firmware release manifest', () => {
  it('normalizes options, libraries, and artifacts under a deterministic digest', () => {
    const input = entry();
    const first = createFeaturedFirmwareManifest('bundle-v1', [runtime()], [input], '2026-08-08T00:00:00.000Z');
    const second = createFeaturedFirmwareManifest('bundle-v1', [runtime()], [{
      ...input,
      options: { lto: 'on', cpu: 'atmega328p' },
      resolvedLibraries: [...input.resolvedLibraries].reverse(),
    }], '2026-08-08T00:00:00.000Z');
    expect(second).toEqual(first);
    expect(() => assertFeaturedFirmwareManifest(first)).not.toThrow();
    expect(first.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.schema).toBe(2);
    expect(first.runtimeIdentities).toEqual([runtime()]);
  });

  it('rejects cache misses, tampering, duplicate identities, and mixed bundles', () => {
    const first = createFeaturedFirmwareManifest('bundle-v1', [runtime()], [entry()], '2026-08-08T00:00:00.000Z');
    const second = createFeaturedFirmwareManifest('bundle-v1', [runtime()], [
      entry('featured-b', digest('2')),
    ], '2026-08-08T00:01:00.000Z');
    const merged = mergeFeaturedFirmwareManifests([second, first]);
    expect(merged.entries.map((candidate) => candidate.id)).toEqual(['featured-a', 'featured-b']);
    expect(merged.generatedAt).toBe('2026-08-08T00:01:00.000Z');
    expect(mergeFeaturedFirmwareManifests([
      createFeaturedFirmwareManifest('bundle-v1', [runtime('avr')], [], '2026-08-08T00:00:00.000Z'),
      createFeaturedFirmwareManifest('bundle-v1', [runtime('esp32-xtensa', '2')], [], '2026-08-08T00:01:00.000Z'),
      createFeaturedFirmwareManifest('bundle-v1', [runtime('esp32-riscv', '3')], [], '2026-08-08T00:02:00.000Z'),
    ]).runtimeIdentities.map((identity) => identity.pool)).toEqual([
      'avr',
      'esp32-xtensa',
      'esp32-riscv',
    ]);
    expect(() => mergeFeaturedFirmwareManifests([first, first])).toThrow(/duplicate/);
    expect(() => mergeFeaturedFirmwareManifests([
      first,
      createFeaturedFirmwareManifest('bundle-v2', [runtime()], [], '2026-08-08T00:00:00.000Z'),
    ])).toThrow(/different compiler bundles/);
    expect(() => mergeFeaturedFirmwareManifests([
      first,
      createFeaturedFirmwareManifest('bundle-v1', [runtime('avr', '2')], [], '2026-08-08T00:00:00.000Z'),
    ])).toThrow(/evidence drift/);
    expect(() => assertFeaturedFirmwareManifest({ ...first, entries: [] })).toThrow(/digest mismatch/);

    const missed = { ...entry(), cacheReplay: { actions: 8, cachedActions: 7, allCached: true as const } };
    const invalid = createFeaturedFirmwareManifest('bundle-v1', [runtime()], [missed], '2026-08-08T00:00:00.000Z');
    expect(() => assertFeaturedFirmwareManifest(invalid)).toThrow(/entry is invalid/);
  });
});
