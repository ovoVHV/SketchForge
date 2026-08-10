import { describe, expect, it } from 'vitest';

import { fingerprintCompileRequest } from '../src/request-fingerprint.js';
import type { CompileRequest } from '../src/types.js';

function request(overrides: Partial<CompileRequest> = {}): CompileRequest {
  return {
    board: 'arduino:avr:uno',
    files: [{
      name: 'main.ino',
      content: 'void setup() {}\nvoid loop() {}\n',
    }],
    options: { optimize: 'fast', cpu: 'atmega328' },
    libraries: [
      { name: 'Wire', version: '1.0.0' },
      { name: 'SPI' },
    ],
    ...overrides,
  };
}

describe('fingerprintCompileRequest', () => {
  it('canonicalizes line endings, option order, library order, and ignores sessionId', () => {
    const first = request({
      files: [{
        name: 'main.ino',
        content: '\ufeffvoid setup() {}\r\nvoid loop() {}\r\n',
      }],
      options: { optimize: 'fast', cpu: 'atmega328' },
      libraries: [
        { name: 'Wire', version: '1.0.0' },
        { name: 'SPI' },
      ],
      sessionId: 'browser-a',
    });
    const second = request({
      options: { cpu: 'atmega328', optimize: 'fast' },
      libraries: [
        { name: 'SPI', version: undefined },
        { name: 'Wire', version: '1.0.0' },
      ],
      sessionId: 'browser-b',
    });

    expect(fingerprintCompileRequest(first)).toEqual(fingerprintCompileRequest(second));
    expect(fingerprintCompileRequest(first)).toEqual({
      baseHash: '9af88b36fcfa40ef8bc08f4adae8eadab1acbb6089ecf48b8da88e8f7dfa1abf',
      resultReusable: true,
    });
  });

  it('treats omitted and empty optional build inputs identically', () => {
    const omitted = request({ options: undefined, libraries: undefined });
    const empty = request({ options: {}, libraries: [] });

    expect(fingerprintCompileRequest(omitted)).toEqual(fingerprintCompileRequest(empty));
  });

  it('canonicalizes project-file order but includes every file in the hash', () => {
    const firstFiles = [
      { name: 'main.ino', content: '#include "Math.h"\nvoid setup() {}\nvoid loop() {}\n' },
      { name: 'src/Math.h', content: '#pragma once\nint twice(int);\n' },
      { name: 'src/Math.cpp', content: 'int twice(int x) { return x * 2; }\n' },
    ];
    const reordered = [firstFiles[2]!, firstFiles[0]!, firstFiles[1]!];
    const changed = firstFiles.map((file) => (
      file.name === 'src/Math.cpp' ? { ...file, content: 'int twice(int x) { return x + x; }\n' } : file
    ));

    expect(fingerprintCompileRequest(request({ files: firstFiles })))
      .toEqual(fingerprintCompileRequest(request({ files: reordered })));
    expect(fingerprintCompileRequest(request({ files: changed })).baseHash)
      .not.toBe(fingerprintCompileRequest(request({ files: firstFiles })).baseHash);
  });

  it('changes the hash for every artifact-relevant request component', () => {
    const base = fingerprintCompileRequest(request()).baseHash;
    const variants = [
      request({ board: 'arduino:avr:nano' }),
      request({ files: [{ name: 'other.ino', content: 'void setup() {}\nvoid loop() {}\n' }] }),
      request({ files: [{ name: 'main.ino', content: 'void setup() { pinMode(13, 1); }\nvoid loop() {}\n' }] }),
      request({ options: { optimize: 'size', cpu: 'atmega328' } }),
      request({ libraries: [{ name: 'Wire', version: '2.0.0' }, { name: 'SPI' }] }),
    ];

    for (const variant of variants) {
      expect(fingerprintCompileRequest(variant).baseHash).not.toBe(base);
    }
  });

  it.each(['__DATE__', '__TIME__', '__TIMESTAMP__', '__COUNTER__'])(
    'marks %s requests as completed-result non-reusable while retaining a stable base hash',
    (macro) => {
      const source = `const char *build = ${macro};\nvoid setup() {}\nvoid loop() {}\n`;
      const first = fingerprintCompileRequest(request({
        files: [{ name: 'main.ino', content: source }],
        sessionId: 'first',
      }));
      const second = fingerprintCompileRequest(request({
        files: [{ name: 'main.ino', content: source }],
        sessionId: 'second',
      }));

      expect(first.resultReusable).toBe(false);
      expect(first.baseHash).toBe(second.baseHash);
      expect(first.baseHash).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it('marks a helper source with __TIME__ as non-reusable', () => {
    const fingerprint = fingerprintCompileRequest(request({
      files: [
        { name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' },
        { name: 'src/build.cpp', content: 'const char *builtAt = __TIME__;\n' },
      ],
    }));

    expect(fingerprint.resultReusable).toBe(false);
  });
});
