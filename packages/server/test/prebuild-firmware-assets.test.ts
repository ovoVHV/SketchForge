import { describe, expect, it } from 'vitest';
import {
  createPrebuiltFirmwareManifest,
  mergePrebuiltFirmwareManifests,
} from '../src/prebuild-firmware-assets.js';
import { compilerHostRuntimeIdentity } from '../src/compiler-runtime-release.js';
import type { WorkerPool } from '../src/worker-pools.js';

const digest = (value: string) => value.repeat(64);
const releaseId = `sha256:${digest('9')}`;

function runtime(pool: WorkerPool = 'esp32-riscv', value = '1') {
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

describe('prebuilt static firmware manifest', () => {
  it('normalizes entries and binds the complete publication to one digest', () => {
    const input = [{
      id: 'entry-b',
      fqbn: 'esp32:esp32:esp32c3',
      options: { flash_size: '4MB', flash_mode: 'dio' },
      matrixIdentity: digest('a'),
      buildIrSha256: digest('b'),
      packSetSha256: digest('c'),
      artifacts: [
        { name: 'partitions.bin', offset: '0x8000', sha256: digest('d'), size: 4, url: 'https://cdn.test/p' },
        { name: 'bootloader.bin', offset: '0x0', sha256: digest('e'), size: 8, url: 'https://cdn.test/b' },
      ],
    }];
    const first = createPrebuiltFirmwareManifest('bundle-v1', [runtime()], input, '2026-08-08T00:00:00.000Z');
    const second = createPrebuiltFirmwareManifest('bundle-v1', [runtime()], [{
      ...input[0]!,
      options: { flash_mode: 'dio', flash_size: '4MB' },
      artifacts: [...input[0]!.artifacts].reverse(),
    }], '2026-08-08T00:00:00.000Z');
    expect(second).toEqual(first);
    expect(first.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.schema).toBe(2);
    expect(first.runtimeIdentities).toEqual([runtime()]);
    expect(first.entries[0]?.artifacts.map((artifact) => artifact.name))
      .toEqual(['bootloader.bin', 'partitions.bin']);
  });

  it('merges verified shards and rejects tampering, overlap, or mixed bundles', () => {
    const entry = {
      id: 'entry-a', fqbn: 'esp32:esp32:esp32c3', options: {},
      matrixIdentity: digest('a'), buildIrSha256: digest('b'), packSetSha256: digest('c'),
      artifacts: [{ name: 'bootloader.bin', offset: '0x0', sha256: digest('d'), size: 4 }],
    };
    const first = createPrebuiltFirmwareManifest('bundle-v1', [runtime()], [entry], '2026-08-08T00:00:00.000Z');
    const second = createPrebuiltFirmwareManifest('bundle-v1', [runtime()], [{
      ...entry, id: 'entry-b', matrixIdentity: digest('e'),
    }], '2026-08-08T00:01:00.000Z');
    const merged = mergePrebuiltFirmwareManifests([second, first]);
    expect(merged.entries.map((candidate) => candidate.id)).toEqual(['entry-a', 'entry-b']);
    expect(merged.generatedAt).toBe('2026-08-08T00:01:00.000Z');
    expect(mergePrebuiltFirmwareManifests(Array.from({ length: 16 }, (_, index) => (
      createPrebuiltFirmwareManifest(
        'bundle-v1',
        [runtime()],
        [],
        `2026-08-08T00:${String(index).padStart(2, '0')}:00.000Z`,
      )
    ))).runtimeIdentities).toEqual([runtime()]);
    expect(() => mergePrebuiltFirmwareManifests([first, first])).toThrow(/duplicate/);
    expect(() => mergePrebuiltFirmwareManifests([
      first,
      createPrebuiltFirmwareManifest('bundle-v2', [runtime()], [], '2026-08-08T00:00:00.000Z'),
    ])).toThrow(/different compiler bundles/);
    expect(() => mergePrebuiltFirmwareManifests([
      first,
      createPrebuiltFirmwareManifest('bundle-v1', [runtime('esp32-riscv', '2')], [], '2026-08-08T00:00:00.000Z'),
    ])).toThrow(/evidence drift/);
    expect(() => mergePrebuiltFirmwareManifests([
      first,
      createPrebuiltFirmwareManifest('bundle-v1', [{
        ...runtime('esp32-xtensa', '2'),
        compileReleaseId: `sha256:${digest('8')}`,
      }], [], '2026-08-08T00:00:00.000Z'),
    ])).toThrow(/mixes compile releases/);
    expect(() => createPrebuiltFirmwareManifest('bundle-v1', [{
      ...runtime(),
      imageDigest: `sha256:${digest('7')}`,
    }], [], '2026-08-08T00:00:00.000Z')).toThrow(/identity does not match/);
    expect(() => mergePrebuiltFirmwareManifests([{ ...first, entries: [] }]))
      .toThrow(/digest mismatch/);
  });
});
