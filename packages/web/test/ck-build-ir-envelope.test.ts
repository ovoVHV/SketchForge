import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createPlatformManifest } from '../../core/src/platform-pack/builder.js';
import { encodeEsp32PartitionCsv } from '../../core/src/esp32/partition-table.js';
import { browserBoardPackRevisionInput } from '../public/ck-build-ir-envelope.js';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

vi.mock('../public/ck-rust-build-core.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { resolvePlatformManifest } = await import('../../core/src/platform-pack/builder.js');
  const { planBuildIR } = await import('../../core/src/build-ir/planner.js');
  return { ...actual, planBuildIR, resolvePlatformManifest };
});

const hashes = {
  compiler: '1'.repeat(64),
  sdk: '2'.repeat(64),
  board: '3'.repeat(64),
  bootloader: '4'.repeat(64),
  partitions: '5'.repeat(64),
  bootApp0: '6'.repeat(64),
  library: '7'.repeat(64),
  compileGroup: '8'.repeat(64),
  linkGroup: '9'.repeat(64),
  boardGroup: 'a'.repeat(64),
  cFlags: 'b'.repeat(64),
  cxxFlags: 'c'.repeat(64),
  asmFlags: 'd'.repeat(64),
};

const ESP_SR_MODEL = {
  artifactId: 'srmodels',
  sourcePath: 'packs/board/srmodels.bin',
  outputPath: 'build/srmodels.bin',
  offset: '0xd10000',
  size: 2468362,
  capacity: 0x2f0000,
  sha256: '0312f2dde9581cd604e752fbfa287d687a2acc0631e593a35a24c4a518d75879',
} as const;

function capability(libraries: unknown[] = []) {
  return {
    profile: {
      board: 'esp32:esp32:esp32c3', architecture: 'riscv32', runtime: 'esp32-riscv', imageBuilder: true,
    },
    pinnedRuntime: {
      descriptor: {
        schema: 2, id: 'esp32-c3-arduino', abi: 1, board: 'esp32:esp32:esp32c3',
        packs: [
          { role: 'compiler', id: 'riscv32-esp-elf-wasm', revision: hashes.compiler, manifest: 'compiler.json' },
          { role: 'sdk', id: 'arduino-esp32c3-sdk', revision: hashes.sdk, manifest: 'sdk.json' },
          { role: 'board', id: 'arduino-esp32c3-board', revision: hashes.board, manifest: 'board.json' },
        ],
      },
    },
    pinnedLibraries: libraries,
  };
}

function espSrCapability(boardRevision: string) {
  return {
    profile: {
      board: 'esp32:esp32:esp32s3', architecture: 'xtensa32', runtime: 'esp32-xtensa', imageBuilder: true,
    },
    pinnedRuntime: {
      descriptor: {
        schema: 2, id: 'esp32-s3-arduino', abi: 1, board: 'esp32:esp32:esp32s3',
        packs: [
          { role: 'compiler', id: 'xtensa-esp-elf-wasm', revision: hashes.compiler, manifest: 'compiler.json' },
          { role: 'sdk', id: 'arduino-esp32s3-sdk', revision: hashes.sdk, manifest: 'sdk.json' },
          { role: 'board', id: 'arduino-esp32s3-board', revision: boardRevision, manifest: 'board.json' },
        ],
      },
    },
    pinnedLibraries: [],
  };
}

function platformManifest(bootloaderAddress = '0x0') {
  return {
    schema: 2,
    id: 'arduino-esp32c3-3.3.7-default',
    board: 'esp32:esp32:esp32c3',
    sdkVersion: '3.3.7',
    options: {
      flash_mode: 'dio', flash_freq: '40m', flash_size: '4MB', partition_scheme: 'default',
    },
    compile: {
      args: [
        'clang++', '--target=riscv32-esp-elf', '-DARDUINO_ARCH_ESP32',
        '-Icore', '-Ivariant', '-c', 'sketch.cpp', '-o', 'sketch.o',
      ],
      languageFlags: {
        c: ['@sdk/flags/c_flags', '-x', 'c', '-std=gnu17'],
        cxx: ['@sdk/flags/cpp_flags'],
        asm: ['@sdk/flags/S_flags', '-x', 'assembler-with-cpp'],
      },
      source: 'sketch.cpp', object: 'sketch.o', artifactIds: ['compile'],
    },
    link: {
      args: [
        'clang++', '--target=riscv32-esp-elf', '-Lsdk/lib', '-Wl,--start-group',
        'sketch.o', 'core.a', '@sdk/flags/ld_libs', '-Wl,--end-group', '-o', 'firmware.elf',
      ],
      object: 'sketch.o', elf: 'firmware.elf', artifactIds: ['link'],
    },
    variant: 'esp32c3',
    boardPack: { artifactIds: ['variant'] },
    image: { flashMode: 'dio', flashFrequency: '40m', flashSize: '4MB' },
    flash: { bootloader: 'bootloader', partitions: 'partitions', bootApp0: 'boot-app0' },
    platformManifest: createPlatformManifest({
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      platformText: [
        'name=Arduino ESP32',
        'compiler.ar.cmd=ar',
        'compiler.ar.flags=rcs',
        'compiler.ar.extra_flags=D',
        'build.flash_freq=40m',
        'build.img_freq={build.flash_freq}',
        'build.flash_mode=dio',
        'build.flash_size=4MB',
        'build.partitions=default',
        'upload.extra_flags=',
        'tools.esptool_py.path={runtime.tools.esptool_py.path}',
        'tools.esptool_py.cmd=esptool',
        'tools.gen_esp32part.cmd=python3 "{runtime.platform.path}/tools/gen_esp32part.py"',
        'recipe.c.o.pattern=gcc -c {source_file} -o {object_file}',
        'recipe.cpp.o.pattern=g++ -c {source_file} -o {object_file}',
        'recipe.S.o.pattern=gcc -c {source_file} -o {object_file}',
        'recipe.ar.pattern={compiler.ar.cmd} {compiler.ar.flags} {compiler.ar.extra_flags} {archive_file_path} {object_file}',
        'recipe.c.combine.pattern=g++ {object_files} {archive_file_path} -o {build.path}/{build.project_name}.elf',
        'recipe.objcopy.bin.pattern="{tools.esptool_py.path}/{tools.esptool_py.cmd}" "{recipe.objcopy.bin.pattern_args}"',
        'recipe.objcopy.bin.pattern_args=--chip {build.mcu} elf2image --flash-mode "{build.flash_mode}" --flash-freq "{build.img_freq}" --flash-size "{build.flash_size}" --elf-sha256-offset 0xb0 -o "{build.path}/{build.project_name}.bin" "{build.path}/{build.project_name}.elf"',
        'recipe.objcopy.partitions.bin.pattern="{tools.gen_esp32part.cmd}" -q "{build.path}/partitions.csv" "{build.path}/{build.project_name}.partitions.bin"',
        'recipe.hooks.prebuild.4.pattern=/usr/bin/env bash -c "opaque {recipe.hooks.prebuild.4.pattern_args}"',
        'recipe.hooks.prebuild.4.pattern_args=--chip {build.mcu} elf2image --flash-mode {build.flash_mode} --flash-freq {build.img_freq} --flash-size {build.flash_size} -o',
        'recipe.hooks.objcopy.postobjcopy.3.pattern="{tools.esptool_py.path}/{tools.esptool_py.cmd}" "{recipe.hooks.objcopy.postobjcopy.3.pattern_args}"',
        'recipe.hooks.objcopy.postobjcopy.3.pattern_args=--chip {build.mcu} merge-bin -o "{build.path}/{build.project_name}.merged.bin" --pad-to-size {build.flash_size} --flash-mode keep --flash-freq keep --flash-size keep {build.bootloader_addr} "{build.path}/{build.project_name}.bootloader.bin" 0x8000 "{build.path}/{build.project_name}.partitions.bin" 0xe000 "{runtime.platform.path}/tools/partitions/boot_app0.bin" 0x10000 "{build.path}/{build.project_name}.bin"',
      ].join('\n'),
      boardsText: [
        'menu.FlashMode=Flash Mode',
        'menu.FlashFreq=Flash Frequency',
        'menu.FlashSize=Flash Size',
        'menu.PartitionScheme=Partition Scheme',
        'esp32c3.name=ESP32-C3 Dev Module',
        'esp32c3.build.core=esp32',
        'esp32c3.build.variant=esp32c3',
        'esp32c3.build.mcu=esp32c3',
        'esp32c3.build.boot=dio',
        'esp32c3.build.boot_freq=40m',
        `esp32c3.build.bootloader_addr=${bootloaderAddress}`,
        'esp32c3.menu.FlashMode.dio=DIO',
        'esp32c3.menu.FlashMode.dio.build.boot=dio',
        'esp32c3.menu.FlashMode.dio.build.flash_mode=dio',
        'esp32c3.menu.FlashMode.qio=QIO',
        'esp32c3.menu.FlashMode.qio.build.boot=qio',
        'esp32c3.menu.FlashMode.qio.build.flash_mode=dio',
        'esp32c3.menu.FlashFreq.40=40MHz',
        'esp32c3.menu.FlashFreq.40.build.flash_freq=40m',
        'esp32c3.menu.FlashFreq.80=80MHz',
        'esp32c3.menu.FlashFreq.80.build.flash_freq=80m',
        'esp32c3.menu.FlashSize.4M=4MB',
        'esp32c3.menu.FlashSize.4M.build.flash_size=4MB',
        'esp32c3.menu.FlashSize.8M=8MB',
        'esp32c3.menu.FlashSize.8M.build.flash_size=8MB',
        'esp32c3.menu.PartitionScheme.default=Default',
        'esp32c3.menu.PartitionScheme.default.build.partitions=default',
        'esp32c3.menu.PartitionScheme.huge_app=Huge APP',
        'esp32c3.menu.PartitionScheme.huge_app.build.partitions=huge_app',
      ].join('\n'),
      runtimeToolPolicy: 'deferred-ck-binding',
    }),
  };
}

function espSrPlatformManifest() {
  const base = platformManifest();
  return {
    ...base,
    id: 'arduino-esp32s3-3.3.7-esp-sr-16',
    board: 'esp32:esp32:esp32s3',
    options: {
      flash_mode: 'dio', flash_freq: '80m', flash_size: '16MB', partition_scheme: 'esp_sr_16',
    },
    compile: {
      ...base.compile,
      args: base.compile.args.map((argument) => (
        argument === '--target=riscv32-esp-elf' ? '--target=xtensa-esp-elf' : argument
      )),
    },
    link: {
      ...base.link,
      args: base.link.args.map((argument) => (
        argument === '--target=riscv32-esp-elf' ? '--target=xtensa-esp-elf' : argument
      )),
    },
    variant: 'esp32s3',
    image: { flashMode: 'dio', flashFrequency: '80m', flashSize: '16MB' },
    flash: {
      bootloader: 'bootloader', partitions: 'partitions', bootApp0: 'boot-app0',
      partitionScheme: 'esp_sr_16',
      model: {
        artifactId: ESP_SR_MODEL.artifactId,
        offset: ESP_SR_MODEL.offset,
        size: ESP_SR_MODEL.size,
        capacity: ESP_SR_MODEL.capacity,
      },
    },
    platformManifest: createPlatformManifest({
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      platformText: [
        'name=Arduino ESP32',
        'compiler.ar.cmd=ar',
        'compiler.ar.flags=rcs',
        'compiler.ar.extra_flags=D',
        'build.flash_freq=80m',
        'build.img_freq={build.flash_freq}',
        'build.flash_mode=dio',
        'build.flash_size=16MB',
        'build.partitions=esp_sr_16',
        'upload.extra_flags=',
        'tools.esptool_py.path={runtime.tools.esptool_py.path}',
        'tools.esptool_py.cmd=esptool',
        'tools.gen_esp32part.cmd=python3 "{runtime.platform.path}/tools/gen_esp32part.py"',
        'recipe.c.o.pattern=gcc -c {source_file} -o {object_file}',
        'recipe.cpp.o.pattern=g++ -c {source_file} -o {object_file}',
        'recipe.S.o.pattern=gcc -c {source_file} -o {object_file}',
        'recipe.ar.pattern={compiler.ar.cmd} {compiler.ar.flags} {compiler.ar.extra_flags} {archive_file_path} {object_file}',
        'recipe.c.combine.pattern=g++ {object_files} {archive_file_path} -o {build.path}/{build.project_name}.elf',
        'recipe.objcopy.bin.pattern="{tools.esptool_py.path}/{tools.esptool_py.cmd}" "{recipe.objcopy.bin.pattern_args}"',
        'recipe.objcopy.bin.pattern_args=--chip {build.mcu} elf2image --flash-mode "{build.flash_mode}" --flash-freq "{build.img_freq}" --flash-size "{build.flash_size}" --elf-sha256-offset 0xb0 -o "{build.path}/{build.project_name}.bin" "{build.path}/{build.project_name}.elf"',
        'recipe.objcopy.partitions.bin.pattern="{tools.gen_esp32part.cmd}" -q "{build.path}/partitions.csv" "{build.path}/{build.project_name}.partitions.bin"',
        'recipe.hooks.prebuild.4.pattern=/usr/bin/env bash -c "opaque {recipe.hooks.prebuild.4.pattern_args}"',
        'recipe.hooks.prebuild.4.pattern_args=--chip {build.mcu} elf2image --flash-mode {build.flash_mode} --flash-freq {build.img_freq} --flash-size {build.flash_size} -o',
        'recipe.hooks.objcopy.postobjcopy.3.pattern="{tools.esptool_py.path}/{tools.esptool_py.cmd}" "{recipe.hooks.objcopy.postobjcopy.3.pattern_args}"',
        'recipe.hooks.objcopy.postobjcopy.3.pattern_args=--chip {build.mcu} merge-bin -o "{build.path}/{build.project_name}.merged.bin" --pad-to-size {build.flash_size} --flash-mode keep --flash-freq keep --flash-size keep {build.bootloader_addr} "{build.path}/{build.project_name}.bootloader.bin" 0x8000 "{build.path}/{build.project_name}.partitions.bin" 0xe000 "{runtime.platform.path}/tools/partitions/boot_app0.bin" 0x10000 "{build.path}/{build.project_name}.bin"',
      ].join('\n'),
      boardsText: [
        'menu.FlashMode=Flash Mode',
        'menu.FlashFreq=Flash Frequency',
        'menu.FlashSize=Flash Size',
        'menu.PartitionScheme=Partition Scheme',
        'esp32s3.name=ESP32-S3 Dev Module',
        'esp32s3.build.core=esp32',
        'esp32s3.build.variant=esp32s3',
        'esp32s3.build.mcu=esp32s3',
        'esp32s3.build.boot=dio',
        'esp32s3.build.boot_freq=80m',
        'esp32s3.build.bootloader_addr=0x0',
        'esp32s3.menu.FlashMode.dio=DIO',
        'esp32s3.menu.FlashMode.dio.build.boot=dio',
        'esp32s3.menu.FlashMode.dio.build.flash_mode=dio',
        'esp32s3.menu.FlashFreq.80=80MHz',
        'esp32s3.menu.FlashFreq.80.build.flash_freq=80m',
        'esp32s3.menu.FlashSize.16M=16MB',
        'esp32s3.menu.FlashSize.16M.build.flash_size=16MB',
        'esp32s3.menu.PartitionScheme.esp_sr_16=ESP SR 16MB',
        'esp32s3.menu.PartitionScheme.esp_sr_16.build.partitions=esp_sr_16',
      ].join('\n'),
      runtimeToolPolicy: 'deferred-ck-binding',
    }),
  };
}

function sdkManifest(
  compileSha256 = hashes.compileGroup,
  linkSha256 = hashes.linkGroup,
  languageSha256: Partial<Record<'c' | 'cxx' | 'asm', string>> = {},
) {
  const responseHashes = {
    c: languageSha256.c ?? hashes.cFlags,
    cxx: languageSha256.cxx ?? hashes.cxxFlags,
    asm: languageSha256.asm ?? hashes.asmFlags,
  };
  return {
    schema: 2,
    id: 'arduino-esp32c3-sdk',
    version: '3.3.7',
    revision: hashes.sdk,
    artifacts: [
      {
        id: 'compile', kind: 'tree', size: 15, sha256: compileSha256,
        files: [
          { path: 'sdk/flags/S_flags', offset: 0, length: 5, sha256: responseHashes.asm },
          { path: 'sdk/flags/c_flags', offset: 5, length: 5, sha256: responseHashes.c },
          { path: 'sdk/flags/cpp_flags', offset: 10, length: 5, sha256: responseHashes.cxx },
        ],
      },
      {
        id: 'link', kind: 'tree', size: 10, sha256: linkSha256,
        files: [
          { path: 'core.a', offset: 0, length: 1, sha256: 'd'.repeat(64) },
          { path: 'sdk/flags/ld_libs', offset: 1, length: 3, sha256: 'e'.repeat(64) },
          { path: 'sdk/lld-compat/memory.ld', offset: 4, length: 3, sha256: 'f'.repeat(64) },
          { path: 'sdk/lld-compat/sections.ld', offset: 7, length: 3, sha256: '0'.repeat(64) },
        ],
      },
    ],
  };
}

const boardManifest = {
  schema: 2,
  id: 'arduino-esp32c3-board',
  version: '3.3.7',
  revision: hashes.board,
  artifacts: [
    {
      id: 'boot-app0', kind: 'bin', size: 1, sha256: hashes.bootApp0,
      chunks: [{ path: 'chunks/boot-app0.bin', size: 1, sha256: hashes.bootApp0 }],
    },
    {
      id: 'bootloader', kind: 'bin', size: 1, sha256: hashes.bootloader,
      chunks: [{ path: 'chunks/bootloader.bin', size: 1, sha256: hashes.bootloader }],
    },
    {
      id: 'partitions', kind: 'bin', size: 1, sha256: hashes.partitions,
      chunks: [{ path: 'chunks/partitions.bin', size: 1, sha256: hashes.partitions }],
    },
    {
      id: 'variant', kind: 'tree', size: 4, sha256: hashes.boardGroup,
      files: [{
        path: 'variant/pins_arduino.h', offset: 0, length: 4, sha256: 'a'.repeat(64),
      }],
      chunks: [{ path: 'chunks/variant.bin', size: 4, sha256: hashes.boardGroup }],
    },
  ],
};
hashes.board = createHash('sha256')
  .update(browserBoardPackRevisionInput(boardManifest), 'utf8')
  .digest('hex');
boardManifest.revision = hashes.board;
const flashManifest = boardManifest;

function espSrBoardManifest({ includeModel = true, modelSize = ESP_SR_MODEL.size } = {}) {
  const artifacts = [
    ...boardManifest.artifacts.slice(0, 3).map((artifact) => ({ ...artifact })),
    ...(includeModel ? [{
      id: ESP_SR_MODEL.artifactId, kind: 'bin', size: modelSize, sha256: ESP_SR_MODEL.sha256,
      chunks: [{ path: 'chunks/srmodels.bin', size: modelSize, sha256: ESP_SR_MODEL.sha256 }],
    }] : []),
    { ...boardManifest.artifacts[3] },
  ];
  const manifest = {
    schema: 2,
    id: 'arduino-esp32s3-board',
    version: '3.3.7',
    revision: '0'.repeat(64),
    artifacts,
  };
  manifest.revision = createHash('sha256')
    .update(browserBoardPackRevisionInput(manifest), 'utf8')
    .digest('hex');
  return manifest;
}

function espSrPlanning(manifest = espSrBoardManifest()) {
  return {
    platformManifest: espSrPlatformManifest(),
    flashManifest: manifest,
    boardManifest: manifest,
    sdkManifest: { ...sdkManifest(), id: 'arduino-esp32s3-sdk' },
    compilerManifest: { version: '22.0.0' },
    librarySources: [],
  };
}

describe('browserBoardPackRevisionInput', () => {
  const currentBoardManifest = () => ({
    ...boardManifest,
    revision: '0'.repeat(64),
    artifacts: [
      ...boardManifest.artifacts.slice(0, 3),
      {
        id: 'profile-v4', kind: 'json', size: 2, sha256: 'f'.repeat(64),
        chunks: [{ path: 'chunks/profile-v4.json', size: 2, sha256: 'f'.repeat(64) }],
      },
      ...boardManifest.artifacts.slice(3),
    ],
  });

  it('accepts an ordered current Board Pack Manifest', () => {
    const manifest = currentBoardManifest();
    const revisionInput = JSON.parse(browserBoardPackRevisionInput(manifest));

    expect(revisionInput).toEqual({
      schema: manifest.schema,
      id: manifest.id,
      version: manifest.version,
      artifacts: manifest.artifacts,
    });
  });

  it('rejects an unordered Board Pack Manifest under the v3 contract', () => {
    const manifest = currentBoardManifest();
    const unorderedManifest = {
      ...manifest,
      artifacts: [
        ...manifest.artifacts.slice(0, 3),
        manifest.artifacts[4],
        manifest.artifacts[3],
      ],
    };

    expect(() => browserBoardPackRevisionInput(unorderedManifest))
      .toThrow('browser toolchain artifacts must have sorted unique ids: profile-v4');
  });
});

describe('ESP32 CK Build IR browser planner', () => {
  it('keeps the post-link contract identity for explicit current-profile options', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const planning = {
      platformManifest: platformManifest(), flashManifest, boardManifest, sdkManifest: sdkManifest(),
      compilerManifest: { version: '22.0.0' }, librarySources: [],
    };
    const request = {
      board: 'esp32:esp32:esp32c3', libraries: [],
      files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
    };
    const baseline = await createEsp32BrowserBuildIR({ ...request, options: {} }, capability(), planning);
    const explicit = await createEsp32BrowserBuildIR({
      ...request,
      options: {
        partition_scheme: 'default', flash_mode: 'dio', flash_freq: '40m', flash_size: '4MB',
      },
    }, capability(), planning);
    const contractFlags = (ir: any) => [...new Set(ir.graph.actions
      .filter((action: any) => action.id.startsWith('transform-'))
      .flatMap((action: any) => action.transform.flags)
      .filter((argument: string) => argument.startsWith('--ck-post-link-contract=')))];

    expect(contractFlags(baseline)).toEqual([expect.stringMatching(/^--ck-post-link-contract=[a-f0-9]{64}$/)]);
    expect(contractFlags(explicit)).toEqual(contractFlags(baseline));
  });

  it.each([
    ['partition scheme', { partition_scheme: 'huge_app' }, /changes build\.partitions/],
    ['flash mode/bootloader', { flash_mode: 'qio' }, /changes bootloader selection/],
    ['flash frequency', { flash_freq: '80m' }, /changes build\.flash_mode\/build\.img_freq\/build\.flash_size/],
    ['flash size', { flash_size: '8MB' }, /changes build\.flash_mode\/build\.img_freq\/build\.flash_size/],
  ])('fails closed when %s no longer matches the current Board Pack artifact', async (_label, options, error) => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');

    await expect(createEsp32BrowserBuildIR({
      board: 'esp32:esp32:esp32c3', options, libraries: [],
      files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
    }, capability(), {
      platformManifest: platformManifest(), flashManifest, boardManifest, sdkManifest: sdkManifest(),
      compilerManifest: { version: '22.0.0' }, librarySources: [],
    })).rejects.toThrow(error);
  });

  it('takes the bootloader offset from the resolved Platform Manifest', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const request = {
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [],
      files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
    };
    const planning = {
      platformManifest: platformManifest('0x2000'), flashManifest, boardManifest, sdkManifest: sdkManifest(),
      compilerManifest: { version: '22.0.0' }, librarySources: [],
    };

    const ir = await createEsp32BrowserBuildIR(request, capability(), planning);
    expect(ir.artifacts.find((artifact: { format: string }) => artifact.format === 'bootloader'))
      .toMatchObject({ offset: '0x2000' });
  });

  it('binds all Arduino tabs to one ESP32 sketch Action chain', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const planning = {
      platformManifest: platformManifest(), flashManifest, boardManifest, sdkManifest: sdkManifest(),
      compilerManifest: { version: '22.0.0' }, librarySources: [],
    };
    const create = (other: string) => createEsp32BrowserBuildIR({
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [],
      files: [
        { name: 'Other.ino', content: other },
        { name: 'main.ino', content: 'void setup() {}\n' },
      ],
    }, capability(), planning);
    const baseline = await create('void loop() {}\n');
    const changed = await create('void loop() { delay(1); }\n');
    const preprocess = baseline.graph.actions.find((action: any) => action.tool === 'ck:arduino-preprocess');

    expect(baseline.graph.actions.filter((action: any) => action.kind === 'compile')).toHaveLength(1);
    expect(preprocess.arguments.slice(0, 2)).toEqual(['main.ino', 'Other.ino']);
    expect(preprocess.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'main.ino', role: 'sketch-main' }),
      expect.objectContaining({ path: 'Other.ino', role: 'sketch-tab' }),
    ]));
    expect(baseline.diagnosticMap.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceFile: 'Other.ino', sourceLine: 1 }),
    ]));
    expect(changed.graph.actions.find((action: any) => action.tool === 'ck:arduino-preprocess').cacheKey)
      .not.toBe(preprocess.cacheKey);
  });

  it('uses the shared CK planner to create a complete deterministic Action DAG', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const request = {
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [],
      files: [
        { name: 'main.ino', content: '#include "include/config.h"\nvoid setup() {}\nvoid loop() {}\n' },
        { name: 'include/config.h', content: '#pragma once\n' },
      ],
    };
    const planning = {
      platformManifest: platformManifest(), flashManifest, boardManifest, sdkManifest: sdkManifest(),
      compilerManifest: { version: '22.0.0' }, librarySources: [],
    };
    const first = await createEsp32BrowserBuildIR(request, capability(), planning);
    const second = await createEsp32BrowserBuildIR(request, capability(), planning);

    expect(second).toEqual(first);
    expect(first.graph.actions.map((action: { id: string }) => action.id)).not.toContain('browser-worker-build');
    expect(first.graph.actions).toHaveLength(8);
    expect(first.graph.actions.filter((action: { kind: string }) => action.kind === 'compile')).toHaveLength(1);
    expect(first.graph.actions.filter((action: { kind: string }) => action.kind === 'link')).toHaveLength(1);
    expect(first.graph.actions.filter((action: { kind: string }) => action.kind === 'transform')).toHaveLength(6);
    expect(first.artifacts.map((artifact: { path: string }) => artifact.path)).toEqual([
      'build/boot_app0.bin', 'build/bootloader.bin', 'build/firmware.bin',
      'build/firmware.elf', 'build/firmware.merged.bin', 'build/partitions.bin',
    ]);
    expect(first.packs.platform).toMatchObject({
      id: 'espressif-arduino',
      version: '3.3.7',
      sha256: planning.platformManifest.platformManifest.sha256,
    });
    expect(first.packs.board.sha256).not.toBe(first.packs.platform.sha256);
    expect(first.packs.board.version).toBe(boardManifest.version);
    expect(JSON.stringify(first)).not.toContain('worker-result.json');
    expect(JSON.stringify(first)).not.toContain('browser-wasm:esp32-worker');

    const compile = first.graph.actions.find((action: { kind: string }) => action.kind === 'compile');
    expect(compile.compileUnit).toMatchObject({
      macros: { ARDUINO_ARCH_ESP32: true },
      includePaths: expect.arrayContaining([
        'packs/platform/core', 'packs/board/variant', 'project', 'project/include',
      ]),
      flags: expect.arrayContaining(['-Wno-error=narrowing']),
    });
    expect(compile.inputs).toContainEqual(expect.objectContaining({
      path: 'include/config.h', role: 'project-header',
    }));
    expect(compile.inputs).toContainEqual(expect.objectContaining({
      path: 'packs/platform/sdk/flags/cpp_flags', role: 'compiler-response-file',
    }));
    expect(compile.packInputs).toEqual(expect.arrayContaining([
      {
        kind: 'pack-artifact',
        packId: 'espressif-arduino',
        packRevision: planning.platformManifest.platformManifest.sha256,
        packSchema: 1,
        artifactId: 'compile',
        sha256: hashes.compileGroup,
        role: 'platform-compile-tree',
      },
      expect.objectContaining({
        packId: 'arduino-esp32c3-board',
        packSchema: 2,
        artifactId: 'variant',
        role: 'board-variant-tree',
      }),
    ]));
    const link = first.graph.actions.find((action: { kind: string }) => action.kind === 'link');
    expect(link.link.archives).toContain('packs/platform/core.a');
    expect(link.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'packs/platform/sdk/lld-compat/memory.ld', role: 'linker-script' }),
      expect.objectContaining({ path: 'packs/platform/sdk/lld-compat/sections.ld', role: 'linker-script' }),
    ]));
    expect(link.packInputs).toEqual([expect.objectContaining({
      artifactId: 'link', sha256: hashes.linkGroup, role: 'platform-link-tree',
    })]);
    const transforms = first.graph.actions.filter((action: { id: string }) => action.id.startsWith('transform-'));
    expect(transforms.map((action: any) => ({
      id: action.id, tool: action.tool, output: action.outputs[0], dependencies: action.dependencies,
    }))).toEqual([
      {
        id: 'transform-application', tool: 'ck:esp32-image',
        output: { path: 'build/firmware.bin', kind: 'application' },
        dependencies: ['link-firmware'],
      },
      {
        id: 'transform-boot-app0', tool: 'ck:pack-copy',
        output: { path: 'build/boot_app0.bin', kind: 'boot-app0' }, dependencies: [],
      },
      {
        id: 'transform-bootloader', tool: 'ck:pack-copy',
        output: { path: 'build/bootloader.bin', kind: 'bootloader' }, dependencies: [],
      },
      {
        id: 'transform-merged', tool: 'ck:esp32-merge',
        output: { path: 'build/firmware.merged.bin', kind: 'merged' },
        dependencies: [
          'transform-application', 'transform-boot-app0',
          'transform-bootloader', 'transform-partitions',
        ],
      },
      {
        id: 'transform-partitions', tool: 'ck:pack-copy',
        output: { path: 'build/partitions.bin', kind: 'partitions' }, dependencies: [],
      },
    ]);
    const immutableInputs = Object.fromEntries(transforms
      .filter((action: any) => action.tool === 'ck:pack-copy')
      .map((action: any) => [action.id, action.inputs[0]]));
    expect(immutableInputs).toEqual({
      'transform-boot-app0': {
        path: 'packs/board/boot_app0.bin', role: 'boot-app0-source', sha256: hashes.bootApp0,
      },
      'transform-bootloader': {
        path: 'packs/board/bootloader.bin', role: 'bootloader-source', sha256: hashes.bootloader,
      },
      'transform-partitions': {
        path: 'packs/board/partitions.bin', role: 'partitions-source', sha256: hashes.partitions,
      },
    });
    const immutablePackInputs = Object.fromEntries(transforms
      .filter((action: any) => action.tool === 'ck:pack-copy')
      .map((action: any) => [action.id, action.packInputs[0]]));
    expect(immutablePackInputs).toEqual({
      'transform-boot-app0': expect.objectContaining({
        packId: boardManifest.id, packRevision: boardManifest.revision,
        packSchema: 2, artifactId: 'boot-app0', sha256: hashes.bootApp0,
      }),
      'transform-bootloader': expect.objectContaining({
        packId: boardManifest.id, packRevision: boardManifest.revision,
        packSchema: 2, artifactId: 'bootloader', sha256: hashes.bootloader,
      }),
      'transform-partitions': expect.objectContaining({
        packId: boardManifest.id, packRevision: boardManifest.revision,
        packSchema: 2, artifactId: 'partitions', sha256: hashes.partitions,
      }),
    });
    const merged = transforms.find((action: { id: string }) => action.id === 'transform-merged');
    expect(merged.inputs.map((input: { path: string }) => input.path)).toEqual([
      'build/boot_app0.bin', 'build/bootloader.bin',
      'build/firmware.bin', 'build/partitions.bin',
    ]);
    expect(merged.arguments).toEqual(expect.arrayContaining([
      'merge-bin', '0x0', 'build/bootloader.bin', '0x8000', 'build/partitions.bin',
      '0xe000', 'build/boot_app0.bin', '0x10000', 'build/firmware.bin',
    ]));
  });

  it('plans an ESP32-S3 esp_sr_16 model artifact and five-segment merge graph', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const manifest = espSrBoardManifest();
    const ir = await createEsp32BrowserBuildIR({
      board: 'esp32:esp32:esp32s3', options: {}, libraries: [],
      files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
    }, espSrCapability(manifest.revision), espSrPlanning(manifest));

    const model = ir.graph.actions.find((action: any) => action.id === 'transform-model');
    expect(model).toMatchObject({
      tool: 'ck:pack-copy',
      inputs: [{
        path: ESP_SR_MODEL.sourcePath, role: 'model-source', sha256: ESP_SR_MODEL.sha256,
      }],
      outputs: [{ path: ESP_SR_MODEL.outputPath, kind: 'model' }],
      dependencies: [],
      packDependencies: [manifest.id],
      packInputs: [{
        kind: 'pack-artifact', packId: manifest.id, packRevision: manifest.revision,
        packSchema: 2, artifactId: ESP_SR_MODEL.artifactId,
        sha256: ESP_SR_MODEL.sha256, role: 'model-source',
      }],
    });
    const merged = ir.graph.actions.find((action: any) => action.id === 'transform-merged');
    expect(merged.inputs.map(({ path, role }: any) => ({ path, role }))).toEqual([
      { path: 'build/boot_app0.bin', role: 'boot-app0-image' },
      { path: 'build/bootloader.bin', role: 'bootloader-image' },
      { path: 'build/firmware.bin', role: 'application-image' },
      { path: 'build/partitions.bin', role: 'partitions-image' },
      { path: ESP_SR_MODEL.outputPath, role: 'model-image' },
    ]);
    expect(merged.arguments.slice(-10)).toEqual([
      '0x0', 'build/bootloader.bin',
      '0x8000', 'build/partitions.bin',
      '0xe000', 'build/boot_app0.bin',
      '0x10000', 'build/firmware.bin',
      ESP_SR_MODEL.offset, ESP_SR_MODEL.outputPath,
    ]);
    expect(merged.dependencies).toEqual([
      'transform-application', 'transform-boot-app0', 'transform-bootloader',
      'transform-model', 'transform-partitions',
    ]);
    expect(ir.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ESP_SR_MODEL.outputPath, format: 'bin', offset: ESP_SR_MODEL.offset }),
    ]));
  });

  it('rejects missing and oversized esp_sr_16 Board Pack model artifacts', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const create = (manifest: ReturnType<typeof espSrBoardManifest>) => createEsp32BrowserBuildIR({
      board: 'esp32:esp32:esp32s3', options: {}, libraries: [],
      files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
    }, espSrCapability(manifest.revision), espSrPlanning(manifest));

    await expect(create(espSrBoardManifest({ includeModel: false })))
      .rejects.toThrow(/Board Pack artifact is invalid: srmodels/);
    await expect(create(espSrBoardManifest({ modelSize: ESP_SR_MODEL.capacity + 1 })))
      .rejects.toThrow(/Board Pack artifact is invalid: srmodels/);
  });

  it('binds a root project partitions.csv without requesting the default Board Pack partition', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const csv = 'nvs,data,nvs,0x9000,0x5000,\napp,app,ota_0,0x10000,0x100000,\n';
    const ir = await createEsp32BrowserBuildIR({
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [],
      files: [
        { name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' },
        { name: 'partitions.csv', content: csv },
      ],
    }, capability(), {
      platformManifest: platformManifest(), flashManifest, boardManifest, sdkManifest: sdkManifest(),
      compilerManifest: { version: '22.0.0' }, librarySources: [],
    });
    const partitions = ir.graph.actions.find((action: any) => action.id === 'transform-partitions');
    const expectedSha256 = createHash('sha256').update(csv, 'utf8').digest('hex');
    const expectedTableSha256 = createHash('sha256').update(
      encodeEsp32PartitionCsv(csv, { flashSizeBytes: 4 * 1024 * 1024 }).bytes,
    ).digest('hex');

    expect(ir.project.files).toContainEqual(expect.objectContaining({
      path: 'partitions.csv', sha256: expectedSha256, language: 'other',
    }));
    expect(partitions).toMatchObject({
      kind: 'transform',
      tool: 'platform:gen-esp32part',
      inputs: [{ path: 'partitions.csv', role: 'partitions-source', sha256: expectedSha256 }],
      outputs: [{
        path: 'build/partitions.bin', kind: 'partitions', sha256: expectedTableSha256,
      }],
      arguments: ['-q', 'partitions.csv', 'build/partitions.bin'],
      transform: {
        input: 'partitions.csv', output: 'build/partitions.bin', format: 'partition',
        flags: ['--quiet=true', expect.stringMatching(/^--ck-post-link-contract=[a-f0-9]{64}$/)],
      },
    });
    expect(partitions.packInputs).toBeUndefined();
    expect(ir.graph.actions.some((action: any) => action.inputs.some((input: any) => (
      input.path === 'packs/board/partitions.bin'
    )))).toBe(false);
  });

  it.each([
    ['only data partitions', 'nvs,data,nvs,0x9000,0x5000,\n'],
    [
      'an app slot after the fixed image offset',
      'nvs,data,nvs,0x9000,0x5000,\napp,app,factory,0x20000,0x100000,\n',
    ],
  ])('rejects Browser custom partitions with %s', async (_label, csv) => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    await expect(createEsp32BrowserBuildIR({
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [],
      files: [
        { name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' },
        { name: 'partitions.csv', content: csv },
      ],
    }, capability(), {
      platformManifest: platformManifest(), flashManifest, boardManifest, sdkManifest: sdkManifest(),
      compilerManifest: { version: '22.0.0' }, librarySources: [],
    })).rejects.toThrow(/no bootable app partition covers 0x10000/i);
  });

  it('checks actual Browser application bytes against the custom slot boundary', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const { adaptEsp32BuildExecution } = await import('../public/browser-esp32.js');
    const ir = await createEsp32BrowserBuildIR({
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [],
      files: [
        { name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' },
        {
          name: 'partitions.csv',
          content: 'nvs,data,nvs,0x9000,0x5000,\napp,app,factory,0x10000,0x1000,\n',
        },
      ],
    }, capability(), {
      platformManifest: platformManifest(), flashManifest, boardManifest, sdkManifest: sdkManifest(),
      compilerManifest: { version: '22.0.0' }, librarySources: [],
    });
    const execution = (applicationSize: number) => ({
      status: 'success',
      artifacts: ir.artifacts
        .filter((artifact: any) => artifact.format !== 'elf')
        .map((artifact: any) => ({
          ...artifact,
          bytes: new Uint8Array(artifact.path === 'build/firmware.bin' ? applicationSize : 1),
        })),
      diagnostics: [],
      durationMs: 1,
    });

    await expect(adaptEsp32BuildExecution(execution(0x1000), 0, ir)).resolves.toMatchObject({
      status: 'success', artifacts: [{ name: 'firmware.bin', size: 0x1000 }],
    });
    await expect(adaptEsp32BuildExecution(execution(0x1001), 0, ir)).resolves.toMatchObject({
      status: 'error', reason: 'resource_limit',
      message: expect.stringMatching(/4097 bytes.*capacity 4096 bytes/i),
    });
  });

  it('fails closed when a Browser flash artifact loses its Board Pack provenance', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const invalidFlashManifest = {
      ...flashManifest,
      artifacts: flashManifest.artifacts.filter((artifact) => artifact.id !== 'partitions'),
    };

    await expect(createEsp32BrowserBuildIR({
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [],
      files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
    }, capability(), {
      platformManifest: platformManifest(), flashManifest: invalidFlashManifest,
      boardManifest, sdkManifest: sdkManifest(), librarySources: [],
    })).rejects.toThrow(/Board Pack artifact is invalid: partitions/);
  });

  it('plans generic Library Source Packs as compile and archive Actions', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const library = {
      name: 'Example', version: '1.0.0', packId: 'arduino-lib-example', revision: hashes.library,
      dependencies: [],
    };
    const ir = await createEsp32BrowserBuildIR({
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [{ name: 'Example', version: '1.0.0' }],
      files: [{ name: 'main.ino', content: '#include <Example.h>\nvoid setup() {}\nvoid loop() {}\n' }],
    }, capability([library]), {
      platformManifest: platformManifest(), flashManifest, boardManifest, sdkManifest: sdkManifest(),
      compilerManifest: { version: '22.0.0' },
      librarySources: [{
        packId: library.packId,
        includeDirs: ['src'],
        files: [
          { path: 'src/Example.h', content: '#pragma once\n' },
          { path: 'src/Example.cpp', content: '#include "Example.h"\n' },
          { path: 'src/Optional.S', content: '#include "Example.h"\n' },
        ],
      }],
    });

    expect(ir.graph.actions.some((action: { id: string }) => action.id.startsWith('compile-library-'))).toBe(true);
    const archive = ir.graph.actions.find((action: { id: string }) => action.id.startsWith('archive-library-'));
    expect(archive).toMatchObject({
      kind: 'archive',
      packDependencies: [library.packId],
      archive: { flags: ['D'] },
    });
    expect(archive.arguments.at(-1)).toBe('D');
    const link = ir.graph.actions.find((action: { kind: string }) => action.kind === 'link');
    expect(link.link.archives).toEqual(expect.arrayContaining([
      archive.archive.output,
      'packs/platform/core.a',
    ]));
    const assembly = ir.graph.actions.find((action: { kind: string, compileUnit?: { source?: string } }) => (
      action.kind === 'compile' && action.compileUnit?.source?.endsWith('/Optional.S')
    ));
    expect(assembly).toMatchObject({
      tool: expect.stringMatching(/:clang$/),
      arguments: expect.arrayContaining(['-D__ASSEMBLY__', '-x', 'assembler-with-cpp']),
    });
    expect(assembly.arguments).not.toContain('@packs/platform/sdk/flags/cpp_flags');
    expect(assembly.inputs).not.toContainEqual(expect.objectContaining({
      path: 'packs/platform/sdk/flags/cpp_flags',
    }));
  });

  it('makes include-only Library Pack fragments available without compiling them', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const library = {
      name: 'CircularBuffer', version: '1.4.0', packId: 'arduino-lib-circularbuffer', revision: hashes.library,
      dependencies: [],
    };
    const ir = await createEsp32BrowserBuildIR({
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [{ name: library.name, version: library.version }],
      files: [{ name: 'main.ino', content: '#include <CircularBuffer.h>\nvoid setup() {}\nvoid loop() {}\n' }],
    }, capability([library]), {
      platformManifest: platformManifest(), flashManifest, boardManifest, sdkManifest: sdkManifest(),
      compilerManifest: { version: '22.0.0' },
      librarySources: [{
        packId: library.packId,
        includeDirs: ['src'],
        files: [
          { path: 'src/CircularBuffer.h', content: '#include "CircularBuffer.hpp"\n' },
          { path: 'src/CircularBuffer.hpp', content: '#include "CircularBuffer.tpp"\n' },
          { path: 'src/CircularBuffer.tpp', content: 'template <typename T> class CircularBuffer {};\n' },
        ],
      }],
    });

    const projectCompile = ir.graph.actions.find((action: { id: string }) => action.id.startsWith('compile-project-'));
    expect(projectCompile.inputs).toContainEqual(expect.objectContaining({
      path: 'packs/libraries/arduino-lib-circularbuffer/src/CircularBuffer.tpp',
      role: 'library-include-fragment',
    }));
    expect(ir.graph.actions.some((action: { id: string }) => action.id.startsWith('compile-library-'))).toBe(false);
  });

  it('binds each canonical language response file only to its C, C++, or ASM Action', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const ir = await createEsp32BrowserBuildIR({
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [],
      files: [
        { name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' },
        { name: 'helper.c', content: '#include <stdint.h>\nint helper(void) { return (int)sizeof(uint8_t); }\n' },
        { name: 'helper.cpp', content: 'int helper_cpp() { return 2; }\n' },
        { name: 'startup.S', content: '.text\n.global helper_asm\nhelper_asm:\n  ret\n' },
      ],
    }, capability(), { platformManifest: platformManifest(), flashManifest, boardManifest, sdkManifest: sdkManifest(), compilerManifest: { version: '22.0.0' }, librarySources: [] });
    const actionFor = (suffix: string) => ir.graph.actions.find((action: any) => (
      action.kind === 'compile' && action.compileUnit?.source.endsWith(suffix)
    ));
    const cases = [
      { suffix: 'helper.c', response: 'c_flags', sha256: hashes.cFlags },
      { suffix: 'helper.cpp', response: 'cpp_flags', sha256: hashes.cxxFlags },
      { suffix: 'startup.S', response: 'S_flags', sha256: hashes.asmFlags },
    ];
    const responsePaths = cases.map(({ response }) => `packs/platform/sdk/flags/${response}`);

    for (const { suffix, response, sha256 } of cases) {
      const action = actionFor(suffix);
      const expectedPath = `packs/platform/sdk/flags/${response}`;
      expect(action.arguments).toContain(`@${expectedPath}`);
      expect(action.compileUnit.flags).toContain(`@${expectedPath}`);
      expect(action.inputs.filter((input: any) => input.role === 'compiler-response-file')).toEqual([{
        path: expectedPath,
        role: 'compiler-response-file',
        sha256,
      }]);
      for (const otherPath of responsePaths.filter((path) => path !== expectedPath)) {
        expect(action.arguments).not.toContain(`@${otherPath}`);
        expect(action.inputs).not.toContainEqual(expect.objectContaining({ path: otherPath }));
      }
    }

    const c = actionFor('helper.c');
    const cxx = actionFor('helper.cpp');
    const asm = actionFor('startup.S');
    expect(c.arguments.filter((argument: string) => argument === '-x')).toHaveLength(1);
    expect(c.arguments.filter((argument: string) => argument === '-std=gnu17')).toHaveLength(1);
    expect(cxx.arguments).toContain('-Wno-error=narrowing');
    expect(asm.arguments.filter((argument: string) => argument === '-x')).toHaveLength(1);
    expect(asm.arguments).toEqual(expect.arrayContaining(['assembler-with-cpp', '-D__ASSEMBLY__']));
    expect(asm.arguments).not.toContain('-std=gnu17');
  });

  it('keys only the matching language Action with each response-file content identity', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const request = {
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [],
      files: [
        { name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' },
        { name: 'helper.c', content: 'int helper(void) { return 1; }\n' },
        { name: 'helper.cpp', content: 'int helper_cpp() { return 2; }\n' },
        { name: 'startup.S', content: '.text\n.global helper_asm\nhelper_asm:\n  ret\n' },
      ],
    };
    const create = (manifest: ReturnType<typeof sdkManifest>) => createEsp32BrowserBuildIR(
      request,
      capability(),
      { platformManifest: platformManifest(), flashManifest, boardManifest, sdkManifest: manifest, librarySources: [] },
    );
    const baseline = await create(sdkManifest());
    const variants = {
      c: await create(sdkManifest(hashes.compileGroup, hashes.linkGroup, { c: 'e'.repeat(64) })),
      cxx: await create(sdkManifest(hashes.compileGroup, hashes.linkGroup, { cxx: 'f'.repeat(64) })),
      asm: await create(sdkManifest(hashes.compileGroup, hashes.linkGroup, { asm: '0'.repeat(64) })),
    };
    const sources = { c: 'helper.c', cxx: 'helper.cpp', asm: 'startup.S' };
    const actionFor = (ir: any, language: keyof typeof sources) => ir.graph.actions.find((action: any) => (
      action.kind === 'compile' && action.compileUnit?.source.endsWith(sources[language])
    ));

    for (const changedLanguage of Object.keys(variants) as Array<keyof typeof variants>) {
      for (const language of Object.keys(sources) as Array<keyof typeof sources>) {
        const changedKey = actionFor(variants[changedLanguage], language).cacheKey;
        const baselineKey = actionFor(baseline, language).cacheKey;
        if (language === changedLanguage) expect(changedKey).not.toBe(baselineKey);
        else expect(changedKey).toBe(baselineKey);
      }
    }
  });

  it('adds validated project macros to every compile Action and its cache identity', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const base = {
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [],
      files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
    };
    const planning = { platformManifest: platformManifest(), flashManifest, boardManifest, sdkManifest: sdkManifest(), compilerManifest: { version: '22.0.0' }, librarySources: [] };
    const plain = await createEsp32BrowserBuildIR(base, capability(), planning);
    const configured = await createEsp32BrowserBuildIR({ ...base, macros: { LV_KCONFIG_IGNORE: true } }, capability(), planning);
    const action = configured.graph.actions.find((candidate: { kind: string }) => candidate.kind === 'compile');
    const plainAction = plain.graph.actions.find((candidate: { kind: string }) => candidate.kind === 'compile');

    expect(action).toMatchObject({
      arguments: expect.arrayContaining(['-DLV_KCONFIG_IGNORE']),
      compileUnit: { macros: expect.objectContaining({ LV_KCONFIG_IGNORE: true }) },
    });
    expect(action.cacheKey).not.toBe(plainAction.cacheKey);
  });

  it('turns project-local libraries into independent Library Packs', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const ir = await createEsp32BrowserBuildIR({
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [],
      files: [
        { name: 'main.ino', content: '#include <Local.h>\nvoid setup() {}\nvoid loop() {}\n' },
        { name: 'libraries/Local/library.properties', content: 'name=Local\nversion=1.0.0\narchitectures=esp32\nlicense=MIT\n' },
        { name: 'libraries/Local/src/Local.h', content: '#pragma once\n' },
        { name: 'libraries/Local/src/Local.cpp', content: '#include "Local.h"\n' },
      ],
    }, capability(), {
      platformManifest: platformManifest(), flashManifest, boardManifest, sdkManifest: sdkManifest(),
      compilerManifest: { version: '22.0.0' }, librarySources: [],
    });
    const localPack = ir.packs.libraries.packs.find((pack: { name: string }) => pack.name === 'Local');
    expect(localPack).toMatchObject({ kind: 'library', license: 'MIT' });
    expect(ir.graph.actions.some((action: { id: string }) => action.id.startsWith('compile-library-'))).toBe(true);
    const project = ir.graph.actions.find((action: { id: string }) => action.id.startsWith('compile-project-'));
    expect(project.inputs.some((input: { path: string }) => input.path.endsWith('libraries/Local/src/Local.cpp'))).toBe(false);
  });

  it('binds Board identity and Variant inputs directly to a schema-v2 Board Pack', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const splitCapability = capability() as any;
    const profile = platformManifest() as any;
    profile.variant = 'esp32c3';
    profile.boardPack = {
      artifactIds: ['variant'],
    };
    const ir = await createEsp32BrowserBuildIR({
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [],
      files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
    }, splitCapability, {
      platformManifest: profile, flashManifest, sdkManifest: sdkManifest(), boardManifest,
      compilerManifest: { version: '22.0.0' }, librarySources: [],
    });

    expect(ir.packs.board).toMatchObject({
      id: 'arduino-esp32c3-board', sha256: hashes.board, variant: 'esp32c3',
    });
    const compile = ir.graph.actions.find((action: { kind: string }) => action.kind === 'compile');
    expect(compile.inputs).toContainEqual({
      path: 'packs/board/variant/pins_arduino.h', sha256: 'a'.repeat(64), role: 'board-variant-file',
    });
    expect(compile.packInputs).toEqual(expect.arrayContaining([expect.objectContaining({
      packId: 'arduino-esp32c3-board', artifactId: 'variant', sha256: hashes.boardGroup, role: 'board-variant-tree',
    })]));
  });

  it('keys compile and link Actions with the exact SDK tree artifact hashes', async () => {
    const { createEsp32BrowserBuildIR } = await import('../public/ck-build-ir-envelope.js');
    const request = {
      board: 'esp32:esp32:esp32c3', options: {}, libraries: [],
      files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
    };
    const create = (manifest: ReturnType<typeof sdkManifest>) => createEsp32BrowserBuildIR(
      request,
      capability(),
      { platformManifest: platformManifest(), flashManifest, boardManifest, sdkManifest: manifest, librarySources: [] },
    );
    const baseline = await create(sdkManifest());
    const changedCompile = await create(sdkManifest('b'.repeat(64), hashes.linkGroup));
    const changedLink = await create(sdkManifest(hashes.compileGroup, 'c'.repeat(64)));
    const action = (ir: any, kind: string) => ir.graph.actions.find((candidate: any) => candidate.kind === kind);

    expect(action(changedCompile, 'compile').cacheKey).not.toBe(action(baseline, 'compile').cacheKey);
    expect(action(changedLink, 'compile').cacheKey).toBe(action(baseline, 'compile').cacheKey);
    expect(action(changedLink, 'link').cacheKey).not.toBe(action(baseline, 'link').cacheKey);
  });
});
