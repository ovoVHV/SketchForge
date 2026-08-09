import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseFeaturedPrebuildSpec, planFeaturedPrebuildMatrix } from '../src/featured-prebuild.js';
import { BoardRegistry } from '../src/toolchain/board.js';
import { LibraryRegistry } from '../src/toolchain/library.js';
import { materializeFeaturedLibraries } from '../../server/src/materialize-featured-libraries.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function avrPlatformLibrary(root: string, name: string, header: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'library.properties'), [
    `name=${name}`, 'version=1.0.0', 'architectures=avr', `includes=${header}`,
  ].join('\n'));
  writeFileSync(join(dir, header), '#pragma once\n');
}

describe('featured library combination prebuild plan', () => {
  it('expands only explicit templates through the existing dependency registry', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-featured-plan-'));
    roots.push(root);
    const featured = join(root, 'featured');
    materializeFeaturedLibraries({
      registryPath: join(process.cwd(), 'packages', 'web', 'public', 'esp32', 'v1', 'libraries', 'registry.json'),
      outputDir: featured,
    });
    const avr = join(root, 'avr');
    avrPlatformLibrary(avr, 'Wire', 'Wire.h');
    avrPlatformLibrary(avr, 'SPI', 'SPI.h');
    const libraries = LibraryRegistry.fromDirectories([avr, featured]);
    const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards')).list();
    const spec = parseFeaturedPrebuildSpec(JSON.parse(readFileSync(
      join(process.cwd(), 'prebuild', 'featured-library-combinations.json'), 'utf8',
    )) as unknown);
    const first = planFeaturedPrebuildMatrix(spec, boards, libraries, 'bundle-v1');
    const second = planFeaturedPrebuildMatrix(spec, [...boards].reverse(), libraries, 'bundle-v1');
    expect(second).toEqual(first);
    expect(first).toHaveLength(33);
    expect(new Set(first.map((entry) => entry.identity)).size).toBe(first.length);
    const oledUno = first.find((entry) => entry.combinationId === 'oled-ssd1306' && entry.fqbn === 'arduino:avr:uno')!;
    expect(oledUno.resolvedLibraries.map((library) => library.name)).toEqual(expect.arrayContaining([
      'Adafruit BusIO', 'Adafruit GFX Library', 'Adafruit SSD1306', 'SPI', 'Wire',
    ]));
    expect(oledUno.source).toContain('#include <Adafruit_SSD1306.h>');
    expect(oledUno.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.filter((entry) => entry.combinationId === 'fastled').every((entry) => entry.fqbn.startsWith('esp32:')))
      .toBe(true);
  });

  it('rejects an undeclared header instead of silently generating a broken template', () => {
    const spec = parseFeaturedPrebuildSpec({
      schema: 1,
      kind: 'ck-featured-library-combinations',
      combinations: [{
        id: 'demo', name: 'Demo', libraries: [{ name: 'Demo', version: '1.0.0' }],
        headers: ['Missing.h'], targets: [{ fqbn: 'arduino:avr:uno' }],
      }],
    });
    const root = mkdtempSync(join(tmpdir(), 'ck-featured-plan-bad-'));
    roots.push(root);
    avrPlatformLibrary(root, 'Demo', 'Demo.h');
    const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards')).list();
    expect(() => planFeaturedPrebuildMatrix(spec, boards, LibraryRegistry.fromDirectories([root]), 'bundle-v1'))
      .toThrow(/header Missing.h is absent/);
  });
});
