import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserActionCache, BrowserWasmExecutor } from '../public/ck-browser-executor.js';
import { validateBuildIR } from '../public/ck-rust-build-core.js';

const runtimeBase = new URL('../public/avr/v4/', import.meta.url);
const cdnBase = new URL('https://cdn.example.test/toolchains/avr/v4/');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('browser AVR trusted runtime boundary', () => {
  it('runs the real toolchain with verified CDN WASM bytes and no CDN JavaScript', async () => {
    const fetched: URL[] = [];
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      fetched.push(url);

      let localUrl: URL;
      if (url.origin === cdnBase.origin && url.pathname.startsWith(cdnBase.pathname)) {
        localUrl = new URL(url.pathname.slice(cdnBase.pathname.length), runtimeBase);
      } else {
        localUrl = url;
      }
      if (localUrl.protocol !== 'file:' || !localUrl.href.startsWith(runtimeBase.href)) {
        throw new Error(`unexpected browser AVR fetch: ${url.href}`);
      }
      return new Response(await readFile(fileURLToPath(localUrl)), { status: 200 });
    }));

    const manifest = JSON.parse(await readFile(fileURLToPath(new URL('assets/manifest.json', runtimeBase)), 'utf8'));
    const {
      createAvrBrowserBuildIR,
      createAvrBrowserPackProvider,
      loadAvrBrowserBuildPlanning,
    } = await import('../public/avr/v4/build-ir.js');
    const { createAvrBrowserActionExecutor } = await import('../public/avr/v4/firmware-builder.js');
    const planning = await loadAvrBrowserBuildPlanning({ manifest, assetsBase: cdnBase.href });
    const ir = await createAvrBrowserBuildIR({
      board: 'arduino:avr:uno',
      files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}' }],
      options: { optimize: 'fast' },
    }, planning);
    const actionExecutor = createAvrBrowserActionExecutor({ assetsBase: cdnBase.href });
    const runAction = async (action: any, context: any) => {
      try {
        return await actionExecutor.execute(
          action,
          action.inputs.map((input: any) => ({ path: input.path, bytes: context.readFile(input.path) })),
          { signal: context.signal },
        );
      } catch (error: any) {
        return {
          ok: false,
          status: 'error',
          code: error.code,
          reason: error.reason,
          message: error.message,
          diagnostics: error.diagnostics ?? [],
        };
      }
    };
    const executor = new BrowserWasmExecutor({
      cache: new BrowserActionCache(),
      packs: createAvrBrowserPackProvider({ planning, ir }),
      validateIR: validateBuildIR,
      runAction,
    });
    const result = await executor.execute(ir);

    expect(result).toMatchObject({ status: 'success' });
    expect(result.status === 'success'
      && new TextDecoder().decode(result.artifacts.find((artifact) => artifact.path.endsWith('.hex'))!.bytes))
      .toMatch(/^:/);

    const invalidIr = await createAvrBrowserBuildIR({
      board: 'arduino:avr:uno',
      files: [{
        name: 'main.ino',
        content: 'void setup() {\n  doesNotExist();\n}\nvoid loop() {}',
      }],
      options: { optimize: 'fast' },
    }, planning);
    const invalid = await new BrowserWasmExecutor({
      cache: new BrowserActionCache(),
      packs: createAvrBrowserPackProvider({ planning, ir: invalidIr }),
      validateIR: validateBuildIR,
      runAction,
    }).execute(invalidIr);
    actionExecutor.close();

    expect(invalid).toMatchObject({
      status: 'error',
      reason: 'compile',
      diagnostics: [expect.objectContaining({ sourceFile: 'main.ino', sourceLine: 2 })],
    });

    const external = fetched.filter((url) => url.origin === cdnBase.origin);
    expect(external.length).toBeGreaterThan(0);
    expect(external.every((url) => (
      url.pathname.endsWith('.json')
      || url.pathname.endsWith('.wasm')
      || url.pathname.endsWith('.pack')
    ))).toBe(true);
    expect(external.some((url) => /\.(?:m?js)$/.test(url.pathname))).toBe(false);
  }, 30_000);
});
