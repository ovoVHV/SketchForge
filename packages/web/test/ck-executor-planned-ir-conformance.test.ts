import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MemoryActionCache,
  NativeExecutor,
  createBuildIR,
  planBuildIR,
  serializeBuildIR,
  sha256Hex,
  type ActionCache,
  type BoardPackRef,
  type BuildAction,
  type BuildExecutionOptions,
  type BuildExecutionResult,
  type BuildIR,
  type BuildPacks,
  type ExecRequest,
  type LibraryPackRef,
  type SandboxExecutor,
} from '@arduinofast/core';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserActionCache, BrowserWasmExecutor } from '../public/ck-browser-executor.js';

const encoder = new TextEncoder();
const roots: string[] = [];
const packContents = [
  'void coreTick() {}\n',
  'int planned_pin = 1;\n',
  '#pragma once\nvoid planned();\n',
  '#include "Planned.h"\nvoid planned() {}\n',
];
const packBytesByHash = new Map(packContents.map((content) => {
  const bytes = encoder.encode(content);
  return [sha256Hex(bytes), bytes] as const;
}));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type BrowserExecutorContract = {
  execute(ir: BuildIR, options?: BuildExecutionOptions): Promise<BuildExecutionResult>;
};

type InjectedResult = ReturnType<typeof runPlannedAction>;

const InjectedBrowserExecutor = BrowserWasmExecutor as unknown as new (options: {
  cache: ActionCache;
  packs?: {
    materialize(
      packs: BuildPacks,
      context: { hasFile(path: string): boolean; writeFile(path: string, bytes: Uint8Array, sha256?: string): Promise<void> },
    ): Promise<void>;
  };
  runAction(
    action: BuildAction,
    context: { readFile(path: string): Uint8Array },
  ): InjectedResult | Promise<InjectedResult>;
}) => BrowserExecutorContract;

function packFixture(family: 'avr' | 'esp32') {
  const isAvr = family === 'avr';
  const board: BoardPackRef = {
    kind: 'board',
    id: `board:${family}`,
    version: '1.0.0',
    sha256: (isAvr ? 'b' : 'e').repeat(64),
    fqbn: isAvr ? 'arduino:avr:uno' : 'esp32:esp32:esp32c3',
    variant: isAvr ? 'standard' : 'esp32c3',
  };
  const library: LibraryPackRef = {
    kind: 'library',
    id: `library:planned-${family}@1.0.0`,
    name: `Planned${family.toUpperCase()}`,
    version: '1.0.0',
    sha256: (isAvr ? 'd' : '9').repeat(64),
    architectures: [isAvr ? 'avr' : 'esp32'],
    manifest: { name: `Planned${family.toUpperCase()}`, version: '1.0.0' },
    dependencies: [],
  };
  const packs: BuildPacks = {
    toolchain: {
      kind: 'toolchain',
      id: `toolchain:${family}`,
      version: '1.0.0',
      sha256: (isAvr ? 'a' : 'f').repeat(64),
      abi: isAvr ? 'avr-elf' : 'riscv32-esp-elf',
      instructionSet: isAvr ? 'avr5' : 'rv32imc',
    },
    platform: {
      kind: 'platform',
      id: `platform:${family}`,
      version: '1.0.0',
      sha256: (isAvr ? 'c' : '8').repeat(64),
      platform: isAvr ? 'arduino-avr' : 'arduino-esp32',
    },
    board,
    libraries: { roots: [library.id], packs: [library] },
  };
  return { board, library, packs };
}

async function plannedFixture(family: 'avr' | 'esp32'): Promise<BuildIR> {
  const { board, library, packs } = packFixture(family);
  const planned = await planBuildIR({
    project: [
      { path: 'main.ino', content: 'void setup() { planned(); }\n' },
      { path: 'Alpha.ino', content: 'void loop() {}\n' },
      { path: 'Zulu.ino', content: 'int tabValue() { return 7; }\n' },
      { path: 'helper.cpp', content: 'int helper() { return 3; }\n' },
    ],
    target: { fqbn: board.fqbn, options: { contract: family }, boardPack: board },
    packs,
    platform: {
      core: { files: [{ path: 'Core.cpp', content: 'void coreTick() {}\n' }] },
      variant: { files: [{ path: 'pins.c', content: 'int planned_pin = 1;\n' }] },
    },
    libraries: [{
      pack: library,
      includePaths: ['src'],
      files: [
        { path: 'src/Planned.h', content: '#pragma once\nvoid planned();\n' },
        { path: 'src/Planned.cpp', content: '#include "Planned.h"\nvoid planned() {}\n' },
      ],
    }],
    compilerPackInputs: [{
      kind: 'pack-artifact', packId: packs.toolchain.id,
      packRevision: packs.toolchain.sha256, packSchema: 1,
      artifactId: `${family}-compiler-config`, sha256: '1'.repeat(64), role: 'compiler-config',
    }],
    linkerPackInputs: [{
      kind: 'pack-artifact', packId: packs.platform.id,
      packRevision: packs.platform.sha256, packSchema: 1,
      artifactId: `${family}-linker-config`, sha256: '2'.repeat(64), role: 'linker-config',
    }],
    transforms: family === 'avr'
      ? ['hex']
      : [{ format: 'bin' }, { format: 'partition', output: 'build/partitions.bin', offset: '0x8000' }],
  });

  // Exercise both public constructors: rebuild the genuine planner graph, then
  // cross the canonical JSON boundary consumed by both executor adapters.
  const rebuilt = await createBuildIR({
    project: planned.project,
    target: planned.target,
    packs: planned.packs,
    actions: planned.graph.actions,
    artifacts: planned.artifacts,
    diagnosticMap: planned.diagnosticMap,
  });
  return JSON.parse(await serializeBuildIR(rebuilt)) as BuildIR;
}

function runPlannedAction(action: BuildAction) {
  const outputs = action.outputs.map((output) => {
    const bytes = encoder.encode(`planned:${action.id}:${output.path}`);
    return { path: output.path, bytes, sha256: sha256Hex(bytes) };
  });
  return {
    outputs,
    diagnostics: action.tool === 'ck:preprocess'
      ? [{
          severity: 'error' as const,
          file: '<generated>', line: 2, column: 1,
          message: 'planned conformance diagnostic',
        }]
      : [],
  };
}

function normalize(result: BuildExecutionResult) {
  if (result.status !== 'success') return result;
  return {
    actions: result.actions.map(({ actionId, actionKey, cached, outputs }) => ({
      actionId, actionKey, cached, outputs,
    })),
    diagnostics: result.diagnostics,
    artifacts: result.artifacts.map(({ path, format, offset, size, sha256, bytes }) => ({
      path, format, offset, size, sha256, bytes: [...bytes],
    })),
  };
}

function packFiles(ir: BuildIR) {
  const projectPaths = new Set(ir.project.files.map((file) => file.path));
  return new Map(ir.graph.actions.flatMap((action) => action.inputs.flatMap((input) => {
    const bytes = input.sha256 && packBytesByHash.get(input.sha256);
    return !projectPaths.has(input.path) && bytes ? [[input.path, bytes] as const] : [];
  })));
}

function makeExecutors(ir: BuildIR) {
  const browserCalls: string[] = [];
  const nativeCalls: string[] = [];
  const files = packFiles(ir);
  const browser = new InjectedBrowserExecutor({
    cache: new BrowserActionCache(),
    packs: {
      async materialize(_packs, context) {
        for (const [path, bytes] of files) {
          if (!context.hasFile(path)) await context.writeFile(path, bytes, sha256Hex(bytes));
        }
      },
    },
    runAction: (action) => {
      browserCalls.push(action.id);
      return runPlannedAction(action);
    },
  });
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-planned-ir-conformance-'));
  roots.push(workspaceRoot);
  const sandbox: SandboxExecutor = {
    name: 'forbidden', isolationLevel: 'process',
    async exec(_request: ExecRequest) { throw new Error('injected test must not run a compiler'); },
  };
  const native = new NativeExecutor({
    sandbox,
    tools: { resolve: () => { throw new Error('injected test must not resolve a tool'); } },
    workspaceRoot,
    cache: new MemoryActionCache(),
    packs: {
      async materialize(_packs, workspace) {
        for (const [path, bytes] of files) {
          const target = join(workspace, ...path.split('/'));
          mkdirSync(join(target, '..'), { recursive: true });
          writeFileSync(target, bytes);
        }
      },
    },
    runAction: ({ action }) => {
      nativeCalls.push(action.id);
      return runPlannedAction(action);
    },
  });
  return { browser, native, browserCalls, nativeCalls };
}

describe('planned Build IR executor conformance', () => {
  it.each(['avr', 'esp32'] as const)(
    'executes and caches the same serialized %s planner IR in browser and native adapters',
    async (family) => {
      const ir = await plannedFixture(family);
      const kinds = ir.graph.actions.map((action) => action.kind);
      expect(ir.graph.actions.filter((action) => action.tool === 'ck:preprocess').map((action) => ({
        inputs: action.inputs.map((input) => ({ path: input.path, role: input.role })),
      }))).toEqual([
        { inputs: [
          { path: 'Alpha.ino', role: 'sketch-tab' },
          { path: 'Zulu.ino', role: 'sketch-tab' },
          { path: 'main.ino', role: 'sketch-main' },
        ] },
      ]);
      expect(kinds).toEqual(expect.arrayContaining(['compile', 'archive', 'link', 'transform']));
      expect(ir.graph.actions.some((action) => action.packInputs?.length)).toBe(true);

      const { browser, native, browserCalls, nativeCalls } = makeExecutors(ir);
      const browserOrder: string[] = [];
      const nativeOrder: string[] = [];
      const browserFirst = await browser.execute(ir, {
        onProgress: ({ action }) => browserOrder.push(action.id),
      });
      const nativeFirst = await native.execute(ir, {
        onProgress: ({ action }) => nativeOrder.push(action.id),
      });

      expect(browserFirst.status).toBe('success');
      expect(normalize(browserFirst)).toEqual(normalize(nativeFirst));
      expect(nativeOrder).toEqual(browserOrder);
      expect(browserCalls).toEqual(browserOrder);
      expect(nativeCalls).toEqual(browserOrder);
      expect(browserFirst.status === 'success' && browserFirst.diagnostics).toContainEqual(
        expect.objectContaining({
          severity: 'error', sourceFile: 'Alpha.ino', sourceLine: 1,
          fromGenerated: true, message: 'planned conformance diagnostic',
        }),
      );

      const browserSecond = await browser.execute(ir);
      const nativeSecond = await native.execute(ir);
      expect(normalize(browserSecond)).toEqual(normalize(nativeSecond));
      expect(browserSecond.status === 'success' && browserSecond.actions.every(({ cached }) => cached)).toBe(true);
      expect(nativeSecond.status === 'success' && nativeSecond.actions.every(({ cached }) => cached)).toBe(true);
      expect(browserCalls).toEqual(browserOrder);
      expect(nativeCalls).toEqual(browserOrder);
    },
  );

  it.each(['avr', 'esp32'] as const)('rejects a tampered %s planner Action key before execution', async (family) => {
    const ir = await plannedFixture(family);
    ir.graph.actions.at(-1)!.cacheKey = '0'.repeat(64);
    const { browser, native, browserCalls, nativeCalls } = makeExecutors(ir);

    const browserResult = await browser.execute(ir);
    const nativeResult = await native.execute(ir);

    expect(browserResult).toMatchObject({ status: 'error', reason: 'invalid_ir', actions: [] });
    expect(nativeResult).toMatchObject({ status: 'error', reason: 'invalid_ir', actions: [] });
    expect(browserCalls).toEqual([]);
    expect(nativeCalls).toEqual([]);
  });
});
