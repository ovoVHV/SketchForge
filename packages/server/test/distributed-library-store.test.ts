import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibraryStore } from '@sketchforge/core';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const temporaryRoots: string[] = [];

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8').replaceAll('\r\n', '\n');
}

function yamlBlock(source: string, header: string): string {
  const lines = source.split('\n');
  const start = lines.indexOf(header);
  if (start < 0) throw new Error(`missing YAML block: ${header}`);
  const indentation = header.length - header.trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim()) {
      const currentIndentation = line.length - line.trimStart().length;
      if (currentIndentation <= indentation) break;
    }
    end++;
  }
  return lines.slice(start, end).join('\n');
}

function expectLibraryVolume(block: string, readOnly: boolean): void {
  expect(block).toMatch(new RegExp([
    '- type: volume',
    'source: libraries',
    'target: /var/aflibraries',
    `read_only: ${readOnly}`,
  ].join('\\s+')));
}

function seedLibrary(store: LibraryStore, repo: string, commit: string): void {
  const root = store.pathFor('shared', repo, commit);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'library.properties'), `name=${repo}\nversion=1.0.0\n`);
  writeFileSync(join(root, 'src', `${repo}.h`), `// ${commit}\n`);
  store.add({
    name: repo,
    version: '1.0.0',
    owner: 'shared',
    repo,
    commit,
    dir: LibraryStore.dirNameFor('shared', repo, commit),
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('distributed LibraryStore deployment contract', () => {
  it('mounts one named volume read-write in gateway and read-only in every worker', () => {
    const compose = readRepoFile('docker/compose.distributed.yml');
    const commonEnvironment = yamlBlock(compose, 'x-common-env: &common-env');
    const workerDefaults = yamlBlock(compose, 'x-worker: &worker');
    const gateway = yamlBlock(compose, '  gateway:');
    const volumes = yamlBlock(compose, 'volumes:');

    expect(commonEnvironment).toContain('AF_LIBRARY_STORE_DIR: /var/aflibraries');
    expect(workerDefaults).toContain('read_only: true');
    expectLibraryVolume(workerDefaults, true);

    expect(gateway).toContain('read_only: true');
    expect(gateway).toContain('AF_LIBRARY_IMPORT_WORK_DIR: /var/aflibrary-imports');
    expect(gateway).toContain('/var/aflibrary-imports:rw,nosuid,nodev,noexec,size=128m');
    expectLibraryVolume(gateway, false);
    expect(volumes).toMatch(/^  libraries:\s*$/m);

    for (const service of ['worker-avr', 'worker-esp32-xtensa', 'worker-esp32-riscv']) {
      expectLibraryVolume(yamlBlock(compose, `  ${service}:`), true);
    }
  });

  it('prepares the shared mountpoint with the runtime uid in every image', () => {
    for (const dockerfile of [
      'docker/Dockerfile.gateway',
      'docker/Dockerfile.worker-avr',
      'docker/Dockerfile.worker-esp32',
    ]) {
      const source = readRepoFile(dockerfile);
      expect(source).toContain('AF_LIBRARY_STORE_DIR=/var/aflibraries');
      expect(source).toMatch(
        /install -d -o sketchforge -g sketchforge -m 0750[\s\S]{1,200}\/var\/aflibraries/,
      );
      expect(source).toContain('USER 10001:10001');
    }
  });

  it('fails closed when the production wrapper is asked for a multi-host topology', () => {
    const productionCompose = readRepoFile('docker/compose.distributed.production.yml');
    const deploy = readRepoFile('docker/deploy-distributed.sh');

    expect(productionCompose).toContain('This override is intentionally single-host.');
    expect(deploy).toContain(
      'DEPLOYMENT_TOPOLOGY="${AF_DISTRIBUTED_TOPOLOGY:-single-host}"',
    );
    expect(deploy).toMatch(
      /case "\$DEPLOYMENT_TOPOLOGY" in\s+single-host\) ;;\s+\*\)/,
    );
    expect(deploy).toContain('multi-host deployment requires a shared filesystem or object-store');
    expect(deploy).toContain('const libraryServiceNames = [');
    expect(deploy).toContain('libraryMounts.slice(1).every((mount) => mount?.read_only === true)');
    expect(deploy).toContain('rendered shared LibraryStore contract failed');
    expect(deploy.indexOf('case "$DEPLOYMENT_TOPOLOGY" in'))
      .toBeLessThan(deploy.indexOf('command -v docker'));
  });

  it('makes a gateway import visible after worker reload without rewriting the index', () => {
    const root = mkdtempSync(join(tmpdir(), 'sketchforge-shared-library-store-'));
    temporaryRoots.push(root);
    const workerReader = new LibraryStore(root);
    const gatewayWriter = new LibraryStore(root);

    seedLibrary(gatewayWriter, 'FirstLibrary', 'a'.repeat(40));
    expect(workerReader.list()).toEqual([]);

    const indexPath = join(root, 'index.json');
    const importedIndex = readFileSync(indexPath, 'utf8');
    workerReader.reload();
    expect(workerReader.list().map((entry) => entry.name)).toEqual(['FirstLibrary']);
    expect(readFileSync(indexPath, 'utf8')).toBe(importedIndex);

    seedLibrary(gatewayWriter, 'SecondLibrary', 'b'.repeat(40));
    expect(workerReader.list().map((entry) => entry.name)).toEqual(['FirstLibrary']);
    workerReader.reload();
    expect(workerReader.list().map((entry) => entry.name).sort()).toEqual([
      'FirstLibrary',
      'SecondLibrary',
    ]);

    const workerSource = readRepoFile('packages/server/src/worker.ts');
    expect(workerSource).toContain(
      'await lifetime.run(() => service.setLibraries(loadLibraries()));',
    );
    expect(workerSource).not.toMatch(/libraryStore\.(?:add|remove|setCuration|touch)\(/);
    expect(workerSource.indexOf('libraryStore.reload();'))
      .toBeLessThan(workerSource.indexOf('libraryStore.libraryDirs()'));
  });
});
