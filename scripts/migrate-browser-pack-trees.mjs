#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  browserToolchainPackRevisionInput,
  validateBrowserToolchainPackManifest,
} from '../packages/web/public/avr/v3/toolchain-pack.js';

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_PATH = join(WORKSPACE, 'packages', 'web', 'public', 'esp32', 'v1', 'release.js');
const SHA256 = /^[a-f0-9]{64}$/;
const TARGETS = Object.freeze([
  {
    fqbn: 'esp32:esp32:esp32',
    descriptor: 'packages/web/public/esp32/v5/xtensa/esp32.json',
    metadata: 'packages/web/public/esp32/v5/xtensa/metadata/esp32',
  },
  {
    fqbn: 'esp32:esp32:esp32s2',
    descriptor: 'packages/web/public/esp32/v5/xtensa/esp32s2.json',
    metadata: 'packages/web/public/esp32/v5/xtensa/metadata/esp32s2',
  },
  {
    fqbn: 'esp32:esp32:esp32s3',
    descriptor: 'packages/web/public/esp32/v5/xtensa/esp32s3.json',
    metadata: 'packages/web/public/esp32/v5/xtensa/metadata/esp32s3',
  },
  {
    fqbn: 'esp32:esp32:esp32c3',
    descriptor: 'packages/web/public/esp32/v2/runtime/runtime.json',
    report: 'packages/web/public/esp32/v2/runtime/release-report.json',
  },
  {
    fqbn: 'esp32:esp32:esp32c6',
    descriptor: 'packages/web/public/esp32/v2/runtime-c6/runtime.json',
    report: 'packages/web/public/esp32/v2/runtime-c6/release-report.json',
  },
]);

export function migrateBrowserPackTrees({ apply = false } = {}) {
  const results = [];
  const descriptorHashes = new Map();
  for (const target of TARGETS) {
    const descriptorPath = workspacePath(target.descriptor);
    const oldDescriptorBytes = readFileSync(descriptorPath);
    const descriptor = JSON.parse(oldDescriptorBytes.toString('utf8'));
    if (descriptor.schema !== 2 || descriptor.board !== target.fqbn || !Array.isArray(descriptor.packs)) {
      throw new Error(`CK runtime descriptor is invalid: ${target.fqbn}`);
    }
    const packs = {};
    for (const role of ['sdk', 'board']) {
      const pin = descriptor.packs.find((candidate) => candidate.role === role);
      if (!pin || !SHA256.test(pin.revision) || typeof pin.manifest !== 'string') {
        throw new Error(`${target.fqbn} ${role} Pack pin is invalid`);
      }
      const manifestPath = resolve(dirname(descriptorPath), ...pin.manifest.split('/'));
      const migrated = migratePack(manifestPath, role, apply);
      if (migrated.oldRevision !== pin.revision) {
        throw new Error(`${target.fqbn} ${role} Pack revision does not match its descriptor`);
      }
      pin.revision = migrated.newRevision;
      pin.manifest = replaceRevision(pin.manifest, migrated.oldRevision, migrated.newRevision);
      packs[role] = migrated;
    }
    const descriptorBytes = jsonBytes(descriptor);
    const oldDescriptorSha256 = sha256(oldDescriptorBytes);
    const descriptorSha256 = sha256(descriptorBytes);
    if (apply) writeFileSync(descriptorPath, descriptorBytes);
    descriptorHashes.set(oldDescriptorSha256, descriptorSha256);

    const result = Object.freeze({
      ...target,
      descriptorPath,
      descriptor,
      oldDescriptorSha256,
      descriptorSha256,
      packs: Object.freeze(packs),
    });
    results.push(result);
    if (target.report) updateStandaloneReport(result, apply);
    if (target.metadata) updateMetadataReport(result, apply);
  }

  updateXtensaAggregateReport(results, apply);
  updateReleasePins(descriptorHashes, apply);
  return Object.freeze(results);
}

function migratePack(manifestPath, role, apply) {
  const manifest = readJson(manifestPath);
  if (!SHA256.test(manifest.revision) || !Array.isArray(manifest.artifacts)) {
    throw new Error(`Pack Manifest is invalid: ${manifestPath}`);
  }
  if (manifest.schema === 2) {
    return migrateCurrentProfilePack(manifestPath, manifest, role, apply);
  }
  if (manifest.schema !== 1) throw new Error(`unsupported Pack schema: ${manifestPath}`);

  const profileArtifact = findArtifact(manifest, 'profile');
  const profile = JSON.parse(decodeArtifact(manifestPath, profileArtifact).toString('utf8'));
  const phases = role === 'sdk'
    ? [
        ['compile', profile.compile],
        ['link', profile.link],
      ]
    : [['board', profile]];
  const groupsByArtifact = new Map();
  for (const [phase, owner] of phases) {
    const groups = owner?.vfsGroups;
    if (!Array.isArray(groups) || !groups.length) {
      throw new Error(`${manifest.id} ${phase} legacy Pack tree index is missing`);
    }
    const artifactIds = [];
    for (const group of groups) {
      if (!group || typeof group.artifact !== 'string' || groupsByArtifact.has(group.artifact)) {
        throw new Error(`${manifest.id} ${phase} legacy artifact id is invalid`);
      }
      groupsByArtifact.set(group.artifact, { phase, group });
      artifactIds.push(group.artifact);
    }
    if (artifactIds.some((id, index) => index > 0 && id <= artifactIds[index - 1])) {
      throw new Error(`${manifest.id} ${phase} legacy artifact ids are not sorted`);
    }
    replaceProperty(owner, 'vfsGroups', 'artifactIds', artifactIds);
  }
  profile.schema = role === 'sdk' ? 4 : 3;

  const artifacts = manifest.artifacts.map((artifact) => {
    if (artifact.id === 'profile') return null;
    const indexed = groupsByArtifact.get(artifact.id);
    if (!indexed) return cloneArtifact(artifact);
    if (artifact.kind !== 'vfs' || artifact.size !== indexed.group.size) {
      throw new Error(`${manifest.id} ${indexed.phase} legacy tree artifact is invalid: ${artifact.id}`);
    }
    const bytes = decodeArtifact(manifestPath, artifact);
    const files = indexTreeFiles(indexed.group, bytes, `${manifest.id}/${artifact.id}`);
    return {
      id: artifact.id,
      kind: 'tree',
      size: artifact.size,
      sha256: artifact.sha256,
      files,
      chunks: artifact.chunks.map((chunk) => ({ ...chunk })),
    };
  });
  if ([...groupsByArtifact].some(([id]) => !manifest.artifacts.some((artifact) => artifact.id === id))) {
    throw new Error(`${manifest.id} profile references a missing tree artifact`);
  }

  const profileBytes = Buffer.from(JSON.stringify(profile), 'utf8');
  const packedProfile = createProfileArtifact(profileBytes);
  const profileIndex = manifest.artifacts.findIndex((artifact) => artifact.id === 'profile');
  artifacts[profileIndex] = packedProfile.artifact;
  const revisionInput = {
    schema: 2,
    id: manifest.id,
    version: manifest.version,
    artifacts,
  };
  const newRevision = sha256(Buffer.from(JSON.stringify(revisionInput), 'utf8'));
  const migratedManifest = { ...revisionInput, revision: newRevision };
  const sourceRoot = dirname(manifestPath);
  const destinationRoot = join(dirname(sourceRoot), newRevision);
  const destinationManifest = join(destinationRoot, 'toolchain.json');

  if (apply) {
    if (existsSync(destinationManifest)) {
      const existing = readJson(destinationManifest);
      if (JSON.stringify(existing) !== JSON.stringify(migratedManifest)) {
        throw new Error(`immutable Pack destination contains different bytes: ${destinationManifest}`);
      }
    } else {
      mkdirSync(join(destinationRoot, 'chunks'), { recursive: true });
      for (const artifact of migratedManifest.artifacts) {
        if (artifact.id === 'profile') continue;
        for (const chunk of artifact.chunks) {
          linkOrCopy(
            resolve(sourceRoot, ...chunk.path.split('/')),
            resolve(destinationRoot, ...chunk.path.split('/')),
          );
        }
      }
      const profileChunk = packedProfile.artifact.chunks[0];
      const profileChunkPath = resolve(destinationRoot, ...profileChunk.path.split('/'));
      mkdirSync(dirname(profileChunkPath), { recursive: true });
      writeFileSync(profileChunkPath, packedProfile.transport);
      writeFileSync(destinationManifest, jsonBytes(migratedManifest));
    }
  }

  return Object.freeze({
    oldRevision: manifest.revision,
    newRevision,
    manifestPath: destinationManifest,
    manifest: migratedManifest,
    ...packStats(migratedManifest),
  });
}

export function createCurrentOnlyBoardPackManifest(manifest) {
  return createCurrentOnlyProfilePackManifest(manifest, 'Board', ['profile-v4']);
}

export function createCurrentOnlySdkPackManifest(manifest) {
  return createCurrentOnlyProfilePackManifest(
    manifest,
    'SDK',
    ['platform-manifest', 'profile-v5'],
  );
}

function createCurrentOnlyProfilePackManifest(manifest, label, requiredArtifactIds) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.schema !== 2 || typeof manifest.id !== 'string' || !manifest.id
    || typeof manifest.version !== 'string' || !manifest.version
    || !SHA256.test(manifest.revision) || !Array.isArray(manifest.artifacts)) {
    throw new Error(`current ${label} Pack Manifest is invalid`);
  }
  const sourceRevision = sha256(Buffer.from(JSON.stringify({
    schema: manifest.schema,
    id: manifest.id,
    version: manifest.version,
    artifacts: manifest.artifacts,
  }), 'utf8'));
  if (sourceRevision !== manifest.revision) {
    throw new Error(`current ${label} Pack revision is invalid: ${manifest.id}`);
  }

  const ids = new Set();
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
      || typeof artifact.id !== 'string' || !artifact.id || ids.has(artifact.id)) {
      throw new Error(`current ${label} Pack artifact identity is invalid: ${manifest.id}`);
    }
    ids.add(artifact.id);
  }
  for (const id of requiredArtifactIds) {
    if (!ids.has(id)) {
      throw new Error(`current ${label} Pack ${id} artifact is missing: ${manifest.id}`);
    }
  }

  const artifacts = manifest.artifacts
    .filter((artifact) => artifact.id !== 'profile')
    .map((artifact) => JSON.parse(JSON.stringify(artifact)))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const normalized = validateBrowserToolchainPackManifest({
    schema: manifest.schema,
    id: manifest.id,
    version: manifest.version,
    revision: manifest.revision,
    artifacts,
  });
  const base = {
    schema: normalized.schema,
    id: normalized.id,
    version: normalized.version,
    artifacts: normalized.artifacts,
  };
  return {
    ...base,
    revision: sha256(Buffer.from(browserToolchainPackRevisionInput(normalized), 'utf8')),
  };
}

function migrateCurrentProfilePack(manifestPath, manifest, role, apply) {
  for (const artifact of manifest.artifacts) decodeArtifact(manifestPath, artifact);
  const migratedManifest = role === 'sdk'
    ? createCurrentOnlySdkPackManifest(manifest)
    : createCurrentOnlyBoardPackManifest(manifest);
  if (migratedManifest.revision === manifest.revision) {
    return Object.freeze({
      oldRevision: manifest.revision,
      newRevision: manifest.revision,
      manifestPath,
      manifest,
      ...packStats(manifest),
    });
  }

  const sourceRoot = dirname(manifestPath);
  const destinationRoot = join(dirname(sourceRoot), migratedManifest.revision);
  const destinationManifest = join(destinationRoot, 'toolchain.json');
  if (apply) publishCurrentProfilePack(sourceRoot, destinationRoot, migratedManifest);
  return Object.freeze({
    oldRevision: manifest.revision,
    newRevision: migratedManifest.revision,
    manifestPath: destinationManifest,
    manifest: migratedManifest,
    ...packStats(migratedManifest),
  });
}

function publishCurrentProfilePack(sourceRoot, destinationRoot, manifest) {
  const destinationManifest = join(destinationRoot, 'toolchain.json');
  if (existsSync(destinationRoot)) {
    if (!existsSync(destinationManifest)) {
      throw new Error(`immutable Pack destination is incomplete: ${destinationRoot}`);
    }
    const existing = readJson(destinationManifest);
    if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
      throw new Error(`immutable Pack destination contains different bytes: ${destinationManifest}`);
    }
    for (const artifact of manifest.artifacts) decodeArtifact(destinationManifest, artifact);
    return;
  }

  const temporary = join(
    dirname(destinationRoot),
    `.${manifest.revision}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    mkdirSync(join(temporary, 'chunks'), { recursive: true });
    for (const artifact of manifest.artifacts) {
      for (const chunk of artifact.chunks) {
        linkOrCopy(
          packPath(sourceRoot, chunk.path, 'source Pack chunk'),
          packPath(temporary, chunk.path, 'destination Pack chunk'),
        );
      }
    }
    writeFileSync(join(temporary, 'toolchain.json'), jsonBytes(manifest));
    for (const artifact of manifest.artifacts) {
      decodeArtifact(join(temporary, 'toolchain.json'), artifact);
    }
    renameSync(temporary, destinationRoot);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  }
}

function indexTreeFiles(group, bytes, label) {
  if (!Array.isArray(group.entries) || !group.entries.length) {
    throw new Error(`${label} legacy tree files are invalid`);
  }
  let expectedOffset = 0;
  let previousPath = '';
  return group.entries.map((entry) => {
    if (!entry || typeof entry.path !== 'string' || entry.path <= previousPath
      || !Number.isSafeInteger(entry.offset) || entry.offset !== expectedOffset
      || !Number.isSafeInteger(entry.length) || entry.length < 0
      || entry.length > bytes.byteLength - entry.offset) {
      throw new Error(`${label} legacy tree file is invalid`);
    }
    const contents = bytes.subarray(entry.offset, entry.offset + entry.length);
    expectedOffset += entry.length;
    previousPath = entry.path;
    return {
      path: entry.path,
      offset: entry.offset,
      length: entry.length,
      sha256: sha256(contents),
    };
  }).map((file, index, files) => {
    if (index === files.length - 1 && expectedOffset !== bytes.byteLength) {
      throw new Error(`${label} legacy tree bytes are not contiguous`);
    }
    return file;
  });
}

function createProfileArtifact(bytes) {
  const compressed = gzipSync(bytes, { level: 9 });
  const useCompression = compressed.byteLength + 1024 < bytes.byteLength;
  const transport = useCompression ? compressed : bytes;
  const bodySha256 = sha256(bytes);
  const transportSha256 = sha256(transport);
  const path = `chunks/profile-${transportSha256.slice(0, 16)}.bin${useCompression ? '.gz' : ''}`;
  return Object.freeze({
    transport,
    artifact: {
      id: 'profile',
      kind: 'json',
      size: bytes.byteLength,
      sha256: bodySha256,
      chunks: [{
        path,
        size: bytes.byteLength,
        sha256: bodySha256,
        ...(useCompression ? {
          compression: 'gzip',
          compressedSize: transport.byteLength,
          compressedSha256: transportSha256,
        } : {}),
      }],
    },
  });
}

function decodeArtifact(manifestPath, artifact) {
  const root = dirname(manifestPath);
  if (!artifact || typeof artifact !== 'object' || !Array.isArray(artifact.chunks)
    || artifact.chunks.length === 0) {
    throw new Error(`Pack artifact chunks are invalid: ${artifact?.id ?? 'unknown'}`);
  }
  const parts = artifact.chunks.map((chunk) => {
    const transport = readFileSync(packPath(root, chunk.path, 'Pack chunk'));
    const expectedTransportSize = chunk.compressedSize ?? chunk.size;
    const expectedTransportSha256 = chunk.compressedSha256 ?? chunk.sha256;
    if (transport.byteLength !== expectedTransportSize || sha256(transport) !== expectedTransportSha256) {
      throw new Error(`Pack chunk transport integrity mismatch: ${chunk.path}`);
    }
    const bytes = chunk.compression === 'gzip' ? gunzipSync(transport) : transport;
    if (bytes.byteLength !== chunk.size || sha256(bytes) !== chunk.sha256) {
      throw new Error(`Pack chunk decoded integrity mismatch: ${chunk.path}`);
    }
    return bytes;
  });
  const body = Buffer.concat(parts);
  if (body.byteLength !== artifact.size || sha256(body) !== artifact.sha256) {
    throw new Error(`Pack artifact integrity mismatch: ${artifact.id}`);
  }
  return body;
}

function packPath(root, value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\')) {
    throw new Error(`${label} path is invalid: ${String(value)}`);
  }
  const target = resolve(root, ...value.split('/'));
  const path = relative(resolve(root), target);
  if (!path || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes its immutable Pack: ${value}`);
  }
  return target;
}

function updateStandaloneReport(result, apply) {
  const path = workspacePath(result.report);
  const report = readJson(path);
  report.descriptorSha256 = result.descriptorSha256;
  for (const role of ['sdk', 'board']) {
    const pack = result.packs[role];
    const pin = result.descriptor.packs.find((candidate) => candidate.role === role);
    Object.assign(report.packs[role], {
      revision: pack.newRevision,
      bytes: pack.totalBytes,
      downloadBytes: pack.downloadBytes,
      manifest: pin.manifest,
    });
  }
  renamePhaseCounts(report);
  if (apply) writeFileSync(path, jsonBytes(report));
}

function updateMetadataReport(result, apply) {
  const root = workspacePath(result.metadata);
  const runtimePath = join(root, 'runtime.json');
  const runtime = readJson(runtimePath);
  for (const role of ['sdk', 'board']) {
    const pin = runtime.packs?.find((candidate) => candidate.role === role);
    if (!pin) throw new Error(`${result.fqbn} metadata ${role} Pack pin is missing`);
    pin.revision = result.packs[role].newRevision;
  }
  const runtimeBytes = jsonBytes(runtime);
  const reportPath = join(root, 'release-report.json');
  const report = readJson(reportPath);
  report.descriptorSha256 = sha256(runtimeBytes);
  for (const role of ['sdk', 'board']) {
    Object.assign(report.packs[role], {
      revision: result.packs[role].newRevision,
      bytes: result.packs[role].totalBytes,
      downloadBytes: result.packs[role].downloadBytes,
    });
  }
  renamePhaseCounts(report);
  if (apply) {
    writeFileSync(runtimePath, runtimeBytes);
    writeFileSync(reportPath, jsonBytes(report));
  }
}

function updateXtensaAggregateReport(results, apply) {
  const xtensa = results.filter((result) => result.descriptorPath.includes(`${join('v5', 'xtensa')}`));
  const path = workspacePath('packages/web/public/esp32/v5/xtensa/release-report.json');
  const report = readJson(path);
  for (const result of xtensa) {
    const descriptor = report.descriptors[result.fqbn];
    descriptor.sha256 = result.descriptorSha256;
    descriptor.sdkRevision = result.packs.sdk.newRevision;
    descriptor.boardRevision = result.packs.board.newRevision;
    report.downloads.targets[result.fqbn] = {
      rawBytes: report.downloads.compiler.rawBytes
        + result.packs.sdk.totalBytes
        + result.packs.board.totalBytes,
      downloadBytes: report.downloads.compiler.downloadBytes
        + result.packs.sdk.downloadBytes
        + result.packs.board.downloadBytes,
    };
  }
  if (apply) writeFileSync(path, jsonBytes(report));
}

function updateReleasePins(descriptorHashes, apply) {
  let source = readFileSync(RELEASE_PATH, 'utf8');
  for (const [oldSha256, newSha256] of descriptorHashes) {
    if (oldSha256 !== newSha256) source = source.replaceAll(oldSha256, newSha256);
  }
  if (apply) writeFileSync(RELEASE_PATH, source, 'utf8');
}

function renamePhaseCounts(report) {
  for (const phase of Object.values(report.phases ?? {})) {
    if (Object.hasOwn(phase, 'groups')) {
      phase.artifacts = phase.groups;
      delete phase.groups;
    }
  }
}

function packStats(manifest) {
  return Object.freeze({
    totalBytes: manifest.artifacts.reduce((total, artifact) => total + artifact.size, 0),
    downloadBytes: manifest.artifacts.reduce((total, artifact) => total + artifact.chunks.reduce(
      (chunkTotal, chunk) => chunkTotal + (chunk.compressedSize ?? chunk.size),
      0,
    ), 0),
  });
}

function cloneArtifact(artifact) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    size: artifact.size,
    sha256: artifact.sha256,
    chunks: artifact.chunks.map((chunk) => ({ ...chunk })),
  };
}

function findArtifact(manifest, id) {
  const artifact = manifest.artifacts.find((candidate) => candidate.id === id);
  if (!artifact || !Array.isArray(artifact.chunks) || !artifact.chunks.length) {
    throw new Error(`Pack artifact is missing: ${manifest.id}/${id}`);
  }
  return artifact;
}

function replaceProperty(target, oldName, newName, value) {
  const entries = Object.entries(target);
  if (!entries.some(([name]) => name === oldName) || Object.hasOwn(target, newName)) {
    throw new Error(`profile property migration is invalid: ${oldName}`);
  }
  for (const key of Object.keys(target)) delete target[key];
  for (const [name, current] of entries) target[name === oldName ? newName : name] = name === oldName ? value : current;
}

function replaceRevision(value, oldRevision, newRevision) {
  if (oldRevision === newRevision) return value;
  const updated = value.replace(oldRevision, newRevision);
  if (updated === value) throw new Error(`Pack manifest path does not contain its revision: ${value}`);
  return updated;
}

function linkOrCopy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) return;
  try {
    linkSync(source, destination);
  } catch {
    copyFileSync(source, destination);
  }
}

function workspacePath(value) {
  return resolve(WORKSPACE, ...value.split('/'));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const apply = process.argv.includes('--apply');
  const results = migrateBrowserPackTrees({ apply });
  for (const result of results) {
    const changed = result.oldDescriptorSha256 !== result.descriptorSha256
      || result.packs.sdk.oldRevision !== result.packs.sdk.newRevision
      || result.packs.board.oldRevision !== result.packs.board.newRevision;
    console.log([
      changed ? (apply ? 'MIGRATED' : 'WOULD MIGRATE') : 'UNCHANGED',
      result.fqbn,
      `sdk=${result.packs.sdk.newRevision}`,
      `board=${result.packs.board.newRevision}`,
      `descriptor=${result.descriptorSha256}`,
    ].join(' '));
  }
  if (!apply) console.log('Dry run only; pass --apply to publish the new immutable Pack addresses.');
}
