import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  createCurrentOnlyBoardPackManifest,
  createCurrentOnlySdkPackManifest,
} from '../../../scripts/migrate-browser-pack-trees.mjs';
import {
  browserToolchainPackRevisionInput,
  validateBrowserToolchainPackManifest,
} from '../public/avr/v3/toolchain-pack.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function artifact(id: string) {
  const digest = sha256(id);
  const value = {
    id,
    kind: id === 'compile-000'
      ? 'tree'
      : id.startsWith('profile') || id === 'platform-manifest' ? 'json' : 'bin',
    size: id.length,
    sha256: digest,
    chunks: [{ sha256: digest, path: `chunks/${id}.bin`, size: id.length }],
  };
  return id === 'compile-000' ? {
    ...value,
    files: [{ sha256: digest, length: id.length, path: 'runtime/include/c++/algorithm', offset: 0 }],
  } : value;
}

function manifest(ids = [
  'boot-app0', 'bootloader', 'partitions', 'profile', 'variant-000', 'profile-v4',
], id = 'arduino-esp32c3-board') {
  const base = {
    schema: 2,
    id,
    version: '3.3.7',
    artifacts: ids.map(artifact),
  };
  return { ...base, revision: sha256(JSON.stringify(base)) };
}

describe('current-only Board Pack publication', () => {
  it('removes the legacy profile, preserves payload metadata, and sorts artifact ids', () => {
    const source = manifest();
    const current = createCurrentOnlyBoardPackManifest(source);

    expect(source.artifacts.map(({ id }) => id)).toContain('profile');
    expect(current.artifacts.map(({ id }) => id)).toEqual([
      'boot-app0', 'bootloader', 'partitions', 'profile-v4', 'variant-000',
    ]);
    expect(current.artifacts.find(({ id }) => id === 'variant-000'))
      .toEqual(source.artifacts.find(({ id }) => id === 'variant-000'));
    expect(current.revision).toBe(sha256(JSON.stringify({
      schema: current.schema,
      id: current.id,
      version: current.version,
      artifacts: current.artifacts,
    })));
    expect(createCurrentOnlyBoardPackManifest(current)).toEqual(current);
  });

  it('rejects an invalid source revision or a Board Pack without profile-v4', () => {
    expect(() => createCurrentOnlyBoardPackManifest({
      ...manifest(),
      revision: '0'.repeat(64),
    })).toThrow(/revision is invalid/);
    expect(() => createCurrentOnlyBoardPackManifest(manifest(['bootloader', 'profile'])))
      .toThrow(/profile-v4 artifact is missing/);
  });
});

describe('current-only SDK Pack publication', () => {
  const sdkManifest = (ids = [
    'compile-000', 'link-000', 'profile', 'platform-manifest', 'profile-v5',
    'compile-asm-flags',
  ]) => manifest(ids, 'arduino-esp32c3-sdk');

  it('removes only the legacy profile and preserves every current/runtime artifact', () => {
    const source = sdkManifest();
    const current = createCurrentOnlySdkPackManifest(source);

    expect(current.artifacts.map(({ id }) => id)).toEqual([
      'compile-000', 'compile-asm-flags', 'link-000', 'platform-manifest', 'profile-v5',
    ]);
    for (const id of ['compile-000', 'compile-asm-flags', 'link-000', 'platform-manifest', 'profile-v5']) {
      expect(current.artifacts.find((artifact) => artifact.id === id))
        .toEqual(source.artifacts.find((artifact) => artifact.id === id));
    }
    const compile = current.artifacts.find(({ id }) => id === 'compile-000')!;
    expect(Object.keys(compile)).toEqual(['id', 'kind', 'size', 'sha256', 'files', 'chunks']);
    expect(Object.keys(compile.files![0])).toEqual(['path', 'offset', 'length', 'sha256']);
    expect(Object.keys(compile.chunks[0])).toEqual(['path', 'size', 'sha256']);
    const validated = validateBrowserToolchainPackManifest(current);
    expect(current.revision).toBe(sha256(browserToolchainPackRevisionInput(validated)));
    expect(createCurrentOnlySdkPackManifest(current)).toEqual(current);
  });

  it('rejects an invalid source revision or incomplete current SDK profile set', () => {
    expect(() => createCurrentOnlySdkPackManifest({
      ...sdkManifest(),
      revision: '0'.repeat(64),
    })).toThrow(/revision is invalid/);
    expect(() => createCurrentOnlySdkPackManifest(sdkManifest([
      'compile-000', 'profile', 'profile-v5',
    ]))).toThrow(/platform-manifest artifact is missing/);
    expect(() => createCurrentOnlySdkPackManifest(sdkManifest([
      'compile-000', 'profile', 'platform-manifest',
    ]))).toThrow(/profile-v5 artifact is missing/);
  });
});
