/**
 * Acceptance smoke test for the experimental ESP32-C3 YoWASP artifact.
 *
 * This deliberately runs outside browser routing. It validates that a built
 * npm artifact can use its documented runClang API to compile and link an
 * rv32imc_zicsr_zifencei / ilp32 freestanding executable. A successful run is
 * only a compiler gate; SDK, Arduino-core, image, and hardware gates remain.
 */
import { spawn } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const EXPECTED_PACKAGE_NAME = '@arduinofast/esp32c3-clang-wasm';
const EXPECTED_ENTRY = './gen/bundle.js';
const TARGET = 'riscv32-esp-elf';
const MARCH = 'rv32imc_zicsr_zifencei';
const MABI = 'ilp32';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 10_000;
const MAX_ELF_BYTES = 32 * 1024 * 1024;

const ELF_HEADER_BYTES = 0x34;
const ELF_PROGRAM_HEADER_BYTES = 0x20;
const ELF_SECTION_HEADER_BYTES = 0x28;
const ELFCLASS32 = 1;
const ELFDATA2LSB = 1;
const EV_CURRENT = 1;
const ET_REL = 1;
const ET_EXEC = 2;
const EM_RISCV = 0xf3;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const PF_X = 1;
const SHT_PROGBITS = 1;
const SHT_RELA = 4;
const SHT_DYNAMIC = 6;
const SHT_NOBITS = 8;
const SHT_REL = 9;
const SHT_DYNSYM = 11;
const SHF_EXECINSTR = 0x4;
const EF_RISCV_RVC = 0x1;

const SMOKE_SOURCE = String.raw`#if !defined(__riscv) || (__riscv_xlen != 32)
#error "ESP32-C3 smoke source requires RV32"
#endif

#if !defined(__riscv_compressed)
#error "ESP32-C3 smoke source requires the C extension"
#endif

__attribute__((used, noinline, noreturn, section(".text._start")))
void _start(void) {
  __asm__ volatile(
    ".option push\n"
    ".option rvc\n"
    "c.nop\n"
    "csrr x0, mstatus\n"
    "fence.i\n"
    ".option pop\n"
    ::: "memory");
  for (;;) __asm__ volatile("nop" ::: "memory");
}
`;

const LINKER_SCRIPT = String.raw`OUTPUT_ARCH(riscv)
ENTRY(_start)
SECTIONS
{
  . = 0x42000000;
  .text : ALIGN(4) { KEEP(*(.text._start)) *(.text .text.*) }
  .rodata : ALIGN(4) { *(.rodata .rodata.*) }
  .data : ALIGN(4) { *(.data .data.*) }
  .bss (NOLOAD) : ALIGN(4) { *(.bss .bss.*) *(COMMON) }
  /DISCARD/ : { *(.comment) *(.note*) *(.eh_frame*) }
}
`;

/**
 * Run the artifact in a child Node process and validate its resulting ELF.
 * `artifactPath` may be an unpacked package, a package tarball, or a Docker
 * output directory containing exactly one package tarball in `dist/`.
 */
export async function smokeEsp32C3RiscvWasmArtifact(artifactPath, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) {
    throw new TypeError('ESP32-C3 RISC-V WASM smoke timeout must be between 1 second and 10 minutes');
  }

  const artifact = prepareArtifact(artifactPath);
  const runDirectory = mkdtempSync(join(tmpdir(), 'arduinofast-c3-wasm-smoke-'));
  const elfPath = join(runDirectory, 'smoke.elf');
  try {
    const metadata = validateArtifactPackage(artifact.packageDirectory);
    await runChildSmoke(artifact.packageDirectory, elfPath, timeoutMs);
    const elf = readOutputFile(elfPath, 'ESP32-C3 smoke ELF');
    const parsed = parseEsp32C3ExecutableElf(elf);
    return Object.freeze({
      artifactPath: artifact.displayPath,
      packageName: metadata.name,
      packageVersion: metadata.version,
      elfBytes: elf.byteLength,
      entry: parsed.entry,
      loadSegments: parsed.loadSegments.length,
      sections: parsed.sections.length,
      flags: parsed.flags,
    });
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
    artifact.cleanup();
  }
}

/**
 * Parse the executable emitted by the smoke test. This is intentionally
 * stricter than the browser image builder: it is an acceptance gate for the
 * exact RV32IMC soft-float profile, not a generic ELF reader.
 */
export function parseEsp32C3ExecutableElf(value) {
  const elf = parseElf32Riscv(value, ET_EXEC, 'ESP32-C3 executable ELF');
  if (elf.entry === 0) fail('ESP32-C3 executable ELF has a null entry point');
  if (elf.programHeaders.length === 0) fail('ESP32-C3 executable ELF has no program headers');

  const loadSegments = [];
  for (const header of elf.programHeaders) {
    if (header.type === PT_DYNAMIC || header.type === PT_INTERP) {
      fail('ESP32-C3 executable ELF is not freestanding');
    }
    if (header.type !== PT_LOAD) continue;
    if (header.memorySize === 0 || header.memorySize < header.fileSize) {
      fail('ESP32-C3 executable ELF has an invalid load segment size');
    }
    requireRange(elf.bytes.byteLength, header.offset, header.fileSize, 'ESP32-C3 load segment');
    if (header.align !== 0) {
      if (!isPowerOfTwo(header.align) || (header.virtualAddress % header.align) !== (header.offset % header.align)) {
        fail('ESP32-C3 executable ELF has an invalid load segment alignment');
      }
    }
    loadSegments.push(header);
  }
  if (loadSegments.length === 0) fail('ESP32-C3 executable ELF has no loadable segments');

  const entrySegment = loadSegments.find((segment) => (
    (segment.flags & PF_X) !== 0
    && elf.entry >= segment.virtualAddress
    && elf.entry < segment.virtualAddress + segment.memorySize
  ));
  if (!entrySegment) fail('ESP32-C3 executable ELF entry is outside an executable load segment');

  if (elf.sections.length === 0) fail('ESP32-C3 executable ELF has no section table');
  const text = elf.sections.find((section) => section.name === '.text');
  if (!text || text.type !== SHT_PROGBITS || (text.flags & SHF_EXECINSTR) === 0 || text.size === 0) {
    fail('ESP32-C3 executable ELF has no executable .text section');
  }
  if (elf.entry < text.address || elf.entry >= text.address + text.size) {
    fail('ESP32-C3 executable ELF entry is outside .text');
  }
  if (!loadSegments.some((segment) => (
    (segment.flags & PF_X) !== 0
    && text.address >= segment.virtualAddress
    && text.address + text.size <= segment.virtualAddress + segment.memorySize
  ))) {
    fail('ESP32-C3 executable .text section is not mapped by an executable segment');
  }
  for (const section of elf.sections) {
    if ([SHT_REL, SHT_RELA, SHT_DYNAMIC, SHT_DYNSYM].includes(section.type)) {
      fail('ESP32-C3 executable ELF retains dynamic or relocation sections');
    }
  }

  return Object.freeze({ ...elf, loadSegments: Object.freeze(loadSegments) });
}

/** Validate the intermediate object so a linker-only artifact cannot pass. */
export function parseEsp32C3RelocatableElf(value) {
  const elf = parseElf32Riscv(value, ET_REL, 'ESP32-C3 relocatable ELF');
  if (elf.entry !== 0 || elf.programHeaders.length !== 0) {
    fail('ESP32-C3 relocatable ELF has executable program-header state');
  }
  const executableSection = elf.sections.find((section) => (
    section.type === SHT_PROGBITS && (section.flags & SHF_EXECINSTR) !== 0 && section.size > 0
  ));
  if (!executableSection) fail('ESP32-C3 relocatable ELF has no executable code section');
  return elf;
}

function parseElf32Riscv(value, expectedType, label) {
  const bytes = ownBytes(value, label);
  if (bytes.byteLength < ELF_HEADER_BYTES || bytes.byteLength > MAX_ELF_BYTES) {
    fail(`${label} has an invalid size`);
  }
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    fail(`${label} has invalid ELF magic`);
  }
  if (bytes[4] !== ELFCLASS32 || bytes[5] !== ELFDATA2LSB || bytes[6] !== EV_CURRENT) {
    fail(`${label} is not ELF32 little-endian version 1`);
  }
  if (bytes[7] !== 0 || bytes[8] !== 0 || bytes.slice(9, 16).some((byte) => byte !== 0)) {
    fail(`${label} has an unsupported ELF ABI identification`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint16(16, true);
  const machine = view.getUint16(18, true);
  const version = view.getUint32(20, true);
  const entry = view.getUint32(24, true);
  const programOffset = view.getUint32(28, true);
  const sectionOffset = view.getUint32(32, true);
  const flags = view.getUint32(36, true);
  const headerSize = view.getUint16(40, true);
  const programEntrySize = view.getUint16(42, true);
  const programCount = view.getUint16(44, true);
  const sectionEntrySize = view.getUint16(46, true);
  const sectionCount = view.getUint16(48, true);
  const sectionNameIndex = view.getUint16(50, true);

  if (type !== expectedType || machine !== EM_RISCV || version !== EV_CURRENT || headerSize !== ELF_HEADER_BYTES) {
    fail(`${label} has an unexpected ELF header`);
  }
  validateRiscvFlags(flags, label);
  if (programCount === 0) {
    if (programOffset !== 0 || programEntrySize !== 0) fail(`${label} has invalid empty program headers`);
  } else {
    if (programEntrySize !== ELF_PROGRAM_HEADER_BYTES) fail(`${label} has invalid program-header size`);
    requireRange(bytes.byteLength, programOffset, programCount * ELF_PROGRAM_HEADER_BYTES, `${label} program headers`);
  }
  if (sectionCount === 0) {
    if (sectionOffset !== 0 || sectionEntrySize !== 0 || sectionNameIndex !== 0) {
      fail(`${label} has invalid empty section headers`);
    }
  } else {
    if (sectionEntrySize !== ELF_SECTION_HEADER_BYTES || sectionNameIndex >= sectionCount) {
      fail(`${label} has invalid section-header metadata`);
    }
    requireRange(bytes.byteLength, sectionOffset, sectionCount * ELF_SECTION_HEADER_BYTES, `${label} section headers`);
  }

  const programHeaders = [];
  for (let index = 0; index < programCount; index += 1) {
    const offset = programOffset + index * ELF_PROGRAM_HEADER_BYTES;
    programHeaders.push(Object.freeze({
      type: view.getUint32(offset, true),
      offset: view.getUint32(offset + 4, true),
      virtualAddress: view.getUint32(offset + 8, true),
      physicalAddress: view.getUint32(offset + 12, true),
      fileSize: view.getUint32(offset + 16, true),
      memorySize: view.getUint32(offset + 20, true),
      flags: view.getUint32(offset + 24, true),
      align: view.getUint32(offset + 28, true),
    }));
  }
  const sections = parseSections(bytes, view, sectionOffset, sectionCount, sectionNameIndex, label);
  return Object.freeze({
    bytes,
    type,
    entry,
    flags,
    programHeaders: Object.freeze(programHeaders),
    sections: Object.freeze(sections),
  });
}

function parseSections(bytes, view, sectionOffset, sectionCount, sectionNameIndex, label) {
  if (sectionCount === 0) return [];
  const raw = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionOffset + index * ELF_SECTION_HEADER_BYTES;
    const type = view.getUint32(offset + 4, true);
    const sectionOffsetInFile = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 20, true);
    if (type !== SHT_NOBITS) requireRange(bytes.byteLength, sectionOffsetInFile, size, `${label} section ${index}`);
    raw.push({
      nameOffset: view.getUint32(offset, true),
      type,
      flags: view.getUint32(offset + 8, true),
      address: view.getUint32(offset + 12, true),
      offset: sectionOffsetInFile,
      size,
      link: view.getUint32(offset + 24, true),
      info: view.getUint32(offset + 28, true),
      align: view.getUint32(offset + 32, true),
      entrySize: view.getUint32(offset + 36, true),
    });
  }
  const strings = raw[sectionNameIndex];
  if (!strings || strings.type !== 3 || strings.size === 0) {
    fail(`${label} has no valid section-name string table`);
  }
  const stringTable = bytes.slice(strings.offset, strings.offset + strings.size);
  return raw.map((section, index) => Object.freeze({
    ...section,
    name: sectionName(stringTable, section.nameOffset, `${label} section ${index}`),
  }));
}

function sectionName(table, offset, label) {
  if (offset >= table.byteLength) fail(`${label} name offset is outside the string table`);
  const end = table.indexOf(0, offset);
  if (end === -1) fail(`${label} name is not NUL terminated`);
  const name = new TextDecoder('utf-8', { fatal: true }).decode(table.slice(offset, end));
  if (name.includes('/') || name.includes('\\')) fail(`${label} name is invalid`);
  return name;
}

function validateRiscvFlags(flags, label) {
  if (flags !== EF_RISCV_RVC) {
    fail(`${label} is not rv32imc soft-float (unexpected RISC-V ELF flags 0x${flags.toString(16)})`);
  }
}

function prepareArtifact(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('ESP32-C3 RISC-V WASM artifact path is required');
  const path = resolve(value);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`ESP32-C3 RISC-V WASM artifact does not exist: ${path}`);
  }
  if (stat.isSymbolicLink()) fail('ESP32-C3 RISC-V WASM artifact path must not be a symbolic link');
  if (stat.isDirectory()) {
    const packageJson = join(path, 'package.json');
    if (isRegularFile(packageJson)) return artifactDirectory(path, path);
    return prepareTarball(findTarballInOutputDirectory(path));
  }
  if (!stat.isFile()) fail('ESP32-C3 RISC-V WASM artifact path must be a package directory or .tgz file');
  if (!isTarballPath(path)) fail('ESP32-C3 RISC-V WASM artifact file must end in .tgz or .tar.gz');
  return prepareTarball(path);
}

function artifactDirectory(packageDirectory, displayPath) {
  return Object.freeze({ packageDirectory, displayPath, cleanup() {} });
}

function findTarballInOutputDirectory(directory) {
  const candidates = [directory, join(directory, 'dist')]
    .filter((candidate) => {
      try { return lstatSync(candidate).isDirectory(); } catch { return false; }
    })
    .flatMap((candidate) => readdirSync(candidate, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isTarballPath(entry.name))
      .map((entry) => join(candidate, entry.name)));
  if (candidates.length !== 1) {
    fail('ESP32-C3 RISC-V WASM output directory must contain exactly one .tgz artifact');
  }
  return candidates[0];
}

function prepareTarball(tarballPath) {
  const tarball = readFileSync(tarballPath);
  if (tarball.byteLength === 0 || tarball.byteLength > MAX_ARTIFACT_BYTES) {
    fail('ESP32-C3 RISC-V WASM artifact tarball has an invalid size');
  }
  const extractionDirectory = mkdtempSync(join(tmpdir(), 'arduinofast-c3-wasm-package-'));
  try {
    extractNpmTarball(tarball, extractionDirectory);
    const packageDirectory = join(extractionDirectory, 'package');
    if (!isRegularFile(join(packageDirectory, 'package.json'))) {
      fail('ESP32-C3 RISC-V WASM artifact tarball has no package/package.json');
    }
    return Object.freeze({
      packageDirectory,
      displayPath: resolve(tarballPath),
      cleanup() { rmSync(extractionDirectory, { recursive: true, force: true }); },
    });
  } catch (error) {
    rmSync(extractionDirectory, { recursive: true, force: true });
    throw error;
  }
}

function extractNpmTarball(compressed, destination) {
  let archive;
  try {
    archive = gunzipSync(compressed, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    fail('ESP32-C3 RISC-V WASM artifact is not a valid gzip tarball within the size limit');
  }
  const seenPaths = new Set();
  let totalBytes = 0;
  let fileCount = 0;
  for (let offset = 0; offset < archive.byteLength;) {
    if (offset + 512 > archive.byteLength) fail('ESP32-C3 RISC-V WASM artifact tarball has a truncated header');
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!archive.subarray(offset).every((byte) => byte === 0)) fail('ESP32-C3 RISC-V WASM artifact tarball has trailing data');
      return;
    }
    const size = parseTarOctal(header.subarray(124, 136));
    const type = header[156] || 0x30;
    const prefix = tarString(header.subarray(345, 500));
    const name = tarString(header.subarray(0, 100));
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const target = tarTarget(destination, archivePath);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.byteLength) fail('ESP32-C3 RISC-V WASM artifact tarball has a truncated entry');
    if (type === 0x30 || type === 0) {
      if (seenPaths.has(archivePath)) fail('ESP32-C3 RISC-V WASM artifact tarball has duplicate entries');
      seenPaths.add(archivePath);
      fileCount += 1;
      totalBytes += size;
      if (fileCount > MAX_ARCHIVE_FILES || totalBytes > MAX_UNPACKED_BYTES) {
        fail('ESP32-C3 RISC-V WASM artifact tarball exceeds extraction limits');
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, archive.subarray(dataStart, dataEnd), { flag: 'wx' });
    } else if (type === 0x35) {
      mkdirSync(target, { recursive: true });
    } else {
      fail('ESP32-C3 RISC-V WASM artifact tarball contains an unsupported entry type');
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  fail('ESP32-C3 RISC-V WASM artifact tarball has no terminator');
}

function tarTarget(destination, archivePath) {
  if (!archivePath.startsWith('package/') || archivePath.includes('\\') || archivePath.includes('\0')) {
    fail('ESP32-C3 RISC-V WASM artifact tarball has an unsafe path');
  }
  const segments = archivePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail('ESP32-C3 RISC-V WASM artifact tarball has an unsafe path');
  }
  const target = resolve(destination, ...segments);
  if (!isInside(destination, target)) fail('ESP32-C3 RISC-V WASM artifact tarball escapes its extraction directory');
  return target;
}

function parseTarOctal(bytes) {
  const text = tarString(bytes).trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) fail('ESP32-C3 RISC-V WASM artifact tarball has an invalid entry size');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail('ESP32-C3 RISC-V WASM artifact tarball has an invalid entry size');
  return value;
}

function tarString(bytes) {
  const end = bytes.indexOf(0);
  const content = end === -1 ? bytes : bytes.subarray(0, end);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    fail('ESP32-C3 RISC-V WASM artifact tarball has invalid UTF-8 metadata');
  }
}

function validateArtifactPackage(packageDirectory) {
  const packageJsonPath = join(packageDirectory, 'package.json');
  if (!isRegularFile(packageJsonPath)) fail('ESP32-C3 RISC-V WASM artifact package.json must be a regular file');
  let value;
  try {
    value = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    fail('ESP32-C3 RISC-V WASM artifact package.json is invalid JSON');
  }
  if (!isRecord(value) || value.name !== EXPECTED_PACKAGE_NAME || value.type !== 'module' || !validVersion(value.version)) {
    fail('ESP32-C3 RISC-V WASM artifact package metadata is unexpected');
  }
  if (!isRecord(value.exports) || value.exports.default !== EXPECTED_ENTRY) {
    fail('ESP32-C3 RISC-V WASM artifact does not expose the expected YoWASP API entry');
  }
  const entry = resolve(packageDirectory, value.exports.default);
  if (!isInside(packageDirectory, entry) || !isRegularFile(entry)) {
    fail('ESP32-C3 RISC-V WASM artifact API entry is missing or unsafe');
  }
  return Object.freeze({ name: value.name, version: value.version, entry });
}

async function runChildSmoke(packageDirectory, elfPath, timeoutMs) {
  const childArgs = [SCRIPT_PATH, '--child', '--package-dir', packageDirectory, '--elf-out', elfPath];
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, childArgs, {
      cwd: process.cwd(),
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const output = createOutputCapture();
    child.stdout.on('data', (chunk) => output.push('stdout', chunk));
    child.stderr.on('data', (chunk) => output.push('stderr', chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectPromise(new Error(`could not start ESP32-C3 RISC-V WASM smoke process: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(new Error(`ESP32-C3 RISC-V WASM smoke exceeded ${timeoutMs} ms`));
      } else if (code !== 0) {
        const detail = output.text();
        rejectPromise(new Error(`ESP32-C3 RISC-V WASM artifact smoke failed (${signal ?? `exit ${code}`})${detail ? `:\n${detail}` : ''}`));
      } else {
        resolvePromise();
      }
    });
  });
}

function createOutputCapture() {
  const chunks = [];
  let total = 0;
  let truncated = false;
  return {
    push(kind, value) {
      if (total >= MAX_CHILD_OUTPUT_BYTES) { truncated = true; return; }
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = MAX_CHILD_OUTPUT_BYTES - total;
      chunks.push(Buffer.concat([Buffer.from(`${kind}: `), bytes.subarray(0, remaining), Buffer.from('\n')]));
      total += Math.min(bytes.byteLength, remaining);
      if (bytes.byteLength > remaining) truncated = true;
    },
    text() {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      return `${text}${truncated ? '\n[child output truncated]' : ''}`.slice(-MAX_CHILD_OUTPUT_BYTES);
    },
  };
}

async function childMain(argumentsList) {
  const options = parseChildArguments(argumentsList);
  const metadata = validateArtifactPackage(options.packageDirectory);
  const module = await import(`${pathToFileURL(metadata.entry).href}?esp32c3-smoke=${Date.now()}`);
  if (typeof module.runClang !== 'function') {
    fail('ESP32-C3 RISC-V WASM artifact does not export the YoWASP runClang API');
  }
  const files = { 'smoke.c': SMOKE_SOURCE, 'smoke.ld': LINKER_SCRIPT };
  const compiled = await invokeRunClang(module.runClang, [
    'clang',
    `--target=${TARGET}`,
    `-march=${MARCH}`,
    `-mabi=${MABI}`,
    '-ffreestanding',
    '-fno-builtin',
    '-fno-pic',
    '-fno-stack-protector',
    '-fno-unwind-tables',
    '-fno-asynchronous-unwind-tables',
    '-ffunction-sections',
    '-fdata-sections',
    '-c',
    'smoke.c',
    '-o',
    'smoke.o',
  ], files, 'compile');
  const object = treeFile(compiled, 'smoke.o', 'compile');
  parseEsp32C3RelocatableElf(object);

  const linked = await invokeRunClang(module.runClang, [
    'clang',
    `--target=${TARGET}`,
    `-march=${MARCH}`,
    `-mabi=${MABI}`,
    '-nostdlib',
    // The YoWASP RISC-V driver already selects its embedded LLD. Supplying
    // -fuse-ld=lld is rejected as an invalid linker name for this target.
    '-Wl,--no-undefined',
    '-Wl,--gc-sections',
    '-Wl,--build-id=none',
    '-Wl,-e,_start',
    '-Wl,-T,smoke.ld',
    '-o',
    'smoke.elf',
    'smoke.o',
  ], { ...compiled, 'smoke.ld': LINKER_SCRIPT }, 'link');
  const elf = treeFile(linked, 'smoke.elf', 'link');
  parseEsp32C3ExecutableElf(elf);
  mkdirSync(dirname(options.elfOut), { recursive: true });
  writeFileSync(options.elfOut, elf, { flag: 'wx' });
}

async function invokeRunClang(runClang, args, files, phase) {
  const logs = createCompilerLogCapture();
  let result;
  try {
    result = await runClang(args, files, {
      stdout: (bytes) => logs.push('stdout', bytes),
      stderr: (bytes) => logs.push('stderr', bytes),
    });
  } catch (error) {
    const detail = logs.text();
    fail(`ESP32-C3 RISC-V WASM ${phase} API call failed: ${errorMessage(error)}${detail ? `\n${detail}` : ''}`);
  }
  if (!isRecord(result)) fail(`ESP32-C3 RISC-V WASM ${phase} API returned no virtual file tree`);
  return result;
}

function createCompilerLogCapture() {
  const chunks = [];
  let total = 0;
  return {
    push(kind, bytes) {
      if (bytes === null || total >= MAX_CHILD_OUTPUT_BYTES) return;
      if (!(bytes instanceof Uint8Array)) return;
      const available = Math.min(bytes.byteLength, MAX_CHILD_OUTPUT_BYTES - total);
      chunks.push(new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, available)));
      total += available;
    },
    text() { return chunks.join('').trim().slice(-MAX_CHILD_OUTPUT_BYTES); },
  };
}

function treeFile(tree, name, phase) {
  const value = tree[name];
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_ELF_BYTES) {
    fail(`ESP32-C3 RISC-V WASM ${phase} API did not produce a bounded ${name}`);
  }
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function parseChildArguments(args) {
  if (args.length !== 4 || args[0] !== '--package-dir' || args[2] !== '--elf-out') {
    fail('invalid internal ESP32-C3 RISC-V WASM smoke arguments');
  }
  const packageDirectory = resolve(args[1]);
  const elfOut = resolve(args[3]);
  if (!isAbsolute(packageDirectory) || !isAbsolute(elfOut)) fail('internal smoke paths must be absolute');
  return { packageDirectory, elfOut };
}

function readOutputFile(path, label) {
  if (!isRegularFile(path)) fail(`${label} was not written`);
  const bytes = readFileSync(path);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ELF_BYTES) fail(`${label} has an invalid size`);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ownBytes(value, label) {
  if (!(value instanceof Uint8Array)) fail(`${label} must be Uint8Array bytes`);
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function requireRange(total, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > total || length > total - offset) {
    fail(`${label} is outside the ELF file`);
  }
}

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

function isRegularFile(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isTarballPath(path) {
  const lower = basename(path).toLowerCase();
  return lower.endsWith('.tgz') || lower.endsWith('.tar.gz');
}

function isInside(root, candidate) {
  const path = relative(resolve(root), resolve(candidate));
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

function validVersion(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\0\r\n]/.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error) {
  return String(error?.message ?? error ?? 'unknown error').trim().slice(0, 8 * 1024);
}

function fail(message) {
  throw new Error(message);
}

async function main(args) {
  if (args[0] === '--child') {
    await childMain(args.slice(1));
    return;
  }
  if (args.length !== 1 || args[0].startsWith('-')) {
    throw new Error('Usage: node scripts/smoke-esp32c3-riscv-wasm.mjs <artifact-path>');
  }
  const result = await smokeEsp32C3RiscvWasmArtifact(args[0]);
  console.log(`PASS ESP32-C3 RISC-V WASM ${result.packageName}@${result.packageVersion}: ${result.elfBytes} byte ELF, ${result.loadSegments} load segment(s)`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
