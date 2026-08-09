import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CompileService,
  BoardRegistry,
  createPlatformManifest,
  encodeEsp32PartitionCsv,
  sha256Hex,
  type BoardDefinition,
  type CKPlatformManifest,
  type CompileEvent,
  type ExecRequest,
  type ExecResult,
  type SandboxExecutor,
  type ToolchainConfig,
} from '../src/index.js';

const roots: string[] = [];

class DagSandbox implements SandboxExecutor {
  readonly name = 'dag-test';
  readonly isolationLevel = 'process' as const;
  calls = 0;

  constructor(private readonly applicationSize?: number) {}

  async exec(request: ExecRequest): Promise<ExecResult> {
    this.calls += 1;
    const output = outputPath(request.args);
    if (output) {
      mkdirSync(join(request.cwd, output, '..'), { recursive: true });
      if (output === 'build/firmware.bin' && this.applicationSize !== undefined) {
        writeFileSync(join(request.cwd, output), Buffer.alloc(this.applicationSize, 0xa5));
      } else if (output === 'build/partitions.bin' && request.args.includes('partitions.csv')) {
        const csv = readFileSync(join(request.cwd, 'partitions.csv'));
        writeFileSync(join(request.cwd, output), encodeEsp32PartitionCsv(csv, {
          flashSizeBytes: 4 * 1024 * 1024,
        }).bytes);
      } else {
        writeFileSync(join(request.cwd, output), `artifact:${basename(output)}:${this.calls}`);
      }
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
  // gen_esp32part uses `-q input.csv output.bin`.
  if (args[0] === '-q' && args[2]) return args[2]!;
  // ar uses `rcs archive.a object.o ...`.
  if (args[0] === 'rcs' && args[1]) return args[1]!;
  // objcopy uses `-O format input output`.
  if (args[0] === '-O' && args[3]) return args[3]!;
  return null;
}

function makeService(root: string, sandbox: SandboxExecutor): CompileService {
  const board: BoardDefinition = {
    fqbn: 'arduino:avr:dag-test', name: 'DAG Test AVR', arch: 'avr', pins: [], options: [],
    flashTotal: 32_768, ramTotal: 2_048,
    upload: { protocol: 'stk500v1' },
    build: {
      mcu: 'atmega328p', fCpu: '16000000L', variant: 'standard',
      defines: ['ARDUINO_AVR_DAG_TEST', 'ARDUINO_ARCH_AVR'], lto: false,
    },
  };
  const boards = new BoardRegistry();
  boards.add(board);
  const toolchain: ToolchainConfig = {
    avr: {
      binDir: join(root, 'compiler', 'bin'),
      rootDir: join(root, 'compiler'),
      coreDir: join(root, 'core'),
      variantsDir: join(root, 'variants'),
    },
    cacheDir: join(root, 'cache'),
    workDir: join(root, 'work'),
    librariesDirs: [join(root, 'libraries')],
  };
  return new CompileService({ boards, toolchain, executor: sandbox });
}

describe('CompileService Native Action Graph execution', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('executes and caches compile/archive/link/hex actions through one IR', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-dag-service-'));
    roots.push(root);
    mkdirSync(join(root, 'core'), { recursive: true });
    mkdirSync(join(root, 'variants', 'standard'), { recursive: true });
    mkdirSync(join(root, 'compiler', 'bin'), { recursive: true });
    const suffix = process.platform === 'win32' ? '.exe' : '';
    for (const name of ['avr-gcc', 'avr-g++', 'avr-gcc-ar', 'avr-objcopy', 'avr-size']) {
      writeFileSync(join(root, 'compiler', 'bin', `${name}${suffix}`), `tool:${name}`);
    }
    writeFileSync(join(root, 'core', 'Arduino.c'), 'int core_symbol(void) { return 1; }\n');
    writeFileSync(join(root, 'variants', 'standard', 'pins.c'), 'int pin_symbol(void) { return 2; }\n');
    const libraryRoot = join(root, 'libraries', 'Auto_Library');
    mkdirSync(join(libraryRoot, 'src'), { recursive: true });
    writeFileSync(join(libraryRoot, 'library.properties'), [
      'name=Auto Library',
      'version=1.0.0',
      'architectures=avr',
      'includes=AutoLibrary.h',
    ].join('\n'));
    writeFileSync(join(libraryRoot, 'src', 'AutoLibrary.h'), 'int auto_library_symbol(void);\n');
    writeFileSync(join(libraryRoot, 'src', 'AutoLibrary.cpp'), 'int auto_library_symbol(void) { return 7; }\n');
    const sandbox = new DagSandbox();
    const compiler = makeService(root, sandbox);
    const request = {
      board: 'arduino:avr:dag-test',
      files: [{
        name: 'main.ino',
        content: '#include <AutoLibrary.h>\nextern "C" int core_symbol(void);\nvoid setup() {}\nvoid loop() { (void)core_symbol(); (void)auto_library_symbol(); }\n',
      }],
    };
    const ir = await compiler.planActionGraph(request);
    expect(ir.graph.actions.some((action) => action.kind === 'compile')).toBe(true);
    expect(ir.graph.actions.some((action) => action.kind === 'archive')).toBe(true);
    expect(ir.graph.actions.some((action) => action.kind === 'link')).toBe(true);
    expect(ir.graph.actions.some((action) => action.kind === 'transform')).toBe(true);

    const cxx = join(root, 'compiler', 'bin', `avr-g++${suffix}`);
    writeFileSync(cxx, 'replaced-after-planning');
    await expect(compiler.compileBuildIR(ir)).resolves.toMatchObject({
      status: 'error',
      reason: 'internal',
      message: expect.stringMatching(/closure hash mismatch/),
    });
    writeFileSync(cxx, 'tool:avr-g++');

    const stale = {
      ...ir,
      packs: {
        ...ir.packs,
        platform: { ...ir.packs.platform, sha256: 'f'.repeat(64) },
      },
    };
    const rejected = await compiler.compileBuildIR(stale);
    expect(rejected).toMatchObject({
      status: 'error',
      reason: 'internal',
      message: expect.stringMatching(/no exact content-hash match/),
    });

    const events: CompileEvent[] = [];
    const first = await compiler.compile(request, (event) => events.push(event));
    expect(first).toMatchObject({ status: 'success', cached: false });
    expect(first.status === 'success' && first.artifacts.map((artifact) => artifact.name))
      .toContain('firmware.hex');
    expect(first.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'info',
      message: 'Automatically imported library `Auto Library` from #include',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: 'diagnostic',
      diagnostic: expect.objectContaining({ severity: 'info' }),
    }));
    expect(sandbox.calls).toBeGreaterThan(0);

    const callsAfterFirst = sandbox.calls;
    const second = await compiler.compileBuildIR(ir);
    expect(second).toMatchObject({ status: 'success', cached: true });
    expect(sandbox.calls).toBe(callsAfterFirst);

    const explicit = await compiler.compile({
      ...request,
      libraries: [{ name: 'Auto Library', version: '1.0.0' }],
    });
    expect(explicit).toMatchObject({ status: 'success', cached: true });
    expect(explicit.diagnostics.some((diagnostic) => diagnostic.severity === 'info')).toBe(false);
    expect(sandbox.calls).toBe(callsAfterFirst);

    writeFileSync(join(root, 'variants', 'standard', 'pins.c'), 'int pin_symbol(void) { return 3; }\n');
    const variantIr = await makeService(root, new DagSandbox()).planActionGraph(request);
    expect(variantIr.packs.toolchain.sha256).toBe(ir.packs.toolchain.sha256);
    expect(variantIr.packs.platform.sha256).toBe(ir.packs.platform.sha256);
    expect(variantIr.packs.board.sha256).not.toBe(ir.packs.board.sha256);

    writeFileSync(join(root, 'core', 'Arduino.c'), 'int core_symbol(void) { return 4; }\n');
    const coreIr = await makeService(root, new DagSandbox()).planActionGraph(request);
    expect(coreIr.packs.toolchain.sha256).toBe(variantIr.packs.toolchain.sha256);
    expect(coreIr.packs.platform.sha256).not.toBe(variantIr.packs.platform.sha256);
    expect(coreIr.packs.board.sha256).toBe(variantIr.packs.board.sha256);
  });

  it('derives ESP32 planning parameters and custom partitions from the Platform Manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-dag-manifest-'));
    roots.push(root);
    const toolchain = makeEsp32Toolchain(root);
    const board: BoardDefinition = {
      fqbn: 'esp32:esp32:esp32c3', name: 'Legacy board metadata', arch: 'esp32', pins: [], options: [],
      flashTotal: 1_310_720, ramTotal: 327_680, upload: { protocol: 'esp32' },
      build: {
        mcu: 'legacy-mcu', fCpu: '1L', variant: 'legacy-variant', defines: ['LEGACY_BUILD=1'],
        tarch: 'xtensa', target: 'legacy-target', boardDefine: 'LEGACY_BOARD',
        bootloaderAddr: '0x9999', flashMode: 'legacy-mode', boot: 'legacy-boot',
        bootFreq: '1m', psramType: 'legacy-ram', flashFreq: '1m', imageFreq: '1m',
        flashSize: '1MB', partitions: 'legacy-partition',
      },
    };
    const request = {
      board: board.fqbn,
      files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
    };
    const first = await makeManifestService(
      board,
      toolchain,
      makeEsp32Manifest('160000000L'),
    ).planActionGraph(request);
    const second = await makeManifestService(
      board,
      toolchain,
      makeEsp32Manifest('80000000L'),
    ).planActionGraph(request);
    const customPartitionsCsv = [
      '# Name, Type, SubType, Offset, Size, Flags',
      'nvs, data, nvs, 0x9000, 0x5000,',
      'app0, app, ota_0, 0x10000, 0x100000,',
    ].join('\n');
    const custom = await makeManifestService(
      board,
      toolchain,
      makeEsp32Manifest('160000000L'),
    ).planActionGraph({
      ...request,
      files: [
        ...request.files,
        { name: 'partitions.csv', content: customPartitionsCsv },
      ],
    });

    const postLinkProducts = first.graph.actions
      .filter((action) => action.kind === 'transform' && action.id.startsWith('transform-'))
      .map((action) => ({
        id: action.id,
        productId: action.outputs[0]?.kind,
        output: action.outputs[0]?.path,
      }));
    expect(postLinkProducts).toHaveLength(5);
    expect(postLinkProducts).toEqual(expect.arrayContaining([
      {
        id: 'transform-application',
        productId: 'application',
        output: 'build/firmware.bin',
      },
      {
        id: 'transform-bootloader',
        productId: 'bootloader',
        output: 'build/bootloader.bin',
      },
      {
        id: 'transform-partitions',
        productId: 'partitions',
        output: 'build/partitions.bin',
      },
      {
        id: 'transform-boot-app0',
        productId: 'boot-app0',
        output: 'build/boot_app0.bin',
      },
      {
        id: 'transform-merged',
        productId: 'merged',
        output: 'build/firmware.merged.bin',
      },
    ]));
    const defaultPartitions = first.graph.actions.find(
      (action) => action.id === 'transform-partitions',
    );
    expect(defaultPartitions).toMatchObject({
      kind: 'transform',
      tool: 'platform:gen-esp32part',
      inputs: [{
        path: 'packs/board/partitions/default.csv',
        sha256: sha256Hex('nvs,data,nvs,0x9000,0x5000\n'),
        role: 'partitions-source',
      }],
      arguments: [
        '-q',
        'packs/board/partitions/default.csv',
        'build/partitions.bin',
      ],
      transform: {
        input: 'packs/board/partitions/default.csv',
        output: 'build/partitions.bin',
        format: 'partition',
      },
    });
    const customPartitions = custom.graph.actions.find(
      (action) => action.id === 'transform-partitions',
    );
    expect(customPartitions).toMatchObject({
      kind: 'transform',
      tool: 'platform:gen-esp32part',
      inputs: [{
        path: 'partitions.csv',
        sha256: sha256Hex(customPartitionsCsv),
        role: 'partitions-source',
      }],
      outputs: [{
        path: 'build/partitions.bin',
        kind: 'partitions',
        sha256: sha256Hex(encodeEsp32PartitionCsv(customPartitionsCsv, {
          flashSizeBytes: 4 * 1024 * 1024,
        }).bytes),
      }],
      arguments: ['-q', 'partitions.csv', 'build/partitions.bin'],
      transform: {
        input: 'partitions.csv',
        output: 'build/partitions.bin',
        format: 'partition',
      },
    });
    const merged = first.graph.actions.find((action) => action.id === 'transform-merged')!;
    expect(merged.dependencies).toEqual([
      'transform-application',
      'transform-boot-app0',
      'transform-bootloader',
      'transform-partitions',
    ]);

    const firstProject = first.graph.actions.find((action) => action.id.startsWith('compile-project-'))!;
    const secondProject = second.graph.actions.find((action) => action.id.startsWith('compile-project-'))!;
    expect(first.packs.toolchain).toEqual(second.packs.toolchain);
    expect(first.packs.platform.sha256).not.toBe(second.packs.platform.sha256);
    expect(first.packs.board.sha256).not.toBe(second.packs.board.sha256);
    expect(firstProject.arguments).toContain('-DF_CPU=160000000L');
    expect(secondProject.arguments).toContain('-DF_CPU=80000000L');
    expect(firstProject.arguments).toContain('-DMANIFEST_CPU=160000000L');
    expect(secondProject.arguments).toContain('-DMANIFEST_CPU=80000000L');
    expect(firstProject.cacheKey).not.toBe(secondProject.cacheKey);
    expect(first.packs.toolchain.instructionSet).toBe('esp32c3');
    const languageContracts = [
      { language: 'c', flag: '-DCK_LANGUAGE_C', response: 'c_flags' },
      { language: 'c++', flag: '-DCK_LANGUAGE_CXX', response: 'cpp_flags' },
      { language: 'asm', flag: '-DCK_LANGUAGE_ASM', response: 'S_flags' },
    ] as const;
    for (const contract of languageContracts) {
      const action = first.graph.actions.find((candidate) => (
        candidate.kind === 'compile' && candidate.compileUnit.language === contract.language
      ));
      expect(action, `missing ${contract.language} compile Action`).toBeDefined();
      expect(action!.arguments).toContain(contract.flag);
      expect(action!.arguments).not.toEqual(expect.arrayContaining(
        languageContracts.filter((candidate) => candidate !== contract).map((candidate) => candidate.flag),
      ));
      const responseInputs = action!.inputs
        .filter((input) => input.role === 'compiler-response-file');
      expect(responseInputs).toEqual(expect.arrayContaining([
        {
          path: `packs/platform/sdk/flags/${contract.response}`,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          role: 'compiler-response-file',
        },
        {
          path: 'packs/platform/sdk/flags/defines',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          role: 'compiler-response-file',
        },
        {
          path: 'packs/platform/sdk/flags/includes',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          role: 'compiler-response-file',
        },
      ]));
      expect(responseInputs.map((input) => input.path)).not.toEqual(expect.arrayContaining(
        languageContracts
          .filter((candidate) => candidate !== contract)
          .map((candidate) => `packs/platform/sdk/flags/${candidate.response}`),
      ));
    }
    const linkAction = first.graph.actions.find((action) => action.kind === 'link')!;
    expect(linkAction.arguments).not.toContain('@packs/platform/sdk/flags/ld_scripts');
    expect(linkAction.inputs.filter((input) => input.role === 'linker-script').map((input) => input.path))
      .toEqual([
        'packs/platform/sdk/ld/memory.ld',
        'packs/platform/sdk/ld/sections.ld',
      ]);
    const archiveActions = first.graph.actions.filter((action) => action.kind === 'archive');
    expect(archiveActions.length).toBeGreaterThan(0);
    expect(archiveActions.every((action) => action.arguments[0] === 'rcs')).toBe(true);
    expect(archiveActions.every((action) => action.arguments.at(-1) === 'D')).toBe(true);
    expect(archiveActions.every((action) => action.archive.flags.join(' ') === 'D')).toBe(true);
    expect(JSON.stringify(first)).not.toContain(root);
    expect(JSON.stringify(first)).not.toMatch(/legacy-(?:mcu|variant|target|mode|boot|ram|partition)/);
  });

  it('enforces custom application capacity on Native results without changing default partitions', async () => {
    const board: BoardDefinition = {
      fqbn: 'esp32:esp32:esp32c3', name: 'Capacity test board', arch: 'esp32', pins: [], options: [],
      flashTotal: 4 * 1024 * 1024, ramTotal: 327_680, upload: { protocol: 'esp32' },
      build: {
        mcu: 'esp32c3', fCpu: '160000000L', variant: 'esp32c3', defines: [],
        tarch: 'riscv32', target: 'esp', boardDefine: 'ESP32C3_DEV', bootloaderAddr: '0x0',
        flashMode: 'dio', boot: 'dio', bootFreq: '40m', psramType: 'qspi',
        flashFreq: '40m', imageFreq: '40m', flashSize: '4MB', partitions: 'default',
      },
    };
    const customCsv = [
      'nvs,data,nvs,0x9000,0x5000,',
      'app,app,factory,0x10000,0x1000,',
    ].join('\n');
    const run = async (applicationSize: number, custom: boolean) => {
      const root = mkdtempSync(join(tmpdir(), 'ck-dag-capacity-'));
      roots.push(root);
      const service = makeManifestService(
        board,
        makeEsp32Toolchain(root),
        makeEsp32Manifest('160000000L'),
        new DagSandbox(applicationSize),
      );
      return service.compile({
        board: board.fqbn,
        files: [
          { name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' },
          ...(custom ? [{ name: 'partitions.csv', content: customCsv }] : []),
        ],
      });
    };

    const exact = await run(0x1000, true);
    expect(exact, JSON.stringify(exact, null, 2)).toMatchObject({ status: 'success' });
    await expect(run(0x1001, true)).resolves.toMatchObject({
      status: 'error', reason: 'resource_limit',
      message: expect.stringMatching(/4097 bytes.*capacity 4096 bytes/i),
    });
    await expect(run(0x1001, false)).resolves.toMatchObject({ status: 'success' });
  });
});

function makeManifestService(
  board: BoardDefinition,
  toolchain: ToolchainConfig,
  manifest: CKPlatformManifest,
  executor: SandboxExecutor = new DagSandbox(),
): CompileService {
  const boards = new BoardRegistry();
  boards.add(board);
  return new CompileService({
    boards,
    toolchain,
    executor,
    compilerBundleId: 'manifest-action-graph-test',
    platformManifests: [manifest],
  });
}

function makeEsp32Manifest(fCpu: string): CKPlatformManifest {
  return createPlatformManifest({
    id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
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
      'compiler.cpreprocessor.flags="@{compiler.sdk.path}/flags/defines" -iprefix "{compiler.sdk.path}/include/" "@{compiler.sdk.path}/flags/includes"',
      'compiler.ar.cmd=ar',
      'compiler.ar.flags=rcs',
      'compiler.ar.extra_flags=D',
      'compiler.c.elf.cmd=g++',
      'compiler.c.elf.flags="-L{compiler.sdk.path}/lib" "@{compiler.sdk.path}/flags/ld_flags" "@{compiler.sdk.path}/flags/ld_scripts" -Wl,--start-group',
      'compiler.c.elf.extra_flags=',
      'compiler.c.elf.libs="@{compiler.sdk.path}/flags/ld_libs" -Wl,--end-group',
      'build.extra_flags=-DMANIFEST_CPU={build.f_cpu}',
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
      `esp32c3.build.f_cpu=${fCpu}`,
      'esp32c3.build.board=ESP32C3_DEV',
      'esp32c3.build.bootloader_addr=0x0',
      'esp32c3.build.flash_mode=dio',
      'esp32c3.build.boot=dio',
      'esp32c3.build.boot_freq=40m',
      'esp32c3.build.psram_type=qspi',
      'esp32c3.build.flash_freq=40m',
      'esp32c3.build.img_freq={build.flash_freq}',
      'esp32c3.build.flash_size=4MB',
      'esp32c3.build.partitions=default',
    ].join('\n'),
  });
}

function makeEsp32Toolchain(root: string): ToolchainConfig {
  const sdk = join(root, 'sdk');
  const core = join(root, 'core');
  const variants = join(root, 'variants');
  const bin = join(root, 'bin');
  const platform = join(root, 'platform');
  const partitions = join(platform, 'tools', 'partitions');
  for (const path of [
    join(sdk, 'flags'), join(sdk, 'include'), join(sdk, 'dio_qspi', 'include'),
    join(sdk, 'lib'), join(sdk, 'ld'), join(sdk, 'bin'), partitions,
    join(variants, 'esp32c3'), core, bin,
  ]) mkdirSync(path, { recursive: true });
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const name of ['gcc', 'g++', 'gcc-ar', 'objcopy', 'size']) {
    writeFileSync(join(bin, `riscv32-esp-elf-${name}${suffix}`), `tool:${name}`);
  }
  const esptool = join(root, 'esptool');
  writeFileSync(esptool, 'esptool');
  for (const file of ['c_flags', 'cpp_flags', 'S_flags', 'defines', 'includes', 'ld_flags', 'ld_libs']) {
    writeFileSync(join(sdk, 'flags', file), '');
  }
  writeFileSync(join(sdk, 'flags', 'ld_scripts'), '-T memory.ld -T sections.ld\n');
  writeFileSync(join(sdk, 'ld', 'memory.ld'), 'MEMORY {}\n');
  writeFileSync(join(sdk, 'ld', 'sections.ld'), 'SECTIONS {}\n');
  writeFileSync(join(sdk, 'bin', 'bootloader_dio_40m.elf'), 'bootloader');
  writeFileSync(join(partitions, 'default.csv'), 'nvs,data,nvs,0x9000,0x5000\n');
  writeFileSync(join(partitions, 'boot_app0.bin'), 'boot-app0');
  writeFileSync(
    join(platform, 'tools', process.platform === 'win32' ? 'gen_esp32part.exe' : 'gen_esp32part.py'),
    'partition-tool',
  );
  writeFileSync(join(core, 'Arduino.cpp'), 'void initVariant(void) {}\n');
  writeFileSync(join(core, 'native.c'), 'int native_c(void) { return 1; }\n');
  writeFileSync(join(core, 'startup.S'), '.text\n');
  writeFileSync(join(variants, 'esp32c3', 'pins_arduino.h'), '#pragma once\n');
  return {
    esp32: {
      riscvBinDir: bin, coreDir: core, variantsDir: variants, platformDir: platform,
      esptool, sdkRootFor: () => sdk,
    },
    cacheDir: join(root, 'cache'), workDir: join(root, 'work'), librariesDirs: [],
  };
}
