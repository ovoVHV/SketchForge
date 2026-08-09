import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  AF_PARAMETER_MAGIC,
  AF_PARAMETER_TRAILER,
  computeEsp32ImageChecksum,
  decodeIntelHex,
  encodeIntelHex,
  normalizeEsp32ElfIdentity,
  parseEsp32Image,
  patchAvrIntelHexByMagic,
  patchEsp32ImageByMagic,
  patchVmProgramFirmware,
  verifyEsp32Image,
} from '../src/firmware/patch.js';
import { CK_VM_OPCODE, compileVmProgram } from '../src/firmware/vm.js';

const ascii = (value: string) => new TextEncoder().encode(value);

function parameterBinary(length = 96): Uint8Array {
  const output = new Uint8Array(length);
  output.fill(0x5a);
  output.set(ascii(AF_PARAMETER_MAGIC), 24);
  output.set(Uint8Array.of(13, 0, 0xf4, 0x01), 32);
  output.set(ascii(AF_PARAMETER_TRAILER), 36);
  return output;
}

function sha256(input: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(input).digest());
}

function esp32Image(data: Uint8Array): Uint8Array {
  const segmentStart = 32;
  const segmentEnd = segmentStart + data.length;
  const padding = (16 - ((segmentEnd + 1) % 16)) % 16;
  const checksumOffset = segmentEnd + padding;
  const output = new Uint8Array(checksumOffset + 1 + 32);
  output[0] = 0xe9;
  output[1] = 1;
  output[23] = 1;
  const view = new DataView(output.buffer);
  view.setUint32(24, 0x3f400020, true);
  view.setUint32(28, data.length, true);
  output.set(data, segmentStart);
  const layout = parseEsp32Image(output);
  output[layout.checksumOffset] = computeEsp32ImageChecksum(output, layout);
  output.set(sha256(output.subarray(0, layout.sha256Offset!)), layout.sha256Offset!);
  return output;
}

describe('AVR Intel HEX firmware patching', () => {
  it('validates records, patches one fixed region, and re-encodes valid extended addresses', () => {
    const original = parameterBinary();
    const hex = encodeIntelHex({ bytes: original, baseAddress: 0x10000, startAddress: 0x10000 });
    const result = patchAvrIntelHexByMagic(hex, {
      magic: AF_PARAMETER_MAGIC, trailer: AF_PARAMETER_TRAILER, capacity: 4,
    }, Uint8Array.of(12, 0, 0xfa, 0x00));
    const decoded = decodeIntelHex(result.hex);
    expect(decoded.baseAddress).toBe(0x10000);
    expect(result.absolutePayloadAddress).toBe(0x10020);
    expect([...decoded.bytes.slice(32, 36)]).toEqual([12, 0, 250, 0]);
    expect(original[32]).toBe(13);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => decodeIntelHex(hex.replace(/.$/m, '0'))).toThrow(/checksum|syntax|length/);
  });

  it('rejects overflow and ambiguous magic regions', () => {
    const duplicate = new Uint8Array(192);
    duplicate.set(parameterBinary(), 0);
    duplicate.set(parameterBinary(), 96);
    const hex = encodeIntelHex({ bytes: duplicate, baseAddress: 0 });
    expect(() => patchAvrIntelHexByMagic(hex, {
      magic: AF_PARAMETER_MAGIC, trailer: AF_PARAMETER_TRAILER, capacity: 4,
    }, new Uint8Array(5))).toThrow(/exceeds/);
    expect(() => patchAvrIntelHexByMagic(hex, {
      magic: AF_PARAMETER_MAGIC, trailer: AF_PARAMETER_TRAILER, capacity: 4,
    }, new Uint8Array(4))).toThrow(/ambiguous/);
  });
});

describe('ESP32 image patching', () => {
  it('updates segment XOR and appended SHA-256 without mutating the cached image', async () => {
    const data = new Uint8Array(256);
    data.fill(0x5a);
    data.set(parameterBinary(48), 24);
    data.fill(0x77, 0xb0 - 32, 0xd0 - 32);
    const original = esp32Image(data);
    expect(await verifyEsp32Image(original)).toMatchObject({ valid: true });
    const patched = await patchEsp32ImageByMagic(original, {
      magic: AF_PARAMETER_MAGIC, trailer: AF_PARAMETER_TRAILER, capacity: 4,
    }, Uint8Array.of(12, 0, 250, 0));
    expect([...patched.bytes.slice(patched.payloadOffset, patched.payloadOffset + 4)])
      .toEqual([12, 0, 250, 0]);
    expect(await verifyEsp32Image(patched.bytes)).toMatchObject({ valid: true });
    expect(original[patched.payloadOffset]).toBe(13);
    const normalized = await normalizeEsp32ElfIdentity(patched.bytes);
    expect([...normalized.slice(0xb0, 0xd0)].every((value) => value === 0)).toBe(true);
    expect(await verifyEsp32Image(normalized)).toMatchObject({ valid: true });
  });

  it('rejects damaged images and duplicate patch regions', async () => {
    const data = new Uint8Array(256);
    data.set(parameterBinary(48), 0);
    data.set(parameterBinary(48), 96);
    const duplicate = esp32Image(data);
    await expect(patchEsp32ImageByMagic(duplicate, {
      magic: AF_PARAMETER_MAGIC, trailer: AF_PARAMETER_TRAILER, capacity: 4,
    }, new Uint8Array(4))).rejects.toThrow(/ambiguous/);
    const damaged = new Uint8Array(duplicate);
    const layout = parseEsp32Image(damaged);
    damaged[layout.checksumOffset] ^= 1;
    await expect(patchEsp32ImageByMagic(damaged, {
      magic: AF_PARAMETER_MAGIC, trailer: AF_PARAMETER_TRAILER, capacity: 4,
    }, new Uint8Array(4))).rejects.toThrow(/invalid ESP32 image/);
  });
});

describe('device VM payload', () => {
  it('assembles labels deterministically and patches the fixed program slot', async () => {
    const program = compileVmProgram([
      { op: 'label', name: 'loop' },
      { op: 'digitalWrite', pin: 13, value: 1 },
      { op: 'delayMs', milliseconds: 250 },
      { op: 'jump', target: 'loop' },
    ]);
    expect(program.labels).toEqual({ loop: 0 });
    expect([...program.bytes]).toEqual([
      CK_VM_OPCODE.DIGITAL_WRITE, 13, 1,
      CK_VM_OPCODE.DELAY_MS, 250, 0,
      CK_VM_OPCODE.JMP, 0, 0,
      CK_VM_OPCODE.HALT,
    ]);
    const binary = new Uint8Array(320);
    binary.fill(0xff);
    binary.set(ascii('A1F0PROG'), 16);
    binary.fill(0, 24, 280);
    binary.set(ascii('GORP0F1A'), 280);
    const hex = encodeIntelHex({ bytes: binary, baseAddress: 0 });
    const patched = await patchVmProgramFirmware({ format: 'avr-hex', data: hex }, program.bytes);
    expect(patched.format).toBe('avr-hex');
    if (patched.format === 'avr-hex') {
      const output = decodeIntelHex(patched.hex).bytes;
      expect([...output.slice(24, 24 + program.bytes.length)]).toEqual([...program.bytes]);
      expect([...output.slice(24 + program.bytes.length, 280)].every((value) => value === 0)).toBe(true);
    }
    expect(() => compileVmProgram([{ op: 'jump', target: 'missing' }])).toThrow(/unknown VM label/);
    expect(() => compileVmProgram([{ op: 'delayMs', milliseconds: 1 }], 3)).toThrow(/after HALT/);
  });
});
