#!/usr/bin/env node

/**
 * Deduplicate the C3/C6 compiler Pack without rebuilding it. The two runtime
 * descriptors keep board-specific SDK/Board paths and point at one immutable
 * compiler directory addressed by Pack id and revision.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
const DEFAULT_PUBLICATION_ROOT = join(WORKSPACE, 'packages', 'web', 'public', 'esp32', 'v2');
const DEFAULT_CAPABILITIES = join(WORKSPACE, 'packages', 'web', 'public', 'esp32', 'v1', 'capabilities.json');
const DEFAULT_RELEASE = join(WORKSPACE, 'packages', 'web', 'public', 'esp32', 'v1', 'release.js');
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/;
const PIN_FILE_OPERATIONS = Object.freeze({
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
});
const TARGETS = Object.freeze([
  Object.freeze({
    key: 'esp32c3',
    board: 'esp32:esp32:esp32c3',
    runtimeId: 'esp32-c3-arduino',
    source: join(DEFAULT_PUBLICATION_ROOT, 'runtime'),
  }),
  Object.freeze({
    key: 'esp32c6',
    board: 'esp32:esp32:esp32c6',
    runtimeId: 'esp32-c6-arduino',
    source: join(DEFAULT_PUBLICATION_ROOT, 'runtime-c6'),
  }),
]);

export function contentAddressedCompilerManifestPath(packId, revision) {
  if (!IDENTIFIER.test(packId) || !SHA256.test(revision)) {
    throw new TypeError('compiler Pack content address is invalid');
  }
  return `../toolchains/${packId}/${revision}/toolchain.json`;
}

export function contentAddressedRuntimePackManifestPath(packId, revision) {
  if (!IDENTIFIER.test(packId) || !SHA256.test(revision)) {
    throw new TypeError('runtime Pack content address is invalid');
  }
  return `../packs/${packId}/${revision}/toolchain.json`;
}

export function publishEsp32RiscvSharedToolchain({
  publicationRoot = DEFAULT_PUBLICATION_ROOT,
  targets = TARGETS,
  removeDuplicates = true,
} = {}) {
  const root = resolve(publicationRoot);
  if (!Array.isArray(targets) || targets.length !== 2) {
    throw new Error('ESP32 RISC-V compiler publication requires exactly C3 and C6');
  }
  const inputs = targets.map((target) => loadTarget(target, root));
  const primary = inputs[0];
  for (const input of inputs.slice(1)) {
    if (
      input.compiler.id !== primary.compiler.id
      || input.compiler.revision !== primary.compiler.revision
      || input.compilerIdentity.sha256 !== primary.compilerIdentity.sha256
      || input.compilerIdentity.files !== primary.compilerIdentity.files
      || input.compilerIdentity.bytes !== primary.compilerIdentity.bytes
    ) throw new Error(`${input.key} compiler Pack differs from ${primary.key}`);
  }

  const publications = inputs.flatMap((input) => input.packs.map((pack) => ({
    ...pack,
    key: input.key,
    destination: pack.role === 'compiler'
      ? join(root, 'toolchains', pack.manifest.id, pack.manifest.revision)
      : join(root, 'packs', pack.manifest.id, pack.manifest.revision),
  })));
  for (const publication of publications) {
    assertInside(root, publication.destination, `${publication.role} Pack`);
    assertImmutableAddress(publication.destination, publication.identity, publication.role);
  }
  for (const publication of publications) {
    publishPackDirectory(publication, removeDuplicates);
  }
  const destination = join(root, 'toolchains', primary.compiler.id, primary.compiler.revision);

  const descriptorPins = {};
  for (const input of inputs) {
    for (const pin of input.descriptor.packs) {
      pin.manifest = pin.role === 'compiler'
        ? contentAddressedCompilerManifestPath(pin.id, pin.revision)
        : contentAddressedRuntimePackManifestPath(pin.id, pin.revision);
    }
    const descriptorBytes = Buffer.from(`${JSON.stringify(input.descriptor, null, 2)}\n`, 'utf8');
    writeFileSync(join(input.source, 'runtime.json'), descriptorBytes);
    const reportPath = join(input.source, 'release-report.json');
    if (existsSync(reportPath)) {
      const report = readJson(reportPath);
      report.descriptorSha256 = sha256(descriptorBytes);
      for (const pack of input.packs) {
        if (report.packs?.[pack.role] && typeof report.packs[pack.role] === 'object') {
          report.packs[pack.role].revision = pack.manifest.revision;
          report.packs[pack.role].downloadBytes = packDownloadBytes(pack.manifest);
          report.packs[pack.role].manifest = input.descriptor.packs.find((pin) => pin.role === pack.role).manifest;
          report.packs[pack.role].contentAddressed = true;
          if (pack.role === 'compiler') report.packs[pack.role].shared = true;
        }
      }
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    descriptorPins[input.board] = Object.freeze({
      path: relative(root, join(input.source, 'runtime.json')).split(sep).join('/'),
      sha256: sha256(descriptorBytes),
    });
  }

  const beforeBytes = primary.compilerIdentity.bytes * inputs.length;
  const afterBytes = primary.compilerIdentity.bytes;
  return Object.freeze({
    publicationRoot: root,
    manifest: relative(root, join(destination, 'toolchain.json')).split(sep).join('/'),
    compiler: Object.freeze({
      id: primary.compiler.id,
      revision: primary.compiler.revision,
      files: primary.compilerIdentity.files,
      bytes: primary.compilerIdentity.bytes,
      downloadBytes: packDownloadBytes(primary.compiler),
    }),
    descriptorPins: Object.freeze(descriptorPins),
    beforeBytes,
    afterBytes,
    savedBytes: beforeBytes - afterBytes,
  });
}

export function updateRiscvReleasePins({
  report,
  compiler = report?.compiler,
  descriptorPins = report?.descriptors ?? report?.descriptorPins,
  capabilities = DEFAULT_CAPABILITIES,
  release = DEFAULT_RELEASE,
  fileOperations,
}) {
  if (!IDENTIFIER.test(compiler?.id) || !SHA256.test(compiler?.revision)) {
    throw new Error('RISC-V compiler pin is invalid');
  }
  const boards = TARGETS.map((target) => target.board);
  const suppliedBoards = descriptorPins && typeof descriptorPins === 'object' && !Array.isArray(descriptorPins)
    ? Object.keys(descriptorPins).sort()
    : [];
  if (
    suppliedBoards.length !== boards.length
    || suppliedBoards.some((board, index) => board !== [...boards].sort()[index])
    || boards.some((board) => !SHA256.test(descriptorPins?.[board]?.sha256))
  ) {
    throw new Error('RISC-V descriptor pins are incomplete');
  }

  const operations = Object.freeze({ ...PIN_FILE_OPERATIONS, ...fileOperations });
  if (resolve(capabilities) === resolve(release)) {
    throw new Error('RISC-V capabilities and release metadata must be separate files');
  }
  const currentCapabilitiesBytes = operations.readFileSync(capabilities);
  const runtime = JSON.parse(currentCapabilitiesBytes.toString('utf8'));
  const runtimeMatches = Array.isArray(runtime?.runtimes)
    ? runtime.runtimes.filter((entry) => entry?.id === 'esp32-riscv')
    : [];
  if (runtime?.schema !== 1 || runtimeMatches.length !== 1) {
    throw new Error('ESP32 RISC-V capabilities entry is invalid');
  }
  const target = runtimeMatches[0];
  if (
    target.toolchain?.id !== compiler.id
    || !SHA256.test(target.toolchain?.revision)
  ) {
    throw new Error('ESP32 RISC-V capabilities entry does not match the publication');
  }

  const currentReleaseBytes = operations.readFileSync(release);
  let source = currentReleaseBytes.toString('utf8');
  const currentCapabilitiesSha256 = sha256(currentCapabilitiesBytes);
  const pinnedCapabilitiesSha256 = extractPinnedValue(
    source,
    /capabilities:\s*Object\.freeze\(\{[\s\S]*?sha256:\s*'([a-f0-9]{64})'/g,
    'capabilities hash',
  );
  if (pinnedCapabilitiesSha256 !== currentCapabilitiesSha256) {
    throw new Error('RISC-V release metadata capabilities hash drift detected');
  }
  const releaseToolchainId = extractPinnedValue(
    source,
    /'esp32-riscv':\s*Object\.freeze\(\{[\s\S]*?toolchainId:\s*'([^']+)'/g,
    'RISC-V toolchain id',
  );
  if (releaseToolchainId !== compiler.id) {
    throw new Error('RISC-V release metadata toolchain identity drift detected');
  }
  const currentReleaseRevision = extractPinnedValue(
    source,
    /'esp32-riscv':\s*Object\.freeze\(\{[\s\S]*?revision:\s*'([a-f0-9]{64})'/g,
    'RISC-V revision',
  );
  if (currentReleaseRevision !== target.toolchain.revision) {
    throw new Error('RISC-V release metadata runtime revision drift detected');
  }

  target.toolchain.revision = compiler.revision;
  const nextCapabilitiesBytes = Buffer.from(`${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
  source = replacePinnedValue(
    source,
    /(capabilities:\s*Object\.freeze\(\{[\s\S]*?sha256:\s*')([a-f0-9]{64})(')/g,
    sha256(nextCapabilitiesBytes),
    'capabilities hash',
  );
  source = replacePinnedValue(
    source,
    /('esp32-riscv':\s*Object\.freeze\(\{[\s\S]*?revision:\s*')([a-f0-9]{64})(')/g,
    compiler.revision,
    'RISC-V revision',
  );
  for (const board of boards) {
    const pin = descriptorPins[board];
    const escaped = board.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    source = replacePinnedValue(
      source,
      new RegExp(`('${escaped}':\\s*Object\\.freeze\\(\\{[\\s\\S]*?sha256:\\s*')([a-f0-9]{64})(')`, 'g'),
      pin.sha256,
      `${board} descriptor hash`,
    );
  }
  commitPinFiles([
    { path: capabilities, bytes: nextCapabilitiesBytes },
    { path: release, bytes: Buffer.from(source, 'utf8') },
  ], operations);
}

function replacePinnedValue(source, pattern, value, label) {
  let count = 0;
  const replaced = source.replace(pattern, (_match, prefix, _previous, suffix) => {
    count += 1;
    return `${prefix}${value}${suffix}`;
  });
  if (count !== 1) throw new Error(`expected exactly one ${label} in release metadata; found ${count}`);
  return replaced;
}

function extractPinnedValue(source, pattern, label) {
  let count = 0;
  let value;
  source.replace(pattern, (_match, captured) => {
    count += 1;
    value = captured;
    return _match;
  });
  if (count !== 1) throw new Error(`expected exactly one ${label} in release metadata; found ${count}`);
  return value;
}

function commitPinFiles(files, operations) {
  const transactions = [];
  let preserveRecoveryFiles = false;
  try {
    for (const file of files) {
      const directory = operations.mkdtempSync(join(dirname(file.path), '.riscv-release-pins-'));
      const transaction = {
        ...file,
        directory,
        staged: join(directory, 'next'),
        backup: join(directory, 'previous'),
        backedUp: false,
        installed: false,
      };
      transactions.push(transaction);
      operations.writeFileSync(transaction.staged, file.bytes);
    }
    for (const transaction of transactions) {
      operations.renameSync(transaction.path, transaction.backup);
      transaction.backedUp = true;
      operations.renameSync(transaction.staged, transaction.path);
      transaction.installed = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const transaction of [...transactions].reverse()) {
      try {
        if (transaction.installed && operations.existsSync(transaction.path)) {
          operations.rmSync(transaction.path, { force: true });
        }
        if (transaction.backedUp && operations.existsSync(transaction.backup)) {
          operations.renameSync(transaction.backup, transaction.path);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      preserveRecoveryFiles = true;
      throw new AggregateError(
        [error, ...rollbackErrors],
        'RISC-V release pin update failed and rollback was incomplete',
      );
    }
    throw error;
  } finally {
    if (!preserveRecoveryFiles) {
      for (const transaction of transactions) {
        try {
          operations.rmSync(transaction.directory, { recursive: true, force: true });
        } catch {
          // The pin files are already coherent; stale private staging is harmless.
        }
      }
    }
  }
}

/**
 * Promote freshly-built C3/C6 runtimes from an external staging directory.
 * The publisher itself only accepts sources below the publication root so all
 * validation and content-addressed deduplication still runs in one place.
 * Staging is copied into a private sibling, then swapped into the public
 * runtime paths only after both descriptors have been validated and rewritten.
 */
export function publishEsp32RiscvFromStaging({
  stagingRoot,
  publicationRoot = DEFAULT_PUBLICATION_ROOT,
  removeDuplicates = true,
} = {}) {
  if (typeof stagingRoot !== 'string' || !stagingRoot.trim()) {
    throw new TypeError('RISC-V staging root is required');
  }
  const root = resolve(publicationRoot);
  const sourceRoot = resolve(stagingRoot);
  const stagingTargets = TARGETS.map((target) => ({
    ...target,
    source: join(sourceRoot, target.key === 'esp32c3' ? 'runtime-v2-c3-staging' : 'runtime-v2-c6-staging'),
  }));
  for (const target of stagingTargets) {
    assertInside(sourceRoot, target.source, `${target.key} staging runtime`);
    requireDirectory(target.source, `${target.key} staging runtime`);
  }

  const promotionRoot = mkdtempSync(join(root, '.riscv-promotion-'));
  const stagedTargets = stagingTargets.map((target) => ({
    ...target,
    source: join(promotionRoot, target.key === 'esp32c3' ? 'runtime' : 'runtime-c6'),
  }));
  const backups = [];
  let swapped = false;
  try {
    for (let index = 0; index < stagingTargets.length; index += 1) {
      cpSync(stagingTargets[index].source, stagedTargets[index].source, { recursive: true });
    }
    const result = publishEsp32RiscvSharedToolchain({
      publicationRoot: root,
      targets: stagedTargets,
      removeDuplicates,
    });
    for (const target of stagedTargets) {
      const finalPath = join(root, target.key === 'esp32c3' ? 'runtime' : 'runtime-c6');
      if (existsSync(finalPath)) {
        const backup = `${finalPath}.before-promotion`;
        rmSync(backup, { recursive: true, force: true });
        renameSync(finalPath, backup);
        backups.push({ finalPath, backup });
      }
      renameSync(target.source, finalPath);
    }
    swapped = true;
    const descriptorPins = {};
    for (const target of TARGETS) {
      const descriptorPath = join(root, target.key === 'esp32c3' ? 'runtime' : 'runtime-c6', 'runtime.json');
      const descriptorBytes = readFileSync(descriptorPath);
      descriptorPins[target.board] = Object.freeze({
        path: relative(root, descriptorPath).split(sep).join('/'),
        sha256: sha256(descriptorBytes),
      });
    }
    return Object.freeze({ ...result, descriptorPins: Object.freeze(descriptorPins) });
  } catch (error) {
    if (!swapped) {
      for (const backup of backups.reverse()) {
        if (existsSync(backup.finalPath)) rmSync(backup.finalPath, { recursive: true, force: true });
        if (existsSync(backup.backup)) renameSync(backup.backup, backup.finalPath);
      }
    }
    throw error;
  } finally {
    rmSync(promotionRoot, { recursive: true, force: true });
    if (swapped) {
      for (const backup of backups) rmSync(backup.backup, { recursive: true, force: true });
    }
  }
}

function loadTarget(target, publicationRoot) {
  const source = resolve(target.source);
  assertInside(publicationRoot, source, `${target.key} runtime`);
  const descriptor = readJson(join(source, 'runtime.json'));
  if (
    descriptor.schema !== 2
    || descriptor.abi !== 1
    || descriptor.id !== target.runtimeId
    || descriptor.board !== target.board
    || !Array.isArray(descriptor.packs)
  ) throw new Error(`${target.key} runtime descriptor targets unexpected firmware`);
  const pins = new Map(descriptor.packs.map((pack) => [pack.role, pack]));
  if (
    descriptor.packs.length !== 3
    || pins.size !== 3
    || !pins.has('compiler')
    || !pins.has('sdk')
    || !pins.has('board')
  ) throw new Error(`${target.key} runtime descriptor does not match schema 2 Pack roles`);
  const compilerPin = pins.get('compiler');
  if (!compilerPin || !IDENTIFIER.test(compilerPin.id) || !SHA256.test(compilerPin.revision)) {
    throw new Error(`${target.key} compiler Pack pin is invalid`);
  }
  const packs = descriptor.packs.map((pin) => {
    if (!IDENTIFIER.test(pin.id) || !SHA256.test(pin.revision) || typeof pin.manifest !== 'string') {
      throw new Error(`${target.key} ${pin.role} Pack pin is invalid`);
    }
    const manifestPath = resolve(source, ...pin.manifest.split('/'));
    assertInside(publicationRoot, manifestPath, `${target.key} ${pin.role} manifest`);
    const root = dirname(manifestPath);
    const manifest = readJson(manifestPath);
    validatePackManifest(manifest, root, `${target.key} ${pin.role}`);
    if (manifest.id !== pin.id || manifest.revision !== pin.revision) {
      throw new Error(`${target.key} ${pin.role} Pack does not match its descriptor`);
    }
    return Object.freeze({ role: pin.role, manifest, root, identity: treeDigest(root) });
  });
  const compilerPack = packs.find((pack) => pack.role === 'compiler');
  if (!compilerPack) {
    throw new Error(`${target.key} compiler Pack is missing`);
  }
  return Object.freeze({
    ...target,
    source,
    descriptor,
    packs: Object.freeze(packs),
    compiler: compilerPack.manifest,
    compilerRoot: compilerPack.root,
    compilerIdentity: compilerPack.identity,
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
      assertInside(root, path, `${label} Pack chunk`);
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

function publishPackDirectory(publication, removeDuplicates) {
  const source = resolve(publication.root);
  const destination = resolve(publication.destination);
  if (source === destination) return;
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
    return;
  }
  if (removeDuplicates && existsSync(source)) {
    rmSync(source, { recursive: true, force: true });
  }
}

function packDownloadBytes(manifest) {
  return manifest.artifacts.reduce((packTotal, artifact) => (
    packTotal + artifact.chunks.reduce((artifactTotal, chunk) => (
      artifactTotal + (chunk.compressedSize ?? chunk.size)
    ), 0)
  ), 0);
}

function treeDigest(root) {
  requireDirectory(root, 'Pack directory');
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
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Pack contains an unsupported entry: ${path}`);
  }
  return files;
}

function readJson(path) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`JSON file is missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const stagingFlag = process.argv.indexOf('--staging-root');
    const stagingRoot = stagingFlag >= 0 ? process.argv[stagingFlag + 1] : process.env.CK_RISCV_STAGING_ROOT;
    if (stagingFlag >= 0 && (!stagingRoot || stagingRoot.startsWith('--'))) {
      throw new Error('--staging-root requires a directory');
    }
    const result = stagingRoot
      ? publishEsp32RiscvFromStaging({ stagingRoot })
      : publishEsp32RiscvSharedToolchain();
    updateRiscvReleasePins({
      report: { compiler: result.compiler, descriptors: result.descriptorPins },
    });
    console.log(`Published ${result.compiler.id}@${result.compiler.revision}`);
    console.log(`Shared URL: ${result.manifest}`);
    console.log(`Compiler cache: ${result.beforeBytes} -> ${result.afterBytes} bytes; saved ${result.savedBytes} bytes`);
    for (const [board, pin] of Object.entries(result.descriptorPins)) {
      console.log(`${board} ${pin.path} sha256=${pin.sha256}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  }
}
