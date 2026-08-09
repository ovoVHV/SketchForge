import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeBase = new URL('../public/avr/v4/', import.meta.url);
const manifest = JSON.parse(readFileSync(
  fileURLToPath(new URL('assets/manifest.json', runtimeBase)),
  'utf8',
));

function request(board: string, cpu?: string) {
  return {
    board,
    files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}' }],
    options: {
      ...(cpu ? { cpu } : {}),
      optimize: 'fast',
    },
  };
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

describe('browser AVR board profiles', () => {
  it.each([
    ['arduino:avr:uno', undefined, 32_256],
    ['arduino:avr:diecimila', 'atmega328', 30_720],
    ['arduino:avr:nano', 'atmega328', 30_720],
    ['arduino:avr:nano', 'atmega328old', 30_720],
  ])('accepts the asset-compatible profile %s:%s', async (board, cpu, flashTotal) => {
    const { browserAvrCapability } = await import('../public/browser-avr.js');

    await expect(browserAvrCapability(request(board, cpu))).resolves.toMatchObject({
      supported: true,
      profile: {
        board,
        target: { appFlashBytes: flashTotal, ramBytes: 2_048 },
      },
    });
  });

  it.each([
    ['arduino:avr:diecimila', 'atmega168'],
    ['arduino:avr:nano', 'atmega168'],
  ])('rejects %s:%s before loading the ATmega328P assets', async (board, cpu) => {
    const { browserAvrCapability } = await import('../public/browser-avr.js');

    await expect(browserAvrCapability(request(board, cpu))).resolves.toEqual({
      supported: false,
      reason: 'options',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects Mega because the AVR v4 release has no avr6, Mega core, or variant assets', async () => {
    const { browserAvrCapability } = await import('../public/browser-avr.js');

    await expect(browserAvrCapability(request('arduino:avr:mega', 'atmega2560'))).resolves.toEqual({
      supported: false,
      reason: 'board',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalizes compatible boards onto the physical Uno Pack with exact source overlays', async () => {
    const createAvrBrowserBuildIR = vi.fn(async () => ({ graph: { actions: [] } }));
    const execute = vi.fn(async () => ({
      status: 'success',
      durationMs: 1,
      diagnostics: [],
      actions: [{ actionId: 'compile', durationMs: 1, cached: false }],
      artifacts: [
        {
          path: 'build/firmware.hex',
          bytes: new TextEncoder().encode(':00000001FF\n'),
          sha256: 'a'.repeat(64),
        },
        {
          path: 'build/firmware.elf',
          bytes: new Uint8Array(),
          sha256: 'b'.repeat(64),
        },
      ],
    }));
    const close = vi.fn(async () => {});

    vi.doMock('../public/avr/v4/build-ir.js', () => ({
      createAvrBrowserBuildIR,
      createAvrBrowserPackProvider: vi.fn(() => ({})),
      loadAvrBrowserBuildPlanning: vi.fn(async () => ({ manifest })),
    }));
    vi.doMock('../public/ck-rust-build-core.js', () => ({
      validateBuildIR: vi.fn(async () => {}),
    }));
    vi.doMock('../public/ck-browser-executor.js', () => ({
      BrowserActionCache: class BrowserActionCache {},
      BrowserCacheStorageActionCache: class BrowserCacheStorageActionCache {},
      BrowserWasmExecutor: class BrowserWasmExecutor {
        execute(...args: unknown[]) { return execute(...args); }
      },
    }));
    vi.doMock('../public/avr/v4/index.js', () => ({
      openAvrBrowserActionSession: vi.fn(async () => ({ runAction: vi.fn(), close })),
    }));

    const { compileAvrInBrowser } = await import('../public/browser-avr.js');
    const nano = request('arduino:avr:nano', 'atmega328old');
    nano.files.unshift({ name: 'Other.ino', content: 'int other = 1;' });

    await expect(compileAvrInBrowser(nano)).resolves.toMatchObject({
      handled: true,
      result: {
        status: 'success',
        memory: { flashTotal: 30_720, ramTotal: 2_048 },
      },
    });
    const nanoRuntimeRequest = createAvrBrowserBuildIR.mock.calls[0]?.[0];
    expect(nanoRuntimeRequest).toMatchObject({
      board: 'arduino:avr:uno',
      options: { optimize: 'fast' },
    });
    expect(nanoRuntimeRequest.options).not.toHaveProperty('cpu');
    expect(nanoRuntimeRequest.files.find((file: any) => file.name === 'Other.ino').content)
      .toBe('int other = 1;');
    expect(nanoRuntimeRequest.files.find((file: any) => file.name === 'main.ino').content)
      .toBe([
        '#undef ARDUINO_AVR_UNO',
        '#define ARDUINO_AVR_NANO 1',
        '#undef NUM_ANALOG_INPUTS',
        '#define NUM_ANALOG_INPUTS 8',
        '#line 1 "main.ino"',
        'void setup() {}',
        'void loop() {}',
      ].join('\n'));

    createAvrBrowserBuildIR.mockClear();
    await expect(compileAvrInBrowser(request('arduino:avr:diecimila', 'atmega328')))
      .resolves.toMatchObject({
        handled: true,
        result: { status: 'success', memory: { flashTotal: 30_720 } },
      });
    expect(createAvrBrowserBuildIR.mock.calls[0]?.[0].files[0].content).toBe([
      '#undef ARDUINO_AVR_UNO',
      '#define ARDUINO_AVR_DUEMILANOVE 1',
      '#line 1 "main.ino"',
      'void setup() {}',
      'void loop() {}',
    ].join('\n'));
    expect(close).toHaveBeenCalledTimes(2);
  });
});
