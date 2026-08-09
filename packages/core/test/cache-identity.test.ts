import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  contentIdentity, contentIdentityAsync, libraryIdentity,
  memoizedToolchainIdentityAsync, nativeToolchainPackIdentityAsync,
  toolchainIdentity, toolchainIdentityAsync,
} from '../src/cache/identity.js';
import { BoardRegistry, type BoardDefinition } from '../src/toolchain/board.js';
import { toolPath, type ToolchainConfig } from '../src/toolchain/config.js';
import { loadLibrary } from '../src/toolchain/library.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'af-cache-identity-'));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }
});

describe('contentIdentity', () => {
  it('只依赖排序后的相对路径和文件内容', () => {
    const first = tempRoot();
    const second = tempRoot();

    write(join(first, 'b.txt'), 'bravo');
    write(join(first, 'nested', 'a.txt'), 'alpha');
    // 反向创建，证明摘要不依赖文件系统枚举顺序。
    write(join(second, 'nested', 'a.txt'), 'alpha');
    write(join(second, 'b.txt'), 'bravo');

    expect(contentIdentity(first)).toBe(contentIdentity(second));

    // 内容变化但大小不变，不能靠 size/mtime 蒙混过去。
    write(join(second, 'b.txt'), 'BRAVO');
    expect(contentIdentity(first)).not.toBe(contentIdentity(second));
  });

  it('缺失路径有稳定身份且不会抛错', () => {
    const root = tempRoot();
    expect(contentIdentity(join(root, 'missing'))).toBe(contentIdentity(join(root, 'elsewhere')));
  });
});

describe('contentIdentity async', () => {
  it('preserves the stable-file identity format', async () => {
    const root = tempRoot();
    write(join(root, 'nested', 'source.cpp'), 'int answer() { return 42; }\n');
    write(join(root, 'nested', 'header.h'), '#pragma once\n');

    await expect(contentIdentityAsync(root)).resolves.toBe(contentIdentity(root));
  });
});

describe('libraryIdentity', () => {
  it('同名同版本库的实际源码变化会改变身份', () => {
    const root = tempRoot();
    write(join(root, 'library.properties'), 'name=Demo\nversion=1.0.0\narchitectures=*\n');
    write(join(root, 'src', 'Demo.h'), '#pragma once\nint answer();\n');
    const source = join(root, 'src', 'Demo.cpp');
    write(source, 'int answer(){return 1;}\n');

    const before = libraryIdentity(loadLibrary(root)!);
    write(source, 'int answer(){return 2;}\n');
    const after = libraryIdentity(loadLibrary(root)!);

    expect(after).not.toBe(before);
  });
});

function board(arch: 'avr' | 'esp32'): BoardDefinition {
  return {
    fqbn: arch === 'avr' ? 'arduino:avr:test' : 'esp32:esp32:test',
    name: `${arch} test`,
    arch,
    pins: [],
    options: [],
    flashTotal: 1024,
    ramTotal: 256,
    upload: { protocol: arch === 'avr' ? 'stk500v1' : 'esp32' },
    build: {
      mcu: arch === 'avr' ? 'atmega328p' : 'esp32',
      fCpu: arch === 'avr' ? '16000000L' : '240000000L',
      variant: arch,
      defines: [],
      ...(arch === 'esp32' ? { tarch: 'xtensa', target: 'esp32' } : {}),
    },
  };
}

describe('toolchainIdentity', () => {
  it('keeps Core, Variant, and SDK content out of the native Toolchain Pack identity', async () => {
    const root = tempRoot();
    const compilerRoot = join(root, 'compiler');
    const bin = join(compilerRoot, 'bin');
    const core = join(root, 'platform', 'core');
    const variants = join(root, 'platform', 'variants');
    const sdk = join(root, 'sdk');
    const esptool = join(root, 'tools', 'esptool');
    const suffix = process.platform === 'win32' ? '.exe' : '';
    for (const name of ['gcc', 'g++', 'gcc-ar', 'objcopy', 'size']) {
      write(join(bin, `xtensa-esp32-elf-${name}${suffix}`), `tool:${name}:a`);
    }
    write(esptool, 'esptool-a');
    write(join(core, 'Arduino.h'), 'core-a');
    write(join(variants, 'esp32', 'pins_arduino.h'), 'variant-a');
    write(join(sdk, 'flags', 'cpp_flags'), 'sdk-a');

    const config: ToolchainConfig = {
      esp32: {
        xtensaBinDir: bin,
        xtensaRootDir: compilerRoot,
        coreDir: core,
        variantsDir: variants,
        platformDir: join(root, 'platform'),
        sdkRootFor: () => sdk,
        esptool,
      },
      cacheDir: join(root, 'cache'),
      workDir: join(root, 'work'),
      librariesDirs: [],
    };
    const boards = new BoardRegistry();
    boards.add(board('esp32'));
    const provenance = { kind: 'bundle' as const, value: 'fixture-v1' };

    const first = await nativeToolchainPackIdentityAsync(config, boards, 'esp32', provenance);
    write(join(core, 'Arduino.h'), 'core-b');
    write(join(variants, 'esp32', 'pins_arduino.h'), 'variant-b');
    write(join(sdk, 'flags', 'cpp_flags'), 'sdk-b');
    expect(await nativeToolchainPackIdentityAsync(config, boards, 'esp32', provenance)).toBe(first);

    write(join(bin, `xtensa-esp32-elf-g++${suffix}`), 'tool:g++:b');
    expect(await nativeToolchainPackIdentityAsync(config, boards, 'esp32', provenance)).not.toBe(first);
  });

  it('覆盖编译器、core、SDK 和板卡定义', () => {
    const root = tempRoot();
    const avr = {
      binDir: join(root, 'avr', 'bin'),
      coreDir: join(root, 'avr', 'core'),
      variantsDir: join(root, 'avr', 'variants'),
    };
    const sdk = join(root, 'esp', 'sdk');
    const platformDir = join(root, 'esp', 'platform');
    const esptool = join(root, 'esp', 'esptool');
    const config: ToolchainConfig = {
      avr,
      esp32: {
        xtensaBinDir: join(root, 'esp', 'bin'),
        coreDir: join(root, 'esp', 'core'),
        variantsDir: join(root, 'esp', 'variants'),
        platformDir,
        sdkRootFor: (target) => target === 'esp32' ? sdk : null,
        esptool,
      },
      cacheDir: join(root, 'cache'),
      workDir: join(root, 'work'),
      librariesDirs: [],
    };

    write(toolPath(avr, 'avr-g++'), 'compiler-a');
    write(join(avr.coreDir, 'Arduino.h'), 'core-a');
    write(join(avr.variantsDir, 'avr', 'pins_arduino.h'), 'variant-a');
    write(join(config.esp32!.coreDir, 'Arduino.h'), 'esp-core-a');
    write(join(config.esp32!.variantsDir, 'esp32', 'pins_arduino.h'), 'esp-variant-a');
    write(join(sdk, 'flags', 'cpp_flags'), 'sdk-a');
    write(join(platformDir, 'tools', 'partitions', 'default.csv'), 'part-a');
    write(esptool, 'esptool-a');

    const boards = new BoardRegistry();
    boards.add(board('avr'));
    boards.add(board('esp32'));

    let previous = toolchainIdentity(config, boards);
    write(toolPath(avr, 'avr-g++'), 'compiler-b');
    let next = toolchainIdentity(config, boards);
    expect(next).not.toBe(previous);

    previous = next;
    write(join(avr.coreDir, 'Arduino.h'), 'core-b');
    next = toolchainIdentity(config, boards);
    expect(next).not.toBe(previous);

    previous = next;
    write(join(sdk, 'flags', 'cpp_flags'), 'sdk-b');
    next = toolchainIdentity(config, boards);
    expect(next).not.toBe(previous);

    const changedBoards = new BoardRegistry();
    const changedAvr = board('avr');
    changedAvr.build.fCpu = '8000000L';
    changedBoards.add(changedAvr);
    changedBoards.add(board('esp32'));
    expect(toolchainIdentity(config, changedBoards)).not.toBe(next);
  });

  it('架构身份互不扫描或失效对方工具链', () => {
    const root = tempRoot();
    const avr = {
      binDir: join(root, 'avr', 'bin'),
      coreDir: join(root, 'avr', 'core'),
      variantsDir: join(root, 'avr', 'variants'),
    };
    const sdk = join(root, 'esp', 'sdk');
    const config: ToolchainConfig = {
      avr,
      esp32: {
        xtensaBinDir: join(root, 'esp', 'bin'),
        coreDir: join(root, 'esp', 'core'),
        variantsDir: join(root, 'esp', 'variants'),
        platformDir: join(root, 'esp', 'platform'),
        sdkRootFor: () => sdk,
        esptool: join(root, 'esp', 'esptool'),
      },
      cacheDir: join(root, 'cache'),
      workDir: join(root, 'work'),
      librariesDirs: [],
    };
    write(toolPath(avr, 'avr-g++'), 'avr-a');
    write(join(avr.coreDir, 'Arduino.h'), 'avr-core-a');
    write(join(config.esp32.coreDir, 'Arduino.h'), 'esp-core-a');
    write(join(sdk, 'flags', 'cpp_flags'), 'esp-sdk-a');

    const boards = new BoardRegistry();
    boards.add(board('avr'));
    boards.add(board('esp32'));

    const avrBefore = toolchainIdentity(config, boards, 'avr');
    const espBefore = toolchainIdentity(config, boards, 'esp32');
    write(join(sdk, 'flags', 'cpp_flags'), 'esp-sdk-b');

    expect(toolchainIdentity(config, boards, 'avr')).toBe(avrBefore);
    expect(toolchainIdentity(config, boards, 'esp32')).not.toBe(espBefore);
  });

  it('tracks every trusted SDK target reachable from an ESP32 board menu', () => {
    const root = tempRoot();
    const earlySdk = join(root, 'esp', 'sdk', 'esp32p4_es');
    const postV3Sdk = join(root, 'esp', 'sdk', 'esp32p4');
    const config: ToolchainConfig = {
      esp32: {
        riscvBinDir: join(root, 'esp', 'bin'),
        coreDir: join(root, 'esp', 'core'),
        variantsDir: join(root, 'esp', 'variants'),
        platformDir: join(root, 'esp', 'platform'),
        sdkRootFor: (target) => ({
          esp32p4_es: earlySdk,
          esp32p4: postV3Sdk,
        }[target] ?? null),
        esptool: join(root, 'esp', 'esptool'),
      },
      cacheDir: join(root, 'cache'),
      workDir: join(root, 'work'),
      librariesDirs: [],
    };
    write(join(config.esp32.coreDir, 'Arduino.h'), 'core\n');
    write(join(config.esp32.variantsDir, 'esp32p4', 'pins_arduino.h'), 'variant\n');
    write(join(earlySdk, 'flags', 'cpp_flags'), 'early-a\n');
    write(join(postV3Sdk, 'flags', 'cpp_flags'), 'post-a\n');

    const p4 = board('esp32');
    p4.fqbn = 'esp32:esp32:esp32p4';
    p4.build = {
      ...p4.build,
      mcu: 'esp32p4',
      sdkTarget: 'esp32p4_es',
      tarch: 'riscv32',
      target: 'esp',
      variant: 'esp32p4',
      optionEffects: {
        chip_variant: {
          prev3: { sdkTarget: 'esp32p4_es' },
          postv3: { sdkTarget: 'esp32p4' },
        },
      },
    };
    const boards = new BoardRegistry();
    boards.add(p4);

    const first = toolchainIdentity(config, boards, 'esp32');
    write(join(earlySdk, 'flags', 'cpp_flags'), 'early-b\n');
    const afterEarlyChange = toolchainIdentity(config, boards, 'esp32');
    expect(afterEarlyChange).not.toBe(first);

    write(join(postV3Sdk, 'flags', 'cpp_flags'), 'post-b\n');
    expect(toolchainIdentity(config, boards, 'esp32')).not.toBe(afterEarlyChange);
  });

  it('matches the synchronous format and is single-flight', async () => {
    const root = tempRoot();
    const sdk = join(root, 'esp', 'sdk');
    const config: ToolchainConfig = {
      esp32: {
        xtensaBinDir: join(root, 'esp', 'bin'),
        coreDir: join(root, 'esp', 'core'),
        variantsDir: join(root, 'esp', 'variants'),
        platformDir: join(root, 'esp', 'platform'),
        sdkRootFor: () => sdk,
        esptool: join(root, 'esp', 'esptool'),
      },
      cacheDir: join(root, 'cache'),
      workDir: join(root, 'work'),
      librariesDirs: [],
    };
    write(join(config.esp32.coreDir, 'Arduino.h'), 'core\n');
    write(join(config.esp32.variantsDir, 'esp32', 'pins_arduino.h'), 'variant\n');
    write(join(sdk, 'flags', 'cpp_flags'), 'sdk\n');

    const boards = new BoardRegistry();
    boards.add(board('esp32'));

    const first = memoizedToolchainIdentityAsync(config, boards, 'esp32');
    const second = memoizedToolchainIdentityAsync(config, boards, 'esp32');
    expect(second).toBe(first);
    await expect(first).resolves.toBe(toolchainIdentity(config, boards, 'esp32'));
    await expect(toolchainIdentityAsync(config, boards, 'esp32'))
      .resolves.toBe(toolchainIdentity(config, boards, 'esp32'));
  });
});
