#!/usr/bin/env node

/**
 * Publish a fully verified catalog staging registry beside the conservative
 * 12-library release. The old directory remains available for rollback.
 */
import { createHash, webcrypto } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createBrowserToolchainPackLoader } from '../packages/web/public/avr/v4/toolchain-pack.js';
import {
  isEsp32BrowserLibraryImmutableManifestPath,
  validateEsp32BrowserLibraryRegistry,
} from '../packages/web/public/esp32/v1/library-registry.js';
import { createBrowserLibraryReleaseEvidence } from './audit-ck-browser-library-release.mjs';
import {
  inferCatalogRegistryDependencies,
  installImmutableCatalogPackDirectory,
  resetCatalogInferredDependencies,
} from './build-browser-esp32-catalog-packs.mjs';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(SCRIPT_DIRECTORY, '..');
const DEFAULT_STAGING = join(WORKSPACE, 'var', 'browser-library-catalog-packs');
const DEFAULT_OUTPUT = join(WORKSPACE, 'packages', 'web', 'public', 'esp32', 'v1', 'libraries-catalog');
const DEFAULT_RELEASE = join(WORKSPACE, 'packages', 'web', 'public', 'esp32', 'v1', 'release.js');
const DEFAULT_EVIDENCE = join(WORKSPACE, 'var', 'reports', 'ck-browser-library-matrix-primary.json');
const DEFAULT_FIXTURES = join(WORKSPACE, 'scripts', 'fixtures', 'ck-browser-library-compatibility.json');
const SHA256 = /^[a-f0-9]{64}$/;

export function parseCatalogPublishArgs(argv) {
  const options = {
    staging: DEFAULT_STAGING,
    output: DEFAULT_OUTPUT,
    release: DEFAULT_RELEASE,
    evidence: DEFAULT_EVIDENCE,
    replace: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--replace') {
      options.replace = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    if (argument === '--staging') options.staging = resolve(value);
    else if (argument === '--output') options.output = resolve(value);
    else if (argument === '--release') options.release = resolve(value);
    else if (argument === '--evidence') options.evidence = resolve(value);
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

export async function publishBrowserEsp32CatalogPacks(options = {}) {
  const staging = resolve(options.staging ?? DEFAULT_STAGING);
  const output = resolve(options.output ?? DEFAULT_OUTPUT);
  const releasePath = resolve(options.release ?? DEFAULT_RELEASE);
  const evidencePath = resolve(options.evidence ?? DEFAULT_EVIDENCE);
  assertPublicationPaths({ staging, output, releasePath });

  const stagingRegistryPath = join(staging, 'registry.staging.json');
  requireFile(stagingRegistryPath, 'staging registry');
  const registry = inferCatalogRegistryDependencies(
    resetCatalogInferredDependencies(JSON.parse(readFileSync(stagingRegistryPath, 'utf8'))),
    staging,
  );
  const registryBytes = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const validated = validateEsp32BrowserLibraryRegistry(registry, pathToFileURL(stagingRegistryPath).href);
  if (validated.libraries.length < 100) {
    throw new Error(`catalog publication requires at least 100 libraries, received ${validated.libraries.length}`);
  }

  requireFile(evidencePath, 'Browser Library Matrix evidence');
  const evidenceBytes = readFileSync(evidencePath);
  const fixtureBytes = readFileSync(DEFAULT_FIXTURES);
  const releaseEvidence = await createBrowserLibraryReleaseEvidence({
    report: JSON.parse(evidenceBytes.toString('utf8')),
    reportBytes: evidenceBytes,
    registryJson: registry,
    registryBytes,
    registryUrl: pathToFileURL(stagingRegistryPath),
    fixtureJson: JSON.parse(fixtureBytes.toString('utf8')),
    fixtureBytes,
    expectedShards: 8,
  });
  if (releaseEvidence.status !== 'success') {
    throw new Error(`catalog publication evidence was rejected: ${releaseEvidence.findings.join('; ')}`);
  }

  const verification = await verifyRegistryPacks(staging, validated);
  const parent = dirname(output);
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.libraries-catalog-publish-${process.pid}-${Date.now()}`);
  const backup = `${output}.previous-${Date.now()}`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });

  try {
    if (existsSync(output)) {
      if (!options.replace) throw new Error(`catalog publication already exists: ${output}; pass --replace to rotate it`);
      cpSync(output, temporary, { recursive: true, errorOnExist: false, force: true });
    }
    for (const pack of verification.packRevisions) {
      installCatalogPackRevision(staging, temporary, pack.manifest, pack.revision);
    }
    writeFileSync(join(temporary, 'registry.json'), registryBytes);

    const legacyNotice = join(dirname(output), 'libraries', 'THIRD_PARTY_NOTICES.md');
    if (existsSync(legacyNotice)) cpSync(legacyNotice, join(temporary, 'THIRD_PARTY_NOTICES.md'));

    const releaseBody = updateReleaseLibraryPin(
      readFileSync(releasePath, 'utf8'),
      relative(dirname(releasePath), join(output, 'registry.json')).split(sep).join('/'),
      sha256(registryBytes),
    );

    if (existsSync(output)) {
      renameSync(output, backup);
    }
    renameSync(temporary, output);
    writeFileSync(releasePath, releaseBody, 'utf8');

    return Object.freeze({
      output,
      registry: join(output, 'registry.json'),
      registrySha256: sha256(registryBytes),
      libraries: validated.libraries.length,
      packs: verification.packs,
      artifactBytes: verification.artifactBytes,
      matrixFingerprint: releaseEvidence.matrix.fingerprint,
      matrixReportSha256: releaseEvidence.matrix.reportSha256,
      backup: existsSync(backup) ? backup : null,
    });
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function updateReleaseLibraryPin(source, registryPath, registrySha256) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}\.json$/.test(registryPath) || !SHA256.test(registrySha256)) {
    throw new Error('catalog release pin is invalid');
  }
  const pattern = /(libraries:\s*Object\.freeze\(\{\s*path:\s*')[^']+(',\s*\/\/[^\n]*\n\s*sha256:\s*')[a-f0-9]{64}(')/;
  if (!pattern.test(source)) throw new Error('ESP32 library release pin block was not found');
  const updated = source.replace(pattern, `$1${registryPath}$2${registrySha256}$3`);
  return updated;
}

async function verifyRegistryPacks(staging, registry) {
  const packRevisions = [];
  let packs = 0;
  let artifactBytes = 0;
  for (const library of registry.libraries) {
    for (const version of library.versions) {
      const manifestPath = resolve(staging, ...version.pack.manifest.split('/'));
      if (!isEsp32BrowserLibraryImmutableManifestPath(version.pack.manifest, version.pack.revision)) {
        throw new Error(`${library.name} must be migrated to an immutable revision manifest path before publication`);
      }
      assertWithin(staging, manifestPath, `${library.name} manifest`);
      requireFile(manifestPath, `${library.name} manifest`);
      packRevisions.push(Object.freeze({
        manifest: version.pack.manifest,
        revision: version.pack.revision,
      }));
      const loader = createBrowserToolchainPackLoader({
        manifestUrl: pathToFileURL(manifestPath),
        expectedId: version.pack.id,
        expectedRevision: version.pack.revision,
        fetchFn: fileFetch,
        cryptoRef: webcrypto,
      });
      const artifact = await loader.loadArtifact(version.pack.artifact);
      artifactBytes += artifact.bytes.byteLength;
      packs += 1;
    }
  }
  return Object.freeze({ packRevisions: Object.freeze(packRevisions), packs, artifactBytes });
}

/** Install one revision directory without overwriting an already published revision. */
export function installCatalogPackRevision(staging, output, manifest, revision) {
  if (!isEsp32BrowserLibraryImmutableManifestPath(manifest, revision)) {
    throw new Error('catalog Pack manifest is not revision-addressed');
  }
  const segments = manifest.split('/');
  const sourceManifest = resolve(staging, ...segments);
  const destinationManifest = resolve(output, ...segments);
  assertWithin(staging, sourceManifest, 'catalog Pack manifest');
  assertWithin(output, destinationManifest, 'catalog Pack manifest');
  requireFile(sourceManifest, 'catalog Pack manifest');
  const manifestJson = JSON.parse(readFileSync(sourceManifest, 'utf8'));
  if (manifestJson.revision !== revision) throw new Error('catalog Pack manifest revision does not match its immutable path');
  return installImmutableCatalogPackDirectory(dirname(sourceManifest), dirname(destinationManifest));
}

async function fileFetch(input, init = {}) {
  const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'file:') return fetch(input, init);
  if (method !== 'GET') return new Response('method not allowed', { status: 405 });
  try {
    const bytes = readFileSync(fileURLToPath(url));
    return new Response(bytes, { status: 200 });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

function assertPublicationPaths({ staging, output, releasePath }) {
  requireDirectory(staging, 'catalog staging directory');
  requireFile(releasePath, 'ESP32 release metadata');
  const expectedParent = resolve(WORKSPACE, 'packages', 'web', 'public', 'esp32', 'v1');
  if (dirname(output) !== expectedParent || output === expectedParent) {
    throw new Error(`refusing to publish outside the ESP32 v1 directory: ${output}`);
  }
}

function assertWithin(root, path, label) {
  const value = relative(root, path);
  if (!value || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`${label} escapes the staging directory`);
  }
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
}

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${label} is missing: ${path}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishBrowserEsp32CatalogPacks(parseCatalogPublishArgs(process.argv.slice(2)))
    .then((result) => {
      console.log(`Published ESP32 browser catalog: ${relative(WORKSPACE, result.output)}`);
      console.log(`${result.libraries} libraries, ${result.packs} packs, ${result.artifactBytes} artifact bytes`);
      console.log(`registry sha256=${result.registrySha256}`);
      console.log(`matrix fingerprint=${result.matrixFingerprint} report sha256=${result.matrixReportSha256}`);
      if (result.backup) console.log(`previous=${result.backup}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
