import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

const trustDeclaredActionKeys = async <T>(ir: T): Promise<T> => ir;

describe('BrowserWasmExecutor', () => {
  it('allows the production adapter to inject the shared Build IR validator', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    let actionCalled = false;
    const result = await new BrowserWasmExecutor({
      validateIR: async () => { throw new Error('shared validator rejected IR'); },
      runAction: async () => { actionCalled = true; return { outputs: [] }; },
    }).execute({});
    expect(result).toMatchObject({
      status: 'error', reason: 'invalid_ir', message: 'shared validator rejected IR',
    });
    expect(actionCalled).toBe(false);
  });

  it('recalculates and rejects a tampered Action key before cache access or execution', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [] }, target: {}, packs: {}, diagnosticMap: { entries: [] },
      graph: { actions: [{
        id: 'transform', kind: 'transform', tool: 'browser-wasm:test',
        inputs: [], outputs: [{ path: 'build/out.bin' }], arguments: [], environment: {},
        dependencies: [], packDependencies: [], cacheKey: 'a'.repeat(64),
        transform: { input: 'unused', output: 'build/out.bin', format: 'bin', flags: [] },
      }] },
      artifacts: [],
    };
    let cacheReads = 0;
    let runnerCalls = 0;
    const result = await new BrowserWasmExecutor({
      cache: {
        get: async () => { cacheReads += 1; return null; },
        put: async () => {},
      },
      calculateActionKeys: async (candidate: typeof ir) => ({
        ...candidate,
        graph: {
          actions: candidate.graph.actions.map((action) => ({ ...action, cacheKey: 'b'.repeat(64) })),
        },
      }),
      runAction: async () => { runnerCalls += 1; return { outputs: [] }; },
    }).execute(ir);

    expect(result).toMatchObject({
      status: 'error',
      reason: 'invalid_ir',
      message: expect.stringContaining('cache key mismatch for transform'),
      actions: [],
    });
    expect(cacheReads).toBe(0);
    expect(runnerCalls).toBe(0);
  });

  it('uses the Rust Action key calculator by default for complete Build IR', async () => {
    const { createBuildIR } = await import('../../core/src/build-ir/builder.js');
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const board = {
      kind: 'board' as const,
      id: 'board:test', version: '1.0.0', sha256: 'b'.repeat(64),
      fqbn: 'ck:test:board', variant: 'test',
    };
    const ir = createBuildIR({
      project: [{ path: 'src/main.cpp', content: 'int main() { return 0; }\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs: {
        toolchain: {
          kind: 'toolchain', id: 'toolchain:test', version: '1.0.0', sha256: 'a'.repeat(64),
          abi: 'test-elf', instructionSet: 'test',
        },
        platform: {
          kind: 'platform', id: 'platform:test', version: '1.0.0', sha256: 'c'.repeat(64),
          platform: 'test',
        },
        board,
        libraries: { roots: [], packs: [] },
      },
      actions: [{
        id: 'compile-main', kind: 'compile', tool: 'toolchain:test:cxx',
        inputs: [{ path: 'src/main.cpp', role: 'source' }],
        outputs: [{ path: 'build/main.o', kind: 'object' }],
        arguments: [], environment: {}, dependencies: [], packDependencies: [],
        compileUnit: {
          language: 'c++', source: 'src/main.cpp', output: 'build/main.o',
          macros: {}, includePaths: [], flags: [],
        },
      }],
      artifacts: [{ path: 'build/main.o', format: 'other' }],
      diagnosticMap: [],
    });
    ir.graph.actions[0]!.arguments.push('-DKEY_WAS_TAMPERED=1');
    let runnerCalls = 0;

    const result = await new BrowserWasmExecutor({
      runAction: async () => {
        runnerCalls += 1;
        return { outputs: [{ path: 'build/main.o', bytes: new Uint8Array([1]) }] };
      },
    }).execute(ir);

    expect(result).toMatchObject({
      status: 'error', reason: 'invalid_ir',
      message: expect.stringContaining('cache key mismatch for compile-main'),
    });
    expect(runnerCalls).toBe(0);
  });

  it('accepts an Action graph when recalculated keys match', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [] }, target: {}, packs: {}, diagnosticMap: { entries: [] },
      graph: { actions: [{
        id: 'transform', kind: 'transform', tool: 'browser-wasm:test',
        inputs: [], outputs: [{ path: 'build/out.bin' }], arguments: [], environment: {},
        dependencies: [], packDependencies: [], cacheKey: 'a'.repeat(64),
        transform: { input: 'unused', output: 'build/out.bin', format: 'bin', flags: [] },
      }] },
      artifacts: [{ path: 'build/out.bin', format: 'bin' }],
    };
    let calculations = 0;
    const result = await new BrowserWasmExecutor({
      calculateActionKeys: async (candidate: typeof ir) => { calculations += 1; return candidate; },
      runAction: async () => ({ outputs: [{ path: 'build/out.bin', bytes: new Uint8Array([1]) }] }),
    }).execute(ir);

    expect(result).toMatchObject({ status: 'success' });
    expect(calculations).toBe(1);
  });

  it('enforces declared output hashes for fresh and cached Browser outputs', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const expectedBytes = Uint8Array.of(1, 2, 3);
    const expectedSha256 = createHash('sha256').update(expectedBytes).digest('hex');
    const staleBytes = Uint8Array.of(9, 9, 9);
    const staleSha256 = createHash('sha256').update(staleBytes).digest('hex');
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [] }, target: {}, packs: {}, diagnosticMap: { entries: [] },
      graph: { actions: [{
        id: 'transform-partitions', kind: 'transform', tool: 'browser-wasm:test',
        inputs: [],
        outputs: [{ path: 'build/partitions.bin', kind: 'partitions', sha256: expectedSha256 }],
        arguments: [], environment: {}, dependencies: [], packDependencies: [],
        cacheKey: 'a'.repeat(64),
        transform: { input: 'unused', output: 'build/partitions.bin', format: 'partition', flags: [] },
      }] },
      artifacts: [{ path: 'build/partitions.bin', format: 'partition' }],
    };

    const mismatch = await new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async () => ({
        outputs: [{ path: 'build/partitions.bin', bytes: staleBytes, sha256: staleSha256 }],
      }),
    }).execute(ir);
    expect(mismatch).toMatchObject({
      status: 'error', reason: 'integrity', actionId: 'transform-partitions',
      message: expect.stringMatching(/output contract mismatch/),
    });

    let runnerCalls = 0;
    const recovered = await new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      cache: {
        get: async (actionKey: string) => ({
          actionKey,
          outputs: [{ path: 'build/partitions.bin', bytes: staleBytes, sha256: staleSha256 }],
        }),
        put: async () => {},
      },
      runAction: async () => {
        runnerCalls += 1;
        return { outputs: [{ path: 'build/partitions.bin', bytes: expectedBytes }] };
      },
    }).execute(ir);
    expect(recovered).toMatchObject({ status: 'success', actions: [{ cached: false }] });
    expect(runnerCalls).toBe(1);
  });

  it('executes an IR action and reuses its content-addressed outputs', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const sourceHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [{ path: 'main.ino', content: '', language: 'ino', generated: false, sha256: sourceHash, size: 0 }] },
      target: {}, packs: {}, diagnosticMap: { entries: [] },
      graph: {
        actions: [{
          id: 'compile-main', kind: 'compile', tool: 'browser-wasm:legacy',
          inputs: [{ path: 'main.ino', sha256: sourceHash }], outputs: [{ path: 'build/firmware.bin' }],
          arguments: [], environment: {}, dependencies: [], packDependencies: [], cacheKey: 'a'.repeat(64),
          compileUnit: { language: 'c++', source: 'main.ino', output: 'build/firmware.bin', macros: {}, includePaths: [], flags: [], },
        }],
      },
      artifacts: [{ path: 'build/firmware.bin', format: 'bin' }],
    };
    let calls = 0;
    const executor = new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async (_action, context) => {
        calls += 1;
        expect(context.readFile('main.ino')).toBeInstanceOf(Uint8Array);
        return {
          outputs: [{ path: 'build/firmware.bin', bytes: new TextEncoder().encode('ok') }],
          diagnostics: [{ severity: 'warning', file: 'main.ino', line: 1, message: 'cached warning' }],
        };
      },
    });
    const first = await executor.execute(ir);
    expect(first).toMatchObject({ status: 'success', executor: 'browser-wasm' });
    expect(calls).toBe(1);
    const second = await executor.execute(ir);
    expect(second).toMatchObject({ status: 'success' });
    expect(second.status === 'success' && second.actions[0]).toMatchObject({ cached: true });
    expect(first.diagnostics).toEqual(second.diagnostics);
    expect(second.diagnostics).toEqual([expect.objectContaining({ message: 'cached warning' })]);
    expect(calls).toBe(1);
  });

  it('namespaces cached outputs by the Browser adapter policy version', async () => {
    const { BrowserActionCache, BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const cache = new BrowserActionCache();
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [] }, target: {}, packs: {}, diagnosticMap: { entries: [] },
      graph: { actions: [{
        id: 'transform', kind: 'transform', tool: 'browser-wasm:test',
        inputs: [], outputs: [{ path: 'build/out.bin' }], arguments: [], environment: {},
        dependencies: [], packDependencies: [], cacheKey: 'd'.repeat(64),
        transform: { input: 'unused', output: 'build/out.bin', format: 'bin', flags: [] },
      }] },
      artifacts: [{ path: 'build/out.bin', format: 'bin' }],
    };
    let versionOneCalls = 0;
    let versionTwoCalls = 0;
    const versionOne = new BrowserWasmExecutor({
      cache,
      adapterPolicyVersion: 'test-adapter-v1',
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async () => {
        versionOneCalls += 1;
        return { outputs: [{ path: 'build/out.bin', bytes: new Uint8Array([1]) }] };
      },
    });
    const versionTwo = new BrowserWasmExecutor({
      cache,
      adapterPolicyVersion: 'test-adapter-v2',
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async () => {
        versionTwoCalls += 1;
        return { outputs: [{ path: 'build/out.bin', bytes: new Uint8Array([2]) }] };
      },
    });

    const first = await versionOne.execute(ir);
    const replay = await versionOne.execute(ir);
    const changedPolicy = await versionTwo.execute(ir);
    expect(first).toMatchObject({ status: 'success', actions: [{ cached: false }] });
    expect(replay).toMatchObject({ status: 'success', actions: [{ cached: true }] });
    expect(changedPolicy).toMatchObject({ status: 'success', actions: [{ cached: false }] });
    expect(versionOneCalls).toBe(1);
    expect(versionTwoCalls).toBe(1);
    expect(changedPolicy.status === 'success' && changedPolicy.artifacts[0]?.bytes)
      .toEqual(new Uint8Array([2]));
  });

  it('rejects an empty Browser adapter policy version', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    expect(() => new BrowserWasmExecutor({
      adapterPolicyVersion: '',
      runAction: async () => ({ outputs: [] }),
    })).toThrow(/adapterPolicyVersion must be a non-empty string/);
  });

  it('propagates a non-cacheable Action through every dependent Action', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const actions = [
      {
        id: 'compile', kind: 'transform', tool: 'browser-wasm:test',
        inputs: [], outputs: [{ path: 'build/a.bin' }], arguments: [], environment: {},
        dependencies: [], packDependencies: [], cacheKey: '1'.repeat(64),
        transform: { input: 'unused', output: 'build/a.bin', format: 'other', flags: [] },
      },
      {
        id: 'link', kind: 'transform', tool: 'browser-wasm:test',
        inputs: [{ path: 'build/a.bin', role: 'generated' }], outputs: [{ path: 'build/b.bin' }],
        arguments: [], environment: {}, dependencies: ['compile'], packDependencies: [],
        cacheKey: '2'.repeat(64),
        transform: { input: 'build/a.bin', output: 'build/b.bin', format: 'other', flags: [] },
      },
      {
        id: 'image', kind: 'transform', tool: 'browser-wasm:test',
        inputs: [{ path: 'build/b.bin', role: 'generated' }], outputs: [{ path: 'build/c.bin' }],
        arguments: [], environment: {}, dependencies: ['link'], packDependencies: [],
        cacheKey: '3'.repeat(64),
        transform: { input: 'build/b.bin', output: 'build/c.bin', format: 'bin', flags: [] },
      },
    ];
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [] }, target: {}, packs: {}, diagnosticMap: { entries: [] },
      graph: { actions }, artifacts: [{ path: 'build/c.bin', format: 'bin' }],
    };
    let cacheReads = 0;
    let cacheWrites = 0;
    const runnerCalls = new Map<string, number>();
    const executor = new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      cache: {
        get: async () => { cacheReads += 1; return null; },
        put: async () => { cacheWrites += 1; },
      },
      runAction: async (action: { id: string; outputs: Array<{ path: string }> }) => {
        runnerCalls.set(action.id, (runnerCalls.get(action.id) ?? 0) + 1);
        return {
          outputs: [{ path: action.outputs[0]!.path, bytes: new Uint8Array([action.id.length]) }],
          ...(action.id === 'compile' ? { cacheable: false } : {}),
        };
      },
    });

    const first = await executor.execute(ir);
    const second = await executor.execute(ir);
    expect(first).toMatchObject({ status: 'success', actions: [
      { cached: false }, { cached: false }, { cached: false },
    ] });
    expect(second).toMatchObject({ status: 'success', actions: [
      { cached: false }, { cached: false }, { cached: false },
    ] });
    expect(Object.fromEntries(runnerCalls)).toEqual({ compile: 2, link: 2, image: 2 });
    expect(cacheReads).toBe(2);
    expect(cacheWrites).toBe(0);
  });

  it('executes a complete DAG in dependency order and caches every Action', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const encoder = new TextEncoder();
    const source = 'int main_value = 1;\n';
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const action = (
      id: string,
      kind: 'compile' | 'archive' | 'link' | 'transform',
      dependencies: string[],
      inputs: string[],
      output: string,
      key: string,
      detail: Record<string, unknown>,
    ) => ({
      id, kind, tool: `browser-wasm:${kind}`,
      inputs: inputs.map((path) => ({ path })), outputs: [{ path: output }],
      arguments: [], environment: {}, dependencies, packDependencies: [], cacheKey: key.repeat(64),
      ...detail,
    });
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [{ path: 'main.cpp', content: source, language: 'c++', generated: false, sha256: sourceHash, size: source.length }] },
      target: {}, packs: {}, diagnosticMap: { entries: [] },
      graph: { actions: [
        action('transform-bin', 'transform', ['link-elf'], ['build/firmware.elf'], 'build/firmware.bin', 'e', {
          transform: { input: 'build/firmware.elf', output: 'build/firmware.bin', format: 'bin', flags: [] },
        }),
        action('link-elf', 'link', ['archive-core', 'compile-extra'], ['build/core.a', 'build/extra.o'], 'build/firmware.elf', 'd', {
          link: { objects: ['build/extra.o'], archives: ['build/core.a'], output: 'build/firmware.elf', flags: [] },
        }),
        action('archive-core', 'archive', ['compile-main'], ['build/main.o'], 'build/core.a', 'c', {
          archive: { objects: ['build/main.o'], output: 'build/core.a', flags: [] },
        }),
        action('compile-main', 'compile', [], ['main.cpp'], 'build/main.o', 'b', {
          compileUnit: { language: 'c++', source: 'main.cpp', output: 'build/main.o', macros: {}, includePaths: [], flags: [] },
        }),
        action('compile-extra', 'compile', [], ['main.cpp'], 'build/extra.o', 'a', {
          compileUnit: { language: 'c++', source: 'main.cpp', output: 'build/extra.o', macros: {}, includePaths: [], flags: [] },
        }),
      ] },
      artifacts: [{ path: 'build/firmware.bin', format: 'bin' }],
    };
    const calls: string[] = [];
    const progress: Array<{ action: { id: string }; cached: boolean }> = [];
    const executor = new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async (current: { id: string }, context: { readFile: (path: string) => Uint8Array; writeFile: (path: string, bytes: Uint8Array) => void }) => {
        calls.push(current.id);
        if (current.id === 'compile-extra') {
          expect(new TextDecoder().decode(context.readFile('main.cpp'))).toBe(source);
          return { outputs: [{ path: 'build/extra.o', bytes: encoder.encode('extra-object') }] };
        }
        if (current.id === 'compile-main') {
          return { outputs: [{ path: 'build/main.o', bytes: encoder.encode('main-object') }] };
        }
        if (current.id === 'archive-core') {
          expect(new TextDecoder().decode(context.readFile('build/main.o'))).toBe('main-object');
          return { outputs: [{ path: 'build/core.a', bytes: encoder.encode('core-archive') }] };
        }
        if (current.id === 'link-elf') {
          expect(new TextDecoder().decode(context.readFile('build/core.a'))).toBe('core-archive');
          expect(new TextDecoder().decode(context.readFile('build/extra.o'))).toBe('extra-object');
          return { outputs: [{ path: 'build/firmware.elf', bytes: encoder.encode('linked-elf') }] };
        }
        expect(new TextDecoder().decode(context.readFile('build/firmware.elf'))).toBe('linked-elf');
        context.writeFile('build/firmware.bin', encoder.encode('firmware-bin'));
        return { outputs: [] };
      },
    });

    const first = await executor.execute(ir, { onProgress: (event: { action: { id: string }; cached: boolean }) => progress.push(event) });
    expect(first).toMatchObject({ status: 'success', executor: 'browser-wasm' });
    expect(calls).toEqual(['compile-extra', 'compile-main', 'archive-core', 'link-elf', 'transform-bin']);
    expect(first.status === 'success' && first.actions.map((item: { actionId: string }) => item.actionId)).toEqual(calls);
    expect(first.status === 'success' && new TextDecoder().decode(first.artifacts[0].bytes)).toBe('firmware-bin');
    expect(progress.map((event) => event.cached)).toEqual([false, false, false, false, false]);

    progress.length = 0;
    const second = await executor.execute(ir, { onProgress: (event: { action: { id: string }; cached: boolean }) => progress.push(event) });
    expect(second).toMatchObject({ status: 'success' });
    expect(second.status === 'success' && second.actions.every((item: { cached: boolean }) => item.cached)).toBe(true);
    expect(calls).toHaveLength(5);
    expect(progress.map((event) => event.cached)).toEqual([true, true, true, true, true]);
  });

  it('resumes a failed DAG from completed Action cache entries', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const source = 'int value = 1;\n';
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: {
        files: [{
          path: 'main.cpp', content: source, language: 'c++', generated: false,
          sha256: sourceHash, size: source.length,
        }],
      },
      target: {}, packs: {}, diagnosticMap: { entries: [] },
      graph: { actions: [
        {
          id: 'compile-main', kind: 'compile', tool: 'browser-wasm:test',
          inputs: [{ path: 'main.cpp', sha256: sourceHash }], outputs: [{ path: 'build/main.o' }],
          arguments: [], environment: {}, dependencies: [], packDependencies: [], cacheKey: '6'.repeat(64),
          compileUnit: {
            language: 'c++', source: 'main.cpp', output: 'build/main.o',
            macros: {}, includePaths: [], flags: [],
          },
        },
        {
          id: 'transform-bin', kind: 'transform', tool: 'browser-wasm:test',
          inputs: [{ path: 'build/main.o' }], outputs: [{ path: 'build/firmware.bin' }],
          arguments: [], environment: {}, dependencies: ['compile-main'], packDependencies: [],
          cacheKey: '7'.repeat(64),
          transform: { input: 'build/main.o', output: 'build/firmware.bin', format: 'bin', flags: [] },
        },
      ] },
      artifacts: [{ path: 'build/firmware.bin', format: 'bin' }],
    };
    const calls: string[] = [];
    let transformAttempts = 0;
    const executor = new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async (action: { id: string }, context: { readFile: (path: string) => Uint8Array }) => {
        calls.push(action.id);
        if (action.id === 'compile-main') {
          return { outputs: [{ path: 'build/main.o', bytes: new TextEncoder().encode('object') }] };
        }
        transformAttempts += 1;
        expect(new TextDecoder().decode(context.readFile('build/main.o'))).toBe('object');
        if (transformAttempts === 1) return { ok: false, reason: 'tool', message: 'transient failure' };
        return { outputs: [{ path: 'build/firmware.bin', bytes: new TextEncoder().encode('firmware') }] };
      },
    });

    await expect(executor.execute(ir)).resolves.toMatchObject({
      status: 'error', reason: 'tool', actionId: 'transform-bin',
      actions: [{ actionId: 'compile-main', cached: false }],
    });

    const progress: Array<{ action: { id: string }; cached: boolean }> = [];
    const resumed = await executor.execute(ir, {
      onProgress: (event: { action: { id: string }; cached: boolean }) => progress.push(event),
    });
    expect(resumed).toMatchObject({ status: 'success' });
    expect(calls).toEqual(['compile-main', 'transform-bin', 'transform-bin']);
    expect(progress.map(({ action, cached }) => ({ id: action.id, cached }))).toEqual([
      { id: 'compile-main', cached: true },
      { id: 'transform-bin', cached: false },
    ]);
  });

  it('returns a standardized Action failure with mapped diagnostics', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const source = 'bad_call();\n';
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [{ path: 'main.ino', content: source, language: 'ino', generated: false, sha256: sourceHash, size: source.length }] },
      target: {}, packs: {},
      graph: { actions: [
        {
          id: 'preprocess', kind: 'transform', tool: 'ck:preprocess',
          inputs: [{ path: 'main.ino' }], outputs: [{ path: 'build/main.cpp' }],
          arguments: ['main.ino', '-o', 'build/main.cpp'], environment: {}, dependencies: [], packDependencies: [], cacheKey: '1'.repeat(64),
          transform: { input: 'main.ino', output: 'build/main.cpp', format: 'other', flags: [] },
        },
        {
          id: 'compile', kind: 'compile', tool: 'browser-wasm:cxx',
          inputs: [{ path: 'build/main.cpp' }], outputs: [{ path: 'build/main.o' }],
          arguments: [], environment: {}, dependencies: ['preprocess'], packDependencies: [], cacheKey: '2'.repeat(64),
          compileUnit: { language: 'c++', source: 'build/main.cpp', output: 'build/main.o', macros: {}, includePaths: [], flags: [] },
        },
      ] },
      artifacts: [{ path: 'build/main.o', format: 'other' }],
      diagnosticMap: { entries: [{
        generatedFile: 'build/main.cpp', generatedLine: 2, generatedColumn: 5,
        sourceFile: 'main.ino', sourceLine: 1, sourceColumn: 2,
      }] },
    };
    const executor = new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async (current: { id: string }) => current.id === 'preprocess'
        ? {
            outputs: [{ path: 'build/main.cpp', bytes: new TextEncoder().encode('#line 1 "main.ino"\nbad_call();\n') }],
            diagnostics: [{ severity: 'warning', file: 'main.ino', line: 1, column: 1, message: 'preprocess warning' }],
          }
        : {
            ok: false,
            reason: 'tool',
            message: 'WASM compiler unavailable',
            diagnostics: [{
              severity: 'fatal error', file: '.\\build\\main.cpp', line: 2, column: 7,
              message: 'unknown symbol', raw: '.\\build\\main.cpp:2:7: fatal error: unknown symbol',
            }],
          },
    });

    const result = await executor.execute(ir);
    expect(result).toMatchObject({
      status: 'error', executor: 'browser-wasm', reason: 'tool', actionId: 'compile', message: 'WASM compiler unavailable',
    });
    expect(result.actions).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning', file: 'main.ino', line: 1, column: 1, message: 'preprocess warning',
        sourceFile: 'main.ino', sourceLine: 1, sourceColumn: 1, fromGenerated: false,
      },
      {
        severity: 'error', file: 'main.ino', line: 1, column: 2, message: 'unknown symbol',
        raw: '.\\build\\main.cpp:2:7: fatal error: unknown symbol',
        generatedFile: 'build/main.cpp', generatedLine: 2, generatedColumn: 7,
        sourceFile: 'main.ino', sourceLine: 1, sourceColumn: 2, fromGenerated: true,
      },
    ]);
  });

  it('enforces per-Action timeout and output byte limits', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const makeIr = (resourceLimits: { cpuMs?: number; memoryBytes?: number; outputBytes?: number }) => ({
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [] }, target: {}, packs: {}, diagnosticMap: { entries: [] },
      graph: { actions: [{
        id: 'transform', kind: 'transform', tool: 'browser-wasm:test',
        inputs: [], outputs: [{ path: 'build/out.bin' }], arguments: [], environment: {},
        dependencies: [], packDependencies: [], cacheKey: '9'.repeat(64), resourceLimits,
        transform: { input: 'unused', output: 'build/out.bin', format: 'bin', flags: [] },
      }] },
      artifacts: [{ path: 'build/out.bin', format: 'bin' }],
    });

    let actionSignal: AbortSignal | undefined;
    const timedOut = await new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async (_action: unknown, context: { signal: AbortSignal }) => {
        actionSignal = context.signal;
        return new Promise(() => {});
      },
    }).execute(makeIr({ cpuMs: 5 }));
    expect(timedOut).toMatchObject({ status: 'error', reason: 'timeout', actionId: 'transform' });
    expect(actionSignal?.aborted).toBe(true);

    const oversized = await new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async () => ({ outputs: [{ path: 'build/out.bin', bytes: new Uint8Array([1, 2, 3]) }] }),
    }).execute(makeIr({ outputBytes: 2 }));
    expect(oversized).toMatchObject({ status: 'error', reason: 'resource_limit', actionId: 'transform' });

    const memoryExceeded = await new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async (_action: unknown, context: { memoryLimitBytes: number }) => {
        expect(context.memoryLimitBytes).toBe(2);
        return { outputs: [{ path: 'build/out.bin', bytes: new Uint8Array([1, 2, 3]) }] };
      },
    }).execute(makeIr({ memoryBytes: 2 }));
    expect(memoryExceeded).toMatchObject({
      status: 'error', reason: 'resource_limit', actionId: 'transform',
      message: expect.stringContaining('memory limit'),
    });
  });

  it('reports memory limits as unverified without peak evidence and supports fail-closed enforcement', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const makeIr = () => ({
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [] }, target: {}, packs: {}, diagnosticMap: { entries: [] },
      graph: { actions: [{
        id: 'transform', kind: 'transform', tool: 'browser-wasm:test',
        inputs: [], outputs: [{ path: 'build/out.bin' }], arguments: [], environment: {},
        dependencies: [], packDependencies: [], cacheKey: '9'.repeat(64),
        resourceLimits: { memoryBytes: 16 },
        transform: { input: 'unused', output: 'build/out.bin', format: 'bin', flags: [] },
      }] },
      artifacts: [{ path: 'build/out.bin', format: 'bin' }],
    });
    const runAction = async () => ({
      outputs: [{ path: 'build/out.bin', bytes: new Uint8Array([1, 2, 3]) }],
    });

    const compatible = await new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction,
    }).execute(makeIr());
    expect(compatible).toMatchObject({
      status: 'success',
      actions: [{
        memoryLimit: {
          status: 'unverified', limitBytes: 16, controlledBytes: 3,
          reason: 'runner_did_not_report_peak_memory',
        },
      }],
    });

    const strict = await new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      requireMemoryEvidence: true,
      runAction,
    }).execute(makeIr());
    expect(strict).toMatchObject({
      status: 'error', reason: 'resource_limit', actionId: 'transform',
      message: expect.stringContaining('did not provide peak memory evidence'),
    });
  });

  it('validates reported peak memory and preserves verified evidence in the Action cache', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const makeIr = () => ({
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [] }, target: {}, packs: {}, diagnosticMap: { entries: [] },
      graph: { actions: [{
        id: 'transform', kind: 'transform', tool: 'browser-wasm:test',
        inputs: [], outputs: [{ path: 'build/out.bin' }], arguments: [], environment: {},
        dependencies: [], packDependencies: [], cacheKey: '8'.repeat(64),
        resourceLimits: { memoryBytes: 16 },
        transform: { input: 'unused', output: 'build/out.bin', format: 'bin', flags: [] },
      }] },
      artifacts: [{ path: 'build/out.bin', format: 'bin' }],
    });
    let calls = 0;
    const executor = new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      requireMemoryEvidence: true,
      runAction: async () => {
        calls += 1;
        return {
          peakMemoryBytes: 12,
          outputs: [{ path: 'build/out.bin', bytes: new Uint8Array([1, 2, 3]) }],
        };
      },
    });

    const first = await executor.execute(makeIr());
    const second = await executor.execute(makeIr());
    expect(first).toMatchObject({
      status: 'success',
      actions: [{ memoryLimit: { status: 'verified', limitBytes: 16, peakMemoryBytes: 12 } }],
    });
    expect(second).toMatchObject({
      status: 'success',
      actions: [{ cached: true, memoryLimit: { status: 'verified', peakMemoryBytes: 12 } }],
    });
    expect(calls).toBe(1);

    const invalidPeak = await new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async () => ({
        peakMemoryBytes: -1,
        outputs: [{ path: 'build/out.bin', bytes: new Uint8Array([1]) }],
      }),
    }).execute(makeIr());
    expect(invalidPeak).toMatchObject({
      status: 'error', reason: 'resource_limit', message: expect.stringContaining('invalid peak memory'),
    });

    const exceeded = await new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async () => ({
        peakMemoryBytes: 17,
        outputs: [{ path: 'build/out.bin', bytes: new Uint8Array([1]) }],
      }),
    }).execute(makeIr());
    expect(exceeded).toMatchObject({
      status: 'error', reason: 'resource_limit', message: expect.stringContaining('memory limit'),
    });
  });

  it('classifies caller cancellation before and during an Action as cancelled', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [] }, target: {}, packs: {}, diagnosticMap: { entries: [] },
      graph: { actions: [{
        id: 'transform', kind: 'transform', tool: 'browser-wasm:test',
        inputs: [], outputs: [{ path: 'build/out.bin' }], arguments: [], environment: {},
        dependencies: [], packDependencies: [], cacheKey: '7'.repeat(64),
        transform: { input: 'unused', output: 'build/out.bin', format: 'bin', flags: [] },
      }] },
      artifacts: [{ path: 'build/out.bin', format: 'bin' }],
    };

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    let calls = 0;
    await expect(new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async () => { calls += 1; return { outputs: [] }; },
    }).execute(ir, { signal: alreadyCancelled.signal })).resolves.toMatchObject({
      status: 'error', reason: 'cancelled', actions: [],
    });
    expect(calls).toBe(0);

    const controller = new AbortController();
    let actionSignal: AbortSignal | undefined;
    let notifyStarted!: () => void;
    const actionStarted = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const running = new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async (_action: unknown, context: { signal: AbortSignal }) => {
        actionSignal = context.signal;
        notifyStarted();
        return new Promise(() => {});
      },
    }).execute(ir, { signal: controller.signal });

    await actionStarted;
    controller.abort();
    await expect(running).resolves.toMatchObject({
      status: 'error', reason: 'cancelled', actionId: 'transform',
    });
    expect(actionSignal?.aborted).toBe(true);
  });

  it('does not commit conflicting staged Action output', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [] }, target: {}, packs: {}, diagnosticMap: { entries: [] },
      graph: { actions: [{
        id: 'transform', kind: 'transform', tool: 'browser-wasm:test',
        inputs: [], outputs: [{ path: 'build/out.bin' }], arguments: [], environment: {},
        dependencies: [], packDependencies: [], cacheKey: '8'.repeat(64),
        transform: { input: 'unused', output: 'build/out.bin', format: 'bin', flags: [] },
      }] },
      artifacts: [{ path: 'build/out.bin', format: 'bin' }],
    };
    const result = await new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async (_action: unknown, context: { writeFile: (path: string, bytes: Uint8Array) => void }) => {
        context.writeFile('build/out.bin', new Uint8Array([1]));
        return { outputs: [{ path: 'build/out.bin', bytes: new Uint8Array([2]) }] };
      },
    }).execute(ir);
    expect(result).toMatchObject({
      status: 'error', reason: 'integrity', actionId: 'transform',
      message: expect.stringContaining('conflicting bytes'),
    });
  });

  it('materializes verified Pack files before validating Action inputs', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const header = new TextEncoder().encode('#define SDK_VALUE 1\n');
    const headerHash = createHash('sha256').update(header).digest('hex');
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [] }, target: {}, packs: { platform: { id: 'platform:test' } }, diagnosticMap: { entries: [] },
      graph: {
        actions: [{
          id: 'compile-main', kind: 'compile', tool: 'browser-wasm:test',
          inputs: [{ path: 'packs/platform/include/sdk.h', sha256: headerHash }],
          outputs: [{ path: 'build/out.o' }], arguments: [], environment: {}, dependencies: [], packDependencies: [],
          cacheKey: 'c'.repeat(64),
          compileUnit: { language: 'c++', source: 'packs/platform/include/sdk.h', output: 'build/out.o', macros: {}, includePaths: [], flags: [] },
        }],
      },
      artifacts: [{ path: 'build/out.o', format: 'other' }],
    };
    let calls = 0;
    const executor = new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      packs: {
        materialize: async (packs: unknown, context: { writeFile: (path: string, bytes: Uint8Array, sha256: string) => Promise<void> }) => {
          expect(packs).toBe(ir.packs);
          await context.writeFile('packs/platform/include/sdk.h', header, headerHash);
        },
      },
      runAction: async (_action: unknown, context: { readFile: (path: string) => Uint8Array }) => {
        calls += 1;
        expect(context.readFile('packs/platform/include/sdk.h')).toEqual(header);
        return { outputs: [{ path: 'build/out.o', bytes: new Uint8Array([1, 2, 3]) }] };
      },
    });

    await expect(executor.execute(ir)).resolves.toMatchObject({ status: 'success' });
    expect(calls).toBe(1);

    const corrupt = new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      packs: { materialize: (_packs: unknown, context: { writeFile: (path: string, bytes: Uint8Array, sha256: string) => Promise<void> }) => (
        context.writeFile('packs/platform/include/sdk.h', header, '0'.repeat(64))
      ) },
      runAction: async () => { calls += 1; return { outputs: [] }; },
    });
    await expect(corrupt.execute(ir)).resolves.toMatchObject({ status: 'error', reason: 'integrity' });
    expect(calls).toBe(1);
  });

  it('returns a structured invalid-IR result for a dependency cycle', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const cyclicAction = (id: string, dependency: string, key: string) => ({
      id, kind: 'transform', tool: 'browser-wasm:test',
      inputs: [], outputs: [{ path: `build/${id}.bin` }], arguments: [], environment: {},
      dependencies: [dependency], packDependencies: [], cacheKey: key.repeat(64),
      transform: { input: 'main.ino', output: `build/${id}.bin`, format: 'other', flags: [] },
    });
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [] }, target: {}, packs: {}, artifacts: [], diagnosticMap: { entries: [] },
      graph: { actions: [
        cyclicAction('a', 'b', 'a'),
        cyclicAction('b', 'a', 'b'),
      ] },
    };
    const result = await new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async () => ({ outputs: [] }),
    }).execute(ir);
    expect(result).toMatchObject({ status: 'error', reason: 'invalid_ir', message: expect.stringContaining('cycle') });
  });

  it('rejects a generated input whose producer is not an Action dependency', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const transform = (id: string, inputs: string[], output: string, key: string) => ({
      id, kind: 'transform', tool: 'browser-wasm:test',
      inputs: inputs.map((path) => ({ path })), outputs: [{ path: output }], arguments: [], environment: {},
      dependencies: [], packDependencies: [], cacheKey: key.repeat(64),
      transform: { input: inputs[0] ?? 'unused', output, format: 'other', flags: [] },
    });
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [] }, target: {}, packs: {}, artifacts: [], diagnosticMap: { entries: [] },
      graph: { actions: [
        transform('producer', [], 'build/generated.o', '3'),
        transform('consumer', ['build/generated.o'], 'build/result.bin', '4'),
      ] },
    };
    let called = false;
    const result = await new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async () => { called = true; return { outputs: [] }; },
    }).execute(ir);
    expect(result).toMatchObject({
      status: 'error', reason: 'invalid_ir', message: expect.stringContaining('without depending on producer'),
    });
    expect(called).toBe(false);
  });

  it('rejects an action when a declared input is missing or has the wrong hash', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const sourceHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const ir = {
      kind: 'ck-build-ir', schemaVersion: 1,
      project: { files: [{ path: 'main.ino', content: '', language: 'ino', generated: false, sha256: sourceHash, size: 0 }] },
      target: {}, packs: {}, artifacts: [], diagnosticMap: { entries: [] },
      graph: {
        actions: [{
          id: 'compile-main', kind: 'compile', tool: 'browser-wasm:test',
          inputs: [{ path: 'missing.cpp', sha256: sourceHash }], outputs: [{ path: 'build/out.o' }],
          arguments: [], environment: {}, dependencies: [], packDependencies: [], cacheKey: 'b'.repeat(64),
          compileUnit: { language: 'c++', source: 'missing.cpp', output: 'build/out.o', macros: {}, includePaths: [], flags: [], },
        }],
      },
    };
    let called = false;
    const result = await new BrowserWasmExecutor({
      calculateActionKeys: trustDeclaredActionKeys,
      runAction: async () => { called = true; return { outputs: [{ path: 'build/out.o', bytes: new Uint8Array([1]) }] }; },
    }).execute(ir);
    expect(result).toMatchObject({ status: 'error', reason: 'integrity', actionId: 'compile-main' });
    expect(called).toBe(false);
  });
});
