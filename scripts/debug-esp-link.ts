import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { memoizedToolchainIdentity } from '../packages/core/src/cache/identity.js';
import { LocalExecutor } from '../packages/core/src/sandbox/local.js';
import {
  BoardRegistry,
  applyOptions,
  resolveOptions,
} from '../packages/core/src/toolchain/board.js';
import { detectLocalToolchain } from '../packages/core/src/toolchain/config.js';
import { Esp32Toolchain } from '../packages/core/src/toolchain/esp32.js';

async function main(): Promise<void> {
  const root = process.cwd();
  const config = detectLocalToolchain();
  const boards = BoardRegistry.fromDirectory(join(root, 'boards'));
  const base = boards.get('esp32:esp32:esp32');
  if (!base || !config.esp32) throw new Error('ESP32 toolchain unavailable');

  const { options } = resolveOptions(base);
  const board = applyOptions(base, options);
  const buildDir = join(root, 'var', 'work', 'debug-esp-link');
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  const cpp = join(buildDir, 'main.cpp');
  writeFileSync(
    cpp,
    '#include <Arduino.h>\nvoid setup(){pinMode(2,OUTPUT);}\nvoid loop(){digitalWrite(2,HIGH);delay(500);}\n',
  );

  const bundleId = process.env.AF_COMPILER_BUNDLE_ID;
  const identity = bundleId
    ? createHash('sha256')
        .update('arduinofast-immutable-compiler-bundle-v1\0')
        .update('esp32')
        .update('\0')
        .update(bundleId)
        .digest('hex')
    : memoizedToolchainIdentity(config, boards, 'esp32');
  const toolchain = new Esp32Toolchain(
    config.esp32,
    new LocalExecutor(),
    config.cacheDir,
    undefined,
    identity,
    Boolean(bundleId),
  );
  toolchain.setLibraryRoots(config.librariesDirs);
  const result = await toolchain.build(board, options, cpp, buildDir);
  console.log(JSON.stringify({ ok: result.ok, stage: result.failedStage, timings: result.timings }));
  console.log(result.output.slice(-20_000));
}

void main();
