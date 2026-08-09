/**
 * Host-only compatibility probe for the future ESP32-C3 browser linker.
 *
 * It compiles a real Arduino-ESP32 3.3.7 sketch with the installed Espressif
 * GCC, then replaces only the final link with a supplied native LLVM Clang /
 * LLD. This is intentionally not a browser compiler test and never changes
 * browser routing. It answers the narrower question: can current LLD consume
 * the Arduino C3 core, Espressif archives, and linker scripts?
 *
 * Usage:
 *   npx tsx scripts/verify-esp32c3-native-lld.ts --llvm-bin E:\\path\\to\\llvm\\bin
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { SerialPort } from 'serialport';
import { LocalExecutor } from '../packages/core/src/sandbox/local.js';
import { applyOptions, BoardRegistry, resolveOptions } from '../packages/core/src/toolchain/board.js';
import { detectLocalToolchain } from '../packages/core/src/toolchain/config.js';
import { Esp32Toolchain, resolveEsp32BuildProfile } from '../packages/core/src/toolchain/esp32.js';
import { buildEsp32C3Image } from '../packages/web/browser-esp32/image-builder.js';
import { flashEsp32 } from '../packages/web/public/esp32flash.js';
import { NodeWebSerialPort } from './flash-esp32-hardware.ts';
import { makeEsp32C3LldCompatibleInputs } from './esp32c3-lld-compat.js';

const FQBN = 'esp32:esp32:esp32c3';
const EXPECTED_SDK_VERSION = '3.3.7';
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
const MINIMAL_SKETCH = `#include <Arduino.h>

void setup() {
  pinMode(8, OUTPUT);
}

void loop() {
  digitalWrite(8, HIGH);
  delay(500);
}
`;

function usage(): never {
  throw new Error('usage: npx tsx scripts/verify-esp32c3-native-lld.ts --llvm-bin <LLVM bin directory> [--flash-port COM13]');
}

function parseArgs(args: string[]): { llvmBin: string; flashPort?: string } {
  if (args.length !== 2 && args.length !== 4) usage();
  if (args[0] !== '--llvm-bin' || !args[1]) usage();
  if (args.length === 2) return { llvmBin: resolve(args[1]) };
  if (args[2] !== '--flash-port' || !args[3]) usage();
  return { llvmBin: resolve(args[1]), flashPort: args[3] };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function verificationToolchainIdentity(paths: string[]): string {
  const hash = createHash('sha256').update('browser-esp32c3-native-lld-verify-v1\0');
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
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
}

function compilerLibraryDirs(gpp: string, cwd: string): string[] {
  const libraries = ['libgcc.a', 'libstdc++.a', 'libc.a', 'libm.a'];
  const dirs = new Set<string>();
  for (const library of libraries) {
    const path = run(gpp, [`-print-file-name=${library}`], cwd, `find ${library}`, 30_000).trim();
    if (!path || path === library || !existsSync(path)) {
      throw new Error(`Espressif GCC did not locate ${library}: ${path || 'no output'}`);
    }
    dirs.add(dirname(path));
  }
  return [...dirs];
}

function lldCompatibleLdFlags(sdkRoot: string, buildDir: string): string {
  const compatible = readLldCompatibleInputs(sdkRoot);
  const outputPath = join(buildDir, 'lld-ld_flags');
  writeFileSync(outputPath, compatible.ldFlags, 'utf8');
  return outputPath;
}

function lldCompatibleLinkerScriptDir(sdkRoot: string, buildDir: string): string {
  const compatible = readLldCompatibleInputs(sdkRoot);
  const outputDir = join(buildDir, 'lld-ld');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'memory.ld'), compatible.memoryLd, 'utf8');
  writeFileSync(join(outputDir, 'sections.ld'), compatible.sectionsLd, 'utf8');
  return outputDir;
}

function readLldCompatibleInputs(sdkRoot: string) {
  return makeEsp32C3LldCompatibleInputs({
    ldFlags: readFileSync(join(sdkRoot, 'flags', 'ld_flags'), 'utf8'),
    memoryLd: readFileSync(join(sdkRoot, 'ld', 'memory.ld'), 'utf8'),
    sectionsLd: readFileSync(join(sdkRoot, 'ld', 'sections.ld'), 'utf8'),
  });
}

function assertRiscvElf32(elf: Uint8Array): void {
  if (elf.byteLength < 52 || elf[0] !== 0x7f || elf[1] !== 0x45 || elf[2] !== 0x4c || elf[3] !== 0x46) {
    throw new Error('LLD output is not an ELF file');
  }
  if (elf[4] !== 1 || elf[5] !== 1) throw new Error('LLD output is not a little-endian ELF32 file');
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (view.getUint16(18, true) !== 243) throw new Error('LLD output is not EM_RISCV');
  const flags = view.getUint32(36, true);
  if ((flags & 0x1) === 0 || (flags & 0x6) !== 0 || (flags & 0x8) !== 0) {
    throw new Error(`LLD output has an unexpected C3 ABI flag set: 0x${flags.toString(16)}`);
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

function serialSketch(stamp: string): string {
  return `#include <Arduino.h>

const char* const kLldStamp = "${stamp}";

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.print("BOOT ");
  Serial.println(kLldStamp);
}

void loop() {
  Serial.println(kLldStamp);
  delay(400);
}
`;
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

async function main(): Promise<void> {
  const { llvmBin, flashPort } = parseArgs(process.argv.slice(2));
  const root = resolve(process.cwd());
  const buildDir = resolve(root, 'var', 'work', 'verify-esp32c3-native-lld');
  ensureWorkspaceChild(root, buildDir);

  const clang = join(llvmBin, executable('clang++'));
  requireRegularFile(clang, 'native LLVM clang++');

  const config = detectLocalToolchain();
  if (!config.esp32) throw new Error('ESP32 Arduino toolchain was not detected');
  const sdkRoot = config.esp32.sdkRootFor('esp32c3');
  if (!sdkRoot || basename(sdkRoot) !== EXPECTED_SDK_VERSION) {
    throw new Error(`this probe requires Arduino ESP32 ${EXPECTED_SDK_VERSION}; found ${sdkRoot ?? 'none'}`);
  }
  if (!config.esp32.riscvBinDir) throw new Error('RISC-V ESP32-C3 compiler was not detected');
  requireRegularFile(config.esp32.esptool, 'esptool');

  const boards = BoardRegistry.fromDirectory(join(root, 'boards'));
  const sourceBoard = boards.get(FQBN);
  if (!sourceBoard) throw new Error(`board definition is missing: ${FQBN}`);
  const hardwareOptions = flashPort
    ? { flash_size: '4MB', flash_mode: 'dio', flash_freq: '40m', upload_speed: '115200' }
    : undefined;
  const { options, errors } = resolveOptions(sourceBoard, hardwareOptions);
  if (errors.length) throw new Error(`invalid C3 probe options: ${errors.join('; ')}`);
  const board = applyOptions(sourceBoard, options);
  const profile = resolveEsp32BuildProfile(board, options);
  const gpp = join(config.esp32.riscvBinDir, executable('riscv32-esp-elf-g++'));
  requireRegularFile(gpp, 'Espressif RISC-V g++');

  const cacheIdentity = verificationToolchainIdentity([
    join(sdkRoot, 'versions.txt'),
    join(sdkRoot, 'sdkconfig'),
    join(sdkRoot, 'flags', 'ld_flags'),
    join(sdkRoot, 'flags', 'ld_libs'),
    join(sdkRoot, 'flags', 'ld_scripts'),
    join(config.esp32.coreDir, 'Arduino.h'),
    join(config.esp32.variantsDir, board.build.variant, 'pins_arduino.h'),
    gpp,
    config.esp32.esptool,
    clang,
  ]);

  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  const sketchPath = join(buildDir, 'minimal.cpp');
  const stamp = flashPort ? `AF-C3-LLD-${Date.now().toString(36).toUpperCase()}` : undefined;
  writeFileSync(sketchPath, stamp ? serialSketch(stamp) : MINIMAL_SKETCH, 'utf8');

  try {
    const toolchain = new Esp32Toolchain(
      config.esp32,
      new LocalExecutor(),
      config.cacheDir,
      undefined,
      cacheIdentity,
    );
    const baseline = await toolchain.build(board, options, sketchPath, buildDir);
    if (!baseline.ok || !baseline.elfPath) {
      throw new Error(`baseline GCC build failed at ${baseline.failedStage ?? 'unknown'}:\n${baseline.output}`);
    }
    if (flashPort && baseline.staticParts.length === 0) {
      throw new Error('baseline C3 build produced no static flash artifacts for the hardware verification');
    }

    const objectPath = join(buildDir, 'sketch.cpp.o');
    const corePath = join(buildDir, 'core.a');
    requireRegularFile(objectPath, 'GCC sketch object');
    requireRegularFile(corePath, 'Arduino core archive');
    const lldElf = join(buildDir, 'lld.elf');
    const runtimeDirs = compilerLibraryDirs(gpp, buildDir);
    const lldFlagsPath = lldCompatibleLdFlags(sdkRoot, buildDir);
    const lldScriptDir = lldCompatibleLinkerScriptDir(sdkRoot, buildDir);
    const memoryDir = join(sdkRoot, `${profile.boot}_${profile.psramType}`);
    const lldArgs = [
      `--target=${board.build.tarch === 'riscv32' ? 'riscv32-esp-elf' : ''}`,
      '-march=rv32imc_zicsr_zifencei',
      '-mabi=ilp32',
      '-nostdlib',
      '-fuse-ld=lld',
      `-Wl,--Map=${join(buildDir, 'lld.map')}`,
      `-L${join(sdkRoot, 'lib')}`,
      `-L${lldScriptDir}`,
      `-L${join(sdkRoot, 'ld')}`,
      `-L${memoryDir}`,
      ...runtimeDirs.map((dir) => `-L${dir}`),
      '-Wl,--wrap=esp_panic_handler',
      `@${lldFlagsPath}`,
      `@${join(sdkRoot, 'flags', 'ld_scripts')}`,
      '-Wl,--start-group',
      objectPath,
      corePath,
      `@${join(sdkRoot, 'flags', 'ld_libs')}`,
      ...profile.linkerFlags,
      '-Wl,--end-group',
      '-Wl,-EL',
      '-o', lldElf,
    ];
    run(clang, lldArgs, buildDir, 'native LLVM C3 link');

    const lldElfBytes = readFileSync(lldElf);
    assertRiscvElf32(lldElfBytes);
    const hostImagePath = join(buildDir, 'lld-esptool.bin');
    runEsptool(
      config.esp32.esptool,
      lldElf,
      hostImagePath,
      board.build.mcu,
      profile.flashMode,
      profile.imageFreq,
      profile.flashSize,
      buildDir,
    );
    const browserImage = await buildEsp32C3Image(lldElfBytes, {
      flashMode: profile.flashMode,
      flashFrequency: profile.imageFreq,
      flashSize: profile.flashSize,
    });
    const hostImage = readFileSync(hostImagePath);
    if (!hostImage.equals(browserImage.image)) {
      throw new Error(`browser C3 image differs from esptool for LLD ELF: host=${sha256(hostImage)} browser=${sha256(browserImage.image)}`);
    }
    if (!browserImage.elfSha256Embedded) {
      throw new Error('LLD ELF did not expose a valid .flash.appdesc SHA-256 location');
    }
    if (flashPort && stamp) {
      console.log(`flash port ${flashPort}; stamp ${stamp}`);
      await flashAndObserve(flashPort, board, options, baseline.staticParts, browserImage.image, stamp);
    }

    console.log(`PASS ${FQBN} Arduino ${EXPECTED_SDK_VERSION} native LLD compatibility`);
    console.log(`baseline ELF ${readFileSync(baseline.elfPath).byteLength} bytes`);
    console.log(`LLD ELF ${lldElfBytes.byteLength} bytes`);
    console.log(`image ${browserImage.image.byteLength} bytes sha256=${sha256(browserImage.image)}`);
    console.log('NOTICE this proves a host LLD compatibility gate only; browser compilation and C3 routing remain disabled');
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
