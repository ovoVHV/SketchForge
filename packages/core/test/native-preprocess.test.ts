import { describe, expect, it } from 'vitest';

import { decodeNativeSketchAction } from '../src/compile.js';
import { composeArduinoSketchSource } from '../src/preprocess/index.js';
import type { TransformAction } from '../src/build-ir/types.js';

function action(): TransformAction {
  return {
    id: 'preprocess-main',
    kind: 'transform',
    tool: 'ck:preprocess',
    inputs: [
      { path: 'Other.ino', sha256: 'b'.repeat(64), role: 'sketch-tab' },
      { path: 'main.ino', sha256: 'a'.repeat(64), role: 'sketch-main' },
    ],
    outputs: [{ path: 'build/generated/main.cpp' }],
    arguments: ['main.ino', 'Other.ino', '-o', 'build/generated/main.cpp'],
    environment: {},
    dependencies: [],
    packDependencies: [],
    cacheKey: 'c'.repeat(64),
    transform: {
      input: 'main.ino',
      output: 'build/generated/main.cpp',
      format: 'other',
      flags: [],
    },
  };
}

describe('native Arduino preprocess Action', () => {
  it('reads every declared tab in argument order and preserves #line names', () => {
    const contents = new Map([
      ['main.ino', new TextEncoder().encode('void setup() {}\n')],
      ['Other.ino', new TextEncoder().encode('void loop() {}\n')],
    ]);
    const decoded = decodeNativeSketchAction(action(), (path) => contents.get(path)!);

    expect(decoded.sourceName).toBe('main.ino');
    expect(decoded.files.map((file) => file.path)).toEqual(['main.ino', 'Other.ino']);
    expect(composeArduinoSketchSource(decoded.files)).toBe(
      'void setup() {}\n#line 1 "Other.ino"\nvoid loop() {}\n',
    );
  });

  it('rejects an Action that omits a tab from its arguments', () => {
    const malformed = action();
    malformed.arguments = ['main.ino', '-o', 'build/generated/main.cpp'];
    expect(() => decodeNativeSketchAction(malformed, () => new Uint8Array()))
      .toThrow(/arguments are invalid/);
  });

  it('fails closed for case-folded duplicates, mixed roles, and legacy bundles', () => {
    const duplicate = action();
    duplicate.inputs = [
      { path: 'main.ino', sha256: 'a'.repeat(64), role: 'sketch-main' },
      { path: 'MAIN.ino', sha256: 'b'.repeat(64), role: 'sketch-tab' },
    ];
    duplicate.arguments = ['main.ino', 'MAIN.ino', '-o', duplicate.transform.output];
    expect(() => decodeNativeSketchAction(duplicate, () => new Uint8Array()))
      .toThrow(/sketch paths are invalid/);

    const mixed = action();
    mixed.inputs.push({ path: 'config.h', sha256: 'd'.repeat(64), role: 'project-header' });
    expect(() => decodeNativeSketchAction(mixed, () => new Uint8Array()))
      .toThrow(/sketch inputs are invalid/);

    const legacy = action();
    legacy.inputs = [
      { path: 'main.ino', sha256: 'a'.repeat(64), role: 'source' },
      { path: 'Other.ino', sha256: 'b'.repeat(64), role: 'source' },
    ];
    expect(() => decodeNativeSketchAction(legacy, () => new Uint8Array()))
      .toThrow(/legacy input is invalid/);
  });
});
