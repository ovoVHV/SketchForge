import { describe, expect, it } from 'vitest';
import type { BoardDefinition } from '@arduinofast/core';
import { queueName, workerPoolForBoard } from '../src/distributed-queue.js';

function board(arch: BoardDefinition['arch'], tarch?: string): BoardDefinition {
  return {
    fqbn: `test:${arch}:board`,
    name: 'Test',
    arch,
    pins: [],
    options: [],
    flashTotal: 1,
    ramTotal: 1,
    upload: { protocol: arch === 'avr' ? 'stk500v1' : 'esp32' },
    build: { mcu: 'test', fCpu: '1', variant: 'test', defines: [], ...(tarch ? { tarch } : {}) },
  };
}

describe('distributed queue routing', () => {
  it('routes AVR, Xtensa and RISC-V into independent worker pools', () => {
    expect(workerPoolForBoard(board('avr'))).toBe('avr');
    expect(workerPoolForBoard(board('esp32', 'xtensa'))).toBe('esp32-xtensa');
    expect(workerPoolForBoard(board('esp32', 'riscv32'))).toBe('esp32-riscv');
    expect(queueName('compile', 'esp32-riscv', 'v1'))
      .toMatch(/^compile-b[a-f0-9]{24}-r[a-f0-9]{24}-esp32-riscv$/);
    expect(queueName('compile', 'esp32-riscv', 'v1')).not.toBe(queueName('compile', 'esp32-riscv', 'v2'));
  });
});
