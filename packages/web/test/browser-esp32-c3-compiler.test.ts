import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlatformManifest } from '../../core/src/platform-pack/builder.js';
import { canonicalJson, sha256Hex } from '../../core/src/build-ir/canonical.js';
import { encodeEsp32PartitionCsv } from '../../core/src/esp32/partition-table.js';
import {
  ESP32_C3_DEFAULT_OPTIONS,
  ESP32_DEFAULT_OPTIONS,
  ESP32_S3_DEFAULT_OPTIONS,
  loadEsp32BrowserBuildPlanning,
  materializeEsp32PackArtifactTrees,
  measureEsp32C3Memory,
  normalizeEsp32ProvisioningLinkerLibraries,
  parseEsp32C3CompilerDiagnostics,
} from '../public/esp32/v2/c3-compiler.js';
import {
  ESP32_C3_CLANG_RESOURCE_ARTIFACTS,
  loadEsp32C3Toolchain,
} from '../public/esp32/v2/c3-clang-runtime.js';
import { createEsp32C3V2WorkerActionMessageHandler } from '../public/esp32/v2/c3-worker.js';
const descriptorUrl = 'https://cdn.example.test/esp32/c3/v2/runtime.json';
const POST_LINK_CONTRACT_FLAG = `--ck-post-link-contract=${'d'.repeat(64)}`;
const ESP_SR_MODEL_SIZE = 2468362;
const ESP_SR_MODEL_CAPACITY = 0x2f0000;
const ESP_SR_MODEL_SHA256 = '0312f2dde9581cd604e752fbfa287d687a2acc0631e593a35a24c4a518d75879';
const ESP_SR_MERGE_PATHS = {
  bootloader: 'build/bootloader.bin',
  partitions: 'build/partitions.bin',
  bootApp0: 'build/boot_app0.bin',
  application: 'build/firmware.bin',
  model: 'build/srmodels.bin',
} as const;
const PLATFORM_TEXT = [
  'name=Arduino ESP32',
  'recipe.c.o.pattern=gcc -c {source_file} -o {object_file}',
  'recipe.cpp.o.pattern=g++ -c {source_file} -o {object_file}',
  'recipe.S.o.pattern=gcc -c {source_file} -o {object_file}',
  'recipe.ar.pattern=ar rcs {archive_file_path} {object_file}',
  'recipe.c.combine.pattern=g++ {object_files} {archive_file_path} -o {build.path}/{build.project_name}.elf',
  'recipe.hooks.objcopy.postobjcopy.3.pattern_args=--chip {build.mcu} merge-bin -o "{build.path}/{build.project_name}.merged.bin" {build.bootloader_addr} "{build.path}/{build.project_name}.bootloader.bin" 0x8000 "{build.path}/{build.project_name}.partitions.bin" 0xe000 "{runtime.platform.path}/tools/partitions/boot_app0.bin" 0x10000 "{build.path}/{build.project_name}.bin"',
].join('\n');

function descriptor() {
  return {
    schema: 2,
    id: 'esp32-c3-arduino',
    abi: 1,
    board: 'esp32:esp32:esp32c3',
    packs: [
      {
        role: 'compiler',
        id: 'riscv32-esp-elf-wasm',
        revision: 'a'.repeat(64),
        manifest: 'packs/compiler/toolchain.json',
      },
      {
        role: 'sdk',
        id: 'arduino-esp32c3-sdk',
        revision: 'b'.repeat(64),
        manifest: 'packs/sdk/toolchain.json',
      },
      {
        role: 'board',
        id: 'arduino-esp32c3-board',
        revision: 'c'.repeat(64),
        manifest: 'packs/board/toolchain.json',
      },
    ],
  };
}

function sdkProfile() {
  return {
    schema: 2,
    id: 'arduino-esp32c3-3.3.7-default',
    board: 'esp32:esp32:esp32c3',
    sdkVersion: '3.3.7',
    options: { ...ESP32_C3_DEFAULT_OPTIONS },
    compile: {
      args: [
        'clang++',
        '--target=riscv32-esp-elf',
        '-march=rv32imc_zicsr_zifencei',
        '-mabi=ilp32',
        '-c',
        'sketch.cpp',
        '-o',
        'sketch.o',
      ],
      source: 'sketch.cpp',
      object: 'sketch.o',
      artifactIds: ['compile-vfs'],
    },
    link: {
      args: [
        'clang++',
        '--target=riscv32-esp-elf',
        '-march=rv32imc_zicsr_zifencei',
        '-mabi=ilp32',
        '-nostdlib',
        'sketch.o',
        '-o',
        'firmware.elf',
      ],
      object: 'sketch.o',
      elf: 'firmware.elf',
      artifactIds: ['link-vfs'],
    },
    image: { flashMode: 'dio', flashFrequency: '40m', flashSize: '4MB' },
    flash: {
      bootloader: 'bootloader',
      partitions: 'partitions',
      bootApp0: 'boot-app0',
    },
    boardPack: { artifactIds: ['variant'] },
  };
}

function standardPlatformManifest(
  tools: Array<{ id: string; version: string; sha256: string }> = [],
  version = '3.3.7',
) {
  return createPlatformManifest({
    id: 'espressif-arduino',
    version,
    vendor: 'esp32',
    architecture: 'esp32',
    platformText: PLATFORM_TEXT,
    boardsText: [
      'esp32c3.name=ESP32-C3 Dev Module',
      'esp32c3.build.core=esp32',
      'esp32c3.build.variant=esp32c3',
      'esp32c3.build.bootloader_addr=0x0',
    ].join('\n'),
    tools,
  });
}

function compileLanguageFlags() {
  return {
    c: ['@sdk/flags/c_flags', '-x', 'c', '-std=gnu17'],
    cxx: ['@sdk/flags/cpp_flags'],
    asm: ['@sdk/flags/S_flags', '-x', 'assembler-with-cpp'],
  };
}

function toLegacyPlatformManifest(current: ReturnType<typeof standardPlatformManifest>) {
  const {
    sha256: _sha256,
    schemaVersion: _schemaVersion,
    recipeLowering: _recipeLowering,
    ...shared
  } = current;
  const body = { ...shared, schemaVersion: 1 };
  return { ...body, sha256: sha256Hex(canonicalJson(body)) };
}

function legacyPlatformManifest(
  tools: Array<{ id: string; version: string; sha256: string }> = [],
  version = '3.3.7',
) {
  return toLegacyPlatformManifest(standardPlatformManifest(tools, version));
}
















function riscvElf(type: 1 | 2, floatAbi = 0) {
  const bytes = new Uint8Array(52);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  const view = new DataView(bytes.buffer);
  view.setUint16(16, type, true);
  view.setUint16(18, 243, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, type === 2 ? 0x42000000 : 0, true);
  view.setUint32(36, 1 | floatAbi, true);
  view.setUint16(40, 52, true);
  return bytes;
}

function xtensaElf(type: 1 | 2) {
  const bytes = riscvElf(type);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint16(18, 94, true);
  view.setUint32(36, 0, true);
  return bytes;
}

function sizedRiscvElf() {
  const names = new TextEncoder().encode('\0.flash.text\0.dram0.data\0.dram0.bss\0.shstrtab\0');
  const sectionOffset = 52;
  const sectionCount = 5;
  const stringOffset = sectionOffset + sectionCount * 40;
  const dataOffset = stringOffset + names.byteLength;
  const bytes = new Uint8Array(dataOffset + 120);
  bytes.set(riscvElf(2));
  bytes.set(names, stringOffset);
  const view = new DataView(bytes.buffer);
  view.setUint32(32, sectionOffset, true);
  view.setUint16(46, 40, true);
  view.setUint16(48, sectionCount, true);
  view.setUint16(50, 4, true);
  const section = (index: number, name: number, type: number, offset: number, size: number) => {
    const header = sectionOffset + index * 40;
    view.setUint32(header, name, true);
    view.setUint32(header + 4, type, true);
    view.setUint32(header + 16, offset, true);
    view.setUint32(header + 20, size, true);
  };
  section(1, 1, 1, dataOffset, 100);
  section(2, 13, 1, dataOffset + 100, 20);
  section(3, 25, 8, 0, 30);
  section(4, 36, 3, stringOffset, names.byteLength);
  return bytes;
}

function loadedArtifact(id: string, bytes: Uint8Array, kind = 'data') {
  return { artifact: { id, kind, size: bytes.byteLength }, bytes };
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function splitProfilesFor(profile: ReturnType<typeof sdkProfile>) {
  const variant = profile.board.split(':').at(-1)!;
  const targetEnd = profile.compile.args.indexOf('-c');
  const target = profile.compile.args.slice(2, targetEnd);
  const boardDefine = variant.toUpperCase().replace(/[^A-Z0-9_]/g, '_') + '_DEV';
  const platformProfile = {
    schema: 4,
    id: 'espressif-arduino-3.3.7',
    sdkVersion: profile.sdkVersion,
    platformManifest: legacyPlatformManifest(),
    compile: {
      args: [
        'clang++', profile.compile.args[1]!, '-Wall', '-Os',
        '-c', profile.compile.source, '-o', profile.compile.object,
      ],
      overlaySlots: [
        { id: 'target', index: 2 },
        { id: 'defines', index: 3 },
        { id: 'memory', index: 4 },
        { id: 'variant', index: 5 },
      ],
      source: profile.compile.source,
      object: profile.compile.object,
      artifactIds: [...profile.compile.artifactIds],
    },
    link: {
      args: [
        'clang++', profile.link.args[1]!, '-nostdlib', '-Lsdk/lib',
        profile.link.object, '-Wl,--end-group', '-o', profile.link.elf,
      ],
      overlaySlots: [
        { id: 'target', index: 2 },
        { id: 'memory', index: 3 },
        { id: 'flags', index: 4 },
      ],
      object: profile.link.object,
      elf: profile.link.elf,
      artifactIds: [...profile.link.artifactIds],
    },
  };
  const boardProfile = {
    schema: 3,
    id: `arduino-${variant}-default`,
    board: profile.board,
    sdkVersion: profile.sdkVersion,
    variant,
    options: { ...profile.options },
    artifactIds: [...(profile.boardPack?.artifactIds ?? ['variant'])],
    overlay: {
      compile: {
        target,
        defines: [
          `-DF_CPU=${profile.options.cpu_freq ?? '160000000L'}`,
          `-DARDUINO_${boardDefine}`,
          `-DARDUINO_BOARD="${boardDefine}"`,
          `-DARDUINO_VARIANT="${variant}"`,
          `-DARDUINO_PARTITION_${profile.options.partition_scheme ?? 'default'}`,
        ],
        memory: ['-Isdk/qio_qspi/include'],
        variant: ['-Ivariant'],
      },
      link: {
        target: [...target],
        memory: ['-Lsdk/qio_qspi'],
        flags: ['-Wl,--gc-sections'],
      },
    },
    image: { ...profile.image },
    flash: { ...profile.flash },
  };
  return { platformProfile, boardProfile };
}

function overlaySplitProfiles() {
  const legacy = sdkProfile();
  const platformProfile = {
    schema: 4,
    id: 'espressif-arduino-3.3.7',
    sdkVersion: '3.3.7',
    platformManifest: legacyPlatformManifest(),
    compile: {
      ...legacy.compile,
      artifactIds: ['compile-vfs'],
      args: [
        'clang++', '--target=riscv32-esp-elf', '-Wall', '-Os',
        '-c', 'sketch.cpp', '-o', 'sketch.o',
      ],
      overlaySlots: [
        { id: 'target', index: 2 },
        { id: 'defines', index: 3 },
        { id: 'memory', index: 4 },
        { id: 'variant', index: 5 },
      ],
    },
    link: {
      ...legacy.link,
      artifactIds: ['link-vfs'],
      args: [
        'clang++', '--target=riscv32-esp-elf', '-nostdlib', '-Lsdk/lib',
        'sketch.o', '-Wl,--end-group', '-o', 'firmware.elf',
      ],
      overlaySlots: [
        { id: 'target', index: 2 },
        { id: 'memory', index: 3 },
        { id: 'flags', index: 4 },
      ],
    },
  };
  const boardProfile = {
    schema: 3,
    id: 'arduino-esp32c3-default',
    board: 'esp32:esp32:esp32c3',
    sdkVersion: '3.3.7',
    variant: 'esp32c3',
    options: { ...legacy.options },
    artifactIds: ['variant'],
    overlay: {
      compile: {
        target: ['-march=rv32imc_zicsr_zifencei', '-mabi=ilp32'],
        defines: [
          '-DF_CPU=160000000L',
          '-DARDUINO_ESP32_DEV',
          '-DARDUINO_BOARD="ESP32_DEV"',
          '-DARDUINO_VARIANT="esp32c3"',
          '-DARDUINO_PARTITION_default',
        ],
        memory: ['-Isdk/qio_qspi/include'],
        variant: ['-Ivariant'],
      },
      link: {
        target: ['-march=rv32imc_zicsr_zifencei', '-mabi=ilp32'],
        memory: ['-Lsdk/qio_qspi'],
        flags: ['-Wl,--gc-sections'],
      },
    },
    image: legacy.image,
    flash: legacy.flash,
  };
  return { platformProfile, boardProfile };
}

function currentOverlaySplitProfiles() {
  const { platformProfile: legacyPlatformProfile, boardProfile } = overlaySplitProfiles();
  const { platformManifest: _legacyPlatformManifest, ...platformProfile } = legacyPlatformProfile;
  const platformManifest = standardPlatformManifest();
  const platformManifestBytes = new TextEncoder().encode(JSON.stringify(platformManifest));
  const compilerPack = {
    id: 'riscv32-esp-elf-wasm',
    version: '22.0.0',
    sha256: 'a'.repeat(64),
  };
  return {
    platformProfile: {
      ...platformProfile,
      schema: 5,
      compile: {
        ...platformProfile.compile,
        languageFlags: compileLanguageFlags(),
      },
      platformManifestArtifact: {
        id: 'platform-manifest',
        sha256: sha256(platformManifestBytes),
      },
      platformRef: {
        id: platformManifest.id,
        version: platformManifest.version,
        sha256: platformManifest.sha256,
      },
      sdkVariant: {
        id: 'arduino-esp32c3-sdk',
        sdkTarget: 'esp32c3',
        memoryType: 'qio_qspi',
        compilerPack,
      },
      recipeOrigins: {
        compile: platformManifest.recipeLowering.bindings.compile.cxx,
        link: platformManifest.recipeLowering.bindings.link,
      },
      recipeLowering: {
        status: 'manifest-defined',
        schemaVersion: platformManifest.recipeLowering.schemaVersion,
        sha256: platformManifest.recipeLowering.sha256,
      },
      migration: { legacySchema: 4, legacyArtifact: 'profile' },
    },
    boardProfile: {
      ...boardProfile,
      schema: 4,
      platformRef: {
        id: platformManifest.id,
        version: platformManifest.version,
        sha256: platformManifest.sha256,
        fqbn: boardProfile.board,
      },
      execution: {
        targetTriple: 'riscv32-esp-elf',
        targetArguments: [
          '--target=riscv32-esp-elf',
          '-march=rv32imc_zicsr_zifencei',
          '-mabi=ilp32',
        ],
        elf: { machine: 243, floatAbi: 0 },
      },
      flash: {
        ...boardProfile.flash,
        offsets: { bootloader: '0x0', partitions: '0x8000', bootApp0: '0xe000' },
      },
      migration: { legacySchema: 3, legacyArtifact: 'profile' },
    },
    platformManifest,
  };
}

function bindCurrentPlatformManifest(
  profiles: ReturnType<typeof currentOverlaySplitProfiles>,
  platformManifest: ReturnType<typeof standardPlatformManifest>,
) {
  const identity = {
    id: platformManifest.id,
    version: platformManifest.version,
    sha256: platformManifest.sha256,
  };
  profiles.platformManifest = platformManifest;
  profiles.platformProfile.platformManifestArtifact.sha256 = sha256(
    new TextEncoder().encode(JSON.stringify(platformManifest)),
  );
  profiles.platformProfile.platformRef = { ...identity };
  profiles.boardProfile.platformRef = {
    ...identity,
    fqbn: profiles.boardProfile.board,
  };
  profiles.platformProfile.recipeOrigins = {
    compile: platformManifest.recipeLowering.bindings.compile.cxx,
    link: platformManifest.recipeLowering.bindings.link,
  };
  profiles.platformProfile.recipeLowering = {
    status: 'manifest-defined',
    schemaVersion: platformManifest.recipeLowering.schemaVersion,
    sha256: platformManifest.recipeLowering.sha256,
  };
  return profiles;
}

function currentXtensaEsp32Profiles() {
  const base = currentOverlaySplitProfiles();
  const platformManifest = createPlatformManifest({
    id: 'espressif-arduino',
    version: '3.3.7',
    vendor: 'esp32',
    architecture: 'esp32',
    platformText: PLATFORM_TEXT,
    boardsText: [
      'esp32.name=ESP32 Dev Module',
      'esp32.build.core=esp32',
      'esp32.build.variant=esp32',
      'esp32.build.bootloader_addr=0x1000',
    ].join('\n'),
    runtimeToolPolicy: 'deferred-ck-binding',
  });
  const platformRef = {
    id: platformManifest.id,
    version: platformManifest.version,
    sha256: platformManifest.sha256,
  };
  const platformManifestBytes = new TextEncoder().encode(JSON.stringify(platformManifest));
  const platformProfile = {
    ...base.platformProfile,
    platformManifestArtifact: { id: 'platform-manifest', sha256: sha256(platformManifestBytes) },
    platformRef,
    sdkVariant: {
      id: 'arduino-esp32-sdk',
      sdkTarget: 'esp32',
      memoryType: 'dio_qspi',
      compilerPack: {
        id: 'xtensa-esp-elf-wasm',
        version: '22.0.0',
        sha256: 'a'.repeat(64),
      },
    },
    compile: {
      ...base.platformProfile.compile,
      args: base.platformProfile.compile.args.map((argument) => (
        argument === '--target=riscv32-esp-elf' ? '--target=xtensa-esp-elf' : argument
      )),
    },
    link: {
      ...base.platformProfile.link,
      args: base.platformProfile.link.args.map((argument) => (
        argument === '--target=riscv32-esp-elf' ? '--target=xtensa-esp-elf' : argument
      )),
    },
  };
  const boardProfile = {
    ...base.boardProfile,
    id: 'arduino-esp32-default',
    board: 'esp32:esp32:esp32',
    variant: 'esp32',
    options: { ...ESP32_DEFAULT_OPTIONS },
    platformRef: { ...platformRef, fqbn: 'esp32:esp32:esp32' },
    overlay: {
      compile: {
        target: ['-mcpu=esp32'],
        defines: [
          '-DF_CPU=240000000L',
          '-DARDUINO_ESP32_DEV',
          '-DARDUINO_BOARD="ESP32_DEV"',
          '-DARDUINO_VARIANT="esp32"',
          '-DARDUINO_PARTITION_default',
        ],
        memory: ['-Isdk/dio_qspi/include'],
        variant: ['-Ivariant'],
      },
      link: {
        target: ['-mcpu=esp32'],
        memory: ['-Lsdk/dio_qspi'],
        flags: ['-Wl,--gc-sections'],
      },
    },
    execution: {
      targetTriple: 'xtensa-esp-elf',
      targetArguments: ['--target=xtensa-esp-elf', '-mcpu=esp32'],
      elf: { machine: 94, floatAbi: 0 },
    },
    flash: {
      ...base.boardProfile.flash,
      offsets: { bootloader: '0x1000', partitions: '0x8000', bootApp0: '0xe000' },
    },
  };
  return {
    platformProfile,
    boardProfile,
    platformManifest,
    runtimeDescriptor: {
      schema: 2,
      id: 'esp32-arduino',
      abi: 1,
      board: 'esp32:esp32:esp32',
      packs: [
        {
          role: 'compiler', id: 'xtensa-esp-elf-wasm', revision: 'a'.repeat(64),
          manifest: 'packs/compiler/toolchain.json',
        },
        {
          role: 'sdk', id: 'arduino-esp32-sdk', revision: 'b'.repeat(64),
          manifest: 'packs/sdk/toolchain.json',
        },
        {
          role: 'board', id: 'arduino-esp32-board', revision: 'c'.repeat(64),
          manifest: 'packs/board/toolchain.json',
        },
      ],
    },
  };
}

function currentXtensaEsp32S3SrProfiles() {
  const base = currentXtensaEsp32Profiles();
  const platformManifest = createPlatformManifest({
    id: 'espressif-arduino',
    version: '3.3.7',
    vendor: 'esp32',
    architecture: 'esp32',
    platformText: [
      ...PLATFORM_TEXT.split('\n').slice(0, -1),
      'upload.extra_flags=',
      'recipe.hooks.objcopy.postobjcopy.3.pattern_args=--chip {build.mcu} merge-bin -o "{build.path}/{build.project_name}.merged.bin" --pad-to-size {build.flash_size} --flash-mode keep --flash-freq keep --flash-size keep {build.bootloader_addr} "{build.path}/{build.project_name}.bootloader.bin" 0x8000 "{build.path}/{build.project_name}.partitions.bin" 0xe000 "{runtime.platform.path}/tools/partitions/boot_app0.bin" 0x10000 "{build.path}/{build.project_name}.bin" 0xd10000 "{runtime.platform.path}/tools/esp_sr/srmodels.bin"',
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
      'esp32s3.build.bootloader_addr=0x0',
      'esp32s3.menu.FlashMode.dio=DIO',
      'esp32s3.menu.FlashMode.dio.build.flash_mode=dio',
      'esp32s3.menu.FlashFreq.80=80MHz',
      'esp32s3.menu.FlashFreq.80.build.flash_freq=80m',
      'esp32s3.menu.FlashSize.16M=16MB',
      'esp32s3.menu.FlashSize.16M.build.flash_size=16MB',
      'esp32s3.menu.PartitionScheme.esp_sr_16=ESP SR 16MB',
      'esp32s3.menu.PartitionScheme.esp_sr_16.build.partitions=esp_sr_16',
    ].join('\n'),
    runtimeToolPolicy: 'deferred-ck-binding',
  });
  const platformRef = {
    id: platformManifest.id,
    version: platformManifest.version,
    sha256: platformManifest.sha256,
  };
  const platformManifestBytes = new TextEncoder().encode(JSON.stringify(platformManifest));
  const platformProfile = {
    ...base.platformProfile,
    platformManifestArtifact: { id: 'platform-manifest', sha256: sha256(platformManifestBytes) },
    platformRef,
    sdkVariant: {
      ...base.platformProfile.sdkVariant,
      id: 'arduino-esp32s3-sdk',
      sdkTarget: 'esp32s3',
      memoryType: 'qio_qspi',
    },
    recipeOrigins: {
      compile: platformManifest.recipeLowering.bindings.compile.cxx,
      link: platformManifest.recipeLowering.bindings.link,
    },
    recipeLowering: {
      status: 'manifest-defined',
      schemaVersion: platformManifest.recipeLowering.schemaVersion,
      sha256: platformManifest.recipeLowering.sha256,
    },
  };
  const board = 'esp32:esp32:esp32s3';
  const boardProfile = {
    ...base.boardProfile,
    id: 'arduino-esp32s3-esp-sr-16',
    board,
    variant: 'esp32s3',
    options: {
      ...ESP32_S3_DEFAULT_OPTIONS,
      flash_mode: 'dio', flash_freq: '80m', flash_size: '16MB', partition_scheme: 'esp_sr_16',
    },
    platformRef: { ...platformRef, fqbn: board },
    overlay: {
      compile: {
        target: ['-mcpu=esp32s3'],
        defines: [
          '-DF_CPU=240000000L',
          '-DARDUINO_ESP32S3_DEV',
          '-DARDUINO_BOARD="ESP32S3_DEV"',
          '-DARDUINO_VARIANT="esp32s3"',
          '-DARDUINO_PARTITION_esp_sr_16',
        ],
        memory: ['-Isdk/qio_qspi/include'],
        variant: ['-Ivariant'],
      },
      link: {
        target: ['-mcpu=esp32s3'],
        memory: ['-Lsdk/qio_qspi'],
        flags: ['-Wl,--gc-sections'],
      },
    },
    execution: {
      targetTriple: 'xtensa-esp-elf',
      targetArguments: ['--target=xtensa-esp-elf', '-mcpu=esp32s3'],
      elf: { machine: 94, floatAbi: 0 },
    },
    image: { flashMode: 'dio', flashFrequency: '80m', flashSize: '16MB' },
    flash: {
      bootloader: 'bootloader', partitions: 'partitions', bootApp0: 'boot-app0',
      model: {
        artifactId: 'srmodels', offset: '0xd10000',
        size: ESP_SR_MODEL_SIZE, capacity: ESP_SR_MODEL_CAPACITY,
      },
      offsets: { bootloader: '0x0', partitions: '0x8000', bootApp0: '0xe000' },
    },
  };
  return {
    platformProfile,
    boardProfile,
    platformManifest,
    runtimeDescriptor: {
      schema: 2,
      id: 'esp32-s3-arduino',
      abi: 1,
      board,
      packs: [
        {
          role: 'compiler', id: 'xtensa-esp-elf-wasm', revision: 'a'.repeat(64),
          manifest: 'packs/compiler/toolchain.json',
        },
        {
          role: 'sdk', id: 'arduino-esp32s3-sdk', revision: 'b'.repeat(64),
          manifest: 'packs/sdk/toolchain.json',
        },
        {
          role: 'board', id: 'arduino-esp32s3-board', revision: 'c'.repeat(64),
          manifest: 'packs/board/toolchain.json',
        },
      ],
    },
  };
}

async function loadOverlaySplitPlanning(
  platformProfile: unknown,
  boardProfile: unknown,
  publishedPlatformManifest?: unknown,
  platformManifestArtifact: {
    value?: unknown;
    loadedBytes?: Uint8Array;
    sha256?: string;
    size?: number;
    kind?: string;
    runtimeDescriptor?: ReturnType<typeof descriptor>;
    includeCurrentPlatform?: boolean;
    includeCurrentBoard?: boolean;
    currentPlatformBytes?: Uint8Array;
    currentBoardBytes?: Uint8Array;
    legacyPlatformProfile?: unknown;
    legacyBoardProfile?: unknown;
  } = {},
) {
  const legacyDescriptor = descriptor();
  const runtime = platformManifestArtifact.runtimeDescriptor ?? {
    ...legacyDescriptor,
    schema: 2,
    packs: [
      legacyDescriptor.packs[0],
      legacyDescriptor.packs[1],
      {
        role: 'board', id: 'arduino-esp32c3-board', revision: 'c'.repeat(64),
        manifest: 'packs/board/toolchain.json',
      },
    ],
  };
  const compilerPin = runtime.packs.find((pack) => pack.role === 'compiler')!;
  const sdkPin = runtime.packs.find((pack) => pack.role === 'sdk')!;
  const boardPin = runtime.packs.find((pack) => pack.role === 'board')!;
  const compilerVersion = (platformProfile as {
    sdkVariant?: { compilerPack?: { version?: string } };
  })?.sdkVariant?.compilerPack?.version ?? '22.0.0';
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const includeCurrentPlatform = platformManifestArtifact.includeCurrentPlatform !== false;
  const includeCurrentBoard = platformManifestArtifact.includeCurrentBoard !== false;
  const platformBytes = platformManifestArtifact.currentPlatformBytes ?? encode(platformProfile);
  const boardBytes = platformManifestArtifact.currentBoardBytes ?? encode(boardProfile);
  const legacyPlatformBytes = platformManifestArtifact.legacyPlatformProfile === undefined
    ? undefined
    : encode(platformManifestArtifact.legacyPlatformProfile);
  const legacyBoardBytes = platformManifestArtifact.legacyBoardProfile === undefined
    ? undefined
    : encode(platformManifestArtifact.legacyBoardProfile);
  const manifestBytes = includeCurrentPlatform
    ? encode(platformManifestArtifact.value ?? standardPlatformManifest())
    : undefined;
  const loadedManifestBytes = platformManifestArtifact.loadedBytes ?? manifestBytes;
  const manifestArtifact = manifestBytes
    ? {
      id: 'platform-manifest',
      kind: platformManifestArtifact.kind ?? 'json',
      size: platformManifestArtifact.size ?? manifestBytes.byteLength,
      sha256: platformManifestArtifact.sha256 ?? sha256(manifestBytes),
    }
    : undefined;
  const manifests = new Map([
    [compilerPin.id, {
      schema: 1, id: compilerPin.id, revision: compilerPin.revision,
      version: compilerVersion, artifacts: [],
    }],
    [sdkPin.id, {
      schema: 2, id: sdkPin.id, revision: sdkPin.revision, version: '3.3.7', artifacts: [
        {
          id: 'compile-vfs', kind: 'tree', size: 2, sha256: '4'.repeat(64),
          files: [{ path: 'compile/header.h', offset: 0, length: 2, sha256: '5'.repeat(64) }],
        },
        {
          id: 'link-vfs', kind: 'tree', size: 3, sha256: '6'.repeat(64),
          files: [{ path: 'link/core.a', offset: 0, length: 3, sha256: '7'.repeat(64) }],
        },
        ...(includeCurrentPlatform ? [{
          id: 'profile-v5', kind: 'json', size: platformBytes.byteLength, sha256: sha256(platformBytes),
        }] : []),
        ...(legacyPlatformBytes ? [{
          id: 'profile', kind: 'json', size: legacyPlatformBytes.byteLength, sha256: sha256(legacyPlatformBytes),
        }] : []),
        ...(manifestArtifact ? [manifestArtifact] : []),
      ],
    }],
    [boardPin.id, {
      schema: 2, id: boardPin.id, revision: boardPin.revision, version: '3.3.7', artifacts: [
        { id: 'boot-app0', kind: 'data', size: 1, sha256: '3'.repeat(64) },
        { id: 'bootloader', kind: 'data', size: 1, sha256: '1'.repeat(64) },
        { id: 'partitions', kind: 'data', size: 1, sha256: '2'.repeat(64) },
        ...(includeCurrentBoard ? [{
          id: 'profile-v4', kind: 'json', size: boardBytes.byteLength, sha256: sha256(boardBytes),
        }] : []),
        ...(legacyBoardBytes ? [{
          id: 'profile', kind: 'json', size: legacyBoardBytes.byteLength, sha256: sha256(legacyBoardBytes),
        }] : []),
        {
          id: 'variant', kind: 'tree', size: 4, sha256: '8'.repeat(64),
          files: [{ path: 'variant/pins_arduino.h', offset: 0, length: 4, sha256: '9'.repeat(64) }],
        },
      ],
    }],
  ]);
  const profiles = new Map([
    ...(includeCurrentPlatform ? [[`${sdkPin.id}/profile-v5`, platformBytes] as const] : []),
    ...(includeCurrentBoard ? [[`${boardPin.id}/profile-v4`, boardBytes] as const] : []),
    ...(legacyPlatformBytes ? [[`${sdkPin.id}/profile`, legacyPlatformBytes] as const] : []),
    ...(legacyBoardBytes ? [[`${boardPin.id}/profile`, legacyBoardBytes] as const] : []),
    ...(loadedManifestBytes ? [[`${sdkPin.id}/platform-manifest`, loadedManifestBytes] as const] : []),
  ]);
  return loadEsp32BrowserBuildPlanning({
    descriptor: runtime,
    descriptorUrl,
    publishedPlatformManifest,
    createPackLoader: ({ expectedId }: { expectedId: string }) => ({
      async loadManifest() { return manifests.get(expectedId); },
      async loadArtifact(id: string) {
        const bytes = profiles.get(`${expectedId}/${id}`);
        if (!bytes) throw new Error(`unexpected artifact ${expectedId}/${id}`);
        const manifest = manifests.get(expectedId);
        const artifact = manifest?.artifacts.find((candidate) => candidate.id === id);
        if (!artifact) throw new Error(`missing artifact metadata ${expectedId}/${id}`);
        return { artifact, bytes };
      },
      reset() {},
    }),
  });
}

function putTestTreeFile(tree: Record<string, unknown>, path: string, value: unknown) {
  const segments = path.split('/');
  const leaf = segments.pop()!;
  let directory = tree;
  for (const segment of segments) {
    const current = directory[segment];
    if (!current || typeof current !== 'object' || Array.isArray(current)) directory[segment] = {};
    directory = directory[segment] as Record<string, unknown>;
  }
  directory[leaf] = value;
  return tree;
}

function testTreeFile(tree: Record<string, unknown>, path: string) {
  let value: unknown = tree;
  for (const segment of path.split('/')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function makeHarness({
  profile = sdkProfile(),
  profiles,
  runClang,
  buildImage,
}: {
  profile?: ReturnType<typeof sdkProfile>;
  profiles?: ReturnType<typeof currentOverlaySplitProfiles>
    | ReturnType<typeof overlaySplitProfiles>
    | ReturnType<typeof currentXtensaEsp32S3SrProfiles>;
  runClang?: ReturnType<typeof vi.fn>;
  buildImage?: ReturnType<typeof vi.fn>;
} = {}) {
  const selectedProfiles = profiles ?? currentOverlaySplitProfiles();
  const { platformProfile, boardProfile } = selectedProfiles;
  const espSr16 = boardProfile.options.partition_scheme === 'esp_sr_16';
  const runtimeDescriptor = (selectedProfiles as { runtimeDescriptor?: ReturnType<typeof descriptor> })
    ?.runtimeDescriptor ?? descriptor();
  const compilerPin = runtimeDescriptor.packs.find((pack) => pack.role === 'compiler')!;
  const sdkPin = runtimeDescriptor.packs.find((pack) => pack.role === 'sdk')!;
  const boardPin = runtimeDescriptor.packs.find((pack) => pack.role === 'board')!;
  const profileBytes = new TextEncoder().encode(JSON.stringify(platformProfile));
  const boardProfileBytes = new TextEncoder().encode(JSON.stringify(boardProfile));
  const platformArtifact = platformProfile.schema === 5 ? 'profile-v5' : 'profile';
  const boardArtifact = boardProfile.schema === 4 ? 'profile-v4' : 'profile';
  const platformManifestBytes = platformProfile.schema === 5
    ? new TextEncoder().encode(JSON.stringify(
      'platformManifest' in selectedProfiles ? selectedProfiles.platformManifest : standardPlatformManifest(),
    ))
    : undefined;
  const events: string[] = [];
  const compileBytes = Uint8Array.of(0x11, 0x12);
  const linkBytes = Uint8Array.of(0x21, 0x22, 0x23);
  const variantBytes = Uint8Array.of(0x31, 0x32, 0x33, 0x34);
  const sdkArtifacts = new Map([
    [platformArtifact, loadedArtifact(platformArtifact, profileBytes, 'json')],
    ['compile-vfs', loadedArtifact('compile-vfs', compileBytes, 'tree')],
    ['link-vfs', loadedArtifact('link-vfs', linkBytes, 'tree')],
    ...(platformManifestBytes
      ? [['platform-manifest', loadedArtifact('platform-manifest', platformManifestBytes, 'json')] as const]
      : []),
  ]);
  const boardArtifacts = new Map([
    [boardArtifact, loadedArtifact(boardArtifact, boardProfileBytes, 'json')],
    ['variant', loadedArtifact('variant', variantBytes, 'tree')],
    ['bootloader', loadedArtifact('bootloader', Uint8Array.of(1), 'bin')],
    ['partitions', loadedArtifact('partitions', Uint8Array.of(2), 'bin')],
    ['boot-app0', loadedArtifact('boot-app0', Uint8Array.of(3), 'bin')],
    ...(espSr16 ? [[
      'srmodels', loadedArtifact('srmodels', new Uint8Array(2468362).fill(0x5a), 'bin'),
    ] as const] : []),
  ]);
  const sdkPackId = sdkPin.id;
  const boardPackId = boardPin.id;
  const sdkManifest = {
    schema: 2,
    id: sdkPackId,
    version: profile.sdkVersion,
    revision: 'b'.repeat(64),
    artifacts: [
      {
        id: 'compile-vfs', kind: 'tree', size: compileBytes.byteLength, sha256: sha256(compileBytes),
        files: [{
          path: 'compile/header.h', offset: 0, length: compileBytes.byteLength, sha256: sha256(compileBytes),
        }],
      },
      {
        id: 'link-vfs', kind: 'tree', size: linkBytes.byteLength, sha256: sha256(linkBytes),
        files: [{ path: 'link/core.a', offset: 0, length: linkBytes.byteLength, sha256: sha256(linkBytes) }],
      },
      {
        id: platformArtifact, kind: 'json', size: profileBytes.byteLength, sha256: sha256(profileBytes),
      },
      ...(platformManifestBytes ? [{
        id: 'platform-manifest', kind: 'json', size: platformManifestBytes.byteLength,
        sha256: sha256(platformManifestBytes),
      }] : []),
    ],
  };
  const boardManifest = {
    schema: 2,
    id: boardPackId,
    version: profile.sdkVersion,
    revision: 'c'.repeat(64),
    artifacts: [
      { id: 'boot-app0', kind: 'data', size: 1, sha256: sha256(Uint8Array.of(3)) },
      { id: 'bootloader', kind: 'data', size: 1, sha256: sha256(Uint8Array.of(1)) },
      { id: 'partitions', kind: 'data', size: 1, sha256: sha256(Uint8Array.of(2)) },
      {
        id: boardArtifact, kind: 'json', size: boardProfileBytes.byteLength,
        sha256: sha256(boardProfileBytes),
      },
      ...(espSr16 ? [{
        id: 'srmodels', kind: 'bin', size: 2468362, sha256: ESP_SR_MODEL_SHA256,
      }] : []),
      {
        id: 'variant', kind: 'tree', size: variantBytes.byteLength, sha256: sha256(variantBytes),
        files: [{
          path: 'variant/pins_arduino.h', offset: 0, length: variantBytes.byteLength, sha256: sha256(variantBytes),
        }],
      },
    ],
  };
  const sdkLoader = {
    loadManifest: vi.fn(async () => sdkManifest),
    loadArtifact: vi.fn(async (id: string) => {
      events.push(`sdk:${id}`);
      const artifact = sdkArtifacts.get(id);
      if (!artifact) throw new Error(`missing SDK artifact ${id}`);
      return artifact;
    }),
    reset: vi.fn(() => { events.push('sdk:reset'); }),
  };
  const compilerLoader = {
    loadManifest: vi.fn(async () => ({
      schema: 1,
      id: compilerPin.id,
      version: (platformProfile as { sdkVariant?: { compilerPack?: { version?: string } } })
        .sdkVariant?.compilerPack?.version ?? '22.0.0',
      revision: compilerPin.revision,
      artifacts: [],
    })),
    loadArtifact: vi.fn(),
    reset: vi.fn(() => { events.push('compiler:reset'); }),
  };
  const boardLoader = {
    loadManifest: vi.fn(async () => boardManifest),
    loadArtifact: vi.fn(async (id: string) => {
      events.push(`board:${id}`);
      const artifact = boardArtifacts.get(id);
      if (!artifact) throw new Error(`missing Board artifact ${id}`);
      return artifact;
    }),
    reset: vi.fn(() => { events.push('board:reset'); }),
  };
  const defaultRunClang = vi.fn(async (args: string[], files: Record<string, unknown>) => {
    const type = args.includes('-c') ? 1 : 2;
    const elf = riscvElf(type);
    return type === 1
      ? { ...files, 'sketch.o': elf }
      : { ...files, 'firmware.elf': elf };
  });
  const actualRunClang = runClang ?? defaultRunClang;
  const actualBuildImage = buildImage ?? vi.fn(async () => ({
    image: Uint8Array.of(0xe9, 1, 2, 3),
    elfSha256Embedded: true,
    elfSha256Offset: 0xb0,
  }));
  let tick = 0;
  const dependencies = {
    createPackLoader: vi.fn((config: { expectedId: string }) => {
      if (config.expectedId === compilerPin.id) return compilerLoader;
      if (config.expectedId === sdkPackId) return sdkLoader;
      if (config.expectedId === boardPackId) return boardLoader;
      throw new Error(`unexpected pack ${config.expectedId}`);
    }),
    loadRunClang: vi.fn(async (loader: unknown) => {
      expect(loader).toBe(compilerLoader);
      return actualRunClang;
    }),
    loadToolchain: vi.fn(async (loader: unknown) => {
      expect(loader).toBe(compilerLoader);
      return { runClang: actualRunClang, runLLVM: vi.fn() };
    }),
    preprocess: vi.fn((source: string, { sourceName }: { sourceName: string }) => ({
      cpp: `#include <Arduino.h>\n#line 1 "${sourceName}"\n${source}`,
      sourceName,
      sourceLineCount: source.split('\n').length,
      generatedLineToFunction: new Map(),
    })),
    buildImage: actualBuildImage,
    now: () => ++tick,
  };
  return {
    dependencies,
    events,
    runClang: actualRunClang,
    buildImage: actualBuildImage,
    sdkLoader,
    boardLoader,
  };
}

function espSrMergeAction() {
  const output = 'build/firmware.merged.bin';
  return {
    id: 'transform-merged',
    kind: 'transform',
    tool: 'ck:esp32-merge',
    arguments: [
      '--chip', 'esp32s3', 'merge-bin', '-o', output,
      '--pad-to-size', '16MB',
      '--flash-mode', 'keep', '--flash-freq', 'keep', '--flash-size', 'keep',
      '0x0', ESP_SR_MERGE_PATHS.bootloader,
      '0x8000', ESP_SR_MERGE_PATHS.partitions,
      '0xe000', ESP_SR_MERGE_PATHS.bootApp0,
      '0x10000', ESP_SR_MERGE_PATHS.application,
      '0xd10000', ESP_SR_MERGE_PATHS.model,
    ],
    inputs: [
      { path: ESP_SR_MERGE_PATHS.bootApp0, role: 'boot-app0-image' },
      { path: ESP_SR_MERGE_PATHS.bootloader, role: 'bootloader-image' },
      { path: ESP_SR_MERGE_PATHS.application, role: 'application-image' },
      { path: ESP_SR_MERGE_PATHS.partitions, role: 'partitions-image' },
      { path: ESP_SR_MERGE_PATHS.model, role: 'model-image' },
    ],
    outputs: [{ path: output, kind: 'merged' }],
    dependencies: [
      'transform-application', 'transform-boot-app0', 'transform-bootloader',
      'transform-model', 'transform-partitions',
    ],
    packDependencies: [],
    environment: {},
    transform: {
      input: ESP_SR_MERGE_PATHS.bootloader,
      output,
      format: 'bin',
      flags: [
        '--chip=esp32s3', '--pad-to-size=16MB',
        '--flash-mode=keep', '--flash-freq=keep', '--flash-size=keep',
        POST_LINK_CONTRACT_FLAG,
      ],
    },
  };
}

function espSrRuntimeInputs(model = Uint8Array.of(0x51, 0x52)) {
  return [
    { path: ESP_SR_MERGE_PATHS.model, bytes: model },
    { path: ESP_SR_MERGE_PATHS.bootApp0, bytes: Uint8Array.of(0x31, 0x32) },
    { path: ESP_SR_MERGE_PATHS.application, bytes: Uint8Array.of(0x41) },
    { path: ESP_SR_MERGE_PATHS.bootloader, bytes: Uint8Array.of(0x11, 0x12) },
    { path: ESP_SR_MERGE_PATHS.partitions, bytes: Uint8Array.of(0x21) },
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ESP32-C3 v2 compiler adapter', () => {
  it('removes only the legacy provisioning library from published linker inputs', () => {
    expect(normalizeEsp32ProvisioningLinkerLibraries(
      '-lwifi_provisioning -lespressif__network_provisioning -lesp_wifi\n',
      'ESP32-C3',
    )).toBe('-lespressif__network_provisioning -lesp_wifi\n');
    expect(normalizeEsp32ProvisioningLinkerLibraries(
      '-lespressif__network_provisioning -lesp_wifi\n',
      'ESP32-H2',
    )).toBe('-lespressif__network_provisioning -lesp_wifi\n');
    expect(() => normalizeEsp32ProvisioningLinkerLibraries(
      '-lwifi_provisioning -lwifi_provisioning -lespressif__network_provisioning\n',
      'ESP32-C3',
    )).toThrow(/unexpected response-file shape/);
  });

  it('preprocesses every Arduino tab through the shared Action contract', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const harness = makeHarness();
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });
    const result = await adapter.execute({
      id: 'preprocess-main',
      kind: 'transform',
      tool: 'ck:arduino-preprocess',
      inputs: [
        { path: 'Other.ino', role: 'sketch-tab' },
        { path: 'main.ino', role: 'sketch-main' },
      ],
      outputs: [{ path: 'build/generated/main.cpp' }],
      arguments: ['main.ino', 'Other.ino', '-o', 'build/generated/main.cpp'],
      environment: {},
      transform: {
        input: 'main.ino', output: 'build/generated/main.cpp', format: 'other', flags: [],
      },
    }, [
      { path: 'Other.ino', bytes: new TextEncoder().encode('void loop() {}\n') },
      { path: 'main.ino', bytes: new TextEncoder().encode('void setup() {}\n') },
    ]);

    expect(harness.dependencies.preprocess).toHaveBeenCalledWith(
      'void setup() {}\n#line 1 "Other.ino"\nvoid loop() {}\n',
      { sourceName: 'main.ino' },
    );
    expect(new TextDecoder().decode(result.outputs[0].bytes)).toContain('#line 1 "Other.ino"');
    adapter.close();
  });

  it('rejects malformed multi-tab preprocess Action bundles before preprocessing', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const harness = makeHarness();
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });
    const output = 'build/generated/main.cpp';
    const base = {
      id: 'preprocess-main',
      kind: 'transform',
      tool: 'ck:arduino-preprocess',
      outputs: [{ path: output }],
      environment: {},
      transform: { input: 'main.ino', output, format: 'other', flags: [] },
    };
    const bytes = new TextEncoder().encode('void setup() {}\n');

    await expect(adapter.execute({
      ...base,
      inputs: [
        { path: 'main.ino', role: 'sketch-main' },
        { path: 'MAIN.ino', role: 'sketch-tab' },
      ],
      arguments: ['main.ino', 'MAIN.ino', '-o', output],
    }, [
      { path: 'main.ino', bytes },
      { path: 'MAIN.ino', bytes },
    ])).rejects.toThrow(/sketch paths are invalid/);

    await expect(adapter.execute({
      ...base,
      inputs: [
        { path: 'main.ino', role: 'sketch-main' },
        { path: 'Other.ino', role: 'sketch-tab' },
        { path: 'config.h', role: 'project-header' },
      ],
      arguments: ['main.ino', 'Other.ino', '-o', output],
    }, [
      { path: 'main.ino', bytes },
      { path: 'Other.ino', bytes },
      { path: 'config.h', bytes },
    ])).rejects.toThrow(/sketch inputs are invalid/);

    await expect(adapter.execute({
      ...base,
      inputs: [
        { path: 'main.ino', role: 'source' },
        { path: 'Other.ino', role: 'source' },
      ],
      arguments: ['main.ino', 'Other.ino', '-o', output],
    }, [
      { path: 'main.ino', bytes },
      { path: 'Other.ino', bytes },
    ])).rejects.toThrow(/legacy input is invalid/);

    expect(harness.dependencies.preprocess).not.toHaveBeenCalled();
    adapter.close();
  });

  it('preserves synthetic diagnostic coordinates for the Build IR mapper', () => {
    expect(parseEsp32C3CompilerDiagnostics(
      '<generated>:4:7: error: missing declaration',
      undefined,
      'build/generated/main.cpp',
    )).toEqual([{
      severity: 'error',
      file: '<generated>',
      line: 4,
      column: 7,
      message: 'missing declaration',
    }]);
  });

  it('keeps ordinary diagnostics on the original Arduino tab', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const source = 'build/generated/main.cpp';
    const object = 'build/main.o';
    const runClang = vi.fn(async (
      _args: string[],
      files: Record<string, unknown>,
      options: { stderr?: (bytes: Uint8Array) => void },
    ) => {
      options.stderr?.(new TextEncoder().encode(
        "Other.ino:2:3: error: 'missing' was not declared in this scope\n",
      ));
      return putTestTreeFile({ ...files }, object, riscvElf(1));
    });
    const harness = makeHarness({ runClang });
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });

    const execution = adapter.execute({
      id: 'compile-project-main-ino',
      kind: 'compile',
      tool: 'toolchain:clang++',
      arguments: ['-c', source, '-o', object],
      environment: {},
      inputs: [
        { path: source, role: 'generated-source' },
        { path: 'main.ino', role: 'project-file' },
        { path: 'Other.ino', role: 'project-file' },
      ],
      outputs: [{ path: object }],
      compileUnit: { source },
    }, [
      { path: source, bytes: new TextEncoder().encode('#include <Arduino.h>\n') },
      { path: 'main.ino', bytes: new TextEncoder().encode('int value = 1;\n') },
      { path: 'Other.ino', bytes: new TextEncoder().encode('void setup() {}\nmissing();\n') },
    ]);

    const failure = await execution.catch((error) => error);
    expect(failure).toMatchObject({
      diagnostics: [expect.objectContaining({
        file: 'Other.ino',
        line: 2,
        column: 3,
      })],
    });
    expect(failure.diagnostics[0]).not.toHaveProperty('unmapped');
    adapter.close();
  });

  it('passes Action environment values to the compiler runtime', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const source = 'project/src/fixture.cpp';
    const object = 'build/fixture.o';
    const runClang = vi.fn(async (
      _args: string[],
      files: Record<string, unknown>,
      options: { environment?: Record<string, string> },
    ) => {
      expect(options.environment).toEqual({ CK_TEST_MODE: 'strict' });
      return putTestTreeFile({ ...files }, object, riscvElf(1));
    });
    const harness = makeHarness({ runClang });
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });

    const result = await adapter.execute({
      id: 'compile-environment',
      kind: 'compile',
      tool: 'toolchain:clang++',
      arguments: ['-c', source, '-o', object],
      environment: { CK_TEST_MODE: 'strict' },
      inputs: [{ path: source }],
      outputs: [{ path: object }],
      compileUnit: { source },
    }, [{ path: source, bytes: new TextEncoder().encode('int fixture = 1;\n') }]);

    expect(runClang).toHaveBeenCalledOnce();
    expect(result.cacheable).not.toBe(false);
    adapter.close();
  });

  it('rejects legacy-only Profile artifacts instead of falling back', async () => {
    const current = currentOverlaySplitProfiles();
    const legacy = overlaySplitProfiles();
    await expect(loadOverlaySplitPlanning(
      current.platformProfile,
      current.boardProfile,
      undefined,
      {
        includeCurrentPlatform: false,
        includeCurrentBoard: false,
        legacyPlatformProfile: legacy.platformProfile,
        legacyBoardProfile: legacy.boardProfile,
      },
    )).rejects.toThrow(/current artifact is missing or invalid: profile-v[45]/);
  });

  it('rejects mixed legacy/current Profile artifacts', async () => {
    const current = currentOverlaySplitProfiles();
    const legacy = overlaySplitProfiles();
    await expect(loadOverlaySplitPlanning(
      current.platformProfile,
      current.boardProfile,
      undefined,
      {
        includeCurrentPlatform: false,
        legacyPlatformProfile: legacy.platformProfile,
      },
    )).rejects.toThrow(/mixed legacy\/current Profile artifacts are not allowed/);
    await expect(loadOverlaySplitPlanning(
      current.platformProfile,
      current.boardProfile,
      undefined,
      {
        includeCurrentBoard: false,
        legacyBoardProfile: legacy.boardProfile,
      },
    )).rejects.toThrow(/mixed legacy\/current Profile artifacts are not allowed/);
  });

  it('rejects corrupt current Profile bytes', async () => {
    const current = currentOverlaySplitProfiles();
    const corruptJson = new TextEncoder().encode('{"schema":');
    await expect(loadOverlaySplitPlanning(
      current.platformProfile,
      current.boardProfile,
      undefined,
      {
        currentPlatformBytes: corruptJson,
      },
    )).rejects.toThrow(/Platform profile is not valid UTF-8 JSON/);
    await expect(loadOverlaySplitPlanning(
      current.platformProfile,
      current.boardProfile,
      undefined,
      {
        currentBoardBytes: corruptJson,
      },
    )).rejects.toThrow(/Board profile is not valid UTF-8 JSON/);
  });

  it('uses the same current-only Loader for Worker session initialization', async () => {
    const harness = makeHarness({ profiles: overlaySplitProfiles() });
    const posted: unknown[] = [];
    const handler = createEsp32C3V2WorkerActionMessageHandler({
      dependencies: harness.dependencies,
      postMessage(message: unknown) { posted.push(message); },
    });
    await handler({
      data: {
        abi: 1,
        type: 'init',
        id: 1,
        runtime: { descriptor: descriptor(), descriptorUrl },
      },
    });

    expect(posted).toEqual([
      expect.objectContaining({
        type: 'init-result',
        id: 1,
        ok: false,
        error: expect.objectContaining({
          message: expect.stringMatching(/current artifact is missing or invalid: profile-v[45]/),
        }),
      }),
    ]);
    expect(harness.dependencies.loadToolchain).not.toHaveBeenCalled();
  });

  it('consumes schema-5 Platform and schema-4 Board execution metadata without rebinding Platform identity', async () => {
    const { platformProfile, boardProfile, platformManifest } = currentOverlaySplitProfiles();
    const planning = await loadOverlaySplitPlanning(
      platformProfile,
      boardProfile,
      platformManifest,
    );

    expect(planning.platformManifest).toMatchObject({
      execution: boardProfile.execution,
      flash: boardProfile.flash,
      sdkVariant: platformProfile.sdkVariant,
      compile: { languageFlags: compileLanguageFlags() },
    });
    expect(platformProfile).not.toHaveProperty('platformManifest');
    expect(planning.platformManifest.platformManifest).toEqual(platformManifest);
    expect(planning.platformManifest.platformManifest.tools).toEqual([]);
    expect(planning.platformManifest.platformManifest.sha256).toBe(platformProfile.platformRef.sha256);
    expect(platformManifest.recipeLowering).toMatchObject({
      schemaVersion: 2,
      bindings: {
        compile: { c: 'recipe.c.o', cxx: 'recipe.cpp.o', asm: 'recipe.S.o' },
      },
    });
  });

  it('requires exact current Profile compile language flags', async () => {
    const missing = currentOverlaySplitProfiles();
    delete (missing.platformProfile.compile as { languageFlags?: unknown }).languageFlags;
    await expect(loadOverlaySplitPlanning(missing.platformProfile, missing.boardProfile))
      .rejects.toThrow(/compile Platform profile has an invalid shape/);

    const malformed = currentOverlaySplitProfiles();
    (malformed.platformProfile.compile.languageFlags.cxx as unknown[]).push(1);
    await expect(loadOverlaySplitPlanning(malformed.platformProfile, malformed.boardProfile))
      .rejects.toThrow(/compile cxx language flag is invalid/);

    const extra = currentOverlaySplitProfiles();
    (extra.platformProfile.compile.languageFlags as Record<string, unknown>).common = [];
    await expect(loadOverlaySplitPlanning(extra.platformProfile, extra.boardProfile))
      .rejects.toThrow(/compile language flags has an invalid shape/);
  });

  it('binds schema-5 sdkTarget to the selected Xtensa browser route', async () => {
    const profiles = currentXtensaEsp32Profiles();
    const planning = await loadOverlaySplitPlanning(
      profiles.platformProfile,
      profiles.boardProfile,
      undefined,
      { value: profiles.platformManifest, runtimeDescriptor: profiles.runtimeDescriptor },
    );
    expect(planning.platformManifest).toMatchObject({
      board: 'esp32:esp32:esp32',
      sdkVariant: { sdkTarget: 'esp32' },
      execution: { targetTriple: 'xtensa-esp-elf', elf: { machine: 94, floatAbi: 0 } },
    });

    profiles.platformProfile.sdkVariant.sdkTarget = 'esp32s3';
    await expect(loadOverlaySplitPlanning(
      profiles.platformProfile,
      profiles.boardProfile,
      undefined,
      { value: profiles.platformManifest, runtimeDescriptor: profiles.runtimeDescriptor },
    )).rejects.toThrow(/SDK variant is invalid/);
  });

  it('does not cache output produced by the Xtensa backend fallback arguments', async () => {
    const profiles = currentXtensaEsp32Profiles();
    const source = 'project/main.cpp';
    const output = 'build/fallback.o';
    let invocation = 0;
    const runClang = vi.fn(async (
      args: string[],
      files: Record<string, unknown>,
      options: { stderr?: (bytes: Uint8Array) => void },
    ) => {
      invocation++;
      if (invocation === 1) {
        options.stderr?.(new TextEncoder().encode(
          `${source}:1:1: error: Cannot select: intrinsic %0\n`,
        ));
        return { ...files };
      }
      expect(args).toEqual(expect.arrayContaining(['-O0', '-mtext-section-literals']));
      expect(args).not.toContain('-Os');
      return putTestTreeFile({ ...files }, output, xtensaElf(1));
    });
    const harness = makeHarness({ profiles, runClang });
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: profiles.runtimeDescriptor, descriptorUrl },
      dependencies: harness.dependencies,
    });

    const result = await adapter.execute({
      id: 'compile-xtensa-fallback',
      kind: 'compile',
      tool: 'toolchain:clang++',
      arguments: [
        '--target=xtensa-esp-elf', '-mcpu=esp32', '-Os',
        '-c', source, '-o', output,
      ],
      inputs: [{ path: source }],
      outputs: [{ path: output }],
      compileUnit: { source },
    }, [{ path: source, bytes: new TextEncoder().encode('int value = 1;\n') }]);

    expect(runClang).toHaveBeenCalledTimes(2);
    expect(result.cacheable).toBe(false);
    adapter.close();
  });

  it('uses schema-4 Board ELF metadata when validating compiler output', async () => {
    const profiles = currentOverlaySplitProfiles();
    profiles.boardProfile.overlay.compile.target[1] = '-mabi=ilp32f';
    profiles.boardProfile.overlay.link.target[1] = '-mabi=ilp32f';
    profiles.boardProfile.execution.targetArguments[2] = '-mabi=ilp32f';
    profiles.boardProfile.execution.elf.floatAbi = 0x2;
    const output = 'build/profile-driven.o';
    const runClang = vi.fn(async (_args: string[], files: Record<string, unknown>) => (
      putTestTreeFile({ ...files }, output, riscvElf(1, 0x2))
    ));
    const harness = makeHarness({ profiles, runClang });
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });

    await expect(adapter.execute({
      id: 'profile-driven-elf',
      kind: 'compile',
      tool: 'toolchain:clang++',
      arguments: [
        '--target=riscv32-esp-elf', '-march=rv32imc_zicsr_zifencei', '-mabi=ilp32f',
        '-c', 'project/main.cpp', '-o', output,
      ],
      inputs: [{ path: 'project/main.cpp' }],
      outputs: [{ path: output }],
      compileUnit: { source: 'project/main.cpp' },
    }, [{ path: 'project/main.cpp', bytes: new TextEncoder().encode('int main_value = 1;\n') }]))
      .resolves.toMatchObject({ outputs: [{ path: output }] });
    adapter.close();
  });

  it('rejects tampered schema-5 identity, execution, and flash metadata', async () => {
    const missingId = currentOverlaySplitProfiles();
    delete (missingId.platformProfile as { id?: string }).id;
    await expect(loadOverlaySplitPlanning(
      missingId.platformProfile,
      missingId.boardProfile,
    )).rejects.toThrow(/Platform profile has an invalid shape/);

    const wrongPlatformRef = currentOverlaySplitProfiles();
    wrongPlatformRef.platformProfile.platformRef.sha256 = 'f'.repeat(64);
    await expect(loadOverlaySplitPlanning(
      wrongPlatformRef.platformProfile,
      wrongPlatformRef.boardProfile,
    )).rejects.toThrow(/Platform reference does not match its Manifest/);

    const wrongCompiler = currentOverlaySplitProfiles();
    wrongCompiler.platformProfile.sdkVariant.compilerPack.sha256 = 'f'.repeat(64);
    await expect(loadOverlaySplitPlanning(
      wrongCompiler.platformProfile,
      wrongCompiler.boardProfile,
    )).rejects.toThrow(/execution profile Pack binding is invalid/);

    const wrongSdkTarget = currentOverlaySplitProfiles();
    wrongSdkTarget.platformProfile.sdkVariant.sdkTarget = 'esp32c6';
    await expect(loadOverlaySplitPlanning(
      wrongSdkTarget.platformProfile,
      wrongSdkTarget.boardProfile,
    )).rejects.toThrow(/SDK variant is invalid/);

    const wrongMemory = currentOverlaySplitProfiles();
    wrongMemory.platformProfile.sdkVariant.memoryType = 'dio_qspi';
    await expect(loadOverlaySplitPlanning(
      wrongMemory.platformProfile,
      wrongMemory.boardProfile,
    )).rejects.toThrow(/SDK variant is invalid/);

    const wrongRecipeOrigin = currentOverlaySplitProfiles();
    wrongRecipeOrigin.platformProfile.recipeOrigins.compile = (
      wrongRecipeOrigin.platformManifest.recipeLowering.bindings.compile.c
    );
    await expect(loadOverlaySplitPlanning(
      wrongRecipeOrigin.platformProfile,
      wrongRecipeOrigin.boardProfile,
    )).rejects.toThrow(/recipe origins are invalid/);

    const wrongElf = currentOverlaySplitProfiles();
    wrongElf.boardProfile.execution.elf.machine = 94;
    await expect(loadOverlaySplitPlanning(
      wrongElf.platformProfile,
      wrongElf.boardProfile,
    )).rejects.toThrow(/compiler ELF execution is invalid/);

    const incompleteTarget = currentOverlaySplitProfiles();
    incompleteTarget.boardProfile.execution.targetArguments.splice(2, 1);
    incompleteTarget.boardProfile.overlay.compile.target.splice(1, 1);
    incompleteTarget.boardProfile.overlay.link.target.splice(1, 1);
    await expect(loadOverlaySplitPlanning(
      incompleteTarget.platformProfile,
      incompleteTarget.boardProfile,
    )).rejects.toThrow(/compiler ELF execution is invalid/);

    const wrongOffset = currentOverlaySplitProfiles();
    wrongOffset.boardProfile.flash.offsets.bootloader = '4096';
    await expect(loadOverlaySplitPlanning(
      wrongOffset.platformProfile,
      wrongOffset.boardProfile,
    )).rejects.toThrow(/flash offset is invalid: bootloader/);

    const nonCanonicalOffset = currentOverlaySplitProfiles();
    nonCanonicalOffset.boardProfile.flash.offsets.partitions = '0x9000';
    await expect(loadOverlaySplitPlanning(
      nonCanonicalOffset.platformProfile,
      nonCanonicalOffset.boardProfile,
    )).rejects.toThrow(/flash offsets do not match Platform Manifest/);

    const versionMismatch = currentOverlaySplitProfiles();
    const resignedManifest = standardPlatformManifest([], '3.3.8');
    const resignedIdentity = {
      id: resignedManifest.id,
      version: resignedManifest.version,
      sha256: resignedManifest.sha256,
    };
    versionMismatch.platformProfile.platformRef = { ...resignedIdentity };
    versionMismatch.boardProfile.platformRef = {
      ...resignedIdentity,
      fqbn: versionMismatch.boardProfile.board,
    };
    versionMismatch.platformProfile.platformManifestArtifact.sha256 = sha256(
      new TextEncoder().encode(JSON.stringify(resignedManifest)),
    );
    await expect(loadOverlaySplitPlanning(
      versionMismatch.platformProfile,
      versionMismatch.boardProfile,
      undefined,
      { value: resignedManifest },
    )).rejects.toThrow(/Platform profile version does not match its Manifest/);
  });

  it('rejects tampered schema-5 Platform Manifest artifact bindings and bytes', async () => {
    const wrongArtifactRef = currentOverlaySplitProfiles();
    wrongArtifactRef.platformProfile.platformManifestArtifact.sha256 = 'f'.repeat(64);
    await expect(loadOverlaySplitPlanning(
      wrongArtifactRef.platformProfile,
      wrongArtifactRef.boardProfile,
    )).rejects.toThrow(/Platform Manifest artifact binding is invalid/);

    const tamperedBytes = new TextEncoder().encode(JSON.stringify(standardPlatformManifest()));
    tamperedBytes[tamperedBytes.byteLength - 2] ^= 1;
    const changedPayload = currentOverlaySplitProfiles();
    await expect(loadOverlaySplitPlanning(
      changedPayload.platformProfile,
      changedPayload.boardProfile,
      undefined,
      { loadedBytes: tamperedBytes },
    )).rejects.toThrow(/Platform Manifest artifact checksum does not match its Manifest/);

    const corruptCanonicalHash = currentOverlaySplitProfiles();
    const corruptManifest = { ...corruptCanonicalHash.platformManifest, sha256: 'f'.repeat(64) };
    corruptCanonicalHash.platformProfile.platformRef.sha256 = corruptManifest.sha256;
    corruptCanonicalHash.boardProfile.platformRef.sha256 = corruptManifest.sha256;
    corruptCanonicalHash.platformProfile.platformManifestArtifact.sha256 = sha256(
      new TextEncoder().encode(JSON.stringify(corruptManifest)),
    );
    await expect(loadOverlaySplitPlanning(
      corruptCanonicalHash.platformProfile,
      corruptCanonicalHash.boardProfile,
      undefined,
      { value: corruptManifest },
    )).rejects.toThrow(/Platform Manifest hash mismatch/);
  });

  it('applies current Platform slots from a schema-4 Board overlay without polluting Platform args', async () => {
    const { platformProfile, boardProfile } = currentOverlaySplitProfiles();
    const planning = await loadOverlaySplitPlanning(platformProfile, boardProfile);
    const compileArgs = planning.platformManifest.compile.args;
    const linkArgs = planning.platformManifest.link.args;
    const boardArguments = [
      '-march=rv32imc_zicsr_zifencei',
      '-mabi=ilp32',
      '-DF_CPU=160000000L',
      '-DARDUINO_VARIANT="esp32c3"',
      '-Isdk/qio_qspi/include',
      '-Ivariant',
    ];

    expect(compileArgs).toEqual(expect.arrayContaining(boardArguments));
    expect(linkArgs).toEqual(expect.arrayContaining([
      '-march=rv32imc_zicsr_zifencei', '-mabi=ilp32', '-Lsdk/qio_qspi', '-Wl,--gc-sections',
    ]));
    expect(platformProfile.compile.args).not.toEqual(expect.arrayContaining(boardArguments));
    expect(platformProfile.link.args).not.toEqual(expect.arrayContaining([
      '-march=rv32imc_zicsr_zifencei', '-mabi=ilp32', '-Lsdk/qio_qspi', '-Wl,--gc-sections',
    ]));
    expect(planning.platformManifest).toMatchObject({
      board: 'esp32:esp32:esp32c3',
      variant: 'esp32c3',
      boardPack: { artifactIds: boardProfile.artifactIds },
    });
  });

  it('requires the registry-published Platform Manifest to match the SDK profile', async () => {
    const { platformProfile, boardProfile, platformManifest: published } = currentOverlaySplitProfiles();
    const planning = await loadOverlaySplitPlanning(platformProfile, boardProfile, published);
    expect(planning.platformManifest.platformManifest).toEqual(published);

    const changed = createPlatformManifest({
      id: 'espressif-arduino',
      version: '3.3.7',
      vendor: 'esp32',
      architecture: 'esp32',
      platformText: PLATFORM_TEXT.replace('name=Arduino ESP32', 'name=Changed Arduino ESP32'),
      boardsText: [
        'esp32c3.name=ESP32-C3 Dev Module',
        'esp32c3.build.core=esp32',
        'esp32c3.build.variant=esp32c3',
      ].join('\n'),
    });
    await expect(loadOverlaySplitPlanning(platformProfile, boardProfile, changed))
      .rejects.toThrow(/published Platform Manifest does not match the SDK profile/);
  });

  it('rejects invalid Platform overlay slots and cross-paired split profile schemas', async () => {
    const nonNeutralToolManifest = standardPlatformManifest([{
      id: 'riscv32-esp-elf-wasm', version: '22.0.0', sha256: 'a'.repeat(64),
    }]);
    const nonNeutralTool = bindCurrentPlatformManifest(
      currentOverlaySplitProfiles(),
      nonNeutralToolManifest,
    );
    await expect(loadOverlaySplitPlanning(
      nonNeutralTool.platformProfile,
      nonNeutralTool.boardProfile,
      undefined,
      { value: nonNeutralToolManifest },
    ))
      .rejects.toThrow(/Platform Manifest must be tool-neutral/);

    const corruptManifest = currentOverlaySplitProfiles();
    const corruptValue = { ...corruptManifest.platformManifest, sha256: 'f'.repeat(64) };
    corruptManifest.platformProfile.platformRef.sha256 = corruptValue.sha256;
    corruptManifest.boardProfile.platformRef.sha256 = corruptValue.sha256;
    corruptManifest.platformProfile.platformManifestArtifact.sha256 = sha256(
      new TextEncoder().encode(JSON.stringify(corruptValue)),
    );
    await expect(loadOverlaySplitPlanning(
      corruptManifest.platformProfile,
      corruptManifest.boardProfile,
      undefined,
      { value: corruptValue },
    ))
      .rejects.toThrow(/Platform Manifest hash mismatch/);

    const invalidSlot = currentOverlaySplitProfiles();
    invalidSlot.platformProfile.compile.overlaySlots[0]!.index = 0;
    await expect(loadOverlaySplitPlanning(invalidSlot.platformProfile, invalidSlot.boardProfile))
      .rejects.toThrow(/compile Platform overlay slot is invalid: target/);

    const legacyBoardWithCurrentPlatform = currentOverlaySplitProfiles();
    legacyBoardWithCurrentPlatform.boardProfile.schema = 3;
    await expect(loadOverlaySplitPlanning(
      legacyBoardWithCurrentPlatform.platformProfile,
      legacyBoardWithCurrentPlatform.boardProfile,
    )).rejects.toThrow(/unsupported ESP32-C3 Board profile schema/);

    const currentBoardWithLegacyPlatform = currentOverlaySplitProfiles();
    currentBoardWithLegacyPlatform.platformProfile.schema = 4;
    await expect(loadOverlaySplitPlanning(
      currentBoardWithLegacyPlatform.platformProfile,
      currentBoardWithLegacyPlatform.boardProfile,
    )).rejects.toThrow(/unsupported ESP32-C3 Platform profile schema/);
  });

  it('rejects Board arguments hidden in Platform commands and mismatched memory overlays', async () => {
    const pollutedPlatform = currentOverlaySplitProfiles();
    pollutedPlatform.platformProfile.compile.args.splice(2, 0, '-DF_CPU=160000000L');
    pollutedPlatform.platformProfile.compile.overlaySlots.forEach((slot) => { slot.index += 1; });
    await expect(loadOverlaySplitPlanning(pollutedPlatform.platformProfile, pollutedPlatform.boardProfile))
      .rejects.toThrow(/compile Platform profile contains a Board overlay argument/);

    const wrongTargetPlatform = currentOverlaySplitProfiles();
    wrongTargetPlatform.platformProfile.compile.args.splice(2, 0, '-mcpu=esp32s3');
    wrongTargetPlatform.platformProfile.compile.overlaySlots.forEach((slot) => { slot.index += 1; });
    await expect(loadOverlaySplitPlanning(
      wrongTargetPlatform.platformProfile,
      wrongTargetPlatform.boardProfile,
    )).rejects.toThrow(/compile Platform profile contains a board target argument/);

    const commonDefineInBoard = currentOverlaySplitProfiles();
    commonDefineInBoard.boardProfile.overlay.compile.defines.push('-DARDUINO=99999');
    await expect(loadOverlaySplitPlanning(
      commonDefineInBoard.platformProfile,
      commonDefineInBoard.boardProfile,
    )).rejects.toThrow(/Board defines overlay is invalid/);

    const mismatchedMemory = currentOverlaySplitProfiles();
    mismatchedMemory.boardProfile.overlay.link.memory = ['-Lsdk/dio_qspi'];
    await expect(loadOverlaySplitPlanning(mismatchedMemory.platformProfile, mismatchedMemory.boardProfile))
      .rejects.toThrow(/Board memory overlays do not match/);
  });

  it('rejects image Actions that omit the embedded ELF digest marker', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const harness = makeHarness({
      buildImage: vi.fn(async () => ({ image: Uint8Array.of(0xe9, 1, 2, 3) })),
    });
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });

    await expect(adapter.execute({
      kind: 'transform',
      tool: 'ck:esp32-image',
      transform: {
        input: 'build/firmware.elf',
        output: 'build/firmware.bin',
        flags: [
          '--chip=esp32c3', '--flash-mode=dio', '--flash-freq=40m', '--flash-size=4MB',
          '--elf-sha256-offset=0xb0', POST_LINK_CONTRACT_FLAG,
        ],
      },
    }, [{ path: 'build/firmware.elf', bytes: Uint8Array.of(0x7f) }])).rejects.toMatchObject({
      code: 'image_layout',
      message: 'ESP32-C3 image does not contain the required ELF SHA-256 descriptor',
    });
    expect(harness.buildImage).toHaveBeenCalledWith(expect.any(Uint8Array), {
      flashMode: 'dio', flashFrequency: '40m', flashSize: '4MB',
    });
    adapter.close();
  });

  it('rejects image Actions whose contract digest offset drifts', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const harness = makeHarness();
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });

    await expect(adapter.execute({
      kind: 'transform',
      tool: 'ck:esp32-image',
      transform: {
        input: 'build/firmware.elf',
        output: 'build/firmware.bin',
        flags: [
          '--chip=esp32c3', '--flash-mode=dio', '--flash-freq=40m', '--flash-size=4MB',
          '--elf-sha256-offset=0xc0', POST_LINK_CONTRACT_FLAG,
        ],
      },
    }, [{ path: 'build/firmware.elf', bytes: Uint8Array.of(0x7f) }])).rejects.toMatchObject({
      code: 'image_layout',
      message: 'ESP32-C3 image flags are invalid',
    });
    expect(harness.buildImage).not.toHaveBeenCalled();
    adapter.close();
  });

  it('encodes project-owned partitions.csv with the shared browser-safe codec', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const harness = makeHarness();
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });
    const csv = new TextEncoder().encode(
      'nvs,data,nvs,0x9000,0x5000,\napp,app,ota_0,0x10000,0x100000,\n',
    );
    const table = encodeEsp32PartitionCsv(csv, { flashSizeBytes: 4 * 1024 * 1024 }).bytes;
    const tableSha256 = sha256(table);
    const result = await adapter.execute({
      id: 'transform-partitions',
      kind: 'transform',
      tool: 'platform:gen-esp32part',
      arguments: ['-q', 'partitions.csv', 'build/partitions.bin'],
      inputs: [{ path: 'partitions.csv', role: 'partitions-source', sha256: sha256(csv) }],
      outputs: [{ path: 'build/partitions.bin', kind: 'partitions', sha256: tableSha256 }],
      transform: {
        input: 'partitions.csv', output: 'build/partitions.bin', format: 'partition',
        flags: ['--quiet=true', POST_LINK_CONTRACT_FLAG],
      },
    }, [{ path: 'partitions.csv', bytes: csv }]);

    expect(result).toEqual({
      outputs: [{
        path: 'build/partitions.bin',
        bytes: table,
      }],
      diagnostics: [],
    });
    expect(harness.buildImage).not.toHaveBeenCalled();
    adapter.close();
  });

  it('rejects malformed project partition Actions before producing bytes', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const harness = makeHarness();
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });
    const csv = new TextEncoder().encode(
      'nvs,data,nvs,0x9000,0x5000,\napp,app,factory,0x10000,0x100000,\n',
    );
    const tableSha256 = sha256(
      encodeEsp32PartitionCsv(csv, { flashSizeBytes: 4 * 1024 * 1024 }).bytes,
    );
    const action = {
      id: 'transform-partitions', kind: 'transform', tool: 'platform:gen-esp32part',
      arguments: ['-q', 'partitions.csv', 'build/partitions.bin'],
      inputs: [{ path: 'partitions.csv', role: 'partitions-source', sha256: sha256(csv) }],
      outputs: [{ path: 'build/partitions.bin', kind: 'partitions', sha256: tableSha256 }],
      transform: {
        input: 'partitions.csv', output: 'build/partitions.bin', format: 'partition',
        flags: ['--quiet=true', POST_LINK_CONTRACT_FLAG],
      },
    };

    await expect(adapter.execute({
      ...action,
      arguments: ['-q', 'config/partitions.csv', 'build/partitions.bin'],
    }, [{ path: 'partitions.csv', bytes: csv }])).rejects.toThrow(/arguments are invalid/);
    await expect(adapter.execute({
      ...action,
      transform: { ...action.transform, flags: ['--quiet=false', POST_LINK_CONTRACT_FLAG] },
    }, [{ path: 'partitions.csv', bytes: csv }])).rejects.toThrow(/transform is invalid/);
    const brokenCsv = new TextEncoder().encode('broken,row\n');
    await expect(adapter.execute({
      ...action,
      inputs: [{ ...action.inputs[0], sha256: sha256(brokenCsv) }],
    }, [{ path: 'partitions.csv', bytes: brokenCsv }]))
      .rejects.toMatchObject({ code: 'image_layout', message: expect.stringMatching(/CSV is invalid/) });
    adapter.close();
  });

  it('requires immutable partition source/output SHA-256 contracts and verifies runtime bytes', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const harness = makeHarness();
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });
    const csv = new TextEncoder().encode(
      'nvs,data,nvs,0x9000,0x5000,\napp,app,factory,0x10000,0x100000,\n',
    );
    const tableSha256 = sha256(
      encodeEsp32PartitionCsv(csv, { flashSizeBytes: 4 * 1024 * 1024 }).bytes,
    );
    const action = {
      id: 'transform-partitions', kind: 'transform', tool: 'platform:gen-esp32part',
      arguments: ['-q', 'partitions.csv', 'build/partitions.bin'],
      inputs: [{ path: 'partitions.csv', role: 'partitions-source', sha256: sha256(csv) }],
      outputs: [{ path: 'build/partitions.bin', kind: 'partitions', sha256: tableSha256 }],
      transform: {
        input: 'partitions.csv', output: 'build/partitions.bin', format: 'partition',
        flags: ['--quiet=true', POST_LINK_CONTRACT_FLAG],
      },
    };
    const inputWithoutSha256 = { path: 'partitions.csv', role: 'partitions-source' };

    await expect(adapter.execute({
      ...action,
      inputs: [inputWithoutSha256],
    }, [{ path: 'partitions.csv', bytes: csv }])).rejects.toMatchObject({
      code: 'image_layout',
      message: expect.stringMatching(/input\/output declaration is invalid/),
    });
    await expect(adapter.execute({
      ...action,
      inputs: [{ ...action.inputs[0], sha256: 'not-a-sha256' }],
    }, [{ path: 'partitions.csv', bytes: csv }])).rejects.toMatchObject({
      code: 'image_layout',
      message: expect.stringMatching(/input\/output declaration is invalid/),
    });
    await expect(adapter.execute({
      ...action,
      inputs: [{ ...action.inputs[0], sha256: '0'.repeat(64) }],
    }, [{ path: 'partitions.csv', bytes: csv }])).rejects.toMatchObject({
      code: 'image_layout',
      message: expect.stringMatching(/does not match its immutable SHA-256/),
    });
    await expect(adapter.execute({
      ...action,
      outputs: [{ path: 'build/partitions.bin', kind: 'partitions' }],
    }, [{ path: 'partitions.csv', bytes: csv }])).rejects.toMatchObject({
      code: 'image_layout',
      message: expect.stringMatching(/input\/output declaration is invalid/),
    });
    await expect(adapter.execute({
      ...action,
      outputs: [{ ...action.outputs[0], sha256: 'not-a-sha256' }],
    }, [{ path: 'partitions.csv', bytes: csv }])).rejects.toMatchObject({
      code: 'image_layout',
      message: expect.stringMatching(/input\/output declaration is invalid/),
    });
    await expect(adapter.execute({
      ...action,
      outputs: [{ ...action.outputs[0], sha256: '0'.repeat(64) }],
    }, [{ path: 'partitions.csv', bytes: csv }])).rejects.toMatchObject({
      code: 'image_layout',
      message: expect.stringMatching(/output does not match its planned SHA-256/),
    });
    expect(harness.buildImage).not.toHaveBeenCalled();
    adapter.close();
  });

  it('merges exactly four ESP32 flash segments into an ff-padded raw image', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const harness = makeHarness();
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });
    const output = 'build/firmware.merged.bin';
    const paths = [
      'build/bootloader.bin',
      'build/partitions.bin',
      'build/boot_app0.bin',
      'build/firmware.bin',
    ];
    const result = await adapter.execute({
      id: 'transform-merged',
      kind: 'transform',
      tool: 'ck:esp32-merge',
      arguments: [
        '--chip', 'esp32c3', 'merge-bin', '-o', output,
        '--pad-to-size', '16B',
        '--flash-mode', 'keep', '--flash-freq', 'keep', '--flash-size', 'keep',
        '0x0', paths[0], '0x4', paths[1], '0x8', paths[2], '0xc', paths[3],
      ],
      inputs: paths.map((path) => ({ path, role: 'flash-segment' })),
      outputs: [{ path: output, kind: 'merged' }],
      dependencies: [],
      packDependencies: [],
      resourceLimits: { memoryBytes: 1024, outputBytes: 1024 },
      environment: {},
      transform: {
        input: paths[0], output, format: 'bin',
        flags: [
          '--chip=esp32c3', '--pad-to-size=16B',
          '--flash-mode=keep', '--flash-freq=keep', '--flash-size=keep',
          POST_LINK_CONTRACT_FLAG,
        ],
      },
    }, [
      { path: paths[2], bytes: Uint8Array.of(0x31, 0x32) },
      { path: paths[0], bytes: Uint8Array.of(0x11, 0x12) },
      { path: paths[3], bytes: Uint8Array.of(0x41) },
      { path: paths[1], bytes: Uint8Array.of(0x21) },
    ]);

    expect(result.outputs).toEqual([{
      path: output,
      bytes: Uint8Array.of(
        0x11, 0x12, 0xff, 0xff,
        0x21, 0xff, 0xff, 0xff,
        0x31, 0x32, 0xff, 0xff,
        0x41, 0xff, 0xff, 0xff,
      ),
    }]);
    expect(result.diagnostics).toEqual([]);
    expect(harness.buildImage).not.toHaveBeenCalled();
    adapter.close();
  });

  it('merges the ESP32-S3 esp_sr_16 five-segment graph with sorted declarations', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const profiles = currentXtensaEsp32S3SrProfiles();
    const harness = makeHarness({ profiles });
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: profiles.runtimeDescriptor, descriptorUrl },
      dependencies: harness.dependencies,
    });

    const result = await adapter.execute(espSrMergeAction(), espSrRuntimeInputs());
    const image = result.outputs[0].bytes;
    expect(image.byteLength).toBe(0x1000000);
    expect([...image.slice(0, 4)]).toEqual([0x11, 0x12, 0xff, 0xff]);
    expect(image[0x8000]).toBe(0x21);
    expect([...image.slice(0xe000, 0xe004)]).toEqual([0x31, 0x32, 0xff, 0xff]);
    expect(image[0x10000]).toBe(0x41);
    expect([...image.slice(0xd10000, 0xd10004)]).toEqual([0x51, 0x52, 0xff, 0xff]);
    expect(image[0xffffff]).toBe(0xff);
    expect(result.diagnostics).toEqual([]);
    adapter.close();
  });

  it('rejects drift in the ESP32-S3 esp_sr_16 model merge contract', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const profiles = currentXtensaEsp32S3SrProfiles();
    const harness = makeHarness({ profiles });
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: profiles.runtimeDescriptor, descriptorUrl },
      dependencies: harness.dependencies,
    });
    const action = espSrMergeAction();
    const runtimeInputs = espSrRuntimeInputs();

    await expect(adapter.execute({
      ...action,
      arguments: action.arguments.with(21, '0xd00000'),
    }, runtimeInputs)).rejects.toThrow(/esp_sr_16 model segment is invalid/);
    await expect(adapter.execute({
      ...action,
      arguments: action.arguments.with(6, '15MB'),
      transform: { ...action.transform, flags: action.transform.flags.with(1, '--pad-to-size=15MB') },
    }, runtimeInputs)).rejects.toThrow(/must use a 16MB flash image/);
    await expect(adapter.execute({
      ...action,
      inputs: action.inputs.map((input) => (
        input.path === ESP_SR_MERGE_PATHS.model ? { ...input, role: 'flash-segment' } : input
      )),
    }, runtimeInputs)).rejects.toThrow(/input declaration is invalid/);
    const wrongModelPathInputs = runtimeInputs.map((input) => (
      input.path === ESP_SR_MERGE_PATHS.model ? { ...input, path: 'build/not-srmodels.bin' } : input
    ));
    await expect(adapter.execute(
      {
        ...action,
        arguments: action.arguments.with(22, 'build/not-srmodels.bin'),
        inputs: action.inputs.map((input) => (
          input.path === ESP_SR_MERGE_PATHS.model ? { ...input, path: 'build/not-srmodels.bin' } : input
        )),
      },
      wrongModelPathInputs,
    )).rejects.toThrow(/esp_sr_16 model segment is invalid/);
    await expect(adapter.execute(
      action,
      espSrRuntimeInputs(new Uint8Array(ESP_SR_MODEL_CAPACITY + 1)),
    )).rejects.toThrow(/model exceeds the esp_sr_16 allocation/);
    adapter.close();
  });

  it('rejects malformed ESP32 merge Actions and incomplete runtime inputs', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const harness = makeHarness();
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });
    const output = 'build/firmware.merged.bin';
    const paths = ['build/a.bin', 'build/b.bin', 'build/c.bin', 'build/d.bin'];
    const action = {
      id: 'transform-merged', kind: 'transform', tool: 'ck:esp32-merge',
      arguments: [
        '--chip', 'esp32c3', 'merge-bin', '-o', output,
        '--pad-to-size', '16B',
        '--flash-mode', 'keep', '--flash-freq', 'keep', '--flash-size', 'keep',
        '0x0', paths[0], '0x4', paths[1], '0x8', paths[2], '0xc', paths[3],
      ],
      inputs: paths.map((path) => ({ path })),
      outputs: [{ path: output }],
      transform: {
        input: paths[0], output, format: 'bin',
        flags: [
          '--chip=esp32c3', '--pad-to-size=16B',
          '--flash-mode=keep', '--flash-freq=keep', '--flash-size=keep',
          POST_LINK_CONTRACT_FLAG,
        ],
      },
    };
    const runtimeInputs = paths.map((path, index) => ({ path, bytes: Uint8Array.of(index + 1) }));

    await expect(adapter.execute({
      ...action,
      arguments: action.arguments.with(8, 'dio'),
    }, runtimeInputs)).rejects.toThrow(/arguments are invalid/);

    await expect(adapter.execute({
      ...action,
      outputs: [{ path: 'build/not-the-argument-output.bin' }],
    }, runtimeInputs)).rejects.toThrow(/output path is inconsistent/);

    await expect(adapter.execute(action, runtimeInputs.slice(0, 3)))
      .rejects.toThrow(/runtime input set is invalid/);
    await expect(adapter.execute(action, [
      ...runtimeInputs.slice(0, 3),
      { path: 'build/extra.bin', bytes: Uint8Array.of(4) },
    ])).rejects.toThrow(/runtime input set is invalid/);
    adapter.close();
  });

  it('rejects duplicate, out-of-range, overlapping, and oversized ESP32 merge layouts', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const harness = makeHarness();
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });
    const output = 'build/firmware.merged.bin';
    const paths = ['build/a.bin', 'build/b.bin', 'build/c.bin', 'build/d.bin'];
    const makeAction = (offsets: string[], padSize = '16B', resourceLimits = {}) => ({
      id: 'transform-merged', kind: 'transform', tool: 'ck:esp32-merge',
      arguments: [
        '--chip', 'esp32c3', 'merge-bin', '-o', output,
        '--pad-to-size', padSize,
        '--flash-mode', 'keep', '--flash-freq', 'keep', '--flash-size', 'keep',
        ...offsets.flatMap((offset, index) => [offset, paths[index]]),
      ],
      inputs: paths.map((path) => ({ path })), outputs: [{ path: output }],
      resourceLimits,
      transform: {
        input: paths[0], output, format: 'bin',
        flags: [
          '--chip=esp32c3', `--pad-to-size=${padSize}`,
          '--flash-mode=keep', '--flash-freq=keep', '--flash-size=keep',
          POST_LINK_CONTRACT_FLAG,
        ],
      },
    });
    const oneByteInputs = paths.map((path) => ({ path, bytes: Uint8Array.of(1) }));

    await expect(adapter.execute(makeAction(['0x0', '0x0', '0x8', '0xc']), oneByteInputs))
      .rejects.toThrow(/duplicate offset/);
    await expect(adapter.execute(makeAction(['0x0', '0x4', '0x8', '0x10']), oneByteInputs))
      .rejects.toThrow(/outside the flash image/);
    await expect(adapter.execute(
      makeAction(['0x0', '0x2', '0x8', '0xc']),
      [{ path: paths[0], bytes: Uint8Array.of(1, 2, 3) }, ...oneByteInputs.slice(1)],
    )).rejects.toThrow(/segments overlap/);
    await expect(adapter.execute(makeAction(['0x0', '0x4', '0x8', '0xc'], '33MB'), oneByteInputs))
      .rejects.toThrow(/pad size exceeds its byte limit/);
    await expect(adapter.execute(
      makeAction(['0x0', '0x4', '0x8', '0xc'], '16B', { outputBytes: 15 }),
      oneByteInputs,
    )).rejects.toThrow(/output exceeds its byte limit/);
    adapter.close();
  });

  it('mounts library compile inputs at the same translated path used by compiler arguments', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const source = 'packs/libraries/arduino-lib-fixture/src/nested/deeper/Fixture.cpp';
    const header = 'packs/libraries/arduino-lib-fixture/src/nested/Config.h';
    const translated = 'libraries/arduino-lib-fixture/src/nested/deeper/Fixture.cpp';
    const object = 'build/fixture.o';
    const sourceBytes = new TextEncoder().encode('#include "../Config.h"\nint fixture = 1;\n');
    const compactedSourceBytes = new TextEncoder().encode(
      '#include "arduino-lib-fixture/src/nested/Config.h"\nint fixture = 1;\n',
    );
    const runClang = vi.fn(async (args: string[], files: Record<string, unknown>) => {
      expect(args).toContain(translated);
      expect(args).toContain('-Ilibraries/arduino-lib-fixture');
      expect(args).toContain('-iquotelibraries');
      expect(args).not.toContain('-Ilibraries/arduino-lib-fixture/src/nested');
      expect(args).not.toContain('-Ilibraries/arduino-lib-fixture/src/nested/__ck_parent__');
      expect(testTreeFile(files, translated)).toEqual(compactedSourceBytes);
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/src/nested/Config.h'))
        .toEqual(new TextEncoder().encode('#pragma once\n'));
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/src/nested/__ck_parent__/Config.h'))
        .toBeUndefined();
      return putTestTreeFile({ ...files }, object, riscvElf(1));
    });
    const harness = makeHarness({ runClang });
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });

    const result = await adapter.execute({
      id: 'compile-library-fixture',
      kind: 'compile',
      tool: 'toolchain:clang++',
      arguments: ['-Ipacks/libraries/arduino-lib-fixture', '-c', source, '-o', object],
      inputs: [{ path: source }, { path: header }],
      outputs: [{ path: object }],
      compileUnit: { source },
    }, [
      { path: source, bytes: sourceBytes },
      { path: header, bytes: new TextEncoder().encode('#pragma once\n') },
    ]);

    expect(result.outputs).toEqual([{ path: object, bytes: expect.any(Uint8Array) }]);
    expect(result.cacheable).toBe(false);
    expect(runClang).toHaveBeenCalledTimes(1);
    adapter.close();
  });

  it('does not translate macro values that look like project header paths', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const source = 'packs/libraries/arduino-lib-fixture/src/Fixture.c';
    const object = 'build/fixture.o';
    const macro = '-DLIBRARY_CONF_PATH="library_conf.h"';
    const runClang = vi.fn(async (args: string[], files: Record<string, unknown>) => {
      expect(args).toContain(macro);
      expect(args).not.toContain(`project/${macro}`);
      return putTestTreeFile({ ...files }, object, riscvElf(1));
    });
    const harness = makeHarness({ runClang });
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });

    await adapter.execute({
      id: 'compile-library-config-path',
      kind: 'compile',
      tool: 'toolchain:clang',
      arguments: [macro, '-c', source, '-o', object],
      inputs: [{ path: source }],
      outputs: [{ path: object }],
      compileUnit: { source },
    }, [{ path: source, bytes: new TextEncoder().encode('int fixture = 1;\n') }]);

    expect(runClang).toHaveBeenCalledTimes(1);
    adapter.close();
  });

  it('resolves a parent-relative include from nested library sources to the Pack root', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const source = 'packs/libraries/arduino-lib-fixture/src/font/Fixture.c';
    const header = 'packs/libraries/arduino-lib-fixture/Root.h';
    const translated = 'libraries/arduino-lib-fixture/src/font/Fixture.c';
    const object = 'build/fixture.o';
    const sourceBytes = new TextEncoder().encode('#include "../../Root.h"\nint fixture = ROOT_VALUE;\n');
    const compactedSourceBytes = new TextEncoder().encode(
      '#include "arduino-lib-fixture/Root.h"\nint fixture = ROOT_VALUE;\n',
    );
    const headerBytes = new TextEncoder().encode('#pragma once\n#define ROOT_VALUE 1\n');
    const runClang = vi.fn(async (args: string[], files: Record<string, unknown>) => {
      expect(args).toContain(translated);
      expect(args).toContain('-iquotelibraries');
      expect(testTreeFile(files, translated)).toEqual(compactedSourceBytes);
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/Root.h')).toEqual(headerBytes);
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/src/font/Root.h')).toBeUndefined();
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/__ck_parent__/__ck_parent__/Root.h'))
        .toBeUndefined();
      return putTestTreeFile({ ...files }, object, riscvElf(1));
    });
    const harness = makeHarness({ runClang });
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });

    const result = await adapter.execute({
      id: 'compile-library-pack-root-header',
      kind: 'compile',
      tool: 'toolchain:clang',
      arguments: ['-c', source, '-o', object],
      inputs: [{ path: source }, { path: header }],
      outputs: [{ path: object }],
      compileUnit: { source },
    }, [
      { path: source, bytes: sourceBytes },
      { path: header, bytes: headerBytes },
    ]);

    expect(result.outputs).toEqual([{ path: object, bytes: expect.any(Uint8Array) }]);
    expect(runClang).toHaveBeenCalledTimes(1);
    adapter.close();
  });

  it('keeps browser compatibility include roots out of angle-bracket lookup', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const source = 'packs/libraries/arduino-lib-fixture/src/Codec.c';
    const header = 'packs/libraries/arduino-lib-fixture/src/private/Codec.h';
    const privateAssert = 'packs/libraries/arduino-lib-fixture/src/private/assert.h';
    const object = 'build/fixture.o';
    const privateRoot = 'libraries/arduino-lib-fixture/src/private';
    const translatedSource = 'libraries/arduino-lib-fixture/src/Codec.c';
    const canonicalSource = new TextEncoder().encode(
      '#include "arduino-lib-fixture/src/private/Codec.h"\n',
    );
    const canonicalHeader = new TextEncoder().encode(
      '#include "arduino-lib-fixture/src/private/assert.h"\n',
    );
    const runClang = vi.fn(async (args: string[], files: Record<string, unknown>) => {
      expect(args).toContain('-iquotelibraries');
      expect(args).not.toContain(`-iquote${privateRoot}`);
      expect(args).not.toContain(`-I${privateRoot}`);
      expect(testTreeFile(files, translatedSource)).toEqual(canonicalSource);
      expect(testTreeFile(files, `${privateRoot}/Codec.h`)).toEqual(canonicalHeader);
      return putTestTreeFile({ ...files }, object, riscvElf(1));
    });
    const harness = makeHarness({ runClang });
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });

    await adapter.execute({
      id: 'compile-library-private-header',
      kind: 'compile',
      tool: 'toolchain:clang',
      arguments: ['-c', source, '-o', object],
      inputs: [{ path: source }, { path: header }, { path: privateAssert }],
      outputs: [{ path: object }],
      compileUnit: { source },
    }, [
      { path: source, bytes: new TextEncoder().encode('#include "private/Codec.h"\n') },
      { path: header, bytes: new TextEncoder().encode('#include "assert.h"\n') },
      { path: privateAssert, bytes: new TextEncoder().encode('#pragma once\n') },
    ]);

    expect(runClang).toHaveBeenCalledTimes(1);
    adapter.close();
  });

  it('compacts parent-relative includes while preserving canonical sibling headers', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const source = 'packs/libraries/arduino-lib-fixture/src/debugging/sysmon/Fixture.c';
    const target = 'packs/libraries/arduino-lib-fixture/src/core/Observer.h';
    const sibling = 'packs/libraries/arduino-lib-fixture/src/core/Types.h';
    const translated = 'libraries/arduino-lib-fixture/src/debugging/sysmon/Fixture.c';
    const object = 'build/fixture.o';
    const sourceBytes = new TextEncoder().encode('#include "../../core/Observer.h"\nint fixture = OBSERVER_VALUE;\n');
    const compactedSourceBytes = new TextEncoder().encode(
      '#include "arduino-lib-fixture/src/core/Observer.h"\nint fixture = OBSERVER_VALUE;\n',
    );
    const targetBytes = new TextEncoder().encode('#pragma once\n#include "Types.h"\n#define OBSERVER_VALUE TYPE_VALUE\n');
    const compactedTargetBytes = new TextEncoder().encode(
      '#pragma once\n#include "arduino-lib-fixture/src/core/Types.h"\n#define OBSERVER_VALUE TYPE_VALUE\n',
    );
    const siblingBytes = new TextEncoder().encode('#pragma once\n#define TYPE_VALUE 1\n');
    const runClang = vi.fn(async (args: string[], files: Record<string, unknown>) => {
      expect(args).toContain(translated);
      expect(args).toContain('-iquotelibraries');
      expect(testTreeFile(files, translated)).toEqual(compactedSourceBytes);
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/src/core/Observer.h'))
        .toEqual(compactedTargetBytes);
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/src/core/Types.h'))
        .toEqual(siblingBytes);
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/src/debugging/sysmon/core/Observer.h'))
        .toBeUndefined();
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/src/debugging/sysmon/core/Types.h'))
        .toBeUndefined();
      return putTestTreeFile({ ...files }, object, riscvElf(1));
    });
    const harness = makeHarness({ runClang });
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });

    const result = await adapter.execute({
      id: 'compile-library-no-op-sibling',
      kind: 'compile',
      tool: 'toolchain:clang',
      arguments: ['-c', source, '-o', object],
      inputs: [{ path: source }, { path: target }, { path: sibling }],
      outputs: [{ path: object }],
      compileUnit: { source },
    }, [
      { path: source, bytes: sourceBytes },
      { path: target, bytes: targetBytes },
      { path: sibling, bytes: siblingBytes },
    ]);

    expect(result.outputs).toEqual([{ path: object, bytes: expect.any(Uint8Array) }]);
    expect(runClang).toHaveBeenCalledTimes(1);
    adapter.close();
  });

  it('preserves chained parent-relative wrappers through the isolated library namespace', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const source = 'packs/libraries/arduino-lib-fixture/src/nested/Fixture.cpp';
    const wrapper = 'packs/libraries/arduino-lib-fixture/src/nested/fixed/Config.h';
    const target = 'packs/libraries/arduino-lib-fixture/src/nested/Config.h';
    const sibling = 'packs/libraries/arduino-lib-fixture/src/nested/Types.h';
    const object = 'build/fixture.o';
    const runClang = vi.fn(async (args: string[], files: Record<string, unknown>) => {
      expect(args).toContain('-iquotelibraries');
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/src/nested/Fixture.cpp'))
        .toEqual(new TextEncoder().encode(
          '#include "arduino-lib-fixture/src/nested/fixed/Config.h"\n',
        ));
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/src/nested/Config.h'))
        .toEqual(new TextEncoder().encode(
          '#pragma once\n#include "arduino-lib-fixture/src/nested/Types.h"\n',
        ));
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/src/nested/Types.h'))
        .toEqual(new TextEncoder().encode('#pragma once\n'));
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/src/nested/fixed/Config.h'))
        .toEqual(new TextEncoder().encode(
          '#include "arduino-lib-fixture/src/nested/Config.h"\n',
        ));
      return putTestTreeFile({ ...files }, object, riscvElf(1));
    });
    const harness = makeHarness({ runClang });
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });

    await adapter.execute({
      id: 'compile-library-wrapper',
      kind: 'compile',
      tool: 'toolchain:clang++',
      arguments: ['-c', source, '-o', object],
      inputs: [{ path: source }, { path: wrapper }, { path: target }, { path: sibling }],
      outputs: [{ path: object }],
      compileUnit: { source },
    }, [
      { path: source, bytes: new TextEncoder().encode('#include "fixed/Config.h"\n') },
      { path: wrapper, bytes: new TextEncoder().encode('#include "../Config.h"\n') },
      { path: target, bytes: new TextEncoder().encode('#pragma once\n#include "Types.h"\n') },
      { path: sibling, bytes: new TextEncoder().encode('#pragma once\n') },
    ]);

    expect(runClang).toHaveBeenCalledTimes(1);
    adapter.close();
  });

  it('does not create parent-relative shims for library files unreachable from the compile unit', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const source = 'packs/libraries/arduino-lib-fixture/src/Fixture.cpp';
    const unused = 'packs/libraries/arduino-lib-fixture/src/unused/Wrapper.h';
    const target = 'packs/libraries/arduino-lib-fixture/src/Target.h';
    const object = 'build/fixture.o';
    const runClang = vi.fn(async (_args: string[], files: Record<string, unknown>) => {
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/src/unused/Wrapper.h'))
        .toEqual(new TextEncoder().encode('#include "../Target.h"\n'));
      expect(testTreeFile(files, '__ck_resolved_parent__/libraries/arduino-lib-fixture/src/Target.h'))
        .toBeUndefined();
      return putTestTreeFile({ ...files }, object, riscvElf(1));
    });
    const harness = makeHarness({ runClang });
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });

    await adapter.execute({
      id: 'compile-library-reachable-only',
      kind: 'compile',
      tool: 'toolchain:clang++',
      arguments: ['-c', source, '-o', object],
      inputs: [{ path: source }, { path: unused }, { path: target }],
      outputs: [{ path: object }],
      compileUnit: {
        source,
        includePaths: ['packs/libraries/arduino-lib-fixture/src'],
      },
    }, [
      { path: source, bytes: new TextEncoder().encode('int fixture = 1;\n') },
      { path: unused, bytes: new TextEncoder().encode('#include "../Target.h"\n') },
      { path: target, bytes: new TextEncoder().encode('#pragma once\n') },
    ]);

    expect(runClang).toHaveBeenCalledTimes(1);
    adapter.close();
  });

  it('accepts the library Pack root as a declarative include directory', async () => {
    const { validateEsp32C3LibrarySourcePayload } = await import('../public/esp32/v2/c3-compiler.js');
    const value = {
      schema: 1,
      name: 'Fixture',
      version: '1.0.0',
      architectures: ['esp32'],
      includeDirs: ['.', 'src'],
      files: [
        { path: 'Fixture.h', content: '#pragma once\n#include "src/Detail.h"\n' },
        { path: 'src/Detail.h', content: '#pragma once\n' },
      ],
    };
    const selection = {
      name: 'Fixture', version: '1.0.0', packId: 'arduino-lib-fixture',
    };
    expect(validateEsp32C3LibrarySourcePayload(value, selection).includePaths).toEqual([
      'libraries/arduino-lib-fixture',
      'libraries/arduino-lib-fixture/src',
    ]);
  });

  it('maps a project configuration header for library includes that escape the Pack root', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const source = 'packs/libraries/arduino-lib-fixture/src/lv_conf_internal.h';
    const translated = 'libraries/arduino-lib-fixture/src/lv_conf_internal.h';
    const object = 'build/fixture.o';
    const config = new TextEncoder().encode('#define LV_CONF_H 1\n');
    const shimRoot = '__ck_project_relative__/__ck_parent__/__ck_parent__';
    const runClang = vi.fn(async (args: string[], files: Record<string, unknown>) => {
      expect(args).toContain(translated);
      expect(args).toContain(`-iquote${shimRoot}`);
      expect(args).not.toContain(`-I${shimRoot}`);
      expect(testTreeFile(files, 'project/lv_conf.h')).toEqual(config);
      expect(testTreeFile(files, 'libraries/arduino-lib-fixture/src/lv_conf.h')).toEqual(config);
      expect(testTreeFile(files, '__ck_project_relative__/lv_conf.h')).toEqual(config);
      expect(testTreeFile(files, `${shimRoot}/lv_conf.h`)).toEqual(config);
      return putTestTreeFile({ ...files }, object, riscvElf(1));
    });
    const harness = makeHarness({ runClang });
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });

    const result = await adapter.execute({
      id: 'compile-library-parent-config',
      kind: 'compile',
      tool: 'toolchain:clang',
      arguments: ['-c', source, '-o', object],
      inputs: [
        { path: source, role: 'source' },
        { path: 'lv_conf.h', role: 'project-header' },
      ],
      outputs: [{ path: object }],
      compileUnit: { source },
    }, [
      {
        path: source,
        bytes: new TextEncoder().encode([
          '#if __has_include("lv_conf.h")',
          '#include "lv_conf.h"',
          '#else',
          '#include "../../lv_conf.h"',
          '#endif',
          '',
        ].join('\n')),
      },
      { path: 'lv_conf.h', bytes: config },
    ]);

    expect(result.outputs).toEqual([{ path: object, bytes: expect.any(Uint8Array) }]);
    expect(runClang).toHaveBeenCalledTimes(1);
    adapter.close();
  });

  it('mounts nested project inputs below the project namespace for Action compiles', async () => {
    const { createEsp32BrowserActionExecutor } = await import('../public/esp32/v2/c3-compiler.js');
    const source = 'src/Fixture.cpp';
    const header = 'include/Fixture.h';
    const object = 'build/fixture.o';
    const runClang = vi.fn(async (args: string[], files: Record<string, unknown>) => {
      expect(args).toEqual(expect.arrayContaining([
        '-Iproject', '-Iproject/include', 'project/src/Fixture.cpp', object,
      ]));
      expect(testTreeFile(files, 'project/src/Fixture.cpp')).toEqual(
        new TextEncoder().encode('#include "../include/Fixture.h"\n'),
      );
      expect(testTreeFile(files, 'project/include/Fixture.h')).toEqual(
        new TextEncoder().encode('#pragma once\n'),
      );
      return putTestTreeFile({ ...files }, object, riscvElf(1));
    });
    const harness = makeHarness({ runClang });
    const adapter = await createEsp32BrowserActionExecutor({
      init: { descriptor: descriptor(), descriptorUrl },
      dependencies: harness.dependencies,
    });

    const result = await adapter.execute({
      id: 'compile-project-fixture',
      kind: 'compile',
      tool: 'toolchain:clang++',
      arguments: ['-Iproject', '-Iproject/include', '-c', source, '-o', object],
      inputs: [
        { path: source, role: 'source' },
        { path: header, role: 'project-header' },
      ],
      outputs: [{ path: object }],
      compileUnit: { source },
    }, [
      { path: source, bytes: new TextEncoder().encode('#include "../include/Fixture.h"\n') },
      { path: header, bytes: new TextEncoder().encode('#pragma once\n') },
    ]);

    expect(result.outputs).toEqual([{ path: object, bytes: expect.any(Uint8Array) }]);
    expect(runClang).toHaveBeenCalledTimes(1);
    adapter.close();
  });


  it('materializes only sorted, Manifest-sized verified Pack tree artifacts', async () => {
    const bytes = Uint8Array.of(1, 2);
    const loader = {
      loadManifest: vi.fn(async () => ({
        schema: 2,
        artifacts: [{
          id: 'group', kind: 'tree', size: bytes.byteLength, sha256: sha256(bytes),
          files: [
            { path: 'a/first.h', offset: 0, length: 1, sha256: sha256(bytes.subarray(0, 1)) },
            { path: 'b/second.h', offset: 1, length: 1, sha256: sha256(bytes.subarray(1)) },
          ],
        }],
      })),
      loadArtifact: vi.fn(async () => loadedArtifact('group', bytes, 'tree')),
    };
    const tree = await materializeEsp32PackArtifactTrees(['group'], loader);

    expect(tree).toEqual({ a: { 'first.h': Uint8Array.of(1) }, b: { 'second.h': Uint8Array.of(2) } });
    const wrongSizeLoader = {
      ...loader,
      loadManifest: vi.fn(async () => ({
        schema: 2,
        artifacts: [{
          id: 'group', kind: 'tree', size: 3, sha256: 'a'.repeat(64),
          files: [{ path: 'a.h', offset: 0, length: 3, sha256: 'b'.repeat(64) }],
        }],
      })),
    };
    await expect(materializeEsp32PackArtifactTrees(['group'], wrongSizeLoader))
      .rejects.toThrow(/size does not match/);

    const wrongArtifactHashLoader = {
      ...loader,
      loadManifest: vi.fn(async () => ({
        schema: 2,
        artifacts: [{
          id: 'group', kind: 'tree', size: bytes.byteLength, sha256: 'a'.repeat(64),
          files: [
            { path: 'a/first.h', offset: 0, length: 1, sha256: sha256(bytes.subarray(0, 1)) },
            { path: 'b/second.h', offset: 1, length: 1, sha256: sha256(bytes.subarray(1)) },
          ],
        }],
      })),
    };
    await expect(materializeEsp32PackArtifactTrees(['group'], wrongArtifactHashLoader))
      .rejects.toThrow(/checksum does not match its Manifest/);

    const wrongFileHashLoader = {
      ...loader,
      loadManifest: vi.fn(async () => ({
        schema: 2,
        artifacts: [{
          id: 'group', kind: 'tree', size: bytes.byteLength, sha256: sha256(bytes),
          files: [
            { path: 'a/first.h', offset: 0, length: 1, sha256: 'b'.repeat(64) },
            { path: 'b/second.h', offset: 1, length: 1, sha256: sha256(bytes.subarray(1)) },
          ],
        }],
      })),
    };
    await expect(materializeEsp32PackArtifactTrees(['group'], wrongFileHashLoader))
      .rejects.toThrow(/file checksum mismatch: a\/first\.h/);
  });

  it('mirrors resolvable parent-relative SDK includes for WASI path lookup', async () => {
    const source = new TextEncoder().encode('#include "../../../../controller/esp32c6/esp_bt_cfg.h"\n');
    const target = new TextEncoder().encode('#define BT_CONFIG 1\n');
    const bytes = new Uint8Array(source.byteLength + target.byteLength);
    bytes.set(source, 0);
    bytes.set(target, source.byteLength);
    const loader = {
      loadManifest: vi.fn(async () => ({
        schema: 2,
        artifacts: [{
          id: 'group', kind: 'tree', size: bytes.byteLength, sha256: sha256(bytes),
          files: [
            {
              path: 'sdk/include/bt/include/esp32c6/include/esp_bt.h',
              offset: 0,
              length: source.byteLength,
              sha256: sha256(source),
            },
            {
              path: 'sdk/include/controller/esp32c6/esp_bt_cfg.h',
              offset: source.byteLength,
              length: target.byteLength,
              sha256: sha256(target),
            },
          ],
        }],
      })),
      loadArtifact: vi.fn(async () => loadedArtifact('group', bytes, 'tree')),
    };
    const tree = await materializeEsp32PackArtifactTrees(['group'], loader);

    expect(tree.sdk.include.bt.include.esp32c6.include.controller.esp32c6['esp_bt_cfg.h'])
      .toEqual(target);
  });

  it('reports Arduino-compatible flash and RAM section totals from the linked ELF', () => {
    expect(measureEsp32C3Memory(sizedRiscvElf())).toEqual({
      flashUsed: 120,
      flashTotal: 1_310_720,
      ramUsed: 50,
      ramTotal: 327_680,
    });
    expect(measureEsp32C3Memory(riscvElf(2))).toBeNull();
  });
});





describe('ESP32-C3 v2 Clang runtime', () => {
  it('intercepts every YoWASP compiler payload through the verified pack', async () => {
    const originalFetch = vi.fn(async () => new Response('unexpected network request'));
    const globalRef = { fetch: originalFetch };
    const loadedIds: string[] = [];
    const loader = {
      loadArtifact: vi.fn(async (id: string) => {
        loadedIds.push(id);
        const kind = id.endsWith('.wasm') ? 'wasm' : 'tar';
        return loadedArtifact(id, Uint8Array.of(id.length), kind);
      }),
    };
    const runClang = vi.fn();
    const runLLVM = vi.fn();
    const importModule = vi.fn(async (bundleHref: string) => {
      const base = new URL('./', bundleHref);
      for (const file of Object.keys(ESP32_C3_CLANG_RESOURCE_ARTIFACTS)) {
        const response = await globalRef.fetch(new URL(file, base));
        expect(response.ok).toBe(true);
        expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(1);
      }
      return { runClang, runLLVM };
    });

    await expect(loadEsp32C3Toolchain({
      loader,
      importModule,
      globalRef,
      ResponseClass: Response,
    })).resolves.toEqual({ runClang, runLLVM });

    expect(loadedIds).toEqual(Object.values(ESP32_C3_CLANG_RESOURCE_ARTIFACTS));
    expect(originalFetch).not.toHaveBeenCalled();
    expect(globalRef.fetch).toBe(originalFetch);
    expect(importModule).toHaveBeenCalledWith(expect.stringMatching(/\/clang\/bundle\.js$/));
  });
});
