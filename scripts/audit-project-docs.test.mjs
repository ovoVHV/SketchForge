import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { auditProjectDocs } from './audit-project-docs.mjs';

test('checked-in project documentation matches executable contracts', async () => {
  const result = await auditProjectDocs();
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.deepEqual(result.facts, {
    maxFiles: 128,
    sourceBytes: 2 * 1024 * 1024,
    requestBytes: 8 * 1024 * 1024,
    runtimeVersion: 'v4',
    libraries: 145,
    versions: 147,
    registrySha256: '6394e23ac6e4d9b099316b1aeb3003f60b872525bb84ee35d01b9aa000afcea6',
  });
});

test('audit rejects stale documented request limits', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const result = await auditProjectDocs({
    overrides: {
      'README.md': readme.replaceAll('总计最多 128 个项目文件', '总计最多 127 个项目文件'),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.code === 'project-limit-drift'), true);
});

test('audit rejects stale completion claims in MIXLU', async () => {
  const progress = await readFile(new URL('../MIXLU.md', import.meta.url), 'utf8');
  const result = await auditProjectDocs({
    overrides: {
      'MIXLU.md': progress.replace(
        '| 5. 发布配置与遗留入口清理 | 已完成 | 100%',
        '| 5. 发布配置与遗留入口清理 | 进行中 | 45%',
      ),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => (
    item.code === 'stale-documentation' || item.code === 'progress-record-drift'
  )), true);
});

test('audit rejects a Registry release pin that does not match the bytes', async () => {
  const release = await readFile(new URL('../packages/web/public/esp32/v1/release.js', import.meta.url), 'utf8');
  const result = await auditProjectDocs({
    overrides: {
      'packages/web/public/esp32/v1/release.js': release.replace(
        '6394e23ac6e4d9b099316b1aeb3003f60b872525bb84ee35d01b9aa000afcea6',
        '0'.repeat(64),
      ),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.code === 'registry-release-pin-drift'), true);
});

test('audit rejects a Browser AVR release layout that drifts from the published runtime', async () => {
  const layout = await readFile(new URL('../packages/web/browser-toolchain/release-layout.json', import.meta.url), 'utf8');
  const result = await auditProjectDocs({
    overrides: {
      'packages/web/browser-toolchain/release-layout.json': layout.replace('"version": "v4"', '"version": "v3"'),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.code === 'avr-version-drift'), true);
});

test('audit rejects an unbounded production failed-job retention policy', async () => {
  const compose = await readFile(new URL('../docker/compose.distributed.yml', import.meta.url), 'utf8');
  const result = await auditProjectDocs({
    overrides: {
      'docker/compose.distributed.yml': compose.replace(
        '      AF_MAX_FAILED_JOBS_PER_POOL: "25"\n',
        '',
      ),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.code === 'failed-job-retention-drift'), true);
});

test('audit rejects a missing production project-storage byte ceiling', async () => {
  const compose = await readFile(new URL('../docker/compose.distributed.yml', import.meta.url), 'utf8');
  const result = await auditProjectDocs({
    overrides: {
      'docker/compose.distributed.yml': compose.replace(
        '      AF_PROJECT_GLOBAL_MAX_BYTES: "67108864"\n',
        '',
      ),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.some((item) => item.code === 'project-storage-quota-drift'), true);
});

test('audit rejects monolith commands restored as default server entry points', async () => {
  const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const serverPackage = JSON.parse(await readFile(new URL('../packages/server/package.json', import.meta.url), 'utf8'));

  const rootResult = await auditProjectDocs({
    overrides: {
      'package.json': JSON.stringify({
        ...rootPackage,
        scripts: { ...rootPackage.scripts, dev: 'npm run dev:monolith --workspace @sketchforge/server' },
      }),
    },
  });
  const workspaceResult = await auditProjectDocs({
    overrides: {
      'packages/server/package.json': JSON.stringify({
        ...serverPackage,
        scripts: { ...serverPackage.scripts, start: 'node dist/index.js' },
      }),
    },
  });

  for (const result of [rootResult, workspaceResult]) {
    assert.equal(result.ok, false);
    assert.equal(result.findings.some((item) => item.code === 'default-server-entrypoint-drift'), true);
  }
});
