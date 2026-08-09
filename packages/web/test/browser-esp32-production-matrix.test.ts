import { createHash, webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { lowerEsp32PostLinkTransforms } from '../../core/src/build-ir/platform-planning.js';
import { resolvePlatformManifest } from '../../core/src/platform-pack/builder.js';
import { deriveEsp32PostLinkContract } from '../../core/src/platform-pack/recipe-command-lowering.js';
import type { CKEsp32PostLinkBindings } from '../../core/src/platform-pack/recipe-command-lowering.js';
import { ESP32_BROWSER_BOARD_PROFILES } from '../public/browser-esp32.js';
import {
  browserToolchainPackRevisionInput,
  createBrowserToolchainPackLoader,
  validateBrowserToolchainPackManifest,
} from '../public/avr/v3/toolchain-pack.js';
import { ESP32_BROWSER_RELEASE } from '../public/esp32/v1/release.js';
import {
  createEsp32C3WorkerLauncher,
  createEsp32C6WorkerLauncher,
  createEsp32S2WorkerLauncher,
  createEsp32S3WorkerLauncher,
  createEsp32WorkerLauncher,
} from '../public/esp32/v1/c3-runtime.js';
import { parseArgs } from '../../../scripts/verify-browser-esp32c3-worker.mjs';

const PUBLIC_ROOT = new URL('../public/', import.meta.url);

const targets = [
  {
    key: 'esp32',
    fqbn: 'esp32:esp32:esp32',
    runtime: 'esp32-xtensa',
    runtimeId: 'esp32-arduino',
    descriptorPath: 'esp32/v5/xtensa/esp32.json',
    workerPath: 'esp32/v2/esp32-worker.js',
    bootloaderOffset: '0x1000',
    legacySdkRevision: 'ee8f1d670ca441ce8e4a2c1ef978816c9a253b28195e6c84567a55659c3cc947',
    intermediateSdkRevision: 'de18255dfec47192e748d6cbe94e6479de876360d069c2b50986b6170e5e9da1',
    legacyBoardRevision: '0422c3cf65951d360f56bce369556e683569b4114c71ac6c2d99cca12e70d031',
  },
  {
    key: 'esp32s2',
    fqbn: 'esp32:esp32:esp32s2',
    runtime: 'esp32-xtensa',
    runtimeId: 'esp32-s2-arduino',
    descriptorPath: 'esp32/v5/xtensa/esp32s2.json',
    workerPath: 'esp32/v2/s2-worker.js',
    bootloaderOffset: '0x1000',
    legacySdkRevision: '3940fbb1682e5f8640c08bd50b486b4e7e580048f293ff46b2f0550b28d4ffc0',
    intermediateSdkRevision: '9924611c4e3670c4b55e1801587c4655e5a67b115b53a37eabf0d5dfbe36cac0',
    legacyBoardRevision: '9c7b3c78c0f55e12f2490dde63fba1b7e1f64d11a5849e8484af43c66084ac23',
  },
  {
    key: 'esp32s3',
    fqbn: 'esp32:esp32:esp32s3',
    runtime: 'esp32-xtensa',
    runtimeId: 'esp32-s3-arduino',
    descriptorPath: 'esp32/v5/xtensa/esp32s3.json',
    workerPath: 'esp32/v2/s3-worker.js',
    bootloaderOffset: '0x0',
    legacySdkRevision: '206d951eaad9f7e8ebf766494d9f0c8a958fcc1a676365031e671d7d5fa20d8b',
    intermediateSdkRevision: '9d8840e5bff63b77780c2f6a020d8ce24aeb6704e3930b2145e034b32fa84b9c',
    legacyBoardRevision: 'a3efc8e75ae50f881458fc07e64238e3818a74c9836a41debb7827929bdc9a7f',
  },
  {
    key: 'esp32c3',
    fqbn: 'esp32:esp32:esp32c3',
    runtime: 'esp32-riscv',
    runtimeId: 'esp32-c3-arduino',
    descriptorPath: 'esp32/v2/runtime/runtime.json',
    workerPath: 'esp32/v2/c3-worker.js',
    bootloaderOffset: '0x0',
    legacySdkRevision: '03d8a8a77f8aae1384beefcfbc1a85dc3d163d83267edb43283e20dec65db8a1',
    intermediateSdkRevision: 'e66e9cf83c5e4ac6ccc7c36a8783be62f04edf9bc37d5bea0c0cc3592fed06e5',
    legacyBoardRevision: '010cf4e5ecf12fd5599d25499647238d78bb3fa180eeaa749af3f9046cf8e1ca',
  },
  {
    key: 'esp32c6',
    fqbn: 'esp32:esp32:esp32c6',
    runtime: 'esp32-riscv',
    runtimeId: 'esp32-c6-arduino',
    descriptorPath: 'esp32/v2/runtime-c6/runtime.json',
    workerPath: 'esp32/v2/c6-worker.js',
    bootloaderOffset: '0x0',
    legacySdkRevision: '4bfc047d3f4ffa058ef623320c747ff9d37ef154c2d31262dd7607d3fbc7ed56',
    intermediateSdkRevision: '151c7a12c08e60a79379fa81f632ec59fd107dc49614dceb33e03e86e63fcea5',
    legacyBoardRevision: 'a7933f722c19e88aff51da998a15917161209963c4caff421b5f92506738b5b6',
  },
] as const;

const unpublishedTargets = [
  'esp32:esp32:esp32c5',
  'esp32:esp32:esp32h2',
  'esp32:esp32:esp32p4',
] as const;

function bytes(path: string): Buffer {
  return readFileSync(fileURLToPath(new URL(path, PUBLIC_ROOT)));
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function postLinkBindings(
  boardPack: Readonly<{ id: string; revision: string }>,
  boardManifest: Readonly<{
    schema: number;
    artifacts: readonly Readonly<{ id: string; sha256: string }>[];
  }>,
): CKEsp32PostLinkBindings {
  const immutable = (artifactId: string, path: string, role: string) => {
    const artifact = boardManifest.artifacts.find(({ id }) => id === artifactId);
    if (!artifact) throw new Error(`missing Board Pack artifact: ${artifactId}`);
    return {
      kind: 'immutable' as const,
      path,
      role,
      sha256: artifact.sha256,
      provenance: {
        kind: 'pack-artifact' as const,
        packId: boardPack.id,
        packSha256: boardPack.revision,
        packSchema: boardManifest.schema,
        artifactId,
      },
    };
  };
  return {
    application: {
      kind: 'action-output',
      actionId: 'link-firmware',
      path: 'build/firmware.elf',
      role: 'linked-elf',
    },
    bootloader: {
      source: 'immutable-bin',
      input: immutable('bootloader', 'packs/board/bootloader.bin', 'bootloader-source'),
    },
    partitions: {
      source: 'immutable-bin',
      input: immutable('partitions', 'packs/board/partitions.bin', 'partitions-source'),
    },
    bootApp0: immutable('boot-app0', 'packs/board/boot_app0.bin', 'boot-app0-source'),
  };
}

describe('ESP32 browser production smoke matrix', () => {
  it('matches the eight UI boards to the five fully published browser routes', () => {
    const registry = JSON.parse(bytes('esp32/v1/platform-manifests/registry.json').toString('utf8'));
    const publishedBoards = new Set(targets.map(({ fqbn }) => fqbn));
    const registeredBoards = new Set(
      registry.entries.map(({ fqbn }: { fqbn: string }) => fqbn),
    );
    const pinnedBoards = new Set(Object.values(ESP32_BROWSER_RELEASE.runtimes).flatMap((runtime) => (
      Object.keys(runtime.descriptors ?? {})
    )));

    expect(new Set(Object.keys(ESP32_BROWSER_BOARD_PROFILES))).toEqual(publishedBoards);
    for (const board of publishedBoards) {
      expect(pinnedBoards.has(board)).toBe(true);
      expect(registeredBoards.has(board)).toBe(true);
    }
    for (const board of unpublishedTargets) {
      expect(ESP32_BROWSER_BOARD_PROFILES).not.toHaveProperty(board);
      expect(pinnedBoards.has(board)).toBe(false);
      expect(registeredBoards.has(board)).toBe(false);
    }
  });

  it('keeps every v2 Worker on the Action-only toolchain contract', () => {
    for (const key of ['esp32', 's2', 's3', 'c3', 'c6', 'c5', 'h2', 'p4']) {
      const source = bytes(`esp32/v2/${key}-worker.js`).toString('utf8');
      expect(source).toContain('V2WorkerActionMessageHandler');
      expect(source).toContain('loadToolchain:');
      expect(source).toContain("scope.addEventListener('message', actionHandler)");
      expect(source).not.toContain('V2_COMPILER');
      expect(source).not.toContain('loadRunClang');
      expect(source).not.toMatch(/V2WorkerMessageHandler\b/);
    }
  });

  it('keeps unpublished C5, H2, and P4 Worker entries Action-only', () => {
    for (const key of ['c5', 'h2', 'p4']) {
      const source = bytes(`esp32/v2/${key}-worker.js`).toString('utf8');
      const actionFactory = `createEsp32${key.toUpperCase()}V2WorkerActionMessageHandler`;
      expect(source).toContain(actionFactory);
      expect(source).toContain(`const actionHandler = ${actionFactory}`);
      expect(source).not.toContain(`scope.addEventListener('message', createEsp32${key.toUpperCase()}V2WorkerMessageHandler`);
    }
  });

  it('shares one content-addressed RISC-V compiler Pack between C3 and C6', () => {
    const c3Target = targets.find(({ key }) => key === 'esp32c3')!;
    const c6Target = targets.find(({ key }) => key === 'esp32c6')!;
    const c3Descriptor = JSON.parse(bytes(c3Target.descriptorPath).toString('utf8'));
    const c6Descriptor = JSON.parse(bytes(c6Target.descriptorPath).toString('utf8'));
    const c3Compiler = c3Descriptor.packs.find(({ role }: { role: string }) => role === 'compiler');
    const c6Compiler = c6Descriptor.packs.find(({ role }: { role: string }) => role === 'compiler');
    expect(c3Compiler).toEqual(c6Compiler);
    expect(c3Compiler.manifest).toBe(
      `../toolchains/${c3Compiler.id}/${c3Compiler.revision}/toolchain.json`,
    );

    const c3DescriptorUrl = new URL(c3Target.descriptorPath, PUBLIC_ROOT);
    const c6DescriptorUrl = new URL(c6Target.descriptorPath, PUBLIC_ROOT);
    const c3CompilerUrl = new URL(c3Compiler.manifest, c3DescriptorUrl);
    const c6CompilerUrl = new URL(c6Compiler.manifest, c6DescriptorUrl);
    expect(c6CompilerUrl.href).toBe(c3CompilerUrl.href);
    expect(JSON.parse(readFileSync(fileURLToPath(c3CompilerUrl), 'utf8'))).toMatchObject({
      id: c3Compiler.id,
      revision: c3Compiler.revision,
    });
    expect(existsSync(fileURLToPath(new URL('packs/compiler/toolchain.json', c3DescriptorUrl)))).toBe(false);
    expect(existsSync(fileURLToPath(new URL('packs/compiler/toolchain.json', c6DescriptorUrl)))).toBe(false);

    const c3Report = JSON.parse(bytes('esp32/v2/runtime/release-report.json').toString('utf8'));
    const c6Report = JSON.parse(bytes('esp32/v2/runtime-c6/release-report.json').toString('utf8'));
    expect(c3Report.packs.compiler).toMatchObject({ shared: true, downloadBytes: 29_210_723 });
    expect(c6Report.packs.compiler).toMatchObject({ shared: true, downloadBytes: 29_210_723 });
  });

  it.each(targets)('keeps release, descriptor, Worker, and smoke config aligned for $key', (target) => {
    const profile = ESP32_BROWSER_BOARD_PROFILES[target.fqbn];
    expect(profile).toMatchObject({ board: target.fqbn, runtime: target.runtime, imageBuilder: true });

    const releaseRuntime = ESP32_BROWSER_RELEASE.runtimes[target.runtime];
    expect(releaseRuntime).toMatchObject({ enabled: true });
    const releaseDescriptor = releaseRuntime.descriptors?.[target.fqbn];
    const pinnedPath = releaseDescriptor?.path?.replace(/^\.\//, '');
    const pinnedSha256 = releaseDescriptor?.sha256;
    expect(pinnedPath).toBe(target.descriptorPath);

    const descriptorBytes = bytes(target.descriptorPath);
    expect(sha256(descriptorBytes)).toBe(pinnedSha256);
    const descriptor = JSON.parse(descriptorBytes.toString('utf8'));
    expect(descriptor).toMatchObject({
      schema: 2,
      abi: 1,
      id: target.runtimeId,
      board: target.fqbn,
    });
    expect(descriptor.packs.map((pack: { role: string }) => pack.role))
      .toEqual(['compiler', 'sdk', 'board']);
    const compilerPack = descriptor.packs.find((pack: { role: string }) => pack.role === 'compiler');
    expect(releaseRuntime).toMatchObject({
      toolchainId: compilerPack.id,
      revision: compilerPack.revision,
    });

    const workerSource = bytes(target.workerPath).toString('utf8');
    expect(workerSource.length).toBeGreaterThan(0);
    if (target.runtime === 'esp32-xtensa') {
      expect(workerSource.match(/\.\.\/v5\/xtensa\/clang\/bundle\.js/g)).toHaveLength(1);
      expect(workerSource).not.toContain('../v3/xtensa/clang/bundle.js');
    }
    const smoke = parseArgs(['--board', target.key, '--production-route'], { cwd: 'C:/workspace' });
    expect(smoke).toMatchObject({
      productionRoute: true,
      target: {
        fqbn: target.fqbn,
        runtimeId: target.runtimeId,
        bootloaderOffset: target.bootloaderOffset,
      },
    });
  });

  it('derives and lowers the published five-board post-link matrix', async () => {
    const registry = JSON.parse(bytes('esp32/v1/platform-manifests/registry.json').toString('utf8'));
    const bootloaderOffsets: Record<string, string | undefined> = {};

    for (const target of targets) {
      const registryEntry = registry.entries.find(
        ({ fqbn }: { fqbn: string }) => fqbn === target.fqbn,
      );
      expect(registryEntry).toMatchObject({
        id: 'espressif-arduino',
        fqbn: target.fqbn,
        version: '3.3.7',
      });
      expect(registryEntry.path).toBe(
        `espressif-arduino/${registryEntry.sha256}/manifest.json`,
      );
      const manifestBytes = bytes(`esp32/v1/platform-manifests/${registryEntry.path}`);
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      expect(manifest.sha256).toBe(registryEntry.sha256);
      const resolved = resolvePlatformManifest({ manifest, fqbn: target.fqbn });

      const descriptorUrl = new URL(target.descriptorPath, PUBLIC_ROOT);
      const descriptor = JSON.parse(readFileSync(fileURLToPath(descriptorUrl), 'utf8'));
      const sdkPack = descriptor.packs.find(({ role }: { role: string }) => role === 'sdk');
      const boardPack = descriptor.packs.find(({ role }: { role: string }) => role === 'board');
      expect(sdkPack).toBeDefined();
      expect(boardPack).toBeDefined();
      expect(registryEntry.sdkPack).toEqual({ id: sdkPack.id, revision: sdkPack.revision });

      const sdkManifestUrl = new URL(sdkPack.manifest, descriptorUrl);
      const sdkManifest = JSON.parse(readFileSync(fileURLToPath(sdkManifestUrl), 'utf8'));
      expect(sdkManifest).toMatchObject({
        schema: 2,
        id: sdkPack.id,
        revision: sdkPack.revision,
      });
      const sdkArtifactIds = sdkManifest.artifacts.map(({ id }: { id: string }) => id);
      expect(sdkArtifactIds).toEqual([
        'compile-000', 'compile-asm-flags', 'link-000', 'link-001',
        'platform-manifest', 'profile-v5',
      ]);
      expect(sdkArtifactIds).not.toContain('profile');

      const normalizedSdkManifest = validateBrowserToolchainPackManifest(sdkManifest);
      expect(sha256(Buffer.from(browserToolchainPackRevisionInput(normalizedSdkManifest), 'utf8')))
        .toBe(sdkPack.revision);

      const intermediateSdkManifestUrl = new URL(
        sdkPack.manifest.replace(sdkPack.revision, target.intermediateSdkRevision),
        descriptorUrl,
      );
      expect(existsSync(fileURLToPath(intermediateSdkManifestUrl))).toBe(true);
      const intermediateSdkManifest = JSON.parse(
        readFileSync(fileURLToPath(intermediateSdkManifestUrl), 'utf8'),
      );
      expect(intermediateSdkManifest.artifacts.map(({ id }: { id: string }) => id))
        .not.toContain('profile');
      for (const artifact of sdkManifest.artifacts) {
        expect(artifact).toEqual(
          intermediateSdkManifest.artifacts.find(({ id }: { id: string }) => id === artifact.id),
        );
      }

      const legacySdkManifestUrl = new URL(
        sdkPack.manifest.replace(sdkPack.revision, target.legacySdkRevision),
        descriptorUrl,
      );
      expect(existsSync(fileURLToPath(legacySdkManifestUrl))).toBe(true);
      const legacySdkManifest = JSON.parse(readFileSync(fileURLToPath(legacySdkManifestUrl), 'utf8'));
      expect(legacySdkManifest.artifacts.map(({ id }: { id: string }) => id)).toContain('profile');
      for (const artifact of sdkManifest.artifacts) {
        expect(artifact).toEqual(
          legacySdkManifest.artifacts.find(({ id }: { id: string }) => id === artifact.id),
        );
      }

      const sdkLoader = createBrowserToolchainPackLoader({
        manifestUrl: sdkManifestUrl,
        expectedId: sdkPack.id,
        expectedRevision: sdkPack.revision,
        cryptoRef: webcrypto,
        fetchFn: async (url: URL) => {
          expect(url.href).toBe(sdkManifestUrl.href);
          return new Response(JSON.stringify(sdkManifest));
        },
      });
      expect(await sdkLoader.loadManifest()).toMatchObject({ revision: sdkPack.revision });

      const boardManifestUrl = new URL(boardPack.manifest, descriptorUrl);
      const boardManifest = JSON.parse(readFileSync(fileURLToPath(boardManifestUrl), 'utf8'));
      expect(boardManifest).toMatchObject({
        schema: 2,
        id: boardPack.id,
        revision: boardPack.revision,
      });
      const boardArtifactIds = boardManifest.artifacts.map(({ id }: { id: string }) => id);
      expect(boardArtifactIds).toEqual([
        'boot-app0', 'bootloader', 'partitions', 'profile-v4',
        ...(target.key === 'esp32s3' ? ['srmodels'] : []),
        'variant-000',
      ]);
      expect(boardArtifactIds).not.toContain('profile');

      const legacyManifestUrl = new URL(
        boardPack.manifest.replace(boardPack.revision, target.legacyBoardRevision),
        descriptorUrl,
      );
      expect(existsSync(fileURLToPath(legacyManifestUrl))).toBe(true);
      const legacyManifest = JSON.parse(readFileSync(fileURLToPath(legacyManifestUrl), 'utf8'));
      expect(legacyManifest.artifacts.map(({ id }: { id: string }) => id)).toContain('profile');
      for (const artifact of boardManifest.artifacts) {
        if (target.key === 'esp32s3' && ['profile-v4', 'srmodels'].includes(artifact.id)) continue;
        expect(artifact).toEqual(
          legacyManifest.artifacts.find(({ id }: { id: string }) => id === artifact.id),
        );
      }
      if (target.key === 'esp32s3') {
        expect(legacyManifest.artifacts.map(({ id }: { id: string }) => id)).not.toContain('srmodels');
        expect(boardManifest.artifacts.find(({ id }: { id: string }) => id === 'profile-v4'))
          .not.toEqual(legacyManifest.artifacts.find(({ id }: { id: string }) => id === 'profile-v4'));
      }

      const loader = createBrowserToolchainPackLoader({
        manifestUrl: boardManifestUrl,
        expectedId: boardPack.id,
        expectedRevision: boardPack.revision,
        cryptoRef: webcrypto,
        fetchFn: async (url: URL) => {
          expect(url.href).toBe(boardManifestUrl.href);
          return new Response(JSON.stringify(boardManifest));
        },
      });
      expect(await loader.loadManifest()).toMatchObject({ revision: boardPack.revision });

      const boardPackRevisionInput = browserToolchainPackRevisionInput(boardManifest);
      expect(sha256(Buffer.from(boardPackRevisionInput, 'utf8'))).toBe(boardPack.revision);

      const contract = deriveEsp32PostLinkContract({
        manifest,
        resolved,
        boardPack: { id: boardPack.id, sha256: boardPack.revision },
        boardPackRevisionInput,
        bindings: postLinkBindings(boardPack, boardManifest),
      });
      const transforms = lowerEsp32PostLinkTransforms(contract, {
        elf2image: 'ck:esp32-image',
        partitionBin: 'ck:esp32-partition',
        materialize: 'ck:pack-copy',
        mergeBin: 'ck:esp32-merge',
      });

      expect(contract.source).toMatchObject({
        platformManifestSha256: registryEntry.sha256,
        fqbn: target.fqbn,
        boardPackId: boardPack.id,
        boardPackSha256: boardPack.revision,
      });
      expect(contract.products.map(({ productId }) => productId)).toEqual([
        'application', 'bootloader', 'partitions', 'boot-app0', 'merged',
      ]);
      const offsets = Object.fromEntries(
        contract.products.map(({ productId, offset }) => [productId, offset]),
      );
      expect(offsets).toMatchObject({
        application: '0x10000',
        bootloader: target.bootloaderOffset,
        partitions: '0x8000',
        'boot-app0': '0xe000',
      });
      bootloaderOffsets[target.key] = offsets.bootloader;

      const merged = transforms.find(({ productId }) => productId === 'merged');
      expect(merged).toMatchObject({
        id: 'transform-merged',
        output: 'build/firmware.merged.bin',
        dependencies: [
          'transform-application', 'transform-boot-app0',
          'transform-bootloader', 'transform-partitions',
        ],
      });
      expect(merged?.inputs?.map(({ path }) => path)).toEqual([
        'build/bootloader.bin',
        'build/partitions.bin',
        'build/boot_app0.bin',
        'build/firmware.bin',
      ]);
      expect(transforms.every(({ flags }) => (
        flags?.includes(`--ck-post-link-contract=${contract.sha256}`)
      ))).toBe(true);
    }

    expect(bootloaderOffsets).toEqual({
      esp32: '0x1000',
      esp32s2: '0x1000',
      esp32s3: '0x0',
      esp32c3: '0x0',
      esp32c6: '0x0',
    });
  });

  it('routes every production board through one persistent Action session', async () => {
    const launchers = new Map([
      ['esp32', createEsp32WorkerLauncher],
      ['esp32s2', createEsp32S2WorkerLauncher],
      ['esp32s3', createEsp32S3WorkerLauncher],
      ['esp32c3', createEsp32C3WorkerLauncher],
      ['esp32c6', createEsp32C6WorkerLauncher],
    ] as const);
    const action = {
      id: 'matrix-action',
      kind: 'transform',
      tool: 'ck:pack-copy',
      inputs: [{ path: 'project/main.cpp' }],
      outputs: [{ path: 'build/result.bin', kind: 'other' }],
      arguments: [],
      environment: {},
      dependencies: [],
      packDependencies: [],
      cacheKey: 'f'.repeat(64),
      transform: {
        input: 'project/main.cpp',
        output: 'build/result.bin',
        format: 'other',
        flags: [],
      },
    };

    for (const target of targets) {
      const posted: Array<{ type: string; action?: typeof action }> = [];
      let workerUrl = '';
      class WorkerHarness {
        private listeners = new Map<string, (event: { data: unknown }) => void>();
        constructor(url: URL) { workerUrl = url.pathname.replaceAll('\\', '/'); }
        addEventListener(type: string, callback: (event: { data: unknown }) => void) { this.listeners.set(type, callback); }
        postMessage(message: any) {
          posted.push(message);
          if (message.type === 'init') {
            queueMicrotask(() => this.listeners.get('message')?.({ data: { abi: 1, type: 'init-result', id: message.id, ok: true } }));
          } else if (message.type === 'action') {
            const output = message.action.outputs[0];
            queueMicrotask(() => this.listeners.get('message')?.({ data: {
              abi: 1,
              type: 'action-result',
              id: message.id,
              ok: true,
              result: { outputs: [{ path: output.path, bytes: Uint8Array.of(0x42) }], diagnostics: [] },
            } }));
          } else if (message.type === 'close') {
            queueMicrotask(() => this.listeners.get('message')?.({ data: { abi: 1, type: 'close-result', id: message.id, ok: true } }));
          }
        }
        terminate() {}
      }

      const descriptor = JSON.parse(bytes(target.descriptorPath).toString('utf8'));
      const launcher = launchers.get(target.key)!({
        enabled: true,
        WorkerClass: WorkerHarness as never,
        navigatorRef: { deviceMemory: 8 },
        performanceRef: {},
      });
      const session = await launcher.openActionSession({
        descriptor,
        descriptorUrl: `https://cdn.example.test/esp32/${target.key}/runtime.json`,
      });
      await expect(session.runAction(action, {
        inputs: [{ path: 'project/main.cpp', bytes: Uint8Array.of(1, 2, 3) }],
      })).resolves.toMatchObject({ outputs: [{ path: 'build/result.bin' }] });
      await session.close();

      expect(workerUrl).toMatch(new RegExp(`/public/esp32/v2/${target.workerPath.split('/').at(-1)}$`));
      expect(posted.map(({ type }) => type)).toEqual(['init', 'action', 'close']);
      expect(posted.some(({ type }) => type === 'compile')).toBe(false);
    }
  });
});
