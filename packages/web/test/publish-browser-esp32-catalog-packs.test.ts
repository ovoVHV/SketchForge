import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  installCatalogPackRevision,
  parseCatalogPublishArgs,
  updateReleaseLibraryPin,
} from '../../../scripts/publish-browser-esp32-catalog-packs.mjs';

describe('ESP32 browser catalog publisher', () => {
  it('parses explicit publication paths and requires replace opt-in', () => {
    const options = parseCatalogPublishArgs([
      '--staging', 'var/catalog-fixture',
      '--output', 'packages/web/public/esp32/v1/catalog-fixture',
      '--release', 'packages/web/public/esp32/v1/release-fixture.js',
      '--evidence', 'var/reports/catalog-evidence.json',
      '--replace',
    ]);
    expect(options).toMatchObject({ replace: true });
    expect(options.staging.replaceAll('\\', '/')).toMatch(/\/var\/catalog-fixture$/);
    expect(options.output.replaceAll('\\', '/')).toMatch(/\/esp32\/v1\/catalog-fixture$/);
    expect(options.evidence.replaceAll('\\', '/')).toMatch(/\/var\/reports\/catalog-evidence\.json$/);
  });

  it('updates only the executable library path and integrity pin', () => {
    const source = `export const release = {
  capabilities: { path: 'capabilities.json', sha256: '${'a'.repeat(64)}' },
  libraries: Object.freeze({
    path: 'libraries/registry.json',
    // catalog pin
    sha256: '${'b'.repeat(64)}',
  }),
};\n`;
    const updated = updateReleaseLibraryPin(
      source,
      'libraries-catalog/registry.json',
      'c'.repeat(64),
    );
    expect(updated).toContain("path: 'libraries-catalog/registry.json'");
    expect(updated).toContain(`sha256: '${'c'.repeat(64)}'`);
    expect(updated).toContain(`sha256: '${'a'.repeat(64)}'`);
    expect(updateReleaseLibraryPin(
      updated,
      'libraries-catalog/registry.json',
      'c'.repeat(64),
    )).toBe(updated);
  });

  it('rejects immutable revision conflicts and retains older revisions', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-catalog-publish-'));
    const staging = join(root, 'staging');
    const output = join(root, 'published');
    const firstRevision = 'a'.repeat(64);
    const secondRevision = 'b'.repeat(64);
    const writeRevision = (revision: string, content: string) => {
      const directory = join(staging, 'fixture', '1.0.0', revision);
      mkdirSync(join(directory, 'chunks'), { recursive: true });
      writeFileSync(join(directory, 'toolchain.json'), JSON.stringify({ revision }));
      writeFileSync(join(directory, 'chunks', 'sources.bin'), content);
      return `fixture/1.0.0/${revision}/toolchain.json`;
    };

    try {
      const firstManifest = writeRevision(firstRevision, 'first revision');
      expect(installCatalogPackRevision(staging, output, firstManifest, firstRevision)).toBe(true);
      expect(readFileSync(join(output, 'fixture', '1.0.0', firstRevision, 'chunks', 'sources.bin'), 'utf8'))
        .toBe('first revision');

      writeRevision(firstRevision, 'mutated bytes');
      expect(() => installCatalogPackRevision(staging, output, firstManifest, firstRevision))
        .toThrow(/immutable catalog Pack conflict/);
      expect(readFileSync(join(output, 'fixture', '1.0.0', firstRevision, 'chunks', 'sources.bin'), 'utf8'))
        .toBe('first revision');

      const secondManifest = writeRevision(secondRevision, 'second revision');
      expect(installCatalogPackRevision(staging, output, secondManifest, secondRevision)).toBe(true);
      expect(readFileSync(join(output, 'fixture', '1.0.0', firstRevision, 'chunks', 'sources.bin'), 'utf8'))
        .toBe('first revision');
      expect(readFileSync(join(output, 'fixture', '1.0.0', secondRevision, 'chunks', 'sources.bin'), 'utf8'))
        .toBe('second revision');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
