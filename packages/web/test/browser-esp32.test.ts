import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
  validateEsp32BrowserLibraryRegistry,
} from '../public/esp32/v1/library-registry.js';
import {
  ESP32_BROWSER_PLATFORM_REGISTRY_SCHEMA,
} from '../public/esp32/v1/platform-registry.js';

const capabilityUrl = new URL('../public/esp32/v1/capabilities.json', import.meta.url);
const c3DescriptorUrl = new URL('../public/esp32/v2/runtime/runtime.json', import.meta.url);
const c6DescriptorUrl = new URL('../public/esp32/v2/runtime-c6/runtime.json', import.meta.url);
const libraryRegistryUrl = new URL('../public/esp32/v1/libraries-catalog/registry.json', import.meta.url);
const platformRegistryUrl = new URL('../public/esp32/v1/platform-manifests/registry.json', import.meta.url);
const publishedPlatformRegistry = JSON.parse(
  readFileSync(fileURLToPath(platformRegistryUrl), 'utf8'),
);
const platformManifestUrls = [...new Set<string>(
  publishedPlatformRegistry.entries.map(
    (entry: { path: string }) => new URL(entry.path, platformRegistryUrl).href,
  ),
)].map((href) => new URL(href));
const xtensaTargets = [
  {
    board: 'esp32:esp32:esp32', runtimeId: 'esp32-arduino', descriptor: 'esp32.json',
    worker: 'esp32-worker.js', bootloaderOffset: '0x1000',
  },
  {
    board: 'esp32:esp32:esp32s2', runtimeId: 'esp32-s2-arduino', descriptor: 'esp32s2.json',
    worker: 's2-worker.js', bootloaderOffset: '0x1000',
  },
  {
    board: 'esp32:esp32:esp32s3', runtimeId: 'esp32-s3-arduino', descriptor: 'esp32s3.json',
    worker: 's3-worker.js', bootloaderOffset: '0x0',
  },
] as const;
const localCompilerUrls = new Set([
  capabilityUrl.href,
  c3DescriptorUrl.href,
  c6DescriptorUrl.href,
  libraryRegistryUrl.href,
  platformRegistryUrl.href,
  ...platformManifestUrls.map((url) => url.href),
  ...xtensaTargets.map((target) => new URL(`../public/esp32/v5/xtensa/${target.descriptor}`, import.meta.url).href),
]);
const C3_COMPILER_REVISION = 'a'.repeat(64);

function request(board = 'esp32:esp32:esp32c3') {
  return {
    board,
    files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}' }],
    options: {},
  };
}

function multiFileRequest(board = 'esp32:esp32:esp32c3') {
  return {
    board,
    files: [
      { name: 'main.ino', content: '#include "include/helper.hpp"\nvoid setup() { helper(); }\nvoid loop() {}' },
      { name: 'src/plain.c', content: 'int plain(void) { return 1; }' },
      { name: 'src/legacy.cc', content: 'int legacy() { return 2; }' },
      { name: 'src/helper.cpp', content: '#include "../include/helper.hpp"\nvoid helper() {}' },
      { name: 'src/modern.cxx', content: 'int modern() { return 3; }' },
      { name: 'startup/entry.S', content: '.text' },
      { name: 'include/plain.h', content: 'int plain(void);' },
      { name: 'include/legacy.hh', content: 'int legacy();' },
      { name: 'include/helper.hpp', content: 'void helper();' },
      { name: 'include/modern.hxx', content: 'int modern();' },
    ],
    options: {},
  };
}

async function localCapabilityResponse(input: URL | string) {
  const url = new URL(String(input));
  if (!localCompilerUrls.has(url.href)) {
    throw new Error(`unexpected browser compiler fetch: ${url.href}`);
  }
  return new Response(await readFile(fileURLToPath(url)), { status: 200 });
}

async function sha256(bytes: Uint8Array) {
  const digest = new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function createTestBuildIR(compileRequest: ReturnType<typeof request>) {
  const encoder = new TextEncoder();
  const files = await Promise.all(compileRequest.files.map(async (file) => {
    const bytes = encoder.encode(file.content);
    const extension = file.name.toLowerCase().split('.').at(-1);
    const language = extension === 'ino' ? 'ino'
      : extension === 'c' ? 'c'
        : ['s', 'asm'].includes(extension ?? '') ? 'asm'
          : ['h', 'hh', 'hpp', 'hxx'].includes(extension ?? '') ? 'header'
            : ['cc', 'cpp', 'cxx'].includes(extension ?? '') ? 'c++'
              : 'other';
    return {
      path: file.name,
      content: file.content,
      language,
      generated: false,
      sha256: await sha256(bytes),
      size: bytes.byteLength,
    };
  }));
  const bootloaderOffset = ['esp32:esp32:esp32', 'esp32:esp32:esp32s2'].includes(compileRequest.board)
    ? '0x1000'
    : '0x0';
  const artifacts = [
    { id: 'application', path: 'build/firmware.bin', format: 'bin', offset: '0x10000' },
    { id: 'bootloader', path: 'build/bootloader.bin', format: 'bootloader', offset: bootloaderOffset },
    { id: 'partitions', path: 'build/partitions.bin', format: 'partition', offset: '0x8000' },
    { id: 'boot-app0', path: 'build/boot_app0.bin', format: 'boot-app0', offset: '0xe000' },
    { id: 'merged', path: 'build/firmware.merged.bin', format: 'bin', offset: undefined },
  ];
  const inputs = files.map((file) => ({ path: file.path, sha256: file.sha256, role: 'source' }));
  const actions = await Promise.all(artifacts.map(async (artifact) => ({
    id: `test-${artifact.id}`,
    kind: 'transform',
    tool: 'ck:test-action-session',
    inputs,
    outputs: [{ path: artifact.path, kind: artifact.id }],
    arguments: [],
    environment: {},
    dependencies: [],
    packDependencies: [],
    cacheKey: await sha256(encoder.encode([
      compileRequest.board,
      artifact.path,
      ...files.map((file) => `${file.path}:${file.sha256}`),
    ].join('\n'))),
    transform: {
      input: files[0]?.path ?? 'main.ino',
      output: artifact.path,
      format: artifact.format,
      flags: [],
    },
  })));
  return {
    kind: 'ck-build-ir',
    schemaVersion: 1,
    project: { files },
    target: { fqbn: compileRequest.board, options: compileRequest.options ?? {} },
    packs: {},
    graph: { actions },
    artifacts: artifacts.map(({ path, format, offset }) => ({ path, format, offset })),
    diagnosticMap: { entries: [] },
  };
}

async function enabledC3Fixture({ descriptorPin = true, legacyDescriptorPin = false } = {}) {
  const capabilityManifest = {
    schema: 1,
    runtimes: [
      {
        id: 'esp32-riscv',
        architecture: 'riscv32',
        boards: [
          'esp32:esp32:esp32c3',
          'esp32:esp32:esp32c5',
          'esp32:esp32:esp32c6',
          'esp32:esp32:esp32h2',
          'esp32:esp32:esp32p4',
        ],
        state: 'ready',
        imageBuilderBoards: ['esp32:esp32:esp32c3', 'esp32:esp32:esp32c6'],
        toolchain: { id: 'riscv32-esp-elf-wasm', revision: C3_COMPILER_REVISION },
      },
      {
        id: 'esp32-xtensa',
        architecture: 'xtensa',
        boards: ['esp32:esp32:esp32', 'esp32:esp32:esp32s2', 'esp32:esp32:esp32s3'],
        state: 'unavailable',
        imageBuilderBoards: [],
        toolchain: null,
      },
    ],
  };
  const descriptor = {
    schema: 2,
    id: 'esp32-c3-arduino',
    abi: 1,
    board: 'esp32:esp32:esp32c3',
    packs: [
      {
        role: 'compiler', id: 'riscv32-esp-elf-wasm', revision: C3_COMPILER_REVISION,
        manifest: 'packs/compiler/toolchain.json',
      },
      {
        role: 'sdk', id: 'arduino-esp32c3-sdk', revision: 'b'.repeat(64),
        manifest: 'packs/sdk/toolchain.json',
      },
      {
        role: 'board', id: 'arduino-esp32c3-board', revision: 'c'.repeat(64),
        manifest: 'packs/board/toolchain.json',
      },
    ],
  };
  const c6Descriptor = {
    schema: 2,
    id: 'esp32-c6-arduino',
    abi: 1,
    board: 'esp32:esp32:esp32c6',
    packs: [
      {
        role: 'compiler', id: 'riscv32-esp-elf-wasm', revision: C3_COMPILER_REVISION,
        manifest: 'packs/compiler/toolchain.json',
      },
      {
        role: 'sdk', id: 'arduino-esp32c6-sdk', revision: 'd'.repeat(64),
        manifest: 'packs/sdk/toolchain.json',
      },
      {
        role: 'board', id: 'arduino-esp32c6-board', revision: 'e'.repeat(64),
        manifest: 'packs/board/toolchain.json',
      },
    ],
  };
  const encoder = new TextEncoder();
  const c3SdkPack = { id: 'arduino-esp32c3-sdk', revision: 'b'.repeat(64) };
  const c6SdkPack = { id: 'arduino-esp32c6-sdk', revision: 'd'.repeat(64) };
  const publishedManifestUrl = platformManifestUrls[0]!;
  const publishedManifest = JSON.parse(await readFile(fileURLToPath(publishedManifestUrl), 'utf8'));
  const c3PlatformManifest = publishedManifest;
  const c6PlatformManifest = publishedManifest;
  const c3PlatformManifestUrl = new URL(
    `../public/esp32/v1/platform-manifests/espressif-arduino/${c3PlatformManifest.sha256}/manifest.json`,
    import.meta.url,
  );
  const c6PlatformManifestUrl = new URL(
    `../public/esp32/v1/platform-manifests/espressif-arduino/${c6PlatformManifest.sha256}/manifest.json`,
    import.meta.url,
  );
  const platformRegistry = {
    kind: 'ck-platform-manifest-registry',
    schemaVersion: ESP32_BROWSER_PLATFORM_REGISTRY_SCHEMA,
    entries: [
      {
        fqbn: 'esp32:esp32:esp32c3',
        id: 'espressif-arduino',
        version: '3.3.7',
        sha256: c3PlatformManifest.sha256,
        path: `espressif-arduino/${c3PlatformManifest.sha256}/manifest.json`,
        sdkPack: c3SdkPack,
      },
      {
        fqbn: 'esp32:esp32:esp32c6',
        id: 'espressif-arduino',
        version: '3.3.7',
        sha256: c6PlatformManifest.sha256,
        path: `espressif-arduino/${c6PlatformManifest.sha256}/manifest.json`,
        sdkPack: c6SdkPack,
      },
    ],
  };
  const capabilityBytes = encoder.encode(JSON.stringify(capabilityManifest));
  const platformRegistryBytes = encoder.encode(JSON.stringify(platformRegistry));
  const c3PlatformManifestBytes = encoder.encode(JSON.stringify(c3PlatformManifest));
  const c6PlatformManifestBytes = encoder.encode(JSON.stringify(c6PlatformManifest));
  const descriptorBytes = new TextEncoder().encode(JSON.stringify(descriptor));
  const c6DescriptorBytes = new TextEncoder().encode(JSON.stringify(c6Descriptor));
  const release = Object.freeze({
    schema: 1,
    capabilities: Object.freeze({ path: 'capabilities.json', sha256: await sha256(capabilityBytes) }),
    platforms: Object.freeze({
      path: 'platform-manifests/registry.json',
      sha256: await sha256(platformRegistryBytes),
    }),
    runtimes: Object.freeze({
      'esp32-riscv': Object.freeze({
        enabled: true,
        toolchainId: 'riscv32-esp-elf-wasm',
        revision: C3_COMPILER_REVISION,
        ...(legacyDescriptorPin ? {
          descriptorPath: './esp32/v2/runtime/runtime.json',
          descriptorSha256: await sha256(descriptorBytes),
        } : {}),
        descriptors: Object.freeze({
          ...(descriptorPin ? {
            'esp32:esp32:esp32c3': Object.freeze({
              path: './esp32/v2/runtime/runtime.json',
              sha256: await sha256(descriptorBytes),
            }),
          } : {}),
          'esp32:esp32:esp32c6': Object.freeze({
            path: './esp32/v2/runtime-c6/runtime.json',
            sha256: await sha256(c6DescriptorBytes),
          }),
        }),
      }),
      'esp32-xtensa': Object.freeze({ enabled: false, toolchainId: null, revision: null }),
    }),
  });
  return {
    descriptor,
    c6Descriptor,
    release,
    fetch: vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.href === capabilityUrl.href) return new Response(capabilityBytes, { status: 200 });
      if (url.href === c3DescriptorUrl.href) return new Response(descriptorBytes, { status: 200 });
      if (url.href === c6DescriptorUrl.href) return new Response(c6DescriptorBytes, { status: 200 });
      if (url.href === platformRegistryUrl.href) return new Response(platformRegistryBytes, { status: 200 });
      if (url.href === c3PlatformManifestUrl.href) return new Response(c3PlatformManifestBytes, { status: 200 });
      if (url.href === c6PlatformManifestUrl.href) return new Response(c6PlatformManifestBytes, { status: 200 });
      throw new Error(`unexpected RISC-V route fetch: ${url.href}`);
    }),
  };
}

async function loadEnabledC3Route(fixture: Awaited<ReturnType<typeof enabledC3Fixture>>) {
  vi.resetModules();
  vi.doMock('../public/esp32/v1/release.js', () => ({
    ESP32_BROWSER_RELEASE: fixture.release,
    esp32BrowserCapabilitiesUrl: () => capabilityUrl,
  }));
  vi.stubGlobal('fetch', fixture.fetch);
  return import('../public/browser-esp32.js');
}

function installC3Worker(result: Record<string, unknown>, error?: { code: string; message: string }) {
  let workerUrl: URL | undefined;
  let workerOptions: WorkerOptions | undefined;
  const posted: Array<Record<string, any>> = [];
  const listeners = new Map<string, (event: any) => void>();
  class WorkerHarness {
    constructor(url: URL, options: WorkerOptions) {
      workerUrl = new URL(String(url));
      workerOptions = options;
    }

    addEventListener(type: string, listener: (event: any) => void) {
      listeners.set(type, listener);
    }

    postMessage(message: Record<string, any>) {
      posted.push(message);
      if (message.type === 'init') {
        queueMicrotask(() => listeners.get('message')?.({ data: error
          ? { abi: 1, type: 'init-result', id: message.id, ok: false, error }
          : { abi: 1, type: 'init-result', id: message.id, ok: true } }));
        return;
      }
      if (message.type === 'close') {
        queueMicrotask(() => listeners.get('message')?.({
          data: { abi: 1, type: 'close-result', id: message.id, ok: true },
        }));
        return;
      }
      if (message.type !== 'action') return;
      queueMicrotask(() => {
        listeners.get('message')?.({
          data: { abi: 1, type: 'action-progress', id: message.id, progress: { stage: 'assets', percent: 10 } },
        });
        if (result.status === 'error') {
          listeners.get('message')?.({ data: {
            abi: 1,
            type: 'action-result',
            id: message.id,
            ok: false,
            error: {
              code: 'compiler_failed',
              reason: result.reason,
              message: result.message,
              diagnostics: result.diagnostics ?? [],
            },
          } });
          return;
        }
        const artifactBytes = new Map([
          ...((result.artifacts as Array<{ name: string; bytes: Uint8Array }> | undefined) ?? []),
          ...((result.staticArtifacts as Array<{ name: string; bytes: Uint8Array }> | undefined) ?? []),
        ].map((artifact) => [artifact.name, artifact.bytes] as const));
        listeners.get('message')?.({ data: {
          abi: 1,
          type: 'action-result',
          id: message.id,
          ok: true,
          result: {
            outputs: message.action.outputs.map((output: { path: string }) => ({
              path: output.path,
              bytes: artifactBytes.get(output.path.split('/').at(-1)!) ?? Uint8Array.of(0),
            })),
            diagnostics: [],
            cacheable: true,
          },
        } });
      });
    }

    terminate() {}
  }
  vi.stubGlobal('Worker', WorkerHarness);
  return {
    workerUrl: () => workerUrl,
    workerOptions: () => workerOptions,
    messages: () => posted,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.doMock('../public/esp32/v2/c3-compiler.js', () => ({
    loadEsp32BrowserBuildPlanning: vi.fn(async () => ({})),
  }));
  vi.doMock('../public/esp32/v2/ck-pack-provider.js', () => ({
    createEsp32BrowserPackProvider: vi.fn(() => ({ materialize: vi.fn(async () => {}) })),
  }));
  vi.doMock('../public/ck-build-ir-envelope.js', () => ({
    createEsp32BrowserBuildIR: vi.fn(createTestBuildIR),
    customEsp32PartitionsForBuildIR: vi.fn(() => null),
  }));
  vi.doMock('../public/ck-rust-build-core.js', () => ({
    validateBuildIR: vi.fn(async () => undefined),
    calculateActionKeys: vi.fn(async (ir: unknown) => ir),
  }));
  vi.stubGlobal('Worker', class Worker {});
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(localCapabilityResponse));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../public/esp32/v1/release.js');
  vi.doUnmock('../public/esp32/v2/c3-compiler.js');
  vi.doUnmock('../public/esp32/v2/ck-pack-provider.js');
  vi.doUnmock('../public/ck-build-ir-envelope.js');
  vi.doUnmock('../public/ck-rust-build-core.js');
  vi.resetModules();
});

describe('browser ESP32 capability routing', () => {
  it('exposes only the five boards backed by published browser routes', async () => {
    const {
      ESP32_BROWSER_BOARD_PROFILES,
      isEsp32BrowserBoard,
    } = await import('../public/browser-esp32.js');
    const supported = [
      'esp32:esp32:esp32',
      'esp32:esp32:esp32c3',
      'esp32:esp32:esp32c6',
      'esp32:esp32:esp32s2',
      'esp32:esp32:esp32s3',
    ];
    const unsupported = [
      'esp32:esp32:esp32c5',
      'esp32:esp32:esp32h2',
      'esp32:esp32:esp32p4',
    ];

    expect(Object.keys(ESP32_BROWSER_BOARD_PROFILES).sort()).toEqual([...supported].sort());
    for (const board of supported) expect(isEsp32BrowserBoard(board)).toBe(true);
    for (const board of unsupported) expect(isEsp32BrowserBoard(board)).toBe(false);
  });

  it('falls back before loading assets when gzip streams are unavailable', async () => {
    vi.stubGlobal('DecompressionStream', undefined);
    const { browserEsp32Capability } = await import('../public/browser-esp32.js');

    await expect(browserEsp32Capability(request())).resolves.toMatchObject({
      supported: false,
      reason: 'browser',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('adapts stable ESP32 products without relying on build paths or fixed offsets', async () => {
    const { adaptEsp32BuildExecution } = await import('../public/browser-esp32.js');
    const bytes = (value: number) => Uint8Array.of(value);
    const result = await adaptEsp32BuildExecution({
      status: 'success',
      artifacts: [
        { path: 'outputs/all.flash', productId: 'merged', bytes: bytes(5) },
        { path: 'objects/app.payload', kind: 'application', offset: '0x20000', bytes: bytes(4) },
        { path: 'configuration/ota.payload', productId: 'boot-app0', offset: '0xf000', bytes: bytes(3) },
        { path: 'configuration/layout.payload', kind: 'partitions', offset: '0x9000', bytes: bytes(2) },
        { path: 'configuration/startup.payload', productId: 'bootloader', offset: '0x2000', bytes: bytes(1) },
      ],
      diagnostics: [],
      durationMs: 1,
    }, 0);

    expect(result.artifacts).toEqual([expect.objectContaining({
      name: 'firmware.bin', offset: '0x20000', size: 1, base64: 'BA==',
    })]);
    expect(result.staticArtifacts.map(({ name, offset }: { name: string; offset: string }) => ({ name, offset })))
      .toEqual([
        { name: 'bootloader.bin', offset: '0x2000' },
        { name: 'partitions.bin', offset: '0x9000' },
        { name: 'boot_app0.bin', offset: '0xf000' },
      ]);
    expect(result.downloadArtifacts).toEqual([expect.objectContaining({
      name: 'firmware.merged.bin', size: 1, base64: 'BQ==',
    })]);
    expect(result.downloadArtifacts[0]).not.toHaveProperty('offset');
  });

  it('maps legacy execution artifacts through their Action output kinds', async () => {
    const { adaptEsp32BuildExecution } = await import('../public/browser-esp32.js');
    const products = [
      ['application', 'arbitrary/app', '0x30000'],
      ['bootloader', 'arbitrary/boot', '0x3000'],
      ['partitions', 'arbitrary/part', '0xa000'],
      ['boot-app0', 'arbitrary/ota', '0x10000'],
      ['merged', 'arbitrary/merged', undefined],
    ] as const;
    const execution = {
      status: 'success',
      artifacts: products.map(([, path, offset], index) => ({
        path, ...(offset === undefined ? {} : { offset }), bytes: Uint8Array.of(index + 1),
      })),
      diagnostics: [],
      durationMs: 1,
    };
    const ir = {
      graph: {
        actions: products.map(([kind, path]) => ({ outputs: [{ path, kind }] })),
      },
    };

    const result = await adaptEsp32BuildExecution(execution, 0, ir);

    expect(result.artifacts[0]).toMatchObject({ name: 'firmware.bin', offset: '0x30000' });
    expect(result.staticArtifacts.map(({ offset }: { offset: string }) => offset))
      .toEqual(['0x3000', '0xa000', '0x10000']);
    expect(result.downloadArtifacts[0]).toMatchObject({ name: 'firmware.merged.bin' });
  });

  it.each(['application', 'bootloader', 'partitions', 'boot-app0'])(
    'fails closed when the %s product has no flash offset',
    async (missingOffset) => {
      const { adaptEsp32BuildExecution } = await import('../public/browser-esp32.js');
      const products = [
        { productId: 'application', path: 'a', offset: '0x10000' },
        { productId: 'bootloader', path: 'b', offset: '0x0' },
        { productId: 'partitions', path: 'c', offset: '0x8000' },
        { productId: 'boot-app0', path: 'd', offset: '0xe000' },
        { productId: 'merged', path: 'e' },
      ].map((artifact) => ({
        ...artifact,
        ...(artifact.productId === missingOffset ? { offset: undefined } : {}),
        bytes: Uint8Array.of(1),
      }));

      await expect(adaptEsp32BuildExecution({
        status: 'success', artifacts: products, diagnostics: [], durationMs: 1,
      }, 0)).rejects.toThrow(`no valid ${missingOffset} flash offset`);
    },
  );

  it('reads the release-pinned ready C3 route from local metadata', async () => {
    const { browserEsp32Capability } = await import('../public/browser-esp32.js');

    await expect(browserEsp32Capability(request())).resolves.toMatchObject({
      supported: true,
      profile: {
        board: 'esp32:esp32:esp32c3',
        architecture: 'riscv32',
        runtime: 'esp32-riscv',
        imageBuilder: true,
      },
      runtime: { id: 'esp32-riscv', state: 'ready' },
      c3Runtime: {
        descriptor: {
          schema: 2,
          id: 'esp32-c3-arduino',
          abi: 1,
          board: 'esp32:esp32:esp32c3',
          packs: expect.arrayContaining([
            expect.objectContaining({
              role: 'compiler',
              id: 'riscv32-esp-elf-wasm',
              revision: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
          ]),
        },
        descriptorUrl: c3DescriptorUrl.href,
      },
    });
    expect(fetch).toHaveBeenCalledWith(capabilityUrl, { cache: 'no-cache' });
    expect(fetch).toHaveBeenCalledWith(c3DescriptorUrl, { cache: 'no-cache' });
  });

  it('reads the release-pinned ready C6 route from local metadata', async () => {
    const { browserEsp32Capability } = await import('../public/browser-esp32.js');

    await expect(browserEsp32Capability(request('esp32:esp32:esp32c6'))).resolves.toMatchObject({
      supported: true,
      profile: {
        board: 'esp32:esp32:esp32c6',
        architecture: 'riscv32',
        runtime: 'esp32-riscv',
        imageBuilder: true,
      },
      runtime: { id: 'esp32-riscv', state: 'ready' },
      pinnedRuntime: {
        descriptor: {
          schema: 2,
          id: 'esp32-c6-arduino',
          abi: 1,
          board: 'esp32:esp32:esp32c6',
          packs: expect.arrayContaining([
            expect.objectContaining({
              role: 'compiler',
              id: 'riscv32-esp-elf-wasm',
              revision: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
          ]),
        },
        descriptorUrl: c6DescriptorUrl.href,
      },
    });
    expect(fetch).toHaveBeenCalledWith(capabilityUrl, { cache: 'no-cache' });
    expect(fetch).toHaveBeenCalledWith(c6DescriptorUrl, { cache: 'no-cache' });
  });

  it.each(xtensaTargets)('loads the release-pinned Xtensa descriptor for $board', async (target) => {
    const { browserEsp32Capability } = await import('../public/browser-esp32.js');
    const descriptorUrl = new URL(`../public/esp32/v5/xtensa/${target.descriptor}`, import.meta.url);

    await expect(browserEsp32Capability(request(target.board))).resolves.toMatchObject({
      supported: true,
      profile: { board: target.board, architecture: 'xtensa', runtime: 'esp32-xtensa', imageBuilder: true },
      runtime: { id: 'esp32-xtensa', state: 'ready' },
      pinnedRuntime: {
        descriptor: {
          id: target.runtimeId,
          board: target.board,
          packs: expect.arrayContaining([expect.objectContaining({
            role: 'compiler',
            id: 'xtensa-esp-elf-wasm',
          })]),
        },
        descriptorUrl: descriptorUrl.href,
      },
    });
  });

  it.each(xtensaTargets)('runs only the pinned $worker and adapts its artifacts', async (target) => {
    const worker = installC3Worker({
      status: 'success',
      artifacts: [{ name: 'firmware.bin', offset: '0x10000', bytes: Uint8Array.of(1, 2, 3) }],
      staticArtifacts: [
        { name: 'bootloader.bin', offset: target.bootloaderOffset, bytes: Uint8Array.of(4) },
        { name: 'partitions.bin', offset: '0x8000', bytes: Uint8Array.of(5) },
        { name: 'boot_app0.bin', offset: '0xe000', bytes: Uint8Array.of(6) },
      ],
      diagnostics: [],
      timings: { total: 12 },
    });
    const { compileEsp32InBrowser } = await import('../public/browser-esp32.js');

    await expect(compileEsp32InBrowser(request(target.board))).resolves.toMatchObject({
      handled: true,
      result: {
        status: 'success',
        execution: 'browser',
        artifacts: [{ name: 'firmware.bin', size: 3, base64: 'AQID' }],
        staticArtifacts: expect.arrayContaining([
          expect.objectContaining({ name: 'bootloader.bin', offset: target.bootloaderOffset }),
        ]),
      },
    });
    expect(worker.workerUrl()?.pathname.replaceAll('\\', '/')).toMatch(new RegExp(`/esp32/v2/${target.worker}$`));
    expect(worker.messages().find((message) => message.type === 'init')).toMatchObject({
      runtime: { descriptor: { id: target.runtimeId, board: target.board } },
    });
    expect(worker.messages().map((message) => message.type)).toEqual([
      'init', 'action', 'action', 'action', 'action', 'action', 'close',
    ]);
  });

  it.each([
    'network',
    408,
    429,
    503,
    'read',
    'checksum',
  ])('retries a first %s capability failure with cache reload', async (failure) => {
    let attempt = 0;
    const fetch = vi.fn(async (input: URL | string) => {
      attempt += 1;
      if (attempt > 1) return localCapabilityResponse(input);
      if (failure === 'network') throw new TypeError('temporary network failure');
      if (failure === 'read') {
        const response = new Response('', { status: 200 });
        vi.spyOn(response, 'arrayBuffer').mockRejectedValueOnce(new Error('temporary read failure'));
        return response;
      }
      if (failure === 'checksum') return new Response('{"schema":1,"runtimes":[]}', { status: 200 });
      return new Response('', { status: typeof failure === 'number' ? failure : 500 });
    });
    vi.stubGlobal('fetch', fetch);
    const { loadEsp32BrowserCapabilityManifest } = await import('../public/browser-esp32.js');

    await expect(loadEsp32BrowserCapabilityManifest()).resolves.toMatchObject({ schema: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, capabilityUrl, { cache: 'no-cache' });
    expect(fetch).toHaveBeenNthCalledWith(2, capabilityUrl, { cache: 'reload' });
  });

  it('clears a rejected capability promise after its reload retry is exhausted', async () => {
    let attempt = 0;
    const fetch = vi.fn(async (input: URL | string) => {
      attempt += 1;
      if (attempt <= 2) throw new TypeError('temporary network failure');
      return localCapabilityResponse(input);
    });
    vi.stubGlobal('fetch', fetch);
    const { loadEsp32BrowserCapabilityManifest } = await import('../public/browser-esp32.js');

    await expect(loadEsp32BrowserCapabilityManifest()).rejects.toThrow(/temporary network failure/);
    await expect(loadEsp32BrowserCapabilityManifest()).resolves.toMatchObject({ schema: 1 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(1, capabilityUrl, { cache: 'no-cache' });
    expect(fetch).toHaveBeenNthCalledWith(2, capabilityUrl, { cache: 'reload' });
    expect(fetch).toHaveBeenNthCalledWith(3, capabilityUrl, { cache: 'no-cache' });
  });

  it('does not reload retry a non-transient capability HTTP failure', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const { loadEsp32BrowserCapabilityManifest } = await import('../public/browser-esp32.js');

    await expect(loadEsp32BrowserCapabilityManifest()).rejects.toThrow(/returned 404/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(capabilityUrl, { cache: 'no-cache' });
  });

  it('rejects a changed capability manifest and falls back instead of enabling a runtime', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"schema":1,"runtimes":[]}', { status: 200 })));
    const { compileEsp32InBrowser } = await import('../public/browser-esp32.js');

    await expect(compileEsp32InBrowser(request())).resolves.toMatchObject({
      handled: false,
      reason: 'assets',
    });
  });

  it('requires a matching same-origin release pin before a RISC-V runtime can activate', async () => {
    const { browserEsp32RuntimeActivation } = await import('../public/browser-esp32.js');

    expect(browserEsp32RuntimeActivation({
      id: 'esp32-riscv',
      state: 'ready',
      toolchain: { id: 'esp32-riscv-runtime', revision: '0'.repeat(64) },
    })).toEqual({ enabled: false, reason: 'runtime_unpinned' });
  });

  it('keeps malformed and unknown-library ESP32 requests on the server', async () => {
    const { browserEsp32Capability } = await import('../public/browser-esp32.js');

    await expect(browserEsp32Capability({ ...request(), libraries: [{ name: 'Definitely Unknown' }] })).resolves.toMatchObject({
      supported: false,
      reason: 'libraries',
    });
    await expect(browserEsp32Capability({ ...request(), files: [] })).resolves.toEqual({
      supported: false,
      reason: 'request',
      profile: expect.objectContaining({ architecture: 'riscv32' }),
    });
    await expect(browserEsp32Capability({ ...request(), board: '__proto__' })).resolves.toEqual({
      supported: false,
      reason: 'board',
    });
    expect(fetch).toHaveBeenCalledWith(capabilityUrl, { cache: 'no-cache' });
    expect(fetch).toHaveBeenCalledWith(libraryRegistryUrl, { cache: 'no-cache' });
    expect(fetch).not.toHaveBeenCalledWith(c3DescriptorUrl, expect.anything());
  });

  it('keeps an imported library without an immutable Browser Pack on the server with its identity intact', async () => {
    const { compileEsp32InBrowser } = await import('../public/browser-esp32.js');
    const importedLibrary = { name: 'GitHub Imported Fixture', version: '1.2.3' };
    const compileRequest = {
      ...request(),
      files: [{
        name: 'main.ino',
        content: '#include <GitHubImportedFixture.h>\nvoid setup() {}\nvoid loop() {}\n',
      }],
      libraries: [importedLibrary],
    };
    const requestBeforeRouting = structuredClone(compileRequest);

    await expect(compileEsp32InBrowser(compileRequest)).resolves.toMatchObject({
      handled: false,
      reason: 'libraries',
    });
    expect(compileRequest).toEqual(requestBeforeRouting);
    expect(compileRequest.libraries).toEqual([{ name: 'GitHub Imported Fixture', version: '1.2.3' }]);
    expect(fetch).toHaveBeenCalledWith(libraryRegistryUrl, { cache: 'no-cache' });
    expect(fetch).not.toHaveBeenCalledWith(c3DescriptorUrl, expect.anything());
  });

  it('keeps an implicit unknown include on the server after checking the pinned registry', async () => {
    const { browserEsp32Capability, inspectEsp32BrowserIncludes } = await import('../public/browser-esp32.js');

    await expect(browserEsp32Capability({
      ...request(),
      files: [{
        name: 'main.ino',
        content: '#include <SomeThirdPartyLibrary.h>\nvoid setup() {}\nvoid loop() {}\n',
      }],
    })).resolves.toMatchObject({
      supported: false,
      reason: 'libraries',
    });
    expect(fetch).toHaveBeenCalledWith(libraryRegistryUrl, { cache: 'no-cache' });
    expect(fetch).not.toHaveBeenCalledWith(c3DescriptorUrl, expect.anything());

    expect(inspectEsp32BrowserIncludes([{
      name: 'main.ino',
      content: '#include <vector>\n#include <driver/gpio.h>\n',
    }])).toEqual({ supported: true, libraries: [] });
    expect(inspectEsp32BrowserIncludes([{
      name: 'main.ino',
      content: '#include <SomeThirdPartyLibrary.h>\n',
    }])).toEqual({ supported: false, libraries: [] });
  });

  it('routes an include exclusively from validated registry header metadata', async () => {
    const { inspectEsp32BrowserIncludes } = await import('../public/browser-esp32.js');
    const registry = validateEsp32BrowserLibraryRegistry({
      schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
      libraries: [{
        name: 'Registry Routed',
        defaultVersion: '1.0.0',
        versions: [{
          version: '1.0.0',
          architectures: ['esp32'],
          publicHeaders: ['OnlyFromRegistry.h'],
          depends: [],
          pack: {
            id: 'arduino-lib-registry-routed',
            revision: 'a'.repeat(64),
            manifest: 'registry-routed/1.0.0/toolchain.json',
            artifact: 'sources',
          },
        }],
      }],
    }, new URL('https://app.example.test/esp32/v1/libraries/registry.json'));

    expect(inspectEsp32BrowserIncludes([{
      name: 'main.ino',
      content: '#include <OnlyFromRegistry.h>\n',
    }], [], registry)).toEqual({
      supported: true,
      libraries: [{ name: 'Registry Routed', version: '1.0.0' }],
    });
  });

  it('prefers an exact Registry header over the broad ESP32 SDK heuristic', async () => {
    const { inspectEsp32BrowserIncludes } = await import('../public/browser-esp32.js');
    const registry = validateEsp32BrowserLibraryRegistry({
      schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
      libraries: [{
        name: 'ESP32Servo',
        defaultVersion: '3.0.9',
        versions: [{
          version: '3.0.9',
          architectures: ['esp32'],
          publicHeaders: ['ESP32Servo.h'],
          depends: [],
          pack: {
            id: 'arduino-lib-esp32servo',
            revision: 'b'.repeat(64),
            manifest: 'esp32servo/3.0.9/toolchain.json',
            artifact: 'sources',
          },
        }],
      }],
    }, new URL('https://app.example.test/esp32/v1/libraries/registry.json'));

    expect(inspectEsp32BrowserIncludes([{
      name: 'main.ino',
      content: '#include <ESP32Servo.h>\n#include <esp_wifi.h>\n',
    }], [], registry)).toEqual({
      supported: true,
      libraries: [{ name: 'ESP32Servo', version: '3.0.9' }],
    });
  });

  it('loads the pinned Registry before accepting an ambiguous ESP32-prefixed include', async () => {
    const { browserEsp32Capability } = await import('../public/browser-esp32.js');

    await expect(browserEsp32Capability({
      ...request(),
      files: [{
        name: 'main.ino',
        content: '#include <ESP32Servo.h>\nvoid setup() {}\nvoid loop() {}\n',
      }],
    })).resolves.toMatchObject({
      supported: true,
      pinnedLibraries: [expect.objectContaining({ name: 'ESP32Servo', version: '3.2.1' })],
    });
    expect(fetch).toHaveBeenCalledWith(libraryRegistryUrl, { cache: 'no-cache' });
  });

  it('derives future board profiles from validated capability data', async () => {
    const { validateEsp32BrowserCapabilityManifest } = await import('../public/browser-esp32.js');
    const manifest = validateEsp32BrowserCapabilityManifest({
      schema: 1,
      runtimes: [{
        id: 'esp32-future',
        architecture: 'future32',
        boards: ['esp32:esp32:esp32future'],
        state: 'unavailable',
        imageBuilderBoards: ['esp32:esp32:esp32future'],
        toolchain: null,
      }],
    });

    expect(manifest.profilesByBoard.get('esp32:esp32:esp32future')).toEqual({
      board: 'esp32:esp32:esp32future',
      architecture: 'future32',
      runtime: 'esp32-future',
      imageBuilder: true,
    });
  });

  it('infers a trusted browser library from its include header', async () => {
    const worker = installC3Worker({
      status: 'success',
      artifacts: [{ name: 'firmware.bin', offset: '0x10000', bytes: Uint8Array.of(1) }],
      staticArtifacts: [
        { name: 'bootloader.bin', offset: '0x0', bytes: Uint8Array.of(2) },
        { name: 'partitions.bin', offset: '0x8000', bytes: Uint8Array.of(3) },
        { name: 'boot_app0.bin', offset: '0xe000', bytes: Uint8Array.of(4) },
      ],
      diagnostics: [],
      timings: { total: 12 },
    });
    const { compileEsp32InBrowser } = await import('../public/browser-esp32.js');
    const compileRequest = {
      ...request(),
      files: [{
        name: 'main.ino',
        content: '#include <PubSubClient.h>\nvoid setup() {}\nvoid loop() {}\n',
      }],
    };

    await expect(compileEsp32InBrowser(compileRequest)).resolves.toMatchObject({
      handled: true,
      result: { status: 'success', execution: 'browser' },
    });
    const envelope = await import('../public/ck-build-ir-envelope.js');
    expect(vi.mocked(envelope.createEsp32BrowserBuildIR)).toHaveBeenCalledWith(
      compileRequest,
      expect.objectContaining({
        pinnedLibraries: [expect.objectContaining({ name: 'PubSubClient', version: '2.8' })],
      }),
      {},
    );
    expect(worker.messages().some((message) => message.type === 'compile')).toBe(false);
  });

  it('pins Registry dependencies declared only by a project-local library manifest', async () => {
    const { browserEsp32Capability } = await import('../public/browser-esp32.js');
    const compileRequest = {
      ...request(),
      files: [
        ...request().files,
        { name: 'libraries/Local/library.properties', content: 'name=Local\nversion=1.0.0\ndepends=PubSubClient\n' },
        { name: 'libraries/Local/src/Local.h', content: '#pragma once\n' },
      ],
    };

    await expect(browserEsp32Capability(compileRequest)).resolves.toMatchObject({
      supported: true,
      pinnedLibraries: [expect.objectContaining({ name: 'PubSubClient', version: '2.8' })],
    });
    expect(fetch).toHaveBeenCalledWith(libraryRegistryUrl, { cache: 'no-cache' });
  });

  it('routes an exact trusted PubSubClient selection to the pinned Worker', async () => {
    const worker = installC3Worker({
      status: 'success',
      artifacts: [{ name: 'firmware.bin', offset: '0x10000', bytes: Uint8Array.of(1) }],
      staticArtifacts: [
        { name: 'bootloader.bin', offset: '0x0', bytes: Uint8Array.of(2) },
        { name: 'partitions.bin', offset: '0x8000', bytes: Uint8Array.of(3) },
        { name: 'boot_app0.bin', offset: '0xe000', bytes: Uint8Array.of(4) },
      ],
      diagnostics: [],
      timings: { total: 12 },
    });
    const { compileEsp32InBrowser } = await import('../public/browser-esp32.js');
    const compileRequest = {
      ...request(),
      files: [{
        name: 'main.ino',
        content: '#include <PubSubClient.h>\nvoid setup() {}\nvoid loop() {}\n',
      }],
      libraries: [{ name: 'PubSubClient', version: '2.8' }],
    };

    expect(compileRequest.libraries).toEqual([{ name: 'PubSubClient', version: '2.8' }]);

    await expect(compileEsp32InBrowser(compileRequest)).resolves.toMatchObject({
      handled: true,
      result: { status: 'success', execution: 'browser' },
    });
    const envelope = await import('../public/ck-build-ir-envelope.js');
    expect(vi.mocked(envelope.createEsp32BrowserBuildIR)).toHaveBeenCalledWith(
      compileRequest,
      expect.objectContaining({
        pinnedLibraries: [expect.objectContaining({
          name: 'PubSubClient',
          version: '2.8',
          packId: 'arduino-lib-pubsubclient',
          revision: expect.stringMatching(/^[a-f0-9]{64}$/),
          manifestUrl: expect.stringMatching(/\/libraries-catalog\/pubsubclient\/2\.8\/toolchain\.json$/),
          artifact: 'sources',
        })],
      }),
      {},
    );
    expect(worker.messages().some((message) => message.type === 'compile')).toBe(false);
    expect(fetch).toHaveBeenCalledWith(libraryRegistryUrl, { cache: 'no-cache' });
  });

  it('accepts bounded multi-file projects and rejects unsafe project layouts before loading assets', async () => {
    const { browserEsp32Capability } = await import('../public/browser-esp32.js');
    const invalidProjects = [
      [{ name: 'src/main.ino', content: '' }],
      [{ name: 'main.ino', content: '' }, { name: 'other.ino', content: '' }],
      [{ name: 'main.ino', content: '' }, { name: '../src/helper.cpp', content: '' }],
      [{ name: 'main.ino', content: '' }, { name: 'src/helper.txt', content: '' }],
      [{ name: 'main.ino', content: '' }, { name: 'src/helper.cpp', content: '' }, { name: 'src/helper.cpp', content: '' }],
      [{ name: 'main.ino', content: '' }, { name: 'src/helper.cpp', content: '' }, { name: 'SRC/HELPER.cpp', content: '' }],
      [{ name: 'main.ino', content: '' }, { name: 'a/config.h', content: '' }, { name: 'b/config.h', content: '' }],
      [{ name: 'main.ino', content: '' }, { name: 'constructor/helper.cpp', content: '' }],
      [{ name: 'main.ino', content: '\0' }],
      [
        { name: 'main.ino', content: '' },
        ...Array.from({ length: 128 }, (_, index) => ({ name: `include/file-${index}.h`, content: '' })),
      ],
    ];

    for (const files of invalidProjects) {
      await expect(
        browserEsp32Capability({ ...request(), files }),
        `invalid project: ${files.map((file) => file.name).join(', ')}`,
      ).resolves.toMatchObject({
        supported: false,
        reason: 'request',
      });
    }
    await expect(browserEsp32Capability({
      ...request(),
      files: [{ name: 'main.ino', content: 'x'.repeat(2 * 1024 * 1024 + 1) }],
    })).resolves.toMatchObject({ supported: false, reason: 'source_size' });
    expect(fetch).not.toHaveBeenCalled();

    const maximumFileCount = [
      { name: 'main.ino', content: '' },
      ...Array.from({ length: 127 }, (_, index) => ({ name: `include/file-${index}.h`, content: '' })),
    ];
    await expect(browserEsp32Capability({ ...request(), files: maximumFileCount })).resolves.toMatchObject({
      supported: true,
    });
    await expect(browserEsp32Capability({
      ...request(),
      files: [{ name: 'main.ino', content: 'x'.repeat(2 * 1024 * 1024) }],
    })).resolves.toMatchObject({ supported: true });
  });

  it('accepts only the exact root partitions.csv project file', async () => {
    const { browserEsp32Capability } = await import('../public/browser-esp32.js');
    const partitionCsv = 'nvs,data,nvs,0x9000,0x5000,\napp,app,ota_0,0x10000,0x100000,\n';

    await expect(browserEsp32Capability({
      ...request(),
      files: [...request().files, { name: 'partitions.csv', content: partitionCsv }],
    })).resolves.toMatchObject({
      supported: true,
      profile: { board: 'esp32:esp32:esp32c3' },
    });
    expect(fetch).toHaveBeenCalledWith(c3DescriptorUrl, { cache: 'no-cache' });
  });

  it.each([
    'other.csv',
    'config/partitions.csv',
    'Partitions.csv',
    '../partitions.csv',
    './partitions.csv',
    'partitions.csv\\nested.cpp',
  ])('rejects non-exact custom partition path %s before loading assets', async (name) => {
    const { browserEsp32Capability } = await import('../public/browser-esp32.js');

    await expect(browserEsp32Capability({
      ...request(),
      files: [...request().files, { name, content: 'nvs,data,nvs,0x9000,0x5000,\n' }],
    })).resolves.toMatchObject({ supported: false, reason: 'request' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes every validated project file to the pinned Worker', async () => {
    const worker = installC3Worker({
      status: 'success',
      artifacts: [{ name: 'firmware.bin', offset: '0x10000', bytes: Uint8Array.of(1) }],
      staticArtifacts: [
        { name: 'bootloader.bin', offset: '0x1000', bytes: Uint8Array.of(2) },
        { name: 'partitions.bin', offset: '0x8000', bytes: Uint8Array.of(3) },
        { name: 'boot_app0.bin', offset: '0xe000', bytes: Uint8Array.of(4) },
      ],
      diagnostics: [],
      timings: { total: 12 },
    });
    const { compileEsp32InBrowser } = await import('../public/browser-esp32.js');
    const compileRequest = multiFileRequest('esp32:esp32:esp32');

    await expect(compileEsp32InBrowser(compileRequest)).resolves.toMatchObject({
      handled: true,
      result: { status: 'success', execution: 'browser' },
    });
    const actionInputs = new Set(worker.messages()
      .filter((message) => message.type === 'action')
      .flatMap((message) => message.inputs.map((input: { path: string }) => input.path)));
    expect(actionInputs).toEqual(new Set(compileRequest.files.map((file) => file.name)));
    expect(worker.messages().some((message) => message.type === 'compile')).toBe(false);
  });

  it('routes ESP32 requests without touching the AVR capability manifest', async () => {
    const worker = installC3Worker({
      status: 'success',
      artifacts: [{ name: 'firmware.bin', offset: '0x10000', bytes: Uint8Array.of(1, 2, 3) }],
      staticArtifacts: [
        { name: 'bootloader.bin', offset: '0x0', bytes: Uint8Array.of(4) },
        { name: 'partitions.bin', offset: '0x8000', bytes: Uint8Array.of(5) },
        { name: 'boot_app0.bin', offset: '0xe000', bytes: Uint8Array.of(6) },
      ],
      diagnostics: [],
      timings: { total: 12 },
    });
    const { compileInBrowser } = await import('../public/browser-compiler.js');

    await expect(compileInBrowser(request('esp32:esp32:esp32c6'))).resolves.toMatchObject({
      handled: true,
      result: { status: 'success', execution: 'browser' },
    });
    expect(worker.workerUrl()?.pathname.replaceAll('\\', '/')).toMatch(/\/esp32\/v2\/c6-worker\.js$/);
    const init = worker.messages().find((message) => message.type === 'init');
    expect(init).toMatchObject({
      runtime: { descriptor: { id: 'esp32-c6-arduino', board: 'esp32:esp32:esp32c6' } },
    });
    const calls = vi.mocked(fetch).mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(calls).toEqual([
      capabilityUrl.pathname,
      c6DescriptorUrl.pathname,
      platformRegistryUrl.pathname,
      expect.stringContaining('/platform-manifests/espressif-arduino/'),
    ]);
    expect(calls.some((path) => path.includes('/avr/'))).toBe(false);
  });

  it('forwards a pre-cancelled route without loading either browser runtime', async () => {
    const controller = new AbortController();
    controller.abort();
    const { compileInBrowser } = await import('../public/browser-compiler.js');

    await expect(compileInBrowser(request(), undefined, {
      signal: controller.signal,
    })).resolves.toMatchObject({
      handled: true,
      result: { status: 'error', reason: 'cancelled', execution: 'browser' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects legacy C3 descriptor fields when the per-board release pin is missing', async () => {
    const fixture = await enabledC3Fixture({ descriptorPin: false, legacyDescriptorPin: true });
    const { browserEsp32Capability } = await loadEnabledC3Route(fixture);

    await expect(browserEsp32Capability(request())).resolves.toMatchObject({
      supported: false,
      reason: 'runtime_unpinned',
    });
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it('runs only the pinned C3 Worker and adapts its flash fragments to app artifacts', async () => {
    const fixture = await enabledC3Fixture();
    const worker = installC3Worker({
      status: 'success',
      artifacts: [{ name: 'firmware.bin', offset: '0x10000', bytes: Uint8Array.of(1, 2, 3) }],
      staticArtifacts: [
        { name: 'bootloader.bin', offset: '0x0', bytes: Uint8Array.of(4) },
        { name: 'partitions.bin', offset: '0x8000', bytes: Uint8Array.of(5) },
        { name: 'boot_app0.bin', offset: '0xe000', bytes: Uint8Array.of(6) },
      ],
      diagnostics: [],
      timings: { total: 12 },
      memory: { flashUsed: 3, flashTotal: 10, ramUsed: 1, ramTotal: 10 },
    });
    const { compileEsp32InBrowser } = await loadEnabledC3Route(fixture);
    const progress = vi.fn();

    await expect(compileEsp32InBrowser(request(), progress)).resolves.toMatchObject({
      handled: true,
      result: {
        status: 'success',
        execution: 'browser',
        cached: false,
        artifacts: [{ name: 'firmware.bin', offset: '0x10000', size: 3, base64: 'AQID' }],
        staticArtifacts: [
          { name: 'bootloader.bin', offset: '0x0', size: 1, base64: 'BA==' },
          { name: 'partitions.bin', offset: '0x8000', size: 1, base64: 'BQ==' },
          { name: 'boot_app0.bin', offset: '0xe000', size: 1, base64: 'Bg==' },
        ],
      },
    });
    expect(worker.workerUrl()?.pathname.replaceAll('\\', '/')).toMatch(/\/esp32\/v2\/c3-worker\.js$/);
    expect(worker.workerOptions()).toEqual({ type: 'module' });
    expect(worker.messages().find((message) => message.type === 'init')).toMatchObject({
      runtime: { descriptor: fixture.descriptor, descriptorUrl: c3DescriptorUrl.href },
    });
    expect(worker.messages().some((message) => message.type === 'compile')).toBe(false);
    expect(progress).toHaveBeenCalledWith({ stage: 'assets', percent: 10 });
    expect(fixture.fetch.mock.calls.map(([input]) => new URL(String(input)).href)).toEqual([
      capabilityUrl.href,
      c3DescriptorUrl.href,
      platformRegistryUrl.href,
      expect.stringContaining('/platform-manifests/espressif-arduino/'),
    ]);
  });

  it('keeps a validated C3 compiler error handled instead of recompiling on the server', async () => {
    const fixture = await enabledC3Fixture();
    installC3Worker({
      status: 'error',
      reason: 'compile_error',
      message: 'use of undeclared identifier',
      diagnostics: [{
        severity: 'error', file: 'main.ino', line: 2, column: 3,
        message: 'use of undeclared identifier',
      }],
      timings: { compile: 8, total: 12 },
    });
    const { compileEsp32InBrowser } = await loadEnabledC3Route(fixture);

    await expect(compileEsp32InBrowser(request())).resolves.toEqual(expect.objectContaining({
      handled: true,
      result: expect.objectContaining({
        status: 'error',
        reason: 'compile_error',
        execution: 'browser',
        cached: false,
        diagnostics: [expect.objectContaining({ file: 'main.ino', line: 2, column: 3 })],
      }),
    }));
  });

  it('falls back to the server when the Worker reports a missing header', async () => {
    const fixture = await enabledC3Fixture();
    installC3Worker({
      status: 'error',
      reason: 'compile_error',
      message: "'NestedDependency.h' file not found",
      diagnostics: [{
        severity: 'error', file: 'main.ino', line: 1, column: 1,
        message: "'NestedDependency.h' file not found",
      }],
      timings: { compile: 8, total: 12 },
    });
    const { compileEsp32InBrowser } = await loadEnabledC3Route(fixture);

    await expect(compileEsp32InBrowser(request())).resolves.toEqual({
      handled: false,
      reason: 'libraries',
    });
  });

  it('falls back to the server when the browser Worker times out', async () => {
    const fixture = await enabledC3Fixture();
    installC3Worker({}, { code: 'timeout', message: 'browser compile timed out' });
    const { compileEsp32InBrowser } = await loadEnabledC3Route(fixture);

    await expect(compileEsp32InBrowser(request())).resolves.toMatchObject({
      handled: false,
      reason: 'assets',
    });
  });

  it.each([
    { board: 'esp32:esp32:esp32c5' },
    { board: 'esp32:esp32:esp32h2' },
    { board: 'esp32:esp32:esp32p4' },
  ])('rejects unpublished $board before loading browser assets', async ({ board }) => {
    const fixture = await enabledC3Fixture();
    const { browserEsp32Capability } = await loadEnabledC3Route(fixture);

    await expect(browserEsp32Capability(request(board))).resolves.toEqual({
      supported: false,
      reason: 'board',
    });
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
});
