#!/usr/bin/env node

/**
 * Publish the verified ESP32 Xtensa browser runtimes into one immutable layout.
 *
 * The three targets share the compiler pack and Clang glue. Their SDK and
 * Board packs stay separate so a descriptor can never mix board-specific
 * inputs, while the browser cache can reuse compiler bytes across boards.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(SCRIPT_DIRECTORY, '..');
const DEFAULT_OUTPUT = join(WORKSPACE, 'packages', 'web', 'public', 'esp32', 'v5', 'xtensa');
const DEFAULT_CAPABILITIES = join(WORKSPACE, 'packages', 'web', 'public', 'esp32', 'v1', 'capabilities.json');
const DEFAULT_RELEASE = join(WORKSPACE, 'packages', 'web', 'public', 'esp32', 'v1', 'release.js');
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/;
const TARGETS = Object.freeze([
  Object.freeze({
    key: 'esp32',
    board: 'esp32:esp32:esp32',
    runtimeId: 'esp32-arduino',
    source: join(WORKSPACE, 'var', 'work', 'runtime-v3-esp32-staging'),
  }),
  Object.freeze({
    key: 'esp32s2',
    board: 'esp32:esp32:esp32s2',
    runtimeId: 'esp32-s2-arduino',
    source: join(WORKSPACE, 'var', 'work', 'runtime-v3-s2-staging'),
  }),
  Object.freeze({
    key: 'esp32s3',
    board: 'esp32:esp32:esp32s3',
    runtimeId: 'esp32-s3-arduino',
    source: join(WORKSPACE, 'var', 'work', 'runtime-v3-s3-staging'),
  }),
]);

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function contentAddressedPackManifestPath(packId, revision) {
  if (!IDENTIFIER.test(packId) || !SHA256.test(revision)) {
    throw new TypeError('Pack content address is invalid');
  }
  return `packs/${packId}/${revision}/toolchain.json`;
}

export function publicationDescriptor(descriptor, key) {
  const value = structuredClone(descriptor);
  const roles = new Map(value.packs?.map((pack) => [pack.role, pack]));
  if (
    value.schema !== 2
    || value.packs.length !== 3
    || roles.size !== 3
    || !roles.has('compiler')
    || !roles.has('sdk')
    || !roles.has('board')
  ) {
    throw new Error(`${key} runtime descriptor does not match schema 2 Pack roles`);
  }
  for (const pack of value.packs) {
    pack.manifest = contentAddressedPackManifestPath(pack.id, pack.revision);
  }
  return value;
}

/**
 * Return decoded and transport byte totals from a Pack manifest. The totals
 * deliberately use the manifest's chunk transport fields instead of the
 * copied files, so a publication report is reproducible from immutable Pack
 * metadata alone.
 */
export function packDownloadTotals(manifest) {
  if (!manifest || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length) {
    throw new Error('Pack manifest does not contain artifacts');
  }
  return Object.freeze(manifest.artifacts.reduce((totals, artifact) => {
    if (!Number.isSafeInteger(artifact?.size) || artifact.size < 0 || !Array.isArray(artifact.chunks)) {
      throw new Error(`Pack artifact is invalid: ${String(artifact?.id)}`);
    }
    const transportBytes = artifact.chunks.reduce((sum, chunk) => {
      const bytes = chunk?.compressedSize ?? chunk?.size;
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error(`Pack chunk is invalid: ${String(chunk?.path)}`);
      }
      return sum + bytes;
    }, 0);
    return {
      rawBytes: totals.rawBytes + artifact.size,
      downloadBytes: totals.downloadBytes + transportBytes,
    };
  }, { rawBytes: 0, downloadBytes: 0 }));
}

/** @param {readonly { board: string, compiler: object, sdk: object, boardPack: object }[]} inputs */
export function publicationDownloads(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error('Xtensa publication has no targets');
  const compiler = packDownloadTotals(inputs[0].compiler);
  const targets = {};
  for (const input of inputs) {
    const sdk = packDownloadTotals(input.sdk);
    const boardPack = packDownloadTotals(input.boardPack);
    targets[input.board] = Object.freeze({
      rawBytes: compiler.rawBytes + sdk.rawBytes + boardPack.rawBytes,
      downloadBytes: compiler.downloadBytes + sdk.downloadBytes + boardPack.downloadBytes,
    });
  }
  return Object.freeze({ compiler, targets: Object.freeze(targets) });
}

export function publishEsp32Xtensa({
  output = DEFAULT_OUTPUT,
  targets = TARGETS,
  capabilities = DEFAULT_CAPABILITIES,
  release = DEFAULT_RELEASE,
  updateReleasePins = output === DEFAULT_OUTPUT,
} = {}) {
  const outputRoot = resolve(output);
  const expectedParent = resolve(WORKSPACE, 'packages', 'web', 'public', 'esp32', 'v5');
  if (dirname(outputRoot) !== expectedParent || outputRoot === expectedParent) {
    throw new Error(`refusing to replace an unexpected publication path: ${outputRoot}`);
  }
  if (!Array.isArray(targets) || targets.length !== 3) {
    throw new Error('ESP32 Xtensa publication requires exactly three targets');
  }

  const inputs = targets.map((target) => loadTarget(target));
  assertSharedFile(inputs, join('packs', 'compiler', 'toolchain.json'));
  assertSharedTree(inputs, join('packs', 'compiler'));
  assertSharedFile(inputs, join('clang', 'bundle.js'));
  const publications = [
    { ...inputs[0].packs.compiler, role: 'compiler' },
    ...inputs.flatMap((input) => [
      { ...input.packs.sdk, role: 'sdk' },
      { ...input.packs.board, role: 'board' },
    ]),
  ].map((pack) => ({
    ...pack,
    destination: join(outputRoot, 'packs', pack.manifest.id, pack.manifest.revision),
  }));
  for (const publication of publications) {
    assertImmutableAddress(publication.destination, publication.identity, publication.role);
  }
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });

  const primary = inputs[0];
  copyDirectory(primary.packs.compiler.root, join(
    outputRoot,
    'packs',
    primary.compiler.id,
    primary.compiler.revision,
  ));
  copyDirectory(join(primary.source, 'clang'), join(outputRoot, 'clang'));

  const descriptors = {};
  for (const input of inputs) {
    copyDirectory(input.packs.sdk.root, join(outputRoot, 'packs', input.sdk.id, input.sdk.revision));
    copyDirectory(input.packs.board.root, join(
      outputRoot,
      'packs',
      input.boardPack.id,
      input.boardPack.revision,
    ));
    copyDirectory(join(input.source, 'licenses'), join(outputRoot, 'metadata', input.key, 'licenses'));
    copyDirectory(join(input.source, 'provenance'), join(outputRoot, 'metadata', input.key, 'provenance'));
    for (const path of [
      'release-report.json',
      'runtime.json',
      'source-lock.json',
      'source-offer.md',
      'THIRD_PARTY_NOTICES.md',
    ]) {
      copyFile(join(input.source, path), join(outputRoot, 'metadata', input.key, path));
    }

    const descriptor = publicationDescriptor(input.descriptor, input.key);
    const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
    const descriptorName = `${input.key}.json`;
    writeFileSync(join(outputRoot, descriptorName), descriptorBytes);
    descriptors[input.board] = Object.freeze({
      path: descriptorName,
      sha256: sha256(descriptorBytes),
      runtimeId: descriptor.id,
      compilerRevision: input.compiler.revision,
      sdkRevision: input.sdk.revision,
      boardRevision: input.boardPack.revision,
    });
  }

  const report = {
    schema: 1,
    compiler: {
      id: primary.compiler.id,
      version: primary.compiler.version,
      revision: primary.compiler.revision,
    },
    descriptors,
    downloads: publicationDownloads(inputs),
  };
  writeFileSync(join(outputRoot, 'release-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (updateReleasePins) updateXtensaReleasePins({ report, capabilities, release });
  const totals = treeDigest(outputRoot);
  return Object.freeze({ output: outputRoot, report: Object.freeze(report), ...totals });
}

/** Move an existing verified Xtensa publication to immutable Pack addresses without duplicating Pack bytes. */
export function migrateEsp32XtensaPublication({
  output = DEFAULT_OUTPUT,
  targets = TARGETS,
  capabilities = DEFAULT_CAPABILITIES,
  release = DEFAULT_RELEASE,
  updateReleasePins = resolve(output) === resolve(DEFAULT_OUTPUT),
} = {}) {
  const outputRoot = resolve(output);
  requireDirectory(outputRoot, 'Xtensa publication');
  const inputs = targets.map((target) => loadPublishedTarget(outputRoot, target));
  const compilerIdentity = inputs[0].packs.compiler.identity;
  for (const input of inputs.slice(1)) {
    const identity = input.packs.compiler.identity;
    if (
      input.compiler.id !== inputs[0].compiler.id
      || input.compiler.revision !== inputs[0].compiler.revision
      || identity.sha256 !== compilerIdentity.sha256
      || identity.files !== compilerIdentity.files
      || identity.bytes !== compilerIdentity.bytes
    ) throw new Error(`${input.key} compiler Pack differs from ${inputs[0].key}`);
  }

  const publications = new Map();
  for (const input of inputs) {
    for (const pack of Object.values(input.packs)) {
      const destination = join(outputRoot, 'packs', pack.manifest.id, pack.manifest.revision);
      assertInside(outputRoot, destination, `${pack.role} Pack`);
      assertImmutableAddress(destination, pack.identity, pack.role);
      const key = `${resolve(pack.root)}\0${resolve(destination)}`;
      publications.set(key, { ...pack, destination });
    }
  }
  for (const publication of publications.values()) {
    const source = resolve(publication.root);
    const destination = resolve(publication.destination);
    if (source === destination) continue;
    if (!existsSync(destination)) {
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(source, destination);
    } else if (existsSync(source)) {
      rmSync(source, { recursive: true, force: true });
    }
  }

  const descriptors = {};
  for (const input of inputs) {
    const descriptor = publicationDescriptor(input.descriptor, input.key);
    const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
    writeFileSync(input.descriptorPath, descriptorBytes);
    descriptors[input.board] = Object.freeze({
      path: `${input.key}.json`,
      sha256: sha256(descriptorBytes),
      runtimeId: descriptor.id,
      compilerRevision: input.compiler.revision,
      sdkRevision: input.sdk.revision,
      boardRevision: input.boardPack.revision,
    });
  }
  const reportPath = join(outputRoot, 'release-report.json');
  const previousReport = existsSync(reportPath) ? readJson(reportPath) : {};
  const report = {
    ...previousReport,
    schema: 1,
    compiler: {
      id: inputs[0].compiler.id,
      version: inputs[0].compiler.version,
      revision: inputs[0].compiler.revision,
    },
    descriptors,
    downloads: publicationDownloads(inputs),
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (updateReleasePins) updateXtensaReleasePins({ report, capabilities, release });
  return Object.freeze({ output: outputRoot, report: Object.freeze(report), ...treeDigest(outputRoot) });
}

/** Keep same-origin bootstrap metadata in lockstep with the published Packs. */
export function updateXtensaReleasePins({ report, capabilities = DEFAULT_CAPABILITIES, release = DEFAULT_RELEASE }) {
  const runtime = readJson(capabilities);
  const target = runtime.runtimes?.find((entry) => entry.id === 'esp32-xtensa');
  if (!target || target.toolchain?.id !== report.compiler.id) {
    throw new Error('ESP32 Xtensa capabilities entry does not match the publication');
  }
  target.toolchain.revision = report.compiler.revision;
  writeFileSync(capabilities, `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
  const capabilitiesSha256 = sha256(readFileSync(capabilities));

  let source = readFileSync(release, 'utf8');
  source = replacePinnedValue(source, /(capabilities:\s*Object\.freeze\(\{[\s\S]*?sha256:\s*')[a-f0-9]{64}(')/, capabilitiesSha256, 'capabilities hash');
  source = replacePinnedValue(source, /('esp32-xtensa':\s*Object\.freeze\(\{[\s\S]*?revision:\s*')[a-f0-9]{64}(')/, report.compiler.revision, 'Xtensa revision');
  for (const [board, descriptor] of Object.entries(report.descriptors)) {
    const escaped = board.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    source = replacePinnedValue(
      source,
      new RegExp(`('${escaped}':\\s*Object\\.freeze\\(\\{[\\s\\S]*?sha256:\\s*')[a-f0-9]{64}(')`),
      descriptor.sha256,
      `${board} descriptor hash`,
    );
  }
  writeFileSync(release, source, 'utf8');
}

function replacePinnedValue(source, pattern, value, label) {
  let count = 0;
  const replaced = source.replace(pattern, (_match, prefix, suffix) => {
    count += 1;
    return `${prefix}${value}${suffix}`;
  });
  if (count !== 1) throw new Error(`expected exactly one ${label} in release metadata; found ${count}`);
  return replaced;
}

function loadTarget(target) {
  const source = resolve(target.source);
  for (const path of [
    'runtime.json',
    join('packs', 'compiler', 'toolchain.json'),
    join('packs', 'sdk', 'toolchain.json'),
    join('clang', 'bundle.js'),
  ]) requireFile(join(source, path), `${target.key} ${path}`);
  const descriptor = readJson(join(source, 'runtime.json'));
  if (
    descriptor.schema !== 2
    || descriptor.abi !== 1
    || descriptor.id !== target.runtimeId
    || descriptor.board !== target.board
    || !Array.isArray(descriptor.packs)
  ) throw new Error(`${target.key} runtime descriptor targets unexpected firmware`);
  const packs = new Map(descriptor.packs.map((pack) => [pack.role, pack]));
  if (descriptor.packs.length !== 3 || packs.size !== 3 || !packs.has('compiler') || !packs.has('sdk') || !packs.has('board')) {
    throw new Error(`${target.key} runtime descriptor does not match schema 2 Pack roles`);
  }
  requireFile(join(source, 'packs', 'board', 'toolchain.json'), `${target.key} board Pack`);
  const compiler = readJson(join(source, 'packs', 'compiler', 'toolchain.json'));
  const sdk = readJson(join(source, 'packs', 'sdk', 'toolchain.json'));
  const boardPack = readJson(join(source, 'packs', 'board', 'toolchain.json'));
  const packRoots = {
    compiler: join(source, 'packs', 'compiler'),
    sdk: join(source, 'packs', 'sdk'),
    board: join(source, 'packs', 'board'),
  };
  for (const [role, manifest] of [['compiler', compiler], ['sdk', sdk], ['board', boardPack]]) {
    const pin = packs.get(role);
    if (!pin || pin.id !== manifest.id || pin.revision !== manifest.revision || !SHA256.test(manifest.revision)) {
      throw new Error(`${target.key} ${role} pack does not match its descriptor`);
    }
    const root = role === 'compiler' ? packRoots.compiler : role === 'sdk' ? packRoots.sdk : packRoots.board;
    validatePackManifest(manifest, root, `${target.key} ${role}`);
  }
  return Object.freeze({
    ...target,
    source,
    descriptor,
    compiler,
    sdk,
    boardPack,
    packs: Object.freeze({
      compiler: Object.freeze({ manifest: compiler, root: packRoots.compiler, identity: treeDigest(packRoots.compiler) }),
      sdk: Object.freeze({ manifest: sdk, root: packRoots.sdk, identity: treeDigest(packRoots.sdk) }),
      board: Object.freeze({ manifest: boardPack, root: packRoots.board, identity: treeDigest(packRoots.board) }),
    }),
  });
}

function loadPublishedTarget(outputRoot, target) {
  const descriptorPath = join(outputRoot, `${target.key}.json`);
  const descriptor = readJson(descriptorPath);
  if (
    descriptor.schema !== 2
    || descriptor.abi !== 1
    || descriptor.id !== target.runtimeId
    || descriptor.board !== target.board
    || !Array.isArray(descriptor.packs)
  ) throw new Error(`${target.key} published descriptor targets unexpected firmware`);
  const roles = new Map(descriptor.packs.map((pack) => [pack.role, pack]));
  if (descriptor.packs.length !== 3 || roles.size !== 3 || !roles.has('compiler') || !roles.has('sdk') || !roles.has('board')) {
    throw new Error(`${target.key} published descriptor does not contain compiler, sdk, and board packs`);
  }
  const loadPack = (role) => {
    const pin = roles.get(role);
    if (!IDENTIFIER.test(pin?.id) || !SHA256.test(pin?.revision) || typeof pin?.manifest !== 'string') {
      throw new Error(`${target.key} ${role} Pack pin is invalid`);
    }
    const manifestPath = resolve(outputRoot, ...pin.manifest.split('/'));
    assertInside(outputRoot, manifestPath, `${target.key} ${role} Pack manifest`);
    const root = dirname(manifestPath);
    const manifest = readJson(manifestPath);
    if (manifest.id !== pin.id || manifest.revision !== pin.revision) {
      throw new Error(`${target.key} ${role} Pack does not match its descriptor`);
    }
    validatePackManifest(manifest, root, `${target.key} ${role}`);
    return Object.freeze({ role, manifest, root, identity: treeDigest(root) });
  };
  const packs = Object.freeze({
    compiler: loadPack('compiler'),
    sdk: loadPack('sdk'),
    board: loadPack('board'),
  });
  return Object.freeze({
    ...target,
    descriptor,
    descriptorPath,
    compiler: packs.compiler.manifest,
    sdk: packs.sdk.manifest,
    boardPack: packs.board.manifest,
    packs,
  });
}

function validatePackManifest(manifest, root, label) {
  if (
    ![1, 2].includes(manifest?.schema)
    || !IDENTIFIER.test(manifest.id)
    || typeof manifest.version !== 'string'
    || !SHA256.test(manifest.revision)
    || !Array.isArray(manifest.artifacts)
    || !manifest.artifacts.length
  ) throw new Error(`${label} Pack manifest is invalid`);
  const revision = sha256(Buffer.from(JSON.stringify({
    schema: manifest.schema,
    id: manifest.id,
    version: manifest.version,
    artifacts: manifest.artifacts,
  }), 'utf8'));
  if (revision !== manifest.revision) throw new Error(`${label} Pack revision mismatch`);
  for (const artifact of manifest.artifacts) {
    if (!Array.isArray(artifact.chunks) || !artifact.chunks.length) {
      throw new Error(`${label} Pack artifact is invalid: ${String(artifact.id)}`);
    }
    for (const chunk of artifact.chunks) {
      if (typeof chunk.path !== 'string' || chunk.path.includes('..') || chunk.path.startsWith('/')) {
        throw new Error(`${label} Pack chunk path is invalid`);
      }
      const path = resolve(root, ...chunk.path.split('/'));
      const body = readFileSync(path);
      const expectedSize = chunk.compressedSize ?? chunk.size;
      const expectedSha256 = chunk.compressedSha256 ?? chunk.sha256;
      if (body.byteLength !== expectedSize || sha256(body) !== expectedSha256) {
        throw new Error(`${label} Pack chunk integrity mismatch: ${chunk.path}`);
      }
    }
  }
}

function assertImmutableAddress(destination, identity, role) {
  if (!existsSync(destination)) return;
  const published = treeDigest(destination);
  if (
    published.sha256 !== identity.sha256
    || published.files !== identity.files
    || published.bytes !== identity.bytes
  ) throw new Error(`immutable ${role} Pack address contains different bytes: ${destination}`);
}

function assertSharedFile(inputs, path) {
  const expected = sha256(readFileSync(join(inputs[0].source, path)));
  for (const input of inputs.slice(1)) {
    if (sha256(readFileSync(join(input.source, path))) !== expected) {
      throw new Error(`${path} differs between ${inputs[0].key} and ${input.key}`);
    }
  }
}

function assertSharedTree(inputs, path) {
  const expected = treeDigest(join(inputs[0].source, path));
  for (const input of inputs.slice(1)) {
    const actual = treeDigest(join(input.source, path));
    if (actual.sha256 !== expected.sha256 || actual.files !== expected.files || actual.bytes !== expected.bytes) {
      throw new Error(`${path} differs between ${inputs[0].key} and ${input.key}`);
    }
  }
}

function treeDigest(root) {
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  for (const path of walkFiles(root)) {
    const body = readFileSync(path);
    const name = relative(root, path).split(sep).join('/');
    hash.update(name).update('\0').update(body).update('\0');
    files += 1;
    bytes += body.byteLength;
  }
  return Object.freeze({ files, bytes, sha256: hash.digest('hex') });
}

function walkFiles(root) {
  requireDirectory(root, 'publication tree');
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`publication input contains an unsupported entry: ${path}`);
  }
  return files;
}

function copyDirectory(source, destination) {
  requireDirectory(source, 'publication directory');
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
}

function copyFile(source, destination) {
  requireFile(source, 'publication file');
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { errorOnExist: true, force: false });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
}

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${label} is missing: ${path}`);
}

function assertInside(root, child, label) {
  const value = relative(resolve(root), resolve(child));
  if (!value || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay inside ${root}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = process.argv.includes('--migrate-existing')
      ? migrateEsp32XtensaPublication()
      : publishEsp32Xtensa();
    console.log(`Published ESP32 Xtensa browser runtime: ${relative(WORKSPACE, result.output)}`);
    console.log(`${result.files} files, ${(result.bytes / 1024 / 1024).toFixed(1)} MiB, tree sha256=${result.sha256}`);
    for (const [board, descriptor] of Object.entries(result.report.descriptors)) {
      console.log(`${board} ${descriptor.path} sha256=${descriptor.sha256}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  }
}
