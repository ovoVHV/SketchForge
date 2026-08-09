#!/usr/bin/env node

/** Re-pin a registry after an integrity-preserving Pack transport migration. */
import { createHash, webcrypto } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createBrowserToolchainPackLoader } from '../packages/web/public/avr/v3/toolchain-pack.js';
import {
  ESP32_BROWSER_LIBRARY_PACK_LIMITS,
  validateEsp32BrowserLibraryRegistry,
} from '../packages/web/public/esp32/v1/library-registry.js';
import { updateReleaseLibraryPin } from './publish-browser-esp32-catalog-packs.mjs';

const WORKSPACE = resolve(import.meta.dirname, '..');
const DEFAULT_REGISTRY = joinWorkspace('packages', 'web', 'public', 'esp32', 'v1', 'libraries-catalog', 'registry.json');
const DEFAULT_RELEASE = joinWorkspace('packages', 'web', 'public', 'esp32', 'v1', 'release.js');

export async function repinBrowserEsp32LibraryRegistry({
  registryPath = DEFAULT_REGISTRY,
  releasePath = DEFAULT_RELEASE,
} = {}) {
  const registryFile = resolve(registryPath);
  const releaseFile = resolve(releasePath);
  requireFile(registryFile, 'library registry');
  requireFile(releaseFile, 'ESP32 release metadata');
  const root = dirname(registryFile);
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
  let changed = 0;

  for (const library of registry.libraries ?? []) {
    for (const version of library.versions ?? []) {
      const manifestPath = resolve(root, ...String(version.pack?.manifest ?? '').split('/'));
      assertInside(root, manifestPath, `${library.name} manifest`);
      requireFile(manifestPath, `${library.name} manifest`);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.id !== version.pack.id || !manifest.artifacts?.some(({ id }) => id === version.pack.artifact)) {
        throw new Error(`${library.name}@${version.version} Pack identity mismatch`);
      }
      if (version.pack.revision !== manifest.revision) {
        version.pack.revision = manifest.revision;
        changed += 1;
      }
    }
  }

  const provisionalUrl = pathToFileURL(registryFile).href;
  const validated = validateEsp32BrowserLibraryRegistry(registry, provisionalUrl);
  let artifactBytes = 0;
  let transportBytes = 0;
  for (const library of validated.libraries) {
    for (const version of library.versions) {
      const manifestPath = resolve(root, ...version.pack.manifest.split('/'));
      const loader = createBrowserToolchainPackLoader({
        manifestUrl: pathToFileURL(manifestPath),
        expectedId: version.pack.id,
        expectedRevision: version.pack.revision,
        limits: ESP32_BROWSER_LIBRARY_PACK_LIMITS,
        fetchFn: fileFetch,
        cryptoRef: webcrypto,
      });
      const loaded = await loader.loadArtifact(version.pack.artifact);
      if (loaded.artifact.kind !== 'library-source-json') {
        throw new Error(`${library.name}@${version.version} is not a library source Pack`);
      }
      artifactBytes += loaded.bytes.byteLength;
      transportBytes += loaded.artifact.chunks.reduce(
        (sum, chunk) => sum + (chunk.compressedSize ?? chunk.size),
        0,
      );
    }
  }

  const registryBytes = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  const registrySha256 = sha256(registryBytes);
  const registryRelative = relative(dirname(releaseFile), registryFile).split(sep).join('/');
  const release = updateReleaseLibraryPin(
    readFileSync(releaseFile, 'utf8'),
    registryRelative,
    registrySha256,
  );
  writeFileSync(registryFile, registryBytes);
  writeFileSync(releaseFile, release, 'utf8');
  return Object.freeze({
    registry: registryFile,
    registrySha256,
    libraries: validated.libraries.length,
    packs: validated.libraries.reduce((sum, library) => sum + library.versions.length, 0),
    changed,
    artifactBytes,
    transportBytes,
  });
}

async function fileFetch(input, init = {}) {
  const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'file:') return fetch(input, init);
  if (method !== 'GET') return new Response('method not allowed', { status: 405 });
  try {
    const bytes = readFileSync(fileURLToPath(url));
    return new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

function assertInside(root, path, label) {
  const value = relative(resolve(root), resolve(path));
  if (!value || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`${label} escapes the registry directory`);
  }
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function joinWorkspace(...segments) {
  return resolve(WORKSPACE, ...segments);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  repinBrowserEsp32LibraryRegistry()
    .then((result) => {
      console.log(`Verified ${result.libraries} libraries / ${result.packs} Packs`);
      console.log(`Updated ${result.changed} Pack revisions; registry sha256=${result.registrySha256}`);
      console.log(`${result.artifactBytes} decoded bytes / ${result.transportBytes} transport bytes`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
