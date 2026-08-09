import { describe, expect, it } from 'vitest';

import {
  ESP32_PARTITION_BINARY_SIZE,
  ESP32_PARTITION_MAX_CSV_BYTES,
  encodeEsp32PartitionCsv,
  encodeEsp32PartitionTable,
  parseEsp32PartitionCsv,
} from '../src/esp32/partition-table.js';

const FOUR_MB = 4 * 1024 * 1024;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

describe('ESP32 partition CSV parser and encoder', () => {
  it('matches the known Arduino/ESP-IDF binary golden, including MD5 and end marker', () => {
    const csv = [
      '\ufeff# Name,   Type, SubType, Offset,  Size, Flags',
      'nvs,      data, nvs,     0x9000,  0x5000,',
      'otadata,  data, ota,     0xe000,  0x2000,',
      'app0,     app,  ota_0,   0x10000, 0x140000,',
      'app1,     app,  ota_1,   0x150000,0x140000,',
      'spiffs,   data, spiffs,  0x290000,0x160000,',
      'coredump, data, coredump,0x3F0000,0x10000,',
    ].join('\r\n');

    const result = encodeEsp32PartitionCsv(csv, { flashSizeBytes: FOUR_MB });
    expect(result.bytes).toHaveLength(ESP32_PARTITION_BINARY_SIZE);
    expect(hex(result.bytes.subarray(0, 224))).toBe(
      'aa50010200900000005000006e76730000000000000000000000000000000000'
      + 'aa50010000e00000002000006f74616461746100000000000000000000000000'
      + 'aa50001000000100000014006170703000000000000000000000000000000000'
      + 'aa50001100001500000014006170703100000000000000000000000000000000'
      + 'aa50018200002900000016007370696666730000000000000000000000000000'
      + 'aa50010300003f0000000100636f726564756d70000000000000000000000000'
      + 'ebebffffffffffffffffffffffffffff972dae2ff872a0142d60bad124c0666b',
    );
    expect(result.bytes.slice(224).every((value) => value === 0xff)).toBe(true);
  });

  it('supports names, numeric values, KB/MB units, automatic offsets, and flags', () => {
    const table = parseEsp32PartitionCsv([
      '# comments are ignored',
      'small, 0x1, 0x2, , 4KB, readonly:encrypted',
      'firmware, 0, 0x10, , 1MB,',
      'fs, data, spiffs, , 2MB, encrypted',
    ].join('\n'), { flashSizeBytes: 8 * 1024 * 1024 });

    expect(table.entries).toEqual([
      expect.objectContaining({
        label: 'small', type: 1, subtype: 2, offset: 0x9000, size: 0x1000,
        flags: ['encrypted', 'readonly'],
      }),
      expect.objectContaining({
        label: 'firmware', type: 0, subtype: 0x10, offset: 0x10000, size: 0x100000,
        flags: [],
      }),
      expect.objectContaining({
        label: 'fs', type: 1, subtype: 0x82, offset: 0x110000, size: 0x200000,
        flags: ['encrypted'],
      }),
    ]);

    const first = encodeEsp32PartitionTable(table);
    const second = encodeEsp32PartitionCsv(
      '\ufeffsmall,data,nvs,0x9000,4KB,encrypted:readonly\nfirmware,app,ota_0,0x10000,1MB,\nfs,data,spiffs,0x110000,2MB,encrypted',
      { flashSizeBytes: 8 * 1024 * 1024 },
    ).bytes;
    expect(hex(first)).toBe(hex(second));
  });

  it('accepts an empty data subtype as the official undefined subtype', () => {
    const table = parseEsp32PartitionCsv('blob,data,,0x9000,0x3000,', { flashSizeBytes: FOUR_MB });
    expect(table.entries[0]).toMatchObject({ type: 1, subtype: 0x06 });
  });
});

describe('ESP32 partition CSV fail-closed validation', () => {
  const valid = 'nvs,data,nvs,0x9000,0x5000,\napp,app,ota_0,0x10000,0x100000,';

  it.each([
    ['duplicate label', 'nvs,data,nvs,0x9000,0x5000,\nnvs,data,spiffs,0x10000,0x1000,', /duplicate.*label/i],
    ['NUL', 'nv\0s,data,nvs,0x9000,0x5000,', /NUL/i],
    ['unknown flag', 'nvs,data,nvs,0x9000,0x5000,wat', /unknown.*flag/i],
    ['duplicate flag', 'nvs,data,nvs,0x9000,0x5000,encrypted:encrypted', /duplicate.*flag/i],
    ['too many fields', 'nvs,data,nvs,0x9000,0x5000,,extra', /five or six/i],
    ['missing size', 'nvs,data,nvs,0x9000,,', /size.*empty/i],
    ['empty app subtype', 'app,app,,0x10000,0x100000,', /subtype.*empty/i],
    ['bad hex', 'nvs,data,nvs,0xZZ,0x5000,', /invalid.*offset/i],
    ['negative number', 'nvs,data,nvs,-1,0x5000,', /invalid.*offset/i],
    ['unaligned offset', 'nvs,data,nvs,0x9001,0x5000,', /aligned/i],
    ['unaligned app size', 'app,app,ota_0,0x10000,0x1001,', /aligned/i],
    ['table overlap', 'nvs,data,nvs,0x8000,0x5000,', /table/i],
    ['ordered overlap', 'nvs,data,nvs,0x9000,0x10000,\napp,app,ota_0,0x10000,0x100000,', /before.*previous|overlap/i],
    ['flash overflow', 'app,app,ota_0,0x3f0000,0x200000,', /beyond flash/i],
    ['numeric overflow', 'nvs,data,nvs,0x100000000,0x5000,', /overflow|invalid/i],
    ['long label', `${'x'.repeat(17)},data,spiffs,0x9000,0x1000,`, /label.*16/i],
    ['illegal control label', 'bad\tlabel,data,spiffs,0x9000,0x1000,', /illegal.*character/i],
    ['read-only coredump', 'dump,data,coredump,0x9000,0x1000,readonly', /cannot be readonly/i],
    ['small read-write nvs', 'nvs,data,nvs,0x9000,0x1000,', /nvs.*at least/i],
  ])('rejects %s', (_name, csv, pattern) => {
    expect(() => parseEsp32PartitionCsv(csv, { flashSizeBytes: FOUR_MB })).toThrow(pattern);
  });

  it('rejects malformed UTF-8 and oversized input before parsing', () => {
    expect(() => parseEsp32PartitionCsv(Uint8Array.of(0xc3, 0x28), { flashSizeBytes: FOUR_MB }))
      .toThrow(/UTF-8/i);
    expect(() => parseEsp32PartitionCsv('bad\ud800,data,spiffs,0x9000,0x1000,', { flashSizeBytes: FOUR_MB }))
      .toThrow(/surrogate/i);
    expect(() => parseEsp32PartitionCsv('x'.repeat(ESP32_PARTITION_MAX_CSV_BYTES + 1), { flashSizeBytes: FOUR_MB }))
      .toThrow(/bytes/i);
  });

  it('rejects invalid flash and table options', () => {
    expect(() => parseEsp32PartitionCsv(valid, { flashSizeBytes: 3 * 1024 * 1024 }))
      .toThrow(/flashSizeBytes/i);
    expect(() => parseEsp32PartitionCsv(valid, { flashSizeBytes: FOUR_MB, partitionTableOffsetBytes: 0x8001 }))
      .toThrow(/aligned/i);
    expect(() => parseEsp32PartitionCsv(valid, { flashSizeBytes: FOUR_MB, partitionTableOffsetBytes: FOUR_MB }))
      .toThrow(/table sector/i);
  });

  it('rejects duplicate otadata entries and forged encoder input', () => {
    expect(() => parseEsp32PartitionCsv(
      'a,data,ota,0x9000,0x2000,\nb,data,ota,0xb000,0x2000,',
      { flashSizeBytes: FOUR_MB },
    )).toThrow(/one|duplicate/i);

    expect(() => encodeEsp32PartitionTable({
      entries: [{
        line: 1, label: 'bad\0label', type: 1, subtype: 0x82,
        offset: 0x9000, size: 0x1000, flags: [],
      }],
      flashSizeBytes: FOUR_MB,
      partitionTableOffsetBytes: 0x8000,
    })).toThrow(/NUL|illegal|label/i);
  });
});
