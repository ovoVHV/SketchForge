import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { ESP32_BROWSER_RELEASE } from '../packages/web/public/esp32/v1/release.js';
import { auditCkActiveRelease } from './audit-ck-active-release.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('active release closure accepts the checked-in five-board release', async () => {
  const report = await auditCkActiveRelease({ root: ROOT });

  assert.equal(report.state, 'closed');
  assert.deepEqual(report.counts, {
    runtimes: 2,
    descriptors: 5,
    releaseReports: 3,
    compilerPacks: 2,
    compilerArtifacts: 10,
    compilerChunks: 10,
    compilerDownloadBytes: 50_628_165,
  });
  assert.deepEqual(report.issues, []);
});

test('active release closure rejects a capabilities pin drift', async () => {
  const release = clone(ESP32_BROWSER_RELEASE);
  release.capabilities.sha256 = '0'.repeat(64);

  const report = await auditCkActiveRelease({ root: ROOT, releaseMetadata: release });

  assert.equal(report.state, 'invalid');
  assertIssue(report, 'capabilities', 'SHA-256');
});

test('active release closure rejects a descriptor pin drift', async () => {
  const release = clone(ESP32_BROWSER_RELEASE);
  release.runtimes['esp32-xtensa'].descriptors['esp32:esp32:esp32'].sha256 = '0'.repeat(64);

  const report = await auditCkActiveRelease({ root: ROOT, releaseMetadata: release });

  assert.equal(report.state, 'invalid');
  assertIssue(report, 'descriptor:esp32:esp32:esp32', 'descriptor SHA-256');
});

test('active release closure rejects a release report drift', async () => {
  const report = await auditCkActiveRelease({
    root: ROOT,
    readFile(path) {
      const bytes = readFileSync(path);
      if (!path.replaceAll('\\', '/').endsWith('/esp32/v2/runtime/release-report.json')) return bytes;
      const value = JSON.parse(bytes.toString('utf8'));
      value.packs.compiler.downloadBytes += 1;
      return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    },
  });

  assert.equal(report.state, 'invalid');
  assertIssue(report, 'release-report:esp32:esp32:esp32c3', 'release-report binding');
});

test('active release closure rejects a compiler transport chunk drift', async () => {
  let changed = false;
  const report = await auditCkActiveRelease({
    root: ROOT,
    readFile(path) {
      const bytes = readFileSync(path);
      const normalized = path.replaceAll('\\', '/');
      if (!changed && normalized.includes('/toolchains/') && normalized.includes('/chunks/')) {
        changed = true;
        const copy = Buffer.from(bytes);
        copy[0] ^= 0xff;
        return copy;
      }
      return bytes;
    },
  });

  assert.equal(report.state, 'invalid');
  assert.equal(changed, true);
  assertIssue(report, 'compiler-pack:', 'transport chunk integrity');
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertIssue(report, scopePrefix, messagePart) {
  assert.equal(
    report.issues.some((issue) => issue.scope.startsWith(scopePrefix) && issue.message.includes(messagePart)),
    true,
    JSON.stringify(report.issues),
  );
}
