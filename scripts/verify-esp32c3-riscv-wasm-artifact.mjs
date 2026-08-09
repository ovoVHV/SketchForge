#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_PACKAGE = '@arduinofast/esp32c3-clang-wasm';
const root = process.cwd();

if (process.argv[2] === '--self-test') {
  runSelfTest();
  console.log('PASS ESP32-C3 RISC-V WASM artifact verifier self-test');
  process.exit(0);
}

if (process.argv.length !== 3) {
  throw new Error('usage: node scripts/verify-esp32c3-riscv-wasm-artifact.mjs <artifact-directory>');
}

const artifactRoot = resolve(root, process.argv[2]);
const lock = JSON.parse(readFileSync(resolve(root, 'toolchains', 'esp32c3-riscv-wasm', 'source-lock.json'), 'utf8'));
const tarballs = listFiles(artifactRoot).filter((path) => path.endsWith('.tgz'));
if (tarballs.length !== 1) {
  throw new Error(`expected exactly one compiler package in ${artifactRoot}, found ${tarballs.length}`);
}

const tarball = tarballs[0];
const installRoot = mkdtempSync(join(tmpdir(), 'esp32c3-riscv-wasm-smoke-'));
try {
  writeFileSync(join(installRoot, 'package.json'), '{"private":true,"type":"module"}\n');
  execFileSync(npmExecutable(), [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    tarball,
  ], { cwd: installRoot, stdio: 'inherit' });

  const packageRoot = join(installRoot, 'node_modules', '@arduinofast', 'esp32c3-clang-wasm');
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.name !== EXPECTED_PACKAGE || typeof packageJson.version !== 'string') {
    throw new Error(`unexpected compiler package identity: ${packageJson.name}@${packageJson.version}`);
  }

  const compiler = await import(pathToFileURL(join(packageRoot, 'gen', 'bundle.js')).href);
  if (typeof compiler.runClang !== 'function') {
    throw new Error('compiler package does not export runClang()');
  }

  const source = [
    'typedef unsigned int u32;',
    '__attribute__((used, noinline))',
    'u32 esp32c3_wasm_smoke(u32 left, u32 right) {',
    '  u32 cycle;',
    '  __asm__ volatile ("csrr %0, cycle" : "=r"(cycle));',
    '  __asm__ volatile ("fence.i" ::: "memory");',
    '  return left * right + cycle;',
    '}',
    '',
  ].join('\n');
  const compilerArgs = [
    'clang',
    `--target=${lock.sdk.target}`,
    `-march=${lock.sdk.march}`,
    '-mabi=ilp32',
    '-Oz',
    '-ffreestanding',
    '-fno-builtin',
    '-nostdlib',
    '-c',
    'smoke.c',
    '-o',
    'smoke.o',
  ];
  const stdout = [];
  const stderr = [];
  let files;
  try {
    files = await compiler.runClang(
      compilerArgs,
      { 'smoke.c': new TextEncoder().encode(source) },
      { stdout: capture(stdout), stderr: capture(stderr) },
    );
  } catch (error) {
    throw new Error([
      `WASM Clang smoke compile failed: ${errorMessage(error)}`,
      decode(stdout),
      decode(stderr),
    ].filter(Boolean).join('\n'));
  }

  const objectEntry = Object.entries(files).find(([path]) => basename(path) === 'smoke.o');
  if (!objectEntry || !(objectEntry[1] instanceof Uint8Array)) {
    throw new Error('WASM Clang did not return smoke.o');
  }
  const object = new Uint8Array(objectEntry[1]);
  const elf = inspectRiscvElf32(object);

  const smokeDir = join(artifactRoot, 'smoke');
  mkdirSync(smokeDir, { recursive: true });
  writeFileSync(join(smokeDir, 'smoke.o'), object);

  const packageSha256 = sha256(readFileSync(tarball));
  const objectSha256 = sha256(object);
  const report = {
    schema: 1,
    status: 'feasibility-only',
    result: 'pass',
    scope: 'compile-only; Arduino core/ESP-IDF linking and hardware execution are not proven',
    package: {
      name: packageJson.name,
      version: packageJson.version,
      file: portablePath(relative(artifactRoot, tarball)),
      sha256: packageSha256,
    },
    invocation: compilerArgs,
    target: {
      triple: lock.sdk.target,
      march: lock.sdk.march,
      abi: 'ilp32',
    },
    elf: {
      class: 'ELF32',
      endianness: 'little',
      type: 'ET_REL',
      machine: 'EM_RISCV',
      flags: `0x${elf.flags.toString(16).padStart(8, '0')}`,
      rvc: true,
      floatAbi: 'soft',
      size: object.byteLength,
      sha256: objectSha256,
    },
    compilerOutput: {
      stdout: decode(stdout),
      stderr: decode(stderr),
    },
  };
  writeFileSync(join(smokeDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeManifest(artifactRoot, lock, report);

  console.log(`PASS ${packageJson.name}@${packageJson.version}`);
  console.log(`PASS ELF32 RISC-V smoke object ${object.byteLength} bytes sha256=${objectSha256}`);
  console.log('NOTICE compile-only feasibility passed; firmware linking and browser routing remain disabled');
} finally {
  rmSync(installRoot, { recursive: true, force: true });
}

function inspectRiscvElf32(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 52) {
    throw new Error('smoke output is too short to be an ELF32 file');
  }
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new Error('smoke output has an invalid ELF magic');
  }
  if (bytes[4] !== 1) throw new Error(`expected ELFCLASS32, got ${bytes[4]}`);
  if (bytes[5] !== 1) throw new Error(`expected little-endian ELF, got ${bytes[5]}`);
  if (bytes[6] !== 1) throw new Error(`expected ELF version 1, got ${bytes[6]}`);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint16(16, true);
  const machine = view.getUint16(18, true);
  const version = view.getUint32(20, true);
  const flags = view.getUint32(36, true);
  const headerSize = view.getUint16(40, true);
  if (type !== 1) throw new Error(`expected ET_REL, got ELF type ${type}`);
  if (machine !== 243) throw new Error(`expected EM_RISCV, got ELF machine ${machine}`);
  if (version !== 1) throw new Error(`expected ELF version 1, got ${version}`);
  if (headerSize !== 52) throw new Error(`expected a 52-byte ELF32 header, got ${headerSize}`);
  if ((flags & 0x1) === 0) throw new Error('expected EF_RISCV_RVC for rv32imc');
  if ((flags & 0x6) !== 0) throw new Error(`expected the soft-float ILP32 ABI, got flags 0x${flags.toString(16)}`);
  if ((flags & 0x8) !== 0) throw new Error('unexpected EF_RISCV_RVE flag for ilp32');
  return { flags };
}

function writeManifest(directory, sourceLock, smokeReport) {
  const checksumPath = join(directory, 'SHA256SUMS');
  const manifestPath = join(directory, 'artifact-manifest.json');
  const files = listFiles(directory)
    .filter((path) => path !== checksumPath && path !== manifestPath)
    .map((path) => ({
      path: portablePath(relative(directory, path)),
      size: statSync(path).size,
      sha256: sha256(readFileSync(path)),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  writeFileSync(checksumPath, files.map((file) => `${file.sha256}  ${file.path}\n`).join(''));

  const manifest = {
    schema: 1,
    status: 'feasibility-only',
    activation: false,
    sourceLock,
    smoke: {
      result: smokeReport.result,
      scope: smokeReport.scope,
      report: 'smoke/report.json',
    },
    provenance: compact({
      repository: process.env.GITHUB_REPOSITORY,
      commit: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    }),
    files,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function runSelfTest() {
  const valid = new Uint8Array(52);
  valid.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  const view = new DataView(valid.buffer);
  view.setUint16(16, 1, true);
  view.setUint16(18, 243, true);
  view.setUint32(20, 1, true);
  view.setUint32(36, 1, true);
  view.setUint16(40, 52, true);
  inspectRiscvElf32(valid);

  const wrongMachine = valid.slice();
  new DataView(wrongMachine.buffer).setUint16(18, 3, true);
  expectFailure(() => inspectRiscvElf32(wrongMachine), 'EM_RISCV');
  const hardFloat = valid.slice();
  new DataView(hardFloat.buffer).setUint32(36, 0x3, true);
  expectFailure(() => inspectRiscvElf32(hardFloat), 'soft-float');
}

function expectFailure(fn, message) {
  try {
    fn();
  } catch (error) {
    if (String(error.message).includes(message)) return;
    throw error;
  }
  throw new Error(`expected verifier failure containing ${message}`);
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function capture(chunks) {
  return (bytes) => {
    if (bytes !== null && bytes !== undefined) chunks.push(Buffer.from(bytes));
  };
}

function decode(chunks) {
  return Buffer.concat(chunks).toString('utf8').trim();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function portablePath(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item));
}

function npmExecutable() {
  return 'npm';
}

function errorMessage(error) {
  return String(error?.message || error).trim().slice(0, 1024);
}
