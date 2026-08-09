import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parsePrebuildShard, planPrebuildMatrix, selectPrebuildShard } from '../src/prebuild.js';
import { BoardRegistry, resolveOptions } from '../src/toolchain/board.js';
import { resolveEsp32BuildProfile } from '../src/toolchain/esp32.js';

const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards')).list();

describe('release prebuild matrix', () => {
  it('covers every board variant and both AVR LTO identities without unrelated cartesian growth', () => {
    const core = planPrebuildMatrix(boards, ['core']);
    expect(new Set(core.map((entry) => entry.fqbn))).toEqual(new Set(boards.map((board) => board.fqbn)));
    expect(core.filter((entry) => entry.fqbn === 'arduino:avr:uno').map((entry) => entry.options.optimize))
      .toEqual(['fast', 'size']);
    expect(core.filter((entry) => entry.fqbn === 'arduino:avr:nano')).toHaveLength(6);
    expect(core.length).toBeLessThan(boards.length * 7);
  });

  it('enumerates only valid ESP32 flash/partition combinations with stable content identities', () => {
    const first = planPrebuildMatrix(boards, ['static-firmware']);
    const second = planPrebuildMatrix([...boards].reverse(), ['static-firmware']);
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(20);
    expect(first.length).toBeLessThan(2_000);
    expect(new Set(first.map((entry) => entry.id)).size).toBe(first.length);
    const staticIdentities = first.map((entry) => {
      const board = boards.find((candidate) => candidate.fqbn === entry.fqbn)!;
      const profile = resolveEsp32BuildProfile(board, entry.options);
      return JSON.stringify({
        fqbn: entry.fqbn,
        sdkTarget: profile.sdkTarget,
        variant: board.build.variant,
        boot: profile.boot,
        bootFreq: profile.bootFreq,
        flashMode: profile.flashMode,
        flashFreq: profile.flashFreq,
        imageFreq: profile.imageFreq,
        flashSize: profile.flashSize,
        partitions: profile.partitions,
        bootAddr: board.build.bootloaderAddr ?? '0x1000',
      });
    });
    expect(new Set(staticIdentities).size).toBe(first.length);
    for (const entry of first) {
      expect(entry.identity).toMatch(/^[a-f0-9]{64}$/);
      const board = boards.find((candidate) => candidate.fqbn === entry.fqbn)!;
      expect(resolveOptions(board, entry.options).errors).toEqual([]);
      expect(entry.options.upload_speed).toBeUndefined();
      expect(entry.options.erase_flash).toBeUndefined();
    }
  });

  it('assigns every identity to exactly one stable release shard', () => {
    const entries = planPrebuildMatrix(boards, ['static-firmware']);
    const shards = Array.from({ length: 8 }, (_, index) => selectPrebuildShard(entries, { index, total: 8 }));
    expect(shards.flat().sort((left, right) => left.id.localeCompare(right.id)))
      .toEqual([...entries].sort((left, right) => left.id.localeCompare(right.id)));
    expect(new Set(shards.flat().map((entry) => entry.identity)).size).toBe(entries.length);
    expect(parsePrebuildShard('3/8')).toEqual({ index: 2, total: 8 });
    expect(() => parsePrebuildShard('0/8')).toThrow(/out of range/);
    expect(() => parsePrebuildShard('9/8')).toThrow(/out of range/);
  });
});
