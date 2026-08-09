import { describe, expect, it, vi } from 'vitest';
import { createBuildIR } from '../../core/src/build-ir/builder.js';
import type { CompileAction } from '../../core/src/build-ir/types.js';
import {
  createEsp32C3WorkerActionInitRequest,
  createEsp32C3WorkerActionMessageHandler,
  createEsp32C3WorkerLauncher,
  createEsp32WorkerActionRequest,
  validateEsp32C3WorkerActionResponse,
  validateEsp32WorkerActionRequest,
} from '../public/esp32/v1/c3-runtime.js';

const descriptorUrl = 'https://cdn.example.test/esp32/c3/v1/runtime.json';

function descriptor() {
  return {
    schema: 2,
    id: 'esp32-c3-arduino',
    abi: 1,
    board: 'esp32:esp32:esp32c3',
    packs: [
      { role: 'compiler', id: 'riscv32-esp-elf-wasm', revision: 'a'.repeat(64), manifest: 'packs/compiler/toolchain.json' },
      { role: 'sdk', id: 'arduino-esp32c3-sdk', revision: 'b'.repeat(64), manifest: 'packs/sdk/toolchain.json' },
      { role: 'board', id: 'arduino-esp32c3-board', revision: 'c'.repeat(64), manifest: 'packs/board/toolchain.json' },
    ],
  };
}

function compileAction(id = 'compile-main', output = 'build/main.o'): CompileAction {
  return {
    id,
    kind: 'compile',
    tool: 'riscv32-esp-elf-g++',
    inputs: [{ path: 'project/main.cpp', sha256: 'd'.repeat(64), role: 'source' }],
    outputs: [{ path: output, kind: 'object' }],
    arguments: ['-c', 'project/main.cpp', '-o', output],
    environment: { LC_ALL: 'C' },
    dependencies: [],
    packDependencies: ['riscv32-esp-elf-wasm', 'arduino-esp32c3-sdk'],
    resourceLimits: { cpuMs: 30_000, outputBytes: 1024 * 1024 },
    cacheKey: 'e'.repeat(64),
    compileUnit: {
      language: 'c++',
      source: 'project/main.cpp',
      output,
      macros: { ARDUINO: '10819', ESP32: true },
      includePaths: ['packs/platform/core', 'project'],
      flags: ['-Os'],
    },
  };
}

function packInput() {
  return {
    kind: 'pack-artifact',
    packId: 'arduino-esp32c3-sdk',
    packRevision: 'b'.repeat(64),
    packSchema: 2,
    artifactId: 'compile-000',
    sha256: 'f'.repeat(64),
    role: 'compiler-vfs',
  };
}

function actionResult(action: ReturnType<typeof compileAction>, byte: number) {
  return {
    outputs: [{ path: action.outputs[0]!.path, bytes: new Uint8Array([byte]) }],
    diagnostics: [],
    cacheable: true,
  };
}

function initInput(overrides: Record<string, unknown> = {}) {
  return { descriptor: descriptor(), descriptorUrl, ...overrides };
}

describe('ESP32 persistent Worker Action session', () => {
  it('initializes once, queues Actions on one Worker, and closes it orderly', async () => {
    const posted: Array<{ message: any; transfer?: Transferable[] }> = [];
    const listeners = new Map<string, (event: any) => void>();
    const pendingActions: Array<{ message: any }> = [];
    let workers = 0;
    let terminated = 0;

    class WorkerHarness {
      constructor(_url: URL, options: WorkerOptions) {
        workers += 1;
        expect(options).toEqual({ type: 'module' });
      }

      addEventListener(type: string, listener: (event: any) => void) {
        listeners.set(type, listener);
      }

      postMessage(message: any, transfer?: Transferable[]) {
        posted.push({ message, transfer });
        if (message.type === 'init') {
          queueMicrotask(() => listeners.get('message')?.({
            data: { abi: 1, type: 'init-result', id: message.id, ok: true },
          }));
        } else if (message.type === 'action') {
          pendingActions.push({ message });
        } else if (message.type === 'close') {
          queueMicrotask(() => listeners.get('message')?.({
            data: { abi: 1, type: 'close-result', id: message.id, ok: true },
          }));
        }
      }

      terminate() { terminated += 1; }
    }

    const launcher = createEsp32C3WorkerLauncher({
      enabled: true,
      WorkerClass: WorkerHarness as never,
      performanceRef: {},
    });
    const session = await launcher.openActionSession(initInput());
    expect(workers).toBe(1);
    expect(posted[0]!.message).toMatchObject({ type: 'init', id: 1, runtime: { descriptor: { board: 'esp32:esp32:esp32c3' } } });

    const firstAction = compileAction('compile-first', 'build/first.o');
    firstAction.outputs[0]!.sha256 = 'f'.repeat(64);
    const secondAction = compileAction('compile-second', 'build/second.o');
    const first = session.runAction(firstAction, {
      inputs: [{ path: 'project/main.cpp', bytes: new Uint8Array([1, 2]) }],
    });
    const second = session.runAction(secondAction, {
      readFile: (path: string) => path === 'project/main.cpp' ? new Uint8Array([3, 4]) : undefined,
    });

    await vi.waitFor(() => expect(pendingActions).toHaveLength(1));
    expect(posted.filter(({ message }) => message.type === 'action')).toHaveLength(1);
    const firstRequest = pendingActions.shift()!.message;
    const firstPost = posted.find(({ message }) => message === firstRequest)!;
    expect(firstRequest).toMatchObject({
      type: 'action',
      action: {
        id: 'compile-first',
        outputs: [{ path: 'build/first.o', kind: 'object', sha256: 'f'.repeat(64) }],
      },
    });
    expect(firstPost.transfer).toEqual([firstRequest.inputs[0].bytes.buffer]);
    listeners.get('message')?.({
      data: { abi: 1, type: 'action-result', id: firstRequest.id, ok: true, result: actionResult(firstAction, 11) },
    });
    await expect(first).resolves.toMatchObject({ outputs: [{ path: 'build/first.o', bytes: new Uint8Array([11]) }] });

    await vi.waitFor(() => expect(pendingActions).toHaveLength(1));
    const secondRequest = pendingActions.shift()!.message;
    expect(secondRequest).toMatchObject({ type: 'action', action: { id: 'compile-second' } });
    listeners.get('message')?.({
      data: { abi: 1, type: 'action-result', id: secondRequest.id, ok: true, result: actionResult(secondAction, 22) },
    });
    await expect(second).resolves.toMatchObject({ outputs: [{ path: 'build/second.o', bytes: new Uint8Array([22]) }] });

    await session.close();
    expect(posted.map(({ message }) => message.type)).toEqual(['init', 'action', 'action', 'close']);
    expect(terminated).toBe(1);
    expect(session.closed).toBe(true);
    await expect(session.runAction(firstAction, { inputs: [] })).rejects.toMatchObject({ code: 'session_closed' });
  });

  it('terminates the session when a Worker returns a malformed or out-of-order response', async () => {
    const listeners = new Map<string, (event: any) => void>();
    let terminated = false;

    class WorkerHarness {
      addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, listener); }
      postMessage(message: any) {
        queueMicrotask(() => listeners.get('message')?.({ data: message.type === 'init'
          ? { abi: 1, type: 'init-result', id: message.id, ok: true }
          : message.type === 'close'
            ? { abi: 1, type: 'close-result', id: message.id, ok: true }
            : {
              abi: 1,
              type: 'action-result',
              id: message.id,
              ok: true,
              result: { ...actionResult(message.action, 1), unexpected: true },
            } }));
      }
      terminate() { terminated = true; }
    }

    const session = await createEsp32C3WorkerLauncher({
      enabled: true,
      WorkerClass: WorkerHarness as never,
      performanceRef: {},
    }).openActionSession(initInput());
    await expect(session.runAction(compileAction(), {
      inputs: [{ path: 'project/main.cpp', bytes: new Uint8Array([1]) }],
    })).rejects.toMatchObject({ code: 'worker_protocol' });
    expect(terminated).toBe(true);
    expect(session.closed).toBe(true);
  });

  it('times out initialization and always terminates the Worker', async () => {
    let terminated = false;
    class SilentWorker {
      addEventListener() {}
      postMessage() {}
      terminate() { terminated = true; }
    }

    await expect(createEsp32C3WorkerLauncher({
      enabled: true,
      WorkerClass: SilentWorker as never,
      performanceRef: {},
      timeoutMs: 1,
    }).openActionSession(initInput())).rejects.toMatchObject({
      code: 'timeout',
      message: 'ESP32-C3 Worker init request exceeded 1 ms',
    });
    expect(terminated).toBe(true);
  });

  it('times out an Action, sends cancellation, and does not reuse the uncertain Worker', async () => {
    const listeners = new Map<string, (event: any) => void>();
    const posted: any[] = [];
    let terminated = false;
    class WorkerHarness {
      addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, listener); }
      postMessage(message: any) {
        posted.push(message);
        if (message.type === 'init') queueMicrotask(() => listeners.get('message')?.({
          data: { abi: 1, type: 'init-result', id: message.id, ok: true },
        }));
      }
      terminate() { terminated = true; }
    }

    const session = await createEsp32C3WorkerLauncher({
      enabled: true,
      WorkerClass: WorkerHarness as never,
      performanceRef: {},
      timeoutMs: 2,
    }).openActionSession(initInput());
    await expect(session.runAction(compileAction(), {
      inputs: [{ path: 'project/main.cpp', bytes: new Uint8Array([1]) }],
    })).rejects.toMatchObject({ code: 'timeout' });
    const actionRequest = posted.find((message) => message.type === 'action');
    expect(posted.at(-1)).toMatchObject({ type: 'cancel', requestId: actionRequest.id });
    expect(terminated).toBe(true);
    expect(session.closed).toBe(true);
  });

  it('cancels an in-flight Action through AbortSignal and closes the session', async () => {
    const listeners = new Map<string, (event: any) => void>();
    const posted: any[] = [];
    let terminated = false;
    class WorkerHarness {
      addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, listener); }
      postMessage(message: any) {
        posted.push(message);
        if (message.type === 'init') queueMicrotask(() => listeners.get('message')?.({
          data: { abi: 1, type: 'init-result', id: message.id, ok: true },
        }));
      }
      terminate() { terminated = true; }
    }

    const session = await createEsp32C3WorkerLauncher({
      enabled: true,
      WorkerClass: WorkerHarness as never,
      performanceRef: {},
    }).openActionSession(initInput());
    const controller = new AbortController();
    const execution = session.runAction(compileAction(), {
      inputs: [{ path: 'project/main.cpp', bytes: new Uint8Array([1]) }],
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(posted.some((message) => message.type === 'action')).toBe(true));
    controller.abort();

    await expect(execution).rejects.toMatchObject({ code: 'aborted' });
    expect(posted.at(-1)).toMatchObject({ type: 'cancel', requestId: posted.find((message) => message.type === 'action').id });
    expect(terminated).toBe(true);
    expect(session.closed).toBe(true);
  });

  it('returns Worker Action failures with code, canonical reason, and diagnostics', async () => {
    const listeners = new Map<string, (event: any) => void>();
    class WorkerHarness {
      addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, listener); }
      postMessage(message: any) {
        queueMicrotask(() => listeners.get('message')?.({ data: message.type === 'init'
          ? { abi: 1, type: 'init-result', id: message.id, ok: true }
          : message.type === 'close'
            ? { abi: 1, type: 'close-result', id: message.id, ok: true }
            : {
              abi: 1,
              type: 'action-result',
              id: message.id,
              ok: false,
              error: {
                code: 'compiler_failed',
                reason: 'compile_error',
                message: 'undefined reference to setup',
                diagnostics: [{
                  severity: 'error',
                  file: 'project/main.cpp',
                  line: 2,
                  column: 4,
                  message: 'undefined reference to setup',
                  fromGenerated: true,
                  unmapped: false,
                }],
              },
            } }));
      }
      terminate() {}
    }

    const session = await createEsp32C3WorkerLauncher({
      enabled: true,
      WorkerClass: WorkerHarness as never,
      performanceRef: {},
    }).openActionSession(initInput());
    const failure = await session.runAction(compileAction(), {
      inputs: [{ path: 'project/main.cpp', bytes: new Uint8Array([1]) }],
    });

    expect(failure).toMatchObject({
      ok: false,
      status: 'error',
      code: 'compiler_failed',
      reason: 'compile',
      message: 'undefined reference to setup',
      diagnostics: [{ file: 'project/main.cpp', line: 2, column: 4 }],
    });
    await session.close();
  });

  it('feeds the normalized Action failure directly into BrowserWasmExecutor', async () => {
    const { BrowserWasmExecutor } = await import('../public/ck-browser-executor.js');
    const action = compileAction();
    const board = {
      kind: 'board' as const,
      id: 'arduino-esp32c3-board',
      version: '3.0.7',
      sha256: 'c'.repeat(64),
      fqbn: 'esp32:esp32:esp32c3',
      variant: 'esp32c3',
    };
    const ir = createBuildIR({
      project: [{ path: 'project/main.cpp', content: '', language: 'c++' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs: {
        toolchain: {
          kind: 'toolchain',
          id: 'riscv32-esp-elf-wasm',
          version: '14.2.0',
          sha256: 'a'.repeat(64),
          abi: 'riscv32-esp-elf',
          instructionSet: 'rv32imc_zicsr_zifencei',
        },
        platform: {
          kind: 'platform',
          id: 'arduino-esp32-platform',
          version: '3.0.7',
          sha256: 'b'.repeat(64),
          platform: 'esp32:esp32',
        },
        board,
        libraries: { roots: [], packs: [] },
      },
      actions: [{
        ...action,
        inputs: [{
          path: 'project/main.cpp',
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          role: 'source',
        }],
        packDependencies: [],
      }],
      artifacts: [{ path: 'build/main.o', format: 'other' }],
      diagnosticMap: [],
    });
    const executor = new BrowserWasmExecutor({
      runAction: async () => ({
        ok: false,
        status: 'error',
        code: 'compiler_failed',
        reason: 'compile',
        message: 'undefined reference to setup',
        diagnostics: [{
          severity: 'error',
          file: 'project/main.cpp',
          line: 2,
          message: 'undefined reference to setup',
        }],
      }),
    });

    await expect(executor.execute(ir)).resolves.toMatchObject({
      status: 'error',
      reason: 'compile',
      message: 'undefined reference to setup',
      actionId: 'compile-main',
      diagnostics: [{ file: 'project/main.cpp', line: 2 }],
    });
  });

  it('makes close terminate an in-flight Action instead of waiting for its timeout', async () => {
    const listeners = new Map<string, (event: any) => void>();
    const posted: any[] = [];
    let terminated = false;
    class WorkerHarness {
      addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, listener); }
      postMessage(message: any) {
        posted.push(message);
        if (message.type === 'init') queueMicrotask(() => listeners.get('message')?.({
          data: { abi: 1, type: 'init-result', id: message.id, ok: true },
        }));
      }
      terminate() { terminated = true; }
    }

    const session = await createEsp32C3WorkerLauncher({
      enabled: true,
      WorkerClass: WorkerHarness as never,
      performanceRef: {},
    }).openActionSession(initInput());
    const execution = session.runAction(compileAction(), {
      inputs: [{ path: 'project/main.cpp', bytes: new Uint8Array([1]) }],
    });
    await vi.waitFor(() => expect(posted.some((message) => message.type === 'action')).toBe(true));
    await session.close();

    await expect(execution).rejects.toMatchObject({ code: 'session_closed' });
    expect(posted.at(-1)).toMatchObject({ type: 'cancel' });
    expect(terminated).toBe(true);
    expect(session.closed).toBe(true);
  });

  it('validates Worker-side ordering and transfers normalized Uint8Array outputs', async () => {
    const responses: Array<{ message: any; transfer?: Transferable[] }> = [];
    const opened = vi.fn(async () => ({
      async runAction(action: ReturnType<typeof compileAction>, context: any) {
        expect(context.signal.aborted).toBe(false);
        expect(context.readFile('project/main.cpp')).toEqual(new Uint8Array([7, 8]));
        return actionResult(action, 99);
      },
      close: vi.fn(async () => {}),
    }));
    const handler = createEsp32C3WorkerActionMessageHandler({
      openSession: opened,
      postMessage(message, transfer) { responses.push({ message, transfer }); },
    });

    const action = compileAction();
    await handler({ data: createEsp32C3WorkerActionInitRequest({ id: 1, descriptor: descriptor(), descriptorUrl }) });
    await handler({ data: createEsp32WorkerActionRequest({
      id: 2,
      action,
      inputs: [{ path: 'project/main.cpp', bytes: new Uint8Array([7, 8]) }],
    }) });
    await handler({ data: { abi: 1, type: 'close', id: 3 } });

    expect(opened).toHaveBeenCalledTimes(1);
    expect(responses.map(({ message }) => message.type)).toEqual(['init-result', 'action-result', 'close-result']);
    const actionResponse = responses[1]!;
    expect(actionResponse.message).toMatchObject({
      ok: true,
      result: { outputs: [{ path: 'build/main.o', bytes: new Uint8Array([99]) }] },
    });
    expect(actionResponse.transfer).toEqual([actionResponse.message.result.outputs[0].bytes.buffer]);
  });

  it('serializes callback Action failures without dropping metadata', async () => {
    const responses: any[] = [];
    const handler = createEsp32C3WorkerActionMessageHandler({
      openSession: async () => ({
        async runAction() {
          const error = new Error('header not found') as Error & Record<string, unknown>;
          error.code = 'missing_header';
          error.reason = 'integrity';
          error.diagnostics = [{
            severity: 'error',
            file: 'project/main.cpp',
            line: 1,
            message: 'header not found',
          }];
          throw error;
        },
      }),
      postMessage(message) { responses.push(message); },
    });
    const action = compileAction();
    await handler({ data: createEsp32C3WorkerActionInitRequest({ id: 1, descriptor: descriptor(), descriptorUrl }) });
    await handler({ data: createEsp32WorkerActionRequest({
      id: 2,
      action,
      inputs: [{ path: 'project/main.cpp', bytes: new Uint8Array([1]) }],
    }) });

    expect(responses[1]).toMatchObject({
      type: 'action-result',
      ok: false,
      error: {
        code: 'missing_header',
        reason: 'integrity',
        diagnostics: [{ file: 'project/main.cpp', line: 1 }],
      },
    });
  });

  it('rejects malformed Action shapes, byte sets, and result output paths', () => {
    const action = compileAction();
    expect(createEsp32WorkerActionRequest({
      id: 1,
      action: { ...action, packInputs: [packInput()] },
      inputs: [{ path: 'project/main.cpp', bytes: new Uint8Array() }],
    }).action).toMatchObject({ packInputs: [packInput()] });
    expect(() => validateEsp32WorkerActionRequest({
      abi: 1,
      type: 'action',
      id: 1,
      action,
      inputs: [],
    })).toThrow(/invalid count/);

    expect(() => createEsp32WorkerActionRequest({
      id: 1,
      action: { ...action, extra: true },
      inputs: [{ path: 'project/main.cpp', bytes: new Uint8Array() }],
    })).toThrow(/invalid shape/);

    expect(() => createEsp32WorkerActionRequest({
      id: 1,
      action: { ...action, packInputs: [{ ...packInput(), sha256: 'invalid' }] },
      inputs: [{ path: 'project/main.cpp', bytes: new Uint8Array() }],
    })).toThrow(/Pack input hash/);

    expect(() => validateEsp32C3WorkerActionResponse({
      abi: 1,
      type: 'action-result',
      id: 1,
      ok: true,
      result: {
        outputs: [{ path: 'build/not-main.o', bytes: new Uint8Array([1]) }],
        diagnostics: [],
      },
    }, { action })).toThrow(/unexpected path/);
  });
});
