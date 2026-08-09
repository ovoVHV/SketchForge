import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createBuildIR } from '../../core/src/build-ir/builder.js';
import {
  MemoryActionCache,
  NativeExecutor,
  sha256Hex,
  type ActionCache,
  type BuildAction,
  type BuildExecutionOptions,
  type BuildExecutionResult,
  type BuildIR,
  type ExecRequest,
  type SandboxExecutor,
} from '../../core/src/index.js';
import { BrowserActionCache, BrowserWasmExecutor } from '../public/ck-browser-executor.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const source = 'int value() { return 42; }\n';
  const board = {
    kind: 'board' as const,
    id: 'board:contract',
    version: '1.0.0',
    sha256: 'b'.repeat(64),
    fqbn: 'ck:test:contract',
    variant: 'contract',
  };
  return createBuildIR({
    project: [{ path: 'src/main.cpp', content: source }],
    target: { fqbn: board.fqbn, options: {}, boardPack: board },
    packs: {
      toolchain: {
        kind: 'toolchain', id: 'toolchain:contract', version: '1.0.0',
        sha256: 'a'.repeat(64), abi: 'contract-elf', instructionSet: 'test',
      },
      platform: {
        kind: 'platform', id: 'platform:contract', version: '1.0.0',
        sha256: 'c'.repeat(64), platform: 'contract',
      },
      board,
      libraries: { roots: [], packs: [] },
    },
    actions: [
      {
        id: 'compile-main', kind: 'compile', tool: 'toolchain:contract:cxx',
        inputs: [{ path: 'src/main.cpp', sha256: sha256Hex(source), role: 'source' }],
        outputs: [{ path: 'build/main.o', kind: 'object' }],
        arguments: [], environment: { LANG: 'C' }, dependencies: [], packDependencies: [],
        compileUnit: {
          language: 'c++', source: 'src/main.cpp', output: 'build/main.o',
          macros: {}, includePaths: [], flags: [],
        },
      },
      {
        id: 'image', kind: 'transform', tool: 'ck:contract-image',
        inputs: [{ path: 'build/main.o', role: 'object' }],
        outputs: [{ path: 'build/firmware.bin', kind: 'firmware' }],
        arguments: [], environment: {}, dependencies: ['compile-main'], packDependencies: [],
        transform: {
          input: 'build/main.o', output: 'build/firmware.bin', format: 'bin', flags: [],
        },
      },
    ],
    artifacts: [{ path: 'build/firmware.bin', format: 'bin' }],
    diagnosticMap: [{
      generatedFile: 'src/main.cpp', generatedLine: 1, generatedColumn: 1,
      sourceFile: 'main.ino', sourceLine: 7, sourceColumn: 3,
    }],
  });
}

function executeAction(action: BuildAction, readFile: (path: string) => Uint8Array) {
  const input = readFile(action.inputs[0]!.path);
  const prefix = action.kind === 'compile' ? 'object:' : 'image:';
  const bytes = encoder.encode(`${prefix}${decoder.decode(input)}`);
  return {
    outputs: [{ path: action.outputs[0]!.path, bytes, sha256: sha256Hex(bytes) }],
    diagnostics: action.kind === 'compile'
      ? [{ severity: 'warning' as const, file: 'src/main.cpp', line: 1, column: 4, message: 'contract warning' }]
      : [],
  };
}

type BrowserExecutorContract = {
  execute(ir: BuildIR, options?: BuildExecutionOptions): Promise<BuildExecutionResult>;
};

const ConformingBrowserWasmExecutor = BrowserWasmExecutor as unknown as new (options: {
  cache: ActionCache;
  runAction(
    action: BuildAction,
    context: { readFile(path: string): Uint8Array },
  ): ReturnType<typeof executeAction> | Promise<ReturnType<typeof executeAction>>;
}) => BrowserExecutorContract;

function normalized(result: BuildExecutionResult) {
  if (result.status !== 'success') return result;
  return {
    actions: result.actions.map(({ actionId, actionKey, cached, outputs }) => ({
      actionId, actionKey, cached, outputs,
    })),
    artifacts: result.artifacts.map(({ path, format, size, sha256, bytes }) => ({
      path, format, size, sha256, bytes: [...bytes],
    })),
    diagnostics: result.diagnostics,
  };
}

async function executeInBoth(ir: BuildIR) {
  let browserCalls = 0;
  let nativeCalls = 0;
  const browser = new ConformingBrowserWasmExecutor({
    cache: new BrowserActionCache(),
    runAction: (action, context) => {
      browserCalls += 1;
      return executeAction(action, context.readFile);
    },
  });
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-executor-invalid-contract-'));
  roots.push(workspaceRoot);
  const native = new NativeExecutor({
    sandbox: {
      name: 'forbidden', isolationLevel: 'process',
      async exec(_request: ExecRequest) { throw new Error('invalid IR must not execute'); },
    },
    tools: { resolve: () => { throw new Error('invalid IR must not resolve tools'); } },
    workspaceRoot,
    runAction: ({ action, readFile }) => {
      nativeCalls += 1;
      return executeAction(action, readFile);
    },
  });
  return {
    browser: await browser.execute(ir),
    native: await native.execute(ir),
    calls: { browser: browserCalls, native: nativeCalls },
  };
}

describe('CK Executor conformance', () => {
  it('executes and caches the same Build IR identically in browser and native adapters', async () => {
    const ir = fixture();
    const browserCalls: string[] = [];
    const nativeCalls: string[] = [];
    const browserProgress: string[] = [];
    const nativeProgress: string[] = [];

    const browser = new ConformingBrowserWasmExecutor({
      cache: new BrowserActionCache(),
      runAction: async (action: BuildAction, context: { readFile(path: string): Uint8Array }) => {
        browserCalls.push(action.id);
        return executeAction(action, context.readFile);
      },
    });

    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-executor-contract-'));
    roots.push(workspaceRoot);
    const forbiddenSandbox: SandboxExecutor = {
      name: 'forbidden',
      isolationLevel: 'process',
      async exec(_request: ExecRequest) {
        throw new Error('contract actions must stay inside the injected adapter');
      },
    };
    const native = new NativeExecutor({
      sandbox: forbiddenSandbox,
      tools: { resolve: () => { throw new Error('logical tools must not escape the adapter'); } },
      workspaceRoot,
      cache: new MemoryActionCache(),
      runAction: async ({ action, readFile }) => {
        nativeCalls.push(action.id);
        return executeAction(action, readFile);
      },
    });

    const browserFirst = await browser.execute(ir, {
      onProgress: ({ action }: { action: BuildAction }) => browserProgress.push(action.id),
    });
    const nativeFirst = await native.execute(ir, {
      onProgress: ({ action }) => nativeProgress.push(action.id),
    });

    expect(browserFirst.status).toBe('success');
    expect(nativeFirst.status).toBe('success');
    expect(normalized(browserFirst)).toEqual(normalized(nativeFirst));
    expect(browserProgress).toEqual(['compile-main', 'image']);
    expect(nativeProgress).toEqual(browserProgress);
    expect(browserCalls).toEqual(browserProgress);
    expect(nativeCalls).toEqual(browserProgress);

    const browserSecond = await browser.execute(ir);
    const nativeSecond = await native.execute(ir);
    expect(normalized(browserSecond)).toEqual(normalized(nativeSecond));
    expect(browserSecond.status === 'success' && browserSecond.actions.every((action) => action.cached)).toBe(true);
    expect(nativeSecond.status === 'success' && nativeSecond.actions.every((action) => action.cached)).toBe(true);
    expect(browserCalls).toEqual(['compile-main', 'image']);
    expect(nativeCalls).toEqual(['compile-main', 'image']);
  });

  it.each([
    ['stale key', (ir: BuildIR) => { ir.graph.actions[0]!.cacheKey = '0'.repeat(64); }],
    ['missing key', (ir: BuildIR) => { delete (ir.graph.actions[0] as Partial<BuildAction>).cacheKey; }],
    ['tampered arguments', (ir: BuildIR) => { ir.graph.actions[0]!.arguments.push('--tampered'); }],
  ])('rejects a %s consistently before either adapter executes an Action', async (_name, mutate) => {
    const ir = structuredClone(fixture());
    mutate(ir);

    const result = await executeInBoth(ir);

    expect(result.browser).toMatchObject({ status: 'error', reason: 'invalid_ir', actions: [] });
    expect(result.native).toMatchObject({ status: 'error', reason: 'invalid_ir', actions: [] });
    expect(result.calls).toEqual({ browser: 0, native: 0 });
  });
});
