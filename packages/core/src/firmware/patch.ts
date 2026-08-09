import { sha256Hex } from '../build-ir/canonical.js';

export const AF_PARAMETER_MAGIC = 'A1F0PARM';
export const AF_PARAMETER_TRAILER = 'MRAP0F1A';
export const AF_VM_PROGRAM_MAGIC = 'A1F0PROG';
export const AF_VM_PROGRAM_TRAILER = 'GORP0F1A';

export interface FirmwarePatchSpec {
  magic: string | Uint8Array;
  capacity: number;
  trailer?: string | Uint8Array;
  /** Missing payload bytes are filled with this value. Omit to require an exact-size payload. */
  padByte?: number;
}

export interface BinaryPatchResult {
  bytes: Uint8Array;
  payloadOffset: number;
  payloadLength: number;
  capacity: number;
  sha256: string;
}

export interface IntelHexImage {
  bytes: Uint8Array;
  baseAddress: number;
  startAddress?: number;
}

export interface IntelHexPatchResult extends BinaryPatchResult {
  hex: string;
  absolutePayloadAddress: number;
}

export interface Esp32ImageLayout {
  hashAppended: boolean;
  segments: Array<{ start: number; end: number; loadAddress: number }>;
  checksumOffset: number;
  sha256Offset: number | null;
}

export interface Esp32ImageVerification {
  valid: boolean;
  errors: string[];
  layout?: Esp32ImageLayout;
}

const MAX_BINARY_BYTES = 32 * 1024 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

function bytes(value: string | Uint8Array, label: string): Uint8Array {
  const result = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
  if (result.length < 4 || result.length > 64) throw new TypeError(`${label} must contain 4..64 bytes`);
  return result;
}

function byte(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new TypeError(`${label} must be a byte`);
  return value;
}

function patchSpec(spec: FirmwarePatchSpec): {
  magic: Uint8Array;
  trailer?: Uint8Array;
  capacity: number;
  padByte?: number;
} {
  if (!Number.isSafeInteger(spec.capacity) || spec.capacity < 1 || spec.capacity > MAX_PATCH_BYTES) {
    throw new TypeError('patch capacity is invalid');
  }
  return {
    magic: bytes(spec.magic, 'patch magic'),
    ...(spec.trailer === undefined ? {} : { trailer: bytes(spec.trailer, 'patch trailer') }),
    capacity: spec.capacity,
    ...(spec.padByte === undefined ? {} : { padByte: byte(spec.padByte, 'patch padByte') }),
  };
}

function equalAt(source: Uint8Array, expected: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset + expected.length > source.length) return false;
  for (let index = 0; index < expected.length; index++) {
    if (source[offset + index] !== expected[index]) return false;
  }
  return true;
}

function contains(ranges: readonly { start: number; end: number }[], start: number, end: number): boolean {
  return ranges.some((range) => start >= range.start && end <= range.end);
}

function locate(
  source: Uint8Array,
  spec: ReturnType<typeof patchSpec>,
  ranges: readonly { start: number; end: number }[] = [{ start: 0, end: source.length }],
): number {
  const matches: number[] = [];
  for (const range of ranges) {
    const last = Math.min(range.end - spec.magic.length, source.length - spec.magic.length);
    for (let offset = Math.max(0, range.start); offset <= last; offset++) {
      if (!equalAt(source, spec.magic, offset)) continue;
      const payloadStart = offset + spec.magic.length;
      const payloadEnd = payloadStart + spec.capacity;
      if (!contains(ranges, payloadStart, payloadEnd)) continue;
      if (spec.trailer && !equalAt(source, spec.trailer, payloadEnd)) continue;
      matches.push(payloadStart);
      if (matches.length > 1) throw new TypeError('patch magic is ambiguous; expected exactly one valid region');
    }
  }
  if (matches.length !== 1) throw new TypeError('patch magic/trailer region was not found');
  return matches[0]!;
}

function payloadBytes(payload: Uint8Array, spec: ReturnType<typeof patchSpec>): Uint8Array {
  if (payload.length > spec.capacity) throw new RangeError(`patch payload exceeds ${spec.capacity} bytes`);
  if (payload.length !== spec.capacity && spec.padByte === undefined) {
    throw new RangeError(`patch payload must contain exactly ${spec.capacity} bytes`);
  }
  const result = new Uint8Array(spec.capacity);
  if (spec.padByte !== undefined) result.fill(spec.padByte);
  result.set(payload);
  return result;
}

export function patchBinaryByMagic(
  input: Uint8Array,
  specInput: FirmwarePatchSpec,
  payloadInput: Uint8Array,
): BinaryPatchResult {
  if (!(input instanceof Uint8Array) || input.length < 1 || input.length > MAX_BINARY_BYTES) {
    throw new TypeError('firmware binary size is invalid');
  }
  const spec = patchSpec(specInput);
  const payload = payloadBytes(payloadInput, spec);
  const payloadOffset = locate(input, spec);
  const output = new Uint8Array(input);
  output.set(payload, payloadOffset);
  return {
    bytes: output,
    payloadOffset,
    payloadLength: payloadInput.length,
    capacity: spec.capacity,
    sha256: sha256Hex(output),
  };
}

function parseHexByte(text: string, offset: number, label: string): number {
  const value = text.slice(offset, offset + 2);
  if (!/^[a-fA-F0-9]{2}$/.test(value)) throw new TypeError(`Intel HEX ${label} is invalid`);
  return Number.parseInt(value, 16);
}

export function decodeIntelHex(text: string): IntelHexImage {
  if (typeof text !== 'string' || text.length < 12 || text.length > MAX_BINARY_BYTES * 3) {
    throw new TypeError('Intel HEX text size is invalid');
  }
  const memory = new Map<number, number>();
  let upperAddress = 0;
  let startAddress: number | undefined;
  let eof = false;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = -1;
  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!.trim();
    if (!line) continue;
    if (eof) throw new TypeError(`Intel HEX contains data after EOF at line ${lineIndex + 1}`);
    if (!line.startsWith(':') || line.length < 11 || line.length % 2 === 0) {
      throw new TypeError(`Intel HEX line ${lineIndex + 1} has invalid syntax`);
    }
    const count = parseHexByte(line, 1, 'byte count');
    if (line.length !== 11 + count * 2) throw new TypeError(`Intel HEX line ${lineIndex + 1} length mismatch`);
    const address = (parseHexByte(line, 3, 'address') << 8) | parseHexByte(line, 5, 'address');
    const type = parseHexByte(line, 7, 'record type');
    const data = new Uint8Array(count);
    let sum = count + (address >> 8) + (address & 0xff) + type;
    for (let index = 0; index < count; index++) {
      data[index] = parseHexByte(line, 9 + index * 2, 'data');
      sum += data[index]!;
    }
    sum += parseHexByte(line, 9 + count * 2, 'checksum');
    if ((sum & 0xff) !== 0) throw new TypeError(`Intel HEX checksum mismatch at line ${lineIndex + 1}`);
    if (type === 0x00) {
      const absolute = upperAddress + address;
      if (absolute + count > MAX_BINARY_BYTES) throw new RangeError('Intel HEX address exceeds the firmware limit');
      for (let index = 0; index < count; index++) {
        const target = absolute + index;
        if (memory.has(target)) throw new TypeError(`Intel HEX data overlaps at address 0x${target.toString(16)}`);
        memory.set(target, data[index]!);
      }
      if (count > 0) {
        minimum = Math.min(minimum, absolute);
        maximum = Math.max(maximum, absolute + count - 1);
      }
    } else if (type === 0x01) {
      if (count !== 0 || address !== 0) throw new TypeError('Intel HEX EOF record is invalid');
      eof = true;
    } else if (type === 0x02) {
      if (count !== 2 || address !== 0) throw new TypeError('Intel HEX extended segment record is invalid');
      upperAddress = ((data[0]! << 8) | data[1]!) << 4;
    } else if (type === 0x04) {
      if (count !== 2 || address !== 0) throw new TypeError('Intel HEX extended linear record is invalid');
      upperAddress = ((data[0]! << 8) | data[1]!) * 0x10000;
    } else if (type === 0x03 || type === 0x05) {
      if (count !== 4 || address !== 0) throw new TypeError('Intel HEX start-address record is invalid');
      startAddress = ((data[0]! << 24) | (data[1]! << 16) | (data[2]! << 8) | data[3]!) >>> 0;
    } else throw new TypeError(`Intel HEX record type 0x${type.toString(16)} is unsupported`);
  }
  if (!eof) throw new TypeError('Intel HEX EOF record is missing');
  if (maximum < minimum) return { bytes: new Uint8Array(), baseAddress: 0, ...(startAddress === undefined ? {} : { startAddress }) };
  const output = new Uint8Array(maximum - minimum + 1);
  output.fill(0xff);
  for (const [address, value] of memory) output[address - minimum] = value;
  return { bytes: output, baseAddress: minimum, ...(startAddress === undefined ? {} : { startAddress }) };
}

function hexRecord(address: number, type: number, data: Uint8Array): string {
  let sum = data.length + (address >> 8) + (address & 0xff) + type;
  let body = `${data.length.toString(16).padStart(2, '0')}${address.toString(16).padStart(4, '0')}${type.toString(16).padStart(2, '0')}`;
  for (const value of data) {
    sum += value;
    body += value.toString(16).padStart(2, '0');
  }
  const checksum = (-sum) & 0xff;
  return `:${body}${checksum.toString(16).padStart(2, '0')}`.toUpperCase();
}

export function encodeIntelHex(image: IntelHexImage, recordBytes = 16): string {
  if (!(image.bytes instanceof Uint8Array) || image.bytes.length > MAX_BINARY_BYTES
    || !Number.isSafeInteger(image.baseAddress) || image.baseAddress < 0
    || image.baseAddress + image.bytes.length > 0x1_0000_0000
    || !Number.isSafeInteger(recordBytes) || recordBytes < 1 || recordBytes > 255) {
    throw new TypeError('Intel HEX image is invalid');
  }
  const lines: string[] = [];
  let currentUpper = -1;
  for (let offset = 0; offset < image.bytes.length;) {
    const absolute = image.baseAddress + offset;
    const upper = Math.floor(absolute / 0x10000);
    if (upper !== currentUpper) {
      currentUpper = upper;
      if (upper !== 0) lines.push(hexRecord(0, 0x04, Uint8Array.of((upper >> 8) & 0xff, upper & 0xff)));
    }
    const low = absolute & 0xffff;
    const count = Math.min(recordBytes, image.bytes.length - offset, 0x10000 - low);
    lines.push(hexRecord(low, 0x00, image.bytes.subarray(offset, offset + count)));
    offset += count;
  }
  if (image.startAddress !== undefined) {
    const value = image.startAddress >>> 0;
    lines.push(hexRecord(0, 0x05, Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value)));
  }
  lines.push(hexRecord(0, 0x01, new Uint8Array()));
  return `${lines.join('\n')}\n`;
}

export function patchAvrIntelHexByMagic(
  hex: string,
  spec: FirmwarePatchSpec,
  payload: Uint8Array,
): IntelHexPatchResult {
  const decoded = decodeIntelHex(hex);
  const patched = patchBinaryByMagic(decoded.bytes, spec, payload);
  return {
    ...patched,
    hex: encodeIntelHex({ ...decoded, bytes: patched.bytes }),
    absolutePayloadAddress: decoded.baseAddress + patched.payloadOffset,
  };
}

function readUint32LE(source: Uint8Array, offset: number): number {
  return new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(offset, true);
}

export function parseEsp32Image(input: Uint8Array): Esp32ImageLayout {
  if (!(input instanceof Uint8Array) || input.length < 34 || input.length > MAX_BINARY_BYTES || input[0] !== 0xe9) {
    throw new TypeError('ESP32 image header is invalid');
  }
  const segmentCount = input[1]!;
  if (segmentCount < 1 || segmentCount > 16) throw new TypeError('ESP32 image segment count is invalid');
  if (input[23] !== 0 && input[23] !== 1) throw new TypeError('ESP32 hash_appended flag is invalid');
  const hashAppended = input[23] === 1;
  const checksumOffset = input.length - (hashAppended ? 33 : 1);
  if (checksumOffset < 24) throw new TypeError('ESP32 image checksum offset is invalid');
  const segments: Esp32ImageLayout['segments'] = [];
  let cursor = 24;
  for (let index = 0; index < segmentCount; index++) {
    if (cursor + 8 > checksumOffset) throw new TypeError(`ESP32 segment ${index} header is truncated`);
    const loadAddress = readUint32LE(input, cursor);
    const length = readUint32LE(input, cursor + 4);
    const start = cursor + 8;
    const end = start + length;
    if (length > MAX_BINARY_BYTES || end > checksumOffset || end < start) {
      throw new TypeError(`ESP32 segment ${index} data is truncated`);
    }
    segments.push({ start, end, loadAddress });
    cursor = end;
  }
  if (cursor > checksumOffset || checksumOffset - cursor > 15) {
    throw new TypeError('ESP32 image padding is invalid');
  }
  return {
    hashAppended,
    segments,
    checksumOffset,
    sha256Offset: hashAppended ? input.length - 32 : null,
  };
}

export function computeEsp32ImageChecksum(input: Uint8Array, layout = parseEsp32Image(input)): number {
  let checksum = 0xef;
  for (const segment of layout.segments) {
    for (let offset = segment.start; offset < segment.end; offset++) checksum ^= input[offset]!;
  }
  return checksum;
}

async function digestBytes(input: Uint8Array): Promise<Uint8Array> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
    return new Uint8Array(digest);
  }
  const hex = sha256Hex(input);
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export async function verifyEsp32Image(input: Uint8Array): Promise<Esp32ImageVerification> {
  let layout: Esp32ImageLayout;
  try { layout = parseEsp32Image(input); }
  catch (error) { return { valid: false, errors: [(error as Error).message] }; }
  const errors: string[] = [];
  if (computeEsp32ImageChecksum(input, layout) !== input[layout.checksumOffset]) {
    errors.push('ESP32 image XOR checksum mismatch');
  }
  if (layout.sha256Offset !== null) {
    const expected = await digestBytes(input.subarray(0, layout.sha256Offset));
    if (!sameBytes(expected, input.subarray(layout.sha256Offset))) errors.push('ESP32 image SHA-256 mismatch');
  }
  return { valid: errors.length === 0, errors, layout };
}

async function refreshEsp32Digests(output: Uint8Array, layout: Esp32ImageLayout): Promise<void> {
  output[layout.checksumOffset] = computeEsp32ImageChecksum(output, layout);
  if (layout.sha256Offset !== null) {
    output.set(await digestBytes(output.subarray(0, layout.sha256Offset)), layout.sha256Offset);
  }
}

export async function patchEsp32ImageByMagic(
  input: Uint8Array,
  specInput: FirmwarePatchSpec,
  payloadInput: Uint8Array,
): Promise<BinaryPatchResult> {
  const verification = await verifyEsp32Image(input);
  if (!verification.valid || !verification.layout) {
    throw new TypeError(`cannot patch an invalid ESP32 image: ${verification.errors.join('; ')}`);
  }
  const spec = patchSpec(specInput);
  const payload = payloadBytes(payloadInput, spec);
  const payloadOffset = locate(input, spec, verification.layout.segments);
  const output = new Uint8Array(input);
  let checksum = output[verification.layout.checksumOffset]!;
  for (let index = 0; index < payload.length; index++) {
    checksum ^= output[payloadOffset + index]! ^ payload[index]!;
    output[payloadOffset + index] = payload[index]!;
  }
  output[verification.layout.checksumOffset] = checksum;
  if (verification.layout.sha256Offset !== null) {
    output.set(await digestBytes(output.subarray(0, verification.layout.sha256Offset)), verification.layout.sha256Offset);
  }
  const result = await verifyEsp32Image(output);
  if (!result.valid) throw new Error(`patched ESP32 image is inconsistent: ${result.errors.join('; ')}`);
  return {
    bytes: output,
    payloadOffset,
    payloadLength: payloadInput.length,
    capacity: spec.capacity,
    sha256: sha256Hex(output),
  };
}

export async function normalizeEsp32ElfIdentity(
  input: Uint8Array,
  offset = 0xb0,
  length = 32,
): Promise<Uint8Array> {
  const verification = await verifyEsp32Image(input);
  if (!verification.valid || !verification.layout) {
    throw new TypeError(`cannot normalize an invalid ESP32 image: ${verification.errors.join('; ')}`);
  }
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 1
    || !contains(verification.layout.segments, offset, offset + length)) {
    throw new RangeError('ESP32 ELF identity range is outside segment data');
  }
  const output = new Uint8Array(input);
  output.fill(0, offset, offset + length);
  await refreshEsp32Digests(output, verification.layout);
  return output;
}

export type PatchableFirmware =
  | { format: 'avr-hex'; data: string }
  | { format: 'esp32-bin'; data: Uint8Array };

export type PatchedFirmware =
  | ({ format: 'avr-hex' } & IntelHexPatchResult)
  | ({ format: 'esp32-bin' } & BinaryPatchResult);

export async function patchFirmwareByMagic(
  firmware: PatchableFirmware,
  spec: FirmwarePatchSpec,
  payload: Uint8Array,
): Promise<PatchedFirmware> {
  if (firmware.format === 'avr-hex') return { format: 'avr-hex', ...patchAvrIntelHexByMagic(firmware.data, spec, payload) };
  return { format: 'esp32-bin', ...await patchEsp32ImageByMagic(firmware.data, spec, payload) };
}

export async function patchVmProgramFirmware(
  firmware: PatchableFirmware,
  program: Uint8Array,
  capacity = 256,
): Promise<PatchedFirmware> {
  return patchFirmwareByMagic(firmware, {
    magic: AF_VM_PROGRAM_MAGIC,
    trailer: AF_VM_PROGRAM_TRAILER,
    capacity,
    padByte: 0,
  }, program);
}

export async function patchParameterFirmware(
  firmware: PatchableFirmware,
  payload: Uint8Array,
): Promise<PatchedFirmware> {
  return patchFirmwareByMagic(firmware, {
    magic: AF_PARAMETER_MAGIC,
    trailer: AF_PARAMETER_TRAILER,
    capacity: payload.length,
  }, payload);
}
