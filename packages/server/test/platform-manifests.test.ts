import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformManifest, resolvePlatformManifestWithRust } from '@arduinofast/core';

import { loadPublishedPlatformManifests } from '../src/platform-manifests.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('published CK Platform Manifest loader', () => {
  it('loads and verifies the shared Manifest pinned by all five registry entries', () => {
    const manifests = loadPublishedPlatformManifests({ repoRoot: REPO_ROOT });
    expect(manifests).toHaveLength(1);
    expect(manifests.flatMap((manifest) => manifest.boards.map((board) => board.fqbn)).sort())
      .toEqual([
        'esp32:esp32:esp32',
        'esp32:esp32:esp32c3',
        'esp32:esp32:esp32c6',
        'esp32:esp32:esp32s2',
        'esp32:esp32:esp32s3',
      ]);
  });

  it('publishes every property required by strict native ESP32 planning', async () => {
    const manifests = loadPublishedPlatformManifests({ repoRoot: REPO_ROOT });
    const required = [
      'build.mcu', 'build.f_cpu', 'build.tarch', 'build.target', 'build.board',
      'build.bootloader_addr', 'build.flash_mode', 'build.boot', 'build.boot_freq',
      'build.flash_freq', 'build.img_freq', 'build.flash_size', 'build.partitions',
    ];
    for (const manifest of manifests) {
      for (const board of manifest.boards) {
        const resolved = await resolvePlatformManifestWithRust({ manifest, fqbn: board.fqbn, options: {} });
        for (const name of required) {
          const value = expandResolvedProperty(resolved.properties, name);
          expect(value, `${board.fqbn} ${name}`).toBeTruthy();
          expect(value, `${board.fqbn} ${name}`).not.toContain('{');
        }
      }
    }
  });

  it('rejects registry bytes that differ from the release pin', () => {
    const fixture = makeFixture();
    writeFileSync(fixture.registryPath, '{}\n');
    expect(() => loadPublishedPlatformManifests({ repoRoot: fixture.root, releasePath: fixture.releasePath }))
      .toThrow(/does not match the browser release pin/);
  });

  it('rejects unsafe release paths and duplicate FQBN entries', () => {
    const unsafe = makeFixture();
    writeRelease(unsafe.releasePath, '../registry.json', '0'.repeat(64));
    expect(() => loadPublishedPlatformManifests({ repoRoot: unsafe.root, releasePath: unsafe.releasePath }))
      .toThrow(/safe relative POSIX path/);

    const duplicate = makeFixture({ duplicate: true });
    expect(() => loadPublishedPlatformManifests({ repoRoot: duplicate.root, releasePath: duplicate.releasePath }))
      .toThrow(/duplicate Platform Manifest FQBN/);
  });
});

function makeFixture(options: { duplicate?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ck-platform-registry-'));
  roots.push(root);
  const publicationRoot = join(root, 'packages', 'web', 'public', 'esp32', 'v1');
  const releasePath = join(publicationRoot, 'release.js');
  const registryRoot = join(publicationRoot, 'platform-manifests');
  const registryPath = join(registryRoot, 'registry.json');
  const manifest = createPlatformManifest({
    id: 'espressif-arduino',
    version: '3.3.7',
    vendor: 'esp32',
    architecture: 'esp32',
    platformText: [
      'name=Arduino ESP32',
      'recipe.c.o.pattern=gcc -c {source_file} -o {object_file}',
      'recipe.cpp.o.pattern=g++ -c {source_file} -o {object_file}',
      'recipe.S.o.pattern=gcc -c {source_file} -o {object_file}',
      'recipe.ar.pattern=ar rcs {archive_file_path} {object_file}',
      'recipe.c.combine.pattern=g++ {object_files} {archive_file_path} -o {build.path}/{build.project_name}.elf',
    ].join('\n'),
    boardsText: [
      'esp32c3.name=ESP32-C3 Dev Module',
      'esp32c3.build.core=esp32',
      'esp32c3.build.variant=esp32c3',
    ].join('\n'),
  });
  const manifestPath = join(registryRoot, manifest.id, manifest.sha256, 'manifest.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const entry = {
    fqbn: 'esp32:esp32:esp32c3',
    id: manifest.id,
    version: manifest.version,
    sha256: manifest.sha256,
    path: `${manifest.id}/${manifest.sha256}/manifest.json`,
  };
  const registry = {
    kind: 'ck-platform-manifest-registry',
    schemaVersion: 1,
    entries: options.duplicate ? [entry, { ...entry }] : [entry],
  };
  const registryBytes = Buffer.from(`${JSON.stringify(registry)}\n`);
  mkdirSync(registryRoot, { recursive: true });
  writeFileSync(registryPath, registryBytes);
  writeRelease(releasePath, 'platform-manifests/registry.json', sha256(registryBytes));
  return { root, releasePath, registryPath };
}

function writeRelease(path: string, registryPath: string, registrySha256: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `export const release = Object.freeze({
  platforms: Object.freeze({
    path: '${registryPath}',
    sha256: '${registrySha256}',
  }),
});\n`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function expandResolvedProperty(properties: Readonly<Record<string, string>>, name: string): string {
  let value = properties[name] ?? '';
  for (let pass = 0; pass < 32; pass += 1) {
    const expanded = value.replace(/\{([^{}]+)\}/g, (placeholder, key: string) => (
      Object.prototype.hasOwnProperty.call(properties, key) ? properties[key]! : placeholder
    ));
    if (expanded === value) break;
    value = expanded;
  }
  return value.trim();
}
