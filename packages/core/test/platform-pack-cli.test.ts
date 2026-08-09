import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { collectPlatformSourceFiles } from '../../../scripts/build-ck-platform-pack.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const TSX = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SCRIPT = join(REPO_ROOT, 'scripts', 'build-ck-platform-pack.ts');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; platform: string; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'ck-platform-pack-cli-'));
  roots.push(root);
  const platform = join(root, 'platform');
  const output = join(root, 'manifest.json');
  mkdirSync(join(platform, 'cores', 'demo'), { recursive: true });
  mkdirSync(join(platform, 'cores', 'other'), { recursive: true });
  mkdirSync(join(platform, 'variants', 'demo'), { recursive: true });
  mkdirSync(join(platform, 'variants', 'other'), { recursive: true });
  mkdirSync(join(platform, 'libraries', 'Bundled'), { recursive: true });
  mkdirSync(join(platform, 'tools', 'partitions'), { recursive: true });
  mkdirSync(join(platform, 'tools'), { recursive: true });
    writeFileSync(join(platform, 'platform.txt'), [
      'name=Demo',
      'compiler.path={runtime.tools.demo-compiler.path}/bin/',
      'recipe.c.o.pattern=gcc -c {source_file} -o {object_file}',
      'recipe.cpp.o.pattern=g++ -c {source_file} -o {object_file}',
      'recipe.S.o.pattern=gcc -c {source_file} -o {object_file}',
      'recipe.ar.pattern=ar rcs {archive_file_path} {object_file}',
      'recipe.c.combine.pattern=g++ {object_files} {archive_file_path} -o {build.path}/{build.project_name}.elf',
    ].join('\n'));
  writeFileSync(join(platform, 'boards.txt'), [
    'demo.name=Demo Board',
    'demo.build.core=demo',
    'demo.build.variant=demo',
    'other.name=Other Board',
    'other.build.core=other',
    'other.build.variant=other',
  ].join('\n'));
  writeFileSync(join(platform, 'programmers.txt'), 'serial.name=Serial\n');
  writeFileSync(join(platform, 'cores', 'demo', 'Arduino.h'), '#pragma once\n');
  writeFileSync(join(platform, 'cores', 'other', 'Arduino.h'), '#pragma once\n');
  writeFileSync(join(platform, 'variants', 'demo', 'pins.h'), '#pragma once\n');
  writeFileSync(join(platform, 'variants', 'other', 'pins.h'), '#pragma once\n');
  writeFileSync(join(platform, 'libraries', 'Bundled', 'Bundled.cpp'), 'int bundled;\n');
  writeFileSync(join(platform, 'tools', 'metadata.json'), JSON.stringify({
    schema: 1,
    tools: [{ id: 'demo-compiler', version: '1.0.0', sha256: 'a'.repeat(64) }],
  }));
  writeFileSync(join(platform, 'tools', 'compiler.exe'), 'not-a-platform-metadata-file');
  writeFileSync(join(platform, 'tools', 'partitions', 'default.csv'), 'nvs,data,nvs,0x9000,0x5000\n');
  return { root, platform, output };
}

function baseArgs(platform: string, output: string): string[] {
  return [
    TSX,
    SCRIPT,
    '--platform-dir', platform,
    '--id', 'demo-platform',
    '--version', '1.0.0',
    '--vendor', 'demo',
    '--architecture', 'avr',
    '--output', output,
  ];
}

describe('build-ck-platform-pack CLI', () => {
  it('keeps the complete shared Platform sources while excluding libraries and tool binaries', () => {
    const { platform, output } = fixture();
    expect(collectPlatformSourceFiles(platform).map((file) => file.path)).toEqual([
      'boards.txt',
      'cores/demo/Arduino.h',
      'cores/other/Arduino.h',
      'platform.txt',
      'programmers.txt',
      'tools/metadata.json',
      'tools/partitions/default.csv',
      'variants/demo/pins.h',
      'variants/other/pins.h',
    ]);
    const result = spawnSync(process.execPath, baseArgs(platform, output), {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);

    const manifest = JSON.parse(readFileSync(output, 'utf8')) as {
      schemaVersion: number;
      files: Array<{ path: string }>;
      tools: Array<{ id: string; version: string; sha256: string }>;
      boards: Array<{ fqbn: string }>;
      recipeLowering: { schemaVersion: number };
    };
    const paths = manifest.files.map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining([
      'platform.txt',
      'boards.txt',
      'programmers.txt',
      'cores/demo/Arduino.h',
      'cores/other/Arduino.h',
      'variants/demo/pins.h',
      'variants/other/pins.h',
      'tools/metadata.json',
      'tools/partitions/default.csv',
    ]));
    expect(paths.some((path) => path.startsWith('libraries/'))).toBe(false);
    expect(paths).not.toContain('tools/compiler.exe');
    expect(manifest.tools).toEqual([{
      id: 'demo-compiler', version: '1.0.0', sha256: 'a'.repeat(64),
    }]);
    expect(manifest.boards.map((board) => board.fqbn)).toEqual([
      'demo:avr:demo', 'demo:avr:other',
    ]);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.recipeLowering.schemaVersion).toBe(2);
  }, 20_000);

  it('requires an integrity hash for every declared tool', () => {
    const { platform, output } = fixture();
    const result = spawnSync(process.execPath, [
      ...baseArgs(platform, output),
      '--tool', 'demo-compiler@1.0.0',
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--tool requires id@version#sha256/);
  }, 20_000);

  it('can emit a shared source Manifest with deferred target Compiler binding', () => {
    const { platform, output } = fixture();
    const result = spawnSync(process.execPath, [
      ...baseArgs(platform, output),
      '--defer-ck-tool-binding',
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(output, 'utf8')) as { tools: unknown[]; boards: unknown[] };
    expect(manifest.tools).toEqual([]);
    expect(manifest.boards).toHaveLength(2);
  }, 20_000);
});
