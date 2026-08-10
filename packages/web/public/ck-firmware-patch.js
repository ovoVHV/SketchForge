// Generated from @sketchforge/core firmware patching. Browser and test code share one implementation.

// packages/core/src/build-ir/canonical.ts
function sha256Hex(input) {
  const bytes2 = typeof input === "string" ? utf8(input) : input;
  const bitLength = bytes2.length * 8;
  const paddedLength = bytes2.length + 9 + 63 >> 6 << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes2);
  padded[bytes2.length] = 128;
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

// packages/core/src/firmware/patch.ts
var AF_PARAMETER_MAGIC = "A1F0PARM";
var AF_PARAMETER_TRAILER = "MRAP0F1A";
var AF_VM_PROGRAM_MAGIC = "A1F0PROG";
var AF_VM_PROGRAM_TRAILER = "GORP0F1A";
var MAX_BINARY_BYTES = 32 * 1024 * 1024;
var MAX_PATCH_BYTES = 1024 * 1024;
var encoder = new TextEncoder();
function bytes(value, label) {
  const result = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  if (result.length < 4 || result.length > 64) throw new TypeError(`${label} must contain 4..64 bytes`);
  return result;
}
function byte(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new TypeError(`${label} must be a byte`);
  return value;
}
function patchSpec(spec) {
  if (!Number.isSafeInteger(spec.capacity) || spec.capacity < 1 || spec.capacity > MAX_PATCH_BYTES) {
    throw new TypeError("patch capacity is invalid");
  }
  return {
    magic: bytes(spec.magic, "patch magic"),
    ...spec.trailer === void 0 ? {} : { trailer: bytes(spec.trailer, "patch trailer") },
    capacity: spec.capacity,
    ...spec.padByte === void 0 ? {} : { padByte: byte(spec.padByte, "patch padByte") }
  };
}
function equalAt(source, expected, offset) {
  if (offset < 0 || offset + expected.length > source.length) return false;
  for (let index = 0; index < expected.length; index++) {
    if (source[offset + index] !== expected[index]) return false;
  }
  return true;
}
function contains(ranges, start, end) {
  return ranges.some((range) => start >= range.start && end <= range.end);
}
function locate(source, spec, ranges = [{ start: 0, end: source.length }]) {
  const matches = [];
  for (const range of ranges) {
    const last = Math.min(range.end - spec.magic.length, source.length - spec.magic.length);
    for (let offset = Math.max(0, range.start); offset <= last; offset++) {
      if (!equalAt(source, spec.magic, offset)) continue;
      const payloadStart = offset + spec.magic.length;
      const payloadEnd = payloadStart + spec.capacity;
      if (!contains(ranges, payloadStart, payloadEnd)) continue;
      if (spec.trailer && !equalAt(source, spec.trailer, payloadEnd)) continue;
      matches.push(payloadStart);
      if (matches.length > 1) throw new TypeError("patch magic is ambiguous; expected exactly one valid region");
    }
  }
  if (matches.length !== 1) throw new TypeError("patch magic/trailer region was not found");
  return matches[0];
}
function payloadBytes(payload, spec) {
  if (payload.length > spec.capacity) throw new RangeError(`patch payload exceeds ${spec.capacity} bytes`);
  if (payload.length !== spec.capacity && spec.padByte === void 0) {
    throw new RangeError(`patch payload must contain exactly ${spec.capacity} bytes`);
  }
  const result = new Uint8Array(spec.capacity);
  if (spec.padByte !== void 0) result.fill(spec.padByte);
  result.set(payload);
  return result;
}
function patchBinaryByMagic(input, specInput, payloadInput) {
  if (!(input instanceof Uint8Array) || input.length < 1 || input.length > MAX_BINARY_BYTES) {
    throw new TypeError("firmware binary size is invalid");
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
    sha256: sha256Hex(output)
  };
}
function parseHexByte(text, offset, label) {
  const value = text.slice(offset, offset + 2);
  if (!/^[a-fA-F0-9]{2}$/.test(value)) throw new TypeError(`Intel HEX ${label} is invalid`);
  return Number.parseInt(value, 16);
}
function decodeIntelHex(text) {
  if (typeof text !== "string" || text.length < 12 || text.length > MAX_BINARY_BYTES * 3) {
    throw new TypeError("Intel HEX text size is invalid");
  }
  const memory = /* @__PURE__ */ new Map();
  let upperAddress = 0;
  let startAddress;
  let eof = false;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = -1;
  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].trim();
    if (!line) continue;
    if (eof) throw new TypeError(`Intel HEX contains data after EOF at line ${lineIndex + 1}`);
    if (!line.startsWith(":") || line.length < 11 || line.length % 2 === 0) {
      throw new TypeError(`Intel HEX line ${lineIndex + 1} has invalid syntax`);
    }
    const count = parseHexByte(line, 1, "byte count");
    if (line.length !== 11 + count * 2) throw new TypeError(`Intel HEX line ${lineIndex + 1} length mismatch`);
    const address = parseHexByte(line, 3, "address") << 8 | parseHexByte(line, 5, "address");
    const type = parseHexByte(line, 7, "record type");
    const data = new Uint8Array(count);
    let sum = count + (address >> 8) + (address & 255) + type;
    for (let index = 0; index < count; index++) {
      data[index] = parseHexByte(line, 9 + index * 2, "data");
      sum += data[index];
    }
    sum += parseHexByte(line, 9 + count * 2, "checksum");
    if ((sum & 255) !== 0) throw new TypeError(`Intel HEX checksum mismatch at line ${lineIndex + 1}`);
    if (type === 0) {
      const absolute = upperAddress + address;
      if (absolute + count > MAX_BINARY_BYTES) throw new RangeError("Intel HEX address exceeds the firmware limit");
      for (let index = 0; index < count; index++) {
        const target = absolute + index;
        if (memory.has(target)) throw new TypeError(`Intel HEX data overlaps at address 0x${target.toString(16)}`);
        memory.set(target, data[index]);
      }
      if (count > 0) {
        minimum = Math.min(minimum, absolute);
        maximum = Math.max(maximum, absolute + count - 1);
      }
    } else if (type === 1) {
      if (count !== 0 || address !== 0) throw new TypeError("Intel HEX EOF record is invalid");
      eof = true;
    } else if (type === 2) {
      if (count !== 2 || address !== 0) throw new TypeError("Intel HEX extended segment record is invalid");
      upperAddress = (data[0] << 8 | data[1]) << 4;
    } else if (type === 4) {
      if (count !== 2 || address !== 0) throw new TypeError("Intel HEX extended linear record is invalid");
      upperAddress = (data[0] << 8 | data[1]) * 65536;
    } else if (type === 3 || type === 5) {
      if (count !== 4 || address !== 0) throw new TypeError("Intel HEX start-address record is invalid");
      startAddress = (data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0;
    } else throw new TypeError(`Intel HEX record type 0x${type.toString(16)} is unsupported`);
  }
  if (!eof) throw new TypeError("Intel HEX EOF record is missing");
  if (maximum < minimum) return { bytes: new Uint8Array(), baseAddress: 0, ...startAddress === void 0 ? {} : { startAddress } };
  const output = new Uint8Array(maximum - minimum + 1);
  output.fill(255);
  for (const [address, value] of memory) output[address - minimum] = value;
  return { bytes: output, baseAddress: minimum, ...startAddress === void 0 ? {} : { startAddress } };
}
function hexRecord(address, type, data) {
  let sum = data.length + (address >> 8) + (address & 255) + type;
  let body = `${data.length.toString(16).padStart(2, "0")}${address.toString(16).padStart(4, "0")}${type.toString(16).padStart(2, "0")}`;
  for (const value of data) {
    sum += value;
    body += value.toString(16).padStart(2, "0");
  }
  const checksum = -sum & 255;
  return `:${body}${checksum.toString(16).padStart(2, "0")}`.toUpperCase();
}
function encodeIntelHex(image, recordBytes = 16) {
  if (!(image.bytes instanceof Uint8Array) || image.bytes.length > MAX_BINARY_BYTES || !Number.isSafeInteger(image.baseAddress) || image.baseAddress < 0 || image.baseAddress + image.bytes.length > 4294967296 || !Number.isSafeInteger(recordBytes) || recordBytes < 1 || recordBytes > 255) {
    throw new TypeError("Intel HEX image is invalid");
  }
  const lines = [];
  let currentUpper = -1;
  for (let offset = 0; offset < image.bytes.length; ) {
    const absolute = image.baseAddress + offset;
    const upper = Math.floor(absolute / 65536);
    if (upper !== currentUpper) {
      currentUpper = upper;
      if (upper !== 0) lines.push(hexRecord(0, 4, Uint8Array.of(upper >> 8 & 255, upper & 255)));
    }
    const low = absolute & 65535;
    const count = Math.min(recordBytes, image.bytes.length - offset, 65536 - low);
    lines.push(hexRecord(low, 0, image.bytes.subarray(offset, offset + count)));
    offset += count;
  }
  if (image.startAddress !== void 0) {
    const value = image.startAddress >>> 0;
    lines.push(hexRecord(0, 5, Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value)));
  }
  lines.push(hexRecord(0, 1, new Uint8Array()));
  return `${lines.join("\n")}
`;
}
function patchAvrIntelHexByMagic(hex, spec, payload) {
  const decoded = decodeIntelHex(hex);
  const patched = patchBinaryByMagic(decoded.bytes, spec, payload);
  return {
    ...patched,
    hex: encodeIntelHex({ ...decoded, bytes: patched.bytes }),
    absolutePayloadAddress: decoded.baseAddress + patched.payloadOffset
  };
}
function readUint32LE(source, offset) {
  return new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(offset, true);
}
function parseEsp32Image(input) {
  if (!(input instanceof Uint8Array) || input.length < 34 || input.length > MAX_BINARY_BYTES || input[0] !== 233) {
    throw new TypeError("ESP32 image header is invalid");
  }
  const segmentCount = input[1];
  if (segmentCount < 1 || segmentCount > 16) throw new TypeError("ESP32 image segment count is invalid");
  if (input[23] !== 0 && input[23] !== 1) throw new TypeError("ESP32 hash_appended flag is invalid");
  const hashAppended = input[23] === 1;
  const checksumOffset = input.length - (hashAppended ? 33 : 1);
  if (checksumOffset < 24) throw new TypeError("ESP32 image checksum offset is invalid");
  const segments = [];
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
    throw new TypeError("ESP32 image padding is invalid");
  }
  return {
    hashAppended,
    segments,
    checksumOffset,
    sha256Offset: hashAppended ? input.length - 32 : null
  };
}
function computeEsp32ImageChecksum(input, layout = parseEsp32Image(input)) {
  let checksum = 239;
  for (const segment of layout.segments) {
    for (let offset = segment.start; offset < segment.end; offset++) checksum ^= input[offset];
  }
  return checksum;
}
async function digestBytes(input) {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
    return new Uint8Array(digest);
  }
  const hex = sha256Hex(input);
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}
function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}
async function verifyEsp32Image(input) {
  let layout;
  try {
    layout = parseEsp32Image(input);
  } catch (error) {
    return { valid: false, errors: [error.message] };
  }
  const errors = [];
  if (computeEsp32ImageChecksum(input, layout) !== input[layout.checksumOffset]) {
    errors.push("ESP32 image XOR checksum mismatch");
  }
  if (layout.sha256Offset !== null) {
    const expected = await digestBytes(input.subarray(0, layout.sha256Offset));
    if (!sameBytes(expected, input.subarray(layout.sha256Offset))) errors.push("ESP32 image SHA-256 mismatch");
  }
  return { valid: errors.length === 0, errors, layout };
}
async function refreshEsp32Digests(output, layout) {
  output[layout.checksumOffset] = computeEsp32ImageChecksum(output, layout);
  if (layout.sha256Offset !== null) {
    output.set(await digestBytes(output.subarray(0, layout.sha256Offset)), layout.sha256Offset);
  }
}
async function patchEsp32ImageByMagic(input, specInput, payloadInput) {
  const verification = await verifyEsp32Image(input);
  if (!verification.valid || !verification.layout) {
    throw new TypeError(`cannot patch an invalid ESP32 image: ${verification.errors.join("; ")}`);
  }
  const spec = patchSpec(specInput);
  const payload = payloadBytes(payloadInput, spec);
  const payloadOffset = locate(input, spec, verification.layout.segments);
  const output = new Uint8Array(input);
  let checksum = output[verification.layout.checksumOffset];
  for (let index = 0; index < payload.length; index++) {
    checksum ^= output[payloadOffset + index] ^ payload[index];
    output[payloadOffset + index] = payload[index];
  }
  output[verification.layout.checksumOffset] = checksum;
  if (verification.layout.sha256Offset !== null) {
    output.set(await digestBytes(output.subarray(0, verification.layout.sha256Offset)), verification.layout.sha256Offset);
  }
  const result = await verifyEsp32Image(output);
  if (!result.valid) throw new Error(`patched ESP32 image is inconsistent: ${result.errors.join("; ")}`);
  return {
    bytes: output,
    payloadOffset,
    payloadLength: payloadInput.length,
    capacity: spec.capacity,
    sha256: sha256Hex(output)
  };
}
async function normalizeEsp32ElfIdentity(input, offset = 176, length = 32) {
  const verification = await verifyEsp32Image(input);
  if (!verification.valid || !verification.layout) {
    throw new TypeError(`cannot normalize an invalid ESP32 image: ${verification.errors.join("; ")}`);
  }
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 1 || !contains(verification.layout.segments, offset, offset + length)) {
    throw new RangeError("ESP32 ELF identity range is outside segment data");
  }
  const output = new Uint8Array(input);
  output.fill(0, offset, offset + length);
  await refreshEsp32Digests(output, verification.layout);
  return output;
}
async function patchFirmwareByMagic(firmware, spec, payload) {
  if (firmware.format === "avr-hex") return { format: "avr-hex", ...patchAvrIntelHexByMagic(firmware.data, spec, payload) };
  return { format: "esp32-bin", ...await patchEsp32ImageByMagic(firmware.data, spec, payload) };
}
async function patchVmProgramFirmware(firmware, program, capacity = 256) {
  return patchFirmwareByMagic(firmware, {
    magic: AF_VM_PROGRAM_MAGIC,
    trailer: AF_VM_PROGRAM_TRAILER,
    capacity,
    padByte: 0
  }, program);
}
async function patchParameterFirmware(firmware, payload) {
  return patchFirmwareByMagic(firmware, {
    magic: AF_PARAMETER_MAGIC,
    trailer: AF_PARAMETER_TRAILER,
    capacity: payload.length
  }, payload);
}

// packages/core/src/firmware/vm.ts
var CK_VM_PROGRAM_CAPACITY = 256;
var CK_VM_OPCODE = Object.freeze({
  HALT: 0,
  PIN_MODE: 1,
  DIGITAL_WRITE: 2,
  DELAY_MS: 3,
  SERIAL_PRINT: 4,
  DIGITAL_READ: 5,
  ANALOG_READ: 6,
  LOAD: 7,
  ADD: 8,
  JMP: 9,
  JMP_IF_ZERO: 10
});
var SAFE_LABEL = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
function u8(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) throw new RangeError(`${label} must fit in uint8`);
  return value;
}
function register(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 3) throw new RangeError("VM register must be 0..3");
  return value;
}
function u16(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) throw new RangeError(`${label} must fit in uint16`);
  return [value & 255, value >>> 8];
}
function size(instruction) {
  switch (instruction.op) {
    case "label":
      return 0;
    case "halt":
      return 1;
    case "serialPrint":
      return 2;
    case "pinMode":
    case "digitalWrite":
    case "delayMs":
    case "digitalRead":
    case "analogRead":
    case "add":
    case "jump":
      return 3;
    case "load":
    case "jumpIfZero":
      return 4;
  }
}
function compileVmProgram(instructions, capacity = CK_VM_PROGRAM_CAPACITY) {
  if (!Array.isArray(instructions) || instructions.length > 4096 || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 65535) {
    throw new TypeError("VM program input is invalid");
  }
  const labels = {};
  let offset = 0;
  for (const instruction of instructions) {
    if (instruction.op === "label") {
      if (!SAFE_LABEL.test(instruction.name)) throw new TypeError(`invalid VM label: ${instruction.name}`);
      if (labels[instruction.name] !== void 0) throw new TypeError(`duplicate VM label: ${instruction.name}`);
      labels[instruction.name] = offset;
    } else offset += size(instruction);
    if (offset > capacity) throw new RangeError(`VM program exceeds ${capacity} bytes`);
  }
  const output = [];
  let lastOperation;
  const target = (name) => {
    const address = labels[name];
    if (address === void 0) throw new TypeError(`unknown VM label: ${name}`);
    return u16(address, "VM jump target");
  };
  for (const instruction of instructions) {
    if (instruction.op !== "label") lastOperation = instruction.op;
    switch (instruction.op) {
      case "label":
        break;
      case "halt":
        output.push(CK_VM_OPCODE.HALT);
        break;
      case "pinMode":
        output.push(CK_VM_OPCODE.PIN_MODE, u8(instruction.pin, "pin"), u8(instruction.mode, "pin mode"));
        break;
      case "digitalWrite":
        output.push(CK_VM_OPCODE.DIGITAL_WRITE, u8(instruction.pin, "pin"), u8(instruction.value, "digital value"));
        break;
      case "delayMs":
        output.push(CK_VM_OPCODE.DELAY_MS, ...u16(instruction.milliseconds, "delay"));
        break;
      case "serialPrint":
        output.push(CK_VM_OPCODE.SERIAL_PRINT, register(instruction.register));
        break;
      case "digitalRead":
        output.push(CK_VM_OPCODE.DIGITAL_READ, u8(instruction.pin, "pin"), register(instruction.register));
        break;
      case "analogRead":
        output.push(CK_VM_OPCODE.ANALOG_READ, u8(instruction.pin, "pin"), register(instruction.register));
        break;
      case "load": {
        if (!Number.isSafeInteger(instruction.value) || instruction.value < -32768 || instruction.value > 65535) {
          throw new RangeError("VM load value must fit in int16/uint16");
        }
        output.push(CK_VM_OPCODE.LOAD, register(instruction.register), ...u16(instruction.value & 65535, "load value"));
        break;
      }
      case "add":
        output.push(CK_VM_OPCODE.ADD, register(instruction.destination), register(instruction.source));
        break;
      case "jump":
        output.push(CK_VM_OPCODE.JMP, ...target(instruction.target));
        break;
      case "jumpIfZero":
        output.push(CK_VM_OPCODE.JMP_IF_ZERO, register(instruction.register), ...target(instruction.target));
        break;
    }
  }
  if (lastOperation !== "halt") output.push(CK_VM_OPCODE.HALT);
  if (output.length > capacity) throw new RangeError(`VM program exceeds ${capacity} bytes after HALT`);
  return { bytes: Uint8Array.from(output), labels: Object.freeze({ ...labels }) };
}
export {
  AF_PARAMETER_MAGIC,
  AF_PARAMETER_TRAILER,
  AF_VM_PROGRAM_MAGIC,
  AF_VM_PROGRAM_TRAILER,
  CK_VM_OPCODE,
  CK_VM_PROGRAM_CAPACITY,
  compileVmProgram,
  computeEsp32ImageChecksum,
  decodeIntelHex,
  encodeIntelHex,
  normalizeEsp32ElfIdentity,
  parseEsp32Image,
  patchAvrIntelHexByMagic,
  patchBinaryByMagic,
  patchEsp32ImageByMagic,
  patchFirmwareByMagic,
  patchParameterFirmware,
  patchVmProgramFirmware,
  verifyEsp32Image
};
