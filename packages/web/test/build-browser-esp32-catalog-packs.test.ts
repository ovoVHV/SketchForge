import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  buildCatalogPacks,
  CATALOG_PACK_LIMITS,
  classifyCatalogPackFailure,
  createCatalogSourcePack,
  createCatalogSourcePackFromFiles,
  inferCatalogRegistryDependencies,
  migrateCatalogRegistryToImmutablePaths,
  parseCatalogZip,
  parseCatalogBuildArgs,
  planCatalogPacks,
  readCatalogRecords,
  resetCatalogInferredDependencies,
  verifyCatalogArchive,
} from '../../../scripts/build-browser-esp32-catalog-packs.mjs';
import { browserToolchainPackRevisionInput } from '../public/avr/v3/toolchain-pack.js';

function crc32(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? ((value >>> 1) ^ 0xedb88320) : (value >>> 1);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<{ name: string; content: string | Buffer; method?: 0 | 8 }>) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const source = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
    const method = entry.method ?? 8;
    const data = method === 8 ? deflateRawSync(source) : source;
    const checksum = crc32(source);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(source.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(source.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

const fixtureRecord = {
  name: 'Catalog Fixture',
  version: '1.0.0',
  architectures: ['*'],
  dependencies: [],
  providesIncludes: ['Fixture.h'],
  url: 'https://downloads.example.test/fixture.zip',
  checksum: `SHA-256:${'a'.repeat(64)}`,
};

describe('catalog browser pack generator', () => {
  it('classifies bounded Pack failures for retry and release reporting', () => {
    expect(classifyCatalogPackFailure(new Error('U8g2 archive download timed out'))).toEqual({
      failureClass: 'download-timeout',
      retryable: true,
    });
    expect(classifyCatalogPackFailure(new Error('lvgl archive exceeds the byte limit'))).toEqual({
      failureClass: 'archive-limit-or-invalid',
      retryable: false,
    });
    expect(classifyCatalogPackFailure(new Error('library source artifact integrity checksum mismatch'))).toEqual({
      failureClass: 'integrity',
      retryable: false,
    });
    expect(classifyCatalogPackFailure(new Error('library source tree exceeds the browser Pack limit'))).toEqual({
      failureClass: 'pack-limit',
      retryable: false,
    });
  });

  it('accepts only integrity-verified local catalog archives', () => {
    const bytes = Buffer.from('locked archive');
    const plan = {
      name: 'Catalog Fixture',
      source: {
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
    expect(verifyCatalogArchive(plan, bytes)).toBe(bytes);
    expect(() => verifyCatalogArchive(plan, Buffer.from('wrong archive'))).toThrow(/size mismatch/);
    expect(parseCatalogBuildArgs(['--build', '--name', 'lvgl', '--limit', '1', '--archive', './fixture.zip']))
      .toMatchObject({ build: true, names: ['lvgl'], limit: 1, archive: expect.stringMatching(/fixture\.zip$/) });
  });

  it('reads the checked-in catalog and distinguishes existing packs', () => {
    const records = readCatalogRecords();
    expect(records).toHaveLength(113);
    const planned = planCatalogPacks(records, {
      existing: new Map([['accelstepper@1.64.0', { id: 'existing' }]]),
    });
    expect(planned.filter((entry) => entry.state === 'existing')).toHaveLength(1);
    expect(planned.filter((entry) => entry.state === 'incompatible')).toHaveLength(6);
    expect(planned.filter((entry) => entry.state === 'candidate')).toHaveLength(106);
    expect(new Set(planned.map((entry) => entry.id)).size).toBe(113);
    expect(planned.flatMap((entry) => entry.dependencies).every((dependency) => dependency.version)).toBe(true);
  });

  it('removes stale inferred edges before rebuilding catalog dependencies', () => {
    const registry = {
      schema: 2,
      libraries: [{
        name: 'Consumer',
        defaultVersion: '1.0.0',
        versions: [{
          version: '1.0.0',
          depends: [{ name: 'Stale', version: '1.0.0' }],
        }],
      }, {
        name: 'Required',
        defaultVersion: '2.0.0',
        versions: [{ version: '2.0.0', depends: [] }],
      }],
    };
    const restored = resetCatalogInferredDependencies(registry, [{
      name: 'Consumer',
      version: '1.0.0',
      architectures: ['esp32'],
      dependencies: [{ name: 'Required', version: '2.0.0' }],
      publicHeaders: ['Consumer.h'],
      source: { url: 'https://example.test/consumer.zip', sha256: 'a'.repeat(64) },
    }]);

    expect(restored.libraries[0]!.versions[0]!.depends).toEqual([]);
    expect(registry.libraries[0]!.versions[0]!.depends).toEqual([
      { name: 'Stale', version: '1.0.0' },
    ]);
  });

  it('classifies a renamed catalog library as superseded when another Pack provides its full public surface', () => {
    const records = [{
      name: 'Legacy BLE',
      version: '1.0.0',
      architectures: ['esp32'],
      dependencies: [],
      publicHeaders: ['BLEDevice.h', 'BLEScan.h'],
      source: { url: 'https://example.test/legacy.zip', sha256: 'a'.repeat(64) },
    }];
    const provider = Object.freeze({ name: 'BLE', version: '3.3.7', architectures: Object.freeze(['esp32']) });
    const planned = planCatalogPacks(records, {
      providedHeaders: new Map([
        ['bledevice.h', [provider]],
        ['blescan.h', [provider]],
      ]),
    });

    expect(planned).toMatchObject([{
      name: 'Legacy BLE',
      state: 'superseded',
      replacement: [{ name: 'BLE', version: '3.3.7' }],
    }]);

    const migrated = planCatalogPacks(records, {
      providedHeaders: new Map([
        ['bledevice.h', [provider]],
        ['blescan.h', [provider]],
      ]),
      replaceProviders: ['Legacy BLE'],
    });
    expect(migrated).toMatchObject([{
      name: 'Legacy BLE',
      state: 'candidate',
    }]);
  });

  it('replaces an obsolete header provider only when migration is explicitly requested', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-catalog-provider-migration-'));
    try {
      const registryRoot = join(root, 'registry');
      const output = join(root, 'output');
      mkdirSync(registryRoot, { recursive: true });
      const old = writeSourcePack(registryRoot, 'old-provider', 'Old Provider', '1.0.0', [
        { path: 'src/Shared.h', content: '#pragma once\n' },
      ], '9'.repeat(64));
      const consumer = writeSourcePack(registryRoot, 'consumer', 'Consumer', '1.0.0', [
        { path: 'src/Consumer.h', content: '#include <Shared.h>\n' },
      ], 'a'.repeat(64));
      const registry = {
        schema: 2,
        libraries: [
          registryLibrary('Consumer', 'consumer', 'Consumer.h', consumer.revision, [
            { name: 'Old Provider', version: '1.0.0' },
          ]),
          registryLibrary('Old Provider', 'old-provider', 'Shared.h', old.revision),
        ],
      };
      const registryPath = join(registryRoot, 'registry.json');
      writeFileSync(registryPath, JSON.stringify(registry));
      const archive = zip([
        { name: 'new-provider-2.0.0/library.properties', content: 'name=New Provider\nincludes=Shared.h\n' },
        { name: 'new-provider-2.0.0/src/Shared.h', content: '#pragma once\n' },
      ]);
      const archivePath = join(root, 'new-provider.zip');
      writeFileSync(archivePath, archive);
      const catalogPath = join(root, 'catalog.ts');
      writeFileSync(catalogPath, `export const FIXTURE = ${JSON.stringify([{
        name: 'New Provider',
        version: '2.0.0',
        architectures: ['esp32'],
        dependencies: [],
        providesIncludes: ['Shared.h'],
        url: 'https://example.invalid/new-provider.zip',
        size: archive.byteLength,
        checksum: `SHA-256:${createHash('sha256').update(archive).digest('hex')}`,
      }])} as const;\n`);

      await buildCatalogPacks({
        catalog: catalogPath,
        registry: registryPath,
        output,
        architecture: 'esp32',
        build: true,
        names: ['new provider'],
        replaceProviders: ['new provider'],
        limit: 1,
        concurrency: 1,
        archive: archivePath,
      });
      const staged = JSON.parse(readFileSync(join(output, 'registry.staging.json'), 'utf8'));
      expect(staged.libraries.map((library) => library.name)).toEqual(['Consumer', 'New Provider']);
      expect(staged.libraries[0].versions[0].depends).toEqual([
        { name: 'New Provider', version: '2.0.0' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses deflated archives, strips one root, and rejects traversal', () => {
    const archive = zip([
      { name: 'fixture-1.0/src/Fixture.h', content: '#pragma once\n' },
      { name: 'fixture-1.0/src/Fixture.cpp', content: '#include "Fixture.h"\n' },
      { name: 'fixture-1.0/examples/demo.cpp', content: 'int ignored;\n', method: 0 },
    ]);
    expect(parseCatalogZip(archive).map((entry) => entry.path)).toEqual([
      'fixture-1.0/examples/demo.cpp',
      'fixture-1.0/src/Fixture.cpp',
      'fixture-1.0/src/Fixture.h',
    ]);
    expect(() => parseCatalogZip(zip([{ name: '../escape.h', content: 'x' }]))).toThrow(/unsafe/);
  });

  it('creates a deterministic source pack under the browser artifact limit', () => {
    const archive = zip([
      { name: 'fixture-1.0/library.properties', content: 'name=Catalog Fixture\nincludes=Fixture.h\n' },
      { name: 'fixture-1.0/src/Fixture.h', content: '#pragma once\n' },
      { name: 'fixture-1.0/src/Fixture.cpp', content: '#include "Fixture.h"\n#include "../Root.h"\n' },
      { name: 'fixture-1.0/Root.h', content: '#pragma once\n#include "RootDetail.h"\n' },
      { name: 'fixture-1.0/RootDetail.h', content: '#pragma once\n' },
      { name: 'fixture-1.0/Unused.h', content: '#pragma once\n' },
      { name: 'fixture-1.0/src/private/config.h', content: '#pragma once\n' },
      { name: 'fixture-1.0/src/debugging/test/required.h', content: '#pragma once\n' },
      { name: 'fixture-1.0/src/examples_linux/ignored.cpp', content: '#include <RF24/RF24.h>\n' },
      { name: 'fixture-1.0/examples/demo.cpp', content: 'int ignored;\n' },
      { name: 'fixture-1.0/tests/ignored.h', content: '#pragma once\n' },
    ]);
    const first = createCatalogSourcePack(fixtureRecord, archive);
    const second = createCatalogSourcePack(fixtureRecord, archive);
    expect(first.id).toBe('arduino-lib-catalog-fixture');
    expect(first.publicHeaders).toEqual(['Fixture.h']);
    expect(first.files.map((file) => file.path)).toEqual([
      'Root.h',
      'RootDetail.h',
      'src/Fixture.cpp',
      'src/Fixture.h',
      'src/debugging/test/required.h',
      'src/private/config.h',
    ]);
    expect(JSON.parse(first.bytes.toString('utf8')).includeDirs).toEqual(['.', 'src']);
    expect(first.artifact.sha256).toBe(createHash('sha256').update(first.bytes).digest('hex'));
    for (const chunk of first.artifact.chunks) {
      const transportSha256 = chunk.compressedSha256 ?? chunk.sha256;
      expect(chunk.path).toContain(`-${transportSha256.slice(0, 16)}.bin${chunk.compression ? '.gz' : ''}`);
    }
    const manifest = { schema: 1, id: first.id, version: first.version, revision: first.revision, artifacts: [first.artifact] };
    expect(first.revision).toBe(createHash('sha256').update(browserToolchainPackRevisionInput(manifest)).digest('hex'));
    expect(first.revision).toBe(second.revision);
    expect(first.bytes.equals(second.bytes)).toBe(true);
  });

  it('keeps source fragments angle-included by flat-root library headers', () => {
    const archive = zip([
      { name: 'fixture-1.0/library.properties', content: 'name=Catalog Fixture\nincludes=Display.h\n' },
      { name: 'fixture-1.0/Display.h', content: '#pragma once\n#include <Fonts/glcdfont.c>\n' },
      { name: 'fixture-1.0/Display.cpp', content: '#include "Display.h"\nint display_driver = 1;\n' },
      { name: 'fixture-1.0/Fonts/glcdfont.c', content: 'const unsigned char fixture_font[] = { 0 };\n' },
      { name: 'fixture-1.0/Fonts/unused.c', content: 'int unused_font = 1;\n' },
    ]);

    const pack = createCatalogSourcePack(fixtureRecord, archive);
    expect(pack.files.map((file) => file.path)).toEqual([
      'src/Display.cpp',
      'src/Display.h',
      'src/Fonts/glcdfont.c',
    ]);
    const payload = JSON.parse(pack.bytes.toString('utf8'));
    expect(payload.files.find((file) => file.path === 'src/Fonts/glcdfont.c')?.content)
      .toContain('fixture_font');
  });

  it('filters non-source archive entries before applying decoded source limits', () => {
    const archive = zip([
      { name: 'fixture-1.0/library.properties', content: 'name=Catalog Fixture\nincludes=Fixture.h\n' },
      { name: 'fixture-1.0/src/Fixture.h', content: '#pragma once\n' },
      { name: 'fixture-1.0/docs/generated.h', content: 'x'.repeat(512) },
    ]);
    const pack = createCatalogSourcePack(fixtureRecord, archive, {
      ...CATALOG_PACK_LIMITS,
      maxArchiveEntryBytes: 1024,
      maxArchiveFileBytes: 64,
      maxArchiveDeclaredBytes: 2048,
    });
    expect(pack.files.map((file) => file.path)).toEqual(['src/Fixture.h']);
  });

  it('creates deterministic independently verified gzip chunks for a large source tree', () => {
    const largeHeader = `#pragma once\n${'constexpr int catalog_value = 7;\n'.repeat(70_000)}`;
    const archive = zip([
      { name: 'fixture-1.0/library.properties', content: 'name=Catalog Fixture\nincludes=Fixture.h\n' },
      { name: 'fixture-1.0/src/Fixture.h', content: largeHeader },
      { name: 'fixture-1.0/src/Fixture.cpp', content: '#include "Fixture.h"\n' },
    ]);
    const limits = {
      ...CATALOG_PACK_LIMITS,
      maxArchiveRatio: 20_000,
      maxSourceBytes: 4 * 1024 * 1024,
      maxPayloadBytes: 4 * 1024 * 1024,
      maxChunkBytes: 64 * 1024,
    };
    const first = createCatalogSourcePack(fixtureRecord, archive, limits);
    const second = createCatalogSourcePack(fixtureRecord, archive, limits);
    expect(first.artifact.size).toBeGreaterThan(2 * 1024 * 1024);
    expect(first.artifact.chunks.length).toBeGreaterThan(16);
    expect(first.transportBytes).toBeLessThan(first.artifact.size);
    expect(first.artifact).toEqual(second.artifact);
    const decoded = Buffer.concat(first.chunks.map((chunk) => (
      chunk.compression === 'gzip' ? gunzipSync(chunk.bytes) : chunk.bytes
    )));
    expect(decoded.equals(first.bytes)).toBe(true);
    expect(first.chunks.every((chunk) => chunk.size <= limits.maxChunkBytes)).toBe(true);
  });

  it('normalizes legacy text source bytes without silent replacement characters', () => {
    const archive = zip([
      { name: 'fixture-1.0/library.properties', content: 'name=Catalog Fixture\nincludes=Fixture.h\n' },
      { name: 'fixture-1.0/src/Fixture.h', content: Buffer.from('// copyright \xff\n#pragma once\n', 'latin1') },
    ]);
    const pack = createCatalogSourcePack(fixtureRecord, archive);
    const payload = JSON.parse(pack.bytes.toString('utf8'));
    expect(payload.files[0].content).toContain('copyright ÿ');
    expect(payload.files[0].content).not.toContain('\ufffd');
    expect(pack.files[0].sourceEncoding).toBe('windows-1252');
    expect(pack.files[0].upstreamSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('builds the same source artifact from a verified platform library tree', () => {
    const files = [
      { path: 'library.properties', bytes: Buffer.from('name=Catalog Fixture\nincludes=Fixture.h\n') },
      { path: 'src/Fixture.cpp', bytes: Buffer.from('#include "Fixture.h"\n') },
      { path: 'src/Fixture.h', bytes: Buffer.from('#pragma once\n') },
    ];
    const direct = createCatalogSourcePackFromFiles(fixtureRecord, files);
    const archived = createCatalogSourcePack(fixtureRecord, zip(files.map((file) => ({
      name: `fixture-1.0/${file.path}`,
      content: file.bytes,
    }))));
    expect(direct.revision).toBe(archived.revision);
    expect(direct.bytes.equals(archived.bytes)).toBe(true);
  });

  it('infers Pack dependencies from external includes without library-name branches', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-catalog-dependencies-'));
    try {
      const dependency = writeSourcePack(root, 'dependency', 'Dependency', '1.0.0', [
        { path: 'src/Dependency.h', content: '#pragma once\n' },
        { path: 'src/CompatibilityAlias.h', content: '#include "Dependency.h"\n' },
      ], 'a'.repeat(64));
      const optional = writeSourcePack(root, 'optional', 'Optional', '1.0.0', [
        { path: 'src/OptionalDependency.h', content: '#pragma once\n' },
      ], 'd'.repeat(64));
      const defaultEnabled = writeSourcePack(root, 'default-enabled', 'DefaultEnabled', '1.0.0', [
        { path: 'src/DefaultEnabled.h', content: '#pragma once\n' },
      ], 'e'.repeat(64));
      const declared = writeSourcePack(root, 'declared', 'Declared', '1.0.0', [
        { path: 'src/Declared.h', content: '#pragma once\n' },
      ], 'c'.repeat(64));
      const consumer = writeSourcePack(root, 'consumer', 'Consumer', '1.0.0', [
        { path: 'src/Consumer.h', content: '#pragma once\n' },
        {
          path: 'src/Consumer.cpp',
          content: '#include "private/Required.h"\n#if USE_OPTIONAL\n#include "private/OptionalBridge.h"\n#endif\n',
        },
        {
          path: 'src/private/Required.h',
          content: '#ifndef CONSUMER_REQUIRED_H\n#define CONSUMER_REQUIRED_H\n#include <CompatibilityAlias.h>\n#ifndef CONSUMER_NO_DEFAULT_ENABLED\n#include <DefaultEnabled.h>\n#endif\n#if USE_OPTIONAL\n#include <Optional.h>\n#endif\n#endif\n',
        },
        { path: 'src/private/OptionalBridge.h', content: '#include <OptionalDependency.h>\n' },
      ], 'b'.repeat(64));
      const consumerLibrary = registryLibrary('Consumer', 'consumer', 'Consumer.h', consumer.revision, [
        { name: 'Declared', version: '1.0.0' },
      ]);
      const registry = {
        schema: 2,
        libraries: [
          consumerLibrary,
          registryLibrary('Declared', 'declared', 'Declared.h', declared.revision),
          registryLibrary('DefaultEnabled', 'default-enabled', 'DefaultEnabled.h', defaultEnabled.revision),
          registryLibrary('Dependency', 'dependency', 'Dependency.h', dependency.revision),
          registryLibrary('Optional', 'optional', 'OptionalDependency.h', optional.revision),
        ],
      };
      const inferred = inferCatalogRegistryDependencies(registry, root);
      expect(inferred.libraries[0]!.versions[0]!.depends).toEqual([
        { name: 'Declared', version: '1.0.0' },
        { name: 'DefaultEnabled', version: '1.0.0' },
        { name: 'Dependency', version: '1.0.0' },
      ]);
      expect(inferred.libraries[1]!.versions[0]!.depends).toEqual([]);
      expect(inferred.libraries[2]!.versions[0]!.depends).toEqual([]);
      expect(inferred.libraries[3]!.versions[0]!.depends).toEqual([]);
      expect(inferred.libraries[4]!.versions[0]!.depends).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps platform CONFIG macro includes in the default Pack closure', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-catalog-config-dependencies-'));
    try {
      const dependency = writeSourcePack(root, 'config-dependency', 'ConfigDependency', '1.0.0', [
        { path: 'src/ConfigDependency.h', content: '#pragma once\n' },
      ], 'f'.repeat(64));
      const esp32Dependency = writeSourcePack(root, 'esp32-dependency', 'Esp32Dependency', '1.0.0', [
        { path: 'src/Esp32Dependency.h', content: '#pragma once\n' },
      ], '2'.repeat(64));
      const consumer = writeSourcePack(root, 'config-consumer', 'ConfigConsumer', '1.0.0', [
        { path: 'src/ConfigConsumer.h', content: '#pragma once\n' },
        {
          path: 'src/ConfigConsumer.cpp',
          content: '#ifdef CONFIG_PLATFORM_FEATURE\n#include <ConfigDependency.h>\n#endif\n#ifdef ESP32\n#include <Esp32Dependency.h>\n#endif\n',
        },
      ], '1'.repeat(64));
      const inferred = inferCatalogRegistryDependencies({
        schema: 2,
        libraries: [
          registryLibrary('ConfigConsumer', 'config-consumer', 'ConfigConsumer.h', consumer.revision),
          registryLibrary('ConfigDependency', 'config-dependency', 'ConfigDependency.h', dependency.revision),
          registryLibrary('Esp32Dependency', 'esp32-dependency', 'Esp32Dependency.h', esp32Dependency.revision),
        ],
      }, root);
      expect(inferred.libraries.find((library) => library.name === 'ConfigConsumer')
        .versions[0].depends).toEqual([
        { name: 'ConfigDependency', version: '1.0.0' },
        { name: 'Esp32Dependency', version: '1.0.0' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps includes behind a preceding unconditional feature define', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-catalog-defined-dependencies-'));
    try {
      const dependency = writeSourcePack(root, 'defined-dependency', 'DefinedDependency', '1.0.0', [
        { path: 'src/DefinedDependency.h', content: '#pragma once\n' },
      ], '3'.repeat(64));
      const consumer = writeSourcePack(root, 'defined-consumer', 'DefinedConsumer', '1.0.0', [
        { path: 'src/DefinedConsumer.h', content: '#pragma once\n' },
        {
          path: 'src/DefinedConsumer.cpp',
          content: '#define USE_DEFINED_DEPENDENCY 1\n#if USE_DEFINED_DEPENDENCY\n#include <DefinedDependency.h>\n#endif\n',
        },
      ], '4'.repeat(64));
      const inferred = inferCatalogRegistryDependencies({
        schema: 2,
        libraries: [
          registryLibrary('DefinedConsumer', 'defined-consumer', 'DefinedConsumer.h', consumer.revision),
          registryLibrary('DefinedDependency', 'defined-dependency', 'DefinedDependency.h', dependency.revision),
        ],
      }, root);
      expect(inferred.libraries.find((library) => library.name === 'DefinedConsumer')
        .versions[0].depends).toEqual([
        { name: 'DefinedDependency', version: '1.0.0' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('infers a top-level compatibility header behind compound platform version guards', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-catalog-platform-version-dependencies-'));
    try {
      const platform = writeSourcePack(root, 'platform-network', 'PlatformNetwork', '1.0.0', [
        { path: 'src/PlatformNetwork.h', content: '#include "PlatformInterface.h"\n' },
        { path: 'src/PlatformInterface.h', content: '#pragma once\n' },
      ], '9'.repeat(64));
      const consumer = writeSourcePack(root, 'platform-consumer', 'PlatformConsumer', '1.0.0', [
        { path: 'src/PlatformConsumer.h', content: '#pragma once\n' },
        {
          path: 'src/PlatformConsumer.cpp',
          content: `#include "PlatformConsumer.h"
#if defined(ARDUINO) && !defined(ALTERNATE_ARDUINO_RUNTIME)
#if ESP_IDF_VERSION_MAJOR >= 5
#include <PlatformInterface.h>
#endif
#endif
`,
        },
      ], 'a'.repeat(64));
      const inferred = inferCatalogRegistryDependencies({
        schema: 2,
        libraries: [
          registryLibrary('PlatformConsumer', 'platform-consumer', 'PlatformConsumer.h', consumer.revision),
          registryLibrary('PlatformNetwork', 'platform-network', 'PlatformNetwork.h', platform.revision),
        ],
      }, root);
      expect(inferred.libraries.find((library) => library.name === 'PlatformConsumer')
        .versions[0].depends).toEqual([
        { name: 'PlatformNetwork', version: '1.0.0' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('propagates object macro values through the default platform branch', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-catalog-macro-values-'));
    try {
      const required = writeSourcePack(root, 'required-network', 'RequiredNetwork', '1.0.0', [
        { path: 'src/RequiredNetwork.h', content: '#pragma once\n' },
      ], '5'.repeat(64));
      const wrongTarget = writeSourcePack(root, 'wrong-network', 'WrongNetwork', '1.0.0', [
        { path: 'src/WrongNetwork.h', content: '#pragma once\n' },
      ], '6'.repeat(64));
      const optional = writeSourcePack(root, 'optional-network', 'OptionalNetwork', '1.0.0', [
        { path: 'src/OptionalNetwork.h', content: '#pragma once\n' },
      ], '7'.repeat(64));
      const consumer = writeSourcePack(root, 'network-consumer', 'NetworkConsumer', '1.0.0', [
        {
          path: 'src/NetworkConsumer.h',
          content: `#pragma once
#define NETWORK_PRIMARY (4)
#define NETWORK_OTHER (5)
#if !defined(NETWORK_TYPE)
#if defined(OTHER_TARGET)
#define NETWORK_TYPE NETWORK_OTHER
#elif defined(ESP32)
#define NETWORK_TYPE NETWORK_PRIMARY
#else
#define NETWORK_TYPE NETWORK_OTHER
#endif
#endif
#if NETWORK_TYPE == NETWORK_PRIMARY
#include <RequiredNetwork.h>
#elif NETWORK_TYPE == NETWORK_OTHER
#include <WrongNetwork.h>
#endif
#if UNKNOWN_FEATURE == NETWORK_PRIMARY
#include <OptionalNetwork.h>
#endif
`,
        },
      ], '8'.repeat(64));
      const inferred = inferCatalogRegistryDependencies({
        schema: 2,
        libraries: [
          registryLibrary('NetworkConsumer', 'network-consumer', 'NetworkConsumer.h', consumer.revision),
          registryLibrary('OptionalNetwork', 'optional-network', 'OptionalNetwork.h', optional.revision),
          registryLibrary('RequiredNetwork', 'required-network', 'RequiredNetwork.h', required.revision),
          registryLibrary('WrongNetwork', 'wrong-network', 'WrongNetwork.h', wrongTarget.revision),
        ],
      }, root);
      expect(inferred.libraries.find((library) => library.name === 'NetworkConsumer')
        .versions[0].depends).toEqual([
        { name: 'RequiredNetwork', version: '1.0.0' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('migrates legacy catalog manifests to full revision-addressed paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-catalog-migration-'));
    const source = join(root, 'source');
    const output = join(root, 'output');
    const revision = 'a'.repeat(64);
    try {
      writeSourcePack(source, 'catalog-fixture', 'Catalog Fixture', '1.0.0', [
        { path: 'src/Fixture.h', content: '#pragma once\n' },
      ], revision);
      const registry = {
        schema: 2,
        libraries: [registryLibrary('Catalog Fixture', 'catalog-fixture', 'Fixture.h', revision)],
      };
      const migrated = migrateCatalogRegistryToImmutablePaths(
        registry,
        join(source, 'registry.json'),
        output,
      );
      const manifest = migrated.libraries[0]!.versions[0]!.pack.manifest;
      expect(manifest).toBe(`catalog-fixture/1.0.0/${revision}/toolchain.json`);
      expect(JSON.parse(readFileSync(join(output, ...manifest.split('/')), 'utf8'))).toMatchObject({ revision });
      expect(registry.libraries[0]!.versions[0]!.pack.manifest)
        .toBe('catalog-fixture/1.0.0/toolchain.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeSourcePack(
  root: string,
  slug: string,
  name: string,
  version: string,
  files: Array<{ path: string; content: string }>,
  revision: string,
) {
  const directory = join(root, slug, version);
  mkdirSync(join(directory, 'chunks'), { recursive: true });
  const bytes = Buffer.from(JSON.stringify({
    schema: 1,
    name,
    version,
    architectures: ['esp32'],
    includeDirs: ['src'],
    files,
  }));
  const digest = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(directory, 'chunks', 'sources.bin'), bytes);
  writeFileSync(join(directory, 'toolchain.json'), JSON.stringify({
    schema: 1,
    id: `arduino-lib-${slug}`,
    version,
    revision,
    artifacts: [{
      id: 'sources',
      kind: 'library-source-json',
      size: bytes.byteLength,
      sha256: digest,
      chunks: [{ path: 'chunks/sources.bin', size: bytes.byteLength, sha256: digest }],
    }],
  }));
  return { revision };
}

function registryLibrary(
  name: string,
  slug: string,
  header: string,
  revision: string,
  depends: Array<{ name: string; version: string }> = [],
) {
  return {
    name,
    defaultVersion: '1.0.0',
    versions: [{
      version: '1.0.0',
      architectures: ['esp32'],
      publicHeaders: [header],
      depends,
      pack: {
        id: `arduino-lib-${slug}`,
        revision,
        manifest: `${slug}/1.0.0/toolchain.json`,
        artifact: 'sources',
      },
    }],
  };
}
