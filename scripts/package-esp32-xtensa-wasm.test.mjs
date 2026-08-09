import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  EXPECTED_PACKAGE_FILES,
  PACKAGE_NAME,
  createPackagePlan,
  parseArguments,
  validatePackagePlan,
  validateTemplateContract,
} from './package-esp32-xtensa-wasm.mjs';
import { parseClangDriverOutput } from './esp32-xtensa-wasm-package/lib/clang-driver-output.js';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(SCRIPT_DIRECTORY, 'package-esp32-xtensa-wasm.mjs');

test('Xtensa package templates preserve the fixed package and runClang contracts', () => {
  assert.doesNotThrow(() => validateTemplateContract());
  const artifact = JSON.parse(readFileSync(
    join(SCRIPT_DIRECTORY, 'esp32-xtensa-wasm-package', 'artifact-package.json'),
    'utf8',
  ));
  assert.equal(artifact.name, PACKAGE_NAME);
  assert.deepEqual([...artifact.files, 'package.json'], EXPECTED_PACKAGE_FILES);
});

test('dry-run validates inputs and reports the complete jco/resource/npm plan', () => {
  const fixture = makeFixture();
  try {
    const output = execFileSync(process.execPath, [
      SCRIPT,
      '--llvm', fixture.llvm,
      '--wasi-prefix', fixture.wasiPrefix,
      '--version', '21.1.3-espressif.1',
      '--out', join(fixture.root, 'artifact'),
      '--dry-run',
    ], { cwd: resolve(SCRIPT_DIRECTORY, '..'), encoding: 'utf8' });
    const plan = JSON.parse(output);
    assert.equal(plan.package.name, PACKAGE_NAME);
    assert.equal(plan.package.version, '21.1.3-espressif.1');
    assert.equal(plan.inputs.llvm, fixture.llvm);
    assert.equal(plan.inputs.resourceRoot, join(fixture.wasiPrefix, 'usr'));
    assert.deepEqual(plan.steps.map((step) => step.tool), [
      'npm',
      'jco',
      'jco',
      'yowasp-pack-resources',
      'esbuild',
      'npm',
    ]);
    assert.deepEqual(plan.includedFiles, EXPECTED_PACKAGE_FILES);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('npm pack cannot include files outside the audited artifact whitelist', () => {
  const root = mkdtempSync(join(tmpdir(), 'arduinofast-xtensa-pack-list-test-'));
  try {
    const template = join(SCRIPT_DIRECTORY, 'esp32-xtensa-wasm-package', 'artifact-package.json');
    const manifest = JSON.parse(readFileSync(template, 'utf8'));
    manifest.version = '21.1.3-espressif.1';
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    for (const relativePath of EXPECTED_PACKAGE_FILES) {
      if (relativePath === 'package.json') continue;
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, relativePath + '\n');
    }
    writeFileSync(join(root, 'package-lock.json'), '{"must":"not be packed"}\n');
    mkdirSync(join(root, 'dist'));
    const report = JSON.parse(execFileSync(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', join(root, 'dist')],
      { cwd: root, encoding: 'utf8' },
    ));
    assert.equal(report.length, 1);
    assert.deepEqual(
      report[0].files.map((file) => file.path).sort(),
      [...EXPECTED_PACKAGE_FILES].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runClang parser keeps Xtensa driver warnings and still replays every job', () => {
  const fixture = readFileSync(join(
    SCRIPT_DIRECTORY,
    'esp32-xtensa-wasm-package',
    'test-fixtures',
    'esp-clang-21.1.3-xtensa-hash3.txt',
  ), 'utf8');
  const parsed = parseClangDriverOutput(fixture);

  assert.equal(parsed.valid, true);
  assert.equal(parsed.commands.length, 1);
  assert.match(parsed.commands[0][0], /clang\.exe$/);
  assert.ok(parsed.commands[0].includes('-cc1'));
  assert.ok(parsed.commands[0].includes('xtensa-esp-unknown-elf'));
  assert.ok(parsed.commands[0].includes('sketch.o'));
  assert.match(parsed.diagnostics, /-freorder-blocks/);
  assert.match(parsed.diagnostics, /-mlongcalls/);
});

test('runClang parser rejects unknown in-band output instead of guessing jobs', () => {
  const parsed = parseClangDriverOutput([
    'clang version 21.1.3',
    'unrecognized driver protocol line',
    ' "/usr/bin/clang" "-cc1"',
    '',
  ].join('\n'));
  assert.equal(parsed.valid, false);
  assert.equal(parsed.invalidLine, 'unrecognized driver protocol line');
});

test('input validation rejects a missing compiler before any packaging work', () => {
  const fixture = makeFixture();
  try {
    const result = spawnSync(process.execPath, [
      SCRIPT,
      '--llvm', join(fixture.root, 'missing-llvm'),
      '--wasi-prefix', fixture.wasiPrefix,
      '--version', '21.1.3-espressif.1',
      '--dry-run',
    ], { cwd: resolve(SCRIPT_DIRECTORY, '..'), encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WASI llvm-driver output is missing/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('version is explicit SemVer and never inferred from an LLVM tag', () => {
  const fixture = makeFixture();
  try {
    const options = parseArguments([
      '--llvm', fixture.llvm,
      '--wasi-prefix', fixture.wasiPrefix,
      '--version', 'llvmorg-21.1.3',
    ]);
    assert.throws(() => createPackagePlan(options), /valid SemVer/);

    const valid = createPackagePlan(parseArguments([
      '--llvm', fixture.llvm,
      '--wasi-prefix', fixture.wasiPrefix,
      '--version', '21.1.3-espressif.570c44b6',
    ]));
    assert.doesNotThrow(() => validatePackagePlan(valid));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'arduinofast-xtensa-package-test-'));
  const llvm = join(root, 'llvm-build', 'bin', 'llvm');
  const wasiPrefix = join(root, 'clang-resource-headers', 'wasi-prefix');
  mkdirSync(dirname(llvm), { recursive: true });
  mkdirSync(join(wasiPrefix, 'usr', 'include'), { recursive: true });
  writeFileSync(llvm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
  writeFileSync(join(wasiPrefix, 'usr', 'include', 'stddef.h'), '/* fixture */\n');
  return { root, llvm, wasiPrefix };
}
