import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createNativeExecutionIdentity,
  createVerifiedNativeToolBinding,
  lowerBrowserClangArguments,
  parseNativeSmokeOptions,
} from '../../../scripts/verify-ck-native-library-pack.js';
import {
  DefaultNativeToolResolver,
  type BuildPacks,
  type ToolchainConfig,
} from '../src/index.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function fakeNativeToolchain(root: string): {
  config: ToolchainConfig;
  gcc: string;
  python: string;
  helper: string;
  runtime: string;
  sysroot: string;
} {
  const bin = join(root, 'bin');
  const helper = join(root, 'libexec', 'cc1');
  const runtime = join(root, 'lib', 'runtime.dll');
  const sysroot = join(root, 'sysroot', 'include', 'stdint.h');
  mkdirSync(bin, { recursive: true });
  mkdirSync(dirname(helper), { recursive: true });
  mkdirSync(dirname(runtime), { recursive: true });
  mkdirSync(dirname(sysroot), { recursive: true });
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const python = join(root, 'python3');
  writeFileSync(python, 'fake-python3-v1');
  const tools = ['gcc', 'g++', 'gcc-ar', 'objcopy'];
  for (const tool of tools) {
    writeFileSync(join(bin, `riscv32-esp-elf-${tool}${suffix}`), `fake-${tool}-v1`);
  }
  writeFileSync(helper, 'fake-cc1-v1');
  writeFileSync(runtime, 'fake-runtime-v1');
  writeFileSync(sysroot, 'fake-stdint-v1');
  const config: ToolchainConfig = {
    cacheDir: join(root, 'cache'),
    workDir: join(root, 'work'),
    librariesDirs: [],
    esp32: {
      riscvBinDir: bin,
      riscvRootDir: root,
      coreDir: join(root, 'core'),
      variantsDir: join(root, 'variants'),
      platformDir: join(root, 'platform'),
      esptool: join(root, `esptool${suffix}`),
      sdkRootFor: () => null,
    },
  };
  return { config, gcc: join(bin, `riscv32-esp-elf-gcc${suffix}`), python, helper, runtime, sysroot };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fakeBuildPacks(): BuildPacks {
  return {
    toolchain: {
      kind: 'toolchain', id: 'compiler:test', version: '1.0.0', sha256: SHA_A,
      abi: 'riscv32-esp-elf', instructionSet: 'c3',
    },
    platform: {
      kind: 'platform', id: 'sdk:test', version: '3.3.7', sha256: SHA_B,
      platform: 'arduino-esp32',
    },
    board: {
      kind: 'board', id: 'board:test', version: '3.3.7', sha256: SHA_C,
      fqbn: 'esp32:esp32:esp32c3', variant: 'c3',
    },
    libraries: { roots: [], packs: [] },
  };
}

describe('CK Native Library Pack verifier', () => {
  it('lowers Browser Clang-only arguments without changing portable flags', () => {
    expect(lowerBrowserClangArguments([
      '--target=riscv32-esp-elf',
      '--target',
      'riscv32-esp-elf',
      '-mcpu=esp32s3',
      '-nostdinc',
      '-nostdinc++',
      '-isystem',
      'packs/toolchain/runtime/include/c++/14.2.0',
      '-isystem',
      'project/generated',
      '--sysroot=packs/toolchain/runtime/sysroot',
      '-fuse-ld=lld',
      '-march=rv32imc_zicsr_zifencei',
      '-Ipacks/platform/core',
      '-c',
      'project/main.cpp',
    ])).toEqual([
      '-isystem',
      'project/generated',
      '-march=rv32imc_zicsr_zifencei',
      '-Ipacks/platform/core',
      '-c',
      'project/main.cpp',
    ]);
  });

  it('parses the same fixture file and macro options used by the browser matrix', () => {
    expect(parseNativeSmokeOptions([
      '--project-file-base64',
      'lv_conf.h',
      Buffer.from('#define LV_COLOR_DEPTH 16\n').toString('base64'),
      '--macro',
      'LV_KCONFIG_IGNORE',
      '--macro-base64',
      'LV_CONF_PATH',
      Buffer.from('"lv_conf.h"').toString('base64'),
      '--only-action',
      'compile-library',
      '--trace-compiler',
    ])).toEqual({
      projectFiles: [{ name: 'lv_conf.h', content: '#define LV_COLOR_DEPTH 16\n' }],
      macros: { LV_KCONFIG_IGNORE: true, LV_CONF_PATH: '"lv_conf.h"' },
      onlyAction: 'compile-library',
      traceCompiler: true,
    });
  });

  it('rejects unknown options instead of silently changing a matrix fixture', () => {
    expect(() => parseNativeSmokeOptions(['--unknown'])).toThrow('unknown native smoke option');
  });

  it('binds fake native tool bytes to Packs and rejects a post-capture replacement', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-tool-evidence-'));
    try {
      const { config, gcc, python } = fakeNativeToolchain(root);
      const packs = fakeBuildPacks();
      const binding = createVerifiedNativeToolBinding(config, packs, 'c3', {
        hostPlatform: 'linux',
        pythonInterpreter: {
          command: python,
          commandSha256: sha256(readFileSync(python)),
          authorizedDirectory: dirname(python),
        },
      });
      expect(binding.evidence).toMatchObject({
        schema: 3,
        mode: 'strict-pack-bound-recursive-closure-and-python-sha256-v2',
        toolSource: 'host-native-substitution',
        packToolEquivalence: false,
        target: 'c3',
        packs: {
          compiler: { id: 'compiler:test', revision: SHA_A },
          sdk: { id: 'sdk:test', revision: SHA_B },
          board: { id: 'board:test', revision: SHA_C },
        },
      });
      expect(binding.evidence.tools).toHaveLength(4);
      expect(binding.evidence.tools[0]?.closure).toMatchObject({
        schemaVersion: 1,
        fileCount: expect.any(Number),
        totalBytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(binding.evidence.sha256).toMatch(/^[a-f0-9]{64}$/);

      writeFileSync(gcc, 'fake-gcc-v2');
      expect(() => binding.resolver.resolve('toolchain:cc', packs))
        .toThrow('native tool command hash mismatch: toolchain:cc');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('describes all fake native tools without executing them', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-tool-probe-'));
    try {
      const { config, gcc, python } = fakeNativeToolchain(root);
      const request = {
        schema: 3,
        hostPlatform: 'linux',
        pythonInterpreter: {
          command: python,
          commandSha256: sha256(readFileSync(python)),
          authorizedDirectory: dirname(python),
        },
        targets: [{
          target: 'c3',
          board: 'esp32:esp32:esp32c3',
          packs: [
            { role: 'compiler', id: 'compiler:test', revision: SHA_A, version: '1.0.0', schema: 1 },
            { role: 'sdk', id: 'sdk:test', revision: SHA_B, version: '3.3.7', schema: 2 },
            { role: 'board', id: 'board:test', revision: SHA_C, version: '3.3.7', schema: 2 },
          ],
        }],
      };
      const first = createNativeExecutionIdentity(request, config);
      writeFileSync(gcc, 'fake-gcc-v2');
      const second = createNativeExecutionIdentity(request, config);
      expect(second.sha256).not.toBe(first.sha256);
      expect(second.targets[0]?.tools.find((tool) => tool.id === 'toolchain:cc')?.commandSha256)
        .not.toBe(first.targets[0]?.tools.find((tool) => tool.id === 'toolchain:cc')?.commandSha256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('changes evidence and fails closed when non-command runtime files drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-tool-closure-evidence-'));
    try {
      const { config, python, helper, runtime, sysroot } = fakeNativeToolchain(root);
      const packs = fakeBuildPacks();
      const options = {
        hostPlatform: 'linux' as const,
        pythonInterpreter: {
          command: python,
          commandSha256: sha256(readFileSync(python)),
          authorizedDirectory: dirname(python),
        },
      };
      const baseline = createVerifiedNativeToolBinding(config, packs, 'c3', options);
      const baselineTool = baseline.evidence.tools.find((tool) => tool.id === 'toolchain:cc')!;

      writeFileSync(helper, 'fake-cc1-v2');
      expect(() => new DefaultNativeToolResolver({ config, integrity: baseline.integrity })
        .verifyForExecution(packs)).toThrow(/closure hash mismatch/);
      const helperChanged = createVerifiedNativeToolBinding(config, packs, 'c3', options);
      const helperTool = helperChanged.evidence.tools.find((tool) => tool.id === 'toolchain:cc')!;
      expect(helperTool.commandSha256).toBe(baselineTool.commandSha256);
      expect(helperTool.closure.sha256).not.toBe(baselineTool.closure.sha256);
      expect(helperChanged.evidence.sha256).not.toBe(baseline.evidence.sha256);

      writeFileSync(runtime, 'fake-runtime-v2');
      const runtimeChanged = createVerifiedNativeToolBinding(config, packs, 'c3', options);
      const runtimeTool = runtimeChanged.evidence.tools.find((tool) => tool.id === 'toolchain:cc')!;
      expect(runtimeTool.commandSha256).toBe(baselineTool.commandSha256);
      expect(runtimeTool.closure.sha256).not.toBe(helperTool.closure.sha256);

      writeFileSync(sysroot, 'fake-stdint-v2');
      const sysrootChanged = createVerifiedNativeToolBinding(config, packs, 'c3', options);
      const sysrootTool = sysrootChanged.evidence.tools.find((tool) => tool.id === 'toolchain:cc')!;
      expect(sysrootTool.commandSha256).toBe(baselineTool.commandSha256);
      expect(sysrootTool.closure.sha256).not.toBe(runtimeTool.closure.sha256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
