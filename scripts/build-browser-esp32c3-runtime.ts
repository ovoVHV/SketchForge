/**
 * Build an immutable ESP32-family browser runtime from a verified compiler tgz
 * and the locally installed Arduino-ESP32 3.3.7 toolchain.
 *
 * The SDK is split into compile/link artifact trees. Each phase stays below
 * the browser memory limit even though the release contains both input sets.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { x as extractTar } from 'tar';
import { canonicalJson } from '../packages/core/src/build-ir/canonical.js';
import {
  createPlatformManifest,
  resolvePlatformManifest,
  tokenizeRecipe,
  validatePlatformManifest,
} from '../packages/core/src/platform-pack/builder.js';
import {
  derivePlatformRecipeCommands,
  expandPlatformProperty,
  hasPlatformPropertyDependency,
} from '../packages/core/src/platform-pack/recipe-command-lowering.js';
import {
  CK_BOARD_PROFILE_ARTIFACT_ID,
  CK_BOARD_PROFILE_SCHEMA_VERSION,
  CK_LEGACY_BOARD_PROFILE_SCHEMA_VERSION,
  CK_LEGACY_PLATFORM_PROFILE_SCHEMA_VERSION,
  CK_LEGACY_PROFILE_ARTIFACT_ID,
  CK_PLATFORM_MANIFEST_ARTIFACT_ID,
  CK_PLATFORM_PROFILE_ARTIFACT_ID,
  CK_PLATFORM_PROFILE_SCHEMA_VERSION,
} from '../packages/core/src/platform-pack/types.js';
import type {
  CKBoardProfileV4,
  CKCompilerExecutionMetadata,
  CKPlatformCommandProfile,
  CKPlatformManifest,
  CKPlatformProfileV5,
  CreatePlatformManifestInput,
  PlatformToolRequirement,
  ResolvedPlatformManifest,
} from '../packages/core/src/platform-pack/types.js';
import { LocalExecutor } from '../packages/core/src/sandbox/local.js';
import { applyOptions, BoardRegistry, resolveOptions } from '../packages/core/src/toolchain/board.js';
import { detectLocalToolchain } from '../packages/core/src/toolchain/config.js';
import { Esp32Toolchain, resolveEsp32BuildProfile } from '../packages/core/src/toolchain/esp32.js';
import { collectPlatformSourceFiles } from './build-ck-platform-pack.js';
import { createEsp32RecipeLoweringInput } from './ck-esp32-recipe-lowering.mjs';
import {
  ESP32C3_UNUSED_SDK_ARCHIVES,
  ESP32C5_UNUSED_SDK_ARCHIVES,
  ESP32C6_UNUSED_SDK_ARCHIVES,
  ESP32H2_UNUSED_SDK_ARCHIVES,
  ESP32P4_UNUSED_SDK_ARCHIVES,
  makeEsp32C3LldCompatibleLdLibs,
  makeEsp32C3LldCompatibleInputs,
  makeEsp32C3WasmCompatibleCppFlags,
  makeEsp32C5LldCompatibleLdLibs,
  makeEsp32C5LldCompatibleInputs,
  makeEsp32C5WasmCompatibleCppFlags,
  makeEsp32C6LldCompatibleLdLibs,
  makeEsp32C6LldCompatibleInputs,
  makeEsp32C6WasmCompatibleCppFlags,
  makeEsp32H2LldCompatibleLdLibs,
  makeEsp32H2LldCompatibleInputs,
  makeEsp32H2WasmCompatibleCppFlags,
  makeEsp32P4LldCompatibleLdLibs,
  makeEsp32P4LldCompatibleInputs,
  makeEsp32P4WasmCompatibleCppFlags,
  makeEsp32S2LldCompatibleInputs,
  makeEsp32S2LldCompatibleLdLibs,
  makeEsp32S2WasmCompatibleCppFlags,
  makeEsp32S3LldCompatibleInputs,
  makeEsp32S3LldCompatibleLdLibs,
  makeEsp32S3WasmCompatibleCppFlags,
  makeEsp32XtensaLldCompatibleInputs,
  makeEsp32XtensaLldCompatibleLdLibs,
  makeEsp32XtensaWasmCompatibleCppFlags,
  selectEsp32C3LldArchiveNames,
  selectEsp32C5LldArchiveNames,
  selectEsp32C6LldArchiveNames,
  selectEsp32H2LldArchiveNames,
  selectEsp32P4LldArchiveNames,
  selectEsp32XtensaLldArchiveNames,
} from './esp32c3-lld-compat.js';

const SDK_VERSION = '3.3.7';
const ARDUINO_VERSION_DEFINE = '10607';
const MAX_GROUP_BYTES = 64 * 1024 * 1024;
const MAX_PHASE_BYTES = 256 * 1024 * 1024;
const MAX_SDK_PACK_BYTES = 256 * 1024 * 1024;
const MAX_PROFILE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
const PACK_IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/;
const PACK_REVISION = /^[a-f0-9]{64}$/;
const COMPILER_RESOURCES = Object.freeze([
  'llvm-resources.tar',
  'llvm.core.wasm',
  'llvm.core2.wasm',
  'llvm.core3.wasm',
  'llvm.core4.wasm',
]);
const C5_CLIC_VECTOR_ARCHIVE_PATH = 'sdk/lib/libriscv.a';
const C5_CLIC_VECTOR_MEMBER = 'vectors_clic.S.obj';
const C5_CLIC_VECTOR_SECTION = '.exception_vectors_table.text';
const ESP32_SR_MODEL_ARTIFACT_ID = 'srmodels';
const ESP32_SR_MODEL_OFFSET = '0xd10000';
const ESP32_SR_MODEL_SIZE_BYTES = 2_468_362;
const ESP32_SR_MODEL_CAPACITY_BYTES = 0x2f0000;
const ESP32_SR_MODEL_SHA256 = '0312f2dde9581cd604e752fbfa287d687a2acc0631e593a35a24c4a518d75879';
export type RuntimeTargetKey =
  | 'esp32'
  | 'esp32s2'
  | 'esp32s3'
  | 'esp32c3'
  | 'esp32c5'
  | 'esp32c6'
  | 'esp32h2'
  | 'esp32p4';

export type RuntimeTarget = Readonly<{
  key: RuntimeTargetKey;
  label: string;
  fqbn: string;
  sdkTarget: string;
  architecture: 'riscv' | 'xtensa';
  compilerPackage: string;
  compilerPackId: string;
  gccTriple: 'riscv32-esp-elf' | 'xtensa-esp-elf';
  gccDriverPrefix:
    | 'riscv32-esp-elf'
    | 'xtensa-esp32-elf'
    | 'xtensa-esp32s2-elf'
    | 'xtensa-esp32s3-elf';
  gccLibraryArgs: readonly string[];
  sourceBundleDir: 'esp32c3-riscv-wasm' | 'esp32-xtensa-wasm';
  toolchainLicenseId: 'esp-rv32' | 'esp-x32';
  toolchainLabel: 'RISC-V' | 'Xtensa';
  sdkPackId: string;
  flashPackId: string;
  runtimeId: string;
  unusedArchives: readonly string[];
  repairClicVectorFlags: boolean;
  makeLldInputs: typeof makeEsp32C3LldCompatibleInputs;
  makeCppFlags: typeof makeEsp32C3WasmCompatibleCppFlags;
  makeLdLibs: typeof makeEsp32C3LldCompatibleLdLibs;
  selectArchives: typeof selectEsp32C3LldArchiveNames;
}>;

const RISCV_COMPILER_PROFILE = Object.freeze({
  architecture: 'riscv' as const,
  compilerPackage: '@arduinofast/esp32c3-clang-wasm',
  compilerPackId: 'riscv32-esp-elf-wasm',
  gccTriple: 'riscv32-esp-elf' as const,
  gccDriverPrefix: 'riscv32-esp-elf' as const,
  sourceBundleDir: 'esp32c3-riscv-wasm' as const,
  toolchainLicenseId: 'esp-rv32' as const,
  toolchainLabel: 'RISC-V' as const,
});

const XTENSA_COMPILER_PROFILE = Object.freeze({
  architecture: 'xtensa' as const,
  compilerPackage: '@arduinofast/esp32-xtensa-clang-wasm',
  compilerPackId: 'xtensa-esp-elf-wasm',
  gccTriple: 'xtensa-esp-elf' as const,
  gccLibraryArgs: Object.freeze([]),
  // Espressif's Xtensa GCC uses long for the 32-bit stdint typedefs while
  // Clang defaults to int. Keep C++ mangling compatible with the prebuilt core.
  sourceBundleDir: 'esp32-xtensa-wasm' as const,
  toolchainLicenseId: 'esp-x32' as const,
  toolchainLabel: 'Xtensa' as const,
});

export const RUNTIME_TARGETS: Readonly<Record<RuntimeTargetKey, RuntimeTarget>> = Object.freeze({
  esp32: Object.freeze({
    key: 'esp32',
    label: 'ESP32',
    fqbn: 'esp32:esp32:esp32',
    sdkTarget: 'esp32',
    ...XTENSA_COMPILER_PROFILE,
    gccDriverPrefix: 'xtensa-esp32-elf',
    sdkPackId: 'arduino-esp32-sdk',
    flashPackId: 'arduino-esp32-flash',
    runtimeId: 'esp32-arduino',
    unusedArchives: Object.freeze([]),
    repairClicVectorFlags: false,
    makeLldInputs: makeEsp32XtensaLldCompatibleInputs,
    makeCppFlags: makeEsp32XtensaWasmCompatibleCppFlags,
    makeLdLibs: makeEsp32XtensaLldCompatibleLdLibs,
    selectArchives: selectEsp32XtensaLldArchiveNames,
  }),
  esp32s2: Object.freeze({
    key: 'esp32s2',
    label: 'ESP32-S2',
    fqbn: 'esp32:esp32:esp32s2',
    sdkTarget: 'esp32s2',
    ...XTENSA_COMPILER_PROFILE,
    gccDriverPrefix: 'xtensa-esp32s2-elf',
    sdkPackId: 'arduino-esp32s2-sdk',
    flashPackId: 'arduino-esp32s2-flash',
    runtimeId: 'esp32-s2-arduino',
    unusedArchives: Object.freeze([]),
    repairClicVectorFlags: false,
    makeLldInputs: makeEsp32S2LldCompatibleInputs,
    makeCppFlags: makeEsp32S2WasmCompatibleCppFlags,
    makeLdLibs: makeEsp32S2LldCompatibleLdLibs,
    selectArchives: selectEsp32XtensaLldArchiveNames,
  }),
  esp32s3: Object.freeze({
    key: 'esp32s3',
    label: 'ESP32-S3',
    fqbn: 'esp32:esp32:esp32s3',
    sdkTarget: 'esp32s3',
    ...XTENSA_COMPILER_PROFILE,
    gccDriverPrefix: 'xtensa-esp32s3-elf',
    sdkPackId: 'arduino-esp32s3-sdk',
    flashPackId: 'arduino-esp32s3-flash',
    runtimeId: 'esp32-s3-arduino',
    unusedArchives: Object.freeze([]),
    repairClicVectorFlags: false,
    makeLldInputs: makeEsp32S3LldCompatibleInputs,
    makeCppFlags: makeEsp32S3WasmCompatibleCppFlags,
    makeLdLibs: makeEsp32S3LldCompatibleLdLibs,
    selectArchives: selectEsp32XtensaLldArchiveNames,
  }),
  esp32c3: Object.freeze({
    key: 'esp32c3',
    label: 'ESP32-C3',
    fqbn: 'esp32:esp32:esp32c3',
    sdkTarget: 'esp32c3',
    ...RISCV_COMPILER_PROFILE,
    gccLibraryArgs: Object.freeze(['-march=rv32imc_zicsr_zifencei', '-mabi=ilp32']),
    sdkPackId: 'arduino-esp32c3-sdk',
    flashPackId: 'arduino-esp32c3-flash',
    runtimeId: 'esp32-c3-arduino',
    unusedArchives: ESP32C3_UNUSED_SDK_ARCHIVES,
    repairClicVectorFlags: false,
    makeLldInputs: makeEsp32C3LldCompatibleInputs,
    makeCppFlags: makeEsp32C3WasmCompatibleCppFlags,
    makeLdLibs: makeEsp32C3LldCompatibleLdLibs,
    selectArchives: selectEsp32C3LldArchiveNames,
  }),
  esp32c5: Object.freeze({
    key: 'esp32c5',
    label: 'ESP32-C5',
    fqbn: 'esp32:esp32:esp32c5',
    sdkTarget: 'esp32c5',
    ...RISCV_COMPILER_PROFILE,
    gccLibraryArgs: Object.freeze(['-march=rv32imac_zicsr_zifencei', '-mabi=ilp32']),
    sdkPackId: 'arduino-esp32c5-sdk',
    flashPackId: 'arduino-esp32c5-flash',
    runtimeId: 'esp32-c5-arduino',
    unusedArchives: ESP32C5_UNUSED_SDK_ARCHIVES,
    repairClicVectorFlags: true,
    makeLldInputs: makeEsp32C5LldCompatibleInputs,
    makeCppFlags: makeEsp32C5WasmCompatibleCppFlags,
    makeLdLibs: makeEsp32C5LldCompatibleLdLibs,
    selectArchives: selectEsp32C5LldArchiveNames,
  }),
  esp32c6: Object.freeze({
    key: 'esp32c6',
    label: 'ESP32-C6',
    fqbn: 'esp32:esp32:esp32c6',
    sdkTarget: 'esp32c6',
    ...RISCV_COMPILER_PROFILE,
    gccLibraryArgs: Object.freeze(['-march=rv32imac_zicsr_zifencei', '-mabi=ilp32']),
    sdkPackId: 'arduino-esp32c6-sdk',
    flashPackId: 'arduino-esp32c6-flash',
    runtimeId: 'esp32-c6-arduino',
    unusedArchives: ESP32C6_UNUSED_SDK_ARCHIVES,
    repairClicVectorFlags: false,
    makeLldInputs: makeEsp32C6LldCompatibleInputs,
    makeCppFlags: makeEsp32C6WasmCompatibleCppFlags,
    makeLdLibs: makeEsp32C6LldCompatibleLdLibs,
    selectArchives: selectEsp32C6LldArchiveNames,
  }),
  esp32h2: Object.freeze({
    key: 'esp32h2',
    label: 'ESP32-H2',
    fqbn: 'esp32:esp32:esp32h2',
    sdkTarget: 'esp32h2',
    ...RISCV_COMPILER_PROFILE,
    gccLibraryArgs: Object.freeze(['-march=rv32imac_zicsr_zifencei', '-mabi=ilp32']),
    sdkPackId: 'arduino-esp32h2-sdk',
    flashPackId: 'arduino-esp32h2-flash',
    runtimeId: 'esp32-h2-arduino',
    unusedArchives: ESP32H2_UNUSED_SDK_ARCHIVES,
    repairClicVectorFlags: false,
    makeLldInputs: makeEsp32H2LldCompatibleInputs,
    makeCppFlags: makeEsp32H2WasmCompatibleCppFlags,
    makeLdLibs: makeEsp32H2LldCompatibleLdLibs,
    selectArchives: selectEsp32H2LldArchiveNames,
  }),
  esp32p4: Object.freeze({
    key: 'esp32p4',
    label: 'ESP32-P4',
    fqbn: 'esp32:esp32:esp32p4',
    sdkTarget: 'esp32p4_es',
    ...RISCV_COMPILER_PROFILE,
    gccLibraryArgs: Object.freeze(['-march=rv32imafc_zicsr_zifencei', '-mabi=ilp32f']),
    sdkPackId: 'arduino-esp32p4-sdk',
    flashPackId: 'arduino-esp32p4-flash',
    runtimeId: 'esp32-p4-arduino',
    unusedArchives: ESP32P4_UNUSED_SDK_ARCHIVES,
    repairClicVectorFlags: true,
    makeLldInputs: makeEsp32P4LldCompatibleInputs,
    makeCppFlags: makeEsp32P4WasmCompatibleCppFlags,
    makeLdLibs: makeEsp32P4LldCompatibleLdLibs,
    selectArchives: selectEsp32P4LldArchiveNames,
  }),
});
const BASELINE_SOURCE = `#include <Arduino.h>

void setup() {
  pinMode(8, OUTPUT);
}

void loop() {
  digitalWrite(8, !digitalRead(8));
  delay(20);
}
`;

type Bytes = Uint8Array;
type PackTreeFile = Readonly<{
  path: string;
  size: number;
  source?: string;
  bytes?: Bytes;
}>;
type PackTreeRef = Readonly<{
  artifactId: string;
  size: number;
  fileCount: number;
}>;
type PackArtifactFile = Readonly<{
  path: string;
  offset: number;
  length: number;
  sha256: string;
}>;
type PackArtifact = Readonly<{
  id: string;
  kind: string;
  size: number;
  sha256: string;
  files?: readonly PackArtifactFile[];
  chunks: readonly Readonly<{
    path: string;
    size: number;
    sha256: string;
    compression?: 'gzip';
    compressedSize?: number;
    compressedSha256?: string;
  }>[];
}>;

export function sortPackArtifactsForManifest<T extends Readonly<{ id: string }>>(
  artifacts: readonly T[],
): readonly T[] {
  const sorted = [...artifacts].sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ));
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index - 1]!.id === sorted[index]!.id) {
      throw new Error(`pack artifact is duplicated: ${sorted[index]!.id}`);
    }
  }
  return Object.freeze(sorted);
}

type ArchiveSectionRepair = Readonly<{
  objcopy: string;
  readelf: string;
}>;

class PackTreePlan {
  private readonly files = new Map<string, PackTreeFile>();

  addFile(source: string, destination: string): void {
    requireRegularFile(source, 'Pack tree input');
    const size = lstatSync(source).size;
    this.add({ path: destination, size, source });
  }

  addBytes(destination: string, value: Bytes): void {
    const bytes = new Uint8Array(value);
    this.add({ path: destination, size: bytes.byteLength, bytes });
  }

  addText(destination: string, value: string): void {
    this.addBytes(destination, new TextEncoder().encode(value));
  }

  addDirectory(source: string, destination: string, {
    excludeRootEntries = [],
  }: { excludeRootEntries?: readonly string[] } = {}): void {
    requireDirectory(source, 'Pack tree directory');
    const excluded = new Set(excludeRootEntries);
    const walk = (current: string, virtual: string, root: boolean): void => {
      const entries = readdirSync(current, { withFileTypes: true })
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      for (const entry of entries) {
        if (root && excluded.has(entry.name)) continue;
        const path = join(current, entry.name);
        const virtualPath = `${virtual}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error(`Pack tree input must not be a symbolic link: ${path}`);
        if (entry.isDirectory()) walk(path, virtualPath, false);
        else if (entry.isFile()) this.addFile(path, virtualPath);
        else throw new Error(`Pack tree input has an unsupported entry: ${path}`);
      }
    };
    walk(source, destination, true);
  }

  sorted(): PackTreeFile[] {
    return [...this.files.values()].sort((left, right) => left.path < right.path ? -1 : 1);
  }

  private add(file: PackTreeFile): void {
    validatePackTreePath(file.path);
    if (file.size < 0 || file.size > MAX_FILE_BYTES) throw new Error(`Pack tree file is too large: ${file.path}`);
    if (this.files.has(file.path)) throw new Error(`Pack tree path is duplicated: ${file.path}`);
    if (this.files.size >= MAX_FILES) throw new Error(`Pack tree exceeds ${MAX_FILES} files`);
    this.files.set(file.path, Object.freeze(file));
  }
}

class PackWriter {
  readonly artifacts: PackArtifact[] = [];
  private readonly ids = new Set<string>();

  constructor(
    readonly directory: string,
    readonly id: string,
    readonly version: string,
  ) {
    mkdirSync(join(directory, 'chunks'), { recursive: true });
  }

  addArtifact(id: string, kind: string, value: Bytes, files?: readonly PackArtifactFile[]): PackArtifact {
    if (this.ids.has(id)) throw new Error(`pack artifact is duplicated: ${id}`);
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(id) || !/^[a-z][a-z0-9._-]{0,63}$/.test(kind)) {
      throw new Error(`invalid pack artifact identity: ${id}/${kind}`);
    }
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (!bytes.byteLength) throw new Error(`pack artifact is empty: ${id}`);
    const digest = sha256(bytes);
    const compressed = gzipSync(bytes, { level: 9 });
    const useCompression = compressed.byteLength + 1024 < bytes.byteLength;
    const chunkBytes = useCompression ? compressed : bytes;
    const chunkDigest = sha256(chunkBytes);
    const chunkPath = `chunks/${id}-${chunkDigest.slice(0, 16)}.bin${useCompression ? '.gz' : ''}`;
    writeFileSync(join(this.directory, ...chunkPath.split('/')), chunkBytes);
    const artifact = Object.freeze({
      id,
      kind,
      size: bytes.byteLength,
      sha256: digest,
      ...(files === undefined ? {} : { files: Object.freeze(files.map((file) => Object.freeze({ ...file }))) }),
      chunks: Object.freeze([Object.freeze({
        path: chunkPath,
        size: bytes.byteLength,
        sha256: digest,
        ...(useCompression ? {
          compression: 'gzip' as const,
          compressedSize: chunkBytes.byteLength,
          compressedSha256: chunkDigest,
        } : {}),
      })]),
    });
    this.ids.add(id);
    this.artifacts.push(artifact);
    return artifact;
  }

  finish(): Readonly<{ manifest: object; revision: string; totalBytes: number; downloadBytes: number }> {
    const artifacts = sortPackArtifactsForManifest(this.artifacts);
    const revisionInput = JSON.stringify({
      schema: 2,
      id: this.id,
      version: this.version,
      artifacts,
    });
    const revision = sha256(new TextEncoder().encode(revisionInput));
    const manifest = {
      schema: 2,
      id: this.id,
      version: this.version,
      revision,
      artifacts,
    };
    writeJson(join(this.directory, 'toolchain.json'), manifest);
    return Object.freeze({
      manifest,
      revision,
      totalBytes: artifacts.reduce((total, artifact) => total + artifact.size, 0),
      downloadBytes: artifacts.reduce((total, artifact) => total + artifact.chunks.reduce(
        (chunkTotal, chunk) => chunkTotal + (chunk.compressedSize ?? chunk.size),
        0,
      ), 0),
    });
  }
}

class ArchiveStripper {
  private sequence = 0;
  private inputBytes = 0;
  private outputBytes = 0;
  private repairCount = 0;

  constructor(
    private readonly directory: string,
    private readonly strip: string,
    private readonly rewrites: readonly ('strip-debug' | 'deterministic-archives')[],
    private readonly c5ClicVectorRepair?: ArchiveSectionRepair,
  ) {
    mkdirSync(directory, { recursive: true });
  }

  add(plan: PackTreePlan, source: string, destination: string): void {
    requireRegularFile(source, 'link archive');
    if (!source.endsWith('.a') || !destination.endsWith('.a')) {
      throw new Error(`link input is not an archive: ${source}`);
    }
    const target = join(
      this.directory,
      `${String(this.sequence++).padStart(3, '0')}-${basename(source)}`,
    );
    copyFileSync(source, target);
    const repairClicVectorFlags = this.c5ClicVectorRepair !== undefined
      && destination === C5_CLIC_VECTOR_ARCHIVE_PATH;
    if (repairClicVectorFlags) {
      assertC5ClicVectorSectionFlags(this.c5ClicVectorRepair!.readelf, target, '');
      runText(
        this.c5ClicVectorRepair!.objcopy,
        ['--set-section-flags', `${C5_CLIC_VECTOR_SECTION}=alloc,load,readonly,code,contents`, target],
        this.directory,
        `repair ${C5_CLIC_VECTOR_SECTION} flags in ${basename(source)}`,
      );
    }
    runText(
      this.strip,
      [
        ...this.rewrites.map((rewrite) => rewrite === 'strip-debug'
          ? '--strip-debug'
          : '--enable-deterministic-archives'),
        target,
      ],
      this.directory,
      `strip debug data from ${basename(source)}`,
    );
    if (repairClicVectorFlags) {
      assertC5ClicVectorSectionFlags(this.c5ClicVectorRepair!.readelf, target, 'AX');
      this.repairCount++;
    }
    requireRegularFile(target, 'stripped link archive');
    const inputSize = lstatSync(source).size;
    const outputSize = lstatSync(target).size;
    if (!outputSize) {
      throw new Error(`stripped archive has an invalid size: ${source}`);
    }
    this.inputBytes += inputSize;
    this.outputBytes += outputSize;
    plan.addFile(target, destination);
  }

  assertComplete(): void {
    if (this.c5ClicVectorRepair && this.repairCount !== 1) {
      throw new Error(`expected exactly one repaired ${C5_CLIC_VECTOR_ARCHIVE_PATH}; found ${this.repairCount}`);
    }
  }

  summary(): Readonly<{ inputBytes: number; outputBytes: number; savedBytes: number }> {
    this.assertComplete();
    return Object.freeze({
      inputBytes: this.inputBytes,
      outputBytes: this.outputBytes,
      savedBytes: this.inputBytes - this.outputBytes,
    });
  }
}

function readC5ClicVectorSectionFlags(readelf: string, archive: string): string {
  const output = runText(
    readelf,
    ['-SW', archive],
    dirname(archive),
    `inspect ${C5_CLIC_VECTOR_SECTION} flags in ${basename(archive)}`,
  );
  let member: string | undefined;
  const matches: Array<Readonly<{ member?: string; flags: string }>> = [];
  for (const line of output.split(/\r?\n/)) {
    const memberMatch = /^File: .+\(([^()]+)\)\s*$/.exec(line);
    if (memberMatch) {
      member = memberMatch[1];
      continue;
    }
    const sectionMatch = /^\s*\[\s*\d+\]\s+\.exception_vectors_table\.text\s+PROGBITS\s+[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+(?:(\S+)\s+)?\d+\s+\d+\s+\d+\s*$/i.exec(line);
    if (sectionMatch) matches.push(Object.freeze({ member, flags: sectionMatch[1] ?? '' }));
  }
  if (matches.length !== 1 || matches[0]!.member !== C5_CLIC_VECTOR_MEMBER) {
    throw new Error(
      `expected exactly one ${C5_CLIC_VECTOR_SECTION} in ${C5_CLIC_VECTOR_MEMBER}; found ${matches.length}`,
    );
  }
  return matches[0]!.flags;
}

function assertC5ClicVectorSectionFlags(readelf: string, archive: string, expected: '' | 'AX'): void {
  const actual = readC5ClicVectorSectionFlags(readelf, archive);
  if (actual !== expected) {
    throw new Error(
      `${C5_CLIC_VECTOR_SECTION} flags must be ${expected || 'empty'}; found ${actual || 'empty'}`,
    );
  }
}

export function parseArgs(args: string[]): { compiler?: string; out?: string; board: RuntimeTargetKey; help: boolean } {
  if (args.includes('--help')) return { board: 'esp32c3', help: true };
  let compiler: string | undefined;
  let out: string | undefined;
  let board: RuntimeTargetKey = 'esp32c3';
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === '--compiler') compiler = args[++index];
    else if (value === '--out') out = args[++index];
    else if (value === '--board') {
      const candidate = args[++index];
      if (!candidate || !Object.prototype.hasOwnProperty.call(RUNTIME_TARGETS, candidate)) {
        throw new Error(`unsupported or missing --board value: ${candidate ?? 'none'}`);
      }
      board = candidate as RuntimeTargetKey;
    }
    else if (!value.startsWith('-') && compiler === undefined) compiler = value;
    else throw new Error(`unknown or incomplete argument: ${value}`);
  }
  return { compiler, out, board, help: false };
}

function sha256(value: Bytes): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function requireRegularFile(path: string, label: string): void {
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error(`${label} is missing: ${path}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${path}`);
}

function requireDirectory(path: string, label: string): void {
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error(`${label} is missing: ${path}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a directory: ${path}`);
}

function copyRegularAsset(source: string, destination: string, label: string): void {
  requireRegularFile(source, label);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function copyAssetDirectory(source: string, destination: string, label: string): void {
  requireDirectory(source, label);
  const walk = (current: string, target: string): void => {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const sourcePath = join(current, entry.name);
      const targetPath = join(target, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${sourcePath}`);
      if (entry.isDirectory()) walk(sourcePath, targetPath);
      else if (entry.isFile()) copyRegularAsset(sourcePath, targetPath, label);
      else throw new Error(`${label} contains an unsupported entry: ${sourcePath}`);
    }
  };
  walk(source, destination);
}

export function contentAddressedCompilerManifestPath(packId: string, revision: string): string {
  if (!PACK_IDENTIFIER.test(packId) || !PACK_REVISION.test(revision)) {
    throw new TypeError('compiler Pack content address is invalid');
  }
  return `../toolchains/${packId}/${revision}/toolchain.json`;
}

export function contentAddressedRuntimePackManifestPath(packId: string, revision: string): string {
  if (!PACK_IDENTIFIER.test(packId) || !PACK_REVISION.test(revision)) {
    throw new TypeError('runtime Pack content address is invalid');
  }
  return `../packs/${packId}/${revision}/toolchain.json`;
}

function publishContentAddressedCompilerPack({
  source,
  publicationRoot,
  packId,
  revision,
}: {
  source: string;
  publicationRoot: string;
  packId: string;
  revision: string;
}): string {
  requireDirectory(source, 'compiler Pack staging directory');
  const manifest = contentAddressedCompilerManifestPath(packId, revision);
  const destination = join(publicationRoot, 'toolchains', packId, revision);
  ensureWorkspaceChild(publicationRoot, destination, 'shared compiler Pack');
  if (existsSync(destination)) {
    requireDirectory(destination, 'shared compiler Pack');
    const staged = directoryIdentity(source);
    const published = directoryIdentity(destination);
    if (
      staged.sha256 !== published.sha256
      || staged.files !== published.files
      || staged.bytes !== published.bytes
    ) {
      throw new Error(`immutable compiler Pack address already contains different bytes: ${destination}`);
    }
    rmSync(source, { recursive: true, force: true });
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
  }
  return manifest;
}

function publishContentAddressedRuntimePack({
  source,
  publicationRoot,
  packId,
  revision,
}: {
  source: string;
  publicationRoot: string;
  packId: string;
  revision: string;
}): string {
  requireDirectory(source, 'runtime Pack staging directory');
  const manifest = contentAddressedRuntimePackManifestPath(packId, revision);
  const destination = join(publicationRoot, 'packs', packId, revision);
  ensureWorkspaceChild(publicationRoot, destination, 'content-addressed runtime Pack');
  if (existsSync(destination)) {
    requireDirectory(destination, 'content-addressed runtime Pack');
    const staged = directoryIdentity(source);
    const published = directoryIdentity(destination);
    if (
      staged.sha256 !== published.sha256
      || staged.files !== published.files
      || staged.bytes !== published.bytes
    ) {
      throw new Error(`immutable runtime Pack address already contains different bytes: ${destination}`);
    }
    rmSync(source, { recursive: true, force: true });
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
  }
  return manifest;
}

function directoryIdentity(root: string): Readonly<{ files: number; bytes: number; sha256: string }> {
  requireDirectory(root, 'content-addressed directory');
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`content-addressed directory contains a symbolic link: ${path}`);
      if (entry.isDirectory()) walk(path, name);
      else if (entry.isFile()) {
        const body = readFileSync(path);
        hash.update(name).update('\0').update(body).update('\0');
        files += 1;
        bytes += body.byteLength;
      } else throw new Error(`content-addressed directory contains an unsupported entry: ${path}`);
    }
  };
  walk(root, '');
  return Object.freeze({ files, bytes, sha256: hash.digest('hex') });
}

function writeRuntimeProvenance({
  output,
  compilerRoot,
  esp32,
  toolchainRoot,
  sdkRoot,
  sourceLock,
  target,
}: {
  output: string;
  compilerRoot: string;
  esp32: NonNullable<ReturnType<typeof detectLocalToolchain>['esp32']>;
  toolchainRoot: string;
  sdkRoot: string;
  sourceLock: string;
  target: RuntimeTarget;
}): void {
  const licenseRoot = join(output, 'licenses');
  mkdirSync(licenseRoot, { recursive: true });

  // Keep the compiler's own and bundled upstream notices beside the runtime.
  copyRegularAsset(join(compilerRoot, 'LICENSE.txt'), join(licenseRoot, 'compiler', 'YoWASP-Clang-LICENSE.txt'), 'compiler license');
  copyRegularAsset(join(compilerRoot, 'THIRD_PARTY_NOTICES.md'), join(licenseRoot, 'compiler', 'THIRD_PARTY_NOTICES.md'), 'compiler third-party notices');
  if (existsSync(join(compilerRoot, 'licenses'))) {
    copyAssetDirectory(join(compilerRoot, 'licenses'), join(licenseRoot, 'compiler', 'upstream'), 'compiler upstream licenses');
  }

  // GCC/newlib ships a complete license directory with the Arduino toolchain.
  copyAssetDirectory(
    join(toolchainRoot, 'share', 'licenses'),
    join(licenseRoot, target.toolchainLicenseId, 'share'),
    `Espressif ${target.toolchainLabel} toolchain licenses`,
  );

  // Arduino-ESP32 has no root license file in the installed package. Include
  // the package's declared LGPL text and the third-party notices that are
  // physically present in the core/library inputs used by this runtime.
  copyRegularAsset(
    join(resolve(process.cwd()), 'toolchains', target.sourceBundleDir, 'licenses', 'Arduino-ESP32-LGPL-2.1-or-later.txt'),
    join(licenseRoot, 'arduino-esp32', 'LGPL-2.1-or-later.txt'),
    'Arduino-ESP32 LGPL license',
  );
  copyRegularAsset(join(esp32.coreDir, 'libb64', 'LICENSE'), join(licenseRoot, 'arduino-esp32', 'libb64-LICENSE'), 'Arduino core libb64 license');
  const bleLicense = join(esp32.platformDir, 'libraries', 'BLE', 'LICENSE');
  if (existsSync(bleLicense)) copyRegularAsset(bleLicense, join(licenseRoot, 'arduino-esp32', 'BLE-LICENSE'), 'Arduino BLE license');

  copyAssetDirectory(
    join(resolve(process.cwd()), 'toolchains', target.sourceBundleDir, 'licenses', 'sdk-spdx'),
    join(licenseRoot, 'esp-idf', 'spdx'),
    'ESP-IDF SPDX license texts',
  );
  writeFileSync(join(licenseRoot, 'esp-idf', 'SPDX-INVENTORY.md'), [
    `# ${target.label} SDK SPDX inventory`,
    '',
    `The installed ${target.label} SDK headers declare these identifiers:`,
    '',
    '- Apache-2.0',
    '- Apache-2.0 OR GPL-2.0-or-later',
    '- BSD-2-Clause-FreeBSD AND Apache-2.0',
    '- BSD-3-Clause',
    '- ISC',
    '- MIT',
    '- Unlicense OR CC0-1.0',
    '',
    `Standard texts are in spdx/. Exact component versions and corresponding sources are listed in provenance/${target.key}-sdk-versions.txt.`,
    '',
  ].join('\n'), 'utf8');

  copyRegularAsset(join(sdkRoot, 'versions.txt'), join(output, 'provenance', `${target.key}-sdk-versions.txt`), `${target.label} SDK versions`);
  copyRegularAsset(join(sdkRoot, 'sdkconfig'), join(output, 'provenance', `${target.key}-sdkconfig`), `${target.label} SDK config`);
  writeFileSync(join(output, 'provenance', 'source-lock.json'), sourceLock, 'utf8');
  const sourceMetadata = JSON.parse(sourceLock);
  const compilerRepository = sourceMetadata.compiler.repository.replace(/\.git$/, '');
  const compilerRevision = sourceMetadata.compiler.revision;
  writeFileSync(join(output, 'source-offer.md'), [
    `# ${target.label} browser runtime source offer`,
    '',
    'This runtime contains the compiler, Arduino core, ESP-IDF archives, and GCC/newlib runtime inputs listed below.',
    'Available upstream and SPDX license texts are shipped under `licenses/`; source snapshots and exact revisions are recorded under `provenance/`.',
    '',
    `- Browser Clang/LLD: ${compilerRepository}/tree/${compilerRevision}`,
    '- LLVM submodule: https://github.com/llvm/llvm-project (revision is in provenance/source-lock.json)',
    '- wasi-libc submodule: https://github.com/WebAssembly/wasi-libc (revision is in provenance/source-lock.json)',
    '- Arduino-ESP32: https://github.com/espressif/arduino-esp32 (version 3.3.7)',
    `- ESP-IDF/${target.label.slice(6)} SDK component sources: https://github.com/espressif/esp-idf (component revisions are in provenance/${target.key}-sdk-versions.txt)`,
    `- Espressif ${target.toolchainLabel} GCC/newlib: https://github.com/espressif/crosstool-NG (toolchain package 2511)`,
    '',
    'For a complete corresponding-source request, provide the runtime descriptor SHA-256 and compiler/SDK pack revisions from runtime.json.',
    '',
  ].join('\n'), 'utf8');
}

function runtimeSourceLock(
  sourcePath: string,
  fqbn: string,
  execution: CompilerExecutionMetadata,
): string {
  requireRegularFile(sourcePath, 'compiler source lock');
  let value: any;
  try {
    value = JSON.parse(readFileSync(sourcePath, 'utf8'));
  } catch (error) {
    throw new Error(`compiler source lock is invalid JSON: ${String((error as Error)?.message ?? error)}`);
  }
  if (
    value?.schema !== 1
    || typeof value.status !== 'string'
    || !value.compiler
    || typeof value.compiler !== 'object'
    || typeof value.compiler.repository !== 'string'
    || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.compiler.repository)
    || typeof value.compiler.revision !== 'string'
    || !/^[a-f0-9]{40}$/.test(value.compiler.revision)
    || !value.sdk
    || typeof value.sdk !== 'object'
  ) {
    throw new Error('compiler source lock has an invalid shape');
  }
  const {
    target: _previousTarget,
    march: _previousMarch,
    mabi: _previousMabi,
    mcpu: _previousCpu,
    ...sdkMetadata
  } = value.sdk;
  const argument = (prefix: string): string | undefined => execution.targetArguments
    .find((candidate) => candidate.startsWith(prefix))
    ?.slice(prefix.length);
  return `${JSON.stringify({
    ...value,
    sdk: {
      ...sdkMetadata,
      arduinoEsp32Version: SDK_VERSION,
      board: fqbn,
      target: execution.targetTriple,
      ...(argument('-march=') ? { march: argument('-march=') } : {}),
      ...(argument('-mabi=') ? { mabi: argument('-mabi=') } : {}),
      ...(argument('-mcpu=') ? { mcpu: argument('-mcpu=') } : {}),
    },
  }, null, 2)}\n`;
}

function ensureWorkspaceChild(root: string, child: string, label: string): void {
  const value = relative(root, child);
  if (!value || value === '..' || value.startsWith(`..${sep}`) || resolve(root, value) !== child) {
    throw new Error(`${label} must stay inside the workspace: ${child}`);
  }
}

function validatePackTreePath(value: string): void {
  const segments = value.split('/');
  if (
    !value
    || value.startsWith('/')
    || segments.some((segment) => !/^[A-Za-z0-9._+-]+$/.test(segment)
      || segment === '.' || segment === '..'
      || segment === '__proto__' || segment === 'prototype' || segment === 'constructor')
  ) throw new Error(`invalid Pack tree path: ${value}`);
}

function compilerTarball(path: string): string {
  const resolved = resolve(path);
  try {
    if (lstatSync(resolved).isFile()) {
      if (!resolved.endsWith('.tgz')) throw new Error(`compiler artifact is not a .tgz: ${resolved}`);
      return resolved;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('not a .tgz')) throw error;
  }
  requireDirectory(resolved, 'compiler artifact directory');
  const candidates = readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
    .map((entry) => join(resolved, entry.name));
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one compiler .tgz in ${resolved}, found ${candidates.length}`);
  }
  return candidates[0]!;
}

function executable(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function runText(command: string, args: string[], cwd: string, label: string): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: MAX_COMMAND_OUTPUT,
    });
  } catch (error) {
    throw new Error(`${label} failed: ${String((error as Error)?.message ?? error)}`);
  }
}

function toolchainIdentity(paths: string[], target: RuntimeTarget): string {
  const hash = createHash('sha256').update(`browser-${target.key}-runtime-pack-v1\0`);
  for (const path of paths) hash.update(path).update('\0').update(readFileSync(path)).update('\0');
  return hash.digest('hex');
}

export function runtimeToolchainLocation(
  esp32: NonNullable<ReturnType<typeof detectLocalToolchain>['esp32']>,
  target: RuntimeTarget,
): Readonly<{ binDir: string; rootDir: string }> {
  const binDir = target.architecture === 'riscv' ? esp32.riscvBinDir : esp32.xtensaBinDir;
  const rootDir = target.architecture === 'riscv' ? esp32.riscvRootDir : esp32.xtensaRootDir;
  if (!binDir || !rootDir) {
    throw new Error(`${target.label} ${target.toolchainLabel} Arduino toolchain is not installed`);
  }
  return Object.freeze({ binDir, rootDir });
}

export function runtimeIncludeLayout(toolchainRoot: string, gccTriple: string, version: string) {
  return Object.freeze({
    cxxInclude: join(toolchainRoot, gccTriple, 'include', 'c++', version),
    gccInclude: join(toolchainRoot, 'lib', 'gcc', gccTriple, version, 'include'),
    gccIncludeFixed: join(toolchainRoot, 'lib', 'gcc', gccTriple, version, 'include-fixed'),
    sysrootInclude: join(toolchainRoot, gccTriple, 'include'),
  });
}

export function runtimeLibraryQueryArgs(target: RuntimeTarget, name: string): string[] {
  return [...target.gccLibraryArgs, `-print-file-name=${name}`];
}

export function resolveSdkLinkerInputPaths(sdkRoot: string, memoryType: string) {
  const memoryLd = join(sdkRoot, 'ld', 'memory.ld');
  requireRegularFile(memoryLd, 'SDK memory.ld');
  const sectionCandidates = [
    join(sdkRoot, 'ld', 'sections.ld'),
    join(sdkRoot, memoryType, 'sections.ld'),
  ].filter((path) => existsSync(path));
  if (sectionCandidates.length !== 1) {
    throw new Error(
      `expected exactly one SDK sections.ld for ${memoryType}; found ${sectionCandidates.length}`,
    );
  }
  requireRegularFile(sectionCandidates[0]!, 'SDK sections.ld');
  return Object.freeze({ memoryLd, sectionsLd: sectionCandidates[0]! });
}

function resolveRuntimeInputs(gpp: string, toolchainRoot: string, cwd: string, target: RuntimeTarget) {
  const version = runText(gpp, ['-dumpfullversion', '-dumpversion'], cwd, 'read Espressif GCC version')
    .trim().split(/\r?\n/).find(Boolean);
  if (!version || !/^\d+(?:\.\d+){1,3}$/.test(version)) {
    throw new Error(`Espressif GCC returned an invalid version: ${version ?? 'none'}`);
  }
  const { cxxInclude, gccInclude, gccIncludeFixed, sysrootInclude } = runtimeIncludeLayout(
    toolchainRoot,
    target.gccTriple,
    version,
  );
  [cxxInclude, gccInclude, gccIncludeFixed, sysrootInclude]
    .forEach((path) => requireDirectory(path, 'Espressif runtime include directory'));

  const names = ['libgcc.a', 'libstdc++.a', 'libc.a', 'libm.a'];
  const paths = names.map((name) => {
    const path = resolve(runText(
      gpp,
      runtimeLibraryQueryArgs(target, name),
      cwd,
      `find ${target.label} ${name}`,
    ).trim());
    requireRegularFile(path, `Espressif runtime ${name}`);
    return path;
  });
  const sourceDirectories: string[] = [];
  const libraries = paths.map((source) => {
    const sourceDirectory = dirname(source);
    let index = sourceDirectories.indexOf(sourceDirectory);
    if (index < 0) {
      index = sourceDirectories.length;
      sourceDirectories.push(sourceDirectory);
    }
    return Object.freeze({ source, virtual: `runtime/lib/${index}/${basename(source)}` });
  });
  return Object.freeze({
    cxxInclude,
    gccInclude,
    gccIncludeFixed,
    sysrootInclude,
    cxxVirtualRoot: `runtime/include/c++/${version}`,
    gccIncludeVirtual: 'runtime/gcc/include',
    gccIncludeFixedVirtual: 'runtime/gcc/include-fixed',
    sysrootIncludeVirtual: 'runtime/sysroot/include',
    libraryDirectories: Object.freeze(sourceDirectories.map((source, index) => Object.freeze({
      source,
      virtual: `runtime/lib/${index}`,
    }))),
    libraries: Object.freeze(libraries),
  });
}

type CommandOverlaySlot = Readonly<{ id: string; index: number }>;
type PlatformCommand = Readonly<{ args: readonly string[]; overlaySlots: readonly CommandOverlaySlot[] }>;
type CompileLanguage = 'c' | 'cxx' | 'asm';
type PlatformCompileLanguageFlags = Readonly<Record<CompileLanguage, readonly string[]>>;
type PlatformCompileCommand = PlatformCommand & Readonly<{
  languageFlags: PlatformCompileLanguageFlags;
}>;
type BoardCommandOverlay = Readonly<Record<string, readonly string[]>>;

type RuntimeRecipeLoweringV2 = Omit<CKPlatformManifest['recipeLowering'], 'schemaVersion' | 'bindings'> & Readonly<{
  schemaVersion: 2;
  bindings: Readonly<{
    compile: Readonly<Record<CompileLanguage, string>>;
    archive: string;
    link: string;
  }>;
}>;

export type CompilerExecutionMetadata = CKCompilerExecutionMetadata;

function requireRuntimeRecipeLoweringV2(value: unknown): RuntimeRecipeLoweringV2 {
  const candidate = value as Partial<RuntimeRecipeLoweringV2> | undefined;
  const compile = candidate?.bindings?.compile;
  if (candidate?.schemaVersion !== 2 || !compile || typeof compile !== 'object'
    || Array.isArray(compile)
    || (['c', 'cxx', 'asm'] as const).some((language) => (
      typeof compile[language] !== 'string' || !compile[language]!.trim()
    ))) {
    throw new Error('Platform runtime requires recipe lowering schema 2 language compile bindings');
  }
  return candidate as RuntimeRecipeLoweringV2;
}

function freezeCompileLanguageFlags(value: unknown): PlatformCompileLanguageFlags {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== 'asm\0c\0cxx') {
    throw new Error('Platform compile language flags are invalid');
  }
  const flags = value as Record<CompileLanguage, unknown>;
  const normalized = Object.fromEntries((['c', 'cxx', 'asm'] as const).map((language) => {
    const languageFlags = flags[language];
    if (!Array.isArray(languageFlags) || !languageFlags.length
      || languageFlags.some((flag) => typeof flag !== 'string' || !flag)) {
      throw new Error(`Platform ${language} compile language flags are invalid`);
    }
    return [language, Object.freeze([...languageFlags])];
  })) as Record<CompileLanguage, readonly string[]>;
  return Object.freeze(normalized);
}

function resolveRequiredProperty(
  properties: Readonly<Record<string, string>>,
  key: string,
): string {
  const raw = properties[key];
  if (typeof raw !== 'string') throw new Error(`resolved Platform property is missing: ${key}`);
  const value = expandPlatformProperty(properties, raw).value.trim();
  if (!value || /\{[^{}]+\}/.test(value)) throw new Error(`resolved Platform property is incomplete: ${key}`);
  return value;
}

function resolveCompilerRuntimeInclude(
  runtime: any,
  targetTriple: string,
  role: string,
): string {
  const paths: Record<string, string> = {
    cxx: runtime.cxxVirtualRoot,
    'cxx-target': `${runtime.cxxVirtualRoot}/${targetTriple}`,
    'cxx-backward': `${runtime.cxxVirtualRoot}/backward`,
    gcc: runtime.gccIncludeVirtual,
    'gcc-fixed': runtime.gccIncludeFixedVirtual,
    sysroot: runtime.sysrootIncludeVirtual,
  };
  const path = paths[role];
  if (typeof path !== 'string' || !path) throw new Error(`Platform recipe lowering references unsupported compiler runtime role: ${role}`);
  return path;
}

export function deriveCompilerExecutionMetadata(
  resolved: ResolvedPlatformManifest,
  compilerFlags: string,
): CompilerExecutionMetadata {
  const tarch = resolveRequiredProperty(resolved.properties, 'build.tarch');
  const mcu = resolveRequiredProperty(resolved.properties, 'build.mcu');
  const flags = tokenizeRecipe(compilerFlags);
  let targetTriple: string;
  let boardArguments: string[];
  if (tarch === 'xtensa') {
    targetTriple = 'xtensa-esp-elf';
    boardArguments = [`-mcpu=${mcu}`];
  } else if (tarch === 'riscv32') {
    targetTriple = 'riscv32-esp-elf';
    const march = flags.find((flag) => flag.startsWith('-march='));
    const mabi = flags.find((flag) => flag.startsWith('-mabi='));
    if (!march || !mabi) throw new Error(`${resolved.board.fqbn} SDK flags omit the RISC-V ISA or ABI`);
    boardArguments = [march, mabi];
  } else {
    throw new Error(`${resolved.board.fqbn} uses unsupported compiler architecture ${tarch}`);
  }
  const mabi = boardArguments.find((argument) => argument.startsWith('-mabi='))?.slice(6) ?? '';
  return Object.freeze({
    targetTriple,
    targetArguments: Object.freeze([`--target=${targetTriple}`, ...boardArguments]),
    elf: Object.freeze({
      machine: targetTriple.startsWith('riscv32-') ? 243 : 94,
      floatAbi: mabi.endsWith('d') ? 0x4 : mabi.endsWith('f') ? 0x2 : 0,
    }),
  });
}

export function derivePlatformCommands(input: {
  manifest: CKPlatformManifest;
  resolved: ResolvedPlatformManifest;
  runtime: any;
  compilerFlags: string;
}): Readonly<{
  compile: PlatformCompileCommand;
  link: PlatformCommand;
  overlay: Readonly<{ compile: BoardCommandOverlay; link: BoardCommandOverlay }>;
  execution: CompilerExecutionMetadata;
}> {
  const execution = deriveCompilerExecutionMetadata(input.resolved, input.compilerFlags);
  const manifestLowering = requireRuntimeRecipeLoweringV2(input.manifest.recipeLowering);
  const lowering = requireRuntimeRecipeLoweringV2(input.resolved.recipeLowering);
  if (lowering.sha256 !== manifestLowering.sha256) {
    throw new Error('resolved Platform recipe lowering contract does not match its Manifest');
  }
  const properties = {
    ...input.resolved.properties,
    'runtime.ide.version': ARDUINO_VERSION_DEFINE,
    'runtime.os': 'wasm',
    'build.fqbn': input.resolved.board.fqbn,
    'build.arch': input.manifest.architecture.toUpperCase(),
    'build.path': '.',
    'build.project_name': 'firmware',
    'build.source.path': 'core',
    'compiler.path': '',
    'compiler.prefix': '',
    'compiler.sdk.path': 'sdk',
    'source_file': 'sketch.cpp',
    'object_file': 'sketch.o',
    'object_files': 'sketch.o',
    'archive_file_path': 'core.a',
    'includes': '',
    'file_opts.path': '',
    'build.opt.path': '',
  };
  const recipeCommands = derivePlatformRecipeCommands({
    recipes: input.manifest.recipes,
    recipeLowering: lowering,
    properties,
  });
  const compileRecipes = recipeCommands.compile;
  const linkExpanded = [...recipeCommands.link];
  linkExpanded[0] = Object.freeze({ value: 'clang++', dependencies: linkExpanded[0]!.dependencies });

  const compileArgs: string[] = ['clang++', `--target=${execution.targetTriple}`, '-c'];
  const compileOverlay: Record<string, string[]> = { target: [], defines: [], memory: [], variant: ['-Ivariant'] };
  const compileSlots: CommandOverlaySlot[] = [{ id: 'target', index: 2 }];
  compileOverlay.target.push(...execution.targetArguments.slice(1));
  for (const argument of compileRecipes.common) {
    let value = argument.value === './firmware.elf' ? 'firmware.elf' : argument.value;
    if (value.startsWith('-DARDUINO_BOARD=') && !value.startsWith('-DARDUINO_BOARD="')) {
      value = `-DARDUINO_BOARD="${value.slice('-DARDUINO_BOARD='.length)}"`;
    }
    if (value.startsWith('-DARDUINO_VARIANT=') && !value.startsWith('-DARDUINO_VARIANT="')) {
      value = `-DARDUINO_VARIANT="${value.slice('-DARDUINO_VARIANT='.length)}"`;
    }
    if (value === `--target=${execution.targetTriple}` || execution.targetArguments.slice(1).includes(value)) continue;
    const slot = hasPlatformPropertyDependency(argument, 'build.memory_type') && /^-Isdk\/[A-Za-z0-9._+-]+\/include$/.test(argument.value)
      ? 'memory'
      : value !== '-DESP32=ESP32'
        && [...argument.dependencies].some((key) => key.startsWith('build.') && key !== 'build.source.path')
        ? 'defines'
        : undefined;
    if (slot) {
      if (!compileOverlay[slot]!.length) compileSlots.push({ id: slot, index: compileArgs.length });
      compileOverlay[slot]!.push(value);
    } else {
      compileArgs.push(value);
    }
  }
  const sourceIndex = compileArgs.indexOf('sketch.cpp');
  if (sourceIndex < 0) throw new Error('lowered Platform compile recipe omits sketch.cpp');
  compileSlots.push({ id: 'variant', index: sourceIndex });
  const compileCompatibilityArgs = [
    ...(lowering.compatibility.compiler.disableBuiltinCxxIncludes ? ['-nostdinc++'] : []),
    ...lowering.compatibility.compiler.runtimeIncludes.flatMap((include) => [
      include.flag,
      resolveCompilerRuntimeInclude(input.runtime, execution.targetTriple, include.role),
    ]),
  ];
  compileArgs.splice(sourceIndex, 0, ...compileCompatibilityArgs);
  for (const slot of compileSlots) {
    if (slot.id === 'variant' || slot.index <= sourceIndex) continue;
    (slot as { index: number }).index += compileCompatibilityArgs.length;
  }

  const linkArgs: string[] = [];
  const linkOverlay: Record<string, string[]> = { target: [], memory: [], flags: [] };
  const linkSlots: CommandOverlaySlot[] = [{ id: 'target', index: 2 }];
  linkOverlay.target.push(...execution.targetArguments.slice(1));
  for (const argument of linkExpanded) {
    const value = argument.value === './firmware.elf' ? 'firmware.elf' : argument.value;
    if (value === `--target=${execution.targetTriple}` || execution.targetArguments.slice(1).includes(value)) continue;
    if (value === 'clang++') {
      linkArgs.push(value, `--target=${execution.targetTriple}`);
      continue;
    }
    const slot = hasPlatformPropertyDependency(argument, 'build.memory_type') && /^-Lsdk\/[A-Za-z0-9._+-]+$/.test(argument.value)
      ? 'memory'
      : (hasPlatformPropertyDependency(argument, 'build.extra_libs')
          || hasPlatformPropertyDependency(argument, 'build.zigbee_libs'))
        ? 'flags'
        : undefined;
    if (slot) {
      if (!linkOverlay[slot]!.length) linkSlots.push({ id: slot, index: linkArgs.length });
      linkOverlay[slot]!.push(value);
    } else {
      linkArgs.push(value);
    }
  }
  const groupIndex = linkArgs.indexOf('-Wl,--start-group');
  if (groupIndex < 0) throw new Error('lowered Platform link recipe omits the linker group');
  const linkerCompatibility = lowering.compatibility.linker;
  const linkCompatibilityArgs = [
    ...(linkerCompatibility.forceLldTargetPrefixes.some((prefix) => execution.targetTriple.startsWith(prefix))
      ? ['-fuse-ld=lld']
      : []),
    ...linkerCompatibility.searchPaths.map((path) => `-L${path}`),
    ...(linkerCompatibility.runtimeLibraryDirectories === 'all'
      ? input.runtime.libraryDirectories.flatMap((directory: { virtual: string }) => [`-L${directory.virtual}`])
      : []),
    ...linkerCompatibility.responseFiles.map((path) => `${lowering.responseFiles.marker}${path}`),
  ];
  linkArgs.splice(groupIndex, 0, ...linkCompatibilityArgs);
  for (const slot of linkSlots) {
    if (slot.index <= groupIndex) continue;
    (slot as { index: number }).index += linkCompatibilityArgs.length;
  }
  if (!compileSlots.some((slot) => slot.id === 'defines')) {
    compileSlots.push({ id: 'defines', index: sourceIndex });
  }
  if (!compileSlots.some((slot) => slot.id === 'memory')) {
    throw new Error('lowered Platform compile recipe omits the SDK memory profile');
  }
  if (!linkSlots.some((slot) => slot.id === 'memory')) {
    throw new Error('lowered Platform link recipe omits the SDK memory profile');
  }
  if (!linkSlots.some((slot) => slot.id === 'flags')) {
    linkSlots.push({ id: 'flags', index: linkArgs.indexOf('-Wl,--end-group') });
  }
  return Object.freeze({
    compile: Object.freeze({
      args: Object.freeze(compileArgs),
      overlaySlots: Object.freeze(compileSlots),
      languageFlags: compileRecipes.languageFlags,
    }),
    link: Object.freeze({ args: Object.freeze(linkArgs), overlaySlots: Object.freeze(linkSlots) }),
    overlay: Object.freeze({
      compile: Object.freeze(Object.fromEntries(Object.entries(compileOverlay).map(([key, value]) => [key, Object.freeze(value)]))),
      link: Object.freeze(Object.fromEntries(Object.entries(linkOverlay).map(([key, value]) => [key, Object.freeze(value)]))),
    }),
    execution,
  });
}

export function resolvePlatformDefaultsFromBoard(
  manifest: CKPlatformManifest,
  fqbn: string,
  legacyDefaults: Readonly<Record<string, string>>,
): ResolvedPlatformManifest {
  const accepted: Record<string, string> = {};
  for (const [name, value] of Object.entries(legacyDefaults).sort(([left], [right]) => left.localeCompare(right))) {
    try {
      resolvePlatformManifest({ manifest, fqbn, options: { [name]: value } });
      accepted[name] = value;
    } catch (error) {
      if (!(error instanceof Error) || !/unknown platform target option(?: value)?:/.test(error.message)) {
        throw error;
      }
    }
  }
  return resolvePlatformManifest({ manifest, fqbn, options: accepted });
}

export function applyCommandOverlay(command: PlatformCommand, overlay: BoardCommandOverlay): string[] {
  const slotIds = command.overlaySlots.map(({ id }) => id);
  if (new Set(slotIds).size !== slotIds.length
    || Object.keys(overlay).sort().join('\0') !== [...slotIds].sort().join('\0')) {
    throw new Error('Platform command and Board overlay slots do not match');
  }
  const slotsByIndex = new Map<number, CommandOverlaySlot[]>();
  for (const slot of command.overlaySlots) {
    if (!Number.isSafeInteger(slot.index) || slot.index < 1 || slot.index > command.args.length) {
      throw new Error(`Platform command overlay slot is invalid: ${slot.id}`);
    }
    const slots = slotsByIndex.get(slot.index) ?? [];
    slots.push(slot);
    slotsByIndex.set(slot.index, slots);
  }
  const merged: string[] = [];
  for (let index = 0; index <= command.args.length; index++) {
    for (const slot of slotsByIndex.get(index) ?? []) merged.push(...overlay[slot.id]!);
    if (index < command.args.length) merged.push(command.args[index]!);
  }
  return merged;
}

type RuntimeProfileArtifact<Id extends string, Profile> = Readonly<{
  id: Id;
  profile: Profile;
}>;

type CurrentPlatformProfileInput = Omit<
  CKPlatformProfileV5,
  'schema' | 'platformRef' | 'platformManifestArtifact' | 'recipeOrigins' | 'recipeLowering' | 'migration'
>;

type CurrentBoardProfileInput = Omit<CKBoardProfileV4, 'schema' | 'platformRef' | 'migration'>;

export function createPlatformProfileArtifacts(input: Readonly<{
  profile: CurrentPlatformProfileInput;
  platformManifest: CKPlatformManifest;
}>): Readonly<{
  current: RuntimeProfileArtifact<typeof CK_PLATFORM_PROFILE_ARTIFACT_ID, CKPlatformProfileV5>;
  platformManifest: RuntimeProfileArtifact<typeof CK_PLATFORM_MANIFEST_ARTIFACT_ID, CKPlatformManifest>;
}> {
  const manifest = validatePlatformManifest(input.platformManifest);
  const lowering = requireRuntimeRecipeLoweringV2(manifest.recipeLowering);
  const compileLanguageFlags = freezeCompileLanguageFlags(input.profile.compile.languageFlags);
  if (input.profile.sdkVersion !== manifest.version) {
    throw new Error('Platform profile SDK version does not match its shared Platform Manifest');
  }
  for (const recipeId of [
    lowering.bindings.compile.c,
    lowering.bindings.compile.cxx,
    lowering.bindings.compile.asm,
    lowering.bindings.link,
  ]) {
    if (manifest.recipes.filter((recipe) => recipe.id === recipeId).length !== 1) {
      throw new Error(`Shared Platform Manifest must contain exactly one ${recipeId}`);
    }
  }
  if (manifest.tools.length) {
    throw new Error('Platform profile must defer target Compiler Pack binding to sdkVariant');
  }
  validateProfileCommand(input.profile.compile, 'compile');
  validateProfileCommand(input.profile.link, 'link');
  validateSdkVariant(input.profile.sdkVariant);

  const manifestArtifactSha256 = sha256(encodePlatformManifest(manifest));
  const current: CKPlatformProfileV5 = Object.freeze({
    schema: CK_PLATFORM_PROFILE_SCHEMA_VERSION,
    id: input.profile.id,
    sdkVersion: input.profile.sdkVersion,
    compile: Object.freeze({
      ...input.profile.compile,
      languageFlags: compileLanguageFlags,
    }),
    link: Object.freeze({ ...input.profile.link }),
    platformRef: Object.freeze({
      id: manifest.id,
      version: manifest.version,
      sha256: manifest.sha256,
    }),
    platformManifestArtifact: Object.freeze({
      id: CK_PLATFORM_MANIFEST_ARTIFACT_ID,
      sha256: manifestArtifactSha256,
    }),
    sdkVariant: Object.freeze({
      ...input.profile.sdkVariant,
      compilerPack: Object.freeze({ ...input.profile.sdkVariant.compilerPack }),
    }),
    recipeOrigins: Object.freeze({
      compile: lowering.bindings.compile.cxx,
      link: lowering.bindings.link,
    }),
    recipeLowering: Object.freeze({
      status: 'manifest-defined',
      schemaVersion: manifest.recipeLowering.schemaVersion,
      sha256: manifest.recipeLowering.sha256,
    }),
    migration: Object.freeze({
      legacySchema: CK_LEGACY_PLATFORM_PROFILE_SCHEMA_VERSION,
      legacyArtifact: CK_LEGACY_PROFILE_ARTIFACT_ID,
    }),
  });
  return Object.freeze({
    current: Object.freeze({ id: CK_PLATFORM_PROFILE_ARTIFACT_ID, profile: current }),
    platformManifest: Object.freeze({ id: CK_PLATFORM_MANIFEST_ARTIFACT_ID, profile: manifest }),
  });
}

function encodePlatformManifest(manifest: CKPlatformManifest): Uint8Array {
  return new TextEncoder().encode(canonicalJson(manifest));
}

export function createBoardProfileArtifacts(input: Readonly<{
  profile: CurrentBoardProfileInput;
  platformManifest: CKPlatformManifest;
}>): Readonly<{
  current: RuntimeProfileArtifact<typeof CK_BOARD_PROFILE_ARTIFACT_ID, CKBoardProfileV4>;
}> {
  const manifest = requirePlatformManifestBoard(
    validatePlatformManifest(input.platformManifest),
    input.profile.board,
  );
  if (input.profile.sdkVersion !== manifest.version) {
    throw new Error('Board profile SDK version does not match its shared Platform Manifest');
  }
  const board = manifest.boards.find((candidate) => candidate.fqbn === input.profile.board)!;
  if (board.variant !== input.profile.variant) {
    throw new Error('Board profile variant does not match its shared Platform Manifest');
  }
  const resolved = resolvePlatformManifest({
    manifest,
    fqbn: input.profile.board,
    options: { ...input.profile.options },
  });
  if (!sameStringRecord(resolved.options, input.profile.options)) {
    throw new Error('Board profile options are not canonical for its shared Platform Manifest');
  }
  const execution = validateCompilerExecution(input.profile.execution);
  const flashOffsets = validateProfileFlashOffsets(input.profile.flash.offsets);
  const flashModel = validateProfileFlashModel(input.profile.flash.model);

  const current: CKBoardProfileV4 = Object.freeze({
    schema: CK_BOARD_PROFILE_SCHEMA_VERSION,
    id: input.profile.id,
    board: input.profile.board,
    sdkVersion: input.profile.sdkVersion,
    variant: input.profile.variant,
    platformRef: Object.freeze({
      id: manifest.id,
      version: manifest.version,
      sha256: manifest.sha256,
      fqbn: input.profile.board,
    }),
    options: Object.freeze({ ...input.profile.options }),
    artifactIds: Object.freeze([...input.profile.artifactIds]),
    overlay: input.profile.overlay,
    execution,
    image: input.profile.image,
    flash: Object.freeze({
      bootloader: input.profile.flash.bootloader,
      partitions: input.profile.flash.partitions,
      bootApp0: input.profile.flash.bootApp0,
      ...(flashModel ? { model: flashModel } : {}),
      offsets: flashOffsets,
    }),
    migration: Object.freeze({
      legacySchema: CK_LEGACY_BOARD_PROFILE_SCHEMA_VERSION,
      legacyArtifact: CK_LEGACY_PROFILE_ARTIFACT_ID,
    }),
  });
  return Object.freeze({
    current: Object.freeze({ id: CK_BOARD_PROFILE_ARTIFACT_ID, profile: current }),
  });
}

function validateProfileCommand(
  command: CKPlatformCommandProfile,
  label: string,
): void {
  if (!Array.isArray(command.args) || !command.args.length
    || command.args.some((argument) => typeof argument !== 'string' || !argument)) {
    throw new Error(`Platform profile ${label} command is invalid`);
  }
  const slotIds = new Set<string>();
  for (const slot of command.overlaySlots) {
    if (!slot.id || slotIds.has(slot.id) || !Number.isSafeInteger(slot.index)
      || slot.index < 1 || slot.index > command.args.length) {
      throw new Error(`Platform profile ${label} overlay slot is invalid`);
    }
    slotIds.add(slot.id);
  }
  if (!command.artifactIds.length || new Set(command.artifactIds).size !== command.artifactIds.length
    || command.artifactIds.some((id) => !id)) {
    throw new Error(`Platform profile ${label} artifact IDs are invalid`);
  }
}

function validateSdkVariant(value: CKPlatformProfileV5['sdkVariant']): void {
  if (!PACK_IDENTIFIER.test(value.id) || !PACK_IDENTIFIER.test(value.sdkTarget)
    || !PACK_IDENTIFIER.test(value.memoryType) || !PACK_IDENTIFIER.test(value.compilerPack.id)
    || !value.compilerPack.version.trim() || !PACK_REVISION.test(value.compilerPack.sha256)) {
    throw new Error('Platform profile SDK variant is invalid');
  }
}

function validateCompilerExecution(value: CKCompilerExecutionMetadata): CKCompilerExecutionMetadata {
  if (!PACK_IDENTIFIER.test(value.targetTriple) || !Array.isArray(value.targetArguments)
    || value.targetArguments.length < 2
    || value.targetArguments[0] !== `--target=${value.targetTriple}`
    || value.targetArguments.some((argument) => typeof argument !== 'string' || !argument)
    || !Number.isSafeInteger(value.elf.machine) || value.elf.machine <= 0
    || ![0, 0x2, 0x4].includes(value.elf.floatAbi)) {
    throw new Error('Board profile compiler execution metadata is invalid');
  }
  return Object.freeze({
    targetTriple: value.targetTriple,
    targetArguments: Object.freeze([...value.targetArguments]),
    elf: Object.freeze({ machine: value.elf.machine, floatAbi: value.elf.floatAbi }),
  });
}

function validateProfileFlashOffsets(
  value: CKBoardProfileV4['flash']['offsets'],
): CKBoardProfileV4['flash']['offsets'] {
  const offsets = [value.bootloader, value.partitions, value.bootApp0];
  if (offsets.some((offset) => typeof offset !== 'string' || !/^0x[0-9a-f]+$/i.test(offset))
    || new Set(offsets.map((offset) => offset.toLowerCase())).size !== offsets.length) {
    throw new Error('Board profile flash offsets are invalid');
  }
  return Object.freeze({ ...value });
}

function validateProfileFlashModel(
  value: CKBoardProfileV4['flash']['model'],
): CKBoardProfileV4['flash']['model'] {
  if (value === undefined) return undefined;
  if (value.artifactId !== ESP32_SR_MODEL_ARTIFACT_ID
    || value.offset !== ESP32_SR_MODEL_OFFSET
    || value.size !== ESP32_SR_MODEL_SIZE_BYTES
    || value.capacity !== ESP32_SR_MODEL_CAPACITY_BYTES
    || value.size > value.capacity
    || Number(BigInt(value.offset)) + value.capacity > 0x1000000) {
    throw new Error('Board profile ESP SR model metadata is invalid');
  }
  return Object.freeze({ ...value });
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const rightEntries = Object.entries(right).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

export function patchCompilerBundleEnvironment(source: string): string {
  const varsAnchor = 'var Environment = class {\n  vars = {};';
  const varsReplacement = 'var Environment = class {\n  vars = [];';
  const anchor = '    const environment = new Environment();\n    environment.args = [this.#argv0].concat(args);';
  const replacement = `    const environment = new Environment();
    const environmentVariables = options.environment ?? {};
    if (environmentVariables === null || typeof environmentVariables !== "object" || Array.isArray(environmentVariables))
      throw new TypeError("options.environment must be a plain object");
    environment.vars = Object.entries(environmentVariables)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || /[\\0\\r\\n]/.test(value))
        throw new TypeError("options.environment contains an invalid variable");
      return [key, value];
    });
    environment.args = [this.#argv0].concat(args);`;
  const varsMatches = source.split(varsAnchor).length - 1;
  const matches = source.split(anchor).length - 1;
  if (varsMatches !== 1) {
    throw new Error(`compiler bundle Environment.vars patch expected one anchor; found ${varsMatches}`);
  }
  if (matches !== 1) throw new Error(`compiler bundle environment patch expected one anchor; found ${matches}`);
  const patched = source.replace(varsAnchor, varsReplacement).replace(anchor, replacement);
  if (!patched.includes('environment.vars = Object.entries(environmentVariables)')) {
    throw new Error('compiler bundle environment patch verification failed');
  }
  return patched;
}

function addCompileInputs(plan: PackTreePlan, inputs: any): void {
  const { sdkRoot, coreDir, runtime, compatibility, memoryType } = inputs;
  plan.addText('sdk/flags/c_flags', compatibility.cFlags);
  plan.addText('sdk/flags/cpp_flags', compatibility.cppFlags);
  plan.addText('sdk/flags/S_flags', compatibility.sFlags);
  plan.addFile(join(sdkRoot, 'flags', 'defines'), 'sdk/flags/defines');
  plan.addFile(join(sdkRoot, 'flags', 'includes'), 'sdk/flags/includes');
  plan.addDirectory(join(sdkRoot, 'include'), 'sdk/include');
  plan.addDirectory(join(sdkRoot, memoryType, 'include'), `sdk/${memoryType}/include`);
  plan.addDirectory(coreDir, 'core');
  plan.addDirectory(runtime.cxxInclude, runtime.cxxVirtualRoot);
  plan.addDirectory(runtime.gccInclude, runtime.gccIncludeVirtual);
  plan.addDirectory(runtime.gccIncludeFixed, runtime.gccIncludeFixedVirtual);
  plan.addDirectory(runtime.sysrootInclude, runtime.sysrootIncludeVirtual, { excludeRootEntries: ['c++'] });
}

function addLinkInputs(plan: PackTreePlan, inputs: any, archives: ArchiveStripper): void {
  const { sdkRoot, coreArchive, runtime, compatibility, memoryType, ldLibs, target } = inputs;
  plan.addFile(join(sdkRoot, 'flags', 'ld_scripts'), 'sdk/flags/ld_scripts');
  plan.addText('sdk/flags/ld_libs', ldLibs);
  const sdkLib = join(sdkRoot, 'lib');
  requireDirectory(sdkLib, `${target.label} SDK library directory`);
  const entries = readdirSync(sdkLib, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const source = join(sdkLib, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.a')) {
      throw new Error(`${target.label} SDK library directory contains an unexpected entry: ${source}`);
    }
  }
  const includedArchives = new Set(target.selectArchives(entries.map((entry: { name: string }) => entry.name), ldLibs));
  for (const entry of entries) {
    if (!includedArchives.has(entry.name)) continue;
    const source = join(sdkLib, entry.name);
    archives.add(plan, source, `sdk/lib/${entry.name}`);
  }
  plan.addDirectory(join(sdkRoot, 'ld'), 'sdk/ld');
  plan.addDirectory(join(sdkRoot, memoryType), `sdk/${memoryType}`, { excludeRootEntries: ['include'] });
  archives.add(plan, coreArchive, 'core.a');
  plan.addText('sdk/lld-compat/ld_flags', compatibility.ldFlags);
  plan.addText('sdk/lld-compat/memory.ld', compatibility.memoryLd);
  plan.addText('sdk/lld-compat/sections.ld', compatibility.sectionsLd);
  for (const library of runtime.libraries) archives.add(plan, library.source, library.virtual);
}

function readPlanned(file: PackTreeFile): Bytes {
  if (file.bytes) return file.bytes;
  if (!file.source) throw new Error(`Pack tree file has no source: ${file.path}`);
  const bytes = readFileSync(file.source);
  if (bytes.byteLength !== file.size) throw new Error(`Pack tree file changed while packing: ${file.source}`);
  return bytes;
}

function emitPackTrees(plan: PackTreePlan, prefix: string, pack: PackWriter): PackTreeRef[] {
  const files = plan.sorted();
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (!files.length || totalBytes > MAX_PHASE_BYTES) {
    throw new Error(`${prefix} Pack tree is outside its phase limit: ${files.length} files / ${totalBytes} bytes`);
  }
  const batches: PackTreeFile[][] = [];
  let batch: PackTreeFile[] = [];
  let batchBytes = 0;
  for (const file of files) {
    if (batch.length && batchBytes + file.size > MAX_GROUP_BYTES) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(file);
    batchBytes += file.size;
  }
  if (batch.length) batches.push(batch);

  return batches.map((groupFiles, index) => {
    const artifact = `${prefix}-${String(index).padStart(3, '0')}`;
    const size = groupFiles.reduce((total, file) => total + file.size, 0);
    const bytes = new Uint8Array(size);
    const entries: PackArtifactFile[] = [];
    let offset = 0;
    for (const file of groupFiles) {
      const contents = readPlanned(file);
      bytes.set(contents, offset);
      entries.push(Object.freeze({
        path: file.path,
        offset,
        length: contents.byteLength,
        sha256: sha256(contents),
      }));
      offset += contents.byteLength;
    }
    pack.addArtifact(artifact, 'tree', bytes, entries);
    return Object.freeze({ artifactId: artifact, size, fileCount: entries.length });
  });
}

async function extractCompiler(
  tarball: string,
  work: string,
  target: RuntimeTarget,
): Promise<{ root: string; version: string }> {
  const destination = join(work, 'compiler');
  mkdirSync(destination, { recursive: true });
  await extractTar({ file: tarball, cwd: destination, strict: true });
  const root = join(destination, 'package');
  requireDirectory(root, 'compiler package root');
  const packageJson = join(root, 'package.json');
  requireRegularFile(packageJson, 'compiler package metadata');
  const metadata = JSON.parse(readFileSync(packageJson, 'utf8'));
  if (
    metadata.name !== target.compilerPackage
    || typeof metadata.version !== 'string'
    || metadata.type !== 'module'
    || metadata.exports?.default !== './gen/bundle.js'
  ) {
    throw new Error(`unexpected compiler package: ${String(metadata.name)}@${String(metadata.version)}`);
  }
  requireRegularFile(join(root, 'gen', 'bundle.js'), 'compiler bundle');
  for (const resource of COMPILER_RESOURCES) {
    requireRegularFile(join(root, 'gen', resource), `compiler resource ${resource}`);
  }
  return { root, version: metadata.version };
}

export function requirePlatformManifestBoard<T extends {
  boards: Array<{ fqbn: string }>;
}>(manifest: T, fqbn: string): T {
  if (manifest.boards.filter((candidate) => candidate.fqbn === fqbn).length !== 1) {
    throw new Error('runtime target is missing from the shared CK Platform Pack Manifest');
  }
  return manifest;
}

export function deriveStaticFlashOffsets(
  staticParts: readonly Readonly<{ name: string; offset: string }>[],
): Readonly<{ bootloader: string; partitions: string; bootApp0: string }> {
  const required = Object.freeze({
    bootloader: 'bootloader.bin',
    partitions: 'partitions.bin',
    bootApp0: 'boot_app0.bin',
  });
  const offsets: Record<string, string> = {};
  for (const [id, name] of Object.entries(required)) {
    const matches = staticParts.filter((part) => part.name === name);
    if (matches.length !== 1) throw new Error(`static flash profile must contain exactly one ${name}`);
    const offset = matches[0]!.offset;
    if (!/^0x[0-9a-f]+$/i.test(offset)) throw new Error(`static flash profile offset is invalid: ${name}`);
    offsets[id] = offset;
  }
  return Object.freeze({
    bootloader: offsets.bootloader!,
    partitions: offsets.partitions!,
    bootApp0: offsets.bootApp0!,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: npx tsx scripts/build-browser-esp32c3-runtime.ts --compiler <artifact-directory-or-tgz> [--board ${Object.keys(RUNTIME_TARGETS).join('|')}] [--out <runtime-directory>]`);
    return;
  }
  if (!args.compiler) throw new Error('--compiler is required');
  const target = RUNTIME_TARGETS[args.board];

  const workspace = resolve(process.cwd());
  const publicV2 = resolve(workspace, 'packages', 'web', 'public', 'esp32', 'v2');
  const defaultOutput = target.key === 'esp32c3'
    ? join(publicV2, 'runtime')
    : join(workspace, 'var', 'work', `${target.key}-browser-runtime`);
  const output = resolve(args.out ?? defaultOutput);
  const publicationRoot = dirname(output) === publicV2 ? publicV2 : null;
  // An explicit staging output must be self-contained and must not mutate the
  // checked-in runtime tree merely because a candidate is being audited.
  const clangOutput = output === defaultOutput ? join(publicV2, 'clang') : join(output, 'clang');
  ensureWorkspaceChild(workspace, output, 'runtime output');
  ensureWorkspaceChild(workspace, clangOutput, 'Clang output');
  const tarball = compilerTarball(args.compiler);
  const sourceLockPath = join(workspace, 'toolchains', target.sourceBundleDir, 'source-lock.json');
  const work = mkdtempSync(join(tmpdir(), `arduinofast-${target.key}-runtime-`));

  try {
    const compiler = await extractCompiler(tarball, work, target);
    const config = detectLocalToolchain();
    if (!config.esp32) throw new Error('Arduino-ESP32 toolchain is not installed');
    const localToolchain = runtimeToolchainLocation(config.esp32, target);
    const sdkRoot = config.esp32.sdkRootFor(target.sdkTarget);
    if (!sdkRoot || basename(sdkRoot) !== SDK_VERSION) {
      throw new Error(`${target.label} Arduino-ESP32 ${SDK_VERSION} is required; found ${sdkRoot ?? 'none'}`);
    }
    const boards = BoardRegistry.fromDirectory(join(workspace, 'boards'));
    const boardDefinition = boards.get(target.fqbn);
    if (!boardDefinition) throw new Error(`board definition is missing: ${target.fqbn}`);
    const resolvedOptions = resolveOptions(boardDefinition, undefined);
    if (resolvedOptions.errors.length) throw new Error(resolvedOptions.errors.join('; '));
    const board = applyOptions(boardDefinition, resolvedOptions.options);
    const platformText = readFileSync(join(config.esp32.platformDir, 'platform.txt'), 'utf8');
    const boardsText = readFileSync(join(config.esp32.platformDir, 'boards.txt'), 'utf8');
    const programmersPath = join(config.esp32.platformDir, 'programmers.txt');
    const programmersText = existsSync(programmersPath) ? readFileSync(programmersPath, 'utf8') : '';
    const platformFiles = collectPlatformSourceFiles(config.esp32.platformDir);
    const standardPlatformManifest = createPlatformManifest({
      id: 'espressif-arduino',
      version: SDK_VERSION,
      vendor: 'esp32',
      architecture: 'esp32',
      platformText,
      boardsText,
      programmersText,
      files: platformFiles,
      // The data-only .mjs module is runtime-validated by createPlatformManifest;
      // narrow its JavaScript literal inference to the schema-v2 input contract.
      recipeLowering: createEsp32RecipeLoweringInput() as unknown as CreatePlatformManifestInput['recipeLowering'],
      // Compiler Pack identity belongs to the SDK execution profile. Keeping
      // it out of this source manifest gives every FQBN one shared Platform identity.
      runtimeToolPolicy: 'deferred-ck-binding',
    });
    requirePlatformManifestBoard(standardPlatformManifest, target.fqbn);
    const resolvedStandardPlatform = resolvePlatformDefaultsFromBoard(
      standardPlatformManifest,
      target.fqbn,
      resolvedOptions.options,
    );
    const buildProfile = resolveEsp32BuildProfile(board, resolvedOptions.options);
    if (buildProfile.sdkTarget !== target.sdkTarget) {
      throw new Error(`${target.label} SDK target changed: ${buildProfile.sdkTarget}`);
    }
    const memoryType = `${buildProfile.boot}_${buildProfile.psramType}`;
    requireDirectory(join(sdkRoot, memoryType), `${target.label} memory profile`);
    const gpp = join(localToolchain.binDir, executable(`${target.gccDriverPrefix}-g++`));
    const strip = join(localToolchain.binDir, executable(`${target.gccDriverPrefix}-strip`));
    const c5ClicVectorRepair = target.repairClicVectorFlags ? Object.freeze({
      objcopy: join(localToolchain.binDir, executable(`${target.gccTriple}-objcopy`)),
      readelf: join(localToolchain.binDir, executable(`${target.gccTriple}-readelf`)),
    }) : undefined;
    requireRegularFile(gpp, `Espressif ${target.toolchainLabel} g++`);
    requireRegularFile(strip, `Espressif ${target.toolchainLabel} strip`);
    if (c5ClicVectorRepair) {
      requireRegularFile(c5ClicVectorRepair.objcopy, `Espressif ${target.toolchainLabel} objcopy`);
      requireRegularFile(c5ClicVectorRepair.readelf, `Espressif ${target.toolchainLabel} readelf`);
    }

    const baselineDir = join(work, 'baseline');
    mkdirSync(baselineDir, { recursive: true });
    const identity = toolchainIdentity([
      join(sdkRoot, 'versions.txt'), join(sdkRoot, 'sdkconfig'),
      join(sdkRoot, 'flags', 'c_flags'),
      join(sdkRoot, 'flags', 'cpp_flags'), join(sdkRoot, 'flags', 'S_flags'),
      join(sdkRoot, 'flags', 'defines'),
      join(sdkRoot, 'flags', 'includes'), join(sdkRoot, 'flags', 'ld_flags'),
      join(sdkRoot, 'flags', 'ld_libs'), join(sdkRoot, 'flags', 'ld_scripts'),
      join(config.esp32.coreDir, 'Arduino.h'),
      join(config.esp32.variantsDir, board.build.variant, 'pins_arduino.h'),
      gpp, strip, ...(c5ClicVectorRepair
        ? [c5ClicVectorRepair.objcopy, c5ClicVectorRepair.readelf]
        : []), config.esp32.esptool,
    ], target);
    const native = new Esp32Toolchain(config.esp32, new LocalExecutor(), config.cacheDir, undefined, identity);
    // Runtime packaging only needs the prebuilt Arduino core and the three
    // static flash fragments. Compiling a throwaway sketch here adds a large
    // native C++ memory spike without contributing any browser artifact. The
    // core/static helpers retain their content-addressed cache and still fail
    // if the installed native toolchain cannot produce the required inputs.
    let coreBuildOutput = '';
    const coreResult = await native.ensureCore(board, resolvedOptions.options, (path) => {
      copyFileSync(path, join(baselineDir, 'core.a'));
    });
    coreBuildOutput += coreResult.output;
    if (!coreResult.path) throw new Error(`native core preparation failed:\n${coreBuildOutput}`);
    let staticParts: Array<{ name: string; offset: string; path: string }> = [];
    const staticResult = await native.ensureStaticParts(board, resolvedOptions.options, (parts) => {
      staticParts = parts.map((part) => {
        const path = join(baselineDir, part.name);
        copyFileSync(part.path, path);
        return { ...part, path };
      });
    });
    coreBuildOutput += staticResult.output;
    if (!staticResult.parts.length || staticParts.length !== staticResult.parts.length) {
      throw new Error(`native static flash preparation failed:\n${coreBuildOutput}`);
    }
    const coreArchive = join(baselineDir, 'core.a');
    requireRegularFile(coreArchive, 'native baseline core archive');
    for (const name of ['bootloader.bin', 'partitions.bin', 'boot_app0.bin']) {
      if (!staticParts.some((part) => part.name === name)) throw new Error(`baseline omitted ${name}`);
    }
    const bootloaderPart = staticParts.find((part) => part.name === 'bootloader.bin')!;
    const expectedBootloaderOffset = resolveRequiredProperty(
      resolvedStandardPlatform.properties,
      'build.bootloader_addr',
    );
    if (bootloaderPart.offset !== expectedBootloaderOffset) {
      throw new Error(
        `${target.label} bootloader address changed: ${bootloaderPart.offset} (Platform Manifest ${expectedBootloaderOffset})`,
      );
    }

    const runtime = resolveRuntimeInputs(gpp, localToolchain.rootDir, baselineDir, target);
    const linkerInputs = resolveSdkLinkerInputPaths(sdkRoot, memoryType);
    const lldCompatibility = target.makeLldInputs({
      ldFlags: readFileSync(join(sdkRoot, 'flags', 'ld_flags'), 'utf8'),
      memoryLd: readFileSync(linkerInputs.memoryLd, 'utf8'),
      sectionsLd: readFileSync(linkerInputs.sectionsLd, 'utf8'),
    });
    const compatibility = {
      ...lldCompatibility,
      // C and C++ use distinct Arduino platform response files. Preserve
      // both so CK Build IR can choose flags by source language.
      cFlags: target.makeCppFlags(readFileSync(join(sdkRoot, 'flags', 'c_flags'), 'utf8')),
      cppFlags: target.makeCppFlags(readFileSync(join(sdkRoot, 'flags', 'cpp_flags'), 'utf8')),
      sFlags: target.makeCppFlags(readFileSync(join(sdkRoot, 'flags', 'S_flags'), 'utf8')),
    };

    rmSync(output, { recursive: true, force: true });
    rmSync(clangOutput, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    mkdirSync(clangOutput, { recursive: true });
    const compilerBundle = readFileSync(join(compiler.root, 'gen', 'bundle.js'), 'utf8');
    writeFileSync(join(clangOutput, 'bundle.js'), patchCompilerBundleEnvironment(compilerBundle), 'utf8');

    const compilerPack = new PackWriter(join(output, 'packs', 'compiler'), target.compilerPackId, compiler.version);
    for (const resource of COMPILER_RESOURCES) {
      compilerPack.addArtifact(resource, resource.endsWith('.wasm') ? 'wasm' : 'tar', readFileSync(join(compiler.root, 'gen', resource)));
    }
    const compilerRelease = compilerPack.finish();
    const compilerManifest = publicationRoot
      ? publishContentAddressedCompilerPack({
          source: join(output, 'packs', 'compiler'),
          publicationRoot,
          packId: target.compilerPackId,
          revision: compilerRelease.revision,
        })
      : 'packs/compiler/toolchain.json';

    const sdkPack = new PackWriter(join(output, 'packs', 'sdk'), target.sdkPackId, SDK_VERSION);
    const commonInputs = {
      sdkRoot,
      coreDir: config.esp32.coreDir,
      variantDir: join(config.esp32.variantsDir, board.build.variant),
      coreArchive,
      runtime,
      compatibility,
      memoryType,
      ldLibs: target.makeLdLibs(readFileSync(join(sdkRoot, 'flags', 'ld_libs'), 'utf8')),
      target,
    };
    const compilePlan = new PackTreePlan();
    addCompileInputs(compilePlan, commonInputs);
    const compileTrees = emitPackTrees(compilePlan, 'compile', sdkPack);
    const linkPlan = new PackTreePlan();
    const archiveStripper = new ArchiveStripper(
      join(work, 'stripped-archives'),
      strip,
      standardPlatformManifest.recipeLowering.publication.sdkArchiveRewrites,
      c5ClicVectorRepair,
    );
    addLinkInputs(linkPlan, commonInputs, archiveStripper);
    archiveStripper.assertComplete();
    const linkTrees = emitPackTrees(linkPlan, 'link', sdkPack);
    const commands = derivePlatformCommands({
      manifest: standardPlatformManifest,
      resolved: resolvedStandardPlatform,
      runtime,
      compilerFlags: compatibility.cppFlags,
    });
    const sourceLock = runtimeSourceLock(sourceLockPath, target.fqbn, commands.execution);
    const platformProfiles = createPlatformProfileArtifacts({
      profile: {
        id: `espressif-arduino-${SDK_VERSION}`,
        sdkVersion: SDK_VERSION,
        compile: {
          args: commands.compile.args,
          overlaySlots: commands.compile.overlaySlots,
          source: 'sketch.cpp',
          object: 'sketch.o',
          artifactIds: compileTrees.map(({ artifactId }) => artifactId),
          languageFlags: commands.compile.languageFlags,
        },
        link: {
          args: commands.link.args,
          overlaySlots: commands.link.overlaySlots,
          object: 'sketch.o',
          elf: 'firmware.elf',
          artifactIds: linkTrees.map(({ artifactId }) => artifactId),
        },
        sdkVariant: {
          id: target.sdkPackId,
          sdkTarget: buildProfile.sdkTarget,
          memoryType,
          compilerPack: {
            id: target.compilerPackId,
            version: compiler.version,
            sha256: compilerRelease.revision,
          },
        },
      },
      platformManifest: standardPlatformManifest,
    });
    const platformManifestBytes = encodePlatformManifest(platformProfiles.platformManifest.profile);
    const platformManifestArtifact = sdkPack.addArtifact(
      platformProfiles.platformManifest.id,
      'json',
      platformManifestBytes,
    );
    if (platformManifestArtifact.sha256 !== platformProfiles.current.profile.platformManifestArtifact.sha256) {
      throw new Error('Platform Manifest artifact hash does not match profile-v5');
    }
    const platformProfileBytes = new TextEncoder().encode(JSON.stringify(platformProfiles.current.profile));
    if (platformProfileBytes.byteLength > MAX_PROFILE_BYTES) {
      throw new Error(`Platform profile v5 exceeds ${MAX_PROFILE_BYTES} bytes: ${platformProfileBytes.byteLength}`);
    }
    sdkPack.addArtifact(platformProfiles.current.id, 'json', platformProfileBytes);
    const sdkRelease = sdkPack.finish();
    if (sdkRelease.totalBytes > MAX_SDK_PACK_BYTES) {
      throw new Error(`SDK pack exceeds ${MAX_SDK_PACK_BYTES} bytes: ${sdkRelease.totalBytes}`);
    }
    const sdkManifest = publicationRoot
      ? publishContentAddressedRuntimePack({
          source: join(output, 'packs', 'sdk'),
          publicationRoot,
          packId: target.sdkPackId,
          revision: sdkRelease.revision,
        })
      : 'packs/sdk/toolchain.json';

    const boardPackId = `arduino-${target.key}-board`;
    const boardPack = new PackWriter(join(output, 'packs', 'board'), boardPackId, SDK_VERSION);
    const boardPlan = new PackTreePlan();
    boardPlan.addDirectory(join(config.esp32.variantsDir, board.build.variant), 'variant');
    const boardTrees = emitPackTrees(boardPlan, 'variant', boardPack);
    const flashOffsets = deriveStaticFlashOffsets(staticParts);
    const modelBytes = target.key === 'esp32s3'
      ? readFileSync(join(sdkRoot, 'esp_sr', 'srmodels.bin'))
      : undefined;
    if (modelBytes && (modelBytes.byteLength !== ESP32_SR_MODEL_SIZE_BYTES
      || sha256(modelBytes) !== ESP32_SR_MODEL_SHA256)) {
      throw new Error('ESP32-S3 speech-recognition model does not match the locked SDK artifact');
    }
    const boardProfiles = createBoardProfileArtifacts({
      profile: {
        id: `arduino-${target.key}-default`,
        board: target.fqbn,
        sdkVersion: SDK_VERSION,
        variant: board.build.variant,
        options: resolvedStandardPlatform.options,
        artifactIds: boardTrees.map(({ artifactId }) => artifactId),
        overlay: commands.overlay,
        image: {
          flashMode: resolveRequiredProperty(resolvedStandardPlatform.properties, 'build.flash_mode'),
          flashFrequency: resolveRequiredProperty(resolvedStandardPlatform.properties, 'build.img_freq'),
          flashSize: resolveRequiredProperty(resolvedStandardPlatform.properties, 'build.flash_size'),
        },
        flash: {
          bootloader: 'bootloader',
          partitions: 'partitions',
          bootApp0: 'boot-app0',
          ...(modelBytes ? {
            model: {
              artifactId: ESP32_SR_MODEL_ARTIFACT_ID,
              offset: ESP32_SR_MODEL_OFFSET,
              size: ESP32_SR_MODEL_SIZE_BYTES,
              capacity: ESP32_SR_MODEL_CAPACITY_BYTES,
            },
          } : {}),
          offsets: flashOffsets,
        },
        execution: commands.execution,
      },
      platformManifest: standardPlatformManifest,
    });
    const boardProfileBytes = new TextEncoder().encode(JSON.stringify(boardProfiles.current.profile));
    if (boardProfileBytes.byteLength > MAX_PROFILE_BYTES) {
      throw new Error(`Board profile v4 exceeds ${MAX_PROFILE_BYTES} bytes: ${boardProfileBytes.byteLength}`);
    }
    boardPack.addArtifact(boardProfiles.current.id, 'json', boardProfileBytes);
    for (const definition of [
      { id: 'bootloader', name: 'bootloader.bin' },
      { id: 'partitions', name: 'partitions.bin' },
      { id: 'boot-app0', name: 'boot_app0.bin' },
    ]) {
      const part = staticParts.find((candidate) => candidate.name === definition.name)!;
      boardPack.addArtifact(definition.id, 'bin', readFileSync(part.path));
    }
    if (modelBytes) boardPack.addArtifact(ESP32_SR_MODEL_ARTIFACT_ID, 'bin', modelBytes);
    const boardRelease = boardPack.finish();
    const boardManifest = publicationRoot
      ? publishContentAddressedRuntimePack({
          source: join(output, 'packs', 'board'),
          publicationRoot,
          packId: boardPackId,
          revision: boardRelease.revision,
        })
      : 'packs/board/toolchain.json';

    const descriptor = {
      schema: 2,
      id: target.runtimeId,
      abi: 1,
      board: target.fqbn,
      packs: [
        { role: 'compiler', id: target.compilerPackId, revision: compilerRelease.revision, manifest: compilerManifest },
        { role: 'sdk', id: target.sdkPackId, revision: sdkRelease.revision, manifest: sdkManifest },
        { role: 'board', id: boardPackId, revision: boardRelease.revision, manifest: boardManifest },
      ],
    };
    const descriptorBytes = new TextEncoder().encode(`${JSON.stringify(descriptor, null, 2)}\n`);
    writeFileSync(join(output, 'runtime.json'), descriptorBytes);
    writeFileSync(join(output, 'source-lock.json'), sourceLock, 'utf8');
    writeRuntimeProvenance({
      output,
      compilerRoot: compiler.root,
      esp32: config.esp32,
      toolchainRoot: localToolchain.rootDir,
      sdkRoot,
      sourceLock,
      target,
    });
    writeFileSync(join(output, 'THIRD_PARTY_NOTICES.md'), [
      `# ${target.label} browser runtime notices`,
      '',
      `Compiler: ${target.compilerPackage}@${compiler.version}; compiler and bundled upstream notices are under licenses/compiler/.`,
      `SDK: Arduino-ESP32 ${SDK_VERSION}; package and core notices are under licenses/arduino-esp32/.`,
      `Runtime libraries: Espressif ${target.toolchainLabel} GCC libgcc/libstdc++/newlib inputs; the complete installed toolchain license directory is under licenses/${target.toolchainLicenseId}/share/.`,
      '',
      'Source revisions, SDK component versions, and the corresponding-source request are recorded in provenance/ and source-offer.md.',
      '',
    ].join('\n'), 'utf8');

    const report = {
      schema: 1,
      descriptorSha256: sha256(descriptorBytes),
      compilerPackage: { version: compiler.version, sha256: sha256(readFileSync(tarball)) },
      packs: {
        compiler: {
          revision: compilerRelease.revision,
          bytes: compilerRelease.totalBytes,
          downloadBytes: compilerRelease.downloadBytes,
          manifest: compilerManifest,
          shared: publicationRoot !== null,
        },
        sdk: {
          revision: sdkRelease.revision,
          bytes: sdkRelease.totalBytes,
          downloadBytes: sdkRelease.downloadBytes,
          manifest: sdkManifest,
          contentAddressed: publicationRoot !== null,
        },
        board: {
          revision: boardRelease.revision,
          bytes: boardRelease.totalBytes,
          downloadBytes: boardRelease.downloadBytes,
          manifest: boardManifest,
          contentAddressed: publicationRoot !== null,
        },
      },
      phases: {
        compile: { artifacts: compileTrees.length, bytes: compileTrees.reduce((sum, tree) => sum + tree.size, 0) },
        link: { artifacts: linkTrees.length, bytes: linkTrees.reduce((sum, tree) => sum + tree.size, 0) },
        board: { artifacts: boardTrees.length, bytes: boardTrees.reduce((sum, tree) => sum + tree.size, 0) },
      },
      archiveStripping: archiveStripper.summary(),
      sdkArchiveExclusions: {
        names: target.unusedArchives,
        inputBytes: target.unusedArchives.reduce(
          (total, name) => total + lstatSync(join(sdkRoot, 'lib', name)).size,
          0,
        ),
      },
    };
    writeJson(join(output, 'release-report.json'), report);
    console.log(`PASS built ${target.runtimeId} browser runtime`);
    console.log(`descriptor sha256=${report.descriptorSha256}`);
    console.log(`compiler ${(compilerRelease.totalBytes / 1024 / 1024).toFixed(1)} MiB raw / ${(compilerRelease.downloadBytes / 1024 / 1024).toFixed(1)} MiB download`);
    console.log(`SDK compile ${(report.phases.compile.bytes / 1024 / 1024).toFixed(1)} MiB; link ${(report.phases.link.bytes / 1024 / 1024).toFixed(1)} MiB`);
    console.log(`stripped archive debug data ${(report.archiveStripping.savedBytes / 1024 / 1024).toFixed(1)} MiB`);
    console.log(`output ${output}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
