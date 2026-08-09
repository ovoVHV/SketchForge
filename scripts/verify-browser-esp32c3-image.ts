/**
 * Host-only regression for the ESP32-family browser image writers.
 *
 * Usage:
 *   npx tsx scripts/verify-browser-esp32c3-image.ts [--board esp32|esp32s2|esp32s3|esp32c3]
 *
 * This intentionally depends on a locally installed Arduino ESP32 3.3.7
 * toolchain. It builds a real minimal Arduino ELF, invokes the host esptool
 * independently, and requires byte-for-byte equality with the corresponding
 * browser-side image writer. No binary fixture is kept in the repository.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalExecutor } from '../packages/core/src/sandbox/local.js';
import { applyOptions, BoardRegistry, resolveOptions } from '../packages/core/src/toolchain/board.js';
import { detectLocalToolchain } from '../packages/core/src/toolchain/config.js';
import { Esp32Toolchain, resolveEsp32BuildProfile } from '../packages/core/src/toolchain/esp32.js';
import {
  buildEsp32C3Image,
  buildEsp32Image,
  buildEsp32S2Image,
  buildEsp32S3Image,
} from '../packages/web/browser-esp32/image-builder.js';

const TARGETS = Object.freeze({
  esp32: Object.freeze({
    key: 'esp32',
    label: 'ESP32',
    fqbn: 'esp32:esp32:esp32',
    sdkTarget: 'esp32',
    architecture: 'xtensa',
    compilerPrefix: 'xtensa-esp32-elf',
    buildImage: buildEsp32Image,
  }),
  esp32s2: Object.freeze({
    key: 'esp32s2',
    label: 'ESP32-S2',
    fqbn: 'esp32:esp32:esp32s2',
    sdkTarget: 'esp32s2',
    architecture: 'xtensa',
    compilerPrefix: 'xtensa-esp32s2-elf',
    buildImage: buildEsp32S2Image,
  }),
  esp32s3: Object.freeze({
    key: 'esp32s3',
    label: 'ESP32-S3',
    fqbn: 'esp32:esp32:esp32s3',
    sdkTarget: 'esp32s3',
    architecture: 'xtensa',
    compilerPrefix: 'xtensa-esp32s3-elf',
    buildImage: buildEsp32S3Image,
  }),
  esp32c3: Object.freeze({
    key: 'esp32c3',
    label: 'ESP32-C3',
    fqbn: 'esp32:esp32:esp32c3',
    sdkTarget: 'esp32c3',
    architecture: 'riscv',
    compilerPrefix: 'riscv32-esp-elf',
    buildImage: buildEsp32C3Image,
  }),
} as const);

type TargetKey = keyof typeof TARGETS;

const MINIMAL_SKETCH = `#include <Arduino.h>

void setup() {
  pinMode(8, OUTPUT);
}

void loop() {
  digitalWrite(8, HIGH);
  delay(500);
}
`;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(args: string[]): { board: TargetKey; help: boolean } {
  let board: TargetKey = 'esp32c3';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return { board, help: true };
    if (argument !== '--board') throw new Error(`unknown argument: ${argument}`);
    const value = args[++index];
    if (!value || !Object.prototype.hasOwnProperty.call(TARGETS, value)) {
      throw new Error('--board must be esp32, esp32s2, esp32s3, or esp32c3');
    }
    board = value as TargetKey;
  }
  return { board, help: false };
}

/**
 * The installed Arduino package is version-pinned below. Hash only the small
 * inputs which define this regression's compiler invocation, rather than
 * walking every precompiled SDK archive before the test can start.
 */
function verificationToolchainIdentity(target: TargetKey, paths: string[]): string {
  const hash = createHash('sha256').update(`browser-esp32-image-verify-v2\0${target}\0`);
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
  const result = spawnSync(command, [
    '--chip', chip,
    'elf2image',
    '--flash-mode', flashMode,
    '--flash-freq', flashFrequency,
    '--flash-size', flashSize,
    '--elf-sha256-offset', '0xb0',
    '-o', outputPath,
    elfPath,
  ], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`esptool elf2image failed:\n${result.stdout}\n${result.stderr}`.trim());
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npx tsx scripts/verify-browser-esp32c3-image.ts [--board esp32|esp32s2|esp32s3|esp32c3]');
    return;
  }
  const target = TARGETS[args.board];
  const root = resolve(process.cwd());
  const buildDir = resolve(root, 'var', 'work', `verify-browser-${target.key}-image`);
  ensureWorkspaceChild(root, buildDir);

  const config = detectLocalToolchain();
  if (!config.esp32) throw new Error('ESP32 Arduino toolchain was not detected');
  const sdkRoot = config.esp32.sdkRootFor(target.sdkTarget);
  if (!sdkRoot || basename(sdkRoot) !== '3.3.7') {
    throw new Error(`this regression requires Arduino ESP32 3.3.7; found ${sdkRoot ?? 'none'}`);
  }
  if (!existsSync(config.esp32.esptool)) {
    throw new Error(`esptool is missing: ${config.esp32.esptool}`);
  }

  const boards = BoardRegistry.fromDirectory(join(root, 'boards'));
  const sourceBoard = boards.get(target.fqbn);
  if (!sourceBoard) throw new Error(`board definition is missing: ${target.fqbn}`);
  const resolved = resolveOptions(sourceBoard, undefined);
  if (resolved.errors.length) throw new Error(resolved.errors.join('; '));
  const { options } = resolved;
  const board = applyOptions(sourceBoard, options);
  const profile = resolveEsp32BuildProfile(board, options);
  const compilerBinDir = target.architecture === 'xtensa'
    ? config.esp32.xtensaBinDir
    : config.esp32.riscvBinDir;
  if (!compilerBinDir) throw new Error(`${target.label} ${target.architecture} compiler was not detected`);
  const executable = process.platform === 'win32' ? '.exe' : '';

  const cacheIdentity = verificationToolchainIdentity(target.key, [
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
    join(compilerBinDir, `${target.compilerPrefix}-gcc${executable}`),
    join(compilerBinDir, `${target.compilerPrefix}-g++${executable}`),
    join(compilerBinDir, `${target.compilerPrefix}-gcc-ar${executable}`),
    join(compilerBinDir, `${target.compilerPrefix}-ld${executable}`),
    config.esp32.esptool,
  ]);

  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  const sketchPath = join(buildDir, 'minimal.cpp');
  writeFileSync(sketchPath, MINIMAL_SKETCH, 'utf8');

  try {
    const toolchain = new Esp32Toolchain(
      config.esp32,
      new LocalExecutor(),
      config.cacheDir,
      undefined,
      cacheIdentity,
    );
    const build = await toolchain.build(board, options, sketchPath, buildDir);
    if (!build.ok || !build.elfPath) {
      throw new Error(`minimal ${target.label} build failed at ${build.failedStage ?? 'unknown'}:\n${build.output}`);
    }

    const esptoolPath = join(buildDir, 'esptool.bin');
    runEsptool(
      config.esp32.esptool,
      build.elfPath,
      esptoolPath,
      board.build.mcu,
      profile.flashMode,
      profile.imageFreq,
      profile.flashSize,
      buildDir,
    );

    const browser = await target.buildImage(readFileSync(build.elfPath), {
      flashMode: profile.flashMode,
      flashFrequency: profile.imageFreq,
      flashSize: profile.flashSize,
    });
    const browserPath = join(buildDir, 'browser.bin');
    writeFileSync(browserPath, browser.image);

    const esptool = readFileSync(esptoolPath);
    const browserBytes = readFileSync(browserPath);
    if (!esptool.equals(browserBytes)) {
      throw new Error(
        `browser image differs from esptool: esptool=${sha256(esptool)} browser=${sha256(browserBytes)}`,
      );
    }
    if (!browser.elfSha256Embedded) {
      throw new Error('browser image did not embed the ELF SHA-256 in .flash.appdesc');
    }

    console.log(`PASS ${target.fqbn} Arduino ${basename(sdkRoot)}`);
    console.log(`ELF ${readFileSync(build.elfPath).byteLength} bytes`);
    console.log(`image ${browserBytes.byteLength} bytes sha256=${sha256(browserBytes)}`);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
