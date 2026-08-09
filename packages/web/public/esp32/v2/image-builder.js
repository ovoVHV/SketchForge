/**
 * ESP32 application image writer for the browser toolchain path.
 *
 * This deliberately implements the on-flash image format locally instead of
 * shelling out to a host tool. It accepts the normal 32-bit little-endian
 * Xtensa or RISC-V ELF layout emitted by the ESP32 Arduino toolchains.
 */

export const ESP32_IMAGE_CHIP_ID = 0;
export const ESP32_S2_IMAGE_CHIP_ID = 2;
export const ESP32_S3_IMAGE_CHIP_ID = 9;
export const ESP32_C3_IMAGE_CHIP_ID = 5;
export const ESP32_C5_IMAGE_CHIP_ID = 23;
export const ESP32_C6_IMAGE_CHIP_ID = 13;
export const ESP32_H2_IMAGE_CHIP_ID = 16;
export const ESP32_P4_IMAGE_CHIP_ID = 18;
export const ESP32_C3_MMU_PAGE_SIZE = 64 * 1024;
export const ESP32_C3_ELF_SHA256_OFFSET = 0xb0;

const MAX_ELF_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_SECTION_HEADERS = 4096;
const MAX_IMAGE_SEGMENTS = 16;
const MAX_SEGMENT_BYTES = 0x1000000 - 1;
const SEGMENT_HEADER_BYTES = 8;
const ELF_HEADER_BYTES = 0x34;
const ELF_SECTION_HEADER_BYTES = 0x28;
const IMAGE_MAGIC = 0xe9;
const CHECKSUM_SEED = 0xef;
const ELF_MACHINE_XTENSA = 0x5e;
const ELF_MACHINE_RISCV = 0xf3;

const DATA_SECTION_TYPES = new Set([1, 14, 15, 16]);
const FLASH_MODES = Object.freeze({ qio: 0, qout: 1, dio: 2, dout: 3 });
const FLASH_SIZES = Object.freeze({
  "1MB": 0x00,
  "2MB": 0x10,
  "4MB": 0x20,
  "8MB": 0x30,
  "16MB": 0x40,
  "32MB": 0x50,
  "64MB": 0x60,
  "128MB": 0x70,
});
const FLASH_FREQUENCIES = Object.freeze({ "80m": 0x0f, "40m": 0x00, "26m": 0x01, "20m": 0x02 });

const ESP32_MEMORY_MAP = Object.freeze([
  [0x00000000, 0x00010000, "padding"],
  [0x3f400000, 0x3f800000, "drom"],
  [0x3f800000, 0x3fc00000, "extram-data"],
  [0x3ff80000, 0x3ff82000, "rtc-dram"],
  [0x3ff90000, 0x40000000, "byte-accessible"],
  [0x3ffae000, 0x40000000, "dram"],
  [0x3ffe0000, 0x3ffffffc, "diram-dram"],
  [0x40000000, 0x40070000, "irom"],
  [0x40070000, 0x40078000, "cache-pro"],
  [0x40078000, 0x40080000, "cache-app"],
  [0x40080000, 0x400a0000, "iram"],
  [0x400a0000, 0x400bfffc, "diram-iram"],
  [0x400c0000, 0x400c2000, "rtc-iram"],
  [0x400d0000, 0x40400000, "irom"],
  [0x50000000, 0x50002000, "rtc-data"],
]);

const S2_MEMORY_MAP = Object.freeze([
  [0x00000000, 0x00010000, "padding"],
  [0x3f000000, 0x3ff80000, "drom"],
  [0x3f500000, 0x3ff80000, "extram-data"],
  [0x3ff9e000, 0x3ffa0000, "rtc-dram"],
  [0x3ff9e000, 0x40000000, "byte-accessible"],
  [0x3ff9e000, 0x40072000, "internal"],
  [0x3ffb0000, 0x40000000, "dram"],
  [0x40000000, 0x4001a100, "irom-mask"],
  [0x40020000, 0x40070000, "iram"],
  [0x40070000, 0x40072000, "rtc-iram"],
  [0x40080000, 0x40800000, "irom"],
  [0x50000000, 0x50002000, "rtc-data"],
]);

const S3_MEMORY_MAP = Object.freeze([
  [0x00000000, 0x00010000, "padding"],
  [0x3c000000, 0x3d000000, "drom"],
  [0x3d000000, 0x3e000000, "extram-data"],
  [0x600fe000, 0x60100000, "rtc-dram"],
  [0x3fc88000, 0x3fd00000, "byte-accessible"],
  [0x3fc88000, 0x403e2000, "internal"],
  [0x3fc88000, 0x3fd00000, "dram"],
  [0x40000000, 0x4001a100, "irom-mask"],
  [0x40370000, 0x403e0000, "iram"],
  [0x600fe000, 0x60100000, "rtc-iram"],
  [0x42000000, 0x42800000, "irom"],
  [0x50000000, 0x50002000, "rtc-data"],
]);

// The overlapping ranges matter: esptool only merges sections when their full
// memory-type sets match, not merely when both happen to be RAM.
const C3_MEMORY_MAP = Object.freeze([
  [0x00000000, 0x00010000, "padding"],
  [0x3c000000, 0x3c800000, "drom"],
  [0x3fc80000, 0x3fce0000, "dram"],
  [0x3fc88000, 0x3fd00000, "byte-accessible"],
  [0x3ff00000, 0x3ff20000, "drom-mask"],
  [0x40000000, 0x40060000, "irom-mask"],
  [0x42000000, 0x42800000, "irom"],
  [0x4037c000, 0x403e0000, "iram"],
  [0x50000000, 0x50002000, "rtc-iram"],
  [0x50000000, 0x50002000, "rtc-dram"],
  [0x600fe000, 0x60100000, "internal"],
]);

// ESP32-C6 maps instruction and data flash through the same address range.
// Keep the overlapping memory types because esptool uses the full type set
// when deciding whether adjacent ELF sections may be merged.
const C6_MEMORY_MAP = Object.freeze([
  [0x00000000, 0x00010000, "padding"],
  [0x42000000, 0x43000000, "drom"],
  [0x40800000, 0x40880000, "dram"],
  [0x40800000, 0x40880000, "byte-accessible"],
  [0x4004ac00, 0x40050000, "drom-mask"],
  [0x40000000, 0x4004ac00, "irom-mask"],
  [0x42000000, 0x43000000, "irom"],
  [0x40800000, 0x40880000, "iram"],
  [0x50000000, 0x50004000, "rtc-iram"],
  [0x50000000, 0x50004000, "rtc-dram"],
  [0x600fe000, 0x60100000, "internal"],
]);

// ESP32-C5 also has a shared instruction/data flash bus, but its mapped flash
// window and internal RAM layout differ from ESP32-C6.
const C5_MEMORY_MAP = Object.freeze([
  [0x00000000, 0x00010000, "padding"],
  [0x42000000, 0x44000000, "drom"],
  [0x40800000, 0x40860000, "dram"],
  [0x40800000, 0x40860000, "byte-accessible"],
  [0x4003a000, 0x40040000, "drom-mask"],
  [0x40000000, 0x4003a000, "irom-mask"],
  [0x42000000, 0x44000000, "irom"],
  [0x40800000, 0x40860000, "iram"],
  [0x50000000, 0x50004000, "rtc-iram"],
  [0x50000000, 0x50004000, "rtc-dram"],
  [0x600fe000, 0x60100000, "internal"],
]);

// ESP32-P4 maps instruction and data flash over the same wide address range.
// Its high internal-RAM addresses and RTC window are distinct from the C-series.
const P4_MEMORY_MAP = Object.freeze([
  [0x00000000, 0x00010000, "padding"],
  [0x40000000, 0x4c000000, "drom"],
  [0x4ff00000, 0x4ffa0000, "dram"],
  [0x4ff00000, 0x4ffa0000, "byte-accessible"],
  [0x4fc00000, 0x4fc20000, "drom-mask"],
  [0x4fc00000, 0x4fc20000, "irom-mask"],
  [0x40000000, 0x4c000000, "irom"],
  [0x4ff00000, 0x4ffa0000, "iram"],
  [0x50108000, 0x50110000, "rtc-iram"],
  [0x50108000, 0x50110000, "rtc-dram"],
  [0x600fe000, 0x60100000, "internal"],
]);

const IMAGE_TARGETS = Object.freeze({
  esp32: Object.freeze({
    label: "ESP32",
    chipId: ESP32_IMAGE_CHIP_ID,
    elfMachine: ELF_MACHINE_XTENSA,
    elfArchitecture: "Xtensa",
    mmuPageSize: ESP32_C3_MMU_PAGE_SIZE,
    elfSha256Offset: ESP32_C3_ELF_SHA256_OFFSET,
    memoryMap: ESP32_MEMORY_MAP,
    flashFrequencies: FLASH_FREQUENCIES,
    flashRanges: Object.freeze([
      Object.freeze([0x400d0000, 0x40400000]),
      Object.freeze([0x3f400000, 0x3f800000]),
    ]),
  }),
  esp32s2: Object.freeze({
    label: "ESP32-S2",
    chipId: ESP32_S2_IMAGE_CHIP_ID,
    elfMachine: ELF_MACHINE_XTENSA,
    elfArchitecture: "Xtensa",
    mmuPageSize: ESP32_C3_MMU_PAGE_SIZE,
    elfSha256Offset: ESP32_C3_ELF_SHA256_OFFSET,
    memoryMap: S2_MEMORY_MAP,
    flashFrequencies: FLASH_FREQUENCIES,
    flashRanges: Object.freeze([
      Object.freeze([0x40080000, 0x40b80000]),
      Object.freeze([0x3f000000, 0x3f3f0000]),
    ]),
  }),
  esp32s3: Object.freeze({
    label: "ESP32-S3",
    chipId: ESP32_S3_IMAGE_CHIP_ID,
    elfMachine: ELF_MACHINE_XTENSA,
    elfArchitecture: "Xtensa",
    mmuPageSize: ESP32_C3_MMU_PAGE_SIZE,
    elfSha256Offset: ESP32_C3_ELF_SHA256_OFFSET,
    memoryMap: S3_MEMORY_MAP,
    flashFrequencies: FLASH_FREQUENCIES,
    flashRanges: Object.freeze([
      Object.freeze([0x42000000, 0x44000000]),
      Object.freeze([0x3c000000, 0x3e000000]),
    ]),
  }),
  esp32c3: Object.freeze({
    label: "ESP32-C3",
    chipId: ESP32_C3_IMAGE_CHIP_ID,
    elfMachine: ELF_MACHINE_RISCV,
    elfArchitecture: "RISC-V",
    mmuPageSize: ESP32_C3_MMU_PAGE_SIZE,
    elfSha256Offset: ESP32_C3_ELF_SHA256_OFFSET,
    memoryMap: C3_MEMORY_MAP,
    flashFrequencies: FLASH_FREQUENCIES,
    flashRanges: Object.freeze([
      Object.freeze([0x42000000, 0x42800000]),
      Object.freeze([0x3c000000, 0x3c800000]),
    ]),
  }),
  esp32c5: Object.freeze({
    label: "ESP32-C5",
    chipId: ESP32_C5_IMAGE_CHIP_ID,
    elfMachine: ELF_MACHINE_RISCV,
    elfArchitecture: "RISC-V",
    mmuPageSize: 64 * 1024,
    elfSha256Offset: ESP32_C3_ELF_SHA256_OFFSET,
    memoryMap: C5_MEMORY_MAP,
    flashFrequencies: Object.freeze({ "80m": 0x0f, "40m": 0x00, "20m": 0x02 }),
    flashRanges: Object.freeze([
      Object.freeze([0x42000000, 0x44000000]),
    ]),
  }),
  esp32c6: Object.freeze({
    label: "ESP32-C6",
    chipId: ESP32_C6_IMAGE_CHIP_ID,
    elfMachine: ELF_MACHINE_RISCV,
    elfArchitecture: "RISC-V",
    mmuPageSize: 64 * 1024,
    elfSha256Offset: ESP32_C3_ELF_SHA256_OFFSET,
    memoryMap: C6_MEMORY_MAP,
    flashFrequencies: Object.freeze({ "80m": 0x00, "40m": 0x00, "20m": 0x02 }),
    flashRanges: Object.freeze([
      Object.freeze([0x42000000, 0x43000000]),
    ]),
  }),
  esp32h2: Object.freeze({
    label: "ESP32-H2",
    chipId: ESP32_H2_IMAGE_CHIP_ID,
    elfMachine: ELF_MACHINE_RISCV,
    elfArchitecture: "RISC-V",
    mmuPageSize: 64 * 1024,
    elfSha256Offset: ESP32_C3_ELF_SHA256_OFFSET,
    memoryMap: C6_MEMORY_MAP,
    flashFrequencies: Object.freeze({ "48m": 0x0f, "24m": 0x00, "16m": 0x01, "12m": 0x02 }),
    flashRanges: Object.freeze([
      Object.freeze([0x42000000, 0x43000000]),
    ]),
  }),
  esp32p4: Object.freeze({
    label: "ESP32-P4",
    chipId: ESP32_P4_IMAGE_CHIP_ID,
    elfMachine: ELF_MACHINE_RISCV,
    elfArchitecture: "RISC-V",
    mmuPageSize: 64 * 1024,
    elfSha256Offset: ESP32_C3_ELF_SHA256_OFFSET,
    memoryMap: P4_MEMORY_MAP,
    flashFrequencies: FLASH_FREQUENCIES,
    flashRanges: Object.freeze([
      Object.freeze([0x40000000, 0x4c000000]),
    ]),
  }),
});

export class Esp32C3ImageError extends Error {
  constructor(message) {
    super(message);
    this.name = "Esp32C3ImageError";
  }
}

function fail(message) {
  throw new Esp32C3ImageError(message);
}

function asBytes(value, label) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  throw new TypeError(`${label} must be an ArrayBuffer or typed array`);
}

function requireRange(total, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > total || length > total - offset) {
    fail(`${label} is outside the ELF file`);
  }
}

function padToFour(bytes) {
  const padding = (4 - (bytes.byteLength % 4)) % 4;
  if (padding === 0) return bytes;
  const padded = new Uint8Array(bytes.byteLength + padding);
  padded.set(bytes);
  return padded;
}

function sectionName(stringTable, offset) {
  if (offset >= stringTable.byteLength) fail("ELF section name offset is outside the string table");
  const end = stringTable.indexOf(0, offset);
  if (end === -1) fail("ELF section name is not NUL terminated");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(stringTable.subarray(offset, end));
  } catch {
    fail("ELF section name is not valid UTF-8");
  }
}

function memoryTypes(address, target) {
  return target.memoryMap.filter(([start, end]) => start <= address && address < end).map(([, , type]) => type);
}

function sameMemoryTypes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isFlashMapped(address, target) {
  return target.flashRanges.some(([start, end]) => address >= start && address < end);
}

function concatBytes(left, right) {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function cloneSegment(segment) {
  return {
    name: segment.name,
    address: segment.address,
    data: segment.data,
    memoryTypes: segment.memoryTypes,
  };
}

function mergeAdjacentSections(sections) {
  if (sections.length === 0) return [];
  const work = sections.map(cloneSegment);
  const merged = [];

  for (let index = work.length - 1; index > 0; index -= 1) {
    const current = work[index - 1];
    const next = work[index];
    if (
      sameMemoryTypes(current.memoryTypes, next.memoryTypes)
      && next.address === current.address + current.data.byteLength
    ) {
      current.data = concatBytes(current.data, next.data);
    } else {
      merged.unshift(next);
    }
  }
  merged.unshift(work[0]);
  return merged;
}

function compareAddress(left, right) {
  return left.address - right.address;
}

function splitSegment(segment, length) {
  const original = segment.data;
  const head = {
    name: segment.name,
    address: segment.address,
    data: original.subarray(0, length),
    memoryTypes: segment.memoryTypes,
  };
  segment.address += length;
  segment.data = original.subarray(length);
  return head;
}

class ByteWriter {
  constructor(limit) {
    this.limit = limit;
    this.parts = [];
    this.length = 0;
  }

  ensure(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.limit - this.length) {
      fail(`ESP32-C3 image exceeds the ${this.limit / (1024 * 1024)} MiB browser image limit`);
    }
  }

  write(bytes) {
    this.ensure(bytes.byteLength);
    this.parts.push(bytes);
    this.length += bytes.byteLength;
  }

  zeroes(length) {
    if (length > 0) this.write(new Uint8Array(length));
  }

  bytes() {
    const output = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }
}

function segmentHeader(address, length) {
  const header = new Uint8Array(SEGMENT_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint32(0, address, true);
  view.setUint32(4, length, true);
  return header;
}

function xorChecksum(bytes, state) {
  let checksum = state;
  for (const byte of bytes) checksum ^= byte;
  return checksum;
}

function getAlignmentPadding(writerOffset, address, mmuPageSize) {
  const alignPast = (address % mmuPageSize) - SEGMENT_HEADER_BYTES;
  let padding = (mmuPageSize - (writerOffset % mmuPageSize)) + alignPast;
  if (padding === 0 || padding === mmuPageSize) return 0;
  padding -= SEGMENT_HEADER_BYTES;
  if (padding < 0) padding += mmuPageSize;
  return padding;
}

function formatOption(option, table, value, target) {
  if (typeof value !== "string" || !Object.hasOwn(table, value)) {
    fail(`unsupported ${target.label} ${option}: ${String(value)}`);
  }
  return table[value];
}

function integerOption(value, defaultValue, minimum, maximum, label) {
  const actual = value ?? defaultValue;
  if (!Number.isInteger(actual) || actual < minimum || actual > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return actual;
}

async function sha256(bytes, target) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    fail(`Web Crypto SHA-256 is required to create an ${target.label} image`);
  }
  return new Uint8Array(await cryptoApi.subtle.digest("SHA-256", bytes));
}

function writeSegment(writer, segment, checksum, patch, written, kind, target) {
  if (segment.data.byteLength === 0) fail(`empty ${segment.name || kind} segment is not valid`);
  if (segment.data.byteLength % 4 !== 0) fail(`${segment.name || kind} segment is not 4-byte aligned`);
  if (segment.data.byteLength > MAX_SEGMENT_BYTES) fail(`${segment.name || kind} segment exceeds 16 MiB`);

  const fileOffset = writer.length;
  let data = segment.data;
  if (
    patch.digest
    && !patch.applied
    && patch.offset >= fileOffset
    && patch.offset < fileOffset + data.byteLength
  ) {
    const dataOffset = patch.offset - fileOffset - SEGMENT_HEADER_BYTES;
    if (dataOffset < 0 || dataOffset + patch.digest.byteLength > data.byteLength) {
      fail(`ELF SHA-256 offset falls on an ${target.label} segment boundary`);
    }
    for (let index = dataOffset; index < dataOffset + patch.digest.byteLength; index += 1) {
      if (data[index] !== 0) fail("ELF SHA-256 destination at 0xb0 is not zero-filled");
    }
    data = data.slice();
    data.set(patch.digest, dataOffset);
    patch.applied = true;
  }

  writer.write(segmentHeader(segment.address, data.byteLength));
  writer.write(data);
  written.push({
    address: segment.address,
    length: data.byteLength,
    fileOffset,
    name: segment.name,
    kind,
  });
  return xorChecksum(data, checksum);
}

/**
 * Parse the data-bearing sections from a conventional ELF32 little-endian
 * executable for one ESP target. Program headers, relocatable objects, and
 * ELF64 are out of scope for the browser image writer.
 */
function parseEspElf(value, target) {
  const bytes = asBytes(value, "ELF");
  if (bytes.byteLength < ELF_HEADER_BYTES) fail("ELF is shorter than the ELF32 header");
  if (bytes.byteLength > MAX_ELF_BYTES) fail(`ELF exceeds the ${MAX_ELF_BYTES / (1024 * 1024)} MiB browser limit`);
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) fail("invalid ELF magic");
  if (bytes[4] !== 1 || bytes[5] !== 1 || bytes[6] !== 1) fail("only ELF32 little-endian version-1 files are supported");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const machine = view.getUint16(18, true);
  if (machine !== target.elfMachine) {
    fail(`ELF machine 0x${machine.toString(16)} is not ${target.elfArchitecture}`);
  }
  if (view.getUint32(20, true) !== 1) fail("ELF header has an unsupported version");
  if (view.getUint16(40, true) !== ELF_HEADER_BYTES) fail("ELF header has an unexpected ELF32 header size");
  if (view.getUint16(46, true) !== ELF_SECTION_HEADER_BYTES) fail("ELF section headers are not ELF32-sized");

  const entrypoint = view.getUint32(24, true);
  const sectionOffset = view.getUint32(32, true);
  const sectionCount = view.getUint16(48, true);
  const stringsIndex = view.getUint16(50, true);
  if (sectionCount === 0 || sectionCount > MAX_SECTION_HEADERS) fail("ELF has an unsupported section-header count");
  if (stringsIndex >= sectionCount) fail("ELF section-name table index is invalid");
  requireRange(bytes.byteLength, sectionOffset, sectionCount * ELF_SECTION_HEADER_BYTES, "ELF section-header table");

  const stringHeaderOffset = sectionOffset + stringsIndex * ELF_SECTION_HEADER_BYTES;
  if (view.getUint32(stringHeaderOffset + 4, true) !== 3) fail("ELF section-name table is not a string table");
  const stringOffset = view.getUint32(stringHeaderOffset + 16, true);
  const stringLength = view.getUint32(stringHeaderOffset + 20, true);
  requireRange(bytes.byteLength, stringOffset, stringLength, "ELF section-name table");
  const stringTable = bytes.subarray(stringOffset, stringOffset + stringLength);

  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const headerOffset = sectionOffset + index * ELF_SECTION_HEADER_BYTES;
    const nameOffset = view.getUint32(headerOffset, true);
    const type = view.getUint32(headerOffset + 4, true);
    const address = view.getUint32(headerOffset + 12, true);
    const offset = view.getUint32(headerOffset + 16, true);
    const size = view.getUint32(headerOffset + 20, true);

    if (!DATA_SECTION_TYPES.has(type) || address === 0 || size === 0) continue;
    requireRange(bytes.byteLength, offset, size, `ELF section ${index}`);
    const data = padToFour(bytes.slice(offset, offset + size));
    if (address + data.byteLength > 0x1_0000_0000) fail(`ELF section ${index} overflows the 32-bit address space`);
    sections.push({
      name: sectionName(stringTable, nameOffset),
      address,
      data,
      memoryTypes: memoryTypes(address, target),
    });
  }

  if (sections.length === 0) fail("ELF has no loadable data sections");
  return { bytes, entrypoint, sections };
}

export function parseEsp32Elf(value) {
  return parseEspElf(value, IMAGE_TARGETS.esp32);
}

export function parseEsp32S2Elf(value) {
  return parseEspElf(value, IMAGE_TARGETS.esp32s2);
}

export function parseEsp32S3Elf(value) {
  return parseEspElf(value, IMAGE_TARGETS.esp32s3);
}

export function parseEsp32C3Elf(value) {
  return parseEspElf(value, IMAGE_TARGETS.esp32c3);
}

export function parseEsp32C5Elf(value) {
  return parseEspElf(value, IMAGE_TARGETS.esp32c5);
}

export function parseEsp32C6Elf(value) {
  return parseEspElf(value, IMAGE_TARGETS.esp32c6);
}

export function parseEsp32H2Elf(value) {
  return parseEspElf(value, IMAGE_TARGETS.esp32h2);
}

export function parseEsp32P4Elf(value) {
  return parseEspElf(value, IMAGE_TARGETS.esp32p4);
}

/**
 * Convert an ESP ELF into an app image accepted by esptool 5.x.
 * The return value keeps useful placement metadata for the future Web Worker.
 */
async function buildEspImage(elfValue, options, target) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(`${target.label} image options must be an object`);
  }
  const elf = parseEspElf(elfValue, target);
  const flashMode = formatOption("flash mode", FLASH_MODES, options.flashMode ?? "qio", target);
  const flashSize = formatOption("flash size", FLASH_SIZES, options.flashSize ?? "1MB", target);
  const flashFrequency = formatOption("flash frequency", target.flashFrequencies, options.flashFrequency ?? "40m", target);
  const minRevision = integerOption(options.minRevision, 0, 0, 255, "minimum chip revision");
  const minRevisionFull = integerOption(options.minRevisionFull, 0, 0, 65535, "minimum full chip revision");
  const maxRevisionFull = integerOption(options.maxRevisionFull, 65535, 0, 65535, "maximum full chip revision");
  const appendDigest = options.appendDigest !== false;

  const appDescription = elf.sections.find((section) => section.name.includes(".flash.appdesc") && isFlashMapped(section.address, target));
  const patch = {
    digest: appDescription ? await sha256(elf.bytes, target) : null,
    offset: target.elfSha256Offset,
    applied: false,
  };
  const segments = mergeAdjacentSections(elf.sections);
  if (segments.length > MAX_IMAGE_SEGMENTS) fail(`ELF produces ${segments.length} segments; ESP images support at most ${MAX_IMAGE_SEGMENTS}`);

  const flashSegments = segments.filter((segment) => isFlashMapped(segment.address, target)).sort(compareAddress);
  const ramSegments = segments.filter((segment) => !isFlashMapped(segment.address, target)).sort(compareAddress);
  const appDescriptionIndex = flashSegments.findIndex((segment) => segment.name.includes(".flash.appdesc"));
  if (appDescriptionIndex > 0) {
    const [appDescriptionSegment] = flashSegments.splice(appDescriptionIndex, 1);
    flashSegments.unshift(appDescriptionSegment);
  }

  for (let index = 1; index < flashSegments.length; index += 1) {
    if (
      Math.floor(flashSegments[index - 1].address / target.mmuPageSize)
      === Math.floor(flashSegments[index].address / target.mmuPageSize)
    ) {
      fail("two flash-mapped ELF sections occupy the same 64 KiB MMU page");
    }
  }

  const writer = new ByteWriter(MAX_IMAGE_BYTES);
  const header = new Uint8Array(8);
  const headerView = new DataView(header.buffer);
  header[0] = IMAGE_MAGIC;
  header[2] = flashMode;
  header[3] = flashSize + flashFrequency;
  headerView.setUint32(4, elf.entrypoint, true);
  writer.write(header);

  const extendedHeader = new Uint8Array(16);
  const extendedView = new DataView(extendedHeader.buffer);
  extendedHeader[0] = 0xee;
  extendedView.setUint16(4, target.chipId, true);
  extendedHeader[6] = minRevision;
  extendedView.setUint16(7, minRevisionFull, true);
  extendedView.setUint16(9, maxRevisionFull, true);
  extendedHeader[15] = appendDigest ? 1 : 0;
  writer.write(extendedHeader);

  let checksum = CHECKSUM_SEED;
  const written = [];
  while (flashSegments.length > 0) {
    const segment = flashSegments[0];
    const padding = getAlignmentPadding(writer.length, segment.address, target.mmuPageSize);
    if (padding > 0) {
      let paddingSegment;
      if (ramSegments.length > 0 && padding > SEGMENT_HEADER_BYTES) {
        paddingSegment = splitSegment(ramSegments[0], padding);
        if (ramSegments[0].data.byteLength === 0) ramSegments.shift();
      } else {
        paddingSegment = { name: "", address: 0, data: new Uint8Array(padding), memoryTypes: ["padding"] };
      }
      checksum = writeSegment(writer, paddingSegment, checksum, patch, written, "padding", target);
    } else {
      checksum = writeSegment(writer, flashSegments.shift(), checksum, patch, written, "flash", target);
    }
  }

  for (const segment of ramSegments) {
    checksum = writeSegment(writer, segment, checksum, patch, written, "ram", target);
  }
  if (written.length > MAX_IMAGE_SEGMENTS) {
    fail(`${target.label} image needs ${written.length} segments; ESP images support at most ${MAX_IMAGE_SEGMENTS}`);
  }

  writer.zeroes(15 - (writer.length % 16));
  writer.write(new Uint8Array([checksum]));
  header[1] = written.length;

  if (appendDigest) writer.write(await sha256(writer.bytes(), target));
  const image = writer.bytes();
  return {
    image,
    entrypoint: elf.entrypoint,
    checksum,
    appendedDigest: appendDigest,
    elfSha256Embedded: patch.applied,
    elfSha256Offset: patch.applied ? target.elfSha256Offset : null,
    segments: written,
  };
}

export function buildEsp32Image(elfValue, options = {}) {
  return buildEspImage(elfValue, options, IMAGE_TARGETS.esp32);
}

export function buildEsp32S2Image(elfValue, options = {}) {
  return buildEspImage(elfValue, options, IMAGE_TARGETS.esp32s2);
}

export function buildEsp32S3Image(elfValue, options = {}) {
  return buildEspImage(elfValue, options, IMAGE_TARGETS.esp32s3);
}

export function buildEsp32C3Image(elfValue, options = {}) {
  return buildEspImage(elfValue, options, IMAGE_TARGETS.esp32c3);
}

export function buildEsp32C5Image(elfValue, options = {}) {
  return buildEspImage(elfValue, options, IMAGE_TARGETS.esp32c5);
}

export function buildEsp32C6Image(elfValue, options = {}) {
  return buildEspImage(elfValue, options, IMAGE_TARGETS.esp32c6);
}

export function buildEsp32H2Image(elfValue, options = {}) {
  return buildEspImage(elfValue, options, IMAGE_TARGETS.esp32h2);
}

export function buildEsp32P4Image(elfValue, options = {}) {
  return buildEspImage(elfValue, options, IMAGE_TARGETS.esp32p4);
}
