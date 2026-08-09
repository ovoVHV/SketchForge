import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readLockedSourceTreeFiles,
  validateBrowserEsp32LibraryPublicHeaders,
} from '../../../scripts/build-browser-esp32-libraries.mjs';

const temporaryDirectories: string[] = [];

function treeDigest(files: Array<{ path: string; content: string }>) {
  const hash = createHash('sha256');
  for (const file of files.sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ))) {
    hash.update(file.path).update('\0').update(file.content).update('\0');
  }
  return hash.digest('hex');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'arduinofast-library-tree-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(join(root, 'src', 'Alpha.cpp'), 'int alpha = 1;\n');
  await writeFile(join(root, 'src', 'nested', 'Beta.h'), '#pragma once\n');
  await writeFile(join(root, 'src', 'ignored.txt'), 'ignored\n');
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('browser ESP32 library source tree locks', () => {
  it('collects only supported source files with deterministic published paths', async () => {
    const root = await fixture();
    const files = readLockedSourceTreeFiles(root, {
      name: 'Fixture',
      sourceTrees: [{
        path: 'src',
        output: 'published',
        recursive: true,
        sha256: treeDigest([
          { path: 'Alpha.cpp', content: 'int alpha = 1;\n' },
          { path: 'nested/Beta.h', content: '#pragma once\n' },
        ]),
      }],
    });

    expect(files.map(({ path, output }) => ({ path, output }))).toEqual([
      { path: 'src/Alpha.cpp', output: 'published/Alpha.cpp' },
      { path: 'src/nested/Beta.h', output: 'published/nested/Beta.h' },
    ]);
  });

  it('fails closed when a source tree changes or escapes its root', async () => {
    const root = await fixture();
    const definition = {
      name: 'Fixture',
      sourceTrees: [{
        path: 'src',
        output: 'published',
        recursive: false,
        sha256: treeDigest([{ path: 'Alpha.cpp', content: 'int alpha = 1;\n' }]),
      }],
    };
    expect(readLockedSourceTreeFiles(root, definition)).toHaveLength(1);

    await writeFile(join(root, 'src', 'Added.h'), '#pragma once\n');
    expect(() => readLockedSourceTreeFiles(root, definition)).toThrow(/source tree changed/);
    expect(() => readLockedSourceTreeFiles(root, {
      name: 'Fixture',
      sourceTrees: [{ ...definition.sourceTrees[0], path: '../outside' }],
    })).toThrow(/source tree path|escapes/);
  });

  it('validates deterministic public include paths against packaged files', () => {
    const files = [
      { output: 'src/Alpha.h' },
      { output: 'src/nested/Beta.hpp' },
      { output: 'src/private.cpp' },
    ];
    expect(validateBrowserEsp32LibraryPublicHeaders({
      name: 'Fixture',
      includeDirs: ['src'],
      publicHeaders: ['Alpha.h', 'nested/Beta.hpp'],
    }, files)).toEqual(['Alpha.h', 'nested/Beta.hpp']);
    expect(() => validateBrowserEsp32LibraryPublicHeaders({
      name: 'Fixture',
      includeDirs: ['src'],
      publicHeaders: ['Beta.hpp'],
    }, files)).toThrow(/not in an include directory/);
    expect(() => validateBrowserEsp32LibraryPublicHeaders({
      name: 'Fixture',
      includeDirs: ['src'],
      publicHeaders: ['nested/Beta.hpp', 'Alpha.h'],
    }, files)).toThrow(/sorted and unique/);
  });
});
