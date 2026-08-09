import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildCkPlatformLibraryPacks } from '../../../scripts/build-ck-platform-library-packs.js';

describe('CK platform Library Pack builder', () => {
  it('discovers platform-owned libraries and infers their Pack dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-platform-libraries-'));
    try {
      const platform = join(root, 'platform');
      const registryRoot = join(root, 'base');
      const output = join(root, 'output');
      mkdirSync(platform, { recursive: true });
      mkdirSync(registryRoot, { recursive: true });
      writeFileSync(join(platform, 'platform.txt'), 'name=Fixture\n');
      writeFileSync(join(registryRoot, 'registry.json'), JSON.stringify({ schema: 2, libraries: [] }));
      writeLibrary(platform, 'SPI', 'SPI', 'SPI.h', '#pragma once\n');
      writeLibrary(platform, 'FS', 'FS', 'FS.h', '#pragma once\n#include <SPI.h>\n');

      const result = buildCkPlatformLibraryPacks({
        platformRoot: platform,
        platformId: 'fixture-platform',
        platformVersion: '1.2.3',
        platformRevision: 'fixture-revision',
        registry: join(registryRoot, 'registry.json'),
        output,
      });

      expect(result.report.built).toEqual([
        { name: 'FS', version: '1.2.3' },
        { name: 'SPI', version: '1.2.3' },
      ]);
      const fs = result.registry.libraries.find((library: any) => library.name === 'FS');
      expect(fs.versions[0].depends).toEqual([{ name: 'SPI', version: '1.2.3' }]);
      const manifest = JSON.parse(readFileSync(join(output, fs.versions[0].pack.manifest), 'utf8'));
      expect(manifest.artifacts[0]).toMatchObject({ kind: 'library-source-json' });
      expect(readFileSync(join(output, 'registry.staging.json'))).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps default-enabled secure transport includes in the platform dependency closure', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-platform-httpclient-'));
    try {
      const platform = join(root, 'platform');
      const registryRoot = join(root, 'base');
      const output = join(root, 'output');
      mkdirSync(platform, { recursive: true });
      mkdirSync(registryRoot, { recursive: true });
      writeFileSync(join(platform, 'platform.txt'), 'name=ESP32 Fixture\n');
      writeFileSync(join(registryRoot, 'registry.json'), JSON.stringify({ schema: 2, libraries: [] }));
      writeLibrary(platform, 'Networking', 'Networking', 'NetworkClient.h', '#pragma once\n', '3.3.7');
      writeLibrary(
        platform,
        'NetworkClientSecure',
        'NetworkClientSecure',
        'NetworkClientSecure.h',
        '#pragma once\n#include <NetworkClient.h>\n',
        '3.3.7',
      );
      writeLibrary(
        platform,
        'HTTPClient',
        'HTTPClient',
        'HTTPClient.h',
        '#pragma once\n#include <NetworkClient.h>\n#ifndef HTTPCLIENT_NOSECURE\n#include <NetworkClientSecure.h>\n#endif\n',
        '3.3.7',
      );

      const result = buildCkPlatformLibraryPacks({
        platformRoot: platform,
        platformId: 'espressif-arduino',
        platformVersion: '3.3.7',
        registry: join(registryRoot, 'registry.json'),
        output,
      });

      const httpClient = result.registry.libraries.find((library: any) => library.name === 'HTTPClient');
      expect(httpClient.versions[0].depends).toEqual([
        { name: 'NetworkClientSecure', version: '3.3.7' },
        { name: 'Networking', version: '3.3.7' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exports the primary platform header instead of ambiguous private root headers', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-platform-library-headers-'));
    try {
      const platform = join(root, 'platform');
      const registryRoot = join(root, 'base');
      const output = join(root, 'output');
      mkdirSync(platform, { recursive: true });
      mkdirSync(registryRoot, { recursive: true });
      writeFileSync(join(platform, 'platform.txt'), 'name=Fixture\n');
      writeFileSync(join(registryRoot, 'registry.json'), JSON.stringify({ schema: 2, libraries: [] }));
      writeLibraryWithoutIncludes(platform, 'SD', ['SD.h', 'sd_defines.h']);
      writeLibraryWithoutIncludes(platform, 'SD_MMC', ['SD_MMC.h', 'sd_defines.h']);

      const result = buildCkPlatformLibraryPacks({
        platformRoot: platform,
        platformId: 'fixture-platform',
        platformVersion: '1.2.3',
        registry: join(registryRoot, 'registry.json'),
        output,
      });

      expect(result.registry.libraries.find((library: any) => library.name === 'SD')
        .versions[0].publicHeaders).toEqual(['SD.h']);
      expect(result.registry.libraries.find((library: any) => library.name === 'SD_MMC')
        .versions[0].publicHeaders).toEqual(['SD_MMC.h']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts the directory and display name as aliases for one requested library', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-platform-library-aliases-'));
    try {
      const platform = join(root, 'platform');
      const registryRoot = join(root, 'base');
      const output = join(root, 'output');
      mkdirSync(platform, { recursive: true });
      mkdirSync(registryRoot, { recursive: true });
      writeFileSync(join(platform, 'platform.txt'), 'name=Fixture\n');
      writeFileSync(join(registryRoot, 'registry.json'), JSON.stringify({ schema: 2, libraries: [] }));
      writeLibrary(platform, 'Network', 'Network Library', 'Network.h', '#pragma once\n');

      const result = buildCkPlatformLibraryPacks({
        platformRoot: platform,
        platformId: 'fixture-platform',
        platformVersion: '1.2.3',
        registry: join(registryRoot, 'registry.json'),
        output,
        names: ['network', 'network library'],
      });

      expect(result.report.built).toEqual([{ name: 'Network Library', version: '1.2.3' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('re-pins existing dependencies when a platform-owned library takes precedence', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-platform-library-precedence-'));
    try {
      const basePlatform = join(root, 'base-platform');
      const emptyRegistry = join(root, 'empty-registry');
      const baseOutput = join(root, 'base-output');
      const targetPlatform = join(root, 'target-platform');
      const targetOutput = join(root, 'target-output');
      mkdirSync(basePlatform, { recursive: true });
      mkdirSync(emptyRegistry, { recursive: true });
      mkdirSync(targetPlatform, { recursive: true });
      writeFileSync(join(basePlatform, 'platform.txt'), 'name=Base Fixture\n');
      writeFileSync(join(targetPlatform, 'platform.txt'), 'name=Target Fixture\n');
      writeFileSync(join(emptyRegistry, 'registry.json'), JSON.stringify({ schema: 2, libraries: [] }));
      writeLibrary(basePlatform, 'Transport', 'Transport', 'Transport.h', '#pragma once\n', '0.9.0');
      writeLibrary(
        basePlatform,
        'Consumer',
        'Consumer',
        'Consumer.h',
        '#pragma once\n#include <Transport.h>\n',
        '1.0.0',
      );

      buildCkPlatformLibraryPacks({
        platformRoot: basePlatform,
        platformId: 'base-fixture',
        platformVersion: '0.9.0',
        registry: join(emptyRegistry, 'registry.json'),
        output: baseOutput,
      });

      writeLibrary(targetPlatform, 'Transport', 'Transport', 'Transport.h', '#pragma once\n', '2.0.0');
      const result = buildCkPlatformLibraryPacks({
        platformRoot: targetPlatform,
        platformId: 'target-fixture',
        platformVersion: '2.0.0',
        registry: join(baseOutput, 'registry.staging.json'),
        output: targetOutput,
      });

      const consumer = result.registry.libraries.find((library: any) => library.name === 'Consumer');
      expect(consumer.versions[0].depends).toEqual([{ name: 'Transport', version: '2.0.0' }]);
      const transport = result.registry.libraries.find((library: any) => library.name === 'Transport');
      expect(transport).toMatchObject({ defaultVersion: '2.0.0' });
      expect(transport.versions.map((version: any) => version.version)).toEqual(['2.0.0']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeLibrary(
  platform: string,
  directory: string,
  name: string,
  header: string,
  headerContent: string,
  version = '1.2.3',
) {
  const root = join(platform, 'libraries', directory);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'library.properties'), [
    `name=${name}`,
    `version=${version}`,
    'architectures=esp32',
    `includes=${header}`,
    '',
  ].join('\n'));
  writeFileSync(join(root, 'src', header), headerContent);
  writeFileSync(join(root, 'src', `${name}.cpp`), `#include "${header}"\n`);
}

function writeLibraryWithoutIncludes(platform: string, name: string, headers: string[]) {
  const root = join(platform, 'libraries', name);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'library.properties'), [
    `name=${name}`,
    'version=1.2.3',
    'architectures=esp32',
    '',
  ].join('\n'));
  for (const header of headers) writeFileSync(join(root, 'src', header), '#pragma once\n');
  writeFileSync(join(root, 'src', `${name}.cpp`), `#include "${headers[0]}"\n`);
}
