import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  BoardRegistry,
  type BoardDefinition,
} from '@sketchforge/core';
import { boardAvailabilityResponse, boardCompileOptionError } from '../src/board-availability.js';

function board(fqbn: string, arch: BoardDefinition['arch']): BoardDefinition {
  return {
    fqbn,
    name: fqbn,
    arch,
    flashTotal: 1,
    ramTotal: 1,
    upload: { protocol: arch === 'avr' ? 'stk500v1' : 'esp32' },
    options: [],
    pins: [],
    build: {
      mcu: arch === 'avr' ? 'atmega328p' : 'esp32',
      fCpu: '16000000L',
      variant: 'standard',
      defines: [],
    },
  };
}

describe('boardAvailabilityResponse', () => {
  it('preserves the ready-only boards contract and exposes unavailable boards separately', () => {
    const registry = new BoardRegistry();
    registry.add(board('arduino:avr:uno', 'avr'));
    registry.add(board('esp32:esp32:esp32', 'esp32'));
    registry.add(board('esp32:esp32:esp32s3', 'esp32'));
    registry.add(board('esp32:esp32:esp32c3', 'esp32'));

    const response = boardAvailabilityResponse(
      registry,
      (fqbn) => fqbn === 'arduino:avr:uno' || fqbn === 'esp32:esp32:esp32s3',
    );

    expect(response.boards.map(({ fqbn, available }) => ({ fqbn, available }))).toEqual([
      { fqbn: 'arduino:avr:uno', available: true },
      { fqbn: 'esp32:esp32:esp32s3', available: true },
    ]);
    expect(response.unavailableBoards.map(({ fqbn, available }) => ({ fqbn, available }))).toEqual([
      { fqbn: 'esp32:esp32:esp32', available: false },
      { fqbn: 'esp32:esp32:esp32c3', available: false },
    ]);
    expect([...response.boards, ...response.unavailableBoards])
      .not.toContainEqual(expect.objectContaining({ build: expect.anything() }));
  });

  it('publishes the ESP32-S3 unsupported option and rejects it at the server boundary', () => {
    const registry = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
    const board = registry.get('esp32:esp32:esp32s3')!;
    const publicBoard = registry.toPublic(board);
    const partition = publicBoard.options.find((option) => option.id === 'partition_scheme')!;
    const espSr = partition.values.find((value) => value.value === 'esp_sr_16')!;

    expect(espSr.unsupported?.reason).toContain('srmodels.bin');
    expect(boardCompileOptionError(board, { partition_scheme: 'esp_sr_16' }))
      .toMatch(/暂不支持/);
    expect(boardCompileOptionError(board, { PartitionScheme: 'esp_sr_16' }))
      .toMatch(/PartitionScheme=esp_sr_16/);
    expect(boardCompileOptionError(board, { partition_scheme: 'default' })).toBeUndefined();
  });
});
