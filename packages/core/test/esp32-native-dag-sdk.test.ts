import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CompileService } from '../src/compile.js';
import { createPlatformManifest } from '../src/platform-pack/builder.js';
import type { CKPlatformManifest } from '../src/platform-pack/types.js';
import { BoardRegistry, type BoardDefinition } from '../src/toolchain/board.js';
import type { ToolchainConfig } from '../src/toolchain/config.js';
import type { ExecRequest, ExecResult, SandboxExecutor } from '../src/sandbox/types.js';

const roots: string[] = [];

class Esp32SdkSandbox implements SandboxExecutor {
  readonly name = 'esp32-sdk-dag-test';
  readonly isolationLevel = 'process' as const;
  sawSdkPack = false;
  readonly commands: ExecRequest[] = [];

  async exec(request: ExecRequest): Promise<ExecResult> {
    this.commands.push(request);
    this.sawSdkPack ||= [
      'packs/platform/sdk/flags/cpp_flags',
      'packs/platform/sdk/flags/includes',
      'packs/platform/sdk/include/freertos/FreeRTOS.h',
      'packs/platform/sdk/dio_qspi/include/sdkconfig.h',
      'packs/platform/sdk/lib/libfreertos.a',
      'packs/platform/sdk/ld/sections.ld',
      'packs/platform/sdk/dio_qspi/libspi_flash.a',
      'packs/board/sdk-bin/bootloader_dio_40m.elf',
      'packs/board/partitions/default.csv',
      'packs/board/partitions/boot_app0.bin',
    ].every((path) => existsSync(join(request.cwd, ...path.split('/'))));
    const output = outputPath(request.args);
    if (output) {
      mkdirSync(join(request.cwd, output, '..'), { recursive: true });
      writeFileSync(join(request.cwd, output), `artifact:${basename(output)}`);
    }
    return {
      code: 0, signal: null, stdout: '', stderr: '', durationMs: 1,
      timedOut: false, truncated: false,
    };
  }
}

function outputPath(args: readonly string[]): string | null {
  const marker = args.lastIndexOf('-o');
  if (marker >= 0 && args[marker + 1]) return args[marker + 1]!;
  if (args[0] === 'rcs' && args[1]) return args[1]!;
  if (args[0] === '-O' && args[3]) return args[3]!;
  const quiet = args.indexOf('-q');
  if (quiet >= 0 && args[quiet + 2]) return args[quiet + 2]!;
  return null;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ESP32 Native Action Graph SDK inputs', () => {
  it('uses logical SDK response-file paths and materializes the selected header Pack', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-esp32-sdk-dag-'));
    roots.push(root);
    const sdk = join(root, 'sdk');
    const core = join(root, 'core');
    const variants = join(root, 'variants');
    const compilerRoot = join(root, 'compiler');
    const bin = join(compilerRoot, 'bin');
    const esptool = join(root, 'esptool', 'esptool');
    const partitions = join(root, 'tools', 'partitions');
    mkdirSync(join(sdk, 'flags'), { recursive: true });
    mkdirSync(join(sdk, 'include', 'freertos'), { recursive: true });
    mkdirSync(join(sdk, 'dio_qspi', 'include'), { recursive: true });
    mkdirSync(join(sdk, 'lib'), { recursive: true });
    mkdirSync(join(sdk, 'ld'), { recursive: true });
    mkdirSync(join(sdk, 'bin'), { recursive: true });
    mkdirSync(partitions, { recursive: true });
    mkdirSync(join(variants, 'esp32c3'), { recursive: true });
    mkdirSync(core, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, 'esptool'), { recursive: true });
    const suffix = process.platform === 'win32' ? '.exe' : '';
    for (const name of ['gcc', 'g++', 'gcc-ar', 'objcopy', 'size']) {
      writeFileSync(join(bin, `riscv32-esp-elf-${name}${suffix}`), `tool:${name}`);
    }
    writeFileSync(esptool, 'esptool');
    for (const file of ['c_flags', 'cpp_flags', 'S_flags', 'defines', 'includes', 'ld_flags', 'ld_scripts', 'ld_libs']) {
      writeFileSync(join(sdk, 'flags', file), '');
    }
    writeFileSync(join(sdk, 'include', 'freertos', 'FreeRTOS.h'), '#pragma once\n');
    writeFileSync(join(sdk, 'dio_qspi', 'include', 'sdkconfig.h'), '#pragma once\n');
    writeFileSync(join(sdk, 'lib', 'libfreertos.a'), 'archive');
    writeFileSync(join(sdk, 'ld', 'sections.ld'), 'SECTIONS {}\n');
    writeFileSync(join(sdk, 'ld', 'memory.ld'), 'MEMORY {}\n');
    writeFileSync(join(sdk, 'dio_qspi', 'libspi_flash.a'), 'archive');
    writeFileSync(join(sdk, 'flags', 'ld_scripts'), '-T memory.ld -T sections.ld\n');
    writeFileSync(join(sdk, 'bin', 'bootloader_dio_40m.elf'), 'bootloader-elf');
    writeFileSync(join(partitions, 'default.csv'), 'nvs,data,nvs,0x9000,0x5000\n');
    writeFileSync(join(partitions, 'boot_app0.bin'), 'boot-app0');
    writeFileSync(
      join(root, 'tools', process.platform === 'win32' ? 'gen_esp32part.exe' : 'gen_esp32part.py'),
      'partition-tool',
    );
    writeFileSync(join(core, 'Arduino.cpp'), '#include <freertos/FreeRTOS.h>\n#include <sdkconfig.h>\n');
    writeFileSync(join(variants, 'esp32c3', 'pins_arduino.h'), '#pragma once\n');

    const board: BoardDefinition = {
      fqbn: 'esp32:esp32:esp32c3', name: 'ESP32-C3 test', arch: 'esp32', pins: [], options: [],
      flashTotal: 1_310_720, ramTotal: 327_680, upload: { protocol: 'esp32' },
      build: {
        mcu: 'esp32c3', tarch: 'riscv32', target: 'esp', fCpu: '160000000L',
        variant: 'esp32c3', boardDefine: 'ESP32C3_DEV', defines: [],
        boot: 'dio', bootFreq: '40m', bootloaderAddr: '0x0', psramType: 'qspi', partitions: 'default',
      },
    };
    const boards = new BoardRegistry();
    boards.add(board);
    const toolchain: ToolchainConfig = {
      esp32: {
        riscvBinDir: bin,
        riscvRootDir: compilerRoot,
        coreDir: core,
        variantsDir: variants,
        platformDir: root,
        esptool,
        sdkRootFor: () => sdk,
      },
      cacheDir: join(root, 'cache'), workDir: join(root, 'work'), librariesDirs: [],
    };
    const sandbox = new Esp32SdkSandbox();
    const manifest = makeEsp32PostLinkManifest();
    const compiler = new CompileService({
      boards, toolchain, executor: sandbox, compilerBundleId: 'esp32-sdk-dag-test-v1',
      platformManifests: [manifest],
    });
    const request = {
      board: board.fqbn,
      files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
    };
    const ir = await compiler.planActionGraph(request);
    const sketch = ir.graph.actions.find((action) => action.id.startsWith('compile-project-'));
    expect(sketch?.arguments).toEqual(expect.arrayContaining([
      '@packs/platform/sdk/flags/cpp_flags',
      '@packs/platform/sdk/flags/defines',
      '@packs/platform/sdk/flags/includes',
      '-DESP32=ESP32',
    ]));
    expect(JSON.stringify(ir)).not.toContain(root.replaceAll('\\', '/'));
    const link = ir.graph.actions.find((action) => action.id === 'link-firmware')!;
    expect(link.arguments).toEqual(expect.arrayContaining([
      '-Lpacks/platform/sdk/lib',
      '-Lpacks/platform/sdk/ld',
      '-Lpacks/platform/sdk/dio_qspi',
      '@packs/platform/sdk/flags/ld_flags',
      '-T',
      'packs/platform/sdk/ld/memory.ld',
      '-T',
      'packs/platform/sdk/ld/sections.ld',
      '@packs/platform/sdk/flags/ld_libs',
    ]));
    expect(link.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'packs/platform/sdk/ld/memory.ld', role: 'linker-script' }),
      expect.objectContaining({ path: 'packs/platform/sdk/ld/sections.ld', role: 'linker-script' }),
    ]));
    expect(link.inputs.find((input) => input.path === 'packs/platform/sdk/ld/sections.ld')?.sha256)
      .toMatch(/^[a-f0-9]{64}$/);
    expect(link.arguments.indexOf('-Wl,--start-group'))
      .toBeLessThan(link.arguments.indexOf('build/lib/core.a'));
    expect(link.arguments.indexOf('build/lib/core.a'))
      .toBeLessThan(link.arguments.indexOf('@packs/platform/sdk/flags/ld_libs'));
    expect(link.arguments.indexOf('@packs/platform/sdk/flags/ld_libs'))
      .toBeLessThan(link.arguments.indexOf('-Wl,--end-group'));
    const image = ir.graph.actions.find((action) => action.id === 'transform-application')!;
    expect(image.tool).toBe('toolchain:esptool');
    expect(image.outputs).toEqual([{ path: 'build/firmware.bin', kind: 'application' }]);
    expect(image.arguments).toEqual(expect.arrayContaining([
      '--chip', 'esp32c3', 'elf2image', '-o', 'build/firmware.bin', 'build/firmware.elf',
    ]));
    expect(ir.artifacts).toContainEqual({ path: 'build/firmware.bin', format: 'bin', offset: '0x10000' });
    const staticTransforms = ir.graph.actions.filter((action) => (
      action.kind === 'transform'
      && ['bootloader', 'partition', 'boot-app0'].includes(action.transform.format)
    ));
    expect(staticTransforms).toHaveLength(3);
    for (const action of staticTransforms) {
      expect(action.inputs[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(action.packDependencies).toEqual([ir.packs.board.id]);
    }
    expect(staticTransforms.map((action) => ({
      id: action.id,
      tool: action.tool,
      input: action.kind === 'transform' ? action.transform.input : '',
    }))).toEqual(expect.arrayContaining([
      {
        id: 'transform-bootloader',
        tool: 'toolchain:esptool',
        input: 'packs/board/sdk-bin/bootloader_dio_40m.elf',
      },
      {
        id: 'transform-partitions',
        tool: 'platform:gen-esp32part',
        input: 'packs/board/partitions/default.csv',
      },
      {
        id: 'transform-boot-app0',
        tool: 'ck:copy',
        input: 'packs/board/partitions/boot_app0.bin',
      },
    ]));
    expect(ir.artifacts).toEqual(expect.arrayContaining([
      { path: 'build/bootloader.bin', format: 'bootloader', offset: '0x0' },
      { path: 'build/partitions.bin', format: 'partition', offset: '0x8000' },
      { path: 'build/boot_app0.bin', format: 'boot-app0', offset: '0xe000' },
      { path: 'build/firmware.merged.bin', format: 'bin' },
    ]));
    const merged = ir.graph.actions.find((action) => action.id === 'transform-merged')!;
    expect(merged.tool).toBe('toolchain:esptool');
    expect(merged.outputs).toEqual([{ path: 'build/firmware.merged.bin', kind: 'merged' }]);
    expect(merged.inputs.map((input) => input.path)).toEqual([
      'build/boot_app0.bin',
      'build/bootloader.bin',
      'build/firmware.bin',
      'build/partitions.bin',
    ]);
    expect(merged.dependencies).toEqual([
      'transform-application',
      'transform-boot-app0',
      'transform-bootloader',
      'transform-partitions',
    ]);
    expect(merged.arguments).toEqual(expect.arrayContaining([
      '--chip', 'esp32c3', 'merge-bin', '-o', 'build/firmware.merged.bin',
      '0x0', 'build/bootloader.bin',
      '0x8000', 'build/partitions.bin',
      '0xe000', 'build/boot_app0.bin',
      '0x10000', 'build/firmware.bin',
    ]));

    const staticResult = await compiler.compileStaticBuildIR(ir);
    expect(staticResult.status, JSON.stringify(staticResult, null, 2)).toBe('success');
    expect(staticResult).toMatchObject({
      status: 'success',
      artifacts: [],
      staticArtifacts: expect.arrayContaining([
        expect.objectContaining({ name: 'bootloader.bin', offset: '0x0' }),
        expect.objectContaining({ name: 'partitions.bin', offset: '0x8000' }),
        expect.objectContaining({ name: 'boot_app0.bin', offset: '0xe000' }),
      ]),
    });
    expect(sandbox.commands).toHaveLength(2);

    const result = await compiler.compileBuildIR(ir);
    expect(result, JSON.stringify(result, null, 2)).toMatchObject({ status: 'success' });
    expect(sandbox.sawSdkPack).toBe(true);
    const staticArtifacts = result?.status === 'success' ? result.staticArtifacts : [];
    expect(staticArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'bootloader.bin', offset: '0x0' }),
      expect.objectContaining({ name: 'partitions.bin', offset: '0x8000' }),
      expect.objectContaining({ name: 'boot_app0.bin', offset: '0xe000' }),
    ]));
    expect(staticArtifacts).toHaveLength(3);
    expect(sandbox.commands.some((command) => command.command.toLowerCase().includes('bash'))).toBe(false);
    const mergeRequest = sandbox.commands.find((command) => command.args.includes('merge-bin'));
    expect(mergeRequest?.args.slice(-8).filter((_value, index) => index % 2 === 1)).toEqual([
      'build/bootloader.bin',
      'build/partitions.bin',
      'build/boot_app0.bin',
      'build/firmware.bin',
    ]);

    const initialBootloaderKey = ir.graph.actions.find((action) => action.id === 'transform-bootloader')!.cacheKey;
    writeFileSync(join(sdk, 'bin', 'bootloader_dio_40m.elf'), 'updated-bootloader-elf');
    const changedIr = await compiler.planActionGraph(request);
    expect(changedIr.packs.board.sha256).not.toBe(ir.packs.board.sha256);
    expect(changedIr.graph.actions.find((action) => action.id === 'transform-bootloader')!.cacheKey)
      .not.toBe(initialBootloaderKey);
  });
});

function makeEsp32PostLinkManifest(): CKPlatformManifest {
  return createPlatformManifest({
    id: 'espressif-arduino',
    version: '3.3.7',
    vendor: 'esp32',
    architecture: 'esp32',
    runtimeToolPolicy: 'deferred-ck-binding',
    platformText: [
      'name=Arduino ESP32',
      'compiler.path=',
      'compiler.sdk.path=sdk',
      'compiler.c.cmd=gcc',
      'compiler.cpp.cmd=g++',
      'compiler.c.flags=-MMD -c "@{compiler.sdk.path}/flags/c_flags"',
      'compiler.cpp.flags=-MMD -c "@{compiler.sdk.path}/flags/cpp_flags"',
      'compiler.S.flags=-MMD -c -x assembler-with-cpp "@{compiler.sdk.path}/flags/S_flags"',
      'compiler.c.extra_flags=-DCK_LANGUAGE_C',
      'compiler.cpp.extra_flags=-DCK_LANGUAGE_CXX',
      'compiler.S.extra_flags=-DCK_LANGUAGE_ASM',
      'compiler.cpreprocessor.flags="@{compiler.sdk.path}/flags/defines" -iprefix "{compiler.sdk.path}/include/" "@{compiler.sdk.path}/flags/includes" -I"{compiler.sdk.path}/{build.memory_type}/include"',
      'compiler.ar.cmd=ar',
      'compiler.ar.flags=rcs',
      'compiler.ar.extra_flags=D',
      'compiler.c.elf.cmd=g++',
      'compiler.c.elf.flags="-L{compiler.sdk.path}/lib" "-L{compiler.sdk.path}/ld" "-L{compiler.sdk.path}/{build.memory_type}" "@{compiler.sdk.path}/flags/ld_flags" "@{compiler.sdk.path}/flags/ld_scripts" -Wl,--start-group',
      'compiler.c.elf.extra_flags=',
      'compiler.c.elf.libs="@{compiler.sdk.path}/flags/ld_libs" -Wl,--end-group',
      'build.extra_flags=-DESP32=ESP32 -I{compiler.sdk.path}/{build.memory_type}/include',
      'tools.esptool_py.path={runtime.tools.esptool_py.path}',
      'tools.esptool_py.cmd=esptool',
      'tools.gen_esp32part.cmd=python3 "{runtime.platform.path}/tools/gen_esp32part.py"',
      'upload.extra_flags=',
      'recipe.c.o.pattern={compiler.path}{compiler.c.cmd} {compiler.c.extra_flags} {compiler.c.flags} -DF_CPU={build.f_cpu} {build.extra_flags} {compiler.cpreprocessor.flags} {source_file} -o {object_file}',
      'recipe.cpp.o.pattern={compiler.path}{compiler.cpp.cmd} {compiler.cpp.extra_flags} {compiler.cpp.flags} -DF_CPU={build.f_cpu} {build.extra_flags} {compiler.cpreprocessor.flags} {source_file} -o {object_file}',
      'recipe.S.o.pattern={compiler.path}{compiler.c.cmd} {compiler.S.extra_flags} {compiler.S.flags} -DF_CPU={build.f_cpu} {build.extra_flags} {compiler.cpreprocessor.flags} {source_file} -o {object_file}',
      'recipe.ar.pattern={compiler.path}{compiler.ar.cmd} {compiler.ar.flags} {compiler.ar.extra_flags} {archive_file_path} {object_file}',
      'recipe.c.combine.pattern={compiler.path}{compiler.c.elf.cmd} {compiler.c.elf.flags} {compiler.c.elf.extra_flags} {object_files} {archive_file_path} {compiler.c.elf.libs} -o {build.path}/{build.project_name}.elf',
      'recipe.objcopy.bin.pattern="{tools.esptool_py.path}/{tools.esptool_py.cmd}" "{recipe.objcopy.bin.pattern_args}"',
      'recipe.objcopy.bin.pattern_args=--chip {build.mcu} elf2image --flash-mode "{build.flash_mode}" --flash-freq "{build.img_freq}" --flash-size "{build.flash_size}" --elf-sha256-offset 0xb0 -o "{build.path}/{build.project_name}.bin" "{build.path}/{build.project_name}.elf"',
      'recipe.objcopy.partitions.bin.pattern="{tools.gen_esp32part.cmd}" -q "{build.path}/partitions.csv" "{build.path}/{build.project_name}.partitions.bin"',
      'recipe.hooks.prebuild.4.pattern=/usr/bin/env bash -c "opaque shell {recipe.hooks.prebuild.4.pattern_args}"',
      'recipe.hooks.prebuild.4.pattern_args=--chip {build.mcu} elf2image --flash-mode {build.flash_mode} --flash-freq {build.img_freq} --flash-size {build.flash_size} -o',
      'recipe.hooks.objcopy.postobjcopy.3.pattern="{tools.esptool_py.path}/{tools.esptool_py.cmd}" "{recipe.hooks.objcopy.postobjcopy.3.pattern_args}"',
      'recipe.hooks.objcopy.postobjcopy.3.pattern_args=--chip {build.mcu} merge-bin -o "{build.path}/{build.project_name}.merged.bin" --pad-to-size {build.flash_size} --flash-mode keep --flash-freq keep --flash-size keep {build.bootloader_addr} "{build.path}/{build.project_name}.bootloader.bin" 0x8000 "{build.path}/{build.project_name}.partitions.bin" 0xe000 "{runtime.platform.path}/tools/partitions/boot_app0.bin" 0x10000 "{build.path}/{build.project_name}.bin"',
    ].join('\n'),
    boardsText: [
      'esp32c3.name=ESP32-C3 Dev Module',
      'esp32c3.build.core=esp32',
      'esp32c3.build.variant=esp32c3',
      'esp32c3.build.mcu=esp32c3',
      'esp32c3.build.chip_variant={build.mcu}',
      'esp32c3.build.tarch=riscv32',
      'esp32c3.build.target=esp',
      'esp32c3.build.f_cpu=160000000L',
      'esp32c3.build.board=ESP32C3_DEV',
      'esp32c3.build.bootloader_addr=0x0',
      'esp32c3.build.flash_mode=dio',
      'esp32c3.build.boot=dio',
      'esp32c3.build.boot_freq=40m',
      'esp32c3.build.psram_type=qspi',
      'esp32c3.build.memory_type={build.boot}_{build.psram_type}',
      'esp32c3.build.flash_freq=40m',
      'esp32c3.build.img_freq={build.flash_freq}',
      'esp32c3.build.flash_size=4MB',
      'esp32c3.build.partitions=default',
    ].join('\n'),
  });
}
