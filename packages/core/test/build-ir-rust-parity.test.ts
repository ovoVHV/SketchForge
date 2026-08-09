import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  type BoardPackRef,
  type BuildIR,
  type BuildPacks,
  type LibraryPackRef,
} from '../src/index.js';
import { createBuildIR, migrateBuildIR, serializeBuildIR } from '../src/build-ir/builder.js';
import { planBuildIR as planBuildIRWithTypescript } from '../src/build-ir/planner.js';
import {
  planBuildIR as planBuildIRWithRust,
  resolveLibraries as resolveLibrariesWithRust,
} from '../src/build-ir/rust-planner.js';
import { sha256Hex } from '../src/build-ir/canonical.js';

const fixtureUrl = new URL('../../../crates/ck-build-core/tests/fixtures/typescript-build-ir-v1.json', import.meta.url);

describe('CK Build IR Rust parity fixture', () => {
  it('matches the canonical TypeScript v1 serializer output', async () => {
    const board: BoardPackRef = {
      kind: 'board', id: 'esp32-c3-devkit', version: '1.0.0', sha256: 'b'.repeat(64),
      fqbn: 'esp32:esp32:esp32c3', variant: 'esp32c3',
    };
    const library: LibraryPackRef = {
      kind: 'library', id: 'arduino:Wire', name: 'Wire', version: '1.0.0', sha256: 'd'.repeat(64),
      architectures: ['*'], manifest: { version: '1.0.0', name: 'Wire' }, dependencies: [],
    };
    const packs: BuildPacks = {
      toolchain: {
        kind: 'toolchain', id: 'esp-riscv-gcc', version: '13.2.0', sha256: 'a'.repeat(64),
        abi: 'riscv32-esp-elf', instructionSet: 'rv32imc',
      },
      platform: {
        kind: 'platform', id: 'espressif-arduino', version: '3.3.7', sha256: 'c'.repeat(64),
        platform: 'espressif-arduino',
      },
      board,
      libraries: { roots: [library.id], packs: [library] },
    };
    const ir = createBuildIR({
      project: [{ path: 'src/main.cpp', content: 'int main() { return 0; }\\n' }],
      target: { fqbn: board.fqbn, options: { cpu: 'default' }, boardPack: board },
      packs,
      actions: [{
        id: 'compile-main', kind: 'compile', tool: 'toolchain:g++',
        inputs: [{ path: 'src/main.cpp', sha256: '1'.repeat(64), role: 'source' }],
        outputs: [{ path: 'build/main.o', kind: 'object' }],
        arguments: ['-c'], environment: { LANG: 'C' }, dependencies: [],
        packDependencies: [library.id], resourceLimits: { memoryBytes: 1024 },
        compileUnit: {
          language: 'c++', source: 'src/main.cpp', output: 'build/main.o',
          macros: { ARDUINO: true }, includePaths: ['include'], flags: ['-Os'],
        },
      }],
      artifacts: [{ path: 'build/firmware.elf', format: 'elf' }],
      diagnosticMap: [{
        generatedFile: 'src/main.cpp', generatedLine: 1,
        sourceFile: 'src/main.cpp', sourceLine: 1,
      }],
    });

    const fixture = (await readFile(fixtureUrl, 'utf8')).trim();
    expect(serializeBuildIR(ir)).toBe(fixture);
  });

  it('orders Unicode Library Pack identities by UTF-16 code units', async () => {
    const ir = JSON.parse(await readFile(fixtureUrl, 'utf8')) as BuildIR;
    const nonBmp: LibraryPackRef = {
      kind: 'library', id: 'lib:\u{10000}', name: 'NonBmp', version: '1.0.0', sha256: '1'.repeat(64),
      architectures: ['*'], manifest: { name: 'NonBmp', version: '1.0.0' }, dependencies: [],
    };
    const bmp: LibraryPackRef = {
      kind: 'library', id: 'lib:\ue000', name: 'Bmp', version: '1.0.0', sha256: '2'.repeat(64),
      architectures: ['*'], manifest: { name: 'Bmp', version: '1.0.0' }, dependencies: [],
    };
    ir.packs.libraries = { roots: [bmp.id, nonBmp.id], packs: [bmp, nonBmp] };
    ir.graph.actions[0]!.packDependencies = [bmp.id, nonBmp.id];

    const normalized = migrateBuildIR(ir);

    expect(normalized.packs.libraries.packs.map((pack) => pack.id)).toEqual([nonBmp.id, bmp.id]);
    expect(normalized.graph.actions[0]!.cacheKey)
      .toBe('7f90ff290fc8c37e58b6bba789b63610cea6cf41945b6140206b74a7f5d084ff');
  });

  it('rejects ambiguous logical Library Pack revisions before invoking the Rust backend', async () => {
    const first: LibraryPackRef = {
      kind: 'library', id: 'lib:demo-a', name: 'Demo', version: '1.0.0', sha256: '1'.repeat(64),
      architectures: ['*'], manifest: { name: 'Demo', version: '1.0.0' }, dependencies: [],
    };
    const second: LibraryPackRef = {
      ...first,
      id: 'lib:demo-b',
      sha256: '2'.repeat(64),
    };

    await expect(resolveLibrariesWithRust({ roots: [first.id], packs: [first, second] }))
      .rejects.toThrow(/ambiguous library pack Demo@1\.0\.0: multiple revisions/i);
  });

  it('preserves transform output hashes across TypeScript and Rust planners', async () => {
    const board: BoardPackRef = {
      kind: 'board', id: 'board:partition-test', version: '1.0.0', sha256: 'b'.repeat(64),
      fqbn: 'esp32:esp32:esp32c3', variant: 'esp32c3',
    };
    const csv = 'nvs,data,nvs,0x9000,0x5000,\n';
    const outputSha256 = '9'.repeat(64);
    const input = {
      project: [
        { path: 'main.cpp', content: 'int main() { return 0; }\n' },
        { path: 'partitions.csv', content: csv },
      ],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs: {
        toolchain: {
          kind: 'toolchain' as const,
          id: 'toolchain:test', version: '1.0.0', sha256: 'a'.repeat(64),
          abi: 'test-elf', instructionSet: 'test',
        },
        platform: {
          kind: 'platform' as const,
          id: 'platform:test', version: '1.0.0', sha256: 'c'.repeat(64), platform: 'test',
        },
        board,
        libraries: { roots: [], packs: [] },
      },
      transforms: [{
        id: 'transform-partitions',
        productId: 'partitions',
        lifecycle: 'configuration' as const,
        format: 'partition' as const,
        input: 'partitions.csv',
        inputSha256: sha256Hex(csv),
        output: 'build/partitions.bin',
        outputSha256,
        tool: 'platform:gen-esp32part',
        arguments: ['-q', 'partitions.csv', 'build/partitions.bin'],
      }],
    };

    const typescript = planBuildIRWithTypescript(input);
    const rust = await planBuildIRWithRust(input);
    const typescriptAction = typescript.graph.actions.find((action) => action.id === 'transform-partitions');
    const rustAction = rust.graph.actions.find((action) => action.id === 'transform-partitions');

    expect(typescriptAction?.outputs).toEqual([{
      path: 'build/partitions.bin', kind: 'partitions', sha256: outputSha256,
    }]);
    expect(rustAction?.outputs).toEqual(typescriptAction?.outputs);
    expect(rustAction?.cacheKey).toBe(typescriptAction?.cacheKey);
  });
});
