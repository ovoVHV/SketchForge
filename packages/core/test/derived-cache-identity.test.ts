import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_LIMITS, type ExecRequest, type SandboxExecutor } from '../src/sandbox/types.js';
import { AvrToolchain } from '../src/toolchain/avr.js';
import type { BoardDefinition } from '../src/toolchain/board.js';
import type { ArchToolchain, Esp32Toolchain as Esp32Config } from '../src/toolchain/config.js';
import { Esp32Toolchain } from '../src/toolchain/esp32.js';
import { loadLibrary, type Library } from '../src/toolchain/library.js';
import { getDerivedCacheManager } from '../src/cache/derived.js';

const roots: string[] = [];
const FIXED_TIME = new Date('2024-01-01T00:00:00.000Z');

const executor: SandboxExecutor = {
  name: 'cache-key-test',
  isolationLevel: 'none',
  async exec() {
    return {
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      truncated: false,
    };
  },
};

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'af-derived-cache-'));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  utimesSync(path, FIXED_TIME, FIXED_TIME);
}

function replaceWithSameMetadata(path: string, content: string): void {
  const before = statSync(path);
  writeFileSync(path, content, 'utf8');
  utimesSync(path, FIXED_TIME, FIXED_TIME);
  const after = statSync(path);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);
}

function outputWritingExecutor(failFirstArchive = false): SandboxExecutor {
  let failArchive = failFirstArchive;
  return {
    name: 'cache-lifecycle-test',
    isolationLevel: 'none',
    async exec(request) {
      const outputIndex = request.args.lastIndexOf('-o');
      const isArchive = request.args[0] === 'rcs';
      const outputPath = isArchive
        ? request.args[1]
        : outputIndex >= 0
          ? request.args[outputIndex + 1]
          : request.args.includes('-q')
            ? request.args[request.args.length - 1]
            : undefined;
      if (outputPath) write(outputPath, isArchive ? 'archive' : 'object');

      const failed = isArchive && failArchive;
      if (failed) failArchive = false;
      return {
        code: failed ? 1 : 0,
        signal: null,
        stdout: '',
        stderr: failed ? 'forced archive failure' : '',
        durationMs: 1,
        timedOut: false,
        truncated: false,
      };
    },
  };
}

function avrBoard(): BoardDefinition {
  return {
    fqbn: 'arduino:avr:test',
    name: 'AVR test',
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
      lto: true,
    },
  };
}

function espBoard(): BoardDefinition {
  return {
    fqbn: 'esp32:esp32:test',
    name: 'ESP32 test',
    arch: 'esp32',
    pins: [],
    options: [],
    flashTotal: 4 * 1024 * 1024,
    ramTotal: 320 * 1024,
    upload: { protocol: 'esp32' },
    build: {
      mcu: 'esp32',
      fCpu: '240000000L',
      variant: 'esp32',
      defines: [],
      tarch: 'xtensa',
      target: 'esp32',
    },
  };
}

function makeAvrConfig(root: string): ArchToolchain {
  const config: ArchToolchain = {
    rootDir: join(root, 'toolchain'),
    binDir: join(root, 'toolchain', 'bin'),
    coreDir: join(root, 'core'),
    variantsDir: join(root, 'variants'),
  };
  write(join(config.rootDir!, 'bin', 'avr-g++'), 'compiler-a');
  write(join(config.coreDir, 'Arduino.h'), '#define CORE 1\n');
  write(join(config.coreDir, 'main.cpp'), 'int core_value=1;\n');
  write(join(config.variantsDir, 'standard', 'pins_arduino.h'), '#define PIN 1\n');
  return config;
}

function makeEspConfig(root: string): Esp32Config {
  const toolRoot = join(root, 'esp-toolchain');
  const sdk = join(root, 'sdk');
  const config: Esp32Config = {
    xtensaBinDir: join(toolRoot, 'bin'),
    coreDir: join(root, 'esp-core'),
    variantsDir: join(root, 'esp-variants'),
    platformDir: join(root, 'esp-platform'),
    sdkRootFor: () => sdk,
    esptool: join(root, 'esptool'),
  };
  write(join(toolRoot, 'bin', 'compiler.data'), 'compiler-a');
  write(join(sdk, 'flags', 'cpp_flags'), '-std=gnu++17\n');
  write(join(sdk, 'flags', 'c_flags'), '-std=gnu17   \n');
  write(join(sdk, 'flags', 'S_flags'), '-x assembler\n');
  write(join(sdk, 'flags', 'defines'), '-DESP_PLATFORM\n');
  write(join(sdk, 'flags', 'includes'), '-iwithprefixbefore system\n');
  write(join(sdk, 'include', 'system', 'sdk.h'), '#define SDK 1\n');
  write(join(sdk, 'bin', 'bootloader_dio_40m.elf'), 'boot-elf-a');
  write(join(config.coreDir, 'Arduino.h'), '#define ARDUINO 1\n');
  write(join(config.coreDir, 'core.cpp'), 'int core_value=1;\n');
  write(join(config.variantsDir, 'esp32', 'pins_arduino.h'), '#define PIN 1\n');
  write(join(config.platformDir, 'platform.txt'), 'name=esp32-a\n');
  write(join(config.platformDir, 'tools', 'partitions', 'default.csv'), 'partition-a');
  write(join(config.platformDir, 'tools', 'partitions', 'boot_app0.bin'), 'boot-app-a');
  write(
    join(config.platformDir, 'tools', platform() === 'win32' ? 'gen_esp32part.exe' : 'gen_esp32part.py'),
    'part-tool-a',
  );
  write(config.esptool, 'esptool-a');
  return config;
}

function makeLibrary(root: string, name = 'Demo'): Library {
  write(
    join(root, 'library.properties'),
    `name=${name}\nversion=1.0.0\narchitectures=*\n`,
  );
  write(join(root, 'src', `${name}.h`), '#define ANSWER 1\n');
  write(join(root, 'src', `${name}.cpp`), 'int answer(){return 1;}\n');
  const library = loadLibrary(root);
  expect(library).not.toBeNull();
  return library!;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('AVR derived cache identity', () => {
  it('discards failed archives and keeps successful artifacts leased through consumption', async () => {
    const root = tempRoot();
    const config = makeAvrConfig(root);
    const board = avrBoard();
    const cacheDir = join(root, 'cache');
    const previousBytes = process.env.AF_DERIVED_CACHE_MAX_BYTES;
    const previousEntries = process.env.AF_DERIVED_CACHE_MAX_ENTRIES;
    process.env.AF_DERIVED_CACHE_MAX_BYTES = '0';
    process.env.AF_DERIVED_CACHE_MAX_ENTRIES = '0';
    let toolchain: AvrToolchain;
    try {
      toolchain = new AvrToolchain(config, outputWritingExecutor(true), cacheDir);
    } finally {
      if (previousBytes === undefined) delete process.env.AF_DERIVED_CACHE_MAX_BYTES;
      else process.env.AF_DERIVED_CACHE_MAX_BYTES = previousBytes;
      if (previousEntries === undefined) delete process.env.AF_DERIVED_CACHE_MAX_ENTRIES;
      else process.env.AF_DERIVED_CACHE_MAX_ENTRIES = previousEntries;
    }

    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_010_000);
    const failed = await toolchain.ensureCore(board);
    expect(failed.path).toBe('');
    const coresDir = join(cacheDir, 'cores');
    expect(existsSync(coresDir) ? readdirSync(coresDir) : []).toHaveLength(0);

    const manager = getDerivedCacheManager(cacheDir);
    const succeeded = await toolchain.ensureCore(board, (path) => {
      vi.advanceTimersByTime(5_001);
      expect(existsSync(path)).toBe(true);
      expect(manager.prune().quotaSatisfied).toBe(false);
    });
    expect(succeeded.built).toBe(true);
    expect(existsSync(succeeded.path)).toBe(true);

    vi.runOnlyPendingTimers();
    expect(existsSync(succeeded.path)).toBe(false);
  });

  it('invalidates core.a for same-metadata source or compiler changes', () => {
    const root = tempRoot();
    const config = makeAvrConfig(root);
    const board = avrBoard();
    type AvrKeyAccess = { coreCacheKey(value: BoardDefinition): string };

    const first = (new AvrToolchain(config, executor, join(root, 'cache')) as unknown as AvrKeyAccess)
      .coreCacheKey(board);
    replaceWithSameMetadata(join(config.coreDir, 'main.cpp'), 'int core_value=2;\n');
    const second = (new AvrToolchain(config, executor, join(root, 'cache')) as unknown as AvrKeyAccess)
      .coreCacheKey(board);
    expect(second).not.toBe(first);

    replaceWithSameMetadata(join(config.rootDir!, 'bin', 'avr-g++'), 'compiler-b');
    const third = (new AvrToolchain(config, executor, join(root, 'cache')) as unknown as AvrKeyAccess)
      .coreCacheKey(board);
    expect(third).not.toBe(second);
  });

  it('invalidates library .a for own headers and dependency headers', () => {
    const root = tempRoot();
    const config = makeAvrConfig(root);
    const board = avrBoard();
    const libraryRoot = join(root, 'library');
    const dependency = join(root, 'dependency');
    let library = makeLibrary(libraryRoot);
    write(join(dependency, 'Dependency.h'), '#define DEP 1\n');
    type AvrKeyAccess = {
      libraryCacheKey(value: BoardDefinition, lib: Library, includes: string[]): string;
    };
    const includes = [...library.includeDirs, dependency];

    const first = (new AvrToolchain(config, executor, join(root, 'cache')) as unknown as AvrKeyAccess)
      .libraryCacheKey(board, library, includes);
    replaceWithSameMetadata(join(libraryRoot, 'src', 'Demo.h'), '#define ANSWER 2\n');
    library = loadLibrary(libraryRoot)!;
    const second = (new AvrToolchain(config, executor, join(root, 'cache')) as unknown as AvrKeyAccess)
      .libraryCacheKey(board, library, includes);
    expect(second).not.toBe(first);

    replaceWithSameMetadata(join(dependency, 'Dependency.h'), '#define DEP 2\n');
    const third = (new AvrToolchain(config, executor, join(root, 'cache')) as unknown as AvrKeyAccess)
      .libraryCacheKey(board, library, includes);
    expect(third).not.toBe(second);
  });
});

describe('ESP32 derived cache identity', () => {
  it('passes one official ESP32 macro to every local compiler and rejects duplicates before execution', async () => {
    const root = tempRoot();
    const config = makeEspConfig(root);
    const board = espBoard();
    const options = { flash_mode: 'dio' };
    write(join(config.coreDir, 'core.c'), 'int core_c_value=1;\n');
    write(join(config.coreDir, 'core.S'), '.text\n');

    const requests: ExecRequest[] = [];
    const writer = outputWritingExecutor();
    const recordingExecutor: SandboxExecutor = {
      name: 'esp32-argument-capture-test',
      isolationLevel: 'none',
      async exec(request) {
        requests.push(request);
        return writer.exec(request);
      },
    };
    const result = await new Esp32Toolchain(config, recordingExecutor, join(root, 'cache'))
      .ensureCore(board, options);
    expect(result.path).not.toBe('');

    const compileRequests = requests.filter((request) => request.args.includes('-c'));
    expect(compileRequests).toHaveLength(3);
    for (const request of compileRequests) {
      expect(request.args.filter((argument) => /^-[DU]ESP32(?:=|$)/.test(argument)))
        .toEqual(['-DESP32=ESP32']);
    }

    const duplicateBoard: BoardDefinition = {
      ...board,
      build: { ...board.build, defines: [...board.build.defines, 'ESP32=ESP32'] },
    };
    const duplicateRequests: ExecRequest[] = [];
    const duplicateExecutor: SandboxExecutor = {
      name: 'esp32-duplicate-define-test',
      isolationLevel: 'none',
      async exec(request) {
        duplicateRequests.push(request);
        return writer.exec(request);
      },
    };
    await expect(new Esp32Toolchain(config, duplicateExecutor, join(root, 'duplicate-cache'))
      .ensureCore(duplicateBoard, options))
      .rejects.toThrow(/exactly one -DESP32=ESP32/);
    expect(duplicateRequests).toEqual([]);
  });

  it('reports cold core-cache progress and the later shared-cache hit', async () => {
    const root = tempRoot();
    const config = makeEspConfig(root);
    const board = espBoard();
    const options = { flash_mode: 'dio' };
    const toolchain = new Esp32Toolchain(config, outputWritingExecutor(), join(root, 'cache'));
    const cold: Array<{ completed: number; total: number; cached: boolean; archiving?: boolean }> = [];

    await toolchain.ensureCore(board, options, undefined, (progress) => cold.push(progress));
    expect(cold[0]).toMatchObject({ completed: 0, total: 1, cached: false });
    expect(cold).toContainEqual(expect.objectContaining({ completed: 1, total: 1, cached: false }));
    expect(cold).toContainEqual(expect.objectContaining({ archiving: true }));

    const warm: Array<{ completed: number; total: number; cached: boolean }> = [];
    await toolchain.ensureCore(board, options, undefined, (progress) => warm.push(progress));
    expect(warm).toContainEqual({ completed: 1, total: 1, cached: true });
  });

  it('raises the file limit only while generating the PCH', async () => {
    const root = tempRoot();
    const config = makeEspConfig(root);
    const board = espBoard();
    const requests: ExecRequest[] = [];
    const recordingExecutor: SandboxExecutor = {
      name: 'limit-test',
      isolationLevel: 'none',
      async exec(request) {
        requests.push(request);
        return {
          code: 0,
          signal: null,
          stdout: '',
          stderr: '',
          durationMs: 1,
          timedOut: false,
          truncated: false,
        };
      },
    };
    const normalFileLimit = 8 * 1024 * 1024;
    const toolchain = new Esp32Toolchain(
      config,
      recordingExecutor,
      join(root, 'cache'),
      { ...DEFAULT_LIMITS, fileSizeBytes: normalFileLimit },
    );
    type PchAccess = {
      ensurePch(value: BoardDefinition, opts: Record<string, string>, inc: string[]): Promise<{ dir: string }>;
    };

    await (toolchain as unknown as PchAccess).ensurePch(board, { flash_mode: 'dio' }, []);
    const pchRequest = requests.find((request) => request.args.includes('c++-header'));
    expect(pchRequest?.limits.fileSizeBytes).toBe(128 * 1024 * 1024);

    requests.length = 0;
    await toolchain.ensureCore(board, { flash_mode: 'dio' });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.limits.fileSizeBytes === normalFileLimit)).toBe(true);
  });

  it('invalidates core L1 for same-metadata source or compiler changes', async () => {
    const root = tempRoot();
    const config = makeEspConfig(root);
    const board = espBoard();
    const options = { flash_mode: 'dio' };

    const first = await new Esp32Toolchain(config, executor, join(root, 'cache'))
      .ensureCore(board, options);
    replaceWithSameMetadata(join(config.coreDir, 'core.cpp'), 'int core_value=2;\n');
    const second = await new Esp32Toolchain(config, executor, join(root, 'cache'))
      .ensureCore(board, options);
    expect(second.path).not.toBe(first.path);

    replaceWithSameMetadata(
      join(dirname(config.xtensaBinDir!), 'bin', 'compiler.data'),
      'compiler-b',
    );
    const third = await new Esp32Toolchain(config, executor, join(root, 'cache'))
      .ensureCore(board, options);
    expect(third.path).not.toBe(second.path);
  });

  it('binds library L1 and PCH to library, dependency, and SDK contents', async () => {
    const root = tempRoot();
    const config = makeEspConfig(root);
    const board = espBoard();
    const options = { flash_mode: 'dio' };
    const libraryRoot = join(root, 'library');
    const dependency = join(root, 'dependency');
    let library = makeLibrary(libraryRoot);
    write(join(dependency, 'Dependency.h'), '#define DEP 1\n');
    let includes = [...library.includeDirs, dependency];

    const firstToolchain = new Esp32Toolchain(config, executor, join(root, 'cache'));
    const firstLibrary = await firstToolchain.ensureLibrary(board, options, library, includes);
    type PchAccess = {
      ensurePch(value: BoardDefinition, opts: Record<string, string>, inc: string[]): Promise<{ dir: string }>;
    };
    const firstPch = await (firstToolchain as unknown as PchAccess).ensurePch(board, options, includes);

    replaceWithSameMetadata(join(libraryRoot, 'src', 'Demo.h'), '#define ANSWER 2\n');
    library = loadLibrary(libraryRoot)!;
    includes = [...library.includeDirs, dependency];
    const secondToolchain = new Esp32Toolchain(config, executor, join(root, 'cache'));
    const secondLibrary = await secondToolchain.ensureLibrary(board, options, library, includes);
    const secondPch = await (secondToolchain as unknown as PchAccess).ensurePch(board, options, includes);
    expect(secondLibrary.path).not.toBe(firstLibrary.path);
    expect(secondPch.dir).not.toBe(firstPch.dir);

    replaceWithSameMetadata(join(dependency, 'Dependency.h'), '#define DEP 2\n');
    const thirdToolchain = new Esp32Toolchain(config, executor, join(root, 'cache'));
    const thirdLibrary = await thirdToolchain.ensureLibrary(board, options, library, includes);
    const thirdPch = await (thirdToolchain as unknown as PchAccess).ensurePch(board, options, includes);
    expect(thirdLibrary.path).not.toBe(secondLibrary.path);
    expect(thirdPch.dir).not.toBe(secondPch.dir);

    const sdkCppFlags = join(root, 'sdk', 'flags', 'cpp_flags');
    replaceWithSameMetadata(sdkCppFlags, '-std=gnu++14\n');
    const fourthToolchain = new Esp32Toolchain(config, executor, join(root, 'cache'));
    const fourthLibrary = await fourthToolchain.ensureLibrary(board, options, library, includes);
    const fourthPch = await (fourthToolchain as unknown as PchAccess).ensurePch(board, options, includes);
    expect(fourthLibrary.path).not.toBe(thirdLibrary.path);
    expect(fourthPch.dir).not.toBe(thirdPch.dir);
  });

  it('keeps mutable libraries content-addressed with a toolchain snapshot', async () => {
    const root = tempRoot();
    const config = makeEspConfig(root);
    const board = espBoard();
    const libraryRoot = join(root, 'library');
    let library = makeLibrary(libraryRoot);
    const cacheDir = join(root, 'cache');
    const snapshot = 'full-local-toolchain-snapshot';

    const first = await new Esp32Toolchain(
      config, executor, cacheDir, undefined, snapshot, false, true,
    ).ensureLibrary(board, { flash_mode: 'dio' }, library, library.includeDirs);
    replaceWithSameMetadata(join(libraryRoot, 'src', 'Demo.h'), '#define ANSWER 2\n');
    library = loadLibrary(libraryRoot)!;
    const second = await new Esp32Toolchain(
      config, executor, cacheDir, undefined, snapshot, false, true,
    ).ensureLibrary(board, { flash_mode: 'dio' }, library, library.includeDirs);

    expect(second.path).not.toBe(first.path);
  });

  it('binds static parts to boot, partition, and generator inputs', async () => {
    const root = tempRoot();
    const config = makeEspConfig(root);
    const board = espBoard();
    const options = { flash_mode: 'dio' };
    const cacheDir = join(root, 'cache');
    const staticKey = async (): Promise<string> => {
      const result = await new Esp32Toolchain(config, executor, cacheDir)
        .ensureStaticParts(board, options);
      expect(result.parts).toHaveLength(3);
      return dirname(result.parts[0]!.path);
    };

    const first = await staticKey();
    replaceWithSameMetadata(
      join(root, 'sdk', 'bin', 'bootloader_dio_40m.elf'),
      'boot-elf-b',
    );
    const second = await staticKey();
    expect(second).not.toBe(first);

    replaceWithSameMetadata(
      join(config.platformDir, 'tools', 'partitions', 'default.csv'),
      'partition-b',
    );
    const third = await staticKey();
    expect(third).not.toBe(second);

    replaceWithSameMetadata(
      join(config.platformDir, 'tools', platform() === 'win32' ? 'gen_esp32part.exe' : 'gen_esp32part.py'),
      'part-tool-b',
    );
    const fourth = await staticKey();
    expect(fourth).not.toBe(third);

    replaceWithSameMetadata(config.esptool, 'esptool-b');
    const fifth = await staticKey();
    expect(fifth).not.toBe(fourth);

    replaceWithSameMetadata(
      join(config.platformDir, 'tools', 'partitions', 'boot_app0.bin'),
      'boot-app-b',
    );
    expect(await staticKey()).not.toBe(fifth);
  });

  it('reports whether static parts were created or served from the shared cache', async () => {
    const root = tempRoot();
    const config = makeEspConfig(root);
    const toolchain = new Esp32Toolchain(config, outputWritingExecutor(), join(root, 'cache'));
    const board = espBoard();
    const options = { flash_mode: 'dio' };

    const cold = await toolchain.ensureStaticParts(board, options);
    const warm = await toolchain.ensureStaticParts(board, options);

    expect(cold).toMatchObject({ built: true });
    expect(warm).toMatchObject({ built: false });
  });
});
