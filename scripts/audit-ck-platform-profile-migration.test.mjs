import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { browserToolchainPackRevisionInput } from '../packages/web/public/avr/v3/toolchain-pack.js';
import { decodePackArtifact } from './publish-ck-platform-manifests.mjs';
import {
  auditCkPlatformProfileMigration,
  classifyProfileArtifacts,
} from './audit-ck-platform-profile-migration.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DESCRIPTOR = join(
  ROOT,
  'packages',
  'web',
  'public',
  'esp32',
  'v2',
  'runtime',
  'runtime.json',
);

test('accepts and validates a current-only SDK and Board Pack', () => {
  const fixture = createAuditFixture({
    sdkProfiles: ['platform-manifest', 'profile-v5'],
    boardProfiles: ['profile-v4'],
  });
  try {
    const report = auditCkPlatformProfileMigration({
      root: fixture.root,
      targets: [fixture.target],
    });
    assert.equal(report.policy, 'current-only');
    assert.equal(report.state, 'current-only');
    assert.equal(report.productionPacksMigrated, true);
    assert.deepEqual(report.counts, {
      descriptors: 1,
      currentOnly: 1,
      legacyOnly: 0,
      mixed: 0,
      incompleteCurrent: 0,
      invalid: 0,
    });
    assert.equal(report.issues.length, 0);
    assert.equal(report.targets.length, 1);
    assert.equal(report.targets[0].state, 'current-only');
    assert.deepEqual(report.targets[0].artifacts.sdk, ['platform-manifest', 'profile-v5']);
    assert.deepEqual(report.targets[0].artifacts.board, ['profile-v4']);
  } finally {
    fixture.cleanup();
  }
});

for (const scenario of [
  {
    name: 'rejects a Pack missing a current artifact',
    sdkProfiles: ['profile-v5'],
    boardProfiles: ['profile-v4'],
    state: 'incomplete-current',
    countField: 'incompleteCurrent',
    message: /current profile artifacts are incomplete/,
  },
  {
    name: 'rejects legacy-only Packs',
    sdkProfiles: ['profile'],
    boardProfiles: ['profile'],
    state: 'legacy-only',
    countField: 'legacyOnly',
    message: /legacy-only profile artifacts are noncompliant/,
  },
  {
    name: 'rejects mixed legacy and current Packs',
    sdkProfiles: ['profile', 'platform-manifest', 'profile-v5'],
    boardProfiles: ['profile', 'profile-v4'],
    state: 'mixed',
    countField: 'mixed',
    message: /mixed legacy\/current profile artifacts are noncompliant/,
  },
]) {
  test(scenario.name, () => {
    const fixture = createAuditFixture(scenario);
    try {
      const report = auditCkPlatformProfileMigration({
        root: fixture.root,
        targets: [fixture.target],
      });
      assert.equal(report.policy, 'current-only');
      assert.equal(report.state, 'invalid');
      assert.equal(report.productionPacksMigrated, false);
      assert.equal(report.targets.length, 0);
      assert.equal(report.issues.length, 1);
      assert.equal(report.counts[scenario.countField], 1);
      assert.equal(report.issues[0].state, scenario.state);
      assert.match(report.issues[0].message, scenario.message);
    } finally {
      fixture.cleanup();
    }
  });
}

for (const scenario of [
  {
    name: 'rejects a schema-5 Profile missing its id',
    options: { omitPlatformProfileId: true },
    message: /Platform profile has an invalid shape/,
  },
  {
    name: 'rejects a tool-bound current Platform Manifest',
    options: { platformTools: true },
    message: /complete shared Platform Manifest/,
  },
  {
    name: 'rejects a syntactically valid non-canonical flash offset',
    options: { partitionsOffset: '0x9000' },
    message: /flash offsets do not match Platform Manifest/,
  },
  {
    name: 'rejects a raw-only Pack revision that differs after v3 normalization',
    options: { rawSdkRevision: true },
    state: 'invalid',
    message: /normalized revision is invalid/,
  },
]) {
  test(scenario.name, () => {
    const fixture = createAuditFixture({
      sdkProfiles: ['platform-manifest', 'profile-v5'],
      boardProfiles: ['profile-v4'],
      ...scenario.options,
    });
    try {
      const report = auditCkPlatformProfileMigration({
        root: fixture.root,
        targets: [fixture.target],
      });
      assert.equal(report.state, 'invalid');
      assert.equal(report.productionPacksMigrated, false);
      assert.equal(report.issues.length, 1);
      assert.equal(report.issues[0].state, scenario.state ?? 'invalid-current');
      assert.match(report.issues[0].message, scenario.message);
    } finally {
      fixture.cleanup();
    }
  });
}

test('classifies only the exact current profile artifact set as compliant', () => {
  assert.equal(
    classifyProfileArtifacts(['platform-manifest', 'profile-v5'], ['profile-v4']),
    'current-only',
  );
  assert.throws(
    () => classifyProfileArtifacts(['profile-v5'], ['profile-v4']),
    (error) => error.profileState === 'incomplete-current',
  );
  assert.throws(
    () => classifyProfileArtifacts(['profile'], ['profile']),
    (error) => error.profileState === 'legacy-only',
  );
  assert.throws(
    () => classifyProfileArtifacts(
      ['profile', 'platform-manifest', 'profile-v5'],
      ['profile', 'profile-v4'],
    ),
    (error) => error.profileState === 'mixed',
  );
  assert.throws(
    () => classifyProfileArtifacts(
      ['platform-manifest', 'profile-v5', 'profile-v6'],
      ['profile-v4'],
    ),
    (error) => error.profileState === 'unsupported',
  );
});

function createAuditFixture({
  sdkProfiles,
  boardProfiles,
  omitPlatformProfileId = false,
  platformTools = false,
  partitionsOffset,
  rawSdkRevision = false,
}) {
  const root = mkdtempSync(join(tmpdir(), 'ck-profile-audit-'));
  const descriptor = readJson(SOURCE_DESCRIPTOR);
  for (const [role, profiles] of [['sdk', sdkProfiles], ['board', boardProfiles]]) {
    const pin = descriptor.packs.find((candidate) => candidate.role === role);
    const sourceManifestPath = resolve(dirname(SOURCE_DESCRIPTOR), ...pin.manifest.split('/'));
    const manifest = readJson(sourceManifestPath);
    const syntheticChunks = new Map();
    manifest.artifacts = manifest.artifacts.filter((artifact) => (
      !isProfileArtifact(role, artifact.id) || profiles.includes(artifact.id)
    ));
    if (profiles.includes('profile')
      && !manifest.artifacts.some((artifact) => artifact.id === 'profile')) {
      const content = Buffer.from(JSON.stringify({ schema: role === 'sdk' ? 4 : 3 }), 'utf8');
      const sha256 = createHash('sha256').update(content).digest('hex');
      const path = `chunks/fixture-${role}-legacy-profile.json`;
      manifest.artifacts.push({
        id: 'profile',
        kind: 'json',
        size: content.byteLength,
        sha256,
        chunks: [{ path, size: content.byteLength, sha256 }],
      });
      syntheticChunks.set(path, content);
    }
    manifest.artifacts.sort((left, right) => (
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    ));

    const destinationDirectory = join(root, 'packs', role);
    const destinationManifestPath = join(destinationDirectory, 'toolchain.json');
    mkdirSync(destinationDirectory, { recursive: true });
    for (const artifact of manifest.artifacts.filter((candidate) => profiles.includes(candidate.id))) {
      for (const chunk of artifact.chunks) {
        const sourceChunk = resolve(dirname(sourceManifestPath), ...chunk.path.split('/'));
        const destinationChunk = resolve(destinationDirectory, ...chunk.path.split('/'));
        mkdirSync(dirname(destinationChunk), { recursive: true });
        const synthetic = syntheticChunks.get(chunk.path);
        if (synthetic) writeFileSync(destinationChunk, synthetic);
        else copyFileSync(sourceChunk, destinationChunk);
      }
    }

    manifest.revision = packRevision(manifest);
    writeFileSync(destinationManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    pin.revision = manifest.revision;
    pin.manifest = `packs/${role}/toolchain.json`;
  }

  const target = 'runtime.json';
  const descriptorPath = join(root, target);
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
  const fixture = {
    root,
    target,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  if (omitPlatformProfileId) {
    mutateJsonArtifact(fixture, 'sdk', 'profile-v5', (profile) => {
      delete profile.id;
    });
  }
  if (partitionsOffset !== undefined) {
    mutateJsonArtifact(fixture, 'board', 'profile-v4', (profile) => {
      profile.flash.offsets.partitions = partitionsOffset;
    });
  }
  if (platformTools) bindFixturePlatformTool(fixture);
  if (rawSdkRevision) writeRawOnlyRevision(fixture, 'sdk');
  return fixture;
}

function isProfileArtifact(role, id) {
  return id === 'profile'
    || id.startsWith('profile-v')
    || (role === 'sdk' && id === 'platform-manifest');
}

function packRevision(manifest) {
  const revisionSource = { ...manifest, revision: '0'.repeat(64) };
  return createHash('sha256').update(Buffer.from(
    browserToolchainPackRevisionInput(revisionSource),
    'utf8',
  )).digest('hex');
}

function rawPackRevision(manifest) {
  return createHash('sha256').update(Buffer.from(JSON.stringify({
    schema: manifest.schema,
    id: manifest.id,
    version: manifest.version,
    artifacts: manifest.artifacts,
  }), 'utf8')).digest('hex');
}

function mutateJsonArtifact(fixture, role, id, mutate) {
  const descriptorPath = join(fixture.root, fixture.target);
  const descriptor = readJson(descriptorPath);
  const pin = descriptor.packs.find((candidate) => candidate.role === role);
  const manifestPath = resolve(dirname(descriptorPath), ...pin.manifest.split('/'));
  const manifest = readJson(manifestPath);
  const value = JSON.parse(decodePackArtifact(manifest, id, manifestPath).toString('utf8'));
  mutate(value);
  const content = Buffer.from(JSON.stringify(value), 'utf8');
  const digest = createHash('sha256').update(content).digest('hex');
  const chunkPath = `chunks/fixture-${role}-${id}-${digest.slice(0, 12)}.json`;
  const chunkFile = resolve(dirname(manifestPath), ...chunkPath.split('/'));
  mkdirSync(dirname(chunkFile), { recursive: true });
  writeFileSync(chunkFile, content);
  const artifact = manifest.artifacts.find((candidate) => candidate.id === id);
  Object.keys(artifact).forEach((key) => delete artifact[key]);
  Object.assign(artifact, {
    id,
    kind: 'json',
    size: content.byteLength,
    sha256: digest,
    chunks: [{ path: chunkPath, size: content.byteLength, sha256: digest }],
  });
  manifest.revision = packRevision(manifest);
  pin.revision = manifest.revision;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
  return { value, artifactSha256: digest };
}

function bindFixturePlatformTool(fixture) {
  const profile = readFixtureJsonArtifact(fixture, 'sdk', 'profile-v5');
  const tool = { ...profile.sdkVariant.compilerPack };
  let platformIdentity;
  const rewrittenManifest = mutateJsonArtifact(fixture, 'sdk', 'platform-manifest', (manifest) => {
    manifest.tools = [tool];
    const { sha256: _sha256, ...body } = manifest;
    manifest.sha256 = createHash('sha256')
      .update(Buffer.from(canonicalJson(body), 'utf8'))
      .digest('hex');
    platformIdentity = { id: manifest.id, version: manifest.version, sha256: manifest.sha256 };
  });
  mutateJsonArtifact(fixture, 'sdk', 'profile-v5', (value) => {
    value.platformRef = { ...platformIdentity };
    value.platformManifestArtifact.sha256 = rewrittenManifest.artifactSha256;
  });
  mutateJsonArtifact(fixture, 'board', 'profile-v4', (value) => {
    value.platformRef = { ...platformIdentity, fqbn: value.board };
  });
}

function readFixtureJsonArtifact(fixture, role, id) {
  const descriptorPath = join(fixture.root, fixture.target);
  const descriptor = readJson(descriptorPath);
  const pin = descriptor.packs.find((candidate) => candidate.role === role);
  const manifestPath = resolve(dirname(descriptorPath), ...pin.manifest.split('/'));
  const manifest = readJson(manifestPath);
  return JSON.parse(decodePackArtifact(manifest, id, manifestPath).toString('utf8'));
}

function writeRawOnlyRevision(fixture, role) {
  const descriptorPath = join(fixture.root, fixture.target);
  const descriptor = readJson(descriptorPath);
  const pin = descriptor.packs.find((candidate) => candidate.role === role);
  const manifestPath = resolve(dirname(descriptorPath), ...pin.manifest.split('/'));
  const manifest = readJson(manifestPath);
  const index = manifest.artifacts.findIndex((artifact) => artifact.kind === 'tree' && artifact.files);
  const artifact = manifest.artifacts[index];
  manifest.artifacts[index] = {
    id: artifact.id,
    kind: artifact.kind,
    size: artifact.size,
    sha256: artifact.sha256,
    chunks: artifact.chunks,
    files: artifact.files,
  };
  manifest.revision = rawPackRevision(manifest);
  pin.revision = manifest.revision;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
