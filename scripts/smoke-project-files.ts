import { join } from 'node:path';

import {
  BoardRegistry,
  CompileService,
  FileL0Cache,
  LibraryRegistry,
  LocalExecutor,
  detectLocalToolchain,
  type CompileRequest,
} from '../packages/core/src/index.js';

const toolchain = detectLocalToolchain();
const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
const cacheDir = join(toolchain.cacheDir, 'smoke-project-files');
const service = new CompileService({
  boards,
  toolchain: { ...toolchain, cacheDir },
  executor: new LocalExecutor(),
  cache: new FileL0Cache(join(cacheDir, 'l0')),
  libraries: LibraryRegistry.fromDirectories(toolchain.librariesDirs),
});

const salt = Date.now() % 100_000;
const files: CompileRequest['files'] = [
  {
    name: 'main.ino',
    content: [
      '#include <MathBox.h>',
      `volatile int result = ${salt};`,
      'void setup() { result = projectTwice(result); }',
      'void loop() { delay(result & 1); }',
      '',
    ].join('\n'),
  },
  {
    name: 'src/MathBox.h',
    content: '#pragma once\nint projectTwice(int value);\n',
  },
  {
    name: 'src/MathBox.cpp',
    content: '#include <Arduino.h>\n#include "MathBox.h"\nint projectTwice(int value) { return value * 2; }\n',
  },
];

const targets = [
  ...(toolchain.avr ? ['arduino:avr:uno'] : []),
  ...(toolchain.esp32 ? ['esp32:esp32:esp32'] : []),
];
if (targets.length === 0) throw new Error('no AVR or ESP32 toolchain detected');

async function main(): Promise<void> {
  for (const board of targets) {
    const request: CompileRequest = { board, files };
    const first = await service.compile(request);
    if (first.status !== 'success') {
      throw new Error(`${board} project compile failed: ${first.reason}: ${first.message}`);
    }
    const repeated = await service.compile(request);
    if (repeated.status !== 'success' || !repeated.cached) {
      throw new Error(`${board} repeated project compile did not hit L0 cache`);
    }
    const broken: CompileRequest = {
      ...request,
      files: files.map((file) => file.name === 'src/MathBox.cpp'
        ? { ...file, content: '#include "MathBox.h"\nint projectTwice(int value) { return missingSymbol + value; }\n' }
        : file),
    };
    const failed = await service.compile(broken);
    const diagnostic = failed.status === 'error'
      ? failed.diagnostics.find((entry) => entry.severity === 'error')
      : undefined;
    if (failed.status !== 'error' || diagnostic?.file !== 'src/MathBox.cpp' || diagnostic.line !== 2) {
      throw new Error(`${board} project-file diagnostic was not mapped to src/MathBox.cpp:2`);
    }
    console.log(`${board}: ${first.artifacts[0]?.name} ${first.artifacts[0]?.size} bytes; cached repeat ok`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
