/**
 * Host-side acceptance gate for an experimental ESP32-C3 YoWASP artifact.
 *
 * The candidate compiler runs only through its documented runClang() API. It
 * compiles an Arduino.h C++ sketch, links that object with a real Arduino-ESP32
 * 3.3.7 C3 core, ESP-IDF archives, linker scripts, and GCC runtime archives,
 * then requires the browser image writer to match host esptool byte-for-byte.
 *
 * This is deliberately not a browser route or release activation. It consumes
 * a local artifact directory produced by the feasibility workflow.
 *
 * Usage:
 *   npx tsx scripts/verify-esp32c3-riscv-wasm-arduino-sdk.ts <artifact-directory> [--flash-port COM13]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SerialPort } from 'serialport';
import { LocalExecutor } from '../packages/core/src/sandbox/local.js';
import { applyOptions, BoardRegistry, resolveOptions } from '../packages/core/src/toolchain/board.js';
import { detectLocalToolchain } from '../packages/core/src/toolchain/config.js';
import { Esp32Toolchain, resolveEsp32BuildProfile } from '../packages/core/src/toolchain/esp32.js';
import { buildEsp32C3Image } from '../packages/web/browser-esp32/image-builder.js';
import { flashEsp32 } from '../packages/web/public/esp32flash.js';
import {
  ESP32C3_GCC_INTEGER_ABI_FLAGS,
  makeEsp32C3LldCompatibleInputs,
  makeEsp32C3WasmCompatibleCppFlags,
} from './esp32c3-lld-compat.js';
import { NodeWebSerialPort } from './node-web-serial-port.mjs';

const FQBN = 'esp32:esp32:esp32c3';
const EXPECTED_SDK_VERSION = '3.3.7';
const EXPECTED_PACKAGE = '@arduinofast/esp32c3-clang-wasm';
const ARDUINO_VERSION_DEFINE = '10607';
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
const MAX_COMPILER_OUTPUT = 256 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_VFS_FILES = 10_000;
const MAX_VFS_FILE_BYTES = 64 * 1024 * 1024;
const MAX_VFS_TOTAL_BYTES = 384 * 1024 * 1024;
const MAX_ELF_BYTES = 64 * 1024 * 1024;

const MINIMAL_SKETCH = `#include <Arduino.h>

template <unsigned IntervalMs>
struct BlinkInterval {
  static constexpr unsigned value = IntervalMs;
};

static_assert(BlinkInterval<20>::value == 20);

void setup() {
  pinMode(8, OUTPUT);
}

void loop() {
  digitalWrite(8, HIGH);
  delay(BlinkInterval<20>::value);
  digitalWrite(8, LOW);
  delay(BlinkInterval<20>::value);
}
`;

function serialSketch(stamp: string): string {
  return `#include <Arduino.h>

const char* const kWasmStamp = "${stamp}";

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.print("BOOT ");
  Serial.println(kWasmStamp);
}

void loop() {
  Serial.println(kWasmStamp);
  delay(400);
}
`;
}

type VfsTree = { [name: string]: VfsTree | string | Uint8Array };
type RunClang = (
  args: string[],
  files: VfsTree,
  options: {
    stdout?: (bytes: Uint8Array | null) => void;
    stderr?: (bytes: Uint8Array | null) => void;
  },
) => Promise<VfsTree>;

type RuntimeLibraryDirectory = Readonly<{
  source: string;
  virtual: string;
}>;

type RuntimeInputs = Readonly<{
  cxxInclude: string;
  gccInclude: string;
  gccIncludeFixed: string;
  sysrootInclude: string;
  cxxVirtualRoot: string;
  gccIncludeVirtual: string;
  gccIncludeFixedVirtual: string;
  sysrootIncludeVirtual: string;
  libraryDirectories: readonly RuntimeLibraryDirectory[];
}>;

type InstalledCandidate = Readonly<{
  packageDirectory: string;
  tarball: string;
  cleanup: () => void;
}>;

function usage(): never {
  throw new Error('usage: npx tsx scripts/verify-esp32c3-riscv-wasm-arduino-sdk.ts <artifact-directory> [--flash-port COM13]');
}

function parseArgs(args: string[]): { artifactDirectory?: string; flashPort?: string; help: boolean } {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length !== 1 && args.length !== 3) usage();
  const [artifactDirectory, option, flashPort] = args;
  if (!artifactDirectory || artifactDirectory.startsWith('-')) usage();
  if (args.length === 3 && (option !== '--flash-port' || !flashPort || flashPort.startsWith('-'))) usage();
  return { artifactDirectory: resolve(artifactDirectory), flashPort, help: false };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function verificationToolchainIdentity(paths: string[]): string {
  const hash = createHash('sha256').update('browser-esp32c3-riscv-wasm-arduino-sdk-v1\0');
  for (const path of paths) {
    hash.update(path).update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function ensureWorkspaceChild(root: string, child: string): void {
  const relativeChild = relative(root, child);
  if (
    !relativeChild
    || relativeChild === '..'
    || relativeChild.startsWith(`..${sep}`)
    || resolve(root, relativeChild) !== child
  ) {
    throw new Error(`refusing to remove a path outside the workspace: ${child}`);
  }
}

function executable(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function run(command: string, args: string[], cwd: string, label: string, timeout = 180_000): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: MAX_COMMAND_OUTPUT,
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status ?? 'unknown'}:\n${output}`.trim());
  }
  return output;
}

function requireRegularFile(path: string, label: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${path}`);
}

function requireDirectory(path: string, label: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a directory: ${path}`);
}

function sourceLock(root: string): { target: string; march: string } {
  const path = join(root, 'toolchains', 'esp32c3-riscv-wasm', 'source-lock.json');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`could not read ESP32-C3 source lock: ${path}`);
  }
  const sdk = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { sdk?: unknown }).sdk
    : undefined;
  if (!sdk || typeof sdk !== 'object' || Array.isArray(sdk)) {
    throw new Error('ESP32-C3 source lock has no SDK target');
  }
  const target = (sdk as { target?: unknown }).target;
  const march = (sdk as { march?: unknown }).march;
  if (target !== 'riscv32-esp-elf' || march !== 'rv32imc_zicsr_zifencei') {
    throw new Error('ESP32-C3 source lock has an unexpected RISC-V target');
  }
  return { target, march };
}

function resolveRuntimeInputs(gpp: string, toolchainRoot: string, cwd: string): RuntimeInputs {
  const version = run(gpp, ['-dumpfullversion', '-dumpversion'], cwd, 'read Espressif GCC version', 30_000)
    .trim()
    .split(/\r?\n/)
    .find(Boolean);
  if (!version || !/^\d+(?:\.\d+){1,3}$/.test(version)) {
    throw new Error(`Espressif GCC returned an invalid version: ${version ?? 'none'}`);
  }

  const cxxInclude = join(toolchainRoot, 'riscv32-esp-elf', 'include', 'c++', version);
  const gccInclude = join(toolchainRoot, 'lib', 'gcc', 'riscv32-esp-elf', version, 'include');
  const gccIncludeFixed = join(toolchainRoot, 'lib', 'gcc', 'riscv32-esp-elf', version, 'include-fixed');
  const sysrootInclude = join(toolchainRoot, 'riscv32-esp-elf', 'include');
  requireDirectory(cxxInclude, 'Espressif libstdc++ headers');
  requireDirectory(gccInclude, 'Espressif GCC headers');
  requireDirectory(gccIncludeFixed, 'Espressif GCC fixed headers');
  requireDirectory(sysrootInclude, 'Espressif newlib headers');

  const libraries = ['libgcc.a', 'libstdc++.a', 'libc.a', 'libm.a'];
  const libraryPaths = libraries.map((library) => {
    const path = run(gpp, [`-print-file-name=${library}`], cwd, `find ${library}`, 30_000).trim();
    if (!path || path === library) throw new Error(`Espressif GCC did not locate ${library}`);
    requireRegularFile(path, `Espressif runtime ${library}`);
    return path;
  });
  if (new Set(libraryPaths.map((path) => basename(path))).size !== libraries.length) {
    throw new Error('Espressif runtime library names are unexpectedly duplicated');
  }

  const libraryDirectories: RuntimeLibraryDirectory[] = [];
  for (const path of libraryPaths) {
    const source = resolve(dirname(path));
    requireDirectory(source, 'Espressif runtime archive directory');
    if (libraryDirectories.some((directory) => directory.source === source)) continue;
    libraryDirectories.push(Object.freeze({
      source,
      virtual: `runtime/lib/${libraryDirectories.length}`,
    }));
  }

  return Object.freeze({
    cxxInclude,
    gccInclude,
    gccIncludeFixed,
    sysrootInclude,
    cxxVirtualRoot: `runtime/include/c++/${version}`,
    gccIncludeVirtual: 'runtime/gcc/include',
    gccIncludeFixedVirtual: 'runtime/gcc/include-fixed',
    sysrootIncludeVirtual: 'runtime/sysroot/include',
    libraryDirectories: Object.freeze(libraryDirectories),
  });
}

class VfsBuilder {
  readonly tree: VfsTree = {};
  private files = 0;
  private totalBytes = 0;

  addText(destination: string, value: string): void {
    this.addBytes(destination, new TextEncoder().encode(value));
  }

  addFile(source: string, destination: string): void {
    requireRegularFile(source, 'VFS input');
    const size = lstatSync(source).size;
    if (size > MAX_VFS_FILE_BYTES) {
      throw new Error(`VFS input exceeds the per-file limit: ${source}`);
    }
    this.addBytes(destination, readFileSync(source));
  }

  addDirectory(source: string, destination: string, { excludeRootEntries = [] }: {
    excludeRootEntries?: readonly string[];
  } = {}): void {
    requireDirectory(source, 'VFS input directory');
    const excluded = new Set(excludeRootEntries);
    const walk = (current: string, virtualPath: string, isRoot: boolean) => {
      const entries = readdirSync(current, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (isRoot && excluded.has(entry.name)) continue;
        const path = join(current, entry.name);
        const childVirtualPath = `${virtualPath}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error(`VFS input must not contain symbolic links: ${path}`);
        if (entry.isDirectory()) {
          walk(path, childVirtualPath, false);
        } else if (entry.isFile()) {
          this.addFile(path, childVirtualPath);
        } else {
          throw new Error(`VFS input has an unsupported entry type: ${path}`);
        }
      }
    };
    walk(source, destination, true);
  }

  addTopLevelArchives(source: string, destination: string): void {
    requireDirectory(source, 'VFS runtime archive directory');
    let copied = 0;
    const entries = readdirSync(source, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.name.endsWith('.a')) continue;
      const path = join(source, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`VFS runtime archive must not be a symbolic link: ${path}`);
      }
      if (!entry.isFile()) {
        throw new Error(`VFS runtime archive must be a regular file: ${path}`);
      }
      this.addFile(path, `${destination}/${entry.name}`);
      copied++;
    }
    if (copied === 0) throw new Error(`VFS runtime archive directory has no .a files: ${source}`);
  }

  summary(): Readonly<{ files: number; bytes: number }> {
    return Object.freeze({ files: this.files, bytes: this.totalBytes });
  }

  private addBytes(destination: string, bytes: Uint8Array): void {
    if (!(bytes instanceof Uint8Array)) throw new TypeError(`VFS input is not bytes: ${destination}`);
    if (bytes.byteLength > MAX_VFS_FILE_BYTES) {
      throw new Error(`VFS input exceeds the per-file limit: ${destination}`);
    }
    if (++this.files > MAX_VFS_FILES) throw new Error(`VFS input exceeds ${MAX_VFS_FILES} files`);
    this.totalBytes += bytes.byteLength;
    if (this.totalBytes > MAX_VFS_TOTAL_BYTES) {
      throw new Error(`VFS input exceeds ${MAX_VFS_TOTAL_BYTES} bytes`);
    }

    const segments = destination.split('/');
    if (!segments.length || segments.some((segment) => !/^[A-Za-z0-9._+-]+$/.test(segment) || segment === '.' || segment === '..')) {
      throw new Error(`VFS destination is invalid: ${destination}`);
    }
    const leaf = segments.pop()!;
    let directory = this.tree;
    for (const segment of segments) {
      const current = directory[segment];
      if (current === undefined) {
        const created: VfsTree = {};
        directory[segment] = created;
        directory = created;
      } else if (typeof current === 'string' || current instanceof Uint8Array) {
        throw new Error(`VFS destination conflicts with a file: ${destination}`);
      } else {
        directory = current;
      }
    }
    if (Object.hasOwn(directory, leaf)) throw new Error(`VFS destination is duplicated: ${destination}`);
    directory[leaf] = bytes;
  }
}

function createC3Inputs({
  sdkRoot,
  coreDir,
  variantDir,
  coreArchive,
  runtime,
  compatibility,
  memoryType,
  sketchSource,
}: {
  sdkRoot: string;
  coreDir: string;
  variantDir: string;
  coreArchive: string;
  runtime: RuntimeInputs;
  compatibility: ReturnType<typeof makeEsp32C3LldCompatibleInputs>;
  memoryType: string;
  sketchSource: string;
}): Readonly<{ files: VfsTree; fileCount: number; inputBytes: number }> {
  const builder = new VfsBuilder();
  const cppFlagsPath = join(sdkRoot, 'flags', 'cpp_flags');
  requireRegularFile(cppFlagsPath, 'ESP32-C3 cpp_flags');
  builder.addText('sketch.cpp', sketchSource);
  builder.addDirectory(join(sdkRoot, 'flags'), 'sdk/flags', { excludeRootEntries: ['cpp_flags'] });
  builder.addText('sdk/flags/cpp_flags', makeEsp32C3WasmCompatibleCppFlags(readFileSync(cppFlagsPath, 'utf8')));
  builder.addDirectory(join(sdkRoot, 'include'), 'sdk/include');
  builder.addDirectory(join(sdkRoot, 'lib'), 'sdk/lib');
  builder.addDirectory(join(sdkRoot, 'ld'), 'sdk/ld');
  builder.addDirectory(join(sdkRoot, memoryType), `sdk/${memoryType}`);
  builder.addDirectory(coreDir, 'core');
  builder.addDirectory(variantDir, 'variant');
  builder.addDirectory(runtime.cxxInclude, runtime.cxxVirtualRoot);
  builder.addDirectory(runtime.gccInclude, runtime.gccIncludeVirtual);
  builder.addDirectory(runtime.gccIncludeFixed, runtime.gccIncludeFixedVirtual);
  // libstdc++ headers are mounted separately above; avoid a duplicate copy
  // through the GCC sysroot while keeping all newlib and machine headers.
  builder.addDirectory(runtime.sysrootInclude, runtime.sysrootIncludeVirtual, { excludeRootEntries: ['c++'] });
  for (const directory of runtime.libraryDirectories) {
    builder.addTopLevelArchives(directory.source, directory.virtual);
  }
  builder.addFile(coreArchive, 'core.a');
  builder.addText('sdk/lld-compat/ld_flags', compatibility.ldFlags);
  builder.addText('sdk/lld-compat/memory.ld', compatibility.memoryLd);
  builder.addText('sdk/lld-compat/sections.ld', compatibility.sectionsLd);
  const summary = builder.summary();
  return Object.freeze({ files: builder.tree, fileCount: summary.files, inputBytes: summary.bytes });
}

function boardDefines(
  board: ReturnType<typeof applyOptions>,
  profile: ReturnType<typeof resolveEsp32BuildProfile>,
): string[] {
  const profileDefines = profile.defines.map((define) => `-D${define}`);
  const profileFlags = [...profileDefines, ...profile.compilerFlags];
  if (profileFlags.some((flag) => {
    const definition = flag.startsWith('-D') ? flag.slice(2) : flag;
    return definition === 'ESP32' || definition.startsWith('ESP32=');
  })) {
    throw new Error('ESP32 build profile unexpectedly defines the pinned ESP32 platform macro');
  }
  return [
    `-DF_CPU=${profile.fCpu}`,
    `-DARDUINO=${ARDUINO_VERSION_DEFINE}`,
    `-DARDUINO_${board.build.boardDefine ?? 'ESP32_DEV'}`,
    '-DARDUINO_ARCH_ESP32',
    `-DARDUINO_BOARD="${board.build.boardDefine ?? 'ESP32_DEV'}"`,
    `-DARDUINO_VARIANT="${board.build.variant}"`,
    `-DARDUINO_PARTITION_${profile.partitions}`,
    '-DESP32=ESP32',
    ...profileFlags,
  ];
}

function cxxCompileArgs(
  board: ReturnType<typeof applyOptions>,
  profile: ReturnType<typeof resolveEsp32BuildProfile>,
  target: string,
  march: string,
  runtime: RuntimeInputs,
  memoryType: string,
): string[] {
  if (board.build.tarch !== 'riscv32') throw new Error(`expected C3 RISC-V board, got ${board.build.tarch}`);
  return [
    'clang++',
    `--target=${target}`,
    `-march=${march}`,
    '-mabi=ilp32',
    ...ESP32C3_GCC_INTEGER_ABI_FLAGS,
    '-MMD',
    '-c',
    '@sdk/flags/cpp_flags',
    '-Wall',
    '-Os',
    '-Werror=return-type',
    ...boardDefines(board, profile),
    '@sdk/flags/defines',
    '-iprefix',
    'sdk/include/',
    '@sdk/flags/includes',
    `-Isdk/${memoryType}/include`,
    '-Icore',
    '-Ivariant',
    '-nostdinc++',
    '-isystem', runtime.cxxVirtualRoot,
    '-isystem', `${runtime.cxxVirtualRoot}/riscv32-esp-elf`,
    '-isystem', `${runtime.cxxVirtualRoot}/backward`,
    '-isystem', runtime.gccIncludeVirtual,
    '-isystem', runtime.gccIncludeFixedVirtual,
    '-isystem', runtime.sysrootIncludeVirtual,
    'sketch.cpp',
    '-o', 'sketch.o',
  ];
}

function lldLinkArgs(
  board: ReturnType<typeof applyOptions>,
  profile: ReturnType<typeof resolveEsp32BuildProfile>,
  target: string,
  march: string,
  runtime: RuntimeInputs,
  memoryType: string,
): string[] {
  if (board.build.tarch !== 'riscv32') throw new Error(`expected C3 RISC-V board, got ${board.build.tarch}`);
  return [
    'clang++',
    `--target=${target}`,
    `-march=${march}`,
    '-mabi=ilp32',
    '-nostdlib',
    // YoWASP's RISC-V driver selects embedded LLD itself and rejects
    // -fuse-ld=lld as an invalid linker name for this target.
    '-Wl,--Map=firmware.map',
    '-Lsdk/lib',
    '-Lsdk/lld-compat',
    '-Lsdk/ld',
    `-Lsdk/${memoryType}`,
    ...runtime.libraryDirectories.flatMap((directory) => [`-L${directory.virtual}`]),
    '-Wl,--wrap=esp_panic_handler',
    '@sdk/lld-compat/ld_flags',
    '@sdk/flags/ld_scripts',
    '-Wl,--start-group',
    'sketch.o',
    'core.a',
    '@sdk/flags/ld_libs',
    ...profile.linkerFlags,
    '-Wl,--end-group',
    '-Wl,-EL',
    '-o', 'firmware.elf',
  ];
}

async function invokeRunClang(
  runClang: RunClang,
  args: string[],
  files: VfsTree,
  phase: string,
): Promise<VfsTree> {
  const logs = compilerLogCapture();
  try {
    const output = await runClang(args, files, {
      stdout: (bytes) => logs.push('stdout', bytes),
      stderr: (bytes) => logs.push('stderr', bytes),
    });
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      throw new Error('runClang returned no virtual file tree');
    }
    return output;
  } catch (error) {
    const detail = logs.text();
    throw new Error(`ESP32-C3 WASM ${phase} failed: ${errorMessage(error)}${detail ? `\n${detail}` : ''}`);
  }
}

function compilerLogCapture() {
  const chunks: string[] = [];
  let total = 0;
  return {
    push(kind: string, bytes: Uint8Array | null): void {
      if (!(bytes instanceof Uint8Array) || total >= MAX_COMPILER_OUTPUT) return;
      const length = Math.min(bytes.byteLength, MAX_COMPILER_OUTPUT - total);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, length));
      if (text) chunks.push(`${kind}: ${text}`);
      total += length;
    },
    text(): string {
      const text = chunks.join('').trim();
      return `${text}${total >= MAX_COMPILER_OUTPUT ? '\n[compiler output truncated]' : ''}`;
    },
  };
}

function treeFile(tree: VfsTree, path: string, label: string): Uint8Array {
  const segments = path.split('/');
  let value: VfsTree | string | Uint8Array = tree;
  for (const segment of segments) {
    if (!value || typeof value !== 'object' || value instanceof Uint8Array || !Object.hasOwn(value, segment)) {
      throw new Error(`${label} is missing from the WASM virtual filesystem: ${path}`);
    }
    value = value[segment]!;
  }
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_ELF_BYTES) {
    throw new Error(`${label} is not bounded binary output: ${path}`);
  }
  return new Uint8Array(value);
}

function putTreeFile(tree: VfsTree, path: string, bytes: Uint8Array): void {
  const segments = path.split('/');
  const leaf = segments.pop();
  if (!leaf) throw new Error(`invalid internal VFS path: ${path}`);
  let directory = tree;
  for (const segment of segments) {
    const value = directory[segment];
    if (value === undefined) {
      const created: VfsTree = {};
      directory[segment] = created;
      directory = created;
    } else if (typeof value === 'string' || value instanceof Uint8Array) {
      throw new Error(`internal VFS path conflicts with a file: ${path}`);
    } else {
      directory = value;
    }
  }
  if (Object.hasOwn(directory, leaf)) throw new Error(`internal VFS output already exists: ${path}`);
  directory[leaf] = bytes;
}

function assertRiscvElf32(bytes: Uint8Array, expectedType: number, label: string): void {
  if (bytes.byteLength < 52 || bytes.byteLength > MAX_ELF_BYTES) {
    throw new Error(`${label} has an invalid ELF size`);
  }
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new Error(`${label} is not an ELF file`);
  }
  if (bytes[4] !== 1 || bytes[5] !== 1 || bytes[6] !== 1) {
    throw new Error(`${label} is not ELF32 little-endian version 1`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(16, true) !== expectedType || view.getUint16(18, true) !== 243) {
    throw new Error(`${label} is not the expected ELF32 EM_RISCV type`);
  }
  const flags = view.getUint32(36, true);
  if ((flags & 0x1) === 0 || (flags & 0x6) !== 0 || (flags & 0x8) !== 0) {
    throw new Error(`${label} has an unexpected C3 RISC-V ABI flag set: 0x${flags.toString(16)}`);
  }
  if (expectedType === 2 && view.getUint32(24, true) === 0) {
    throw new Error(`${label} has a null executable entry point`);
  }
}

function runEsptool(
  command: string,
  elfPath: string,
  outputPath: string,
  chip: string,
  flashMode: string,
  flashFrequency: string,
  flashSize: string,
  cwd: string,
): void {
  run(command, [
    '--chip', chip,
    'elf2image',
    '--flash-mode', flashMode,
    '--flash-freq', flashFrequency,
    '--flash-size', flashSize,
    '--elf-sha256-offset', '0xb0',
    '-o', outputPath,
    elfPath,
  ], cwd, 'esptool elf2image', 60_000);
}

function inlineArtifact(name: string, offset: string, bytes: Uint8Array) {
  return {
    name,
    offset,
    size: bytes.byteLength,
    sha256: sha256(bytes),
    base64: Buffer.from(bytes).toString('base64'),
  };
}

async function flashAndObserve(
  portPath: string,
  board: ReturnType<typeof applyOptions>,
  options: Record<string, string>,
  staticParts: Array<{ name: string; offset: string; path: string }>,
  firmware: Uint8Array,
  stamp: string,
): Promise<void> {
  const ports = await SerialPort.list();
  const info = ports.find((port) => port.path.toLowerCase() === portPath.toLowerCase());
  if (!info) throw new Error(`${portPath} is not present in the serial-port list`);

  const result = {
    staticArtifacts: staticParts.map((part) => inlineArtifact(part.name, part.offset, readFileSync(part.path))),
    artifacts: [inlineArtifact('firmware.bin', '0x10000', firmware)],
  };
  const port = new NodeWebSerialPort(portPath, info, 2_000);
  const written = await flashEsp32(
    port,
    result,
    board,
    options,
    (message: string, percent?: number) => console.log(`[${String(percent ?? '').padStart(3)}] ${message}`),
  );
  const markers = port.capturedText().split(/\r?\n/).filter((line) => line.includes(stamp));
  console.log(`written ${written} bytes through flashEsp32()`);
  markers.forEach((line) => console.log(`serial ${line.trim()}`));
  if (markers.length === 0) {
    throw new Error(`did not receive ${stamp} after the production post-flash reset`);
  }
}

function listTarballs(directory: string): string[] {
  requireDirectory(directory, 'ESP32-C3 WASM artifact directory');
  const tarballs: string[] = [];
  const visit = (current: string) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`artifact directory contains a symbolic link: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        if (entry.name.toLowerCase().endsWith('.tgz')) tarballs.push(path);
      } else {
        throw new Error(`artifact directory has an unsupported entry type: ${path}`);
      }
    }
  };
  visit(directory);
  return tarballs;
}

function installCandidate(artifactDirectory: string): InstalledCandidate {
  const tarballs = listTarballs(artifactDirectory);
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one .tgz compiler package in ${artifactDirectory}, found ${tarballs.length}`);
  }
  const tarball = tarballs[0]!;
  requireRegularFile(tarball, 'ESP32-C3 WASM compiler package');
  if (lstatSync(tarball).size > MAX_ARTIFACT_BYTES) {
    throw new Error(`ESP32-C3 WASM compiler package exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }

  const installRoot = mkdtempSync(join(tmpdir(), 'esp32c3-riscv-wasm-sdk-'));
  try {
    writeFileSync(join(installRoot, 'package.json'), '{"private":true,"type":"module"}\n', 'utf8');
    execFileSync(process.execPath, [npmCliPath(),
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--no-bin-links',
      tarball,
    ], { cwd: installRoot, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_COMMAND_OUTPUT });
    const packageDirectory = join(installRoot, 'node_modules', '@arduinofast', 'esp32c3-clang-wasm');
    requireDirectory(packageDirectory, 'installed ESP32-C3 WASM compiler package');
    return Object.freeze({
      packageDirectory,
      tarball,
      cleanup() { rmSync(installRoot, { recursive: true, force: true }); },
    });
  } catch (error) {
    rmSync(installRoot, { recursive: true, force: true });
    throw new Error(`could not install ESP32-C3 WASM compiler package: ${errorMessage(error)}`);
  }
}

async function loadRunClang(packageDirectory: string): Promise<{ runClang: RunClang; version: string }> {
  const packageJsonPath = join(packageDirectory, 'package.json');
  requireRegularFile(packageJsonPath, 'ESP32-C3 WASM package.json');
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    throw new Error('ESP32-C3 WASM package.json is invalid JSON');
  }
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    throw new Error('ESP32-C3 WASM package metadata is invalid');
  }
  const name = (packageJson as { name?: unknown }).name;
  const version = (packageJson as { version?: unknown }).version;
  if (name !== EXPECTED_PACKAGE || typeof version !== 'string' || !version.trim() || version.length > 128) {
    throw new Error(`unexpected ESP32-C3 WASM package identity: ${String(name)}@${String(version)}`);
  }

  const entry = join(packageDirectory, 'gen', 'bundle.js');
  requireRegularFile(entry, 'ESP32-C3 WASM compiler entry');
  const module = await import(`${pathToFileURL(entry).href}?esp32c3-sdk-verify=${Date.now()}`) as { runClang?: unknown };
  if (typeof module.runClang !== 'function') {
    throw new Error('ESP32-C3 WASM compiler does not export runClang()');
  }
  return { runClang: module.runClang as RunClang, version };
}

function npmCliPath(): string {
  const path = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  requireRegularFile(path, 'npm CLI');
  return path;
}

function errorMessage(error: unknown): string {
  const value = error && typeof error === 'object' && 'message' in error
    ? (error as { message?: unknown }).message
    : error;
  return String(value ?? 'unknown error').trim().slice(0, MAX_COMMAND_OUTPUT);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npx tsx scripts/verify-esp32c3-riscv-wasm-arduino-sdk.ts <artifact-directory> [--flash-port COM13]');
    return;
  }
  const artifactDirectory = args.artifactDirectory!;
  const flashPort = args.flashPort;
  const root = resolve(process.cwd());
  const lock = sourceLock(root);
  const candidate = installCandidate(artifactDirectory);
  const buildDir = resolve(root, 'var', 'work', 'verify-esp32c3-riscv-wasm-arduino-sdk');
  ensureWorkspaceChild(root, buildDir);

  try {
    const compiler = await loadRunClang(candidate.packageDirectory);
    const config = detectLocalToolchain();
    if (!config.esp32) throw new Error('ESP32 Arduino toolchain was not detected');
    const sdkRoot = config.esp32.sdkRootFor('esp32c3');
    if (!sdkRoot || basename(sdkRoot) !== EXPECTED_SDK_VERSION) {
      throw new Error(`this gate requires Arduino ESP32 ${EXPECTED_SDK_VERSION}; found ${sdkRoot ?? 'none'}`);
    }
    if (!config.esp32.riscvBinDir || !config.esp32.riscvRootDir) {
      throw new Error('ESP32-C3 RISC-V compiler root was not detected');
    }
    requireRegularFile(config.esp32.esptool, 'esptool');

    const boards = BoardRegistry.fromDirectory(join(root, 'boards'));
    const sourceBoard = boards.get(FQBN);
    if (!sourceBoard) throw new Error(`board definition is missing: ${FQBN}`);
    const hardwareOptions = flashPort
      ? { flash_size: '4MB', flash_mode: 'dio', flash_freq: '40m', upload_speed: '115200' }
      : {};
    const resolvedOptions = resolveOptions(sourceBoard, hardwareOptions);
    if (resolvedOptions.errors.length) {
      throw new Error(`invalid ESP32-C3 defaults: ${resolvedOptions.errors.join('; ')}`);
    }
    const board = applyOptions(sourceBoard, resolvedOptions.options);
    const profile = resolveEsp32BuildProfile(board, resolvedOptions.options);
    const memoryType = `${profile.boot}_${profile.psramType}`;
    if (!/^[A-Za-z0-9_+-]+$/.test(memoryType)) {
      throw new Error(`invalid ESP32-C3 memory profile: ${memoryType}`);
    }
    requireDirectory(join(sdkRoot, memoryType), `ESP32-C3 ${memoryType} memory profile`);
    const gpp = join(config.esp32.riscvBinDir, executable('riscv32-esp-elf-g++'));
    requireRegularFile(gpp, 'Espressif RISC-V g++');

    const cacheIdentity = verificationToolchainIdentity([
      join(sdkRoot, 'versions.txt'),
      join(sdkRoot, 'sdkconfig'),
      join(sdkRoot, 'flags', 'cpp_flags'),
      join(sdkRoot, 'flags', 'defines'),
      join(sdkRoot, 'flags', 'includes'),
      join(sdkRoot, 'flags', 'ld_flags'),
      join(sdkRoot, 'flags', 'ld_libs'),
      join(sdkRoot, 'flags', 'ld_scripts'),
      join(config.esp32.coreDir, 'Arduino.h'),
      join(config.esp32.variantsDir, board.build.variant, 'pins_arduino.h'),
      gpp,
      config.esp32.esptool,
    ]);

    rmSync(buildDir, { recursive: true, force: true });
    mkdirSync(buildDir, { recursive: true });
    const baselineSourcePath = join(buildDir, 'baseline.cpp');
    const stamp = flashPort ? `AF-C3-WASM-${Date.now().toString(36).toUpperCase()}` : undefined;
    const sketchSource = stamp ? serialSketch(stamp) : MINIMAL_SKETCH;
    writeFileSync(baselineSourcePath, sketchSource, 'utf8');

    try {
      const baselineToolchain = new Esp32Toolchain(
        config.esp32,
        new LocalExecutor(),
        config.cacheDir,
        undefined,
        cacheIdentity,
      );
      const baseline = await baselineToolchain.build(board, resolvedOptions.options, baselineSourcePath, buildDir);
      if (!baseline.ok || !baseline.elfPath) {
        throw new Error(`baseline Arduino ESP32-C3 build failed at ${baseline.failedStage ?? 'unknown'}:\n${baseline.output}`);
      }
      const staticParts = baseline.staticParts ?? [];
      if (flashPort && staticParts.length === 0) {
        throw new Error('baseline C3 build produced no static flash artifacts for the hardware verification');
      }
      const coreArchive = join(buildDir, 'core.a');
      requireRegularFile(coreArchive, 'baseline Arduino core archive');

      const runtime = resolveRuntimeInputs(gpp, config.esp32.riscvRootDir, buildDir);
      const compatibility = makeEsp32C3LldCompatibleInputs({
        ldFlags: readFileSync(join(sdkRoot, 'flags', 'ld_flags'), 'utf8'),
        memoryLd: readFileSync(join(sdkRoot, 'ld', 'memory.ld'), 'utf8'),
        sectionsLd: readFileSync(join(sdkRoot, 'ld', 'sections.ld'), 'utf8'),
      });
      const inputs = createC3Inputs({
        sdkRoot,
        coreDir: config.esp32.coreDir,
        variantDir: join(config.esp32.variantsDir, board.build.variant),
        coreArchive,
        runtime,
        compatibility,
        memoryType,
        sketchSource,
      });
      console.log(`prepared ${inputs.fileCount} VFS files (${(inputs.inputBytes / 1024 / 1024).toFixed(1)} MiB)`);

      let compiled: VfsTree | undefined = await invokeRunClang(
        compiler.runClang,
        cxxCompileArgs(board, profile, lock.target, lock.march, runtime, memoryType),
        inputs.files,
        'Arduino C++ compile',
      );
      const object = treeFile(compiled, 'sketch.o', 'WASM C++ object');
      assertRiscvElf32(object, 1, 'WASM C++ object');
      compiled = undefined;
      putTreeFile(inputs.files, 'sketch.o', object);

      const linked = await invokeRunClang(
        compiler.runClang,
        lldLinkArgs(board, profile, lock.target, lock.march, runtime, memoryType),
        inputs.files,
        'Arduino C3 LLD link',
      );
      const elf = treeFile(linked, 'firmware.elf', 'WASM LLD ELF');
      assertRiscvElf32(elf, 2, 'WASM LLD ELF');

      const elfPath = join(buildDir, 'wasm-c3.elf');
      const esptoolPath = join(buildDir, 'wasm-c3-esptool.bin');
      writeFileSync(elfPath, elf);
      runEsptool(
        config.esp32.esptool,
        elfPath,
        esptoolPath,
        board.build.mcu,
        profile.flashMode,
        profile.imageFreq,
        profile.flashSize,
        buildDir,
      );
      const browser = await buildEsp32C3Image(elf, {
        flashMode: profile.flashMode,
        flashFrequency: profile.imageFreq,
        flashSize: profile.flashSize,
      });
      const esptoolImage = readFileSync(esptoolPath);
      if (!esptoolImage.equals(Buffer.from(browser.image))) {
        throw new Error(`browser C3 image differs from esptool: host=${sha256(esptoolImage)} browser=${sha256(browser.image)}`);
      }
      if (!browser.elfSha256Embedded) {
        throw new Error('WASM LLD ELF did not expose a valid .flash.appdesc SHA-256 location');
      }
      if (flashPort && stamp) {
        console.log(`flash port ${flashPort}; stamp ${stamp}`);
        await flashAndObserve(flashPort, board, resolvedOptions.options, staticParts, browser.image, stamp);
      }

      console.log(`PASS ${FQBN} Arduino ${EXPECTED_SDK_VERSION} WASM C++/LLD acceptance`);
      console.log(`candidate ${EXPECTED_PACKAGE}@${compiler.version} sha256=${sha256(readFileSync(candidate.tarball))}`);
      console.log(`object ${object.byteLength} bytes; ELF ${elf.byteLength} bytes`);
      console.log(`image ${browser.image.byteLength} bytes sha256=${sha256(browser.image)}`);
      console.log(`baseline static artifacts ${staticParts.length}`);
      console.log('PASS browser routing is release-pinned for ESP32-C3; hardware verification runs only with --flash-port');
    } finally {
      rmSync(buildDir, { recursive: true, force: true });
    }
  } finally {
    candidate.cleanup();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
