#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(scriptDirectory, '..');
const targets = [
  {
    entryPoint: resolve(workspace, 'packages/core/src/build-ir/local-libraries.ts'),
    outfile: resolve(workspace, 'packages/web/public/ck-project-resolver.js'),
    banner: '// Generated CK project resolver. Build IR planning is provided only by ck-build-core Rust/WASM.',
  },
  {
    entryPoint: resolve(workspace, 'packages/core/src/build-ir/platform-planning.ts'),
    outfile: resolve(workspace, 'packages/web/public/ck-platform-planning.js'),
    banner: '// Generated from @arduinofast/core platform-planning. Do not maintain a browser-specific planner.',
  },
  {
    entryPoint: resolve(workspace, 'packages/core/src/esp32/custom-partitions.ts'),
    outfile: resolve(workspace, 'packages/web/public/ck-esp32-partitions.js'),
    banner: '// Generated from @arduinofast/core ESP32 custom partitions. Browser and Native share one implementation.',
  },
  {
    entryPoint: resolve(workspace, 'packages/core/src/blocks/generator.ts'),
    outfile: resolve(workspace, 'packages/web/public/ck-blockly-generator.js'),
    banner: '// Generated from @arduinofast/core blocks generator. Do not maintain browser-only code generation.',
  },
  {
    entryPoint: resolve(workspace, 'packages/core/src/firmware/index.ts'),
    outfile: resolve(workspace, 'packages/web/public/ck-firmware-patch.js'),
    banner: '// Generated from @arduinofast/core firmware patching. Browser and test code share one implementation.',
  },
];

for (const target of targets) {
  await mkdir(dirname(target.outfile), { recursive: true });
  await build({
    entryPoints: [target.entryPoint],
    outfile: target.outfile,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: ['es2022'],
    treeShaking: true,
    sourcemap: false,
    legalComments: 'none',
    banner: { js: target.banner },
  });
  console.log(`CK browser core module: ${target.outfile}`);
}
