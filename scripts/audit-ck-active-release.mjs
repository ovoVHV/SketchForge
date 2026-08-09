#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  browserToolchainPackRevisionInput,
  validateBrowserToolchainPackManifest,
} from '../packages/web/public/avr/v4/toolchain-pack.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_NAME = 'packages/web/public/esp32/v1/release.js';
const SHA256 = /^[a-f0-9]{64}$/;
const PACK_ROLES = Object.freeze(['compiler', 'sdk', 'board']);
const ACTIVE_RUNTIMES = Object.freeze([
  Object.freeze({
    id: 'esp32-xtensa',
    report: 'shared',
    boards: Object.freeze([
      'esp32:esp32:esp32',
      'esp32:esp32:esp32s2',
      'esp32:esp32:esp32s3',
    ]),
  }),
  Object.freeze({
    id: 'esp32-riscv',
    report: 'per-descriptor',
    boards: Object.freeze([
      'esp32:esp32:esp32c3',
      'esp32:esp32:esp32c6',
    ]),
  }),
]);

export async function auditCkActiveRelease({
  root = ROOT,
  releaseMetadata,
  readFile = readFileSync,
} = {}) {
  const workspace = resolve(root);
  const publicRoot = resolve(workspace, 'packages/web/public');
  const releasePath = resolve(workspace, RELEASE_NAME);
  const issues = [];
  const targets = [];
  const releaseReports = [];
  const compilerPacks = new Map();

  const inspect = (scope, operation) => {
    try {
      return operation();
    } catch (error) {
      issues.push(Object.freeze({
        scope,
        message: error instanceof Error ? error.message : String(error),
      }));
      return undefined;
    }
  };

  let release = releaseMetadata;
  if (release === undefined) {
    try {
      const url = `${pathToFileURL(releasePath).href}?audit=${Date.now()}`;
      ({ ESP32_BROWSER_RELEASE: release } = await import(url));
    } catch (error) {
      issues.push(Object.freeze({
        scope: 'release',
        message: `cannot load release metadata: ${error instanceof Error ? error.message : String(error)}`,
      }));
    }
  }

  const releaseReady = inspect('release', () => {
    if (!isRecord(release) || release.schema !== 1 || !isRecord(release.runtimes)) {
      throw new Error('ESP32 browser release metadata must use schema 1');
    }
    assertExactSet(Object.keys(release.runtimes), ACTIVE_RUNTIMES.map(({ id }) => id), 'runtime IDs');
    return true;
  });
  if (!releaseReady) return createReport({ issues, targets, releaseReports, compilerPacks });

  const capabilities = inspect('capabilities', () => loadCapabilities({
    release,
    releasePath,
    publicRoot,
    readFile,
  }));

  for (const runtimePolicy of ACTIVE_RUNTIMES) {
    const runtime = inspect(`runtime:${runtimePolicy.id}`, () => {
      const value = release.runtimes[runtimePolicy.id];
      if (!isRecord(value) || value.enabled !== true
        || typeof value.toolchainId !== 'string' || !value.toolchainId
        || !SHA256.test(value.revision ?? '') || !isRecord(value.descriptors)) {
        throw new Error('active runtime release metadata is invalid');
      }
      assertExactSet(Object.keys(value.descriptors), runtimePolicy.boards, 'descriptor boards');
      if (capabilities) validateRuntimeCapability(value, capabilities, runtimePolicy);
      return value;
    });
    if (!runtime) continue;

    const runtimeTargets = [];
    for (const board of runtimePolicy.boards) {
      const target = inspect(`descriptor:${board}`, () => loadDescriptor({
        board,
        runtime,
        publicRoot,
        readFile,
      }));
      if (!target) continue;
      runtimeTargets.push(target);
      targets.push(Object.freeze({
        runtime: runtimePolicy.id,
        board,
        descriptor: slash(relative(publicRoot, target.descriptorPath)),
        descriptorSha256: target.descriptorSha256,
        packs: Object.freeze(Object.fromEntries(target.packs.map((pack) => [pack.role, Object.freeze({
          id: pack.pin.id,
          revision: pack.pin.revision,
          manifest: slash(relative(publicRoot, pack.manifestPath)),
        })]))),
      }));

      const compiler = target.packs.find(({ role }) => role === 'compiler');
      if (compiler.pin.id !== runtime.toolchainId || compiler.pin.revision !== runtime.revision) {
        issues.push(Object.freeze({
          scope: `descriptor:${board}`,
          message: 'compiler Pack does not match the release runtime identity',
        }));
      }
      const compilerKey = `${compiler.pin.id}\0${compiler.pin.revision}\0${compiler.manifestPath}`;
      if (!compilerPacks.has(compilerKey)) compilerPacks.set(compilerKey, compiler);
    }

    inspect(`runtime:${runtimePolicy.id}:compiler`, () => {
      if (runtimeTargets.length !== runtimePolicy.boards.length) return;
      const identities = runtimeTargets.map((target) => {
        const compiler = target.packs.find(({ role }) => role === 'compiler');
        return `${compiler.pin.id}\0${compiler.pin.revision}\0${compiler.manifestPath}`;
      });
      if (new Set(identities).size !== 1) {
        throw new Error('runtime descriptors do not share one compiler Pack');
      }
    });

    if (runtimeTargets.length === runtimePolicy.boards.length) {
      if (runtimePolicy.report === 'shared') {
        const evidence = inspect(`release-report:${runtimePolicy.id}`, () => (
      validateSharedReleaseReport(runtimeTargets, publicRoot, readFile)
        ));
        if (evidence) releaseReports.push(evidence);
      } else {
        for (const target of runtimeTargets) {
          const evidence = inspect(`release-report:${target.board}`, () => (
            validatePerDescriptorReleaseReport(target, publicRoot, readFile)
          ));
          if (evidence) releaseReports.push(evidence);
        }
      }
    }
  }

  const verifiedCompilerPacks = [];
  for (const compiler of compilerPacks.values()) {
    const evidence = inspect(`compiler-pack:${compiler.pin.id}@${compiler.pin.revision}`, () => (
      verifyCompilerTransport(compiler, publicRoot, readFile)
    ));
    if (evidence) verifiedCompilerPacks.push(evidence);
  }

  return createReport({
    issues,
    targets,
    releaseReports,
    compilerPacks: verifiedCompilerPacks,
  });
}

function loadCapabilities({ release, releasePath, publicRoot, readFile }) {
  const pin = release.capabilities;
  if (!isRecord(pin) || typeof pin.path !== 'string' || !pin.path || !SHA256.test(pin.sha256 ?? '')) {
    throw new Error('capabilities release pin is invalid');
  }
  const path = resolveRelative(dirname(releasePath), pin.path, publicRoot, 'capabilities');
  const bytes = asBuffer(readFile(path));
  if (sha256(bytes) !== pin.sha256) throw new Error('capabilities SHA-256 does not match release.js');
  const value = parseJson(bytes, 'capabilities');
  if (value?.schema !== 1 || !Array.isArray(value.runtimes)) {
    throw new Error('capabilities must use schema 1');
  }
  const runtimes = new Map();
  for (const runtime of value.runtimes) {
    if (!isRecord(runtime) || typeof runtime.id !== 'string' || !runtime.id || runtimes.has(runtime.id)) {
      throw new Error('capabilities runtime identities are invalid or duplicated');
    }
    runtimes.set(runtime.id, runtime);
  }
  assertExactSet([...runtimes.keys()], ACTIVE_RUNTIMES.map(({ id }) => id), 'capability runtime IDs');
  return runtimes;
}

function validateRuntimeCapability(runtime, capabilities, policy) {
  const capability = capabilities.get(policy.id);
  if (capability?.state !== 'ready' || !isRecord(capability.toolchain)
    || capability.toolchain.id !== runtime.toolchainId
    || capability.toolchain.revision !== runtime.revision) {
    throw new Error('capabilities toolchain identity differs from release.js');
  }
  if (!Array.isArray(capability.boards)
    || policy.boards.some((board) => !capability.boards.includes(board))) {
    throw new Error('capabilities board inventory omits an active descriptor');
  }
  if (!Array.isArray(capability.imageBuilderBoards)) {
    throw new Error('capabilities image-builder board inventory is invalid');
  }
  assertExactSet(capability.imageBuilderBoards, policy.boards, 'image-builder boards');
}

function loadDescriptor({ board, runtime, publicRoot, readFile }) {
  const pin = runtime.descriptors[board];
  if (!isRecord(pin) || typeof pin.path !== 'string' || !pin.path || !SHA256.test(pin.sha256 ?? '')) {
    throw new Error('release descriptor pin is invalid');
  }
  const descriptorPath = resolveRelative(publicRoot, pin.path, publicRoot, 'runtime descriptor');
  const bytes = asBuffer(readFile(descriptorPath));
  const descriptorSha256 = sha256(bytes);
  if (descriptorSha256 !== pin.sha256) throw new Error('descriptor SHA-256 does not match release.js');
  const descriptor = parseJson(bytes, 'runtime descriptor');
  if (descriptor?.schema !== 2 || descriptor.abi !== 1 || descriptor.board !== board
    || typeof descriptor.id !== 'string' || !descriptor.id || !Array.isArray(descriptor.packs)) {
    throw new Error('runtime descriptor identity is invalid');
  }
  if (descriptor.packs.length !== PACK_ROLES.length
    || descriptor.packs.map(({ role }) => role).join('\0') !== PACK_ROLES.join('\0')) {
    throw new Error('runtime descriptor must contain ordered compiler, sdk, and board Packs');
  }
  const packs = descriptor.packs.map((pack) => loadPack({
    pin: pack,
    descriptorPath,
    publicRoot,
    readFile,
  }));
  return Object.freeze({ board, descriptor, descriptorPath, descriptorSha256, packs: Object.freeze(packs) });
}

function loadPack({ pin, descriptorPath, publicRoot, readFile }) {
  if (!isRecord(pin) || !PACK_ROLES.includes(pin.role)
    || typeof pin.id !== 'string' || !pin.id || !SHA256.test(pin.revision ?? '')
    || typeof pin.manifest !== 'string' || !pin.manifest) {
    throw new Error('descriptor Pack pin is invalid');
  }
  const manifestPath = resolveRelative(dirname(descriptorPath), pin.manifest, publicRoot, `${pin.role} Pack`);
  const expectedSuffix = `/${pin.id}/${pin.revision}/toolchain.json`;
  if (!slash(manifestPath).endsWith(expectedSuffix)) {
    throw new Error(`${pin.role} Pack manifest is not stored at its content address`);
  }
  const sourceManifest = parseJson(asBuffer(readFile(manifestPath)), `${pin.role} Pack manifest`);
  const manifest = validateBrowserToolchainPackManifest(sourceManifest);
  if (manifest.id !== pin.id || manifest.revision !== pin.revision) {
    throw new Error(`${pin.role} Pack manifest does not match its descriptor pin`);
  }
  const actualRevision = sha256(Buffer.from(browserToolchainPackRevisionInput(sourceManifest), 'utf8'));
  if (actualRevision !== pin.revision) throw new Error(`${pin.role} Pack revision is not content-addressed`);
  const rawBytes = manifest.artifacts.reduce((total, artifact) => total + artifact.size, 0);
  const downloadBytes = manifest.artifacts.reduce((total, artifact) => (
    total + artifact.chunks.reduce((sum, chunk) => sum + (chunk.compressedSize ?? chunk.size), 0)
  ), 0);
  return Object.freeze({ role: pin.role, pin, manifest, manifestPath, rawBytes, downloadBytes });
}

function validatePerDescriptorReleaseReport(target, publicRoot, readFile) {
  const path = resolve(dirname(target.descriptorPath), 'release-report.json');
  const report = parseJson(asBuffer(readFile(path)), 'release report');
  if (report?.schema !== 1 || report.descriptorSha256 !== target.descriptorSha256
    || !isRecord(report.compilerPackage) || !SHA256.test(report.compilerPackage.sha256 ?? '')
    || !isRecord(report.packs)) {
    throw new Error('per-descriptor release report identity is invalid');
  }
  assertExactSet(Object.keys(report.packs), PACK_ROLES, 'release-report Pack roles');
  for (const pack of target.packs) {
    const evidence = report.packs[pack.role];
    if (!isRecord(evidence) || evidence.revision !== pack.pin.revision
      || evidence.manifest !== pack.pin.manifest || evidence.contentAddressed !== true
      || evidence.bytes !== pack.rawBytes || evidence.downloadBytes !== pack.downloadBytes) {
      throw new Error(`${pack.role} Pack release-report binding is invalid`);
    }
    if (pack.role === 'compiler' && evidence.shared !== true) {
      throw new Error('RISC-V compiler release-report binding is not shared');
    }
  }
  const compiler = target.packs.find(({ role }) => role === 'compiler');
  if (report.compilerPackage.version !== compiler.manifest.version) {
    throw new Error('compiler package version differs from the compiler Pack');
  }
  return Object.freeze({
    kind: 'per-descriptor',
    board: target.board,
    path: slash(relative(publicRoot, path)),
    descriptorSha256: target.descriptorSha256,
  });
}

function validateSharedReleaseReport(targets, publicRoot, readFile) {
  const directory = dirname(targets[0].descriptorPath);
  if (targets.some((target) => dirname(target.descriptorPath) !== directory)) {
    throw new Error('shared release descriptors do not have one publication directory');
  }
  const path = resolve(directory, 'release-report.json');
  const report = parseJson(asBuffer(readFile(path)), 'shared release report');
  const compiler = targets[0].packs.find(({ role }) => role === 'compiler');
  if (report?.schema !== 1 || !isRecord(report.compiler) || !isRecord(report.descriptors)
    || report.compiler.id !== compiler.pin.id
    || report.compiler.version !== compiler.manifest.version
    || report.compiler.revision !== compiler.pin.revision) {
    throw new Error('shared release report compiler identity is invalid');
  }
  assertExactSet(Object.keys(report.descriptors), targets.map(({ board }) => board), 'release-report descriptors');
  for (const target of targets) {
    const entry = report.descriptors[target.board];
    const revisions = Object.fromEntries(target.packs.map((pack) => [pack.role, pack.pin.revision]));
    if (!isRecord(entry)
      || entry.path !== slash(relative(directory, target.descriptorPath))
      || entry.sha256 !== target.descriptorSha256
      || entry.runtimeId !== target.descriptor.id
      || entry.compilerRevision !== revisions.compiler
      || entry.sdkRevision !== revisions.sdk
      || entry.boardRevision !== revisions.board) {
      throw new Error(`${target.board} shared release-report binding is invalid`);
    }
  }
  if (!isRecord(report.downloads?.compiler)
    || report.downloads.compiler.rawBytes !== compiler.rawBytes
    || report.downloads.compiler.downloadBytes !== compiler.downloadBytes
    || !isRecord(report.downloads.targets)) {
    throw new Error('shared compiler download evidence is invalid');
  }
  for (const target of targets) {
    const expected = target.packs.reduce((total, pack) => ({
      rawBytes: total.rawBytes + pack.rawBytes,
      downloadBytes: total.downloadBytes + pack.downloadBytes,
    }), { rawBytes: 0, downloadBytes: 0 });
    const actual = report.downloads.targets[target.board];
    if (actual?.rawBytes !== expected.rawBytes || actual.downloadBytes !== expected.downloadBytes) {
      throw new Error(`${target.board} download evidence is invalid`);
    }
  }
  return Object.freeze({
    kind: 'shared',
    boards: Object.freeze(targets.map(({ board }) => board)),
    path: slash(relative(publicRoot, path)),
  });
}

function verifyCompilerTransport(compiler, publicRoot, readFile) {
  let chunks = 0;
  let downloadBytes = 0;
  for (const artifact of compiler.manifest.artifacts) {
    for (const chunk of artifact.chunks) {
      const path = resolveRelative(dirname(compiler.manifestPath), chunk.path, dirname(compiler.manifestPath), 'compiler chunk');
      const bytes = asBuffer(readFile(path));
      const expectedBytes = chunk.compressedSize ?? chunk.size;
      const expectedSha256 = chunk.compressedSha256 ?? chunk.sha256;
      if (bytes.byteLength !== expectedBytes || sha256(bytes) !== expectedSha256) {
        throw new Error(`compiler transport chunk integrity mismatch: ${chunk.path}`);
      }
      chunks += 1;
      downloadBytes += bytes.byteLength;
    }
  }
  if (downloadBytes !== compiler.downloadBytes) {
    throw new Error('compiler Pack download size differs from its manifest');
  }
  return Object.freeze({
    id: compiler.pin.id,
    revision: compiler.pin.revision,
    version: compiler.manifest.version,
    manifest: slash(relative(publicRoot, compiler.manifestPath)),
    artifacts: compiler.manifest.artifacts.length,
    chunks,
    rawBytes: compiler.rawBytes,
    downloadBytes,
  });
}

function createReport({ issues, targets, releaseReports, compilerPacks }) {
  const compilerEvidence = compilerPacks instanceof Map ? [] : compilerPacks;
  return Object.freeze({
    schema: 1,
    policy: 'active-release-closure',
    state: issues.length ? 'invalid' : 'closed',
    counts: Object.freeze({
      runtimes: ACTIVE_RUNTIMES.length,
      descriptors: targets.length,
      releaseReports: releaseReports.length,
      compilerPacks: compilerEvidence.length,
      compilerArtifacts: compilerEvidence.reduce((sum, pack) => sum + pack.artifacts, 0),
      compilerChunks: compilerEvidence.reduce((sum, pack) => sum + pack.chunks, 0),
      compilerDownloadBytes: compilerEvidence.reduce((sum, pack) => sum + pack.downloadBytes, 0),
    }),
    targets: Object.freeze([...targets]),
    releaseReports: Object.freeze([...releaseReports]),
    compilerPacks: Object.freeze([...compilerEvidence]),
    issues: Object.freeze([...issues]),
  });
}

function resolveRelative(base, value, boundary, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} path is invalid`);
  }
  const path = resolve(base, ...value.split('/'));
  assertInside(boundary, path, label);
  return path;
}

function assertInside(root, child, label) {
  const value = relative(resolve(root), resolve(child));
  if (!value || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay inside ${root}`);
  }
}

function assertExactSet(actual, expected, label) {
  const left = [...actual].sort(compareText);
  const right = [...expected].sort(compareText);
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${label} differ: expected ${right.join(', ') || 'none'}; found ${left.join(', ') || 'none'}`);
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function slash(value) {
  return value.split(sep).join('/');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root' || argument === '--output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`);
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2));
    const report = await auditCkActiveRelease({ root: options.root ?? ROOT });
    const body = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) writeFileSync(resolve(options.output), body, 'utf8');
    console.log(body.trimEnd());
    if (report.state !== 'closed') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  }
}
