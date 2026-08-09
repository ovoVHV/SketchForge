import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuildIR } from '../../core/src/build-ir/builder.js';
import type { TransformAction } from '../../core/src/build-ir/types.js';
import { BrowserWasmExecutor } from '../public/ck-browser-executor.js';
import {
  createAvrWorkerActionRequest,
  createAvrWorkerControlRequest,
  createAvrWorkerInitRequest,
} from '../public/avr/v4/action-protocol.js';
import { createAvrBrowserWorkerLauncher } from '../public/avr/v4/index.js';
import { createAvrWorkerActionMessageHandler } from '../public/avr/v4/worker.js';

function preprocessAction(): TransformAction {
  return {
    arguments: ['main.ino', '-o', 'build/generated/main.cpp'],
    cacheKey: '1'.repeat(64),
    dependencies: [],
    environment: {},
    id: 'preprocess-main',
    inputs: [{ path: 'main.ino', role: 'source' }],
    kind: 'transform',
    outputs: [{ path: 'build/generated/main.cpp', kind: 'generated-source' }],
    packDependencies: [],
    resourceLimits: { cpuMs: 15_000, memoryBytes: 128 * 1024 * 1024, outputBytes: 1024 },
    tool: 'ck:arduino-preprocess',
    transform: {
      input: 'main.ino',
      output: 'build/generated/main.cpp',
      format: 'other',
      flags: [],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('browser AVR Action-only Worker session', () => {
  it('opens locally, transfers one Action at a time, and closes in sequence', async () => {
    const messages: any[] = [];
    const listeners = new Map<string, (event: any) => void>();
    let workerUrl: URL | undefined;
    let workerOptions: WorkerOptions | undefined;
    let terminated = false;
    class WorkerHarness {
      constructor(url: URL, options: WorkerOptions) {
        workerUrl = new URL(String(url));
        workerOptions = options;
      }

      addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, listener); }

      postMessage(message: any) {
        messages.push(message);
        queueMicrotask(() => {
          if (message.type === 'init') {
            listeners.get('message')?.({ data: { abi: 1, type: 'init-result', id: message.id, ok: true } });
          } else if (message.type === 'close') {
            listeners.get('message')?.({ data: { abi: 1, type: 'close-result', id: message.id, ok: true } });
          } else {
            listeners.get('message')?.({ data: {
              abi: 1,
              type: 'action-result',
              id: message.id,
              ok: true,
              result: {
                outputs: [{ path: 'build/generated/main.cpp', bytes: Uint8Array.of(7, 8) }],
                diagnostics: [],
              },
            } });
          }
        });
      }

      terminate() { terminated = true; }
    }

    const session = await createAvrBrowserWorkerLauncher({
      WorkerClass: WorkerHarness as never,
    }).openActionSession({ assetsBase: 'https://cdn.example.test/avr/v4/' });
    const result = await session.runAction(preprocessAction(), {
      inputs: [{ path: 'main.ino', bytes: Uint8Array.of(1, 2, 3) }],
    });
    await session.close();

    expect(result).toEqual({
      outputs: [{ path: 'build/generated/main.cpp', bytes: Uint8Array.of(7, 8) }],
      diagnostics: [],
    });
    expect(messages.map((message) => message.type)).toEqual(['init', 'action', 'close']);
    expect(messages[0]).toMatchObject({ assetsBase: 'https://cdn.example.test/avr/v4/' });
    expect(messages[1]).not.toHaveProperty('source');
    expect(workerUrl?.protocol).toBe('file:');
    expect(workerUrl?.pathname.replaceAll('\\', '/')).toMatch(/\/public\/avr\/v4\/worker\.js$/);
    expect(workerOptions).toEqual({ type: 'module' });
    expect(terminated).toBe(true);
    expect(session.closed).toBe(true);
  });

  it('normalizes Action failures for BrowserWasmExecutor without rejecting the session call', async () => {
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
                code: 'preprocess_failed',
                reason: 'compile',
                message: 'generated declaration failed',
                diagnostics: [{
                  severity: 'error',
                  file: '<generated>',
                  line: 1,
                  message: 'generated declaration failed',
                }],
              },
            } }));
      }
      terminate() {}
    }
    const session = await createAvrBrowserWorkerLauncher({
      WorkerClass: WorkerHarness as never,
    }).openActionSession({ assetsBase: 'https://cdn.example.test/avr/v4/' });
    const action = preprocessAction();
    const board = {
      kind: 'board' as const,
      id: 'arduino-avr-uno-board',
      version: '1.8.6',
      sha256: 'b'.repeat(64),
      fqbn: 'arduino:avr:uno',
      variant: 'standard',
    };
    const ir = createBuildIR({
      project: [{ path: 'main.ino', content: '', language: 'ino' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs: {
        toolchain: {
          kind: 'toolchain',
          id: 'avr-gcc-wasm',
          version: '7.3.0-atmel3.6.1',
          sha256: 'a'.repeat(64),
          abi: 'avr-elf',
          instructionSet: 'avr5',
        },
        platform: {
          kind: 'platform',
          id: 'arduino-avr-platform',
          version: '1.8.6',
          sha256: 'c'.repeat(64),
          platform: 'arduino:avr',
        },
        board,
        libraries: { roots: [], packs: [] },
      },
      actions: [{
        ...action,
        inputs: [{
          ...action.inputs[0]!,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        }],
      }],
      artifacts: [{ path: 'build/generated/main.cpp', format: 'other' }],
      diagnosticMap: [{
        generatedFile: '<generated>',
        generatedLine: 1,
        sourceFile: 'main.ino',
        sourceLine: 1,
      }],
    });
    const execution = await new BrowserWasmExecutor({
      runAction: (candidate: any, context: any) => session.runAction(candidate, {
        inputs: candidate.inputs.map((input: any) => ({
          path: input.path,
          bytes: context.readFile(input.path),
        })),
        signal: context.signal,
      }),
    }).execute(ir);
    await session.close();

    expect(execution).toMatchObject({
      status: 'error',
      reason: 'compile',
      actionId: 'preprocess-main',
      diagnostics: [{ sourceFile: 'main.ino', sourceLine: 1, fromGenerated: true }],
    });
  });

  it('validates Worker-side ordering and transfers only declared output buffers', async () => {
    const responses: Array<{ message: any; transfer?: Transferable[] }> = [];
    const execute = vi.fn(async (action: any, inputs: any[]) => {
      expect(action.id).toBe('preprocess-main');
      expect(inputs).toEqual([{ path: 'main.ino', bytes: Uint8Array.of(3) }]);
      return {
        outputs: [{ path: 'build/generated/main.cpp', bytes: Uint8Array.of(9) }],
        diagnostics: [],
      };
    });
    const close = vi.fn();
    const handler = createAvrWorkerActionMessageHandler({
      openSession: vi.fn(async () => ({ execute, close })),
      postMessage(message, transfer) { responses.push({ message, transfer }); },
    });
    const action = preprocessAction();

    await handler({ data: createAvrWorkerInitRequest({ id: 1, assetsBase: 'https://cdn.example.test/avr/v4/' }) });
    await handler({ data: createAvrWorkerActionRequest({
      id: 2,
      action,
      inputs: [{ path: 'main.ino', bytes: Uint8Array.of(3) }],
    }) });
    await handler({ data: createAvrWorkerControlRequest('close', 3) });

    expect(responses.map(({ message }) => message.type)).toEqual(['init-result', 'action-result', 'close-result']);
    expect(responses[1].message).toMatchObject({
      ok: true,
      result: { outputs: [{ path: 'build/generated/main.cpp', bytes: Uint8Array.of(9) }] },
    });
    expect(responses[1].transfer).toEqual([responses[1].message.result.outputs[0].bytes.buffer]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects the removed whole-build message before opening an executor', async () => {
    const responses: any[] = [];
    const openSession = vi.fn();
    const handler = createAvrWorkerActionMessageHandler({
      openSession,
      postMessage(message) { responses.push(message); },
    });

    await handler({ data: { id: 1, source: 'void setup() {}', assetsBase: 'https://example.test/' } });

    expect(openSession).not.toHaveBeenCalled();
    expect(responses[0]).toMatchObject({
      type: 'action-result',
      ok: false,
      error: { code: 'invalid_request', reason: 'integrity' },
    });
  });
});
