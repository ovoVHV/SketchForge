import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { CompileService } from '../src/compile.js';
import type { BuildIR } from '../src/build-ir/types.js';
import { LocalExecutor } from '../src/sandbox/local.js';
import {
  applyOptions,
  BoardRegistry,
  buildOptions,
  resolveOptions,
} from '../src/toolchain/board.js';

const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function effectiveBoard(fqbn: string, cpu: string) {
  const board = boards.get(fqbn);
  expect(board).toBeDefined();
  const resolved = resolveOptions(board!, { cpu, optimize: 'fast' });
  expect(resolved.errors).toEqual([]);
  return applyOptions(board!, buildOptions(board!, resolved.options));
}

function planner() {
  const root = mkdtempSync(join(tmpdir(), 'ck-avr-board-options-'));
  roots.push(root);
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'variants', 'standard'), { recursive: true });
  mkdirSync(join(root, 'variants', 'eightanaloginputs'), { recursive: true });
  mkdirSync(join(root, 'variants', 'mega'), { recursive: true });
  writeFileSync(join(root, 'core', 'Arduino.c'), 'int ck_core(void) { return 0; }\n');
  writeFileSync(join(root, 'variants', 'standard', 'pins_arduino.h'), '#pragma once\n');
  writeFileSync(
    join(root, 'variants', 'eightanaloginputs', 'pins_arduino.h'),
    '#include "../standard/pins_arduino.h"\n',
  );
  writeFileSync(join(root, 'variants', 'mega', 'pins_arduino.h'), '#pragma once\n');

  return new CompileService({
    boards,
    toolchain: {
      avr: {
        binDir: join(root, 'bin'),
        coreDir: join(root, 'core'),
        variantsDir: join(root, 'variants'),
      },
      cacheDir: join(root, 'cache'),
      workDir: join(root, 'work'),
      librariesDirs: [],
    },
    executor: new LocalExecutor(),
    toolchainIdentityHint: 'avr-board-options-test',
  });
}

describe('official Arduino AVR processor menus', () => {
  it.each([
    ['arduino:avr:nano', 'atmega328', 'atmega328p', 30_720, 2_048, undefined],
    ['arduino:avr:nano', 'atmega328old', 'atmega328p', 30_720, 2_048, undefined],
    ['arduino:avr:nano', 'atmega168', 'atmega168', 14_336, 1_024, undefined],
    ['arduino:avr:diecimila', 'atmega328', 'atmega328p', 30_720, 2_048, 'AVR_DUEMILANOVE'],
    ['arduino:avr:diecimila', 'atmega168', 'atmega168', 14_336, 1_024, 'AVR_DUEMILANOVE'],
    ['arduino:avr:mega', 'atmega2560', 'atmega2560', 253_952, 8_192, 'AVR_MEGA2560'],
    ['arduino:avr:mega', 'atmega1280', 'atmega1280', 126_976, 8_192, 'AVR_MEGA'],
  ])(
    '%s/%s resolves compiler target and memory limits',
    (fqbn, cpu, mcu, flashTotal, ramTotal, boardDefine) => {
      expect(effectiveBoard(fqbn, cpu)).toMatchObject({
        flashTotal,
        ramTotal,
        build: { mcu, ...(boardDefine ? { boardDefine } : {}) },
      });
    },
  );

  it.each([
    ['arduino:avr:nano', 'atmega168', 'atmega168', undefined],
    ['arduino:avr:diecimila', 'atmega168', 'atmega168', 'AVR_DUEMILANOVE'],
    ['arduino:avr:mega', 'atmega2560', 'atmega2560', 'AVR_MEGA2560'],
    ['arduino:avr:mega', 'atmega1280', 'atmega1280', 'AVR_MEGA'],
  ])(
    '%s/%s emits its selected MCU and board macro into CK Build IR',
    async (fqbn, cpu, mcu, boardDefine) => {
      const ir = await planner().planActionGraph({
        board: fqbn,
        options: { cpu, optimize: 'fast' },
        files: [{ name: 'main.ino', content: '' }],
      });
      const argumentsText = ir.graph.actions.flatMap((action) => action.arguments).join('\n');

      expect(ir.target.options.cpu).toBe(cpu);
      expect(ir.packs.toolchain.instructionSet).toBe(mcu);
      expect(argumentsText).toContain(`-mmcu=${mcu}`);
      if (boardDefine) expect(argumentsText).toContain(`-DARDUINO_${boardDefine}`);
    },
  );

  it('preserves Nano variant sibling paths required by pins_arduino.h', async () => {
    const compiler = planner();
    const request = {
      board: 'arduino:avr:nano',
      options: { cpu: 'atmega168', optimize: 'fast' },
      files: [{ name: 'main.ino', content: '' }],
    };
    const ir = await compiler.planActionGraph(request);
    const compileArguments = ir.graph.actions
      .filter((action) => action.kind === 'compile')
      .flatMap((action) => action.arguments);
    const workspace = mkdtempSync(join(tmpdir(), 'ck-nano-pack-layout-'));
    roots.push(workspace);
    type ProviderAccess = {
      nativePackProviderFor(
        req: typeof request,
        value: BuildIR,
      ): Promise<{ materialize(packs: BuildIR['packs'], destination: string): void }>;
    };
    const provider = await (compiler as unknown as ProviderAccess).nativePackProviderFor(request, ir);
    provider.materialize(ir.packs, workspace);

    expect(existsSync(join(workspace, 'packs/board/variant/pins_arduino.h'))).toBe(true);
    expect(existsSync(join(workspace, 'packs/board/standard/pins_arduino.h'))).toBe(true);
    expect(compileArguments).toContain('-Ipacks/board/variant');
    expect(compileArguments).toContain('-Ipacks/board/standard');
  });
});
