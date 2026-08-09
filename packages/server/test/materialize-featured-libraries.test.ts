import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LibraryRegistry } from '@arduinofast/core';
import { materializeFeaturedLibraries } from '../src/materialize-featured-libraries.js';

const roots: string[] = [];
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(root: string): { registryPath: string; chunkPath: string } {
  const packDir = join(root, 'demo', '1.0.0');
  mkdirSync(join(packDir, 'chunks'), { recursive: true });
  const source = JSON.stringify({
    schema: 1,
    name: 'Demo Library',
    version: '1.0.0',
    architectures: ['*'],
    includeDirs: ['src'],
    files: [
      { path: 'src/Demo.h', content: '#pragma once\nint demo();\n' },
      { path: 'src/Demo.cpp', content: '#include "Demo.h"\nint demo() { return 1; }\n' },
    ],
  });
  const sourceHash = sha256(source);
  const chunkPath = join(packDir, 'chunks', 'sources.bin');
  writeFileSync(chunkPath, source);
  const revision = sha256('pack-revision');
  writeFileSync(join(packDir, 'toolchain.json'), JSON.stringify({
    schema: 1,
    id: 'arduino-lib-demo',
    version: '1.0.0',
    revision,
    artifacts: [{
      id: 'sources', kind: 'library-source-json', size: Buffer.byteLength(source), sha256: sourceHash,
      chunks: [{ path: 'chunks/sources.bin', size: Buffer.byteLength(source), sha256: sourceHash }],
    }],
  }));
  const registryPath = join(root, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({
    schema: 2,
    libraries: [{
      name: 'Demo Library', defaultVersion: '1.0.0',
      versions: [{
        version: '1.0.0', architectures: ['*'], publicHeaders: ['Demo.h'], depends: [],
        pack: {
          id: 'arduino-lib-demo', revision, manifest: 'demo/1.0.0/toolchain.json', artifact: 'sources',
        },
      }],
    }],
  }));
  return { registryPath, chunkPath };
}

describe('featured browser Pack materialization', () => {
  it('verifies content identities and emits a standard LibraryRegistry directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-featured-pack-'));
    roots.push(root);
    const { registryPath } = fixture(root);
    const outputDir = join(root, 'output');
    const result = materializeFeaturedLibraries({ registryPath, outputDir });
    expect(result.libraries).toEqual([expect.objectContaining({
      name: 'Demo Library', version: '1.0.0', packId: 'arduino-lib-demo', files: 2,
    })]);
    const registry = LibraryRegistry.fromDirectories([outputDir]);
    expect(registry.get('Demo Library')).toMatchObject({
      manifest: { version: '1.0.0', includes: ['Demo.h'] },
      headers: ['Demo.h'],
    });
    expect(JSON.parse(readFileSync(join(outputDir, 'materialization.json'), 'utf8')).registrySha256)
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a changed chunk before publishing any output directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-featured-pack-bad-'));
    roots.push(root);
    const { registryPath, chunkPath } = fixture(root);
    writeFileSync(chunkPath, 'tampered');
    const outputDir = join(root, 'output');
    expect(() => materializeFeaturedLibraries({ registryPath, outputDir })).toThrow(/digest mismatch/);
    expect(() => readFileSync(join(outputDir, 'materialization.json'))).toThrow();
  });

  it('rejects duplicate name and version entries that pin different Pack revisions', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-featured-pack-ambiguous-'));
    roots.push(root);
    const { registryPath } = fixture(root);
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      libraries: Array<{ versions: Array<Record<string, unknown>> }>;
    };
    const original = registry.libraries[0]!.versions[0]!;
    registry.libraries[0]!.versions.push({
      ...original,
      pack: {
        ...(original.pack as Record<string, unknown>),
        id: 'arduino-lib-demo-other',
        revision: 'b'.repeat(64),
      },
    });
    writeFileSync(registryPath, JSON.stringify(registry));
    const outputDir = join(root, 'output');

    expect(() => materializeFeaturedLibraries({ registryPath, outputDir }))
      .toThrow(/ambiguous featured Library Pack revision.*Demo Library@1\.0\.0/i);
    expect(() => readFileSync(join(outputDir, 'materialization.json'))).toThrow();
  });
});
