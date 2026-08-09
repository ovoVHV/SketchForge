import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ESP32_IMAGE_CHIP_ID,
  ESP32_S2_IMAGE_CHIP_ID,
  ESP32_S3_IMAGE_CHIP_ID,
  ESP32_C3_ELF_SHA256_OFFSET,
  ESP32_C5_IMAGE_CHIP_ID,
  ESP32_C6_IMAGE_CHIP_ID,
  ESP32_H2_IMAGE_CHIP_ID,
  ESP32_P4_IMAGE_CHIP_ID,
  Esp32C3ImageError,
  buildEsp32Image,
  buildEsp32S2Image,
  buildEsp32S3Image,
  buildEsp32C3Image,
  buildEsp32C5Image,
  buildEsp32C6Image,
  buildEsp32H2Image,
  buildEsp32P4Image,
  parseEsp32Elf,
  parseEsp32S2Elf,
  parseEsp32S3Elf,
  parseEsp32C3Elf,
  parseEsp32C5Elf,
  parseEsp32C6Elf,
  parseEsp32H2Elf,
  parseEsp32P4Elf,
} from '../browser-esp32/image-builder.js';
import {
  buildEsp32Image as buildPublicEsp32Image,
  buildEsp32S2Image as buildPublicEsp32S2Image,
  buildEsp32S3Image as buildPublicEsp32S3Image,
  buildEsp32C5Image as buildPublicEsp32C5Image,
  buildEsp32P4Image as buildPublicEsp32P4Image,
  parseEsp32C5Elf as parsePublicEsp32C5Elf,
  parseEsp32P4Elf as parsePublicEsp32P4Elf,
} from '../public/esp32/v2/image-builder.js';

type FixtureSection = {
  name: string;
  address: number;
  data: number[];
  type?: number;
};

function putU16(bytes: Uint8Array, offset: number, value: number) {
  new DataView(bytes.buffer).setUint16(offset, value, true);
}

function putU32(bytes: Uint8Array, offset: number, value: number) {
  new DataView(bytes.buffer).setUint32(offset, value, true);
}

function elf32(sections: FixtureSection[], entrypoint = 0x40380000, machine = 0xf3) {
  const names = [''];
  for (const section of sections) names.push(section.name);
  names.push('.shstrtab');
  const nameOffsets = new Map<string, number>();
  const stringTable = new TextEncoder().encode(`${names.join('\0')}\0`);
  let cursor = 0;
  for (const name of names) {
    nameOffsets.set(name, cursor);
    cursor += new TextEncoder().encode(name).byteLength + 1;
  }

  const headerSize = 0x34;
  const dataStart = 0x100;
  const sectionTableOffset = 0x500;
  const sectionCount = sections.length + 2;
  const output = new Uint8Array(sectionTableOffset + sectionCount * 0x28);
  output.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0);
  putU16(output, 16, 2);
  putU16(output, 18, machine);
  putU32(output, 20, 1);
  putU32(output, 24, entrypoint);
  putU32(output, 32, sectionTableOffset);
  putU16(output, 40, headerSize);
  putU16(output, 46, 0x28);
  putU16(output, 48, sectionCount);
  putU16(output, 50, sectionCount - 1);

  let dataOffset = dataStart;
  sections.forEach((section, index) => {
    const header = sectionTableOffset + (index + 1) * 0x28;
    const data = Uint8Array.from(section.data);
    output.set(data, dataOffset);
    putU32(output, header, nameOffsets.get(section.name)!);
    putU32(output, header + 4, section.type ?? 1);
    putU32(output, header + 12, section.address);
    putU32(output, header + 16, dataOffset);
    putU32(output, header + 20, data.byteLength);
    putU32(output, header + 32, 4);
    dataOffset += data.byteLength + 4;
  });

  const stringsHeader = sectionTableOffset + (sectionCount - 1) * 0x28;
  const stringsOffset = 0x400;
  output.set(stringTable, stringsOffset);
  putU32(output, stringsHeader, nameOffsets.get('.shstrtab')!);
  putU32(output, stringsHeader + 4, 3);
  putU32(output, stringsHeader + 16, stringsOffset);
  putU32(output, stringsHeader + 20, stringTable.byteLength);
  return output;
}

function sha256(bytes: Uint8Array) {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

function parseImage(image: Uint8Array) {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const segments: Array<{ address: number; length: number; fileOffset: number; data: Uint8Array }> = [];
  let offset = 24;
  for (let index = 0; index < image[1]; index += 1) {
    const address = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    segments.push({ address, length, fileOffset: offset, data: image.slice(offset + 8, offset + 8 + length) });
    offset += 8 + length;
  }
  const checksumOffset = offset + 15 - (offset % 16);
  return { segments, checksumOffset };
}

function xorChecksum(parts: Uint8Array[]) {
  return parts.reduce((checksum, data) => data.reduce((state, byte) => state ^ byte, checksum), 0xef);
}

describe('Xtensa ESP32 browser image builders', () => {
  const targets = [
    {
      label: 'ESP32',
      chipId: ESP32_IMAGE_CHIP_ID,
      entrypoint: 0x40080024,
      appDescriptionAddress: 0x3f400020,
      ramAddress: 0x3ffe0000,
      ramTypes: ['byte-accessible', 'dram', 'diram-dram'],
      textAddress: 0x400d0020,
      parse: parseEsp32Elf,
      build: buildEsp32Image,
      buildPublic: buildPublicEsp32Image,
    },
    {
      label: 'ESP32-S2',
      chipId: ESP32_S2_IMAGE_CHIP_ID,
      entrypoint: 0x40020024,
      appDescriptionAddress: 0x3f000020,
      ramAddress: 0x3ffb0000,
      ramTypes: ['byte-accessible', 'internal', 'dram'],
      textAddress: 0x40080020,
      parse: parseEsp32S2Elf,
      build: buildEsp32S2Image,
      buildPublic: buildPublicEsp32S2Image,
    },
    {
      label: 'ESP32-S3',
      chipId: ESP32_S3_IMAGE_CHIP_ID,
      entrypoint: 0x40370024,
      appDescriptionAddress: 0x3c000020,
      ramAddress: 0x3fc88000,
      ramTypes: ['byte-accessible', 'internal', 'dram'],
      textAddress: 0x42000020,
      parse: parseEsp32S3Elf,
      build: buildEsp32S3Image,
      buildPublic: buildPublicEsp32S3Image,
    },
  ] as const;

  it.each(targets)('builds a mapped $label image with its official map and chip id', async (target) => {
    const appDescription = new Array<number>(0xb0).fill(0x58);
    appDescription.fill(0, 0x90, 0xb0);
    const elf = elf32([
      { name: '.flash.appdesc', address: target.appDescriptionAddress, data: appDescription },
      { name: '.dram0.data', address: target.ramAddress, data: [1, 2, 3, 4] },
      { name: '.flash.text', address: target.textAddress, data: [5, 6, 7, 8] },
    ], target.entrypoint, 0x5e);

    const parsed = target.parse(elf);
    expect(parsed.entrypoint).toBe(target.entrypoint);
    expect(parsed.sections.map((section) => section.memoryTypes)).toEqual([
      ['drom'],
      target.ramTypes,
      ['irom'],
    ]);

    const result = await target.build(elf, {
      flashMode: 'dio',
      flashSize: '4MB',
      flashFrequency: '80m',
    });
    const view = new DataView(result.image.buffer, result.image.byteOffset, result.image.byteLength);
    const textSegment = result.segments.find((segment) => segment.name === '.flash.text');

    expect(view.getUint16(12, true)).toBe(target.chipId);
    expect(result.image[2]).toBe(2);
    expect(result.image[3]).toBe(0x2f);
    expect(textSegment?.kind).toBe('flash');
    expect(textSegment?.address).toBe(target.textAddress);
    expect(((textSegment?.fileOffset ?? 0) + 8) % 0x10000).toBe(target.textAddress % 0x10000);
    expect(result.image.slice(ESP32_C3_ELF_SHA256_OFFSET, ESP32_C3_ELF_SHA256_OFFSET + 32)).toEqual(sha256(elf));
    expect(result.elfSha256Embedded).toBe(true);

    for (const [flashFrequency, encoded] of [['40m', 0x00], ['26m', 0x01], ['20m', 0x02]] as const) {
      const frequencyResult = await target.build(elf, { flashSize: '4MB', flashFrequency });
      expect(frequencyResult.image[3]).toBe(0x20 + encoded);
    }

    const publicResult = await target.buildPublic(elf, {
      flashMode: 'dio',
      flashSize: '4MB',
      flashFrequency: '80m',
    });
    expect(publicResult.image).toEqual(result.image);
  });

  it('uses the official mapped-flash windows at target-specific boundaries', async () => {
    const esp32Ram = elf32([
      { name: '.iram0.text', address: 0x40080000, data: [1, 2, 3, 4] },
    ], 0x40080000, 0x5e);
    expect(parseEsp32Elf(esp32Ram).sections[0].memoryTypes).toEqual(['iram']);
    expect((await buildEsp32Image(esp32Ram)).segments[0].kind).toBe('ram');

    const s2ExternalRam = elf32([
      { name: '.ext_ram.data', address: 0x3f500000, data: [1, 2, 3, 4] },
    ], 0x40020000, 0x5e);
    expect(parseEsp32S2Elf(s2ExternalRam).sections[0].memoryTypes).toEqual(['drom', 'extram-data']);
    expect((await buildEsp32S2Image(s2ExternalRam)).segments[0].kind).toBe('ram');

    const s3MappedExternalRam = elf32([
      { name: '.ext_ram.data', address: 0x3d000020, data: [1, 2, 3, 4] },
    ], 0x40370000, 0x5e);
    expect(parseEsp32S3Elf(s3MappedExternalRam).sections[0].memoryTypes).toEqual(['extram-data']);
    expect((await buildEsp32S3Image(s3MappedExternalRam)).segments[0].kind).toBe('flash');
  });

  it('strictly separates Xtensa and RISC-V ELF machines', () => {
    const xtensaElf = elf32([
      { name: '.text', address: 0x400d0020, data: [1, 2, 3, 4] },
    ], 0x40080000, 0x5e);
    expect(() => parseEsp32Elf(xtensaElf)).not.toThrow();
    expect(() => parseEsp32C3Elf(xtensaElf)).toThrow(/not RISC-V/);

    const riscVElf = elf32([
      { name: '.text', address: 0x42000020, data: [1, 2, 3, 4] },
    ]);
    expect(() => parseEsp32Elf(riscVElf)).toThrow(/not Xtensa/);
    expect(() => parseEsp32C3Elf(riscVElf)).not.toThrow();
  });
});

describe('ESP32-C3 browser image builder', () => {
  it('parses ELF32 RISC-V data sections and writes a mapped C3 image', async () => {
    const appDescription = new Array<number>(0xb0).fill(0x41);
    appDescription.fill(0, 0x90, 0xb0);
    const elf = elf32([
      { name: '.flash.appdesc', address: 0x3c000020, data: appDescription },
      { name: '.dram0.data', address: 0x3fc80000, data: [1, 2, 3, 4] },
      { name: '.flash.text', address: 0x42000020, data: [5, 6, 7, 8] },
    ], 0x40380024);

    const parsed = parseEsp32C3Elf(elf);
    expect(parsed.entrypoint).toBe(0x40380024);
    expect(parsed.sections.map((section) => section.name)).toEqual(['.flash.appdesc', '.dram0.data', '.flash.text']);

    const result = await buildEsp32C3Image(elf, {
      flashMode: 'dio',
      flashSize: '8MB',
      flashFrequency: '40m',
    });
    const image = result.image;
    const imageView = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const parsedImage = parseImage(image);

    expect(image[0]).toBe(0xe9);
    expect(image[2]).toBe(2);
    expect(image[3]).toBe(0x30);
    expect(imageView.getUint32(4, true)).toBe(0x40380024);
    expect(image[8]).toBe(0xee);
    expect(imageView.getUint16(12, true)).toBe(5);
    expect(image[23]).toBe(1);
    expect(parsedImage.segments.map((segment) => segment.address)).toEqual([
      0x3c000020,
      0x3fc80000,
      0,
      0x42000020,
    ]);
    expect((parsedImage.segments[3].fileOffset + 8) % 0x10000).toBe(0x20);
    expect(image.slice(ESP32_C3_ELF_SHA256_OFFSET, ESP32_C3_ELF_SHA256_OFFSET + 32)).toEqual(sha256(elf));
    expect(result.elfSha256Embedded).toBe(true);
    expect(result.elfSha256Offset).toBe(0xb0);

    expect(image[parsedImage.checksumOffset]).toBe(xorChecksum(parsedImage.segments.map((segment) => segment.data)));
    expect(image.slice(parsedImage.checksumOffset + 1, image.byteLength)).toEqual(sha256(image.slice(0, parsedImage.checksumOffset + 1)));
  });

  it('does not reserve an ELF digest without a mapped app descriptor', async () => {
    const elf = elf32([
      { name: '.data', address: 0x3fc80000, data: [1, 2, 3, 4] },
      { name: '.text', address: 0x42000020, data: [5, 6, 7, 8] },
    ]);

    const result = await buildEsp32C3Image(elf, { appendDigest: false });
    expect(result.elfSha256Embedded).toBe(false);
    expect(result.elfSha256Offset).toBeNull();
    expect(result.image[23]).toBe(0);
    const parsed = parseImage(result.image);
    expect(result.image.byteLength).toBe(parsed.checksumOffset + 1);
  });

  it('rejects an app descriptor whose 0xb0 digest field is not blank', async () => {
    const data = new Array<number>(0xb0).fill(0x7a);
    await expect(buildEsp32C3Image(elf32([
      { name: '.flash.appdesc', address: 0x3c000020, data },
    ]))).rejects.toThrow(/not zero-filled/);
  });

  it('rejects non-RISC-V and malformed section tables', () => {
    const elf = elf32([{ name: '.text', address: 0x42000020, data: [1, 2, 3, 4] }]);
    putU16(elf, 18, 0x5e);
    expect(() => parseEsp32C3Elf(elf)).toThrow(Esp32C3ImageError);

    const malformed = elf32([{ name: '.text', address: 0x42000020, data: [1, 2, 3, 4] }]);
    putU16(malformed, 50, 0xffff);
    expect(() => parseEsp32C3Elf(malformed)).toThrow(/section-name table index/);
  });
});

describe('ESP32-C5 browser image builder', () => {
  it('uses the C5 memory map, image chip id, and flash-frequency encodings in both copies', async () => {
    const appDescription = new Array<number>(0xb0).fill(0x45);
    appDescription.fill(0, 0x90, 0xb0);
    const elf = elf32([
      { name: '.flash.appdesc', address: 0x42000020, data: appDescription },
      { name: '.dram0.data', address: 0x40800000, data: [1, 2, 3, 4] },
      { name: '.flash.text', address: 0x43010020, data: [5, 6, 7, 8] },
    ], 0x40800024);

    const parsed = parseEsp32C5Elf(elf);
    expect(parsed.entrypoint).toBe(0x40800024);
    expect(parsed.sections.map((section) => section.memoryTypes)).toEqual([
      ['drom', 'irom'],
      ['dram', 'byte-accessible', 'iram'],
      ['drom', 'irom'],
    ]);
    expect(parseEsp32C6Elf(elf).sections[2].memoryTypes).toEqual([]);
    expect(parsePublicEsp32C5Elf(elf).sections.map((section) => section.memoryTypes)).toEqual(
      parsed.sections.map((section) => section.memoryTypes),
    );

    const result = await buildEsp32C5Image(elf, {
      flashMode: 'dio',
      flashSize: '4MB',
      flashFrequency: '80m',
    });
    const imageView = new DataView(result.image.buffer, result.image.byteOffset, result.image.byteLength);
    const textSegment = result.segments.find((segment) => segment.name === '.flash.text');

    expect(imageView.getUint16(12, true)).toBe(ESP32_C5_IMAGE_CHIP_ID);
    expect(result.image[3]).toBe(0x2f);
    expect(textSegment?.address).toBe(0x43010020);
    expect(((textSegment?.fileOffset ?? 0) + 8) % 0x10000).toBe(0x20);
    expect(result.image.slice(ESP32_C3_ELF_SHA256_OFFSET, ESP32_C3_ELF_SHA256_OFFSET + 32)).toEqual(sha256(elf));
    expect(result.elfSha256Embedded).toBe(true);

    for (const [flashFrequency, encoded] of [['40m', 0x00], ['20m', 0x02]] as const) {
      const frequencyResult = await buildEsp32C5Image(elf, { flashSize: '4MB', flashFrequency });
      expect(frequencyResult.image[3]).toBe(0x20 + encoded);
    }

    const publicResult = await buildPublicEsp32C5Image(elf, {
      flashMode: 'dio',
      flashSize: '4MB',
      flashFrequency: '80m',
    });
    expect(publicResult.image).toEqual(result.image);
  });

  it('rejects flash frequencies that ESP32-C5 does not support', async () => {
    const elf = elf32([{ name: '.flash.text', address: 0x42000020, data: [1, 2, 3, 4] }]);
    await expect(buildEsp32C5Image(elf, { flashFrequency: '26m' })).rejects.toThrow(
      /unsupported ESP32-C5 flash frequency/,
    );
  });
});

describe('ESP32-C6 browser image builder', () => {
  it('uses the C6 union-bus memory map and image chip id', async () => {
    const appDescription = new Array<number>(0xb0).fill(0x43);
    appDescription.fill(0, 0x90, 0xb0);
    const elf = elf32([
      { name: '.flash.appdesc', address: 0x42000020, data: appDescription },
      { name: '.dram0.data', address: 0x40800000, data: [1, 2, 3, 4] },
      { name: '.flash.text', address: 0x42010020, data: [5, 6, 7, 8] },
    ], 0x40800024);

    const parsed = parseEsp32C6Elf(elf);
    expect(parsed.entrypoint).toBe(0x40800024);
    expect(parsed.sections.map((section) => section.memoryTypes)).toEqual([
      ['drom', 'irom'],
      ['dram', 'byte-accessible', 'iram'],
      ['drom', 'irom'],
    ]);

    const result = await buildEsp32C6Image(elf, {
      flashMode: 'dio',
      flashSize: '4MB',
      flashFrequency: '80m',
    });
    const image = result.image;
    const imageView = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const parsedImage = parseImage(image);

    expect(imageView.getUint16(12, true)).toBe(ESP32_C6_IMAGE_CHIP_ID);
    expect(image[3]).toBe(0x20);
    expect(parsedImage.segments[0].address).toBe(0x42000020);
    expect(parsedImage.segments.some((segment) => segment.address === 0x40800000)).toBe(true);
    expect(parsedImage.segments.at(-1)?.address).toBe(0x42010020);
    expect(image.slice(ESP32_C3_ELF_SHA256_OFFSET, ESP32_C3_ELF_SHA256_OFFSET + 32)).toEqual(sha256(elf));
    expect(result.elfSha256Embedded).toBe(true);
  });

  it('keeps the C3 parser on the C3 memory map', () => {
    const elf = elf32([{ name: '.flash.text', address: 0x42080020, data: [1, 2, 3, 4] }]);
    expect(parseEsp32C3Elf(elf).sections[0].memoryTypes).toEqual(['irom']);
    expect(parseEsp32C6Elf(elf).sections[0].memoryTypes).toEqual(['drom', 'irom']);
  });
});

describe('ESP32-H2 browser image builder', () => {
  it('uses the union-bus map, H2 chip id, and H2 flash-frequency encoding', async () => {
    const appDescription = new Array<number>(0xb0).fill(0x48);
    appDescription.fill(0, 0x90, 0xb0);
    const elf = elf32([
      { name: '.flash.appdesc', address: 0x42000020, data: appDescription },
      { name: '.dram0.data', address: 0x40800000, data: [1, 2, 3, 4] },
      { name: '.flash.text', address: 0x42010020, data: [5, 6, 7, 8] },
    ], 0x40800024);

    expect(parseEsp32H2Elf(elf).sections[0].memoryTypes).toEqual(['drom', 'irom']);
    const result = await buildEsp32H2Image(elf, {
      flashMode: 'dio',
      flashSize: '4MB',
      flashFrequency: '48m',
    });
    const view = new DataView(result.image.buffer, result.image.byteOffset, result.image.byteLength);
    expect(view.getUint16(12, true)).toBe(ESP32_H2_IMAGE_CHIP_ID);
    expect(result.image[3]).toBe(0x2f);
    expect(result.elfSha256Embedded).toBe(true);
  });
});

describe('ESP32-P4 browser image builder', () => {
  it('matches the P4 memory map, image chip id, and flash-frequency encodings in both copies', async () => {
    const appDescription = new Array<number>(0xb0).fill(0x50);
    appDescription.fill(0, 0x90, 0xb0);
    const elf = elf32([
      { name: '.flash.appdesc', address: 0x40030020, data: appDescription },
      { name: '.dram0.data', address: 0x4ff00000, data: [1, 2, 3, 4] },
      { name: '.flash.text', address: 0x48010020, data: [5, 6, 7, 8] },
    ], 0x4ff00024);

    const parsed = parseEsp32P4Elf(elf);
    expect(parsed.entrypoint).toBe(0x4ff00024);
    expect(parsed.sections.map((section) => section.memoryTypes)).toEqual([
      ['drom', 'irom'],
      ['dram', 'byte-accessible', 'iram'],
      ['drom', 'irom'],
    ]);
    expect(parseEsp32C5Elf(elf).sections[2].memoryTypes).toEqual([]);
    expect(parsePublicEsp32P4Elf(elf).sections.map((section) => section.memoryTypes)).toEqual(
      parsed.sections.map((section) => section.memoryTypes),
    );

    const result = await buildEsp32P4Image(elf, {
      flashMode: 'dio',
      flashSize: '4MB',
      flashFrequency: '80m',
    });
    const view = new DataView(result.image.buffer, result.image.byteOffset, result.image.byteLength);
    const textSegment = result.segments.find((segment) => segment.name === '.flash.text');

    expect(view.getUint16(12, true)).toBe(ESP32_P4_IMAGE_CHIP_ID);
    expect(result.image[3]).toBe(0x2f);
    expect(textSegment?.address).toBe(0x48010020);
    expect(((textSegment?.fileOffset ?? 0) + 8) % 0x10000).toBe(0x20);
    expect(result.image.slice(ESP32_C3_ELF_SHA256_OFFSET, ESP32_C3_ELF_SHA256_OFFSET + 32)).toEqual(sha256(elf));
    expect(result.elfSha256Embedded).toBe(true);

    for (const [flashFrequency, encoded] of [['40m', 0x00], ['26m', 0x01], ['20m', 0x02]] as const) {
      const frequencyResult = await buildEsp32P4Image(elf, { flashSize: '4MB', flashFrequency });
      expect(frequencyResult.image[3]).toBe(0x20 + encoded);
    }

    const publicResult = await buildPublicEsp32P4Image(elf, {
      flashMode: 'dio',
      flashSize: '4MB',
      flashFrequency: '80m',
    });
    expect(publicResult.image).toEqual(result.image);
  });

  it('rejects flash frequencies that ESP32-P4 does not support', async () => {
    const elf = elf32([{ name: '.flash.text', address: 0x40000020, data: [1, 2, 3, 4] }]);
    await expect(buildEsp32P4Image(elf, { flashFrequency: '48m' })).rejects.toThrow(
      /unsupported ESP32-P4 flash frequency/,
    );
  });
});
