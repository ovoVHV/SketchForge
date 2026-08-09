import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '../src/build-ir/canonical.js';
import { encodeEsp32PartitionCsv } from '../src/esp32/partition-table.js';

interface GoldenCase {
  id: string;
  file: string;
  flashSizeBytes: number;
  sha256: string;
  prefixHex: string;
}

interface GoldenContract {
  schemaVersion: number;
  generator: {
    implementation: string;
    platformVersion: string;
    sha256: string;
    arguments: string[];
  };
  outputSize: number;
  paddingByte: number;
  cases: GoldenCase[];
}

const fixtureRoot = dirname(fileURLToPath(new URL(
  './fixtures/esp32-partitions/goldens.json',
  import.meta.url,
)));
const contract = JSON.parse(readFileSync(join(fixtureRoot, 'goldens.json'), 'utf8')) as GoldenContract;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function goldenBytes(item: GoldenCase): Uint8Array {
  if (!/^(?:[a-f0-9]{2})+$/.test(item.prefixHex)) {
    throw new TypeError(`partition golden ${item.id} prefix is invalid`);
  }
  const prefix = new Uint8Array(Buffer.from(item.prefixHex, 'hex'));
  if (prefix.byteLength > contract.outputSize) {
    throw new TypeError(`partition golden ${item.id} prefix exceeds its output size`);
  }
  const bytes = new Uint8Array(contract.outputSize).fill(contract.paddingByte);
  bytes.set(prefix);
  return bytes;
}

describe('ESP32 partition Native compatibility goldens', () => {
  it('binds the fixture set to one content-addressed Native generator', () => {
    expect(contract).toMatchObject({
      schemaVersion: 1,
      generator: {
        implementation: 'arduino-esp32/gen_esp32part.exe',
        platformVersion: '3.3.7',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        arguments: ['-q', '<input.csv>', '<output.bin>'],
      },
      outputSize: 3072,
      paddingByte: 0xff,
    });
    expect(contract.cases.map((item) => item.id)).toEqual([
      'auto-offsets-8mb',
      'numeric-subtypes-4mb',
      'ota-4mb',
    ]);
  });

  it.each(contract.cases)('matches Native bytes for $id', (item) => {
    const csv = new Uint8Array(readFileSync(join(fixtureRoot, item.file)));
    const expected = goldenBytes(item);
    const actual = encodeEsp32PartitionCsv(csv, {
      flashSizeBytes: item.flashSizeBytes,
    }).bytes;

    expect(actual).toEqual(expected);
    expect(sha256Hex(actual)).toBe(item.sha256);
  });

  it.runIf(Boolean(process.env.CK_ESP32_GEN_PART_TOOL))(
    'replays every golden through the explicitly configured Native tool',
    () => {
      const configuredTool = process.env.CK_ESP32_GEN_PART_TOOL!;
      const tool = realpathSync(configuredTool);
      expect(sha256Hex(new Uint8Array(readFileSync(tool))))
        .toBe(contract.generator.sha256);
      const outputRoot = mkdtempSync(join(tmpdir(), 'ck-gen-esp32part-parity-'));
      temporaryRoots.push(outputRoot);

      for (const item of contract.cases) {
        const input = join(fixtureRoot, item.file);
        const output = join(outputRoot, `${basename(item.file, '.csv')}.bin`);
        execFileSync(tool, ['-q', input, output], { stdio: 'pipe' });
        expect(new Uint8Array(readFileSync(output)), item.id).toEqual(goldenBytes(item));
      }
    },
  );
});
