/**
 * Browser/Native-safe ESP32 partition table parser and encoder.
 *
 * This module deliberately has no filesystem, process, environment, or
 * platform-tool dependencies. Its binary format matches gen_esp32part.py's
 * normal (MD5-enabled) output.
 */

export const ESP32_PARTITION_ENTRY_SIZE = 32;
export const ESP32_PARTITION_TABLE_OFFSET = 0x8000;
export const ESP32_PARTITION_TABLE_SECTOR_SIZE = 0x1000;
export const ESP32_PARTITION_BINARY_DATA_SIZE = 0xc00;
export const ESP32_PARTITION_BINARY_SIZE = ESP32_PARTITION_TABLE_SECTOR_SIZE - 0x400;
export const ESP32_PARTITION_MD5_ENTRY_SIZE = ESP32_PARTITION_ENTRY_SIZE;
export const ESP32_PARTITION_MAX_ENTRIES =
  (ESP32_PARTITION_BINARY_DATA_SIZE - ESP32_PARTITION_MD5_ENTRY_SIZE) / ESP32_PARTITION_ENTRY_SIZE - 1;
export const ESP32_PARTITION_MAX_CSV_BYTES = 64 * 1024;
export const ESP32_PARTITION_MAX_LINE_BYTES = 1024;
export const ESP32_PARTITION_MAX_LINES = 256;
export const ESP32_PARTITION_MIN_FLASH_SIZE = 1024 * 1024;
export const ESP32_PARTITION_MAX_FLASH_SIZE = 128 * 1024 * 1024;

const UINT32_MAX = 0xffffffff;
const APP_TYPE = 0x00;
const DATA_TYPE = 0x01;
const BOOTLOADER_TYPE = 0x02;
const PARTITION_TABLE_TYPE = 0x03;
const MD5_MAGIC = [0xeb, 0xeb, ...new Array<number>(14).fill(0xff)];
const UTF8_ENCODER = new TextEncoder();

const TYPE_NAMES: Readonly<Record<string, number>> = Object.freeze({
  app: APP_TYPE,
  data: DATA_TYPE,
  bootloader: BOOTLOADER_TYPE,
  partition_table: PARTITION_TABLE_TYPE,
});

const SUBTYPE_NAMES: Readonly<Record<number, Readonly<Record<string, number>>>> = Object.freeze({
  [BOOTLOADER_TYPE]: Object.freeze({ primary: 0x00, ota: 0x01, recovery: 0x02 }),
  [PARTITION_TABLE_TYPE]: Object.freeze({ primary: 0x00, ota: 0x01 }),
  [APP_TYPE]: Object.freeze({
    factory: 0x00,
    test: 0x20,
    ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`ota_${index}`, 0x10 + index])),
    tee_0: 0x30,
    tee_1: 0x31,
  }),
  [DATA_TYPE]: Object.freeze({
    ota: 0x00,
    phy: 0x01,
    nvs: 0x02,
    coredump: 0x03,
    nvs_keys: 0x04,
    efuse: 0x05,
    undefined: 0x06,
    esphttpd: 0x80,
    fat: 0x81,
    spiffs: 0x82,
    littlefs: 0x83,
    tee_ota: 0x90,
  }),
});

const APP_ALIGNMENT = 0x10000;
const FLASH_ALIGNMENT = 0x1000;
const NVS_RW_MIN_SIZE = 0x3000;
const OTADATA_SIZE = 0x2000;
const MAX_LABEL_BYTES = 16;
const KNOWN_FLAGS = new Set(['encrypted', 'readonly']);

export type Esp32PartitionCsvSource = string | Uint8Array;
export type Esp32PartitionFlag = 'encrypted' | 'readonly';

export interface Esp32PartitionCsvOptions {
  /** Total flash capacity in bytes. Required so the parser always has a range to enforce. */
  readonly flashSizeBytes: number;
  /** Partition table sector offset. Defaults to the Arduino/ESP-IDF value 0x8000. */
  readonly partitionTableOffsetBytes?: number;
}

export interface Esp32PartitionEntry {
  readonly line: number;
  readonly label: string;
  readonly type: number;
  readonly subtype: number;
  readonly offset: number;
  readonly size: number;
  readonly flags: readonly Esp32PartitionFlag[];
}

export interface Esp32PartitionTable {
  readonly entries: readonly Esp32PartitionEntry[];
  readonly flashSizeBytes: number;
  readonly partitionTableOffsetBytes: number;
}

export interface Esp32PartitionTableCompilation extends Esp32PartitionTable {
  readonly bytes: Uint8Array;
}

export class Esp32PartitionCsvError extends Error {
  readonly code: string;
  readonly line?: number;

  constructor(code: string, message: string, line?: number) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = 'Esp32PartitionCsvError';
    this.code = code;
    this.line = line;
  }
}

interface NormalizedOptions {
  readonly flashSizeBytes: number;
  readonly partitionTableOffsetBytes: number;
}

interface ParsedRow {
  readonly line: number;
  readonly label: string;
  readonly type: number;
  readonly subtype: number;
  readonly offset: number | undefined;
  readonly size: number;
  readonly flags: readonly Esp32PartitionFlag[];
}

/** Parse and validate a project/pack ESP32 partition CSV without touching the host. */
export function parseEsp32PartitionCsv(
  source: Esp32PartitionCsvSource,
  options: Esp32PartitionCsvOptions,
): Esp32PartitionTable {
  const normalized = normalizeOptions(options);
  const text = decodeCsvSource(source);
  const rows = parseRows(text);
  const entries = resolveAndValidateRows(rows, normalized);
  return {
    entries,
    flashSizeBytes: normalized.flashSizeBytes,
    partitionTableOffsetBytes: normalized.partitionTableOffsetBytes,
  };
}

/** Encode a validated table. Entries are revalidated to keep this boundary fail-closed. */
export function encodeEsp32PartitionTable(table: Esp32PartitionTable): Uint8Array {
  if (table === null || typeof table !== 'object' || !Array.isArray(table.entries)) {
    throw new Esp32PartitionCsvError('table', 'table entries must be an array');
  }
  if (table.entries.length > ESP32_PARTITION_MAX_ENTRIES) {
    throw new Esp32PartitionCsvError('resource', `too many partition entries: ${table.entries.length}`);
  }
  const normalized = normalizeOptions({
    flashSizeBytes: table.flashSizeBytes,
    partitionTableOffsetBytes: table.partitionTableOffsetBytes,
  });
  const rows: ParsedRow[] = table.entries.map((entry) => ({
    line: entry.line,
    label: entry.label,
    type: entry.type,
    subtype: entry.subtype,
    offset: entry.offset,
    size: entry.size,
    flags: entry.flags,
  }));
  const entries = resolveAndValidateRows(rows, normalized, true);
  return encodeEntries(entries);
}

/** Parse and encode in one deterministic operation. */
export function encodeEsp32PartitionCsv(
  source: Esp32PartitionCsvSource,
  options: Esp32PartitionCsvOptions,
): Esp32PartitionTableCompilation {
  const table = parseEsp32PartitionCsv(source, options);
  return { ...table, bytes: encodeEntries(table.entries) };
}

function normalizeOptions(options: Esp32PartitionCsvOptions): NormalizedOptions {
  if (options === null || typeof options !== 'object') {
    throw new Esp32PartitionCsvError('options', 'options are required');
  }
  const flashSizeBytes = options.flashSizeBytes;
  if (!isSafeInteger(flashSizeBytes)
    || flashSizeBytes < ESP32_PARTITION_MIN_FLASH_SIZE
    || flashSizeBytes > ESP32_PARTITION_MAX_FLASH_SIZE
    || flashSizeBytes % FLASH_ALIGNMENT !== 0
    || !isStandardFlashSize(flashSizeBytes)) {
    throw new Esp32PartitionCsvError(
      'flash-range',
      `flashSizeBytes must be a 4 KiB-aligned integer from ${ESP32_PARTITION_MIN_FLASH_SIZE} through ${ESP32_PARTITION_MAX_FLASH_SIZE}`,
    );
  }

  const partitionTableOffsetBytes = options.partitionTableOffsetBytes === undefined
    ? ESP32_PARTITION_TABLE_OFFSET
    : options.partitionTableOffsetBytes;
  if (!isSafeInteger(partitionTableOffsetBytes)
    || partitionTableOffsetBytes < 0
    || partitionTableOffsetBytes % FLASH_ALIGNMENT !== 0
    || !fitsWithin(partitionTableOffsetBytes, ESP32_PARTITION_TABLE_SECTOR_SIZE, flashSizeBytes)) {
    throw new Esp32PartitionCsvError(
      'table-range',
      'partitionTableOffsetBytes must be 4 KiB aligned and its table sector must fit in flash',
    );
  }
  return { flashSizeBytes, partitionTableOffsetBytes };
}

function decodeCsvSource(source: Esp32PartitionCsvSource): string {
  let bytes: Uint8Array;
  let text: string;
  if (typeof source === 'string') {
    if (source.length > ESP32_PARTITION_MAX_CSV_BYTES) {
      throw new Esp32PartitionCsvError('resource', `CSV exceeds ${ESP32_PARTITION_MAX_CSV_BYTES} bytes`);
    }
    text = source;
    bytes = UTF8_ENCODER.encode(source);
    if (bytes.byteLength > ESP32_PARTITION_MAX_CSV_BYTES) {
      throw new Esp32PartitionCsvError('resource', `CSV exceeds ${ESP32_PARTITION_MAX_CSV_BYTES} bytes`);
    }
    validateUnicodeString(source);
  } else if (source instanceof Uint8Array) {
    bytes = source;
    if (bytes.byteLength > ESP32_PARTITION_MAX_CSV_BYTES) {
      throw new Esp32PartitionCsvError('resource', `CSV exceeds ${ESP32_PARTITION_MAX_CSV_BYTES} bytes`);
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(source);
    } catch {
      throw new Esp32PartitionCsvError('encoding', 'CSV must be valid UTF-8');
    }
  } else {
    throw new Esp32PartitionCsvError('encoding', 'CSV source must be a string or Uint8Array');
  }

  if (text.startsWith('\ufeff')) text = text.slice(1);
  if (text.includes('\ufeff')) {
    throw new Esp32PartitionCsvError('field', 'BOM is only permitted at the beginning of the CSV');
  }
  if (text.includes('\0')) {
    throw new Esp32PartitionCsvError('field', 'NUL bytes are not permitted in CSV');
  }
  return text.replace(/\r\n?/g, '\n');
}

function parseRows(text: string): ParsedRow[] {
  const lines = text.split('\n');
  if (lines.length > ESP32_PARTITION_MAX_LINES) {
    throw new Esp32PartitionCsvError('resource', `CSV exceeds ${ESP32_PARTITION_MAX_LINES} lines`);
  }
  const rows: ParsedRow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]!;
    if (UTF8_ENCODER.encode(line).byteLength > ESP32_PARTITION_MAX_LINE_BYTES) {
      throw new Esp32PartitionCsvError('resource', `CSV line exceeds ${ESP32_PARTITION_MAX_LINE_BYTES} bytes`, lineNumber);
    }
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const fields = line.split(',').map((field) => field.trim());
    if (fields.length < 5 || fields.length > 6) {
      throw new Esp32PartitionCsvError('csv-fields', 'expected five or six comma-separated fields', lineNumber);
    }
    if (fields.some((field) => field.includes('"'))) {
      throw new Esp32PartitionCsvError('csv-fields', 'quoted CSV fields are not supported', lineNumber);
    }

    const label = fields[0]!;
    const type = parseType(fields[1]!, lineNumber);
    const subtype = parseSubtype(fields[2]!, type, lineNumber);
    const offset = parseOptionalNumber(fields[3]!, 'offset', lineNumber);
    const size = parseRequiredNumber(fields[4]!, 'size', lineNumber);
    const flags = parseFlags(fields[5] ?? '', lineNumber);
    validateLabel(label, lineNumber);

    rows.push({ line: lineNumber, label, type, subtype, offset, size, flags });
  }
  if (rows.length === 0) {
    throw new Esp32PartitionCsvError('empty', 'CSV contains no partition entries');
  }
  if (rows.length > ESP32_PARTITION_MAX_ENTRIES) {
    throw new Esp32PartitionCsvError('resource', `CSV exceeds ${ESP32_PARTITION_MAX_ENTRIES} partition entries`);
  }
  return rows;
}

function resolveAndValidateRows(
  rows: readonly ParsedRow[],
  options: NormalizedOptions,
  fromEncodedTable = false,
): readonly Esp32PartitionEntry[] {
  const tableEnd = checkedAdd(
    options.partitionTableOffsetBytes,
    ESP32_PARTITION_TABLE_SECTOR_SIZE,
    'partition table range',
  );
  const labels = new Set<string>();
  const entries: Esp32PartitionEntry[] = [];
  let cursor = tableEnd;

  for (const row of rows) {
    if (labels.has(row.label)) {
      throw new Esp32PartitionCsvError('duplicate-label', `duplicate partition label '${row.label}'`, row.line);
    }
    labels.add(row.label);

    validateLabel(row.label, row.line);
    validateNumericEntry(row, options, tableEnd, fromEncodedTable);
    validateFlagsArray(row.flags, row.line);
    const alignment = row.type === APP_TYPE ? APP_ALIGNMENT : FLASH_ALIGNMENT;
    const offset = row.offset ?? alignUp(cursor, alignment, row.line);
    if (offset < tableEnd) {
      throw new Esp32PartitionCsvError(
        'table-overlap',
        `partition offset 0x${offset.toString(16)} is inside the partition table sector`,
        row.line,
      );
    }
    if (offset % alignment !== 0) {
      throw new Esp32PartitionCsvError(
        'alignment',
        `partition offset 0x${offset.toString(16)} is not aligned to 0x${alignment.toString(16)}`,
        row.line,
      );
    }
    if (row.offset !== undefined && row.offset < cursor) {
      throw new Esp32PartitionCsvError(
        'overlap',
        `partition offset 0x${row.offset.toString(16)} is before the previous partition end 0x${cursor.toString(16)}`,
        row.line,
      );
    }
    const end = checkedAdd(offset, row.size, 'partition range', row.line);
    if (end > options.flashSizeBytes) {
      throw new Esp32PartitionCsvError(
        'flash-range',
        `partition ends at 0x${end.toString(16)}, beyond flash size 0x${options.flashSizeBytes.toString(16)}`,
        row.line,
      );
    }
    validateSemanticRules(row, row.size);
    entries.push(Object.freeze({ ...row, offset }));
    cursor = end;
  }

  const ordered = [...entries].sort((left, right) => left.offset - right.offset);
  let previous: Esp32PartitionEntry | undefined;
  for (const entry of ordered) {
    if (previous !== undefined && entry.offset < previous.offset + previous.size) {
      throw new Esp32PartitionCsvError(
        'overlap',
        `partition '${entry.label}' overlaps '${previous.label}'`,
        entry.line,
      );
    }
    previous = entry;
  }
  const otadataEntries = entries.filter(
    (entry) => entry.type === DATA_TYPE && entry.subtype === SUBTYPE_NAMES[DATA_TYPE]!['ota'],
  );
  if (otadataEntries.length > 1) {
    throw new Esp32PartitionCsvError('semantic', 'only one otadata partition is permitted', otadataEntries[1]!.line);
  }
  const teeOtadataEntries = entries.filter(
    (entry) => entry.type === DATA_TYPE && entry.subtype === SUBTYPE_NAMES[DATA_TYPE]!['tee_ota'],
  );
  if (teeOtadataEntries.length > 1) {
    throw new Esp32PartitionCsvError('semantic', 'only one tee_ota partition is permitted', teeOtadataEntries[1]!.line);
  }
  return Object.freeze(entries);
}

function validateNumericEntry(
  row: ParsedRow,
  options: NormalizedOptions,
  tableEnd: number,
  fromEncodedTable: boolean,
): void {
  if (!isSafeInteger(row.type) || row.type < 0 || row.type > 0xfe) {
    throw new Esp32PartitionCsvError('field', 'partition type must be an integer from 0 through 0xfe', row.line);
  }
  if (!isSafeInteger(row.subtype) || row.subtype < 0 || row.subtype > 0xfe) {
    throw new Esp32PartitionCsvError('field', 'partition subtype must be an integer from 0 through 0xfe', row.line);
  }
  if (!isSafeInteger(row.size) || row.size <= 0 || row.size > UINT32_MAX) {
    throw new Esp32PartitionCsvError('field', 'partition size must be a positive 32-bit integer', row.line);
  }
  if (row.offset !== undefined && (!isSafeInteger(row.offset) || row.offset < 0 || row.offset > UINT32_MAX)) {
    throw new Esp32PartitionCsvError('field', 'partition offset must be an unsigned 32-bit integer', row.line);
  }
  if (fromEncodedTable && row.offset === undefined) {
    throw new Esp32PartitionCsvError('field', 'encoded partition entries must have explicit offsets', row.line);
  }
  if (tableEnd > options.flashSizeBytes) {
    throw new Esp32PartitionCsvError('table-range', 'partition table sector does not fit in flash', row.line);
  }
}

function validateSemanticRules(row: ParsedRow, size: number): void {
  if (row.type === APP_TYPE && size % FLASH_ALIGNMENT !== 0) {
    throw new Esp32PartitionCsvError('alignment', 'application partition size must be 4 KiB aligned', row.line);
  }
  if (row.type === DATA_TYPE && row.subtype === SUBTYPE_NAMES[DATA_TYPE]!['ota'] && size !== OTADATA_SIZE) {
    throw new Esp32PartitionCsvError('semantic', 'otadata partition size must be exactly 0x2000', row.line);
  }
  if (row.type === DATA_TYPE && row.subtype === SUBTYPE_NAMES[DATA_TYPE]!['tee_ota'] && size !== OTADATA_SIZE) {
    throw new Esp32PartitionCsvError('semantic', 'tee_ota partition size must be exactly 0x2000', row.line);
  }
  if (row.type === DATA_TYPE
    && (row.subtype === SUBTYPE_NAMES[DATA_TYPE]!['ota'] || row.subtype === SUBTYPE_NAMES[DATA_TYPE]!['coredump'])
    && row.flags.includes('readonly')) {
    throw new Esp32PartitionCsvError('semantic', 'otadata and coredump partitions cannot be readonly', row.line);
  }
  if (row.type === DATA_TYPE
    && row.subtype === SUBTYPE_NAMES[DATA_TYPE]!['nvs']
    && size < NVS_RW_MIN_SIZE
    && !row.flags.includes('readonly')) {
    throw new Esp32PartitionCsvError(
      'semantic',
      `read/write nvs partition must be at least 0x${NVS_RW_MIN_SIZE.toString(16)} (or use readonly)`,
      row.line,
    );
  }
}

function encodeEntries(entries: readonly Esp32PartitionEntry[]): Uint8Array {
  if (entries.length > ESP32_PARTITION_MAX_ENTRIES) {
    throw new Esp32PartitionCsvError('resource', `too many partition entries: ${entries.length}`);
  }
  const dataLength = entries.length * ESP32_PARTITION_ENTRY_SIZE;
  const md5Offset = dataLength;
  if (md5Offset + ESP32_PARTITION_MD5_ENTRY_SIZE + ESP32_PARTITION_ENTRY_SIZE > ESP32_PARTITION_BINARY_SIZE) {
    throw new Esp32PartitionCsvError('resource', 'partition table leaves no MD5/end marker entries');
  }

  const data = new Uint8Array(dataLength);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const base = index * ESP32_PARTITION_ENTRY_SIZE;
    const labelBytes = UTF8_ENCODER.encode(entry.label);
    if (labelBytes.byteLength > MAX_LABEL_BYTES) {
      throw new Esp32PartitionCsvError('label', 'partition label exceeds 16 UTF-8 bytes', entry.line);
    }
    data[base] = 0xaa;
    data[base + 1] = 0x50;
    data[base + 2] = entry.type;
    data[base + 3] = entry.subtype;
    view.setUint32(base + 4, entry.offset, true);
    view.setUint32(base + 8, entry.size, true);
    data.set(labelBytes, base + 12);
    let flags = 0;
    if (entry.flags.includes('encrypted')) flags |= 1;
    if (entry.flags.includes('readonly')) flags |= 2;
    view.setUint32(base + 28, flags, true);
  }

  const digest = md5(data);
  const output = new Uint8Array(ESP32_PARTITION_BINARY_SIZE);
  output.fill(0xff);
  output.set(data, 0);
  output.set(MD5_MAGIC, md5Offset);
  output.set(digest, md5Offset + 16);
  return output;
}

function validateLabel(label: string, line: number): void {
  if (typeof label !== 'string') {
    throw new Esp32PartitionCsvError('label', 'partition label must be a string', line);
  }
  if (label.length === 0) {
    throw new Esp32PartitionCsvError('label', 'partition label cannot be empty', line);
  }
  if (label.includes('\0')) {
    throw new Esp32PartitionCsvError('label', 'partition label cannot contain NUL', line);
  }
  for (const character of label) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint === 0x7f || character === ',' || character === '"') {
      throw new Esp32PartitionCsvError('label', 'partition label contains an illegal character', line);
    }
  }
  if (UTF8_ENCODER.encode(label).byteLength > MAX_LABEL_BYTES) {
    throw new Esp32PartitionCsvError('label', 'partition label exceeds 16 UTF-8 bytes', line);
  }
}

function parseType(value: string, line: number): number {
  if (value.length === 0) throw new Esp32PartitionCsvError('field', "Field 'type' cannot be empty", line);
  return parseNumberOrName(value, TYPE_NAMES, 'type', line);
}

function parseSubtype(value: string, type: number, line: number): number {
  if (value.length === 0) {
    if (type === APP_TYPE) {
      throw new Esp32PartitionCsvError('field', 'app partition subtype cannot be empty', line);
    }
    if (type === DATA_TYPE) return SUBTYPE_NAMES[DATA_TYPE]!['undefined']!;
    throw new Esp32PartitionCsvError('field', 'custom partition subtype cannot be empty', line);
  }
  return parseNumberOrName(value, SUBTYPE_NAMES[type] ?? {}, 'subtype', line);
}

function parseFlags(value: string, line: number): readonly Esp32PartitionFlag[] {
  if (value.length === 0) return Object.freeze([] as Esp32PartitionFlag[]);
  const flags: Esp32PartitionFlag[] = [];
  const seen = new Set<string>();
  for (const rawFlag of value.split(':')) {
    const flag = rawFlag.trim();
    if (!KNOWN_FLAGS.has(flag)) {
      throw new Esp32PartitionCsvError('flags', `unknown partition flag '${flag}'`, line);
    }
    if (seen.has(flag)) {
      throw new Esp32PartitionCsvError('flags', `duplicate partition flag '${flag}'`, line);
    }
    seen.add(flag);
    flags.push(flag as Esp32PartitionFlag);
  }
  return Object.freeze((['encrypted', 'readonly'] as Esp32PartitionFlag[])
    .filter((flag) => seen.has(flag)));
}

function validateFlagsArray(flags: readonly Esp32PartitionFlag[], line: number): void {
  if (!Array.isArray(flags)) {
    throw new Esp32PartitionCsvError('flags', 'partition flags must be an array', line);
  }
  const seen = new Set<string>();
  for (const flag of flags) {
    if (typeof flag !== 'string' || !KNOWN_FLAGS.has(flag)) {
      throw new Esp32PartitionCsvError('flags', `unknown partition flag '${String(flag)}'`, line);
    }
    if (seen.has(flag)) {
      throw new Esp32PartitionCsvError('flags', `duplicate partition flag '${flag}'`, line);
    }
    seen.add(flag);
  }
}

function parseOptionalNumber(value: string, field: string, line: number): number | undefined {
  if (value.length === 0) return undefined;
  return parseNumber(value, field, line);
}

function parseRequiredNumber(value: string, field: string, line: number): number {
  if (value.length === 0) {
    throw new Esp32PartitionCsvError('field', `Field '${field}' cannot be empty`, line);
  }
  return parseNumber(value, field, line);
}

function parseNumberOrName(
  value: string,
  names: Readonly<Record<string, number>>,
  field: string,
  line: number,
): number {
  const lowered = value.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(names, lowered)) return names[lowered]!;
  return parseNumber(value, field, line);
}

function parseNumber(value: string, field: string, line: number): number {
  const match = /^(0[xX][0-9a-fA-F]+|[0-9]+)(KB?|MB?)?$/i.exec(value);
  if (match === null) {
    throw new Esp32PartitionCsvError('field', `invalid ${field} value '${value}'`, line);
  }
  const numberPart = match[1]!;
  const suffix = match[2]?.toLowerCase();
  let base: number;
  if (numberPart.startsWith('0x') || numberPart.startsWith('0X')) {
    base = Number.parseInt(numberPart.slice(2), 16);
  } else {
    base = Number.parseInt(numberPart, 10);
  }
  const multiplier = suffix === 'k' || suffix === 'kb'
    ? 1024
    : suffix === 'm' || suffix === 'mb'
      ? 1024 * 1024
      : 1;
  const result = base * multiplier;
  if (!Number.isSafeInteger(result) || result < 0 || result > UINT32_MAX) {
    throw new Esp32PartitionCsvError('overflow', `${field} value '${value}' overflows uint32`, line);
  }
  return result;
}

function alignUp(value: number, alignment: number, line: number): number {
  const remainder = value % alignment;
  const aligned = remainder === 0 ? value : value + alignment - remainder;
  if (!Number.isSafeInteger(aligned) || aligned > UINT32_MAX) {
    throw new Esp32PartitionCsvError('overflow', 'automatic partition offset overflows uint32', line);
  }
  return aligned;
}

function checkedAdd(left: number, right: number, field: string, line?: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0 || result > UINT32_MAX) {
    throw new Esp32PartitionCsvError('overflow', `${field} overflows uint32`, line);
  }
  return result;
}

function fitsWithin(offset: number, size: number, limit: number): boolean {
  return offset >= 0 && size >= 0 && Number.isSafeInteger(offset + size) && offset + size <= limit;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function validateUnicodeString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new Esp32PartitionCsvError('encoding', 'CSV contains an unpaired UTF-16 surrogate');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Esp32PartitionCsvError('encoding', 'CSV contains an unpaired UTF-16 surrogate');
    }
  }
}

function isStandardFlashSize(value: number): boolean {
  const mebibytes = value / (1024 * 1024);
  return Number.isInteger(mebibytes) && (mebibytes & (mebibytes - 1)) === 0;
}

// Small, synchronous MD5 implementation so Browser and Native use identical bytes.
function md5(input: Uint8Array): Uint8Array {
  const paddedLength = ((input.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const bitLength = input.length * 8;
  const paddedView = new DataView(padded.buffer);
  paddedView.setUint32(paddedLength - 8, bitLength >>> 0, true);
  paddedView.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
    0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
    0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];

  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(16);
    for (let index = 0; index < 16; index += 1) {
      words[index] = paddedView.getUint32(offset + index * 4, true);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const next = d;
      const sum = (a + f + constants[index]! + words[g]!) >>> 0;
      d = c;
      c = b;
      b = (b + rotateLeft(sum, shifts[index]!)) >>> 0;
      a = next;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const result = new Uint8Array(16);
  const view = new DataView(result.buffer);
  view.setUint32(0, a0, true);
  view.setUint32(4, b0, true);
  view.setUint32(8, c0, true);
  view.setUint32(12, d0, true);
  return result;
}

function rotateLeft(value: number, amount: number): number {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}
