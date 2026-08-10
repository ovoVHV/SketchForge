import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeBase = new URL('../public/avr/v4/', import.meta.url);
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('assets/manifest.json', runtimeBase)), 'utf8'));

function request(content = 'void setup() {}\nvoid loop() {}') {
  return {
    board: 'arduino:avr:uno',
    files: [{ name: 'main.ino', content }],
    options: { optimize: 'fast' },
  };
}

async function loadBrowserAvr() {
  return import('../public/browser-avr.js');
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('Worker', class Worker {});
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => manifest,
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('浏览器 AVR 能力路由', () => {
  it('只在 Uno 核心 API 请求上启用浏览器编译', async () => {
    const { browserAvrCapability } = await loadBrowserAvr();

    await expect(browserAvrCapability(request())).resolves.toMatchObject({ supported: true });
  });

  it('从 files[0].content 检测 Wire 并回退服务端', async () => {
    const { browserAvrCapability } = await loadBrowserAvr();
    const result = await browserAvrCapability(request('#include <Wire.h>\nvoid setup() {}\nvoid loop() {}'));

    expect(result).toEqual({ supported: false, reason: 'headers', unsupported: ['Wire.h'] });
  });

  it('第三方头文件和显式库都回退服务端', async () => {
    const { browserAvrCapability } = await loadBrowserAvr();
    const byHeader = await browserAvrCapability(request('#include <Servo.h>\nvoid setup() {}\nvoid loop() {}'));
    const byLibrary = await browserAvrCapability({
      ...request(),
      libraries: [{ name: 'Servo' }],
    });

    expect(byHeader).toEqual({ supported: false, reason: 'headers', unsupported: ['Servo.h'] });
    expect(byLibrary).toEqual({ supported: false, reason: 'libraries' });
  });

  it('未知 Uno 编译选项交给服务端校验', async () => {
    const { browserAvrCapability } = await loadBrowserAvr();
    const result = await browserAvrCapability({
      ...request(),
      options: { optimize: 'fast', unsupported: 'value' },
    });

    expect(result).toEqual({ supported: false, reason: 'options' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ESP32 不加载 AVR 资源，直接回退服务端', async () => {
    const { browserAvrCapability } = await loadBrowserAvr();
    const result = await browserAvrCapability({
      ...request(),
      board: 'esp32:esp32:esp32',
    });

    expect(result).toEqual({ supported: false, reason: 'board' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('缺少 Web Crypto 时返回能力不足而不是抛 ReferenceError', async () => {
    vi.stubGlobal('crypto', undefined);
    const { browserAvrCapability } = await loadBrowserAvr();

    await expect(browserAvrCapability(request())).resolves.toEqual({
      supported: false,
      reason: 'browser',
    });
  });

  it('把预取消保留为浏览器终态，不加载资源或回退服务端', async () => {
    const controller = new AbortController();
    controller.abort();
    const { compileAvrInBrowser } = await loadBrowserAvr();

    await expect(compileAvrInBrowser(request(), undefined, {
      signal: controller.signal,
    })).resolves.toMatchObject({
      handled: true,
      result: { status: 'error', reason: 'cancelled' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts multiple root Arduino sketch tabs', async () => {
    const { browserAvrCapability } = await loadBrowserAvr();
    await expect(browserAvrCapability({
      ...request(),
      files: [
        { name: 'Other.ino', content: 'void loop() {}\n' },
        { name: 'main.ino', content: 'void setup() {}\n' },
      ],
    })).resolves.toMatchObject({ supported: true });
  });

  it('keeps executable modules and the Worker local when compiler data uses a CDN', async () => {
    let workerUrl: URL | undefined;
    let workerOptions: WorkerOptions | undefined;
    const posted: Array<Record<string, any>> = [];
    const listeners = new Map<string, (event: any) => void>();

    class WorkerHarness {
      constructor(url: URL, options: WorkerOptions) {
        workerUrl = new URL(String(url));
        workerOptions = options;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        listeners.set(type, listener);
      }

      postMessage(message: Record<string, any>) {
        posted.push(message);
        queueMicrotask(() => {
          if (message.type === 'init') {
            listeners.get('message')?.({
              data: { abi: 1, type: 'init-result', id: message.id, ok: true },
            });
            return;
          }
          if (message.type === 'close') {
            listeners.get('message')?.({
              data: { abi: 1, type: 'close-result', id: message.id, ok: true },
            });
            return;
          }
          const outputs = message.action.outputs.map(({ path }: { path: string }) => ({
            path,
            bytes: path.endsWith('.hex')
              ? new TextEncoder().encode(':00000001FF\n')
              : path.endsWith('.cpp')
                ? new TextEncoder().encode('void setup() {}\nvoid loop() {}')
                : Uint8Array.of(1),
          }));
          listeners.get('message')?.({
            data: {
              abi: 1,
              type: 'action-result',
              id: message.id,
              ok: true,
              result: { outputs, diagnostics: [] },
            },
          });
        });
      }

      terminate() {}
    }

    vi.stubGlobal('Worker', WorkerHarness);
    vi.stubGlobal('__SKETCHFORGE_TOOLCHAIN_ORIGINS__', {
      'arduino-avr-uno': 'https://cdn.example.test/toolchains/avr/v4/',
    });
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.origin === 'https://cdn.example.test') {
        const relative = url.pathname.slice('/toolchains/avr/v4/'.length);
        return new Response(readFileSync(fileURLToPath(new URL(relative, runtimeBase))), { status: 200 });
      }
      if (url.href === new URL('assets/manifest.json', runtimeBase).href) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      throw new Error(`unexpected AVR fetch: ${url.href}`);
    }));
    const { compileAvrInBrowser } = await loadBrowserAvr();

    await expect(compileAvrInBrowser(request())).resolves.toMatchObject({
      handled: true,
      result: { status: 'success', execution: 'browser' },
    });

    expect(workerUrl?.protocol).toBe('file:');
    expect(workerUrl?.pathname.replaceAll('\\', '/')).toMatch(/\/public\/avr\/v4\/worker\.js$/);
    expect(workerOptions).toEqual({ type: 'module' });
    expect(posted.find((message) => message.type === 'init')?.assetsBase)
      .toBe('https://cdn.example.test/toolchains/avr/v4/');
    expect(posted.filter((message) => message.type === 'action')).toHaveLength(4);
    expect(posted.some((message) => Object.hasOwn(message, 'source'))).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: expect.stringMatching(/\/public\/avr\/v4\/assets\/manifest\.json$/) }),
      { cache: 'no-cache' },
    );
  });
});

describe('浏览器 AVR 诊断行号', () => {
  it('AVR 与 ESP32 共用预处理器都会恢复后续 .ino tab 的位置', async () => {
    const bundles = await Promise.all([
      import('../public/avr/v3/preprocess.js'),
      import('../public/avr/v4/preprocess.js'),
    ]);
    const source = [
      '#include <Arduino.h>',
      'int value = 1;',
      '#line 1 "Other.ino"',
      '',
      'void setup() { missing(); }',
      'void loop() {}',
    ].join('\n');

    for (const { preprocess } of bundles) {
      const processed = preprocess(source, { sourceName: 'main.ino' });
      expect(processed.cpp).toContain(
        '#line 1 "<generated>"\nvoid setup();\nvoid loop();\n#line 2 "Other.ino"\nvoid setup() { missing(); }',
      );
    }
  });

  it('保留用户源码中的语法错误行列', async () => {
    const { parseCompilerDiagnostics } = await loadBrowserAvr();
    const { preprocess } = await import('../public/avr/v4/preprocess.js');
    const source = [
      'void setup() {',
      '  doesNotExist();',
      '}',
      'void loop() {}',
    ].join('\n');
    const processed = preprocess(source, { sourceName: 'main.ino' });

    expect(parseCompilerDiagnostics([
      "[compiler] main.ino:2:3: error: 'doesNotExist' was not declared in this scope",
    ], processed, 'main.ino')).toEqual([expect.objectContaining({
      severity: 'error',
      file: 'main.ino',
      line: 2,
      column: 3,
    })]);
  });

  it('把自动生成声明的错误映射回函数定义行', async () => {
    const { parseCompilerDiagnostics } = await loadBrowserAvr();
    const { preprocess } = await import('../public/avr/v4/preprocess.js');
    const source = ['// heading', '', 'Widget setup() {}', 'void loop() {}'].join('\n');
    const processed = preprocess(source, { sourceName: 'main.ino' });

    expect(parseCompilerDiagnostics([
      "[compiler] <generated>:1:1: error: 'Widget' does not name a type",
    ], processed, 'main.ino')).toEqual([expect.objectContaining({
      file: 'main.ino',
      line: 3,
      column: 1,
      fromGenerated: true,
    })]);
  });

  it('不把越界或工具链内部行号伪装成用户源码位置', async () => {
    const { parseCompilerDiagnostics } = await loadBrowserAvr();
    const { preprocess } = await import('../public/avr/v4/preprocess.js');
    const processed = preprocess('void setup() {}\nvoid loop() {}', { sourceName: 'main.ino' });

    const diagnostics = parseCompilerDiagnostics([
      '[compiler] main.ino:99:1: error: unexpected token',
      '[compiler] /arduino/core/Arduino.h:123:2: error: internal header failure',
    ], processed, 'main.ino');

    expect(diagnostics[0]).toMatchObject({ line: 2, unmapped: true });
    expect(diagnostics[1]).toMatchObject({ line: 1, unmapped: true });
    expect(diagnostics[1].message).toContain('Arduino.h:123');
  });
});
