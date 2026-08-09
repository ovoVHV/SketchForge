import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync as fsRenameSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  contentAddressedRuntimePackManifestPath,
  publishEsp32RiscvFromStaging,
  publishEsp32RiscvSharedToolchain,
  updateRiscvReleasePins,
} from '../../../scripts/publish-browser-esp32-riscv-toolchain.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ESP32 RISC-V shared compiler publisher', () => {
  it('derives immutable runtime Pack paths from validated identities', () => {
    const revision = 'a'.repeat(64);
    expect(contentAddressedRuntimePackManifestPath('arduino-esp32c3-sdk', revision))
      .toBe(`../packs/arduino-esp32c3-sdk/${revision}/toolchain.json`);
    expect(() => contentAddressedRuntimePackManifestPath('../sdk', revision)).toThrow(/content address/);
    expect(() => contentAddressedRuntimePackManifestPath('sdk', 'latest')).toThrow(/content address/);
  });

  it('moves identical C3/C6 bytes to one content address and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-riscv-publish-'));
    roots.push(root);
    const pack = compilerPack(Uint8Array.of(1, 2, 3, 4));
    writeRuntime(root, 'runtime', 'esp32-c3-arduino', 'esp32:esp32:esp32c3', pack);
    writeRuntime(root, 'runtime-c6', 'esp32-c6-arduino', 'esp32:esp32:esp32c6', pack);

    const result = publishEsp32RiscvSharedToolchain({
      publicationRoot: root,
      targets: targets(root),
    });
    const expectedManifest = `toolchains/riscv32-esp-elf-wasm/${pack.revision}/toolchain.json`;
    expect(result).toMatchObject({
      manifest: expectedManifest,
      beforeBytes: result.afterBytes * 2,
      savedBytes: result.afterBytes,
      compiler: { id: 'riscv32-esp-elf-wasm', revision: pack.revision },
    });
    expect(existsSync(join(root, ...expectedManifest.split('/')))).toBe(true);
    expect(existsSync(join(root, 'runtime', 'packs', 'compiler'))).toBe(false);
    expect(existsSync(join(root, 'runtime-c6', 'packs', 'compiler'))).toBe(false);
    expect(existsSync(join(root, 'runtime', 'packs', 'sdk'))).toBe(false);
    expect(existsSync(join(root, 'runtime', 'packs', 'board'))).toBe(false);

    const c3 = readJson(join(root, 'runtime', 'runtime.json'));
    const c6 = readJson(join(root, 'runtime-c6', 'runtime.json'));
    const sharedPath = `../toolchains/riscv32-esp-elf-wasm/${pack.revision}/toolchain.json`;
    expect(c3.packs[0].manifest).toBe(sharedPath);
    expect(c6.packs[0].manifest).toBe(sharedPath);
    expect(c3.packs[1].manifest).toBe(
      `../packs/sdk-runtime/${c3.packs[1].revision}/toolchain.json`,
    );
    expect(c3.packs[2].manifest).toBe(
      `../packs/board-runtime/${c3.packs[2].revision}/toolchain.json`,
    );
    expect(c3).toMatchObject({ schema: 2, packs: [{ role: 'compiler' }, { role: 'sdk' }, { role: 'board' }] });
    expect(c6).toMatchObject({ schema: 2, packs: [{ role: 'compiler' }, { role: 'sdk' }, { role: 'board' }] });
    expect(new URL(c3.packs[0].manifest, 'https://cdn.test/esp32/v2/runtime/runtime.json').href)
      .toBe(new URL(c6.packs[0].manifest, 'https://cdn.test/esp32/v2/runtime-c6/runtime.json').href);

    expect(publishEsp32RiscvSharedToolchain({
      publicationRoot: root,
      targets: targets(root),
    })).toMatchObject({ manifest: expectedManifest, savedBytes: result.savedBytes });
  });

  it('refuses to merge compiler Packs with different content identities', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-riscv-publish-mismatch-'));
    roots.push(root);
    writeRuntime(
      root,
      'runtime',
      'esp32-c3-arduino',
      'esp32:esp32:esp32c3',
      compilerPack(Uint8Array.of(1)),
    );
    writeRuntime(
      root,
      'runtime-c6',
      'esp32-c6-arduino',
      'esp32:esp32:esp32c6',
      compilerPack(Uint8Array.of(2)),
    );

    expect(() => publishEsp32RiscvSharedToolchain({
      publicationRoot: root,
      targets: targets(root),
    })).toThrow(/differs/);
  });

  it('refuses different bytes at an existing SDK content address before moving inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-riscv-publish-collision-'));
    roots.push(root);
    const pack = compilerPack(Uint8Array.of(1, 2, 3, 4));
    writeRuntime(root, 'runtime', 'esp32-c3-arduino', 'esp32:esp32:esp32c3', pack);
    writeRuntime(root, 'runtime-c6', 'esp32-c6-arduino', 'esp32:esp32:esp32c6', pack);
    const sdk = readJson(join(root, 'runtime', 'packs', 'sdk', 'toolchain.json'));
    const collision = join(root, 'packs', sdk.id, sdk.revision);
    mkdirSync(collision, { recursive: true });
    writeFileSync(join(collision, 'different.bin'), Uint8Array.of(9));

    expect(() => publishEsp32RiscvSharedToolchain({
      publicationRoot: root,
      targets: targets(root),
    })).toThrow(/immutable .* Pack address contains different bytes/);
    expect(existsSync(join(root, 'runtime', 'packs', 'compiler'))).toBe(true);
  });

  it('rejects schema-v1 descriptors and mixed schema-v2 role sets', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-riscv-publish-v1-'));
    roots.push(root);
    const pack = compilerPack(Uint8Array.of(1, 2, 3, 4));
    writeRuntime(root, 'runtime', 'esp32-c3-arduino', 'esp32:esp32:esp32c3', pack, 1);
    writeRuntime(root, 'runtime-c6', 'esp32-c6-arduino', 'esp32:esp32:esp32c6', pack, 1);

    expect(() => publishEsp32RiscvSharedToolchain({
      publicationRoot: root,
      targets: targets(root),
      removeDuplicates: false,
    })).toThrow(/unexpected firmware/);

    const mixedRoot = mkdtempSync(join(tmpdir(), 'ck-riscv-publish-mixed-'));
    roots.push(mixedRoot);
    writeRuntime(mixedRoot, 'runtime', 'esp32-c3-arduino', 'esp32:esp32:esp32c3', pack);
    writeRuntime(mixedRoot, 'runtime-c6', 'esp32-c6-arduino', 'esp32:esp32:esp32c6', pack);
    const c6 = readJson(join(mixedRoot, 'runtime-c6', 'runtime.json'));
    c6.packs[2].role = 'flash';
    writeJson(join(mixedRoot, 'runtime-c6', 'runtime.json'), c6);

    expect(() => publishEsp32RiscvSharedToolchain({
      publicationRoot: mixedRoot,
      targets: targets(mixedRoot),
    })).toThrow(/does not match schema 2 Pack roles/);
  });

  it('promotes schema-v2 staging runtimes into the final C3/C6 paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-riscv-publish-final-'));
    const staging = mkdtempSync(join(tmpdir(), 'ck-riscv-staging-'));
    roots.push(root, staging);
    const pack = compilerPack(Uint8Array.of(9, 8, 7));
    writeRuntime(staging, 'runtime-v2-c3-staging', 'esp32-c3-arduino', 'esp32:esp32:esp32c3', pack);
    writeRuntime(staging, 'runtime-v2-c6-staging', 'esp32-c6-arduino', 'esp32:esp32:esp32c6', pack);

    const result = publishEsp32RiscvFromStaging({ stagingRoot: staging, publicationRoot: root });

    expect(result.descriptorPins['esp32:esp32:esp32c3']).toMatchObject({ path: 'runtime/runtime.json' });
    expect(result.descriptorPins['esp32:esp32:esp32c6']).toMatchObject({ path: 'runtime-c6/runtime.json' });
    expect(existsSync(join(root, 'runtime', 'runtime.json'))).toBe(true);
    expect(existsSync(join(root, 'runtime-c6', 'runtime.json'))).toBe(true);
    expect(existsSync(join(root, 'runtime', 'packs', 'compiler'))).toBe(false);
    expect(readdirSync(root).some((name) => name.startsWith('.riscv-promotion-'))).toBe(false);
  });

  it('rotates the compiler revision, capabilities hash, and descriptor pins together', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-riscv-release-'));
    roots.push(root);
    const fixture = writeRiscvReleaseFixture(root);
    const revision = '1'.repeat(64);
    updateRiscvReleasePins({
      report: {
        compiler: { id: 'riscv32-esp-elf-wasm', revision },
        descriptors: {
          'esp32:esp32:esp32c3': { sha256: '1'.repeat(64) },
          'esp32:esp32:esp32c6': { sha256: '2'.repeat(64) },
        },
      },
      capabilities: fixture.capabilities,
      release: fixture.release,
    });

    const capabilitiesBytes = readFileSync(fixture.capabilities);
    expect(JSON.parse(capabilitiesBytes.toString()).runtimes[0].toolchain.revision).toBe(revision);
    const source = readFileSync(fixture.release, 'utf8');
    expect(source).toContain(`sha256: '${sha256(capabilitiesBytes)}'`);
    expect(source).toContain(`revision: '${revision}'`);
    expect(source.match(new RegExp('1'.repeat(64), 'g'))).toHaveLength(2);
    expect(source).toContain('2'.repeat(64));
  });

  it.each([
    {
      name: 'capabilities hash',
      options: { releaseCapabilitiesSha256: '8'.repeat(64) },
      error: /capabilities hash drift/,
    },
    {
      name: 'runtime revision',
      options: { releaseRevision: '9'.repeat(64) },
      error: /runtime revision drift/,
    },
  ])('rejects $name drift without changing either pin file', ({ options, error }) => {
    const root = mkdtempSync(join(tmpdir(), 'ck-riscv-release-drift-'));
    roots.push(root);
    const fixture = writeRiscvReleaseFixture(root, options);
    const beforeCapabilities = readFileSync(fixture.capabilities);
    const beforeRelease = readFileSync(fixture.release);

    expect(() => updateRiscvReleasePins({
      compiler: { id: 'riscv32-esp-elf-wasm', revision: '1'.repeat(64) },
      capabilities: fixture.capabilities,
      release: fixture.release,
      descriptorPins: {
        'esp32:esp32:esp32c3': { sha256: '2'.repeat(64) },
        'esp32:esp32:esp32c6': { sha256: '3'.repeat(64) },
      },
    })).toThrow(error);
    expect(readFileSync(fixture.capabilities)).toEqual(beforeCapabilities);
    expect(readFileSync(fixture.release)).toEqual(beforeRelease);
  });

  it('rolls capabilities back when installing the release metadata fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-riscv-release-rollback-'));
    roots.push(root);
    const fixture = writeRiscvReleaseFixture(root);
    const beforeCapabilities = readFileSync(fixture.capabilities);
    const beforeRelease = readFileSync(fixture.release);
    let renames = 0;

    expect(() => updateRiscvReleasePins({
      compiler: { id: 'riscv32-esp-elf-wasm', revision: '1'.repeat(64) },
      capabilities: fixture.capabilities,
      release: fixture.release,
      descriptorPins: {
        'esp32:esp32:esp32c3': { sha256: '2'.repeat(64) },
        'esp32:esp32:esp32c6': { sha256: '3'.repeat(64) },
      },
      fileOperations: {
        renameSync(source: string, destination: string) {
          renames += 1;
          if (renames === 4) throw new Error('injected release install failure');
          fsRenameSync(source, destination);
        },
      },
    })).toThrow(/injected release install failure/);
    expect(readFileSync(fixture.capabilities)).toEqual(beforeCapabilities);
    expect(readFileSync(fixture.release)).toEqual(beforeRelease);
    expect(readdirSync(root).some((name) => name.startsWith('.riscv-release-pins-'))).toBe(false);
  });
});

function writeRiscvReleaseFixture(
  root: string,
  {
    capabilityRevision = 'a'.repeat(64),
    releaseRevision = capabilityRevision,
    releaseCapabilitiesSha256,
  }: {
    capabilityRevision?: string;
    releaseRevision?: string;
    releaseCapabilitiesSha256?: string;
  } = {},
) {
  const capabilities = join(root, 'capabilities.json');
  const release = join(root, 'release.js');
  const capabilitiesBytes = Buffer.from(`${JSON.stringify({
    schema: 1,
    runtimes: [{
      id: 'esp32-riscv',
      toolchain: { id: 'riscv32-esp-elf-wasm', revision: capabilityRevision },
    }],
  }, null, 2)}\n`, 'utf8');
  writeFileSync(capabilities, capabilitiesBytes);
  writeFileSync(release, `export const ESP32_BROWSER_RELEASE = Object.freeze({
  capabilities: Object.freeze({ sha256: '${releaseCapabilitiesSha256 ?? sha256(capabilitiesBytes)}' }),
  runtimes: Object.freeze({
    'esp32-riscv': Object.freeze({
      toolchainId: 'riscv32-esp-elf-wasm',
      revision: '${releaseRevision}',
      descriptors: Object.freeze({
        'esp32:esp32:esp32c3': Object.freeze({ sha256: '${'b'.repeat(64)}' }),
        'esp32:esp32:esp32c6': Object.freeze({ sha256: '${'c'.repeat(64)}' }),
      }),
    }),
  }),
});\n`);
  return { capabilities, release };
}

function compilerPack(bytes: Uint8Array) {
  const digest = sha256(bytes);
  const artifacts = [{
    id: 'llvm.core.wasm',
    kind: 'wasm',
    size: bytes.byteLength,
    sha256: digest,
    chunks: [{ path: `chunks/llvm.core.wasm-${digest.slice(0, 16)}.bin`, size: bytes.byteLength, sha256: digest }],
  }];
  const base = { schema: 1, id: 'riscv32-esp-elf-wasm', version: 'test', artifacts };
  return { ...base, revision: sha256(Buffer.from(JSON.stringify(base))), bytes };
}

function writeRuntime(
  root: string,
  directory: string,
  runtimeId: string,
  board: string,
  pack: ReturnType<typeof compilerPack>,
  schema: 1 | 2 = 2,
) {
  const runtime = join(root, directory);
  writePack(join(runtime, 'packs', 'compiler'), pack);
  const sdk = dataPack(`sdk-${directory}`, Uint8Array.of(5, directory.length));
  const boardRole = schema === 2 ? 'board' : 'flash';
  const boardPack = dataPack(`${boardRole}-${directory}`, Uint8Array.of(6, directory.length));
  writePack(join(runtime, 'packs', 'sdk'), sdk);
  writePack(join(runtime, 'packs', boardRole), boardPack);
  writeJson(join(runtime, 'runtime.json'), {
    schema,
    id: runtimeId,
    abi: 1,
    board,
    packs: [
      { role: 'compiler', id: pack.id, revision: pack.revision, manifest: 'packs/compiler/toolchain.json' },
      { role: 'sdk', id: sdk.id, revision: sdk.revision, manifest: 'packs/sdk/toolchain.json' },
      {
        role: boardRole,
        id: boardPack.id,
        revision: boardPack.revision,
        manifest: `packs/${boardRole}/toolchain.json`,
      },
    ],
  });
  writeJson(join(runtime, 'release-report.json'), {
    schema: 1,
    descriptorSha256: '0'.repeat(64),
    packs: { compiler: { revision: pack.revision, bytes: pack.bytes.byteLength } },
  });
}

function dataPack(id: string, bytes: Uint8Array) {
  const digest = sha256(bytes);
  const artifacts = [{
    id: `${id}.data`,
    kind: 'tar',
    size: bytes.byteLength,
    sha256: digest,
    chunks: [{ path: `chunks/${id}-${digest.slice(0, 16)}.bin`, size: bytes.byteLength, sha256: digest }],
  }];
  const base = { schema: 1, id, version: 'test', artifacts };
  return { ...base, revision: sha256(Buffer.from(JSON.stringify(base))), bytes };
}

function writePack(root: string, pack: ReturnType<typeof compilerPack> | ReturnType<typeof dataPack>) {
  const chunk = pack.artifacts[0].chunks[0];
  mkdirSync(join(root, 'chunks'), { recursive: true });
  writeFileSync(join(root, ...chunk.path.split('/')), pack.bytes);
  const { bytes: _bytes, ...manifest } = pack;
  writeJson(join(root, 'toolchain.json'), manifest);
}

function targets(root: string) {
  return [
    {
      key: 'esp32c3', board: 'esp32:esp32:esp32c3', runtimeId: 'esp32-c3-arduino',
      source: join(root, 'runtime'),
    },
    {
      key: 'esp32c6', board: 'esp32:esp32:esp32c6', runtimeId: 'esp32-c6-arduino',
      source: join(root, 'runtime-c6'),
    },
  ];
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}
