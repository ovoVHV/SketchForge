import { describe, expect, it } from 'vitest';
import {
  ProjectFileError,
  addProjectFile,
  createProjectSnapshot,
  mergeProjectSnapshots,
  normalizeProjectPath,
  projectSnapshotKey,
  readProjectSnapshot,
  renameProjectFile,
} from '../public/project-files.js';

describe('browser project file snapshots', () => {
  it('normalizes and deterministically sorts multi-file projects', () => {
    const snapshot = createProjectSnapshot([
      { name: 'src\\helper.CPP', content: 'int helper();\n' },
      { name: 'main.ino', content: '#include "src/helper.h"\n' },
      { name: 'src/helper.h', content: '#pragma once\n' },
    ]);
    expect(snapshot.files.map((file) => file.name)).toEqual(['main.ino', 'src/helper.CPP', 'src/helper.h']);
    expect(snapshot.sketch).toBe('main.ino');
    expect(snapshot.sketches).toEqual(['main.ino']);
    expect(projectSnapshotKey(snapshot)).toContain('src/helper.CPP');
  });

  it('allows Arduino tabs and selects a stable main sketch', () => {
    const preferred = createProjectSnapshot([
      { name: 'Zulu.ino', content: 'void loop() {}\n' },
      { name: 'main.ino', content: 'void setup() {}\n' },
      { name: 'Alpha.ino', content: 'int alpha() { return 1; }\n' },
    ]);
    expect(preferred.sketch).toBe('main.ino');
    expect(preferred.sketches).toEqual(['Alpha.ino', 'Zulu.ino', 'main.ino']);

    const lexical = createProjectSnapshot([
      { name: 'Zulu.ino', content: 'void loop() {}\n' },
      { name: 'Alpha.ino', content: 'void setup() {}\n' },
    ]);
    expect(lexical.sketch).toBe('Alpha.ino');
  });

  it('strips the directory picker root and reads File-like entries', async () => {
    const snapshot = await readProjectSnapshot([
      { name: 'main.ino', webkitRelativePath: 'Blink/main.ino', async text() { return 'void setup() {}\n'; } },
      { name: 'helper.cpp', webkitRelativePath: 'Blink/lib/helper.cpp', async text() { return 'int helper() { return 1; }\n'; } },
      { name: 'README.md', webkitRelativePath: 'Blink/README.md', async text() { return 'docs\n'; } },
    ]);
    expect(snapshot.files.map((file) => file.name)).toEqual(['lib/helper.cpp', 'main.ino']);
  });

  it('keeps local Arduino library manifests and include fragments during folder import', async () => {
    const snapshot = await readProjectSnapshot([
      { name: 'main.ino', webkitRelativePath: 'Demo/main.ino', async text() { return 'void setup() {}\n'; } },
      { name: 'library.properties', webkitRelativePath: 'Demo/libraries/Widget/library.properties', async text() { return 'name=Widget\nversion=1.0.0\narchitectures=*\n'; } },
      { name: 'Widget.cpp', webkitRelativePath: 'Demo/libraries/Widget/src/Widget.cpp', async text() { return 'int widget() { return 1; }\n'; } },
      { name: 'Widget.h', webkitRelativePath: 'Demo/libraries/Widget/src/Widget.h', async text() { return '#pragma once\n'; } },
      { name: 'detail.inc', webkitRelativePath: 'Demo/libraries/Widget/src/detail.inc', async text() { return '#define WIDGET_VALUE 1\n'; } },
      { name: 'README.md', webkitRelativePath: 'Demo/README.md', async text() { return 'docs\n'; } },
    ]);
    expect(snapshot.files.map((file) => file.name)).toEqual([
      'libraries/Widget/library.properties',
      'libraries/Widget/src/Widget.cpp',
      'libraries/Widget/src/Widget.h',
      'libraries/Widget/src/detail.inc',
      'main.ino',
    ]);
  });

  it('accepts only the exact root partitions.csv project file', () => {
    const main = { name: 'main.ino', content: 'void setup() {}\n' };
    const partitions = {
      name: 'partitions.csv',
      content: 'nvs,data,nvs,0x9000,0x5000,\n',
    };
    const snapshot = createProjectSnapshot([main, partitions]);

    expect(snapshot.files).toContainEqual(partitions);

    for (const name of [
      'config/partitions.csv',
      'PARTITIONS.CSV',
      'partitions.txt',
      'partition.csv',
    ]) {
      expect(() => createProjectSnapshot([
        main,
        { ...partitions, name },
      ])).toThrow(/unsupported project file extension/);
    }
  });

  it('rejects traversal, unsupported files, duplicate headers, and missing sketch', () => {
    expect(() => normalizeProjectPath('../main.ino')).toThrow(ProjectFileError);
    expect(() => normalizeProjectPath('main.txt')).toThrow(/unsupported/);
    expect(() => createProjectSnapshot([
      { name: 'main.ino', content: '' },
      { name: 'a/foo.h', content: '' },
      { name: 'b/foo.h', content: '' },
    ])).toThrow(/duplicate header/);
    expect(() => createProjectSnapshot([{ name: 'helper.cpp', content: '' }])).toThrow(/at least one/);
  });

  it('allows adding source files without a sketch before merging', () => {
    const snapshot = createProjectSnapshot([{ name: 'helper.cpp', content: 'int helper();\n' }], { requireSketch: false });
    expect(snapshot.sketch).toBeNull();
    expect(snapshot.sketches).toEqual([]);
  });

  it('adds and renames files without losing their content', () => {
    const initial = createProjectSnapshot([
      { name: 'main.ino', content: 'void setup() {}\n' },
      { name: 'helper.cpp', content: 'int helper = 1;\n' },
    ]);
    const added = addProjectFile(initial, 'include/config.h');
    expect(added.files.find((file) => file.name === 'include/config.h')?.content).toBe('');

    const renamed = renameProjectFile(added, 'helper.cpp', 'src/helper.cpp');
    expect(renamed.files.find((file) => file.name === 'src/helper.cpp')?.content)
      .toBe('int helper = 1;\n');
    expect(renamed.files.some((file) => file.name === 'helper.cpp')).toBe(false);
  });

  it('rejects add, merge, and rename collisions instead of overwriting files', () => {
    const initial = createProjectSnapshot([
      { name: 'main.ino', content: 'original\n' },
      { name: 'helper.cpp', content: 'helper\n' },
    ]);
    const imported = createProjectSnapshot([
      { name: 'MAIN.ino', content: 'replacement\n' },
    ], { requireSketch: false });

    expect(() => mergeProjectSnapshots(initial, imported)).toThrow(/already contains/i);
    expect(() => addProjectFile(initial, 'HELPER.cpp')).toThrow(/already contains/i);
    expect(() => renameProjectFile(initial, 'helper.cpp', 'main.ino')).toThrow(/already contains/i);
    expect(initial.files.find((file) => file.name === 'main.ino')?.content).toBe('original\n');
  });
});
