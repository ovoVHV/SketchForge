import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BoardRegistry,
  CompileService,
  LocalExecutor,
  createPlatformManifest,
  resolvePlatformManifestWithRust,
  type BoardPackRef,
  type BoardDefinition,
  type CKPlatformManifest,
  type PlatformPackRef,
  type ResolvedPlatformManifest,
  type ToolchainConfig,
} from '../src/index.js';
import { resolvePlatformManifest } from '../src/platform-pack/builder.js';

const roots: string[] = [];
const board: BoardDefinition = {
  fqbn: 'esp32:esp32:esp32c3',
  name: 'ESP32-C3 test',
  arch: 'esp32',
  pins: [],
  options: [
    {
      id: 'debug_level', label: 'Core Debug Level', default: 'none',
      values: [{ value: 'none', label: 'None' }, { value: 'verbose', label: 'Verbose' }],
    },
    {
      id: 'upload_speed', label: 'Upload Speed', default: '921600', affectsBuild: false,
      values: [{ value: '921600', label: '921600' }, { value: '115200', label: '115200' }],
    },
    {
      id: 'erase_flash', label: 'Erase Flash', default: 'disabled', affectsBuild: false,
      values: [{ value: 'disabled', label: 'Disabled' }, { value: 'enabled', label: 'Enabled' }],
    },
  ],
  flashTotal: 1_310_720,
  ramTotal: 327_680,
  upload: { protocol: 'esp32' },
  build: {
    mcu: 'esp32c3',
    tarch: 'riscv32',
    target: 'esp',
    fCpu: '160000000L',
    variant: 'esp32c3',
    boardDefine: 'ESP32C3_DEV',
    defines: [],
  },
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CompileService standardized Platform Manifest', () => {
  it('uses the Manifest identity in Platform and Board Pack hashes', async () => {
    const firstManifest = makeManifest('name=Arduino ESP32');
    const secondManifest = makeManifest('name=Arduino ESP32\ncompiler.warning_flags=-Wall');
    const first = await resolvePacks(makeService(firstManifest));
    const second = await resolvePacks(makeService(secondManifest));

    expect(first.platform).toMatchObject({
      id: 'platform:espressif-arduino',
      version: '3.3.7',
      platform: 'espressif-arduino',
    });
    expect(first.platform.sha256).not.toBe(second.platform.sha256);
    expect(first.board.sha256).not.toBe(second.board.sha256);
  });

  it('derives the Board Pack identity from the standardized board subtree', async () => {
    const manifest = makeManifest('name=Arduino ESP32');
    const legacyMappingChanged: BoardDefinition = {
      ...board,
      build: {
        ...board.build,
        mcu: 'legacy-mapping-changed',
        fCpu: '80000000L',
        boardDefine: 'LEGACY_MAPPING_CHANGED',
        defines: ['LEGACY_DEFINE=1'],
        extraFlags: ['-flegacy-flag'],
        optionEffects: {
          legacy: {
            enabled: { defines: ['LEGACY_OPTION_EFFECT=1'] },
          },
        },
      },
    };
    const first = await resolvePacks(makeService(manifest));
    const second = await resolvePacks(makeService(manifest, [legacyMappingChanged]), legacyMappingChanged);

    expect(first.board).toMatchObject({
      id: `board:${board.fqbn}`,
      version: '3.3.7',
      fqbn: board.fqbn,
      variant: 'esp32c3',
    });
    expect(second.board.sha256).toBe(first.board.sha256);
    expect(second.build).toMatchObject({
      mcu: 'esp32c3', fCpu: '160000000L', tarch: 'riscv32', target: 'esp', boardDefine: 'ESP32C3_DEV',
    });
    expect(second.build.defines).toEqual([
      'ESP32=ESP32',
      'CORE_DEBUG_LEVEL=5',
      'ARDUINO_USB_MODE=1',
      'ARDUINO_USB_CDC_ON_BOOT=0',
    ]);
    expect(second.build.extraFlags).toEqual(['-fno-exceptions']);
    expect(second.build.optionEffects).toEqual({});
  });

  it('rejects a missing ESP32 manifest and lets the Manifest select the variant', async () => {
    await expect(makeService().planActionGraph(request()))
      .rejects.toThrow(/required Platform Manifest is missing/);
    await expect(resolvePacks(makeService(
      makeManifest('name=Arduino ESP32', 'esp32c3', 'build.bootloader_addr'),
    ))).rejects.toThrow(/required Platform Manifest property.*build\.bootloader_addr/);
    const changed = await resolvePacks(
      makeService(makeManifest('name=Arduino ESP32', 'manifest-variant')),
    );
    expect(changed.board.variant).toBe('manifest-variant');
    expect(changed.build.variant).toBe('manifest-variant');
  });

  it('rejects a manifest option marked unsupported before planning', async () => {
    const unsupportedBoard: BoardDefinition = {
      ...board,
      options: [
        ...board.options,
        {
          id: 'partition_scheme',
          label: 'Partition Scheme',
          default: 'default',
          values: [
            { value: 'default', label: 'Default' },
            {
              value: 'esp_sr_16',
              label: 'ESP SR 16M',
              unsupported: { reason: '需要尚未建模的 srmodels.bin 额外 Flash 段' },
            },
          ],
        },
      ],
    };
    const planner = makeService(makeManifest('name=Arduino ESP32'), [unsupportedBoard]) as unknown as ManifestPlanningInternals;
    await expect(planner.resolveTargetBuild(unsupportedBoard, { partition_scheme: 'esp_sr_16' }))
      .rejects.toThrow(/partition_scheme=esp_sr_16.*暂不支持/);
  });

  it('enforces Manifest matching per ESP32 request while allowing AVR without a match', async () => {
    const unmatchedEsp32Board: BoardDefinition = {
      ...board,
      fqbn: 'esp32:esp32:esp32c6',
      name: 'ESP32-C6 without matching Manifest',
    };
    const avrBoard: BoardDefinition = {
      fqbn: 'arduino:avr:uno',
      name: 'Arduino Uno',
      arch: 'avr',
      pins: [],
      options: [],
      flashTotal: 32_768,
      ramTotal: 2_048,
      upload: { protocol: 'stk500v1' },
      build: {
        mcu: 'atmega328p',
        fCpu: '16000000L',
        variant: 'standard',
        defines: [],
      },
    };
    const planner = makeService(
      makeManifest('name=Arduino ESP32'),
      [board, unmatchedEsp32Board, avrBoard],
    ) as unknown as ManifestPlanningInternals;

    const avrTarget = await planner.resolveTargetBuild(avrBoard, {});
    expect(avrTarget.standardPlatform).toBeUndefined();
    expect(avrTarget.effectiveBoard).toEqual(avrBoard);
    await expect(planner.resolveTargetBuild(unmatchedEsp32Board, {}))
      .rejects.toThrow(/required Platform Manifest is missing/);
  });

  it('keeps native and WASM Platform Manifest resolution canonical', async () => {
    const manifest = makeManifest('name=Arduino ESP32');
    const input = { manifest, fqbn: board.fqbn, options: {} };
    expect(await resolvePlatformManifestWithRust(input)).toEqual(resolvePlatformManifest(input));
  });

  it('normalizes native CK aliases to standard menu IDs and excludes upload-only choices', async () => {
    const planner = makeService(makeManifest('name=Arduino ESP32')) as unknown as ManifestPlanningInternals;
    const legacy = await planner.resolveTargetBuild(board, {
      debug_level: 'verbose', upload_speed: '115200', erase_flash: 'enabled',
    });
    const standard = await planner.resolveTargetBuild(board, {
      CoreDebugLevel: 'verbose', UploadSpeed: '115200', EraseFlash: 'enabled',
    });

    expect(legacy.buildOptions).toEqual({ CoreDebugLevel: 'verbose' });
    expect(standard.buildOptions).toEqual(legacy.buildOptions);
    expect(standard.standardPlatform?.options).toMatchObject({
      CoreDebugLevel: 'verbose', UploadSpeed: '115200', EraseFlash: 'enabled',
    });
    expect(standard.effectiveBoard.build.defines).toContain('CORE_DEBUG_LEVEL=5');
  });
});

function request() {
  return {
    board: board.fqbn,
    files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
  };
}

interface ManifestPlanningInternals {
  resolveTargetBuild(
    boardDefinition: BoardDefinition,
    options: Record<string, string>,
  ): Promise<{
    buildOptions: Record<string, string>;
    effectiveBoard: BoardDefinition;
    standardPlatform: ResolvedPlatformManifest | undefined;
  }>;
  resolveStandardPlatform(
    boardDefinition: BoardDefinition,
    options: Record<string, string>,
  ): Promise<ResolvedPlatformManifest | undefined>;
  toolchainIdentityFor(arch: 'avr' | 'esp32'): Promise<string>;
  createPlatformPack(
    boardDefinition: BoardDefinition,
    standardPlatform: ResolvedPlatformManifest | undefined,
    toolchainHash: string,
  ): PlatformPackRef;
  createBoardPack(
    boardDefinition: BoardDefinition,
    effectiveBoard: BoardDefinition,
    standardPlatform: ResolvedPlatformManifest | undefined,
  ): BoardPackRef;
  applyStandardPlatformBuild(
    boardDefinition: BoardDefinition,
    standardPlatform: ResolvedPlatformManifest | undefined,
  ): BoardDefinition;
}

async function resolvePacks(service: CompileService, boardDefinition: BoardDefinition = board) {
  const planner = service as unknown as ManifestPlanningInternals;
  const target = await planner.resolveTargetBuild(boardDefinition, {});
  const standardPlatform = target.standardPlatform;
  const toolchainHash = await planner.toolchainIdentityFor(boardDefinition.arch);
  return {
    platform: planner.createPlatformPack(boardDefinition, standardPlatform, toolchainHash),
    board: planner.createBoardPack(boardDefinition, target.effectiveBoard, standardPlatform),
    build: target.effectiveBoard.build,
  };
}

function makeManifest(
  platformText: string,
  variant = 'esp32c3',
  omittedProperty?: string,
): CKPlatformManifest {
  const boardProperties = [
    'esp32c3.name=ESP32-C3 Dev Module',
    'esp32c3.build.core=esp32',
    `esp32c3.build.variant=${variant}`,
    'esp32c3.build.mcu=esp32c3',
    'esp32c3.build.tarch=riscv32',
    'esp32c3.build.target=esp',
    'esp32c3.build.f_cpu=160000000L',
    'esp32c3.build.board=ESP32C3_DEV',
    'esp32c3.build.bootloader_addr=0x0',
    'esp32c3.build.flash_mode=dio',
    'esp32c3.build.boot=dio',
    'esp32c3.build.boot_freq=40m',
    'esp32c3.build.flash_freq=40m',
    'esp32c3.build.img_freq={build.flash_freq}',
    'esp32c3.build.flash_size=4MB',
    'esp32c3.build.partitions=default',
    'esp32c3.build.code_debug=0',
    'esp32c3.build.cdc_on_boot=0',
    'esp32c3.build.defines=',
  ].filter((line) => !omittedProperty || !line.startsWith(`esp32c3.${omittedProperty}=`));
  return createPlatformManifest({
    id: 'espressif-arduino',
    version: '3.3.7',
    vendor: 'esp32',
    architecture: 'esp32',
    platformText: [
      platformText,
      'recipe.c.o.pattern=gcc -c {source_file} -o {object_file}',
      'recipe.cpp.o.pattern=g++ -c {source_file} -o {object_file}',
      'recipe.S.o.pattern=gcc -c {source_file} -o {object_file}',
      'recipe.ar.pattern=ar rcs {archive_file_path} {object_file}',
      'recipe.c.combine.pattern=g++ {object_files} {archive_file_path} -o {build.path}/{build.project_name}.elf',
      'build.extra_flags=-DARDUINO_HOST_OS="{runtime.os}" -DARDUINO_FQBN="{build.fqbn}" -DESP32=ESP32 -DCORE_DEBUG_LEVEL={build.code_debug} {build.defines} {build.extra_flags.{build.mcu}} -fno-exceptions',
      'build.extra_flags.esp32c3=-DARDUINO_USB_MODE=1 -DARDUINO_USB_CDC_ON_BOOT={build.cdc_on_boot}',
    ].join('\n'),
    boardsText: [
      'menu.CoreDebugLevel=Core Debug Level',
      'menu.UploadSpeed=Upload Speed',
      'menu.EraseFlash=Erase Flash',
      ...boardProperties,
      'esp32c3.menu.CoreDebugLevel.verbose=Verbose',
      'esp32c3.menu.CoreDebugLevel.verbose.build.code_debug=5',
      'esp32c3.menu.CoreDebugLevel.none=None',
      'esp32c3.menu.CoreDebugLevel.none.build.code_debug=0',
      'esp32c3.menu.UploadSpeed.921600=921600',
      'esp32c3.menu.UploadSpeed.921600.upload.speed=921600',
      'esp32c3.menu.UploadSpeed.115200=115200',
      'esp32c3.menu.UploadSpeed.115200.upload.speed=115200',
      'esp32c3.menu.EraseFlash.disabled=Disabled',
      'esp32c3.menu.EraseFlash.disabled.upload.erase_cmd=',
      'esp32c3.menu.EraseFlash.enabled=Enabled',
      'esp32c3.menu.EraseFlash.enabled.upload.erase_cmd=--erase-all',
    ].join('\n'),
  });
}

function makeService(
  manifest?: CKPlatformManifest,
  boardDefinitions: readonly BoardDefinition[] = [board],
): CompileService {
  const root = mkdtempSync(join(tmpdir(), 'ck-compile-platform-'));
  roots.push(root);
  const boards = new BoardRegistry();
  for (const boardDefinition of boardDefinitions) boards.add(boardDefinition);
  const toolchain: ToolchainConfig = {
    cacheDir: join(root, 'cache'),
    workDir: join(root, 'work'),
    librariesDirs: [],
  };
  return new CompileService({
    boards,
    toolchain,
    executor: new LocalExecutor(),
    compilerBundleId: 'test-bundle',
    platformManifests: manifest ? [manifest] : [],
  });
}
