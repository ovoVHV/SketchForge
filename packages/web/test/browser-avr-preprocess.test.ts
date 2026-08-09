import { describe, expect, it, vi } from 'vitest';

import { createAvrBrowserActionExecutor } from '../public/avr/v4/firmware-builder.js';

describe('browser AVR Arduino preprocess Action', () => {
  it('preprocesses all root sketch tabs as one source', async () => {
    const preprocessSketch = vi.fn((source: string, { sourceName }: { sourceName: string }) => ({
      cpp: `// ${sourceName}\n${source}`,
    }));
    const executor = createAvrBrowserActionExecutor({
      assetsBase: 'https://example.test/avr/v4/',
      createPackLoader: vi.fn(() => ({ reset: vi.fn() })),
      createModule: vi.fn(),
      preprocessSketch,
    });
    const action = {
      id: 'preprocess-main',
      kind: 'transform',
      tool: 'ck:arduino-preprocess',
      inputs: [
        { path: 'Other.ino', role: 'sketch-tab' },
        { path: 'main.ino', role: 'sketch-main' },
      ],
      outputs: [{ path: 'build/generated/main.cpp' }],
      arguments: ['main.ino', 'Other.ino', '-o', 'build/generated/main.cpp'],
      transform: {
        input: 'main.ino', output: 'build/generated/main.cpp', format: 'other', flags: [],
      },
    };

    const result = await executor.execute(action, [
      { path: 'Other.ino', bytes: new TextEncoder().encode('void loop() {}\n') },
      { path: 'main.ino', bytes: new TextEncoder().encode('void setup() {}\n') },
    ]);

    expect(preprocessSketch).toHaveBeenCalledWith(
      'void setup() {}\n#line 1 "Other.ino"\nvoid loop() {}\n',
      { sourceName: 'main.ino' },
    );
    expect(new TextDecoder().decode(result.outputs[0].bytes)).toContain('#line 1 "Other.ino"');
    executor.close();
  });

  it('fails closed for case-folded duplicates, mixed roles, and legacy bundles', async () => {
    const executor = createAvrBrowserActionExecutor({
      assetsBase: 'https://example.test/avr/v4/',
      createPackLoader: vi.fn(() => ({ reset: vi.fn() })),
      createModule: vi.fn(),
      preprocessSketch: vi.fn(() => ({ cpp: '' })),
    });
    const output = 'build/generated/main.cpp';
    const base = {
      id: 'preprocess-main',
      kind: 'transform',
      tool: 'ck:arduino-preprocess',
      outputs: [{ path: output }],
      transform: { input: 'main.ino', output, format: 'other', flags: [] },
    };
    const bytes = new TextEncoder().encode('void setup() {}\n');

    await expect(executor.execute({
      ...base,
      inputs: [
        { path: 'main.ino', role: 'sketch-main' },
        { path: 'MAIN.ino', role: 'sketch-tab' },
      ],
      arguments: ['main.ino', 'MAIN.ino', '-o', output],
    }, [
      { path: 'main.ino', bytes },
      { path: 'MAIN.ino', bytes },
    ])).rejects.toMatchObject({ code: 'invalid_action', reason: 'integrity' });

    await expect(executor.execute({
      ...base,
      inputs: [
        { path: 'main.ino', role: 'sketch-main' },
        { path: 'Other.ino', role: 'sketch-tab' },
        { path: 'config.h', role: 'project-header' },
      ],
      arguments: ['main.ino', 'Other.ino', '-o', output],
    }, [
      { path: 'main.ino', bytes },
      { path: 'Other.ino', bytes },
      { path: 'config.h', bytes },
    ])).rejects.toMatchObject({ code: 'invalid_action', reason: 'integrity' });

    await expect(executor.execute({
      ...base,
      inputs: [
        { path: 'main.ino', role: 'source' },
        { path: 'Other.ino', role: 'source' },
      ],
      arguments: ['main.ino', 'Other.ino', '-o', output],
    }, [
      { path: 'main.ino', bytes },
      { path: 'Other.ino', bytes },
    ])).rejects.toMatchObject({ code: 'invalid_action', reason: 'integrity' });
    executor.close();
  });
});
