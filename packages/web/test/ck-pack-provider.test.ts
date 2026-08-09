import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { createEsp32BrowserPackProvider } from '../public/esp32/v2/ck-pack-provider.js';

const SHA256 = /^[a-f0-9]{64}$/;
const PLATFORM_REVISION = '4'.repeat(64);
const BOARD_REVISION = '3'.repeat(64);
const ESP_SR_MODEL_SIZE = 2468362;
const ESP_SR_MODEL_SHA256 = '0312f2dde9581cd604e752fbfa287d687a2acc0631e593a35a24c4a518d75879';
const BOARD_INPUTS = {
  bootloader: { path: 'packs/board/bootloader.bin', role: 'bootloader-source' },
  partitions: { path: 'packs/board/partitions.bin', role: 'partitions-source' },
  bootApp0: { path: 'packs/board/boot_app0.bin', role: 'boot-app0-source' },
  model: { path: 'packs/board/srmodels.bin', role: 'model-source' },
} as const;

type BoardArtifactIds = {
  bootloader: string;
  partitions: string;
  bootApp0: string;
  model?: string;
};

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function descriptor() {
  return {
    schema: 2,
    board: 'esp32:esp32:esp32c3',
    packs: [
      { role: 'compiler', id: 'compiler', revision: '1'.repeat(64), manifest: 'compiler.json' },
      { role: 'sdk', id: 'sdk', revision: '2'.repeat(64), manifest: 'sdk.json' },
      { role: 'board', id: 'board', revision: BOARD_REVISION, manifest: 'board.json' },
    ],
  };
}

function buildPacks(runtime: any, libraries: any[] = []) {
  const compiler = runtime.packs.find((pack: any) => pack.role === 'compiler');
  const boardPack = runtime.packs.find((pack: any) => pack.role === 'board');
  return {
    toolchain: {
      kind: 'toolchain', id: compiler.id, version: '1.0.0', sha256: compiler.revision,
      abi: 'riscv32-esp-elf-wasm', instructionSet: 'rv32imc',
    },
    platform: {
      kind: 'platform', id: 'espressif-arduino', version: '3.3.7', sha256: PLATFORM_REVISION,
      platform: 'espressif-arduino',
    },
    board: {
      kind: 'board', id: boardPack?.id ?? `board:${runtime.board}`, version: '3.3.7',
      sha256: boardPack?.revision ?? '4'.repeat(64), fqbn: runtime.board, variant: 'esp32c3',
    },
    libraries: {
      roots: libraries.map((pack) => pack.id),
      packs: libraries,
    },
  };
}

function planning(espSr16 = false) {
  return {
    platformManifest: {
      platformManifest: {
        id: 'espressif-arduino', version: '3.3.7', sha256: PLATFORM_REVISION,
      },
      compile: { artifactIds: ['compile'] },
      link: { artifactIds: ['link'] },
      boardPack: { artifactIds: ['variant'] },
      options: espSr16 ? { partition_scheme: 'esp_sr_16' } : undefined,
      flash: {
        bootloader: 'bootloader', partitions: 'partitions', bootApp0: 'boot-app0',
        ...(espSr16 ? {
          partitionScheme: 'esp_sr_16',
          model: {
            artifactId: 'srmodels', offset: '0xd10000',
            size: ESP_SR_MODEL_SIZE, capacity: 0x2f0000,
          },
        } : {}),
      },
    },
    sdkManifest: { id: 'sdk', version: '3.3.7', revision: '2'.repeat(64) },
    librarySources: [],
  };
}

function makeProvider(
  ir: unknown,
  calls: string[],
  boardIds: BoardArtifactIds = {
    bootloader: 'bootloader', partitions: 'partitions', bootApp0: 'boot-app0',
  },
) {
  const runtime = descriptor();
  const packs = buildPacks(runtime);
  const espSr16 = boardIds.model !== undefined;
  const boundIr = {
    ...(ir as object),
    ...(espSr16 ? {
      target: {
        ...((ir as { target?: object }).target ?? {}),
        options: { partition_scheme: 'esp_sr_16', flash_size: '16MB' },
      },
    } : {}),
    packs,
  };
  const sdkCompile = new TextEncoder().encode('cc');
  const sdkLink = new TextEncoder().encode('lib');
  const boardArtifacts = new Map([
    ['variant', new TextEncoder().encode('pins')],
    [boardIds.bootloader, new TextEncoder().encode('boot')],
    [boardIds.partitions, new TextEncoder().encode('part')],
    [boardIds.bootApp0, new TextEncoder().encode('app0')],
    ...(boardIds.model ? [[boardIds.model, new Uint8Array(ESP_SR_MODEL_SIZE).fill(0x5a)] as const] : []),
  ]);
  const manifests = new Map([
    ['sdk', {
      schema: 2, id: 'sdk', version: '3.3.7', revision: '2'.repeat(64), artifacts: [
        {
          id: 'compile', kind: 'tree', size: sdkCompile.byteLength, sha256: hash(sdkCompile),
          files: [{
            path: 'sdk/flags/cpp_flags', offset: 0, length: sdkCompile.byteLength, sha256: hash(sdkCompile),
          }],
        },
        {
          id: 'link', kind: 'tree', size: sdkLink.byteLength, sha256: hash(sdkLink),
          files: [{ path: 'core.a', offset: 0, length: sdkLink.byteLength, sha256: hash(sdkLink) }],
        },
      ],
    }],
    ['board', {
      schema: 2, id: 'board', version: '3.3.7', revision: BOARD_REVISION, artifacts: [
        {
          id: 'variant', kind: 'tree', size: boardArtifacts.get('variant')!.byteLength,
          sha256: hash(boardArtifacts.get('variant')!),
          files: [{
            path: 'variant/pins.h', offset: 0, length: boardArtifacts.get('variant')!.byteLength,
            sha256: hash(boardArtifacts.get('variant')!),
          }],
        },
        ...[
          boardIds.bootloader, boardIds.partitions, boardIds.bootApp0,
          ...(boardIds.model ? [boardIds.model] : []),
        ].map((id) => ({
          id,
          kind: 'bin',
          size: boardArtifacts.get(id)!.byteLength,
          sha256: id === boardIds.model ? ESP_SR_MODEL_SHA256 : hash(boardArtifacts.get(id)!),
        })),
      ],
    }],
  ]);
  const createPackLoader = ({ expectedId }: { expectedId: string }) => ({
    async loadManifest() {
      const manifest = manifests.get(expectedId);
      if (!manifest) throw new Error(`unexpected manifest: ${expectedId}`);
      return manifest;
    },
    async loadArtifact(id: string) {
      calls.push(`${expectedId}:${id}`);
      const bytes = expectedId === 'sdk'
        ? (id === 'compile' ? sdkCompile : sdkLink)
        : boardArtifacts.get(id);
      if (!bytes) throw new Error(`unexpected artifact: ${expectedId}/${id}`);
      const manifest = manifests.get(expectedId)!;
      const artifact = manifest.artifacts.find((candidate) => candidate.id === id);
      if (!artifact) throw new Error(`unexpected artifact metadata: ${expectedId}/${id}`);
      return { artifact, bytes };
    },
    reset() {},
  });
  return {
    provider: createEsp32BrowserPackProvider({
      capability: {
        pinnedRuntime: {
          descriptor: runtime,
          descriptorUrl: new URL('https://example.test/runtime.json'),
        },
      },
      planning: planning(espSr16),
      ir: boundIr,
      dependencies: { createPackLoader },
    }),
    packs,
    sdkCompile,
    sdkLink,
    boardArtifacts,
  };
}

function input(path: string, bytes: Uint8Array, role = 'pack') {
  return { path, sha256: hash(bytes), role };
}

function boardRequest(
  key: keyof typeof BOARD_INPUTS,
  bytes: Uint8Array,
  artifactId: string,
  overrides: Record<string, unknown> = {},
) {
  const definition = BOARD_INPUTS[key];
  const sha256 = key === 'model' ? ESP_SR_MODEL_SHA256 : hash(bytes);
  return {
    input: { path: definition.path, sha256, role: definition.role },
    packInput: {
      kind: 'pack-artifact',
      packId: 'board',
      packRevision: BOARD_REVISION,
      packSchema: 2,
      artifactId,
      sha256,
      role: definition.role,
      ...overrides,
    },
  };
}

function mockEspSrModelDigest(expectedBytes: Uint8Array) {
  const original = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  const expectedDigest = Uint8Array.from(
    ESP_SR_MODEL_SHA256.match(/../g)!.map((byte) => Number.parseInt(byte, 16)),
  );
  return vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    if (bytes.byteLength === expectedBytes.byteLength
      && bytes[0] === expectedBytes[0]
      && bytes[bytes.byteLength - 1] === expectedBytes[expectedBytes.byteLength - 1]) {
      return expectedDigest.buffer.slice(0);
    }
    return original(algorithm, data);
  });
}

async function materialize(
  provider: { materialize: (packs: unknown, context: unknown) => Promise<void> },
  packs: unknown,
) {
  const files = new Map<string, Uint8Array>();
  await provider.materialize(packs, {
    hasFile: (path: string) => files.has(path),
    writeFile: async (path: string, bytes: Uint8Array, expectedSha256?: string) => {
      if (expectedSha256 !== undefined) {
        expect(expectedSha256).toMatch(SHA256);
        expect(hash(bytes)).toBe(expectedSha256);
      }
      files.set(path, bytes);
    },
  });
  return files;
}

describe('ESP32 CK Pack provider', () => {
  it('pins the AVR v3 toolchain Pack loader import to the recovery revision', async () => {
    const source = await readFile(
      new URL('../public/esp32/v2/ck-pack-provider.js', import.meta.url),
      'utf8',
    );

    expect(source).toContain(
      "from '../../avr/v3/toolchain-pack.js?recovery=20260809';",
    );
    expect(source).not.toContain(
      "from '../../avr/v3/toolchain-pack.js';",
    );
  });

  it('maps SDK trees, Board Variant, core archive, and board artifacts with verified bytes', async () => {
    const sdkCompile = new TextEncoder().encode('cc');
    const sdkLink = new TextEncoder().encode('lib');
    const boardArtifacts = new Map([
      ['variant', new TextEncoder().encode('pins')],
      ['bootloader', new TextEncoder().encode('boot')],
      ['partitions', new TextEncoder().encode('part')],
      ['boot-app0', new TextEncoder().encode('app0')],
    ]);
    const calls: string[] = [];
    const postLink = [
      boardRequest('bootloader', boardArtifacts.get('bootloader')!, 'bootloader'),
      boardRequest('partitions', boardArtifacts.get('partitions')!, 'partitions'),
      boardRequest('bootApp0', boardArtifacts.get('boot-app0')!, 'boot-app0'),
    ];
    const ir = {
      graph: {
        actions: [{
          inputs: [
            input('packs/platform/sdk/flags/cpp_flags', sdkCompile),
            input('packs/board/variant/pins.h', boardArtifacts.get('variant')!),
            input('packs/platform/core.a', sdkLink),
            ...postLink.map((request) => request.input),
          ],
          packInputs: postLink.map((request) => request.packInput),
        }],
      },
    };
    const { provider, packs } = makeProvider(ir, calls);
    const files = await materialize(provider, packs);
    expect([...files.keys()].sort()).toEqual([
      'packs/board/boot_app0.bin',
      'packs/board/bootloader.bin',
      'packs/board/partitions.bin',
      'packs/board/variant/pins.h',
      'packs/platform/core.a',
      'packs/platform/sdk/flags/cpp_flags',
    ]);
    expect(files.get('packs/platform/sdk/flags/cpp_flags')).toEqual(sdkCompile);
    expect(files.get('packs/board/variant/pins.h')).toEqual(boardArtifacts.get('variant'));
    expect(calls).toEqual([
      'sdk:compile', 'sdk:link',
      'board:variant', 'board:bootloader', 'board:partitions', 'board:boot-app0',
    ]);
  });

  it('leaves a root project partitions.csv to the executor while loading requested Board Pack files', async () => {
    const projectPartitions = new TextEncoder().encode(
      'nvs,data,nvs,0x9000,0x5000,\napp,app,ota_0,0x10000,0x100000,\n',
    );
    const boardVariant = new TextEncoder().encode('pins');
    const bootloader = new TextEncoder().encode('boot');
    const bootApp0 = new TextEncoder().encode('app0');
    const bootloaderRequest = boardRequest('bootloader', bootloader, 'bootloader');
    const bootApp0Request = boardRequest('bootApp0', bootApp0, 'boot-app0');
    const ir = {
      graph: { actions: [
        {
          id: 'transform-partitions',
          kind: 'transform',
          tool: 'platform:gen-esp32part',
          inputs: [input('partitions.csv', projectPartitions, 'partitions-source')],
          outputs: [{ path: 'build/partitions.bin', kind: 'partitions' }],
          arguments: ['-q', 'partitions.csv', 'build/partitions.bin'],
          transform: {
            input: 'partitions.csv', output: 'build/partitions.bin', format: 'partition', flags: ['--quiet=true'],
          },
        },
        { id: 'compile-main', inputs: [input('packs/board/variant/pins.h', boardVariant)] },
        {
          id: 'transform-bootloader',
          inputs: [bootloaderRequest.input],
          packInputs: [bootloaderRequest.packInput],
        },
        {
          id: 'transform-boot-app0',
          inputs: [bootApp0Request.input],
          packInputs: [bootApp0Request.packInput],
        },
      ] },
    };
    const calls: string[] = [];
    const { provider, packs } = makeProvider(ir, calls);

    const files = await materialize(provider, packs);

    expect([...files.keys()].sort()).toEqual([
      'packs/board/boot_app0.bin',
      'packs/board/bootloader.bin',
      'packs/board/variant/pins.h',
    ]);
    expect([...files.keys()].every((path) => path.startsWith('packs/'))).toBe(true);
    expect(files.has('partitions.csv')).toBe(false);
    expect(files.get(BOARD_INPUTS.bootloader.path)).toEqual(bootloader);
    expect(files.get(BOARD_INPUTS.bootApp0.path)).toEqual(bootApp0);
    expect(files.get('packs/board/variant/pins.h')).toEqual(boardVariant);
    expect(calls).toEqual(['board:variant', 'board:bootloader', 'board:boot-app0']);
    expect(calls).not.toContain('board:partitions');
  });

  it('loads Variant and static artifacts only from a schema-v2 Board Pack', async () => {
    const sdkCompile = new TextEncoder().encode('cc');
    const sdkLink = new TextEncoder().encode('lib');
    const boardVariant = new TextEncoder().encode('pins');
    const boardArtifacts = new Map([
      ['variant', boardVariant],
      ['bootloader', new TextEncoder().encode('boot')],
      ['partitions', new TextEncoder().encode('part')],
      ['boot-app0', new TextEncoder().encode('app0')],
    ]);
    const calls: string[] = [];
    const descriptorV2 = {
      schema: 2,
      board: 'esp32:esp32:esp32c3',
      packs: [
        { role: 'compiler', id: 'compiler', revision: '1'.repeat(64), manifest: 'compiler.json' },
        { role: 'sdk', id: 'sdk', revision: '2'.repeat(64), manifest: 'sdk.json' },
        { role: 'board', id: 'board', revision: BOARD_REVISION, manifest: 'board.json' },
      ],
    };
    const splitPlanning = planning() as any;
    const packs = buildPacks(descriptorV2);
    const postLink = [
      boardRequest('bootloader', boardArtifacts.get('bootloader')!, 'bootloader'),
      boardRequest('partitions', boardArtifacts.get('partitions')!, 'partitions'),
      boardRequest('bootApp0', boardArtifacts.get('boot-app0')!, 'boot-app0'),
    ];
    const ir = {
      packs,
      graph: { actions: [{ inputs: [
        input('packs/platform/sdk/flags/cpp_flags', sdkCompile),
        input('packs/board/variant/pins.h', boardVariant),
        input('packs/platform/core.a', sdkLink),
        ...postLink.map((request) => request.input),
      ], packInputs: postLink.map((request) => request.packInput) }] },
    };
    const createPackLoader = ({ expectedId }: { expectedId: string }) => ({
      async loadManifest() {
        if (expectedId === 'sdk') {
          return {
            schema: 2, id: 'sdk', version: '3.3.7', revision: '2'.repeat(64), artifacts: [
              {
                id: 'compile', kind: 'tree', size: sdkCompile.byteLength, sha256: hash(sdkCompile),
                files: [{
                  path: 'sdk/flags/cpp_flags', offset: 0, length: sdkCompile.byteLength, sha256: hash(sdkCompile),
                }],
              },
              {
                id: 'link', kind: 'tree', size: sdkLink.byteLength, sha256: hash(sdkLink),
                files: [{ path: 'core.a', offset: 0, length: sdkLink.byteLength, sha256: hash(sdkLink) }],
              },
            ],
          };
        }
        return {
          schema: 2, id: 'board', version: '3.3.7', revision: BOARD_REVISION, artifacts: [
            {
              id: 'variant', kind: 'tree', size: boardVariant.byteLength, sha256: hash(boardVariant),
              files: [{ path: 'variant/pins.h', offset: 0, length: boardVariant.byteLength, sha256: hash(boardVariant) }],
            },
            ...['bootloader', 'partitions', 'boot-app0'].map((id) => ({
              id,
              kind: 'bin',
              size: boardArtifacts.get(id)!.byteLength,
              sha256: hash(boardArtifacts.get(id)!),
            })),
          ],
        };
      },
      async loadArtifact(id: string) {
        calls.push(`${expectedId}:${id}`);
        const bytes = expectedId === 'sdk'
          ? (id === 'compile' ? sdkCompile : sdkLink)
          : boardArtifacts.get(id);
        if (!bytes) throw new Error(`unexpected artifact: ${expectedId}/${id}`);
        const kind = expectedId === 'board' && id !== 'variant' ? 'bin' : 'tree';
        return { artifact: { id, kind, size: bytes.byteLength, sha256: hash(bytes) }, bytes };
      },
      reset() {},
    });
    const provider = createEsp32BrowserPackProvider({
      capability: { pinnedRuntime: { descriptor: descriptorV2, descriptorUrl: new URL('https://example.test/runtime.json') } },
      planning: splitPlanning,
      ir,
      dependencies: { createPackLoader },
    });
    const files = await materialize(provider, packs);

    expect(files.get('packs/board/variant/pins.h')).toEqual(boardVariant);
    expect(calls).toEqual([
      'sdk:compile', 'sdk:link',
      'board:variant', 'board:bootloader', 'board:partitions', 'board:boot-app0',
    ]);
  });

  it('selects post-link Board artifacts from ActionPackInput provenance instead of legacy flash ids', async () => {
    const bytes = {
      bootloader: new TextEncoder().encode('boot'),
      partitions: new TextEncoder().encode('part'),
      bootApp0: new TextEncoder().encode('app0'),
    };
    const ids = {
      bootloader: 'bootloader-selected',
      partitions: 'partitions-selected',
      bootApp0: 'boot-app0-selected',
    };
    const requests = [
      boardRequest('bootloader', bytes.bootloader, ids.bootloader),
      boardRequest('partitions', bytes.partitions, ids.partitions),
      boardRequest('bootApp0', bytes.bootApp0, ids.bootApp0),
    ];
    const calls: string[] = [];
    const { provider, packs } = makeProvider({
      graph: { actions: requests.map((request) => ({
        inputs: [request.input],
        packInputs: [request.packInput],
      })) },
    }, calls, ids);

    const files = await materialize(provider, packs);

    expect(files.get(BOARD_INPUTS.bootloader.path)).toEqual(bytes.bootloader);
    expect(files.get(BOARD_INPUTS.partitions.path)).toEqual(bytes.partitions);
    expect(files.get(BOARD_INPUTS.bootApp0.path)).toEqual(bytes.bootApp0);
    expect(calls).toEqual([
      'board:bootloader-selected',
      'board:partitions-selected',
      'board:boot-app0-selected',
    ]);
  });

  it('materializes the esp_sr_16 srmodels artifact from exact model-source provenance', async () => {
    const modelBytes = new Uint8Array(ESP_SR_MODEL_SIZE).fill(0x5a);
    const request = boardRequest('model', modelBytes, 'srmodels');
    const calls: string[] = [];
    const setup = makeProvider({
      graph: { actions: [{ inputs: [request.input], packInputs: [request.packInput] }] },
    }, calls, {
      bootloader: 'bootloader', partitions: 'partitions', bootApp0: 'boot-app0', model: 'srmodels',
    });
    const digest = mockEspSrModelDigest(modelBytes);
    const files = new Map<string, Uint8Array>();
    try {
      await setup.provider.materialize(setup.packs, {
        hasFile: (path: string) => files.has(path),
        writeFile: async (path: string, bytes: Uint8Array, expectedSha256?: string) => {
          expect(expectedSha256).toBe(ESP_SR_MODEL_SHA256);
          files.set(path, bytes);
        },
      });
    } finally {
      digest.mockRestore();
    }

    expect(files.get(BOARD_INPUTS.model.path)).toEqual(modelBytes);
    expect(request).toMatchObject({
      input: { path: BOARD_INPUTS.model.path, role: 'model-source', sha256: ESP_SR_MODEL_SHA256 },
      packInput: { artifactId: 'srmodels', role: 'model-source', sha256: ESP_SR_MODEL_SHA256 },
    });
    expect(calls).toEqual(['board:srmodels']);
  });

  it('rejects invalid esp_sr_16 model roles, provenance, and bytes', async () => {
    const modelBytes = new Uint8Array(ESP_SR_MODEL_SIZE).fill(0x5a);
    const valid = boardRequest('model', modelBytes, 'srmodels');
    const ids = {
      bootloader: 'bootloader', partitions: 'partitions', bootApp0: 'boot-app0', model: 'srmodels',
    };

    expect(() => makeProvider({
      graph: { actions: [{
        inputs: [{ ...valid.input, role: 'pack' }], packInputs: [valid.packInput],
      }] },
    }, [], ids)).toThrow(/model Pack request|Board Pack request is invalid/);
    expect(() => makeProvider({
      graph: { actions: [{ inputs: [valid.input], packInputs: [] }] },
    }, [], ids)).toThrow(/provenance is missing or ambiguous/);
    const wrongArtifact = boardRequest('model', modelBytes, 'not-srmodels');
    expect(() => makeProvider({
      graph: { actions: [{ inputs: [wrongArtifact.input], packInputs: [wrongArtifact.packInput] }] },
    }, [], ids)).toThrow(/model Pack binding is invalid/);

    const tampered = makeProvider({
      graph: { actions: [{ inputs: [valid.input], packInputs: [valid.packInput] }] },
    }, [], ids);
    tampered.boardArtifacts.get('srmodels')![0] = 0x59;
    const digest = mockEspSrModelDigest(modelBytes);
    try {
      await expect(materialize(tampered.provider, tampered.packs))
        .rejects.toThrow(/artifact bytes are invalid/);
    } finally {
      digest.mockRestore();
    }
  });

  it('requires exact post-link file requests and Board Pack provenance', () => {
    const bytes = new TextEncoder().encode('boot');
    const valid = boardRequest('bootloader', bytes, 'bootloader');
    expect(() => makeProvider({
      graph: { actions: [{ inputs: [valid.input] }] },
    }, [])).toThrow(/provenance is missing or ambiguous/);

    const wrongIdentity = boardRequest('bootloader', bytes, 'bootloader', {
      packRevision: '9'.repeat(64),
    });
    expect(() => makeProvider({
      graph: { actions: [{ inputs: [wrongIdentity.input], packInputs: [wrongIdentity.packInput] }] },
    }, [])).toThrow(/Board Pack identity is invalid/);

    expect(() => makeProvider({
      graph: { actions: [{
        inputs: [{ ...valid.input, path: BOARD_INPUTS.partitions.path }],
        packInputs: [valid.packInput],
      }] },
    }, [])).toThrow(/Board Pack request is invalid/);

    const projectPartitions = new TextEncoder().encode('nvs,data,nvs,0x9000,0x5000,\n');
    const invalidProjectProvenance = boardRequest('partitions', projectPartitions, 'partitions');
    expect(() => makeProvider({
      graph: { actions: [{
        inputs: [input('partitions.csv', projectPartitions, 'partitions-source')],
        packInputs: [invalidProjectProvenance.packInput],
      }] },
    }, [])).toThrow(/provenance has no exact file request/);
  });

  it('rejects a pre-existing file at a post-link Board Pack path', async () => {
    const bytes = new TextEncoder().encode('boot');
    const request = boardRequest('bootloader', bytes, 'bootloader');
    const { provider, packs } = makeProvider({
      graph: { actions: [{ inputs: [request.input], packInputs: [request.packInput] }] },
    }, []);

    await expect(provider.materialize(packs, {
      hasFile: (path: string) => path === request.input.path,
      writeFile: async () => {},
    })).rejects.toThrow(/path collides with an existing file/);
  });

  it('rejects Board Manifest schema/hash mismatches and tampered artifact bytes', async () => {
    const actual = new TextEncoder().encode('boot');
    const wrongBytes = new TextEncoder().encode('other boot');
    const wrongHash = boardRequest('bootloader', wrongBytes, 'bootloader');
    const hashSetup = makeProvider({
      graph: { actions: [{ inputs: [wrongHash.input], packInputs: [wrongHash.packInput] }] },
    }, []);
    await expect(materialize(hashSetup.provider, hashSetup.packs)).rejects.toThrow(/artifact binding is invalid/);

    const wrongSchema = boardRequest('bootloader', actual, 'bootloader', { packSchema: 1 });
    const schemaSetup = makeProvider({
      graph: { actions: [{ inputs: [wrongSchema.input], packInputs: [wrongSchema.packInput] }] },
    }, []);
    await expect(materialize(schemaSetup.provider, schemaSetup.packs)).rejects.toThrow(/Manifest identity is invalid/);

    const valid = boardRequest('bootloader', actual, 'bootloader');
    const tamperedSetup = makeProvider({
      graph: { actions: [{ inputs: [valid.input], packInputs: [valid.packInput] }] },
    }, []);
    tamperedSetup.boardArtifacts.set('bootloader', new TextEncoder().encode('tampered'));
    await expect(materialize(tamperedSetup.provider, tamperedSetup.packs)).rejects.toThrow(/artifact bytes are invalid/);
  });

  it('rejects executor-owned toolchain runtime paths instead of reading them from the SDK Pack', async () => {
    const calls: string[] = [];
    const ir = { graph: { actions: [{ inputs: [{ path: 'packs/toolchain/runtime/clang', sha256: 'a'.repeat(64) }] }] } };
    const { provider, packs } = makeProvider(ir, calls);
    await expect(materialize(provider, packs)).rejects.toThrow(/packs\/toolchain\/runtime\/clang/);
    expect(calls).toEqual([]);
  });

  it('materializes include-only Library Pack fragments requested by Build IR', async () => {
    const calls: string[] = [];
    const content = 'template <typename T> class CircularBuffer {};\n';
    const bytes = new TextEncoder().encode(content);
    const libraryPack = {
      kind: 'library', id: 'arduino-lib-circularbuffer', version: '1.0.0', sha256: '5'.repeat(64),
      name: 'CircularBuffer', architectures: ['esp32'], manifest: { name: 'CircularBuffer' }, dependencies: [],
    };
    const runtime = descriptor();
    const packs = buildPacks(runtime, [libraryPack]);
    const ir = { packs, graph: { actions: [{ inputs: [{
      path: 'packs/libraries/arduino-lib-circularbuffer/src/CircularBuffer.tpp',
      sha256: hash(bytes),
      role: 'library-include-fragment',
    }] }] } };
    const basePlanning = planning();
    basePlanning.librarySources = [{
      packId: 'arduino-lib-circularbuffer',
      files: [{ path: 'src/CircularBuffer.tpp', content }],
    }];
    const provider = createEsp32BrowserPackProvider({
      capability: {
        pinnedRuntime: {
          descriptor: runtime,
          descriptorUrl: new URL('https://example.test/runtime.json'),
        },
      },
      planning: basePlanning,
      ir,
      dependencies: {
        createPackLoader: () => ({
          async loadArtifact() { throw new Error('runtime Pack should not be loaded'); },
          reset() {},
        }),
      },
    });

    const files = await materialize(provider, packs);
    expect(files.get('packs/libraries/arduino-lib-circularbuffer/src/CircularBuffer.tpp')).toEqual(bytes);
    expect(calls).toEqual([]);
  });

  it('rejects conflicting hashes for one logical Pack path', () => {
    const calls: string[] = [];
    const path = 'packs/platform/core.a';
    expect(() => makeProvider({
      graph: { actions: [
        { inputs: [{ path, sha256: 'a'.repeat(64) }] },
        { inputs: [{ path, sha256: 'b'.repeat(64) }] },
      ] },
    }, calls)).toThrow(/Pack input hash conflict/);
  });

  it('rejects executor BuildPacks that differ from the bound Build IR', async () => {
    const calls: string[] = [];
    const { provider, packs } = makeProvider({ graph: { actions: [] } }, calls);
    await expect(materialize(provider, {
      ...packs,
      platform: { ...packs.platform, sha256: 'f'.repeat(64) },
    })).rejects.toThrow(/do not match/);
    expect(calls).toEqual([]);
  });
});
