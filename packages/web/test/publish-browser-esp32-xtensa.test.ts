import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  contentAddressedPackManifestPath,
  migrateEsp32XtensaPublication,
  packDownloadTotals,
  publicationDescriptor,
  publicationDownloads,
  updateXtensaReleasePins,
} from '../../../scripts/publish-browser-esp32-xtensa.mjs';

function pack(...artifacts: Array<{ size: number, chunks: Array<{ size: number, compressedSize?: number }> }>) {
  return { artifacts };
}

describe('ESP32 Xtensa publication download report', () => {
  it('derives immutable Pack paths from validated identities', () => {
    const revision = 'a'.repeat(64);
    expect(contentAddressedPackManifestPath('xtensa-esp-elf-wasm', revision))
      .toBe(`packs/xtensa-esp-elf-wasm/${revision}/toolchain.json`);
    expect(() => contentAddressedPackManifestPath('../compiler', revision)).toThrow(/content address/);
    expect(() => contentAddressedPackManifestPath('compiler', 'latest')).toThrow(/content address/);
  });

  it('publishes schema v2 Board Packs without changing their identities', () => {
    const descriptor = {
      schema: 2,
      packs: [
        { role: 'compiler', id: 'compiler', revision: 'a'.repeat(64), manifest: 'packs/compiler/toolchain.json' },
        { role: 'sdk', id: 'sdk', revision: 'b'.repeat(64), manifest: 'packs/sdk/toolchain.json' },
        { role: 'board', id: 'board', revision: 'c'.repeat(64), manifest: 'packs/board/toolchain.json' },
      ],
    };

    expect(publicationDescriptor(descriptor, 'esp32s3').packs).toEqual([
      { ...descriptor.packs[0], manifest: `packs/compiler/${'a'.repeat(64)}/toolchain.json` },
      { ...descriptor.packs[1], manifest: `packs/sdk/${'b'.repeat(64)}/toolchain.json` },
      { ...descriptor.packs[2], manifest: `packs/board/${'c'.repeat(64)}/toolchain.json` },
    ]);
    expect(descriptor.packs[2]?.manifest).toBe('packs/board/toolchain.json');
  });

  it('rejects the retired runtime descriptor schema and flash role', () => {
    const compiler = { role: 'compiler', id: 'compiler', revision: 'a'.repeat(64), manifest: 'old' };
    const sdk = { role: 'sdk', id: 'sdk', revision: 'b'.repeat(64), manifest: 'old' };
    const board = { role: 'board', id: 'board', revision: 'c'.repeat(64), manifest: 'old' };

    expect(() => publicationDescriptor({ schema: 1, packs: [compiler, sdk, board] }, 'esp32'))
      .toThrow(/schema 2/);
    expect(() => publicationDescriptor({ schema: 2, packs: [compiler, sdk, { ...board, role: 'flash' }] }, 'esp32'))
      .toThrow(/schema 2/);
    expect(() => publicationDescriptor({ schema: 2, packs: [compiler, sdk] }, 'esp32'))
      .toThrow(/schema 2/);
  });

  it('does not accept a retired flash Pack fallback in download reports', () => {
    const compiler = pack({ size: 1, chunks: [{ size: 1 }] });
    const sdk = pack({ size: 1, chunks: [{ size: 1 }] });
    const flash = pack({ size: 1, chunks: [{ size: 1 }] });
    expect(() => publicationDownloads([{ board: 'esp32:esp32:esp32', compiler, sdk, flash } as any]))
      .toThrow();
  });

  it('derives raw and transport totals from the immutable Pack manifests', () => {
    const compiler = pack({
      size: 100,
      chunks: [{ size: 60, compressedSize: 20 }, { size: 40, compressedSize: 15 }],
    });
    const sdk = pack({ size: 200, chunks: [{ size: 200, compressedSize: 80 }] });
    const boardPack = pack({ size: 30, chunks: [{ size: 30, compressedSize: 25 }] });

    expect(packDownloadTotals(compiler)).toEqual({ rawBytes: 100, downloadBytes: 35 });
    expect(publicationDownloads([
      { board: 'esp32:esp32:esp32', compiler, sdk, boardPack },
      { board: 'esp32:esp32:esp32s2', compiler, sdk: pack({ size: 300, chunks: [{ size: 300, compressedSize: 90 }] }), boardPack },
    ])).toEqual({
      compiler: { rawBytes: 100, downloadBytes: 35 },
      targets: {
        'esp32:esp32:esp32': { rawBytes: 330, downloadBytes: 140 },
        'esp32:esp32:esp32s2': { rawBytes: 430, downloadBytes: 150 },
      },
    });
  });

  it('moves an existing publication to content addresses and remains idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-xtensa-migrate-'));
    try {
      const compiler = dataPack('xtensa-esp-elf-wasm', Uint8Array.of(1, 2, 3));
      writePack(join(root, 'packs', 'compiler'), compiler);
      const targets = [
        { key: 'esp32', board: 'esp32:esp32:esp32', runtimeId: 'esp32-arduino' },
        { key: 'esp32s2', board: 'esp32:esp32:esp32s2', runtimeId: 'esp32-s2-arduino' },
        { key: 'esp32s3', board: 'esp32:esp32:esp32s3', runtimeId: 'esp32-s3-arduino' },
      ];
      for (const [index, target] of targets.entries()) {
        const sdk = dataPack(`arduino-${target.key}-sdk`, Uint8Array.of(10 + index));
        const board = dataPack(`arduino-${target.key}-board`, Uint8Array.of(20 + index));
        writePack(join(root, 'packs', `${target.key}-sdk`), sdk);
        writePack(join(root, 'packs', `${target.key}-board`), board);
        writeJson(join(root, `${target.key}.json`), {
          schema: 2,
          id: target.runtimeId,
          abi: 1,
          board: target.board,
          packs: [
            { role: 'compiler', id: compiler.id, revision: compiler.revision, manifest: 'packs/compiler/toolchain.json' },
            { role: 'sdk', id: sdk.id, revision: sdk.revision, manifest: `packs/${target.key}-sdk/toolchain.json` },
            { role: 'board', id: board.id, revision: board.revision, manifest: `packs/${target.key}-board/toolchain.json` },
          ],
        });
      }

      const result = migrateEsp32XtensaPublication({ output: root, targets, updateReleasePins: false });
      expect(result.report.descriptors).toHaveProperty('esp32:esp32:esp32s3');
      expect(existsSync(join(root, 'packs', 'compiler'))).toBe(false);
      expect(existsSync(join(root, 'packs', compiler.id, compiler.revision, 'toolchain.json'))).toBe(true);
      const descriptor = JSON.parse(readFileSync(join(root, 'esp32s3.json'), 'utf8'));
      expect(descriptor.packs.map((entry: any) => entry.manifest)).toEqual(
        descriptor.packs.map((entry: any) => contentAddressedPackManifestPath(entry.id, entry.revision)),
      );
      expect(() => migrateEsp32XtensaPublication({ output: root, targets, updateReleasePins: false })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('updates the capabilities and same-origin release pins atomically from a publication report', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ck-xtensa-release-'));
    try {
      const capabilities = join(directory, 'capabilities.json');
      const release = join(directory, 'release.js');
      writeFileSync(capabilities, `${JSON.stringify({
        schema: 1,
        runtimes: [{ id: 'esp32-xtensa', toolchain: { id: 'xtensa-esp-elf-wasm', revision: 'a'.repeat(64) } }],
      }, null, 2)}\n`);
      writeFileSync(release, `export const ESP32_BROWSER_RELEASE = Object.freeze({
  capabilities: Object.freeze({ sha256: '${'b'.repeat(64)}' }),
  runtimes: Object.freeze({
    'esp32-xtensa': Object.freeze({ revision: '${'c'.repeat(64)}', descriptors: Object.freeze({
      'esp32:esp32:esp32': Object.freeze({ sha256: '${'d'.repeat(64)}' }),
      'esp32:esp32:esp32s2': Object.freeze({ sha256: '${'e'.repeat(64)}' }),
      'esp32:esp32:esp32s3': Object.freeze({ sha256: '${'f'.repeat(64)}' }),
    }) }),
  }),
});\n`);
      const revision = '1'.repeat(64);
      const descriptors = {
        'esp32:esp32:esp32': { sha256: '2'.repeat(64) },
        'esp32:esp32:esp32s2': { sha256: '3'.repeat(64) },
        'esp32:esp32:esp32s3': { sha256: '4'.repeat(64) },
      };

      updateXtensaReleasePins({
        report: { compiler: { id: 'xtensa-esp-elf-wasm', revision }, descriptors },
        capabilities,
        release,
      });

      const capabilitiesBytes = readFileSync(capabilities);
      expect(JSON.parse(capabilitiesBytes.toString()).runtimes[0].toolchain.revision).toBe(revision);
      const source = readFileSync(release, 'utf8');
      expect(source).toContain(createHash('sha256').update(capabilitiesBytes).digest('hex'));
      expect(source).toContain(revision);
      for (const descriptor of Object.values(descriptors)) expect(source).toContain(descriptor.sha256);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function dataPack(id: string, bytes: Uint8Array) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const artifacts = [{
    id: `${id}.data`, kind: 'tar', size: bytes.byteLength, sha256: digest,
    chunks: [{ path: `chunks/${digest.slice(0, 16)}.bin`, size: bytes.byteLength, sha256: digest }],
  }];
  const base = { schema: 1, id, version: 'test', artifacts };
  return { ...base, revision: createHash('sha256').update(JSON.stringify(base)).digest('hex'), bytes };
}

function writePack(root: string, pack: ReturnType<typeof dataPack>) {
  const chunk = pack.artifacts[0].chunks[0];
  mkdirSync(join(root, 'chunks'), { recursive: true });
  writeFileSync(join(root, ...chunk.path.split('/')), pack.bytes);
  const { bytes: _bytes, ...manifest } = pack;
  writeJson(join(root, 'toolchain.json'), manifest);
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
