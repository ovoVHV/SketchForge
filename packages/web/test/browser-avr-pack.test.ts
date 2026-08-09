import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AVR_BOARD_PACK,
  AVR_PLATFORM_PACK,
  AVR_TOOLCHAIN_PACK,
} from '../public/avr/v4/release.js';
import {
  browserToolchainPackRevisionInput,
  validateBrowserToolchainPackManifest,
} from '../browser-toolchain/toolchain-pack.js';
import {
  openAssetPack,
  validateAssetPackDescriptor,
} from '../browser-avr/asset-pack.js';

const require = createRequire(import.meta.url);
const runtimeDir = fileURLToPath(new URL('../public/avr/v4/', import.meta.url));
const assetsDir = join(runtimeDir, 'assets');
const runtimeManifest = JSON.parse(readFileSync(join(assetsDir, 'manifest.json'), 'utf8'));
const roles = ['toolchain', 'platform', 'board'] as const;
const releases = {
  toolchain: AVR_TOOLCHAIN_PACK,
  platform: AVR_PLATFORM_PACK,
  board: AVR_BOARD_PACK,
};
const packManifests = Object.fromEntries(roles.map((role) => [
  role,
  JSON.parse(readFileSync(join(runtimeDir, runtimeManifest.packs[role].manifest), 'utf8')),
]));

describe('AVR asset Pack index', () => {
  const descriptor = {
    file: 'assets.pack',
    size: 5,
    sha256: '0'.repeat(64),
    entries: [
      { path: 'a.txt', offset: 0, length: 2 },
      { path: 'nested/b.bin', offset: 2, length: 3 },
    ],
  };

  it('returns zero-copy slices by offset and length', () => {
    const pack = openAssetPack(descriptor, new Uint8Array([1, 2, 3, 4, 5]));
    expect([...pack.read('/a.txt')]).toEqual([1, 2]);
    expect([...pack.read('nested/b.bin')]).toEqual([3, 4, 5]);
  });

  it('rejects traversal, unsorted entries, holes, and out-of-bounds bodies', () => {
    expect(() => openAssetPack(descriptor, new Uint8Array(4))).toThrow(/byte length mismatch/);
    expect(() => validateAssetPackDescriptor({
      ...descriptor,
      entries: [{ path: '../a', offset: 0, length: 5 }],
    })).toThrow(/invalid packed asset path/);
    expect(() => validateAssetPackDescriptor({
      ...descriptor,
      entries: [
        { path: 'b', offset: 0, length: 2 },
        { path: 'a', offset: 2, length: 3 },
      ],
    })).toThrow(/strictly sorted/);
    expect(() => validateAssetPackDescriptor({
      ...descriptor,
      entries: [{ path: 'a', offset: 1, length: 5 }],
    })).toThrow(/offset/);
  });
});

describe('generated AVR v4 physical Pack split', () => {
  it('assigns every runtime asset to exactly one content-addressed Pack', () => {
    expect(runtimeManifest.schema).toBe(3);
    expect(runtimeManifest).not.toHaveProperty('generatedAt');
    expect(runtimeManifest).not.toHaveProperty('assetPack');

    const allPaths = new Set<string>();
    let entryCount = 0;
    for (const role of roles) {
      const descriptor = runtimeManifest.packs[role].assetPack;
      const entries = validateAssetPackDescriptor(descriptor);
      const body = readFileSync(join(assetsDir, descriptor.file));
      expect(body.byteLength, role).toBe(descriptor.size);
      expect(sha256(body), role).toBe(descriptor.sha256);
      expect(descriptor.file, role).toMatch(new RegExp(`${descriptor.sha256}\\.pack$`));
      for (const path of entries.keys()) {
        expect(allPaths.has(path), path).toBe(false);
        allPaths.add(path);
      }
      entryCount += entries.size;
    }
    expect(entryCount).toBe(
      runtimeManifest.headerFiles.length
      + runtimeManifest.objectFiles.length
      + runtimeManifest.libs.length
      + 1,
    );
    expect(readdirSync(assetsDir).sort()).toEqual([
      'manifest.json',
      ...roles.map((role) => runtimeManifest.packs[role].assetPack.file),
    ].sort());
  });

  it('keeps sysroot/libs, core, and variant bytes under their correct owners', () => {
    const upstreamDir = dirname(require.resolve('@horang-corp/avr-gcc-wasm/package.json'));
    const samples = [
      ['toolchain', 'fs/sysroot/avr/include/avr/io.h', join(upstreamDir, 'assets', 'fs', 'sysroot', 'avr', 'include', 'avr', 'io.h')],
      ['toolchain', 'ldscripts/avr5.xn', join(upstreamDir, 'assets', 'ldscripts', 'avr5.xn')],
      ['platform', 'fs/arduino/core/Arduino.h', join(upstreamDir, 'assets', 'fs', 'arduino', 'core', 'Arduino.h')],
      ['platform', 'objects/core_main.o', join(upstreamDir, 'assets', 'objects', 'core_main.o')],
      ['board', 'fs/arduino/variant/pins_arduino.h', join(upstreamDir, 'assets', 'fs', 'arduino', 'variant', 'pins_arduino.h')],
    ] as const;

    for (const [role, path, upstreamPath] of samples) {
      const descriptor = runtimeManifest.packs[role].assetPack;
      const body = readFileSync(join(assetsDir, descriptor.file));
      const entry = descriptor.entries.find((candidate: any) => candidate.path === path);
      expect(entry, `${role}:${path}`).toBeTruthy();
      expect(body.subarray(entry.offset, entry.offset + entry.length).equals(readFileSync(upstreamPath)), path).toBe(true);
      for (const other of roles.filter((candidate) => candidate !== role)) {
        expect(runtimeManifest.packs[other].assetPack.entries.some((candidate: any) => candidate.path === path)).toBe(false);
      }
    }
  });

  it('publishes independently pinned Toolchain, Platform, and Board manifests', () => {
    expect(releases).toMatchObject({
      toolchain: { id: 'avr-gcc-atmega328p-wasm', version: '0.2.0-ck4' },
      platform: { id: 'arduino-avr-core', version: '1.8.6' },
      board: { id: 'arduino-avr-uno-board', version: '1' },
    });
    expect(new Set(roles.map((role) => releases[role].revision)).size).toBe(3);

    for (const role of roles) {
      const pack = validateBrowserToolchainPackManifest(packManifests[role]);
      const descriptor = runtimeManifest.packs[role];
      expect(pack).toMatchObject(releases[role]);
      expect(descriptor).toMatchObject({
        kind: role,
        id: pack.id,
        version: pack.version,
        revision: pack.revision,
      });
      expect(sha256(browserToolchainPackRevisionInput(packManifests[role]))).toBe(pack.revision);
      expect(pack.artifacts.find((artifact) => artifact.id === descriptor.artifactId)).toMatchObject({
        kind: 'asset-pack',
        size: descriptor.assetPack.size,
        sha256: descriptor.assetPack.sha256,
      });

      for (const artifact of pack.artifacts) {
        const chunks = artifact.chunks.map((chunk) => readFileSync(join(runtimeDir, chunk.path)));
        const body = Buffer.concat(chunks);
        expect(body.byteLength, `${role}:${artifact.id}`).toBe(artifact.size);
        expect(sha256(body), `${role}:${artifact.id}`).toBe(artifact.sha256);
        for (let index = 0; index < artifact.chunks.length; index++) {
          expect(sha256(chunks[index]!), `${role}:${artifact.id}:${index}`).toBe(artifact.chunks[index]!.sha256);
        }
      }
    }

    expect(packManifests.toolchain.artifacts.map((artifact: any) => artifact.id)).toEqual([
      'avr-as-wasm',
      'avr-ld-wasm',
      'avr-objcopy-wasm',
      'cc1plus-wasm',
      'runtime-assets',
    ]);
    expect(packManifests.platform.artifacts.map((artifact: any) => artifact.id)).toEqual(['core-assets']);
    expect(packManifests.board.artifacts.map((artifact: any) => artifact.id)).toEqual(['variant-assets']);
  });
});

function sha256(value: string | NodeJS.ArrayBufferView) {
  return createHash('sha256').update(value).digest('hex');
}
