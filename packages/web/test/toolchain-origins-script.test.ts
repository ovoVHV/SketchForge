import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../public/toolchain-origins.js', import.meta.url)),
  'utf8',
);

const CURRENT_KEY = '__SKETCHFORGE_TOOLCHAIN_ORIGINS__';
const LEGACY_KEY = '__ARDUINOFAST_TOOLCHAIN_ORIGINS__';

describe('deployment toolchain origin bootstrap', () => {
  it('copies a legacy deployment configuration into the current global', () => {
    const legacy = Object.freeze({
      'arduino-avr-uno': 'https://legacy-cdn.example.test/avr/v4/',
    });
    const globalThis = { [LEGACY_KEY]: legacy };

    runInNewContext(source, { globalThis, Object });

    expect(globalThis[CURRENT_KEY as keyof typeof globalThis]).toBe(legacy);
  });

  it('does not overwrite a current deployment configuration', () => {
    const current = Object.freeze({
      'arduino-avr-uno': 'https://current-cdn.example.test/avr/v4/',
    });
    const globalThis = {
      [CURRENT_KEY]: current,
      [LEGACY_KEY]: Object.freeze({
        'arduino-avr-uno': 'https://legacy-cdn.example.test/avr/v4/',
      }),
    };

    runInNewContext(source, { globalThis, Object });

    expect(globalThis[CURRENT_KEY]).toBe(current);
  });
});
