import type {
  ProjectFileInput,
  Sha256,
  SourceLanguage,
} from '../build-ir/types.js';
import { canonicalJson, sha256Hex } from '../build-ir/canonical.js';
import type { SourceFile } from '../types.js';
import {
  ESP32_PARTITION_MAX_CSV_BYTES,
  Esp32PartitionCsvError,
  encodeEsp32PartitionCsv,
  parseEsp32PartitionCsv,
  type Esp32PartitionCsvOptions,
  type Esp32PartitionEntry,
  type Esp32PartitionTable,
} from './partition-table.js';

/** The only project path that may provide a custom ESP32 partition table. */
export const ESP32_CUSTOM_PARTITIONS_FILE = 'partitions.csv' as const;
export const ESP32_CUSTOM_PARTITIONS_SCHEMA_VERSION = 2 as const;
export const ESP32_CUSTOM_PARTITIONS_MAX_BYTES = ESP32_PARTITION_MAX_CSV_BYTES;
/** The application image offset fixed by the current ESP32 post-link contract. */
export const ESP32_APPLICATION_FLASH_OFFSET_BYTES = 0x10000 as const;

const ESP32_APP_PARTITION_TYPE = 0x00;
const ESP32_FACTORY_APP_SUBTYPE = 0x00;
const ESP32_OTA_APP_SUBTYPE_MIN = 0x10;
const ESP32_OTA_APP_SUBTYPE_MAX = 0x1f;

export interface Esp32CustomPartitionsOptions {
  /** Total flash capacity in bytes, as selected by the target board profile. */
  readonly flashSizeBytes: number;
  /** Optional partition table sector offset. Defaults to 0x8000 in the codec. */
  readonly partitionTableOffsetBytes?: number;
}

export type Esp32CustomPartitionsErrorCode =
  | 'files'
  | 'file'
  | 'non-text'
  | 'subdirectory'
  | 'duplicate'
  | 'extension'
  | 'size'
  | 'options'
  | 'csv'
  | 'codec'
  | 'bootability'
  | 'capacity';

export interface Esp32CustomPartitionsErrorDetails {
  readonly path?: string;
  readonly line?: number;
  readonly csvCode?: string;
  readonly cause?: unknown;
}

/** A fail-closed error raised at the project-file/custom-partition boundary. */
export class Esp32CustomPartitionsError extends Error {
  readonly code: Esp32CustomPartitionsErrorCode;
  readonly path?: string;
  readonly line?: number;
  readonly csvCode?: string;

  constructor(
    code: Esp32CustomPartitionsErrorCode,
    message: string,
    details: Esp32CustomPartitionsErrorDetails = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'Esp32CustomPartitionsError';
    this.code = code;
    this.path = details.path;
    this.line = details.line;
    this.csvCode = details.csvCode;
  }
}

/** A Build IR project file or the legacy SourceFile shape used by the API. */
export type ProjectSnapshotHashFile =
  | ProjectFileInput
  | (SourceFile & { readonly language?: SourceLanguage; readonly generated?: boolean });

/** The bootable partition slot that receives the fixed-offset application image. */
export interface Esp32ApplicationSlot {
  readonly label: string;
  readonly subtype: number;
  readonly line: number;
  readonly offsetBytes: number;
  readonly endBytes: number;
  /** Bytes available from the fixed application image offset through the slot end. */
  readonly maxBytes: number;
}

/**
 * Calculate the same project snapshot hash used by Build IR `resolveProject`.
 *
 * Paths are normalized to logical POSIX paths, files are sorted by UTF-16
 * path order, omitted language/generated values receive the Build IR defaults,
 * and only path/content/language/generated participate in the canonical body.
 */
export function projectSnapshotSha256(files: readonly ProjectSnapshotHashFile[]): Sha256 {
  if (!Array.isArray(files)) throw new TypeError('project snapshot files must be an array');

  const normalized = files.map((file, index) => {
    if (!isRecord(file) || Array.isArray(file)) {
      throw new TypeError(`project snapshot file ${index} must be an object`);
    }
    const value = file as Record<string, unknown>;
    const rawPath = typeof value.path === 'string'
      ? value.path
      : typeof value.name === 'string'
        ? value.name
        : undefined;
    if (rawPath === undefined) {
      throw new TypeError(`project snapshot file ${index} must have path or name`);
    }
    if (typeof value.content !== 'string') {
      throw new TypeError(`project snapshot file ${index} content must be text`);
    }
    const path = normalizeProjectSnapshotPath(rawPath, index);
    const language = value.language ?? inferProjectSnapshotLanguage(path);
    if (!isProjectLanguage(language)) {
      throw new TypeError(`project snapshot file ${path} language is invalid`);
    }
    const generated = value.generated ?? false;
    if (typeof generated !== 'boolean') {
      throw new TypeError(`project snapshot file ${path} generated must be boolean`);
    }
    return { path, content: value.content, language, generated };
  }).sort((left, right) => compareProjectPath(left.path, right.path));

  const foldedPaths = new Set<string>();
  for (const file of normalized) {
    const folded = file.path.toLowerCase();
    if (foldedPaths.has(folded)) {
      throw new TypeError(`duplicate project snapshot file: ${file.path}`);
    }
    foldedPaths.add(folded);
  }
  return sha256Hex(canonicalJson(normalized));
}

/**
 * Project-owned ESP32 partition input.
 *
 * `sha256` is the hash of the exact source UTF-8 bytes and is intentionally
 * suitable for a Build IR immutable project-file input. `bytes` is the
 * deterministic MD5-enabled partition-table binary produced by the shared
 * Browser/Native-safe codec. `identitySha256` binds both representations to
 * the logical path, complete project snapshot, and target flash geometry.
 */
export interface Esp32CustomPartitionInput {
  readonly kind: 'project-owned-esp32-partitions';
  readonly schemaVersion: typeof ESP32_CUSTOM_PARTITIONS_SCHEMA_VERSION;
  readonly path: typeof ESP32_CUSTOM_PARTITIONS_FILE;
  readonly fileName: typeof ESP32_CUSTOM_PARTITIONS_FILE;
  readonly flashSizeBytes: number;
  readonly partitionTableOffsetBytes: number;
  readonly applicationSlot: Esp32ApplicationSlot;
  readonly sourceBytes: Uint8Array;
  readonly sourceSize: number;
  readonly sourceSha256: Sha256;
  /** Alias of sourceSha256 for direct ActionInput/ProjectFile binding. */
  readonly sha256: Sha256;
  readonly table: Esp32PartitionTable;
  readonly bytes: Uint8Array;
  readonly tableSize: number;
  readonly tableSha256: Sha256;
  /** Hash of the complete project file list that supplied this input. */
  readonly projectSnapshotSha256: Sha256;
  readonly identitySha256: Sha256;
}

/**
 * Resolve the optional project-owned partitions.csv file.
 *
 * A missing file returns null. Any partition-like file that is present but is
 * not the exact root-level `partitions.csv` is rejected so a nested or
 * misspelled file cannot be silently ignored.
 */
export function resolveCustomEsp32Partitions(
  files: readonly SourceFile[],
  options: Esp32CustomPartitionsOptions,
): Esp32CustomPartitionInput | null {
  const file = findUniqueRootPartitionFile(files);
  if (file === null) return null;

  const projectSnapshotHash = projectSnapshotSha256(files);

  const csvOptions = normalizeCodecOptions(options);
  const sourceBytes = encodeUtf8(file.content, file.name);
  if (sourceBytes.byteLength > ESP32_CUSTOM_PARTITIONS_MAX_BYTES) {
    throw new Esp32CustomPartitionsError(
      'size',
      `${ESP32_CUSTOM_PARTITIONS_FILE} exceeds ${ESP32_CUSTOM_PARTITIONS_MAX_BYTES} UTF-8 bytes`,
      { path: file.name },
    );
  }

  let table: Esp32PartitionTable;
  let encodedBytes: Uint8Array;
  try {
    // Keep the parse and encode calls explicit: both Browser and Native use
    // the same validation boundary, while the encoded bytes become the
    // deterministic post-link input.
    table = parseEsp32PartitionCsv(sourceBytes, csvOptions);
    const compilation = encodeEsp32PartitionCsv(sourceBytes, csvOptions);
    if (
      compilation.flashSizeBytes !== table.flashSizeBytes
      || compilation.partitionTableOffsetBytes !== table.partitionTableOffsetBytes
    ) {
      throw new Esp32CustomPartitionsError(
        'codec',
        'ESP32 partition parser and encoder returned different target geometry',
        { path: file.name },
      );
    }
    encodedBytes = new Uint8Array(compilation.bytes);
  } catch (error) {
    if (error instanceof Esp32CustomPartitionsError) throw error;
    throw wrapCodecError(error, file.name);
  }

  const stableTable = clonePartitionTable(table);
  const applicationSlot = resolveEsp32ApplicationSlot(stableTable);
  const sourceSha256 = sha256Hex(sourceBytes);
  const tableSha256 = sha256Hex(encodedBytes);
  const identitySha256 = sha256Hex(canonicalJson({
    kind: 'project-owned-esp32-partitions',
    schemaVersion: ESP32_CUSTOM_PARTITIONS_SCHEMA_VERSION,
    path: ESP32_CUSTOM_PARTITIONS_FILE,
    sourceSha256,
    sourceSize: sourceBytes.byteLength,
    tableSha256,
    tableSize: encodedBytes.byteLength,
    projectSnapshotSha256: projectSnapshotHash,
    flashSizeBytes: stableTable.flashSizeBytes,
    partitionTableOffsetBytes: stableTable.partitionTableOffsetBytes,
    applicationSlot,
  }));

  return Object.freeze({
    kind: 'project-owned-esp32-partitions' as const,
    schemaVersion: ESP32_CUSTOM_PARTITIONS_SCHEMA_VERSION,
    path: ESP32_CUSTOM_PARTITIONS_FILE,
    fileName: ESP32_CUSTOM_PARTITIONS_FILE,
    flashSizeBytes: stableTable.flashSizeBytes,
    partitionTableOffsetBytes: stableTable.partitionTableOffsetBytes,
    applicationSlot,
    sourceBytes: new Uint8Array(sourceBytes),
    sourceSize: sourceBytes.byteLength,
    sourceSha256,
    sha256: sourceSha256,
    table: stableTable,
    bytes: new Uint8Array(encodedBytes),
    tableSize: encodedBytes.byteLength,
    tableSha256,
    projectSnapshotSha256: projectSnapshotHash,
    identitySha256,
  });
}

/** Resolve the normal factory/OTA slot containing the fixed application image offset. */
export function resolveEsp32ApplicationSlot(table: Esp32PartitionTable): Esp32ApplicationSlot {
  if (!isRecord(table) || !Array.isArray(table.entries)) {
    throw new TypeError('ESP32 partition table is required');
  }
  const imageOffset = ESP32_APPLICATION_FLASH_OFFSET_BYTES;
  const covering = table.entries.filter((entry) => partitionContainsOffset(entry, imageOffset));
  const entry = covering.find((candidate) => (
    candidate.type === ESP32_APP_PARTITION_TYPE
    && isBootableApplicationSubtype(candidate.subtype)
  ));
  if (!entry) {
    const coveringApp = covering.find((candidate) => candidate.type === ESP32_APP_PARTITION_TYPE);
    const detail = coveringApp
      ? `partition '${coveringApp.label}' has non-bootable app subtype 0x${coveringApp.subtype.toString(16)}`
      : `no bootable app partition covers 0x${imageOffset.toString(16)}`;
    throw new Esp32CustomPartitionsError(
      'bootability',
      `invalid ESP32 custom partition layout: ${detail}`,
      coveringApp ? { path: ESP32_CUSTOM_PARTITIONS_FILE, line: coveringApp.line } : {
        path: ESP32_CUSTOM_PARTITIONS_FILE,
      },
    );
  }

  const endBytes = entry.offset + entry.size;
  return Object.freeze({
    label: entry.label,
    subtype: entry.subtype,
    line: entry.line,
    offsetBytes: entry.offset,
    endBytes,
    maxBytes: endBytes - imageOffset,
  });
}

/** Fail closed when an emitted ESP32 application image cannot fit its custom slot. */
export function assertEsp32ApplicationFitsSlot(
  applicationSizeBytes: number,
  slot: Esp32ApplicationSlot,
): void {
  if (!Number.isSafeInteger(applicationSizeBytes) || applicationSizeBytes < 0) {
    throw new TypeError('ESP32 application artifact size must be a non-negative safe integer');
  }
  assertApplicationSlot(slot);
  if (applicationSizeBytes <= slot.maxBytes) return;
  throw new Esp32CustomPartitionsError(
    'capacity',
    `ESP32 application artifact is ${applicationSizeBytes} bytes, exceeding custom partition `
      + `slot '${slot.label}' capacity ${slot.maxBytes} bytes `
      + `(0x${ESP32_APPLICATION_FLASH_OFFSET_BYTES.toString(16)}..0x${slot.endBytes.toString(16)})`,
    { path: ESP32_CUSTOM_PARTITIONS_FILE, line: slot.line },
  );
}

function partitionContainsOffset(entry: Esp32PartitionEntry, offset: number): boolean {
  return entry.offset <= offset && offset < entry.offset + entry.size;
}

function isBootableApplicationSubtype(subtype: number): boolean {
  return subtype === ESP32_FACTORY_APP_SUBTYPE
    || (subtype >= ESP32_OTA_APP_SUBTYPE_MIN && subtype <= ESP32_OTA_APP_SUBTYPE_MAX);
}

function assertApplicationSlot(slot: Esp32ApplicationSlot): void {
  if (!isRecord(slot)
    || typeof slot.label !== 'string'
    || slot.label.length === 0
    || !Number.isSafeInteger(slot.subtype)
    || !isBootableApplicationSubtype(slot.subtype)
    || !Number.isSafeInteger(slot.line)
    || slot.line < 1
    || !Number.isSafeInteger(slot.offsetBytes)
    || !Number.isSafeInteger(slot.endBytes)
    || !Number.isSafeInteger(slot.maxBytes)
    || slot.offsetBytes > ESP32_APPLICATION_FLASH_OFFSET_BYTES
    || slot.endBytes <= ESP32_APPLICATION_FLASH_OFFSET_BYTES
    || slot.maxBytes <= 0
    || slot.maxBytes !== slot.endBytes - ESP32_APPLICATION_FLASH_OFFSET_BYTES) {
    throw new TypeError('ESP32 application slot is invalid');
  }
}

function findUniqueRootPartitionFile(files: readonly SourceFile[]): SourceFile | null {
  if (!Array.isArray(files)) {
    throw new Esp32CustomPartitionsError('files', 'project files must be an array');
  }

  const matches: SourceFile[] = [];
  for (const value of files as readonly unknown[]) {
    if (!isRecord(value) || Array.isArray(value)) {
      throw new Esp32CustomPartitionsError('file', 'each project file must be an object');
    }
    const name = value.name;
    if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
      throw new Esp32CustomPartitionsError('file', 'each project file must have a valid name');
    }
    assertWellFormedText(name, name, 'file name');

    const isRootPartitionFile = classifyPartitionPath(name);
    const content = value.content;
    if (typeof content !== 'string') {
      throw new Esp32CustomPartitionsError(
        'non-text',
        `project file ${name} must contain text content, not binary data`,
        { path: name },
      );
    }
    if (isRootPartitionFile) {
      assertWellFormedText(content, name, 'partition CSV');
      matches.push(value as unknown as SourceFile);
    }
  }

  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Esp32CustomPartitionsError(
      'duplicate',
      `project contains ${matches.length} root-level ${ESP32_CUSTOM_PARTITIONS_FILE} files`,
      { path: ESP32_CUSTOM_PARTITIONS_FILE },
    );
  }
  return matches[0]!;
}

function classifyPartitionPath(name: string): boolean {
  if (name === ESP32_CUSTOM_PARTITIONS_FILE) return true;

  const logicalPath = name.replaceAll('\\', '/');
  const segments = logicalPath.split('/');
  const lowerSegments = segments.map((segment) => segment.trim().toLowerCase());
  const rootSegment = ESP32_CUSTOM_PARTITIONS_FILE.toLowerCase();
  const rootIndex = lowerSegments.indexOf(rootSegment);
  if (rootIndex !== -1) {
    if (segments.length === 1) {
      throw new Esp32CustomPartitionsError(
        'extension',
        `custom partition file must be named exactly ${ESP32_CUSTOM_PARTITIONS_FILE}`,
        { path: name },
      );
    }
    throw new Esp32CustomPartitionsError(
      'subdirectory',
      `custom partition file must be at the project root: ${name}`,
      { path: name },
    );
  }

  const leaf = lowerSegments[lowerSegments.length - 1] ?? '';
  const partitionLike = leaf === 'partitions' || leaf.startsWith('partitions.');
  if (partitionLike) {
    throw new Esp32CustomPartitionsError(
      segments.length === 1 ? 'extension' : 'subdirectory',
      `custom partition file must use the exact root path ${ESP32_CUSTOM_PARTITIONS_FILE}: ${name}`,
      { path: name },
    );
  }
  return false;
}

function normalizeCodecOptions(options: Esp32CustomPartitionsOptions): Esp32PartitionCsvOptions {
  if (!isRecord(options) || Array.isArray(options)) {
    throw new Esp32CustomPartitionsError('options', 'ESP32 custom partition options are required');
  }
  if (!Number.isSafeInteger(options.flashSizeBytes)) {
    throw new Esp32CustomPartitionsError('options', 'flashSizeBytes must be a safe integer');
  }
  if (
    options.partitionTableOffsetBytes !== undefined
    && !Number.isSafeInteger(options.partitionTableOffsetBytes)
  ) {
    throw new Esp32CustomPartitionsError(
      'options',
      'partitionTableOffsetBytes must be a safe integer when provided',
    );
  }
  return {
    flashSizeBytes: options.flashSizeBytes,
    ...(options.partitionTableOffsetBytes === undefined
      ? {}
      : { partitionTableOffsetBytes: options.partitionTableOffsetBytes }),
  };
}

function encodeUtf8(value: string, path: string): Uint8Array {
  assertWellFormedText(value, path, 'partition CSV');
  return new TextEncoder().encode(value);
}

function assertWellFormedText(value: string, path: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Esp32CustomPartitionsError(
          'non-text',
          `${label} in ${path} contains an unpaired UTF-16 surrogate`,
          { path },
        );
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Esp32CustomPartitionsError(
        'non-text',
        `${label} in ${path} contains an unpaired UTF-16 surrogate`,
        { path },
      );
    }
  }
}

function wrapCodecError(error: unknown, path: string): Esp32CustomPartitionsError {
  if (error instanceof Esp32PartitionCsvError) {
    const optionsError = error.line === undefined
      && (error.code === 'options' || error.code === 'flash-range' || error.code === 'table-range');
    return new Esp32CustomPartitionsError(
      optionsError ? 'options' : 'csv',
      `invalid ESP32 partition CSV ${path}: ${error.message}`,
      { path, line: error.line, csvCode: error.code, cause: error },
    );
  }
  return new Esp32CustomPartitionsError(
    'codec',
    `ESP32 partition codec failed for ${path}`,
    { path, cause: error },
  );
}

function clonePartitionTable(table: Esp32PartitionTable): Esp32PartitionTable {
  const entries = Object.freeze(table.entries.map((entry) => Object.freeze({
    ...entry,
    flags: Object.freeze([...entry.flags]),
  })));
  return Object.freeze({
    entries,
    flashSizeBytes: table.flashSizeBytes,
    partitionTableOffsetBytes: table.partitionTableOffsetBytes,
  });
}

function normalizeProjectSnapshotPath(value: string, index: number): string {
  const path = value.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').includes('..')) {
    throw new TypeError(`project snapshot file ${index} path must be relative and must not contain '..': ${value}`);
  }
  return path.split('/').filter((part) => part.length > 0 && part !== '.').join('/');
}

function inferProjectSnapshotLanguage(path: string): SourceLanguage {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  if (extension === 'ino') return 'ino';
  if (extension === 'c') return 'c';
  if (extension === 'cc' || extension === 'cpp' || extension === 'cxx') return 'c++';
  if (extension === 's' || extension === 'asm') return 'asm';
  if (extension === 'h' || extension === 'hh' || extension === 'hpp' || extension === 'hxx') return 'header';
  return 'other';
}

function isProjectLanguage(value: unknown): value is SourceLanguage {
  return value === 'ino'
    || value === 'c'
    || value === 'c++'
    || value === 'asm'
    || value === 'header'
    || value === 'other';
}

function compareProjectPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
