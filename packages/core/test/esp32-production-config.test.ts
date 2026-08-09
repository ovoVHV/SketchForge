import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxExecutor } from '../src/sandbox/types.js';
import { BoardRegistry, type BoardDefinition } from '../src/toolchain/board.js';
import { detectLocalToolchain, type Esp32Toolchain as Esp32Config } from '../src/toolchain/config.js';
import {
  Esp32Toolchain,
  esp32BoardSupported,
  esp32PartitionToolInvocation,
  toolchainParallelismFromEnv,
} from '../src/toolchain/esp32.js';

const ENV_KEYS = [
  'ARDUINO15_DIR',
  'AF_ESP32_XTENSA_BIN',
  'AF_ESP32_XTENSA_ROOT',
  'AF_ESP32_RISCV_BIN',
  'AF_ESP32_RISCV_ROOT',
  'AF_ESP32_CORE',
  'AF_ESP32_VARIANTS',
  'AF_ESP32_PLATFORM',
  'AF_ESP32_SDK_ROOT',
  'AF_ESP32_ESPTOOL',
] as const;

const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function file(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'test\n');
}

const executor: SandboxExecutor = {
  name: 'tool-resolution-test',
  isolationLevel: 'none',
  async exec() {
    throw new Error('tool resolution must not execute a compiler');
  },
};

type ToolResolver = {
  tool(board: BoardDefinition, name: string): string;
};

function makeToolResolver(root: string): {
  resolver: ToolResolver;
  xtensaBin: string;
  riscvBin: string;
} {
  const xtensaBin = join(root, 'xtensa', 'bin');
  const riscvBin = join(root, 'riscv', 'bin');
  const config: Esp32Config = {
    xtensaBinDir: xtensaBin,
    riscvBinDir: riscvBin,
    coreDir: join(root, 'core'),
    variantsDir: join(root, 'variants'),
    platformDir: join(root, 'platform'),
    sdkRootFor: () => join(root, 'sdk'),
    esptool: join(root, 'esptool'),
  };
  const toolchain = new Esp32Toolchain(config, executor, join(root, 'cache'));
  return {
    resolver: toolchain as unknown as ToolResolver,
    xtensaBin,
    riscvBin,
  };
}

describe('ESP32 production toolchain config', () => {
  it('uses the official Python partition generator on POSIX and the executable on Windows', () => {
    const platformDir = join('opt', 'esp32', 'platform');
    const script = join(platformDir, 'tools', 'gen_esp32part.py');
    const executable = join(platformDir, 'tools', 'gen_esp32part.exe');

    expect(esp32PartitionToolInvocation(platformDir, 'linux')).toEqual({
      command: 'python3',
      argsPrefix: [script],
      identityPath: script,
    });
    expect(esp32PartitionToolInvocation(platformDir, 'darwin')).toEqual({
      command: 'python3',
      argsPrefix: [script],
      identityPath: script,
    });
    expect(esp32PartitionToolInvocation(platformDir, 'win32')).toEqual({
      command: executable,
      argsPrefix: [],
      identityPath: executable,
    });
  });

  it('uses one compiler process by default and clamps explicit parallelism', () => {
    expect(toolchainParallelismFromEnv({} as NodeJS.ProcessEnv)).toBe(1);
    expect(toolchainParallelismFromEnv({ AF_TOOLCHAIN_PARALLELISM: '4' } as NodeJS.ProcessEnv)).toBe(4);
    expect(toolchainParallelismFromEnv({ AF_TOOLCHAIN_PARALLELISM: '99' } as NodeJS.ProcessEnv)).toBe(8);
    expect(toolchainParallelismFromEnv({ AF_TOOLCHAIN_PARALLELISM: 'many' } as NodeJS.ProcessEnv)).toBe(1);
  });

  it('uses explicit paths and only advertises boards with a complete compiler and SDK', () => {
    const root = mkdtempSync(join(tmpdir(), 'af-esp32-production-'));
    roots.push(root);
    const emptyArduino15 = join(root, 'arduino15');
    const compilerRoot = join(root, 'esp-x32');
    const bin = join(compilerRoot, 'bin');
    const core = join(root, 'platform', 'cores', 'esp32');
    const variants = join(root, 'platform', 'variants');
    const sdkRoot = join(root, 'sdk');
    const sdk = join(sdkRoot, 'esp32');
    const esptool = join(root, 'esptool', platform() === 'win32' ? 'esptool.exe' : 'esptool');
    const suffix = platform() === 'win32' ? '.exe' : '';

    mkdirSync(emptyArduino15, { recursive: true });
    mkdirSync(core, { recursive: true });
    mkdirSync(join(variants, 'esp32'), { recursive: true });
    file(join(sdk, 'flags', 'cpp_flags'));
    file(esptool);
    for (const tool of ['gcc', 'g++', 'gcc-ar', 'size']) {
      file(join(bin, `xtensa-esp-elf-${tool}${suffix}`));
    }

    process.env.ARDUINO15_DIR = emptyArduino15;
    process.env.AF_ESP32_XTENSA_BIN = bin;
    process.env.AF_ESP32_XTENSA_ROOT = compilerRoot;
    process.env.AF_ESP32_CORE = core;
    process.env.AF_ESP32_VARIANTS = variants;
    process.env.AF_ESP32_PLATFORM = join(root, 'platform');
    process.env.AF_ESP32_SDK_ROOT = sdkRoot;
    process.env.AF_ESP32_ESPTOOL = esptool;

    const config = detectLocalToolchain();
    const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
    const esp32 = boards.get('esp32:esp32:esp32')!;
    const esp32c3 = boards.get('esp32:esp32:esp32c3')!;

    expect(config.esp32?.xtensaRootDir).toBe(compilerRoot);
    expect(config.esp32 && esp32BoardSupported(config.esp32, esp32)).toBe(true);
    expect(config.esp32 && esp32BoardSupported(config.esp32, esp32c3)).toBe(false);
  });

  it('requires both ESP32-P4 ChipVariant SDKs before advertising the board', () => {
    const root = mkdtempSync(join(tmpdir(), 'af-esp32-p4-support-'));
    roots.push(root);
    const bin = join(root, 'riscv', 'bin');
    const core = join(root, 'platform', 'cores', 'esp32');
    const variants = join(root, 'platform', 'variants');
    const earlySdk = join(root, 'sdk', 'esp32p4_es');
    const postV3Sdk = join(root, 'sdk', 'esp32p4');
    const suffix = platform() === 'win32' ? '.exe' : '';
    const config: Esp32Config = {
      riscvBinDir: bin,
      coreDir: core,
      variantsDir: variants,
      platformDir: join(root, 'platform'),
      sdkRootFor: (target) => ({
        esp32p4_es: earlySdk,
        esp32p4: postV3Sdk,
      }[target] ?? null),
      esptool: join(root, 'esptool'),
    };
    for (const tool of ['gcc', 'g++', 'gcc-ar', 'size']) {
      file(join(bin, `riscv32-esp-elf-${tool}${suffix}`));
    }
    file(join(core, 'Arduino.h'));
    file(join(variants, 'esp32p4', 'pins_arduino.h'));
    file(join(earlySdk, 'flags', 'cpp_flags'));
    file(join(postV3Sdk, 'flags', 'cpp_flags'));
    file(config.esptool);

    const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
    const p4 = boards.get('esp32:esp32:esp32p4')!;
    expect(esp32BoardSupported(config, p4)).toBe(true);

    rmSync(join(earlySdk, 'flags'), { recursive: true, force: true });
    expect(esp32BoardSupported(config, p4)).toBe(false);
  });

  it('mounts the SDK selected by the ESP32-P4 ChipVariant option', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-esp32-p4-sdk-mount-'));
    roots.push(root);
    const earlySdk = join(root, 'sdk', 'esp32p4_es');
    const postV3Sdk = join(root, 'sdk', 'esp32p4');
    const config: Esp32Config = {
      riscvBinDir: join(root, 'riscv', 'bin'),
      coreDir: join(root, 'platform', 'cores', 'esp32'),
      variantsDir: join(root, 'platform', 'variants'),
      platformDir: join(root, 'platform'),
      sdkRootFor: (target) => ({
        esp32p4_es: earlySdk,
        esp32p4: postV3Sdk,
      }[target] ?? null),
      esptool: join(root, 'esptool'),
    };
    for (const sdk of [earlySdk, postV3Sdk]) {
      file(join(sdk, 'bin', 'bootloader_qio_80m.elf'));
      file(join(sdk, 'flags', 'cpp_flags'));
    }
    file(join(config.platformDir, 'tools', 'partitions', 'default.csv'));
    file(join(config.platformDir, 'tools', 'partitions', 'boot_app0.bin'));
    file(join(config.platformDir, 'tools', platform() === 'win32' ? 'gen_esp32part.exe' : 'gen_esp32part.py'));
    file(config.esptool);

    const mounted: string[][] = [];
    const recordingExecutor: SandboxExecutor = {
      name: 'p4-sdk-mount-test',
      isolationLevel: 'none',
      async exec(request) {
        mounted.push(request.readOnlyPaths);
        return {
          code: 1,
          signal: null,
          stdout: '',
          stderr: 'stop after mount capture',
          durationMs: 1,
          timedOut: false,
          truncated: false,
        };
      },
    };
    const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
    const p4 = boards.get('esp32:esp32:esp32p4')!;
    const toolchain = new Esp32Toolchain(config, recordingExecutor, join(root, 'cache'));

    await toolchain.ensureStaticParts(p4, { chip_variant: 'prev3' });
    await toolchain.ensureStaticParts(p4, { chip_variant: 'postv3' });

    expect(mounted).toHaveLength(2);
    expect(mounted[0]).toContain(earlySdk);
    expect(mounted[0]).not.toContain(postV3Sdk);
    expect(mounted[1]).toContain(postV3Sdk);
    expect(mounted[1]).not.toContain(earlySdk);
  });

  it('prefers the target-specific Xtensa launcher for ESP32 and ESP32-S3', () => {
    const root = mkdtempSync(join(tmpdir(), 'af-esp32-launcher-'));
    roots.push(root);
    const { resolver, xtensaBin } = makeToolResolver(root);
    const suffix = platform() === 'win32' ? '.exe' : '';
    for (const prefix of ['xtensa-esp32-elf-', 'xtensa-esp32s3-elf-', 'xtensa-esp-elf-']) {
      file(join(xtensaBin, `${prefix}g++${suffix}`));
      file(join(xtensaBin, `${prefix}gcc${suffix}`));
    }

    const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
    const esp32 = boards.get('esp32:esp32:esp32')!;
    const esp32s3 = boards.get('esp32:esp32:esp32s3')!;

    expect(resolver.tool(esp32, 'gcc')).toBe(join(xtensaBin, `xtensa-esp32-elf-gcc${suffix}`));
    expect(resolver.tool(esp32s3, 'gcc')).toBe(join(xtensaBin, `xtensa-esp32s3-elf-gcc${suffix}`));
  });

  it('falls back to the generic Xtensa launcher when target launchers are absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'af-esp32-launcher-fallback-'));
    roots.push(root);
    const { resolver, xtensaBin } = makeToolResolver(root);
    const suffix = platform() === 'win32' ? '.exe' : '';
    file(join(xtensaBin, `xtensa-esp-elf-g++${suffix}`));
    file(join(xtensaBin, `xtensa-esp-elf-size${suffix}`));

    const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
    const esp32 = boards.get('esp32:esp32:esp32')!;
    const esp32s3 = boards.get('esp32:esp32:esp32s3')!;

    expect(resolver.tool(esp32, 'size')).toBe(join(xtensaBin, `xtensa-esp-elf-size${suffix}`));
    expect(resolver.tool(esp32s3, 'size')).toBe(join(xtensaBin, `xtensa-esp-elf-size${suffix}`));
  });

  it('keeps ESP32-C3 on the RISC-V compiler prefix', () => {
    const root = mkdtempSync(join(tmpdir(), 'af-esp32-riscv-launcher-'));
    roots.push(root);
    const { resolver, xtensaBin, riscvBin } = makeToolResolver(root);
    const suffix = platform() === 'win32' ? '.exe' : '';
    file(join(xtensaBin, `xtensa-esp32c3-elf-g++${suffix}`));
    file(join(riscvBin, `riscv32-esp-elf-g++${suffix}`));
    file(join(riscvBin, `riscv32-esp-elf-gcc-ar${suffix}`));

    const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
    const esp32c3 = boards.get('esp32:esp32:esp32c3')!;

    expect(resolver.tool(esp32c3, 'gcc-ar')).toBe(join(riscvBin, `riscv32-esp-elf-gcc-ar${suffix}`));
  });
});
