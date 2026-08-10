import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPlatformManifest, resolvePlatformManifest } from '../../core/src/platform-pack/builder.js';
import { applyOptions, BoardRegistry, resolveOptions } from '../../core/src/toolchain/board.js';
import { resolveEsp32BuildProfile } from '../../core/src/toolchain/esp32.js';
import {
  RUNTIME_TARGETS,
  applyCommandOverlay,
  contentAddressedCompilerManifestPath,
  contentAddressedRuntimePackManifestPath,
  createBoardProfileArtifacts,
  createPlatformProfileArtifacts,
  derivePlatformCommands,
  deriveStaticFlashOffsets,
  parseArgs,
  patchCompilerBundleEnvironment,
  requirePlatformManifestBoard,
  resolvePlatformDefaultsFromBoard,
  runtimeIncludeLayout,
  runtimeLibraryQueryArgs,
  resolveSdkLinkerInputPaths,
  sortPackArtifactsForManifest,
  runtimeToolchainLocation,
} from '../../../scripts/build-browser-esp32c3-runtime.js';

describe('browser ESP32 Xtensa runtime profiles', () => {
  it('retains one shared Platform Manifest identity for every board', () => {
    const full = {
      kind: 'ck-platform-pack', schemaVersion: 1, id: 'platform', version: '1',
      sha256: 'f'.repeat(64),
      boards: [{ fqbn: 'esp32:esp32:esp32c3' }, { fqbn: 'esp32:esp32:esp32c6' }],
      recipes: [], files: [],
    };
    expect(requirePlatformManifestBoard(full, 'esp32:esp32:esp32c3')).toBe(full);
    expect(requirePlatformManifestBoard(full, 'esp32:esp32:esp32c6')).toBe(full);
    expect(() => requirePlatformManifestBoard(full, 'esp32:esp32:esp32p4')).toThrow(/shared CK Platform/);
  });

  it('emits only current profile artifacts from one shared Manifest', () => {
    const manifest = createPlatformManifest({
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      runtimeToolPolicy: 'deferred-ck-binding',
      platformText: [
        'name=Arduino ESP32',
        'recipe.c.o.pattern=gcc -c {source_file} -o {object_file}',
        'recipe.cpp.o.pattern=g++ {source_file} -o {object_file}',
        'recipe.S.o.pattern=gcc -c {source_file} -o {object_file}',
        'recipe.ar.pattern=ar rcs {archive_file_path} {object_file}',
        'recipe.c.combine.pattern=g++ {object_files} -o {build.path}/{build.project_name}.elf',
      ].join('\n'),
      boardsText: [
        'esp32c3.name=ESP32-C3 Dev Module',
        'esp32c3.build.core=esp32',
        'esp32c3.build.variant=esp32c3',
        'esp32c6.name=ESP32-C6 Dev Module',
        'esp32c6.build.core=esp32',
        'esp32c6.build.variant=esp32c6',
      ].join('\n'),
      files: [
        { path: 'cores/esp32/Arduino.h', content: '#pragma once\n' },
        { path: 'variants/esp32c3/pins_arduino.h', content: '#pragma once\n' },
        { path: 'variants/esp32c6/pins_arduino.h', content: '#pragma once\n' },
      ],
    });
    const platformProfile = {
      id: 'espressif-arduino-3.3.7',
      sdkVersion: '3.3.7',
      compile: {
        args: ['clang++', '--target=riscv32-esp-elf', 'sketch.cpp', '-o', 'sketch.o'],
        overlaySlots: [{ id: 'target', index: 2 }],
        source: 'sketch.cpp', object: 'sketch.o', artifactIds: ['compile-tree'],
        languageFlags: {
          c: ['@sdk/flags/c_flags'],
          cxx: ['@sdk/flags/cpp_flags'],
          asm: ['-x', 'assembler-with-cpp', '@sdk/flags/S_flags'],
        },
      },
      link: {
        args: ['clang++', '--target=riscv32-esp-elf', 'sketch.o', '-o', 'firmware.elf'],
        overlaySlots: [{ id: 'target', index: 2 }],
        object: 'sketch.o', elf: 'firmware.elf', artifactIds: ['link-tree'],
      },
      sdkVariant: {
        id: 'arduino-esp32c3-sdk', sdkTarget: 'esp32c3', memoryType: 'dio_qspi',
        compilerPack: {
          id: 'riscv32-esp-elf-wasm', version: '22.0.0', sha256: 'a'.repeat(64),
        },
      },
    };
    const platform = createPlatformProfileArtifacts({
      profile: platformProfile,
      platformManifest: manifest,
    });
    const boardProfile = {
      id: 'arduino-esp32c3-default', board: 'esp32:esp32:esp32c3',
      sdkVersion: '3.3.7', variant: 'esp32c3', options: {},
      artifactIds: ['variant-tree'],
      overlay: {
        compile: { target: ['-march=rv32imc_zicsr_zifencei', '-mabi=ilp32'] },
        link: { target: ['-march=rv32imc_zicsr_zifencei', '-mabi=ilp32'] },
      },
      image: { flashMode: 'dio', flashFrequency: '80m', flashSize: '4MB' },
      flash: {
        bootloader: 'bootloader', partitions: 'partitions', bootApp0: 'boot-app0',
        offsets: { bootloader: '0x0', partitions: '0x8000', bootApp0: '0xe000' },
      },
      execution: {
        targetTriple: 'riscv32-esp-elf',
        targetArguments: [
          '--target=riscv32-esp-elf', '-march=rv32imc_zicsr_zifencei', '-mabi=ilp32',
        ],
        elf: { machine: 243, floatAbi: 0 },
      },
    };
    const board = createBoardProfileArtifacts({
      profile: boardProfile,
      platformManifest: manifest,
    });

    expect(Object.keys(platform).sort()).toEqual(['current', 'platformManifest']);
    expect(Object.keys(board)).toEqual(['current']);
    expect(platform.current.id).toBe('profile-v5');
    expect(board.current.id).toBe('profile-v4');
    expect(platform).not.toHaveProperty('legacy');
    expect(board).not.toHaveProperty('legacy');
    expect(platform.current.profile).toMatchObject({
      schema: 5,
      platformRef: { id: manifest.id, version: manifest.version, sha256: manifest.sha256 },
      platformManifestArtifact: { id: 'platform-manifest', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      sdkVariant: { id: 'arduino-esp32c3-sdk', sdkTarget: 'esp32c3', memoryType: 'dio_qspi' },
      recipeOrigins: { compile: 'recipe.cpp.o', link: 'recipe.c.combine' },
      recipeLowering: {
        status: 'manifest-defined',
        schemaVersion: manifest.recipeLowering.schemaVersion,
        sha256: manifest.recipeLowering.sha256,
      },
      migration: { legacySchema: 4, legacyArtifact: 'profile' },
    });
    expect(platform.current.profile.compile.languageFlags).toEqual({
      c: ['@sdk/flags/c_flags'],
      cxx: ['@sdk/flags/cpp_flags'],
      asm: ['-x', 'assembler-with-cpp', '@sdk/flags/S_flags'],
    });
    expect(platform.current.profile).not.toHaveProperty('platformManifest');
    expect(platform.platformManifest.id).toBe('platform-manifest');
    expect(platform.platformManifest.profile).toBe(manifest);
    expect(platform.platformManifest.profile.boards).toHaveLength(2);
    expect(board.current.profile).toMatchObject({
      schema: 4,
      platformRef: { ...platform.current.profile.platformRef, fqbn: 'esp32:esp32:esp32c3' },
      execution: { elf: { machine: 243, floatAbi: 0 } },
      flash: { offsets: { bootloader: '0x0', partitions: '0x8000', bootApp0: '0xe000' } },
      migration: { legacySchema: 3, legacyArtifact: 'profile' },
    });
    expect(() => createBoardProfileArtifacts({
      profile: {
        ...boardProfile,
        flash: {
          ...boardProfile.flash,
          offsets: { bootloader: '0x0', partitions: '0x0', bootApp0: '0xe000' },
        },
      },
      platformManifest: manifest,
    })).toThrow(/flash offsets are invalid/);

    const schemaOneManifest = { ...manifest, schemaVersion: 1 } as any;
    expect(() => createPlatformProfileArtifacts({
      profile: platformProfile,
      platformManifest: schemaOneManifest,
    })).toThrow(/unsupported platform manifest schema 1/);
    expect(() => createBoardProfileArtifacts({
      profile: boardProfile,
      platformManifest: schemaOneManifest,
    })).toThrow(/unsupported platform manifest schema 1/);
  });

  it('keeps profile-v5 below the control-profile limit when the shared Manifest exceeds it', () => {
    const boardsText = Array.from({ length: 1_200 }, (_, index) => [
      `board${index}.name=Board ${index}`,
      `board${index}.build.core=esp32`,
      `board${index}.build.variant=board${index}`,
      `board${index}.build.extra_flags=-DPROFILE_${index}=${'x'.repeat(1_024)}`,
    ]).flat().join('\n');
    const manifest = createPlatformManifest({
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      runtimeToolPolicy: 'deferred-ck-binding',
      platformText: [
        'name=Arduino ESP32',
        'recipe.c.o.pattern=gcc -c {source_file} -o {object_file}',
        'recipe.cpp.o.pattern=g++ {source_file} -o {object_file}',
        'recipe.S.o.pattern=gcc -c {source_file} -o {object_file}',
        'recipe.ar.pattern=ar rcs {archive_file_path} {object_file}',
        'recipe.c.combine.pattern=g++ {object_files} -o {build.path}/{build.project_name}.elf',
      ].join('\n'),
      boardsText,
    });
    const profiles = createPlatformProfileArtifacts({
      profile: {
        id: 'espressif-arduino-3.3.7', sdkVersion: '3.3.7',
        compile: {
          args: ['clang++', '--target=riscv32-esp-elf', 'sketch.cpp'],
          overlaySlots: [{ id: 'target', index: 2 }],
          source: 'sketch.cpp', object: 'sketch.o', artifactIds: ['compile-tree'],
          languageFlags: {
            c: ['@sdk/flags/c_flags'],
            cxx: ['@sdk/flags/cpp_flags'],
            asm: ['-x', 'assembler-with-cpp', '@sdk/flags/S_flags'],
          },
        },
        link: {
          args: ['clang++', '--target=riscv32-esp-elf', 'sketch.o'],
          overlaySlots: [{ id: 'target', index: 2 }],
          object: 'sketch.o', elf: 'firmware.elf', artifactIds: ['link-tree'],
        },
        sdkVariant: {
          id: 'arduino-esp32c3-sdk', sdkTarget: 'esp32c3', memoryType: 'dio_qspi',
          compilerPack: {
            id: 'riscv32-esp-elf-wasm', version: '22.0.0', sha256: 'a'.repeat(64),
          },
        },
      },
      platformManifest: manifest,
    });
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    expect(bytes(profiles.platformManifest.profile)).toBeGreaterThan(1024 * 1024);
    expect(bytes(profiles.current.profile)).toBeLessThan(1024 * 1024);
  });

  it('sorts Pack artifacts by id and rejects duplicates before writing a Manifest', () => {
    const artifacts = [
      { id: 'variant-000', marker: 3 },
      { id: 'profile-v4', marker: 2 },
      { id: 'boot-app0', marker: 1 },
    ];

    expect(sortPackArtifactsForManifest(artifacts).map(({ id }) => id)).toEqual([
      'boot-app0', 'profile-v4', 'variant-000',
    ]);
    expect(artifacts.map(({ id }) => id)).toEqual(['variant-000', 'profile-v4', 'boot-app0']);
    expect(() => sortPackArtifactsForManifest([
      { id: 'profile-v4' },
      { id: 'profile-v4' },
    ])).toThrow(/pack artifact is duplicated: profile-v4/);
  });

  it('derives complete flash offsets from generated static parts without silent overwrite', () => {
    const parts = [
      { name: 'bootloader.bin', offset: '0x2000' },
      { name: 'partitions.bin', offset: '0x8000' },
      { name: 'boot_app0.bin', offset: '0xe000' },
    ];
    expect(deriveStaticFlashOffsets(parts)).toEqual({
      bootloader: '0x2000', partitions: '0x8000', bootApp0: '0xe000',
    });
    expect(() => deriveStaticFlashOffsets(parts.slice(0, 2))).toThrow(/exactly one boot_app0\.bin/);
    expect(() => deriveStaticFlashOffsets([...parts, parts[0]!])).toThrow(/exactly one bootloader\.bin/);
    expect(() => deriveStaticFlashOffsets(parts.map((part) => (
      part.name === 'partitions.bin' ? { ...part, offset: '32768' } : part
    )))).toThrow(/offset is invalid: partitions\.bin/);
  });

  it('derives an immutable shared compiler path from Pack identity', () => {
    const revision = 'a'.repeat(64);
    expect(contentAddressedCompilerManifestPath('riscv32-esp-elf-wasm', revision))
      .toBe(`../toolchains/riscv32-esp-elf-wasm/${revision}/toolchain.json`);
    expect(() => contentAddressedCompilerManifestPath('../compiler', revision)).toThrow(/content address/);
    expect(() => contentAddressedCompilerManifestPath('riscv32-esp-elf-wasm', 'latest')).toThrow(/content address/);
  });

  it('derives immutable SDK and Board Pack paths from Pack identity', () => {
    const revision = 'b'.repeat(64);
    expect(contentAddressedRuntimePackManifestPath('arduino-esp32c3-sdk', revision))
      .toBe(`../packs/arduino-esp32c3-sdk/${revision}/toolchain.json`);
    expect(() => contentAddressedRuntimePackManifestPath('../sdk', revision)).toThrow(/content address/);
    expect(() => contentAddressedRuntimePackManifestPath('sdk', 'latest')).toThrow(/content address/);
  });

  it('uses an isolated compiler artifact and the three pinned Arduino targets', () => {
    expect(Object.fromEntries(['esp32', 'esp32s2', 'esp32s3'].map((key) => {
      const target = RUNTIME_TARGETS[key as 'esp32' | 'esp32s2' | 'esp32s3'];
      return [key, {
        fqbn: target.fqbn,
        sdkTarget: target.sdkTarget,
        compilerPackage: target.compilerPackage,
        compilerPackId: target.compilerPackId,
        sourceBundleDir: target.sourceBundleDir,
        gccDriverPrefix: target.gccDriverPrefix,
      }];
    }))).toEqual({
      esp32: {
        fqbn: 'esp32:esp32:esp32', sdkTarget: 'esp32',
        compilerPackage: '@sketchforge/esp32-xtensa-clang-wasm',
        compilerPackId: 'xtensa-esp-elf-wasm', sourceBundleDir: 'esp32-xtensa-wasm',
        gccDriverPrefix: 'xtensa-esp32-elf',
      },
      esp32s2: {
        fqbn: 'esp32:esp32:esp32s2', sdkTarget: 'esp32s2',
        compilerPackage: '@sketchforge/esp32-xtensa-clang-wasm',
        compilerPackId: 'xtensa-esp-elf-wasm', sourceBundleDir: 'esp32-xtensa-wasm',
        gccDriverPrefix: 'xtensa-esp32s2-elf',
      },
      esp32s3: {
        fqbn: 'esp32:esp32:esp32s3', sdkTarget: 'esp32s3',
        compilerPackage: '@sketchforge/esp32-xtensa-clang-wasm',
        compilerPackId: 'xtensa-esp-elf-wasm', sourceBundleDir: 'esp32-xtensa-wasm',
        gccDriverPrefix: 'xtensa-esp32s3-elf',
      },
    });
  });

  it('accepts all three Xtensa board selectors and rejects aliases', () => {
    for (const board of ['esp32', 'esp32s2', 'esp32s3'] as const) {
      expect(parseArgs(['--compiler', 'compiler.tgz', '--board', board])).toEqual({
        compiler: 'compiler.tgz', out: undefined, board, help: false,
      });
    }
    expect(() => parseArgs(['--compiler', 'compiler.tgz', '--board', 's3']))
      .toThrow(/unsupported or missing --board value/);
  });

  it('pins option sets that resolve to the expected SDK profiles', () => {
    const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
    for (const target of [RUNTIME_TARGETS.esp32, RUNTIME_TARGETS.esp32s2, RUNTIME_TARGETS.esp32s3]) {
      const definition = boards.get(target.fqbn);
      expect(definition, target.fqbn).toBeDefined();
      const resolved = resolveOptions(definition!, undefined);
      expect(resolved.errors, target.label).toEqual([]);
      const board = applyOptions(definition!, resolved.options);
      expect(resolveEsp32BuildProfile(board, resolved.options).sdkTarget).toBe(target.sdkTarget);
    }
  });

  it('selects the Xtensa GCC root and derives its include and library queries', () => {
    const toolchain = {
      xtensaBinDir: 'C:\\toolchains\\esp-x32\\bin',
      xtensaRootDir: 'C:\\toolchains\\esp-x32',
      riscvBinDir: 'C:\\toolchains\\esp-rv32\\bin',
      riscvRootDir: 'C:\\toolchains\\esp-rv32',
    } as any;
    expect(runtimeToolchainLocation(toolchain, RUNTIME_TARGETS.esp32s3)).toEqual({
      binDir: toolchain.xtensaBinDir,
      rootDir: toolchain.xtensaRootDir,
    });
    expect(runtimeIncludeLayout(toolchain.xtensaRootDir, 'xtensa-esp-elf', '14.2.0')).toEqual({
      cxxInclude: join(toolchain.xtensaRootDir, 'xtensa-esp-elf', 'include', 'c++', '14.2.0'),
      gccInclude: join(toolchain.xtensaRootDir, 'lib', 'gcc', 'xtensa-esp-elf', '14.2.0', 'include'),
      gccIncludeFixed: join(toolchain.xtensaRootDir, 'lib', 'gcc', 'xtensa-esp-elf', '14.2.0', 'include-fixed'),
      sysrootInclude: join(toolchain.xtensaRootDir, 'xtensa-esp-elf', 'include'),
    });
    expect(runtimeLibraryQueryArgs(RUNTIME_TARGETS.esp32s3, 'libgcc.a'))
      .toEqual(['-print-file-name=libgcc.a']);
    expect(runtimeLibraryQueryArgs(RUNTIME_TARGETS.esp32c3, 'libgcc.a'))
      .toEqual(['-march=rv32imc_zicsr_zifencei', '-mabi=ilp32', '-print-file-name=libgcc.a']);
  });

  it('finds the S3 profile-specific sections.ld without accepting ambiguity', () => {
    const root = mkdtempSync(join(tmpdir(), 'sketchforge-linker-inputs-'));
    try {
      const ldRoot = join(root, 'ld');
      const profileRoot = join(root, 'qio_qspi');
      mkdirSync(ldRoot, { recursive: true });
      mkdirSync(profileRoot, { recursive: true });
      writeFileSync(join(ldRoot, 'memory.ld'), 'MEMORY {}\n');
      writeFileSync(join(profileRoot, 'sections.ld'), 'SECTIONS {}\n');

      expect(resolveSdkLinkerInputPaths(root, 'qio_qspi')).toEqual({
        memoryLd: join(ldRoot, 'memory.ld'),
        sectionsLd: join(profileRoot, 'sections.ld'),
      });
      writeFileSync(join(ldRoot, 'sections.ld'), 'SECTIONS {}\n');
      expect(() => resolveSdkLinkerInputPaths(root, 'qio_qspi'))
        .toThrow(/expected exactly one SDK sections\.ld/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lowers Manifest recipes and resolved board properties into split commands', () => {
    const manifest = createPlatformManifest({
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      runtimeToolPolicy: 'deferred-ck-binding',
      platformText: [
        'compiler.path={runtime.tools.compiler.path}/bin/',
        'compiler.prefix=riscv32-esp-elf-',
        'compiler.sdk.path={runtime.platform.path}/tools/sdk/{build.mcu}',
        'compiler.c.cmd={compiler.prefix}gcc',
        'compiler.c.extra_flags=',
        'compiler.c.flags=-MMD -c "@{compiler.sdk.path}/flags/c_flags" -DC_ONLY -Wall -Os',
        'compiler.cpp.cmd={compiler.prefix}g++',
        'compiler.cpp.extra_flags=',
        'compiler.cpp.flags=-MMD -c "@{compiler.sdk.path}/flags/cpp_flags" -DCXX_ONLY -Wall -Os',
        'compiler.S.extra_flags=',
        'compiler.S.flags=-MMD -c -x assembler-with-cpp "@{compiler.sdk.path}/flags/S_flags" -DASM_ONLY -Wall -Os',
        'compiler.cpreprocessor.flags="@{compiler.sdk.path}/flags/defines" -iprefix "{compiler.sdk.path}/include/" "@{compiler.sdk.path}/flags/includes" "-I{compiler.sdk.path}/{build.memory_type}/include"',
        'compiler.c.elf.cmd={compiler.prefix}g++',
        'compiler.c.elf.flags=-nostdlib "-L{compiler.sdk.path}/lib" "-L{compiler.sdk.path}/ld" "-L{compiler.sdk.path}/{build.memory_type}" "@{compiler.sdk.path}/flags/ld_scripts"',
        'compiler.c.elf.libs="@{compiler.sdk.path}/flags/ld_libs"',
        'build.memory_type={build.boot}_qspi',
        'build.extra_flags=-DESP32=ESP32 -DCORE_DEBUG_LEVEL={build.code_debug}',
        'recipe.c.o.pattern="{compiler.path}{compiler.c.cmd}" {compiler.c.extra_flags} {compiler.c.flags} -DF_CPU={build.f_cpu} -DARDUINO={runtime.ide.version} -DARDUINO_{build.board} -DARDUINO_ARCH_ESP32 -DARDUINO_BOARD={build.board} -DARDUINO_VARIANT={build.variant} -DARDUINO_PARTITION_{build.partitions} {build.extra_flags} {compiler.cpreprocessor.flags} {source_file} -o {object_file}',
        'recipe.cpp.o.pattern="{compiler.path}{compiler.cpp.cmd}" {compiler.cpp.extra_flags} {compiler.cpp.flags} -DF_CPU={build.f_cpu} -DARDUINO={runtime.ide.version} -DARDUINO_{build.board} -DARDUINO_ARCH_ESP32 -DARDUINO_BOARD={build.board} -DARDUINO_VARIANT={build.variant} -DARDUINO_PARTITION_{build.partitions} {build.extra_flags} {compiler.cpreprocessor.flags} {source_file} -o {object_file}',
        'recipe.S.o.pattern="{compiler.path}{compiler.c.cmd}" {compiler.S.extra_flags} {compiler.S.flags} -DF_CPU={build.f_cpu} -DARDUINO={runtime.ide.version} -DARDUINO_{build.board} -DARDUINO_ARCH_ESP32 -DARDUINO_BOARD={build.board} -DARDUINO_VARIANT={build.variant} -DARDUINO_PARTITION_{build.partitions} {build.extra_flags} {compiler.cpreprocessor.flags} {source_file} -o {object_file}',
        'recipe.ar.pattern="ar" rcs {archive_file_path} {object_file}',
        'recipe.c.combine.pattern="{compiler.path}{compiler.c.elf.cmd}" {compiler.c.elf.flags} -Wl,--start-group {object_files} {archive_file_path} {build.extra_libs} {compiler.c.elf.libs} -Wl,--end-group -Wl,-EL -o "{build.path}/{build.project_name}.elf"',
      ].join('\n'),
      boardsText: [
        'esp32c3.name=ESP32-C3 Dev Module',
        'esp32c3.build.core=esp32',
        'esp32c3.build.variant=esp32c3',
        'esp32c3.build.board=ESP32C3_DEV',
        'esp32c3.build.mcu=esp32c3',
        'esp32c3.build.tarch=riscv32',
        'esp32c3.build.f_cpu=160000000L',
        'esp32c3.build.boot=dio',
        'esp32c3.build.partitions=default',
        'esp32c3.build.code_debug=0',
        'esp32c3.build.extra_libs=',
      ].join('\n'),
    });
    const resolved = resolvePlatformManifest({ manifest, fqbn: 'esp32:esp32:esp32c3' });
    expect(resolved.resolvedRecipes.map(({ id }) => id)).toEqual([
      'recipe.S.o',
      'recipe.ar',
      'recipe.c.combine',
      'recipe.c.o',
      'recipe.cpp.o',
    ]);
    const resolvedCompile = resolved.resolvedRecipes.find(({ id }) => id === 'recipe.cpp.o')!;
    expect(resolvedCompile.argv).toEqual(expect.arrayContaining([
      '-DF_CPU=160000000L',
      '-DARDUINO_ESP32C3_DEV',
      '-DARDUINO_PARTITION_default',
      '-DCORE_DEBUG_LEVEL=0',
      '{source_file}',
      '{object_file}',
    ]));
    expect(resolvedCompile.argv.join(' ')).not.toMatch(/\{build\.(?:board|code_debug|f_cpu|mcu|partitions|variant)\}/);
    expect(resolvedCompile.placeholders).toEqual([
      'object_file',
      'runtime.ide.version',
      'runtime.platform.path',
      'runtime.tools.compiler.path',
      'source_file',
    ]);
    const resolvedLink = resolved.resolvedRecipes.find(({ id }) => id === 'recipe.c.combine')!;
    expect(resolvedLink.placeholders).toEqual([
      'archive_file_path',
      'build.path',
      'build.project_name',
      'object_files',
      'runtime.platform.path',
      'runtime.tools.compiler.path',
    ]);
    const runtime = {
      cxxVirtualRoot: 'runtime/include/c++/14.2.0',
      gccIncludeVirtual: 'runtime/gcc/include',
      gccIncludeFixedVirtual: 'runtime/gcc/include-fixed',
      sysrootIncludeVirtual: 'runtime/sysroot/include',
      libraryDirectories: [{ virtual: 'runtime/lib/0' }],
    };
    const commands = derivePlatformCommands({
      manifest, resolved, runtime,
      compilerFlags: '-march=rv32imc_zicsr_zifencei -mabi=ilp32 -U__INT32_TYPE__',
    });
    const compile = applyCommandOverlay(commands.compile, commands.overlay.compile);
    const link = applyCommandOverlay(commands.link, commands.overlay.link);

    expect(commands.compile.overlaySlots.map(({ id }) => id))
      .toEqual(['target', 'defines', 'memory', 'variant']);
    expect(commands.link.overlaySlots.map(({ id }) => id))
      .toEqual(['target', 'memory', 'flags']);
    expect(commands.compile.args).not.toContain('-march=rv32imc_zicsr_zifencei');
    expect(commands.compile.args).not.toContain('-DF_CPU=160000000L');
    expect(commands.compile.args.filter((argument) => argument === '-c')).toHaveLength(1);
    expect(commands.compile.args).not.toEqual(expect.arrayContaining([
      '@sdk/flags/c_flags', '@sdk/flags/cpp_flags', '@sdk/flags/S_flags',
    ]));
    expect(commands.compile.languageFlags).toEqual({
      c: ['-MMD', '@sdk/flags/c_flags', '-DC_ONLY', '-Wall', '-Os'],
      cxx: ['-MMD', '@sdk/flags/cpp_flags', '-DCXX_ONLY', '-Wall', '-Os'],
      asm: [
        '-MMD', '-x', 'assembler-with-cpp', '@sdk/flags/S_flags', '-DASM_ONLY', '-Wall', '-Os',
      ],
    });
    for (const [language, ownFlag, foreignFlags] of [
      ['c', '-DC_ONLY', ['-DCXX_ONLY', '-DASM_ONLY']],
      ['cxx', '-DCXX_ONLY', ['-DC_ONLY', '-DASM_ONLY']],
      ['asm', '-DASM_ONLY', ['-DC_ONLY', '-DCXX_ONLY']],
    ] as const) {
      expect(commands.compile.languageFlags[language]).toContain(ownFlag);
      expect(commands.compile.languageFlags[language]).not.toEqual(expect.arrayContaining(foreignFlags));
    }
    expect(commands.overlay.compile.target)
      .toEqual(['-march=rv32imc_zicsr_zifencei', '-mabi=ilp32']);
    expect(commands.overlay.compile).toMatchObject({
      memory: ['-Isdk/dio_qspi/include'],
      variant: ['-Ivariant'],
    });
    expect(commands.overlay.compile.defines).toEqual(expect.arrayContaining([
      '-DF_CPU=160000000L',
      '-DARDUINO_ESP32C3_DEV',
      '-DARDUINO_BOARD="ESP32C3_DEV"',
      '-DARDUINO_VARIANT="esp32c3"',
      '-DARDUINO_PARTITION_default',
      '-DCORE_DEBUG_LEVEL=0',
    ]));
    expect(commands.execution).toEqual({
      targetTriple: 'riscv32-esp-elf',
      targetArguments: ['--target=riscv32-esp-elf', '-march=rv32imc_zicsr_zifencei', '-mabi=ilp32'],
      elf: { machine: 243, floatAbi: 0 },
    });
    expect(compile.slice(0, 4)).toEqual([
      'clang++', '--target=riscv32-esp-elf', '-march=rv32imc_zicsr_zifencei', '-mabi=ilp32',
    ]);
    expect(compile).toContain('runtime/include/c++/14.2.0/riscv32-esp-elf');
    expect(link.slice(0, 4)).toEqual(compile.slice(0, 4));
    expect(link).not.toContain('-fuse-ld=lld');
    expect(link).toContain('@sdk/lld-compat/ld_flags');
    expect(resolved.recipeLowering).toEqual(manifest.recipeLowering);
    expect(manifest.recipeLowering.paths.logicalToAction.prefixes['sdk/'])
      .toBe('packs/platform/sdk/');
    expect({ compile: resolvedCompile.id, link: resolvedLink.id })
      .toEqual({ compile: 'recipe.cpp.o', link: 'recipe.c.combine' });

    const driftManifest = {
      ...manifest,
      recipes: manifest.recipes.map((recipe) => recipe.id === 'recipe.c.o'
        ? { ...recipe, argv: [...recipe.argv, '-DC_COMMON_DRIFT'] }
        : recipe),
    };
    expect(() => derivePlatformCommands({
      manifest: driftManifest,
      resolved,
      runtime,
      compilerFlags: '-march=rv32imc_zicsr_zifencei -mabi=ilp32 -U__INT32_TYPE__',
    })).toThrow(/unmodeled common argv differences/);
  });

  it('patches deterministic compiler environment support exactly once and fails closed on drift', () => {
    const source = [
      'var Environment = class {',
      '  vars = {};',
      '};',
      '  run(args = null, files = {}, options = {}) {',
      '    const environment = new Environment();',
      '    environment.args = [this.#argv0].concat(args);',
      '  }',
    ].join('\n');
    const patched = patchCompilerBundleEnvironment(source);
    expect(patched).toContain('vars = [];');
    expect(patched).toContain('environment.vars = Object.entries(environmentVariables)');
    expect(patched).toContain('.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)');
    expect(patched).toContain('return [key, value];');
    expect(patched).not.toContain('Object.fromEntries');
    expect(patched).toContain('options.environment must be a plain object');
    expect(() => patchCompilerBundleEnvironment(patched)).toThrow(/expected one anchor/);
    expect(() => patchCompilerBundleEnvironment(source.replace('    environment.args', '  environment.args')))
      .toThrow(/expected one anchor; found 0/);
  });

  it('keeps committed compiler bundles aligned with the WASI environment tuple ABI', () => {
    const bundles = [
      new URL('../public/esp32/v2/clang/bundle.js', import.meta.url),
      new URL('../public/esp32/v5/xtensa/clang/bundle.js', import.meta.url),
    ];
    for (const bundlePath of bundles) {
      const bundle = readFileSync(bundlePath, 'utf8');
      expect(bundle).toContain('getEnvironment() {\n          return $this.vars;');
      expect(bundle).toContain('var len3 = vec3.length;');
      expect(bundle).toContain('var [tuple0_0, tuple0_1] = e;');
      expect(bundle).toContain('vars = [];');
      expect(bundle).toContain('environment.vars = Object.entries(environmentVariables)');
      expect(bundle).toContain('return [key, value];');
      expect(bundle).not.toContain('environment.vars = {};');
      expect(bundle).not.toContain('environment.vars = Object.fromEntries');
    }
  });

  it('maps only legacy defaults understood by the shared Platform Manifest', () => {
    const manifest = createPlatformManifest({
      id: 'platform', version: '1', vendor: 'esp32', architecture: 'esp32',
      runtimeToolPolicy: 'deferred-ck-binding',
      platformText: [
        'name=Demo',
        'recipe.c.o.pattern=gcc -c {source_file} -o {object_file}',
        'recipe.cpp.o.pattern=g++ -c {source_file} -o {object_file}',
        'recipe.S.o.pattern=gcc -c {source_file} -o {object_file}',
        'recipe.ar.pattern=ar rcs {archive_file_path} {object_file}',
        'recipe.c.combine.pattern=g++ {object_files} {archive_file_path} -o {build.path}/{build.project_name}.elf',
      ].join('\n'),
      boardsText: [
        'menu.FlashMode=Flash Mode',
        'demo.name=Demo', 'demo.build.core=esp32', 'demo.build.variant=demo',
        'demo.menu.FlashMode.qio=QIO', 'demo.menu.FlashMode.qio.build.flash_mode=qio',
        'demo.menu.FlashMode.dio=DIO', 'demo.menu.FlashMode.dio.build.flash_mode=dio',
      ].join('\n'),
    });
    const resolved = resolvePlatformDefaultsFromBoard(manifest, 'esp32:esp32:demo', {
      flash_mode: 'dio', erase_flash: 'disabled',
    });
    expect(resolved.options).toEqual({ FlashMode: 'dio' });
    expect(resolved.properties['build.flash_mode']).toBe('dio');
  });
});
