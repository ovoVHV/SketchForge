import { describe, expect, it } from 'vitest';
import { parse } from 'node:path';
import {
  isSafeEsp32PrewarmCacheDir,
  parseEsp32PrewarmBoardAllowlist,
  resolveEsp32PrewarmCacheDir,
  selectEsp32PrewarmBoards,
} from '../src/prewarm.js';

const boards = [
  { fqbn: 'arduino:avr:uno', arch: 'avr' },
  { fqbn: 'esp32:esp32:esp32', arch: 'esp32' },
  { fqbn: 'esp32:esp32:esp32s3', arch: 'esp32' },
];

describe('ESP32 prewarm selection', () => {
  it('uses every locally supported ESP32 board by default and reports skipped boards', () => {
    const selected = selectEsp32PrewarmBoards(
      boards,
      (board) => board.fqbn === 'esp32:esp32:esp32',
      null,
    );

    expect(selected.errors).toEqual([]);
    expect(selected.boards.map((board) => board.fqbn)).toEqual(['esp32:esp32:esp32']);
    expect(selected.unavailable.map((board) => board.fqbn)).toEqual(['esp32:esp32:esp32s3']);
  });

  it('fails an explicit whitelist containing unavailable or non-ESP32 boards', () => {
    const selected = selectEsp32PrewarmBoards(
      boards,
      (board) => board.fqbn === 'esp32:esp32:esp32',
      ['esp32:esp32:esp32', 'esp32:esp32:esp32s3', 'arduino:avr:uno'],
    );

    expect(selected.boards.map((board) => board.fqbn)).toEqual(['esp32:esp32:esp32']);
    expect(selected.errors).toEqual([
      'local ESP32 toolchain does not support requested board: esp32:esp32:esp32s3',
      'AF_PREWARM_BOARDS contains an unknown or non-ESP32 board: arduino:avr:uno',
    ]);
  });

  it('parses a trimmed unique allowlist while retaining an invalid comma-only value', () => {
    expect(parseEsp32PrewarmBoardAllowlist(undefined)).toBeNull();
    expect(parseEsp32PrewarmBoardAllowlist('   ')).toBeNull();
    expect(parseEsp32PrewarmBoardAllowlist(' esp32:esp32:esp32, esp32:esp32:esp32 ,,esp32:esp32:esp32s3 '))
      .toEqual(['esp32:esp32:esp32', 'esp32:esp32:esp32s3']);
    expect(parseEsp32PrewarmBoardAllowlist(' , ')).toEqual([]);
  });

  it('resolves an override and rejects a filesystem root as a cache target', () => {
    const cache = resolveEsp32PrewarmCacheDir('var/cache', 'var/prewarm-cache');
    expect(cache).toMatch(/prewarm-cache$/);
    expect(isSafeEsp32PrewarmCacheDir(cache)).toBe(true);
    expect(isSafeEsp32PrewarmCacheDir(process.cwd())).toBe(true);
    expect(isSafeEsp32PrewarmCacheDir(parse(process.cwd()).root)).toBe(false);
  });
});
