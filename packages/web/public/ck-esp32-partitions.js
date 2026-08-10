// Generated from @sketchforge/core ESP32 custom partitions. Browser and Native share one implementation.

// packages/core/src/build-ir/canonical.ts
function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (value === void 0) throw new TypeError("canonical JSON cannot contain undefined");
  if (typeof value !== "object") throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value;
  const keys = Object.keys(object).sort(compareText);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
function sha256Hex(input) {
  const bytes = typeof input === "string" ? utf8(input) : input;
  const bitLength = bytes.length * 8;
  const paddedLength = bytes.length + 9 + 63 >> 6 << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 128;
  const high = Math.floor(bitLength / 4294967296);
  const low = bitLength >>> 0;
  padded[padded.length - 8] = high >>> 24 & 255;
  padded[padded.length - 7] = high >>> 16 & 255;
  padded[padded.length - 6] = high >>> 8 & 255;
  padded[padded.length - 5] = high & 255;
  padded[padded.length - 4] = low >>> 24 & 255;
  padded[padded.length - 3] = low >>> 16 & 255;
  padded[padded.length - 2] = low >>> 8 & 255;
  padded[padded.length - 1] = low & 255;
  const h = [
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ];
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(64);
    for (let i = 0; i < 16; i++) {
      const at = offset + i * 4;
      words[i] = (padded[at] << 24 | padded[at + 1] << 16 | padded[at + 2] << 8 | padded[at + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      const s0 = (rotateRight(x, 7) ^ rotateRight(x, 18) ^ x >>> 3) >>> 0;
      const s1 = (rotateRight(y, 17) ^ rotateRight(y, 19) ^ y >>> 10) >>> 0;
      words[i] = words[i - 16] + s0 + words[i - 7] + s1 >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i++) {
      const s1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
      const ch = (e & f ^ ~e & g) >>> 0;
      const temp1 = hh + s1 + ch + SHA256_K[i] + words[i] >>> 0;
      const s0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
      const maj = (a & b ^ a & c ^ b & c) >>> 0;
      const temp2 = s0 + maj >>> 0;
      hh = g;
      g = f;
      f = e;
      e = d + temp1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2 >>> 0;
    }
    h[0] = h[0] + a >>> 0;
    h[1] = h[1] + b >>> 0;
    h[2] = h[2] + c >>> 0;
    h[3] = h[3] + d >>> 0;
    h[4] = h[4] + e >>> 0;
    h[5] = h[5] + f >>> 0;
    h[6] = h[6] + g >>> 0;
    h[7] = h[7] + hh >>> 0;
  }
  return h.map((part) => part.toString(16).padStart(8, "0")).join("");
}
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function rotateRight(value, amount) {
  return value >>> amount | value << 32 - amount;
}
function utf8(value) {
  const result = [];
  for (let index = 0; index < value.length; index++) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 55296 && codePoint < 56320) {
      if (index + 1 < value.length) {
        const next = value.charCodeAt(index + 1);
        if (next >= 56320 && next <= 57343) {
          codePoint = 65536 + (codePoint - 55296 << 10) + next - 56320;
          index++;
        } else codePoint = 65533;
      } else codePoint = 65533;
    } else if (codePoint >= 56320 && codePoint <= 57343) codePoint = 65533;
    if (codePoint <= 127) result.push(codePoint);
    else if (codePoint <= 2047) result.push(
      192 | codePoint >> 6,
      128 | codePoint & 63
    );
    else if (codePoint <= 65535) result.push(
      224 | codePoint >> 12,
      128 | codePoint >> 6 & 63,
      128 | codePoint & 63
    );
    else result.push(
      240 | codePoint >> 18,
      128 | codePoint >> 12 & 63,
      128 | codePoint >> 6 & 63,
      128 | codePoint & 63
    );
  }
  return Uint8Array.from(result);
}
var SHA256_K = Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);

// packages/core/src/esp32/partition-table.ts
var ESP32_PARTITION_ENTRY_SIZE = 32;
var ESP32_PARTITION_TABLE_OFFSET = 32768;
var ESP32_PARTITION_TABLE_SECTOR_SIZE = 4096;
var ESP32_PARTITION_BINARY_DATA_SIZE = 3072;
var ESP32_PARTITION_BINARY_SIZE = ESP32_PARTITION_TABLE_SECTOR_SIZE - 1024;
var ESP32_PARTITION_MD5_ENTRY_SIZE = ESP32_PARTITION_ENTRY_SIZE;
var ESP32_PARTITION_MAX_ENTRIES = (ESP32_PARTITION_BINARY_DATA_SIZE - ESP32_PARTITION_MD5_ENTRY_SIZE) / ESP32_PARTITION_ENTRY_SIZE - 1;
var ESP32_PARTITION_MAX_CSV_BYTES = 64 * 1024;
var ESP32_PARTITION_MAX_LINE_BYTES = 1024;
var ESP32_PARTITION_MAX_LINES = 256;
var ESP32_PARTITION_MIN_FLASH_SIZE = 1024 * 1024;
var ESP32_PARTITION_MAX_FLASH_SIZE = 128 * 1024 * 1024;
var UINT32_MAX = 4294967295;
var APP_TYPE = 0;
var DATA_TYPE = 1;
var BOOTLOADER_TYPE = 2;
var PARTITION_TABLE_TYPE = 3;
var MD5_MAGIC = [235, 235, ...new Array(14).fill(255)];
var UTF8_ENCODER = new TextEncoder();
var TYPE_NAMES = Object.freeze({
  app: APP_TYPE,
  data: DATA_TYPE,
  bootloader: BOOTLOADER_TYPE,
  partition_table: PARTITION_TABLE_TYPE
});
var SUBTYPE_NAMES = Object.freeze({
  [BOOTLOADER_TYPE]: Object.freeze({ primary: 0, ota: 1, recovery: 2 }),
  [PARTITION_TABLE_TYPE]: Object.freeze({ primary: 0, ota: 1 }),
  [APP_TYPE]: Object.freeze({
    factory: 0,
    test: 32,
    ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`ota_${index}`, 16 + index])),
    tee_0: 48,
    tee_1: 49
  }),
  [DATA_TYPE]: Object.freeze({
    ota: 0,
    phy: 1,
    nvs: 2,
    coredump: 3,
    nvs_keys: 4,
    efuse: 5,
    undefined: 6,
    esphttpd: 128,
    fat: 129,
    spiffs: 130,
    littlefs: 131,
    tee_ota: 144
  })
});
var APP_ALIGNMENT = 65536;
var FLASH_ALIGNMENT = 4096;
var NVS_RW_MIN_SIZE = 12288;
var OTADATA_SIZE = 8192;
var MAX_LABEL_BYTES = 16;
var KNOWN_FLAGS = /* @__PURE__ */ new Set(["encrypted", "readonly"]);
var Esp32PartitionCsvError = class extends Error {
  code;
  line;
  constructor(code, message, line) {
    super(line === void 0 ? message : `line ${line}: ${message}`);
    this.name = "Esp32PartitionCsvError";
    this.code = code;
    this.line = line;
  }
};
function parseEsp32PartitionCsv(source, options) {
  const normalized = normalizeOptions(options);
  const text = decodeCsvSource(source);
  const rows = parseRows(text);
  const entries = resolveAndValidateRows(rows, normalized);
  return {
    entries,
    flashSizeBytes: normalized.flashSizeBytes,
    partitionTableOffsetBytes: normalized.partitionTableOffsetBytes
  };
}
function encodeEsp32PartitionCsv(source, options) {
  const table = parseEsp32PartitionCsv(source, options);
  return { ...table, bytes: encodeEntries(table.entries) };
}
function normalizeOptions(options) {
  if (options === null || typeof options !== "object") {
    throw new Esp32PartitionCsvError("options", "options are required");
  }
  const flashSizeBytes = options.flashSizeBytes;
  if (!isSafeInteger(flashSizeBytes) || flashSizeBytes < ESP32_PARTITION_MIN_FLASH_SIZE || flashSizeBytes > ESP32_PARTITION_MAX_FLASH_SIZE || flashSizeBytes % FLASH_ALIGNMENT !== 0 || !isStandardFlashSize(flashSizeBytes)) {
    throw new Esp32PartitionCsvError(
      "flash-range",
      `flashSizeBytes must be a 4 KiB-aligned integer from ${ESP32_PARTITION_MIN_FLASH_SIZE} through ${ESP32_PARTITION_MAX_FLASH_SIZE}`
    );
  }
  const partitionTableOffsetBytes = options.partitionTableOffsetBytes === void 0 ? ESP32_PARTITION_TABLE_OFFSET : options.partitionTableOffsetBytes;
  if (!isSafeInteger(partitionTableOffsetBytes) || partitionTableOffsetBytes < 0 || partitionTableOffsetBytes % FLASH_ALIGNMENT !== 0 || !fitsWithin(partitionTableOffsetBytes, ESP32_PARTITION_TABLE_SECTOR_SIZE, flashSizeBytes)) {
    throw new Esp32PartitionCsvError(
      "table-range",
      "partitionTableOffsetBytes must be 4 KiB aligned and its table sector must fit in flash"
    );
  }
  return { flashSizeBytes, partitionTableOffsetBytes };
}
function decodeCsvSource(source) {
  let bytes;
  let text;
  if (typeof source === "string") {
    if (source.length > ESP32_PARTITION_MAX_CSV_BYTES) {
      throw new Esp32PartitionCsvError("resource", `CSV exceeds ${ESP32_PARTITION_MAX_CSV_BYTES} bytes`);
    }
    text = source;
    bytes = UTF8_ENCODER.encode(source);
    if (bytes.byteLength > ESP32_PARTITION_MAX_CSV_BYTES) {
      throw new Esp32PartitionCsvError("resource", `CSV exceeds ${ESP32_PARTITION_MAX_CSV_BYTES} bytes`);
    }
    validateUnicodeString(source);
  } else if (source instanceof Uint8Array) {
    bytes = source;
    if (bytes.byteLength > ESP32_PARTITION_MAX_CSV_BYTES) {
      throw new Esp32PartitionCsvError("resource", `CSV exceeds ${ESP32_PARTITION_MAX_CSV_BYTES} bytes`);
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    } catch {
      throw new Esp32PartitionCsvError("encoding", "CSV must be valid UTF-8");
    }
  } else {
    throw new Esp32PartitionCsvError("encoding", "CSV source must be a string or Uint8Array");
  }
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (text.includes("\uFEFF")) {
    throw new Esp32PartitionCsvError("field", "BOM is only permitted at the beginning of the CSV");
  }
  if (text.includes("\0")) {
    throw new Esp32PartitionCsvError("field", "NUL bytes are not permitted in CSV");
  }
  return text.replace(/\r\n?/g, "\n");
}
function parseRows(text) {
  const lines = text.split("\n");
  if (lines.length > ESP32_PARTITION_MAX_LINES) {
    throw new Esp32PartitionCsvError("resource", `CSV exceeds ${ESP32_PARTITION_MAX_LINES} lines`);
  }
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (UTF8_ENCODER.encode(line).byteLength > ESP32_PARTITION_MAX_LINE_BYTES) {
      throw new Esp32PartitionCsvError("resource", `CSV line exceeds ${ESP32_PARTITION_MAX_LINE_BYTES} bytes`, lineNumber);
    }
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const fields = line.split(",").map((field) => field.trim());
    if (fields.length < 5 || fields.length > 6) {
      throw new Esp32PartitionCsvError("csv-fields", "expected five or six comma-separated fields", lineNumber);
    }
    if (fields.some((field) => field.includes('"'))) {
      throw new Esp32PartitionCsvError("csv-fields", "quoted CSV fields are not supported", lineNumber);
    }
    const label = fields[0];
    const type = parseType(fields[1], lineNumber);
    const subtype = parseSubtype(fields[2], type, lineNumber);
    const offset = parseOptionalNumber(fields[3], "offset", lineNumber);
    const size = parseRequiredNumber(fields[4], "size", lineNumber);
    const flags = parseFlags(fields[5] ?? "", lineNumber);
    validateLabel(label, lineNumber);
    rows.push({ line: lineNumber, label, type, subtype, offset, size, flags });
  }
  if (rows.length === 0) {
    throw new Esp32PartitionCsvError("empty", "CSV contains no partition entries");
  }
  if (rows.length > ESP32_PARTITION_MAX_ENTRIES) {
    throw new Esp32PartitionCsvError("resource", `CSV exceeds ${ESP32_PARTITION_MAX_ENTRIES} partition entries`);
  }
  return rows;
}
function resolveAndValidateRows(rows, options, fromEncodedTable = false) {
  const tableEnd = checkedAdd(
    options.partitionTableOffsetBytes,
    ESP32_PARTITION_TABLE_SECTOR_SIZE,
    "partition table range"
  );
  const labels = /* @__PURE__ */ new Set();
  const entries = [];
  let cursor = tableEnd;
  for (const row of rows) {
    if (labels.has(row.label)) {
      throw new Esp32PartitionCsvError("duplicate-label", `duplicate partition label '${row.label}'`, row.line);
    }
    labels.add(row.label);
    validateLabel(row.label, row.line);
    validateNumericEntry(row, options, tableEnd, fromEncodedTable);
    validateFlagsArray(row.flags, row.line);
    const alignment = row.type === APP_TYPE ? APP_ALIGNMENT : FLASH_ALIGNMENT;
    const offset = row.offset ?? alignUp(cursor, alignment, row.line);
    if (offset < tableEnd) {
      throw new Esp32PartitionCsvError(
        "table-overlap",
        `partition offset 0x${offset.toString(16)} is inside the partition table sector`,
        row.line
      );
    }
    if (offset % alignment !== 0) {
      throw new Esp32PartitionCsvError(
        "alignment",
        `partition offset 0x${offset.toString(16)} is not aligned to 0x${alignment.toString(16)}`,
        row.line
      );
    }
    if (row.offset !== void 0 && row.offset < cursor) {
      throw new Esp32PartitionCsvError(
        "overlap",
        `partition offset 0x${row.offset.toString(16)} is before the previous partition end 0x${cursor.toString(16)}`,
        row.line
      );
    }
    const end = checkedAdd(offset, row.size, "partition range", row.line);
    if (end > options.flashSizeBytes) {
      throw new Esp32PartitionCsvError(
        "flash-range",
        `partition ends at 0x${end.toString(16)}, beyond flash size 0x${options.flashSizeBytes.toString(16)}`,
        row.line
      );
    }
    validateSemanticRules(row, row.size);
    entries.push(Object.freeze({ ...row, offset }));
    cursor = end;
  }
  const ordered = [...entries].sort((left, right) => left.offset - right.offset);
  let previous;
  for (const entry of ordered) {
    if (previous !== void 0 && entry.offset < previous.offset + previous.size) {
      throw new Esp32PartitionCsvError(
        "overlap",
        `partition '${entry.label}' overlaps '${previous.label}'`,
        entry.line
      );
    }
    previous = entry;
  }
  const otadataEntries = entries.filter(
    (entry) => entry.type === DATA_TYPE && entry.subtype === SUBTYPE_NAMES[DATA_TYPE]["ota"]
  );
  if (otadataEntries.length > 1) {
    throw new Esp32PartitionCsvError("semantic", "only one otadata partition is permitted", otadataEntries[1].line);
  }
  const teeOtadataEntries = entries.filter(
    (entry) => entry.type === DATA_TYPE && entry.subtype === SUBTYPE_NAMES[DATA_TYPE]["tee_ota"]
  );
  if (teeOtadataEntries.length > 1) {
    throw new Esp32PartitionCsvError("semantic", "only one tee_ota partition is permitted", teeOtadataEntries[1].line);
  }
  return Object.freeze(entries);
}
function validateNumericEntry(row, options, tableEnd, fromEncodedTable) {
  if (!isSafeInteger(row.type) || row.type < 0 || row.type > 254) {
    throw new Esp32PartitionCsvError("field", "partition type must be an integer from 0 through 0xfe", row.line);
  }
  if (!isSafeInteger(row.subtype) || row.subtype < 0 || row.subtype > 254) {
    throw new Esp32PartitionCsvError("field", "partition subtype must be an integer from 0 through 0xfe", row.line);
  }
  if (!isSafeInteger(row.size) || row.size <= 0 || row.size > UINT32_MAX) {
    throw new Esp32PartitionCsvError("field", "partition size must be a positive 32-bit integer", row.line);
  }
  if (row.offset !== void 0 && (!isSafeInteger(row.offset) || row.offset < 0 || row.offset > UINT32_MAX)) {
    throw new Esp32PartitionCsvError("field", "partition offset must be an unsigned 32-bit integer", row.line);
  }
  if (fromEncodedTable && row.offset === void 0) {
    throw new Esp32PartitionCsvError("field", "encoded partition entries must have explicit offsets", row.line);
  }
  if (tableEnd > options.flashSizeBytes) {
    throw new Esp32PartitionCsvError("table-range", "partition table sector does not fit in flash", row.line);
  }
}
function validateSemanticRules(row, size) {
  if (row.type === APP_TYPE && size % FLASH_ALIGNMENT !== 0) {
    throw new Esp32PartitionCsvError("alignment", "application partition size must be 4 KiB aligned", row.line);
  }
  if (row.type === DATA_TYPE && row.subtype === SUBTYPE_NAMES[DATA_TYPE]["ota"] && size !== OTADATA_SIZE) {
    throw new Esp32PartitionCsvError("semantic", "otadata partition size must be exactly 0x2000", row.line);
  }
  if (row.type === DATA_TYPE && row.subtype === SUBTYPE_NAMES[DATA_TYPE]["tee_ota"] && size !== OTADATA_SIZE) {
    throw new Esp32PartitionCsvError("semantic", "tee_ota partition size must be exactly 0x2000", row.line);
  }
  if (row.type === DATA_TYPE && (row.subtype === SUBTYPE_NAMES[DATA_TYPE]["ota"] || row.subtype === SUBTYPE_NAMES[DATA_TYPE]["coredump"]) && row.flags.includes("readonly")) {
    throw new Esp32PartitionCsvError("semantic", "otadata and coredump partitions cannot be readonly", row.line);
  }
  if (row.type === DATA_TYPE && row.subtype === SUBTYPE_NAMES[DATA_TYPE]["nvs"] && size < NVS_RW_MIN_SIZE && !row.flags.includes("readonly")) {
    throw new Esp32PartitionCsvError(
      "semantic",
      `read/write nvs partition must be at least 0x${NVS_RW_MIN_SIZE.toString(16)} (or use readonly)`,
      row.line
    );
  }
}
function encodeEntries(entries) {
  if (entries.length > ESP32_PARTITION_MAX_ENTRIES) {
    throw new Esp32PartitionCsvError("resource", `too many partition entries: ${entries.length}`);
  }
  const dataLength = entries.length * ESP32_PARTITION_ENTRY_SIZE;
  const md5Offset = dataLength;
  if (md5Offset + ESP32_PARTITION_MD5_ENTRY_SIZE + ESP32_PARTITION_ENTRY_SIZE > ESP32_PARTITION_BINARY_SIZE) {
    throw new Esp32PartitionCsvError("resource", "partition table leaves no MD5/end marker entries");
  }
  const data = new Uint8Array(dataLength);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const base = index * ESP32_PARTITION_ENTRY_SIZE;
    const labelBytes = UTF8_ENCODER.encode(entry.label);
    if (labelBytes.byteLength > MAX_LABEL_BYTES) {
      throw new Esp32PartitionCsvError("label", "partition label exceeds 16 UTF-8 bytes", entry.line);
    }
    data[base] = 170;
    data[base + 1] = 80;
    data[base + 2] = entry.type;
    data[base + 3] = entry.subtype;
    view.setUint32(base + 4, entry.offset, true);
    view.setUint32(base + 8, entry.size, true);
    data.set(labelBytes, base + 12);
    let flags = 0;
    if (entry.flags.includes("encrypted")) flags |= 1;
    if (entry.flags.includes("readonly")) flags |= 2;
    view.setUint32(base + 28, flags, true);
  }
  const digest = md5(data);
  const output = new Uint8Array(ESP32_PARTITION_BINARY_SIZE);
  output.fill(255);
  output.set(data, 0);
  output.set(MD5_MAGIC, md5Offset);
  output.set(digest, md5Offset + 16);
  return output;
}
function validateLabel(label, line) {
  if (typeof label !== "string") {
    throw new Esp32PartitionCsvError("label", "partition label must be a string", line);
  }
  if (label.length === 0) {
    throw new Esp32PartitionCsvError("label", "partition label cannot be empty", line);
  }
  if (label.includes("\0")) {
    throw new Esp32PartitionCsvError("label", "partition label cannot contain NUL", line);
  }
  for (const character of label) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 32 || codePoint === 127 || character === "," || character === '"') {
      throw new Esp32PartitionCsvError("label", "partition label contains an illegal character", line);
    }
  }
  if (UTF8_ENCODER.encode(label).byteLength > MAX_LABEL_BYTES) {
    throw new Esp32PartitionCsvError("label", "partition label exceeds 16 UTF-8 bytes", line);
  }
}
function parseType(value, line) {
  if (value.length === 0) throw new Esp32PartitionCsvError("field", "Field 'type' cannot be empty", line);
  return parseNumberOrName(value, TYPE_NAMES, "type", line);
}
function parseSubtype(value, type, line) {
  if (value.length === 0) {
    if (type === APP_TYPE) {
      throw new Esp32PartitionCsvError("field", "app partition subtype cannot be empty", line);
    }
    if (type === DATA_TYPE) return SUBTYPE_NAMES[DATA_TYPE]["undefined"];
    throw new Esp32PartitionCsvError("field", "custom partition subtype cannot be empty", line);
  }
  return parseNumberOrName(value, SUBTYPE_NAMES[type] ?? {}, "subtype", line);
}
function parseFlags(value, line) {
  if (value.length === 0) return Object.freeze([]);
  const flags = [];
  const seen = /* @__PURE__ */ new Set();
  for (const rawFlag of value.split(":")) {
    const flag = rawFlag.trim();
    if (!KNOWN_FLAGS.has(flag)) {
      throw new Esp32PartitionCsvError("flags", `unknown partition flag '${flag}'`, line);
    }
    if (seen.has(flag)) {
      throw new Esp32PartitionCsvError("flags", `duplicate partition flag '${flag}'`, line);
    }
    seen.add(flag);
    flags.push(flag);
  }
  return Object.freeze(["encrypted", "readonly"].filter((flag) => seen.has(flag)));
}
function validateFlagsArray(flags, line) {
  if (!Array.isArray(flags)) {
    throw new Esp32PartitionCsvError("flags", "partition flags must be an array", line);
  }
  const seen = /* @__PURE__ */ new Set();
  for (const flag of flags) {
    if (typeof flag !== "string" || !KNOWN_FLAGS.has(flag)) {
      throw new Esp32PartitionCsvError("flags", `unknown partition flag '${String(flag)}'`, line);
    }
    if (seen.has(flag)) {
      throw new Esp32PartitionCsvError("flags", `duplicate partition flag '${flag}'`, line);
    }
    seen.add(flag);
  }
}
function parseOptionalNumber(value, field, line) {
  if (value.length === 0) return void 0;
  return parseNumber(value, field, line);
}
function parseRequiredNumber(value, field, line) {
  if (value.length === 0) {
    throw new Esp32PartitionCsvError("field", `Field '${field}' cannot be empty`, line);
  }
  return parseNumber(value, field, line);
}
function parseNumberOrName(value, names, field, line) {
  const lowered = value.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(names, lowered)) return names[lowered];
  return parseNumber(value, field, line);
}
function parseNumber(value, field, line) {
  const match = /^(0[xX][0-9a-fA-F]+|[0-9]+)(KB?|MB?)?$/i.exec(value);
  if (match === null) {
    throw new Esp32PartitionCsvError("field", `invalid ${field} value '${value}'`, line);
  }
  const numberPart = match[1];
  const suffix = match[2]?.toLowerCase();
  let base;
  if (numberPart.startsWith("0x") || numberPart.startsWith("0X")) {
    base = Number.parseInt(numberPart.slice(2), 16);
  } else {
    base = Number.parseInt(numberPart, 10);
  }
  const multiplier = suffix === "k" || suffix === "kb" ? 1024 : suffix === "m" || suffix === "mb" ? 1024 * 1024 : 1;
  const result = base * multiplier;
  if (!Number.isSafeInteger(result) || result < 0 || result > UINT32_MAX) {
    throw new Esp32PartitionCsvError("overflow", `${field} value '${value}' overflows uint32`, line);
  }
  return result;
}
function alignUp(value, alignment, line) {
  const remainder = value % alignment;
  const aligned = remainder === 0 ? value : value + alignment - remainder;
  if (!Number.isSafeInteger(aligned) || aligned > UINT32_MAX) {
    throw new Esp32PartitionCsvError("overflow", "automatic partition offset overflows uint32", line);
  }
  return aligned;
}
function checkedAdd(left, right, field, line) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0 || result > UINT32_MAX) {
    throw new Esp32PartitionCsvError("overflow", `${field} overflows uint32`, line);
  }
  return result;
}
function fitsWithin(offset, size, limit) {
  return offset >= 0 && size >= 0 && Number.isSafeInteger(offset + size) && offset + size <= limit;
}
function isSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function validateUnicodeString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 55296 && codeUnit <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (next < 56320 || next > 57343) {
        throw new Esp32PartitionCsvError("encoding", "CSV contains an unpaired UTF-16 surrogate");
      }
      index += 1;
    } else if (codeUnit >= 56320 && codeUnit <= 57343) {
      throw new Esp32PartitionCsvError("encoding", "CSV contains an unpaired UTF-16 surrogate");
    }
  }
}
function isStandardFlashSize(value) {
  const mebibytes = value / (1024 * 1024);
  return Number.isInteger(mebibytes) && (mebibytes & mebibytes - 1) === 0;
}
function md5(input) {
  const paddedLength = input.length + 9 + 63 >> 6 << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 128;
  const bitLength = input.length * 8;
  const paddedView = new DataView(padded.buffer);
  paddedView.setUint32(paddedLength - 8, bitLength >>> 0, true);
  paddedView.setUint32(paddedLength - 4, Math.floor(bitLength / 4294967296), true);
  let a0 = 1732584193;
  let b0 = 4023233417;
  let c0 = 2562383102;
  let d0 = 271733878;
  const shifts = [
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21
  ];
  const constants = [
    3614090360,
    3905402710,
    606105819,
    3250441966,
    4118548399,
    1200080426,
    2821735955,
    4249261313,
    1770035416,
    2336552879,
    4294925233,
    2304563134,
    1804603682,
    4254626195,
    2792965006,
    1236535329,
    4129170786,
    3225465664,
    643717713,
    3921069994,
    3593408605,
    38016083,
    3634488961,
    3889429448,
    568446438,
    3275163606,
    4107603335,
    1163531501,
    2850285829,
    4243563512,
    1735328473,
    2368359562,
    4294588738,
    2272392833,
    1839030562,
    4259657740,
    2763975236,
    1272893353,
    4139469664,
    3200236656,
    681279174,
    3936430074,
    3572445317,
    76029189,
    3654602809,
    3873151461,
    530742520,
    3299628645,
    4096336452,
    1126891415,
    2878612391,
    4237533241,
    1700485571,
    2399980690,
    4293915773,
    2240044497,
    1873313359,
    4264355552,
    2734768916,
    1309151649,
    4149444226,
    3174756917,
    718787259,
    3951481745
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
      let f;
      let g;
      if (index < 16) {
        f = b & c | ~b & d;
        g = index;
      } else if (index < 32) {
        f = d & b | ~d & c;
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = 7 * index % 16;
      }
      const next = d;
      const sum = a + f + constants[index] + words[g] >>> 0;
      d = c;
      c = b;
      b = b + rotateLeft(sum, shifts[index]) >>> 0;
      a = next;
    }
    a0 = a0 + a >>> 0;
    b0 = b0 + b >>> 0;
    c0 = c0 + c >>> 0;
    d0 = d0 + d >>> 0;
  }
  const result = new Uint8Array(16);
  const view = new DataView(result.buffer);
  view.setUint32(0, a0, true);
  view.setUint32(4, b0, true);
  view.setUint32(8, c0, true);
  view.setUint32(12, d0, true);
  return result;
}
function rotateLeft(value, amount) {
  return (value << amount | value >>> 32 - amount) >>> 0;
}

// packages/core/src/esp32/custom-partitions.ts
var ESP32_CUSTOM_PARTITIONS_FILE = "partitions.csv";
var ESP32_CUSTOM_PARTITIONS_SCHEMA_VERSION = 2;
var ESP32_CUSTOM_PARTITIONS_MAX_BYTES = ESP32_PARTITION_MAX_CSV_BYTES;
var ESP32_APPLICATION_FLASH_OFFSET_BYTES = 65536;
var ESP32_APP_PARTITION_TYPE = 0;
var ESP32_FACTORY_APP_SUBTYPE = 0;
var ESP32_OTA_APP_SUBTYPE_MIN = 16;
var ESP32_OTA_APP_SUBTYPE_MAX = 31;
var Esp32CustomPartitionsError = class extends Error {
  code;
  path;
  line;
  csvCode;
  constructor(code, message, details = {}) {
    super(message, details.cause === void 0 ? void 0 : { cause: details.cause });
    this.name = "Esp32CustomPartitionsError";
    this.code = code;
    this.path = details.path;
    this.line = details.line;
    this.csvCode = details.csvCode;
  }
};
function projectSnapshotSha256(files) {
  if (!Array.isArray(files)) throw new TypeError("project snapshot files must be an array");
  const normalized = files.map((file, index) => {
    if (!isRecord(file) || Array.isArray(file)) {
      throw new TypeError(`project snapshot file ${index} must be an object`);
    }
    const value = file;
    const rawPath = typeof value.path === "string" ? value.path : typeof value.name === "string" ? value.name : void 0;
    if (rawPath === void 0) {
      throw new TypeError(`project snapshot file ${index} must have path or name`);
    }
    if (typeof value.content !== "string") {
      throw new TypeError(`project snapshot file ${index} content must be text`);
    }
    const path = normalizeProjectSnapshotPath(rawPath, index);
    const language = value.language ?? inferProjectSnapshotLanguage(path);
    if (!isProjectLanguage(language)) {
      throw new TypeError(`project snapshot file ${path} language is invalid`);
    }
    const generated = value.generated ?? false;
    if (typeof generated !== "boolean") {
      throw new TypeError(`project snapshot file ${path} generated must be boolean`);
    }
    return { path, content: value.content, language, generated };
  }).sort((left, right) => compareProjectPath(left.path, right.path));
  const foldedPaths = /* @__PURE__ */ new Set();
  for (const file of normalized) {
    const folded = file.path.toLowerCase();
    if (foldedPaths.has(folded)) {
      throw new TypeError(`duplicate project snapshot file: ${file.path}`);
    }
    foldedPaths.add(folded);
  }
  return sha256Hex(canonicalJson(normalized));
}
function resolveCustomEsp32Partitions(files, options) {
  const file = findUniqueRootPartitionFile(files);
  if (file === null) return null;
  const projectSnapshotHash = projectSnapshotSha256(files);
  const csvOptions = normalizeCodecOptions(options);
  const sourceBytes = encodeUtf8(file.content, file.name);
  if (sourceBytes.byteLength > ESP32_CUSTOM_PARTITIONS_MAX_BYTES) {
    throw new Esp32CustomPartitionsError(
      "size",
      `${ESP32_CUSTOM_PARTITIONS_FILE} exceeds ${ESP32_CUSTOM_PARTITIONS_MAX_BYTES} UTF-8 bytes`,
      { path: file.name }
    );
  }
  let table;
  let encodedBytes;
  try {
    table = parseEsp32PartitionCsv(sourceBytes, csvOptions);
    const compilation = encodeEsp32PartitionCsv(sourceBytes, csvOptions);
    if (compilation.flashSizeBytes !== table.flashSizeBytes || compilation.partitionTableOffsetBytes !== table.partitionTableOffsetBytes) {
      throw new Esp32CustomPartitionsError(
        "codec",
        "ESP32 partition parser and encoder returned different target geometry",
        { path: file.name }
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
    kind: "project-owned-esp32-partitions",
    schemaVersion: ESP32_CUSTOM_PARTITIONS_SCHEMA_VERSION,
    path: ESP32_CUSTOM_PARTITIONS_FILE,
    sourceSha256,
    sourceSize: sourceBytes.byteLength,
    tableSha256,
    tableSize: encodedBytes.byteLength,
    projectSnapshotSha256: projectSnapshotHash,
    flashSizeBytes: stableTable.flashSizeBytes,
    partitionTableOffsetBytes: stableTable.partitionTableOffsetBytes,
    applicationSlot
  }));
  return Object.freeze({
    kind: "project-owned-esp32-partitions",
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
    identitySha256
  });
}
function resolveEsp32ApplicationSlot(table) {
  if (!isRecord(table) || !Array.isArray(table.entries)) {
    throw new TypeError("ESP32 partition table is required");
  }
  const imageOffset = ESP32_APPLICATION_FLASH_OFFSET_BYTES;
  const covering = table.entries.filter((entry2) => partitionContainsOffset(entry2, imageOffset));
  const entry = covering.find((candidate) => candidate.type === ESP32_APP_PARTITION_TYPE && isBootableApplicationSubtype(candidate.subtype));
  if (!entry) {
    const coveringApp = covering.find((candidate) => candidate.type === ESP32_APP_PARTITION_TYPE);
    const detail = coveringApp ? `partition '${coveringApp.label}' has non-bootable app subtype 0x${coveringApp.subtype.toString(16)}` : `no bootable app partition covers 0x${imageOffset.toString(16)}`;
    throw new Esp32CustomPartitionsError(
      "bootability",
      `invalid ESP32 custom partition layout: ${detail}`,
      coveringApp ? { path: ESP32_CUSTOM_PARTITIONS_FILE, line: coveringApp.line } : {
        path: ESP32_CUSTOM_PARTITIONS_FILE
      }
    );
  }
  const endBytes = entry.offset + entry.size;
  return Object.freeze({
    label: entry.label,
    subtype: entry.subtype,
    line: entry.line,
    offsetBytes: entry.offset,
    endBytes,
    maxBytes: endBytes - imageOffset
  });
}
function assertEsp32ApplicationFitsSlot(applicationSizeBytes, slot) {
  if (!Number.isSafeInteger(applicationSizeBytes) || applicationSizeBytes < 0) {
    throw new TypeError("ESP32 application artifact size must be a non-negative safe integer");
  }
  assertApplicationSlot(slot);
  if (applicationSizeBytes <= slot.maxBytes) return;
  throw new Esp32CustomPartitionsError(
    "capacity",
    `ESP32 application artifact is ${applicationSizeBytes} bytes, exceeding custom partition slot '${slot.label}' capacity ${slot.maxBytes} bytes (0x${ESP32_APPLICATION_FLASH_OFFSET_BYTES.toString(16)}..0x${slot.endBytes.toString(16)})`,
    { path: ESP32_CUSTOM_PARTITIONS_FILE, line: slot.line }
  );
}
function partitionContainsOffset(entry, offset) {
  return entry.offset <= offset && offset < entry.offset + entry.size;
}
function isBootableApplicationSubtype(subtype) {
  return subtype === ESP32_FACTORY_APP_SUBTYPE || subtype >= ESP32_OTA_APP_SUBTYPE_MIN && subtype <= ESP32_OTA_APP_SUBTYPE_MAX;
}
function assertApplicationSlot(slot) {
  if (!isRecord(slot) || typeof slot.label !== "string" || slot.label.length === 0 || !Number.isSafeInteger(slot.subtype) || !isBootableApplicationSubtype(slot.subtype) || !Number.isSafeInteger(slot.line) || slot.line < 1 || !Number.isSafeInteger(slot.offsetBytes) || !Number.isSafeInteger(slot.endBytes) || !Number.isSafeInteger(slot.maxBytes) || slot.offsetBytes > ESP32_APPLICATION_FLASH_OFFSET_BYTES || slot.endBytes <= ESP32_APPLICATION_FLASH_OFFSET_BYTES || slot.maxBytes <= 0 || slot.maxBytes !== slot.endBytes - ESP32_APPLICATION_FLASH_OFFSET_BYTES) {
    throw new TypeError("ESP32 application slot is invalid");
  }
}
function findUniqueRootPartitionFile(files) {
  if (!Array.isArray(files)) {
    throw new Esp32CustomPartitionsError("files", "project files must be an array");
  }
  const matches = [];
  for (const value of files) {
    if (!isRecord(value) || Array.isArray(value)) {
      throw new Esp32CustomPartitionsError("file", "each project file must be an object");
    }
    const name = value.name;
    if (typeof name !== "string" || name.length === 0 || name.includes("\0")) {
      throw new Esp32CustomPartitionsError("file", "each project file must have a valid name");
    }
    assertWellFormedText(name, name, "file name");
    const isRootPartitionFile = classifyPartitionPath(name);
    const content = value.content;
    if (typeof content !== "string") {
      throw new Esp32CustomPartitionsError(
        "non-text",
        `project file ${name} must contain text content, not binary data`,
        { path: name }
      );
    }
    if (isRootPartitionFile) {
      assertWellFormedText(content, name, "partition CSV");
      matches.push(value);
    }
  }
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Esp32CustomPartitionsError(
      "duplicate",
      `project contains ${matches.length} root-level ${ESP32_CUSTOM_PARTITIONS_FILE} files`,
      { path: ESP32_CUSTOM_PARTITIONS_FILE }
    );
  }
  return matches[0];
}
function classifyPartitionPath(name) {
  if (name === ESP32_CUSTOM_PARTITIONS_FILE) return true;
  const logicalPath = name.replaceAll("\\", "/");
  const segments = logicalPath.split("/");
  const lowerSegments = segments.map((segment) => segment.trim().toLowerCase());
  const rootSegment = ESP32_CUSTOM_PARTITIONS_FILE.toLowerCase();
  const rootIndex = lowerSegments.indexOf(rootSegment);
  if (rootIndex !== -1) {
    if (segments.length === 1) {
      throw new Esp32CustomPartitionsError(
        "extension",
        `custom partition file must be named exactly ${ESP32_CUSTOM_PARTITIONS_FILE}`,
        { path: name }
      );
    }
    throw new Esp32CustomPartitionsError(
      "subdirectory",
      `custom partition file must be at the project root: ${name}`,
      { path: name }
    );
  }
  const leaf = lowerSegments[lowerSegments.length - 1] ?? "";
  const partitionLike = leaf === "partitions" || leaf.startsWith("partitions.");
  if (partitionLike) {
    throw new Esp32CustomPartitionsError(
      segments.length === 1 ? "extension" : "subdirectory",
      `custom partition file must use the exact root path ${ESP32_CUSTOM_PARTITIONS_FILE}: ${name}`,
      { path: name }
    );
  }
  return false;
}
function normalizeCodecOptions(options) {
  if (!isRecord(options) || Array.isArray(options)) {
    throw new Esp32CustomPartitionsError("options", "ESP32 custom partition options are required");
  }
  if (!Number.isSafeInteger(options.flashSizeBytes)) {
    throw new Esp32CustomPartitionsError("options", "flashSizeBytes must be a safe integer");
  }
  if (options.partitionTableOffsetBytes !== void 0 && !Number.isSafeInteger(options.partitionTableOffsetBytes)) {
    throw new Esp32CustomPartitionsError(
      "options",
      "partitionTableOffsetBytes must be a safe integer when provided"
    );
  }
  return {
    flashSizeBytes: options.flashSizeBytes,
    ...options.partitionTableOffsetBytes === void 0 ? {} : { partitionTableOffsetBytes: options.partitionTableOffsetBytes }
  };
}
function encodeUtf8(value, path) {
  assertWellFormedText(value, path, "partition CSV");
  return new TextEncoder().encode(value);
}
function assertWellFormedText(value, path, label) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 55296 && code <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 56320 || next > 57343) {
        throw new Esp32CustomPartitionsError(
          "non-text",
          `${label} in ${path} contains an unpaired UTF-16 surrogate`,
          { path }
        );
      }
      index += 1;
    } else if (code >= 56320 && code <= 57343) {
      throw new Esp32CustomPartitionsError(
        "non-text",
        `${label} in ${path} contains an unpaired UTF-16 surrogate`,
        { path }
      );
    }
  }
}
function wrapCodecError(error, path) {
  if (error instanceof Esp32PartitionCsvError) {
    const optionsError = error.line === void 0 && (error.code === "options" || error.code === "flash-range" || error.code === "table-range");
    return new Esp32CustomPartitionsError(
      optionsError ? "options" : "csv",
      `invalid ESP32 partition CSV ${path}: ${error.message}`,
      { path, line: error.line, csvCode: error.code, cause: error }
    );
  }
  return new Esp32CustomPartitionsError(
    "codec",
    `ESP32 partition codec failed for ${path}`,
    { path, cause: error }
  );
}
function clonePartitionTable(table) {
  const entries = Object.freeze(table.entries.map((entry) => Object.freeze({
    ...entry,
    flags: Object.freeze([...entry.flags])
  })));
  return Object.freeze({
    entries,
    flashSizeBytes: table.flashSizeBytes,
    partitionTableOffsetBytes: table.partitionTableOffsetBytes
  });
}
function normalizeProjectSnapshotPath(value, index) {
  const path = value.replaceAll("\\", "/");
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").includes("..")) {
    throw new TypeError(`project snapshot file ${index} path must be relative and must not contain '..': ${value}`);
  }
  return path.split("/").filter((part) => part.length > 0 && part !== ".").join("/");
}
function inferProjectSnapshotLanguage(path) {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  if (extension === "ino") return "ino";
  if (extension === "c") return "c";
  if (extension === "cc" || extension === "cpp" || extension === "cxx") return "c++";
  if (extension === "s" || extension === "asm") return "asm";
  if (extension === "h" || extension === "hh" || extension === "hpp" || extension === "hxx") return "header";
  return "other";
}
function isProjectLanguage(value) {
  return value === "ino" || value === "c" || value === "c++" || value === "asm" || value === "header" || value === "other";
}
function compareProjectPath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function isRecord(value) {
  return value !== null && typeof value === "object";
}
export {
  ESP32_APPLICATION_FLASH_OFFSET_BYTES,
  ESP32_CUSTOM_PARTITIONS_FILE,
  ESP32_CUSTOM_PARTITIONS_MAX_BYTES,
  ESP32_CUSTOM_PARTITIONS_SCHEMA_VERSION,
  Esp32CustomPartitionsError,
  assertEsp32ApplicationFitsSlot,
  projectSnapshotSha256,
  resolveCustomEsp32Partitions,
  resolveEsp32ApplicationSlot
};
