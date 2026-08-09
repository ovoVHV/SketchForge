import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectLocalToolchain } from '../src/toolchain/config.js';

const ENV_KEYS = [
  'ARDUINO15_DIR',
  'AF_LIBRARIES_DIRS',
  'AF_AVR_BIN',
  'AF_AVR_CORE',
  'AF_AVR_VARIANTS',
  'AF_AVR_ROOT',
  'AF_ESP32_XTENSA_BIN',
  'AF_ESP32_XTENSA_ROOT',
  'AF_ESP32_RISCV_BIN',
  'AF_ESP32_RISCV_ROOT',
  'AF_ESP32_CORE',
  'AF_ESP32_VARIANTS',
  'AF_ESP32_PLATFORM',
  'AF_ESP32_SDK_ROOT',
  'AF_ESP32_ESPTOOL',
] as const;

const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local platform library discovery', () => {
  it('includes ESP32 platform libraries immediately after AVR platform libraries', () => {
    const root = mkdtempSync(join(tmpdir(), 'af-local-toolchain-libraries-'));
    roots.push(root);
    const avrLibraries = join(root, 'packages', 'arduino', 'hardware', 'avr', '1.8.7', 'libraries');
    const esp32Platform = join(root, 'packages', 'esp32', 'hardware', 'esp32', '3.3.7');
    const esp32Libraries = join(esp32Platform, 'libraries');

    mkdirSync(avrLibraries, { recursive: true });
    mkdirSync(esp32Libraries, { recursive: true });
    mkdirSync(join(root, 'packages', 'esp32', 'tools', 'esptool_py', '4.8.1'), { recursive: true });

    for (const key of ENV_KEYS) delete process.env[key];
    process.env.ARDUINO15_DIR = root;

    const config = detectLocalToolchain();
    const avrIndex = config.librariesDirs.indexOf(avrLibraries);
    const esp32Index = config.librariesDirs.indexOf(esp32Libraries);

    expect(config.esp32?.platformDir).toBe(esp32Platform);
    expect(avrIndex).toBeGreaterThanOrEqual(0);
    expect(esp32Index).toBe(avrIndex + 1);
  });
});
