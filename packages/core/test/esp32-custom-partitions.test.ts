import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../src/build-ir/canonical.js';
import { resolveProject } from '../src/build-ir/builder.js';
import {
  ESP32_APPLICATION_FLASH_OFFSET_BYTES,
  ESP32_CUSTOM_PARTITIONS_MAX_BYTES,
  ESP32_CUSTOM_PARTITIONS_FILE,
  Esp32CustomPartitionsError,
  assertEsp32ApplicationFitsSlot,
  projectSnapshotSha256,
  resolveCustomEsp32Partitions,
  type Esp32CustomPartitionInput,
} from '../src/esp32/custom-partitions.js';
import { ESP32_PARTITION_BINARY_SIZE } from '../src/esp32/partition-table.js';
import type { SourceFile } from '../src/types.js';

const FOUR_MB = 4 * 1024 * 1024;
const OPTIONS = { flashSizeBytes: FOUR_MB } as const;
const VALID_CSV = [
  '# Name, Type, SubType, Offset, Size, Flags',
  'nvs, data, nvs, 0x9000, 0x5000,',
  'app0, app, ota_0, 0x10000, 0x100000,',
  'spiffs, data, spiffs, 0x110000, 0x100000, encrypted',
].join('\n');

function file(name: string, content: string = VALID_CSV): SourceFile {
  return { name, content };
}

function resolve(files: readonly SourceFile[]): Esp32CustomPartitionInput {
  const result = resolveCustomEsp32Partitions(files, OPTIONS);
  if (result === null) throw new Error('expected a custom partition input');
  return result;
}

function expectErrorCode(action: () => unknown, code: Esp32CustomPartitionsError['code']): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Esp32CustomPartitionsError);
    expect((error as Esp32CustomPartitionsError).code).toBe(code);
    return;
  }
  throw new Error(`expected Esp32CustomPartitionsError(${code})`);
}

describe('ESP32 project-owned custom partitions', () => {
  it('resolves the unique root file and returns source plus encoded evidence', () => {
    const result = resolve([
      file('main.ino', 'void setup() {}\n'),
      file(ESP32_CUSTOM_PARTITIONS_FILE),
      file('src/helper.cpp', 'int helper() { return 1; }\n'),
    ]);
    const sourceBytes = new TextEncoder().encode(VALID_CSV);

    expect(result.kind).toBe('project-owned-esp32-partitions');
    expect(result.schemaVersion).toBe(2);
    expect(result.path).toBe(ESP32_CUSTOM_PARTITIONS_FILE);
    expect(result.fileName).toBe(ESP32_CUSTOM_PARTITIONS_FILE);
    expect(result.flashSizeBytes).toBe(FOUR_MB);
    expect(result.partitionTableOffsetBytes).toBe(0x8000);
    expect(result.applicationSlot).toEqual({
      label: 'app0', subtype: 0x10, line: 3,
      offsetBytes: ESP32_APPLICATION_FLASH_OFFSET_BYTES,
      endBytes: 0x110000,
      maxBytes: 0x100000,
    });
    expect(result.sourceBytes).toEqual(sourceBytes);
    expect(result.sourceSize).toBe(sourceBytes.byteLength);
    expect(result.sha256).toBe(sha256Hex(sourceBytes));
    expect(result.sourceSha256).toBe(result.sha256);
    expect(result.bytes).toHaveLength(ESP32_PARTITION_BINARY_SIZE);
    expect(result.tableSize).toBe(result.bytes.byteLength);
    expect(result.tableSha256).toBe(sha256Hex(result.bytes));
    expect(result.identitySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.table.entries.map((entry) => entry.label)).toEqual(['nvs', 'app0', 'spiffs']);
  });

  it('returns null when the optional root file is absent', () => {
    expect(resolveCustomEsp32Partitions([
      file('main.ino', 'void setup() {}\n'),
      file('src/helper.cpp', 'int helper() { return 1; }\n'),
    ], OPTIONS)).toBeNull();
  });

  it.each([
    ['nested POSIX path', 'config/partitions.csv', 'subdirectory'],
    ['nested Windows path', 'config\\partitions.csv', 'subdirectory'],
    ['dot path alias', './partitions.csv', 'subdirectory'],
    ['wrong extension', 'partitions.txt', 'extension'],
    ['case-changing extension', 'Partitions.CSV', 'extension'],
    ['backup suffix', 'partitions.csv.bak', 'extension'],
  ] as const)('rejects %s', (_label, name, code) => {
    expectErrorCode(() => resolveCustomEsp32Partitions([file(name)], OPTIONS), code);
  });

  it('rejects duplicate root files instead of selecting by array order', () => {
    expectErrorCode(() => resolveCustomEsp32Partitions([
      file(ESP32_CUSTOM_PARTITIONS_FILE),
      file(ESP32_CUSTOM_PARTITIONS_FILE),
    ], OPTIONS), 'duplicate');
  });

  it('rejects non-text project content at the SourceFile boundary', () => {
    const binary = {
      name: ESP32_CUSTOM_PARTITIONS_FILE,
      content: new Uint8Array([0x6e, 0x76, 0x73]),
    } as unknown as SourceFile;
    expectErrorCode(() => resolveCustomEsp32Partitions([binary], OPTIONS), 'non-text');

    const malformedText = file(ESP32_CUSTOM_PARTITIONS_FILE, '\ud800');
    expectErrorCode(() => resolveCustomEsp32Partitions([malformedText], OPTIONS), 'non-text');
  });

  it('rejects an oversized CSV before invoking the partition codec', () => {
    const oversized = file(ESP32_CUSTOM_PARTITIONS_FILE, 'x'.repeat(
      ESP32_CUSTOM_PARTITIONS_MAX_BYTES + 1,
    ));
    expectErrorCode(() => resolveCustomEsp32Partitions([oversized], OPTIONS), 'size');
  });

  it.each([
    ['unknown flag', 'nvs,data,nvs,0x9000,0x5000,unknown', 'flags'],
    ['overlapping entries', 'a,data,spiffs,0x9000,0x8000,\nb,app,ota_0,0x10000,0x100000,', 'overlap'],
    ['empty table', '# only a comment\n', 'empty'],
  ] as const)('wraps invalid CSV (%s) with line/code evidence', (_label, csv, csvCode) => {
    try {
      resolveCustomEsp32Partitions([file(ESP32_CUSTOM_PARTITIONS_FILE, csv)], OPTIONS);
      throw new Error('expected invalid CSV');
    } catch (error) {
      expect(error).toBeInstanceOf(Esp32CustomPartitionsError);
      const customError = error as Esp32CustomPartitionsError;
      expect(customError.code).toBe('csv');
      expect(customError.csvCode).toBe(csvCode);
      expect(customError.path).toBe(ESP32_CUSTOM_PARTITIONS_FILE);
    }
  });

  it.each([
    ['only data partitions', 'nvs,data,nvs,0x9000,0x5000,'],
    [
      'app starts after the fixed image offset',
      'nvs,data,nvs,0x9000,0x5000,\napp,app,factory,0x20000,0x100000,',
    ],
    [
      'non-bootable app subtype covers the fixed image offset',
      'nvs,data,nvs,0x9000,0x5000,\ntest,app,test,0x10000,0x100000,',
    ],
  ] as const)('rejects a non-bootable custom layout: %s', (_label, csv) => {
    expectErrorCode(
      () => resolveCustomEsp32Partitions([file(ESP32_CUSTOM_PARTITIONS_FILE, csv)], OPTIONS),
      'bootability',
    );
  });

  it('accepts an application that exactly fills the slot and rejects one extra byte', () => {
    const slot = resolve([file(
      ESP32_CUSTOM_PARTITIONS_FILE,
      'nvs,data,nvs,0x9000,0x5000,\napp,app,factory,0x10000,0x1000,',
    )]).applicationSlot;

    expect(() => assertEsp32ApplicationFitsSlot(slot.maxBytes, slot)).not.toThrow();
    expectErrorCode(() => assertEsp32ApplicationFitsSlot(slot.maxBytes + 1, slot), 'capacity');
  });

  it('produces deterministic hashes independent of unrelated file order', () => {
    const first = resolve([
      file('main.ino', 'void setup() {}\n'),
      file(ESP32_CUSTOM_PARTITIONS_FILE),
      file('include/config.h', '#define VALUE 1\n'),
    ]);
    const second = resolve([
      file('include/config.h', '#define VALUE 1\n'),
      file(ESP32_CUSTOM_PARTITIONS_FILE),
      file('main.ino', 'void setup() {}\n'),
    ]);

    expect(second.sourceSha256).toBe(first.sourceSha256);
    expect(second.tableSha256).toBe(first.tableSha256);
    expect(second.identitySha256).toBe(first.identitySha256);
    expect(second.bytes).toEqual(first.bytes);
    expect(second.sourceBytes).toEqual(first.sourceBytes);
    expect(second.bytes).not.toBe(first.bytes);
    expect(second.sourceBytes).not.toBe(first.sourceBytes);
  });

  it('keeps source identity distinct while preserving normalized table identity', () => {
    const first = resolve([file(ESP32_CUSTOM_PARTITIONS_FILE, VALID_CSV)]);
    const equivalent = resolve([file(
      ESP32_CUSTOM_PARTITIONS_FILE,
      `\ufeff${VALID_CSV.replaceAll('\n', '\r\n')}\r\n`,
    )]);

    expect(equivalent.tableSha256).toBe(first.tableSha256);
    expect(equivalent.bytes).toEqual(first.bytes);
    expect(equivalent.sourceSha256).not.toBe(first.sourceSha256);
    expect(equivalent.identitySha256).not.toBe(first.identitySha256);
  });

  it('matches the Build IR project snapshot hash and exposes it as provenance', () => {
    const projectFiles = [
      { path: 'src/Z.cpp', content: 'int z;\n' },
      { path: 'main.ino', content: 'void setup() {}\n', generated: false as const },
      { path: 'include/config.h', content: '#define VALUE 1\n', language: 'header' as const },
    ];
    const expected = resolveProject(projectFiles).sha256;

    expect(projectSnapshotSha256(projectFiles)).toBe(expected);
    expect(projectSnapshotSha256([
      { name: 'include/config.h', content: '#define VALUE 1\n', language: 'header' as const },
      { name: 'main.ino', content: 'void setup() {}\n' },
      { name: 'src/Z.cpp', content: 'int z;\n' },
    ])).toBe(expected);

    const input = resolve([
      file('main.ino', 'void setup() {}\n'),
      file(ESP32_CUSTOM_PARTITIONS_FILE),
      file('include/config.h', '#define VALUE 1\n'),
    ]);
    expect(input.projectSnapshotSha256).toBe(projectSnapshotSha256([
      { name: 'main.ino', content: 'void setup() {}\n' },
      { name: ESP32_CUSTOM_PARTITIONS_FILE, content: VALID_CSV },
      { name: 'include/config.h', content: '#define VALUE 1\n' },
    ]));
  });

  it('binds language and generated metadata into the snapshot hash', () => {
    const base = [{ path: 'data.bin', content: 'payload' }];
    const explicit = [{ path: 'data.bin', content: 'payload', language: 'other' as const, generated: false }];
    const generated = [{ path: 'data.bin', content: 'payload', language: 'other' as const, generated: true }];
    const language = [{ path: 'data.bin', content: 'payload', language: 'header' as const, generated: false }];

    expect(projectSnapshotSha256(base)).toBe(projectSnapshotSha256(explicit));
    expect(projectSnapshotSha256(generated)).not.toBe(projectSnapshotSha256(explicit));
    expect(projectSnapshotSha256(language)).not.toBe(projectSnapshotSha256(explicit));
  });
});
