#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..');
const source = resolve(root, 'crates/ck-build-core/dist/web');
const manifest = JSON.parse(await readFile(resolve(source, 'build-manifest.json'), 'utf8'));
const destinations = [
  resolve(root, 'packages/web/public/ck-build-core-wasm'),
  resolve(root, 'packages/core/wasm'),
];

if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
  throw new TypeError('invalid CK Build Core WASM manifest');
}

for (const record of manifest.files) {
  if (!record?.path || record.path.includes('..') || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new TypeError('unsafe CK Build Core WASM manifest entry');
  }
  const input = resolve(source, record.path);
  const bytes = await readFile(input);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== record.bytes || digest !== record.sha256) {
    throw new Error(`CK Build Core WASM integrity mismatch: ${record.path}`);
  }
  for (const destination of destinations) {
    await mkdir(destination, { recursive: true });
    await copyFile(input, resolve(destination, record.path));
  }
}

const stableManifest = `${JSON.stringify(manifest, null, 2)}\n`;
for (const destination of destinations) {
  await writeFile(resolve(destination, 'build-manifest.json'), stableManifest, 'utf8');
}

console.log(`Published CK Build Core WASM to ${destinations.length} runtime locations`);
