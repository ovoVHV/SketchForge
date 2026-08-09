import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import test from 'node:test';

import {
  ESP_SR_AUDIT_PATHS,
  auditEsp32S3EspSrSourceLock,
} from './audit-esp32-s3-esp-sr-source-lock.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function slash(path) {
  return path.split(sep).join('/');
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
}

function assertFinding(result, code) {
  assert.equal(
    result.findings.some((item) => item.code === code),
    true,
    JSON.stringify(result.findings, null, 2),
  );
}

test('current ESP32-S3 ESP-SR metadata is locked, packaged, and enabled', () => {
  const result = auditEsp32S3EspSrSourceLock();
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.status, 'source-locked/packaged');
  assert.equal(result.target, 'ESP32-S3');
  assert.equal(result.licenseSha256, '7d916fb00bc0742c47cafb0d0144b67f826d76779730b1cb8796045ea6ba1b9a');
  assert.equal(result.boardPackArtifact, true);
  assert.equal(result.partitionSchemeEnabled, true);
});

for (const [name, path, code] of [
  ['source lock', ESP_SR_AUDIT_PATHS.sourceLock, 'required-source-lock'],
  ['third-party notice', ESP_SR_AUDIT_PATHS.notice, 'required-notice'],
  ['license text', ESP_SR_AUDIT_PATHS.license, 'required-license'],
]) {
  test(`audit fails closed when the ${name} is missing`, () => {
    const result = auditEsp32S3EspSrSourceLock({ overrides: { [path]: null } });
    assert.equal(result.ok, false);
    assertFinding(result, code);
  });
}

test('audit rejects source asset, component, target, status, or license drift', () => {
  const lock = readJson(ESP_SR_AUDIT_PATHS.sourceLock);
  lock.sdk.espSrModel.asset.sha256 = '0'.repeat(64);
  const changed = `${JSON.stringify(lock, null, 2)}\n`;
  const result = auditEsp32S3EspSrSourceLock({
    overrides: {
      [ESP_SR_AUDIT_PATHS.sourceLock]: changed,
      [ESP_SR_AUDIT_PATHS.provenanceLock]: changed,
    },
  });
  assert.equal(result.ok, false);
  assertFinding(result, 'source-lock-identity');
});

test('audit rejects drift between the published source-lock copies', () => {
  const result = auditEsp32S3EspSrSourceLock({
    overrides: { [ESP_SR_AUDIT_PATHS.provenanceLock]: '{}\n' },
  });
  assert.equal(result.ok, false);
  assertFinding(result, 'source-lock-publication-drift');
});

test('audit rejects a notice that omits the locked license and packaged status', () => {
  const result = auditEsp32S3EspSrSourceLock({
    overrides: { [ESP_SR_AUDIT_PATHS.notice]: '# stale notice\n' },
  });
  assert.equal(result.ok, false);
  assertFinding(result, 'notice-identity');
});

test('audit rejects any license byte drift', () => {
  const license = readFileSync(resolve(ROOT, ESP_SR_AUDIT_PATHS.license));
  const result = auditEsp32S3EspSrSourceLock({
    overrides: { [ESP_SR_AUDIT_PATHS.license]: Buffer.concat([license, Buffer.from('x')]) },
  });
  assert.equal(result.ok, false);
  assertFinding(result, 'license-identity');
});

test('audit rejects duplicate srmodels artifacts in the active ESP32-S3 Board Pack', () => {
  const descriptor = readJson(ESP_SR_AUDIT_PATHS.descriptor);
  const boardPin = descriptor.packs.find((pack) => pack.role === 'board');
  const descriptorPath = resolve(ROOT, ESP_SR_AUDIT_PATHS.descriptor);
  const boardPackPath = slash(relative(ROOT, resolve(dirname(descriptorPath), boardPin.manifest)));
  const boardPack = readJson(boardPackPath);
  boardPack.artifacts.push({
    id: 'srmodels',
    kind: 'bin',
    size: 2468362,
    sha256: '0312f2dde9581cd604e752fbfa287d687a2acc0631e593a35a24c4a518d75879',
    chunks: [],
  });
  const result = auditEsp32S3EspSrSourceLock({
    overrides: { [boardPackPath]: JSON.stringify(boardPack) },
  });
  assert.equal(result.ok, false);
  assertFinding(result, 'board-pack-model');
});

test('audit rejects disabling esp_sr_16 after the model is packaged', () => {
  const board = readJson(ESP_SR_AUDIT_PATHS.board);
  const option = board.options.find((item) => item.id === 'partition_scheme');
  option.values.find((item) => item.value === 'esp_sr_16').unsupported = { reason: 'disabled' };
  delete board.build.optionEffects.partition_scheme.esp_sr_16;
  const result = auditEsp32S3EspSrSourceLock({
    overrides: { [ESP_SR_AUDIT_PATHS.board]: JSON.stringify(board) },
  });
  assert.equal(result.ok, false);
  assertFinding(result, 'partition-scheme-policy');
});
