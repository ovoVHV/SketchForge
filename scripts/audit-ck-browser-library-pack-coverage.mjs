import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  classifyCatalogPackFailure,
  planCatalogPacks,
  readCatalogRecords,
} from './build-browser-esp32-catalog-packs.mjs';
import { validateEsp32BrowserLibraryRegistry } from '../packages/web/public/esp32/v1/library-registry.js';
import { browserToolchainPackRevisionInput } from '../packages/web/public/avr/v3/toolchain-pack.js';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_REGISTRY = resolve(ROOT, 'packages/web/public/esp32/v1/libraries-catalog/registry.json');
// Keep the release-history input separate from the mutable Pack builder output.
// A plan-only build rewrites catalog-pack-build-report.json and must not erase
// previously resolved failure evidence from the coverage audit.
const DEFAULT_HISTORICAL_REPORT = resolve(ROOT, 'var/reports/ck-browser-library-pack-historical-failures.json');
const DEFAULT_REPORT = resolve(ROOT, 'var/reports/ck-browser-library-pack-coverage.json');

const args = parseArgs(process.argv.slice(2));
const registryBytes = await readFile(args.registry);
const historicalBytes = await readOptional(args.historicalReport);
const registry = JSON.parse(registryBytes.toString('utf8'));
validateEsp32BrowserLibraryRegistry(registry, pathToFileURL(args.registry));

const records = readCatalogRecords(args.catalog);
const existing = registryPackIndex(registry);
const providedHeaders = registryHeaderProviders(registry);
const plan = planCatalogPacks(records, { existing, providedHeaders, architecture: args.architecture });
const packIntegrity = [];
for (const library of registry.libraries) {
  for (const version of library.versions) {
    packIntegrity.push(await verifyRegistryPack(args.registry, library.name, version));
  }
}

const historical = historicalBytes ? JSON.parse(historicalBytes.toString('utf8')) : undefined;
const historicalFailures = (historical?.failed ?? []).map((failure) => classifyHistoricalFailure({
  failure,
  plan,
  existing,
}));
const coverage = {
  catalog: plan.length,
  present: plan.filter(({ state }) => state === 'existing').length,
  incompatible: plan.filter(({ state }) => state === 'incompatible').length,
  superseded: plan.filter(({ state }) => state === 'superseded').length,
  missing: plan.filter(({ state }) => state === 'candidate').length,
};
const report = {
  schema: 1,
  scope: 'pack-presence-and-integrity-only',
  compatibilityClaim: false,
  generatedAt: new Date().toISOString(),
  fingerprint: sha256(Buffer.concat([
    registryBytes,
    historicalBytes ?? Buffer.alloc(0),
    Buffer.from(JSON.stringify(records)),
  ])),
  registry: {
    path: args.registry,
    sha256: sha256(registryBytes),
    libraries: registry.libraries.length,
    versions: registry.libraries.reduce((sum, library) => sum + library.versions.length, 0),
  },
  coverage,
  incompatible: plan.filter(({ state }) => state === 'incompatible').map(({ name, version, architectures }) => ({
    name,
    version,
    architectures,
    status: 'catalog-incompatible',
  })),
  superseded: plan.filter(({ state }) => state === 'superseded').map(({ name, version, replacement }) => ({
    name,
    version,
    status: 'registry-superseded',
    replacement,
  })),
  missing: plan.filter(({ state }) => state === 'candidate').map(({ name, version }) => ({
    name,
    version,
    status: 'pack-missing',
  })),
  packIntegrity: {
    verified: packIntegrity.length,
    transportBytes: packIntegrity.reduce((sum, pack) => sum + pack.transportBytes, 0),
    artifactBytes: packIntegrity.reduce((sum, pack) => sum + pack.artifactBytes, 0),
  },
  historicalReport: historicalBytes ? {
    path: args.historicalReport,
    sha256: sha256(historicalBytes),
    originalSchema: historical?.schema,
    failures: historicalFailures,
    statuses: countBy(historicalFailures, ({ status }) => status),
    failureClasses: countBy(historicalFailures, ({ failureClass }) => failureClass),
  } : null,
};

await mkdir(dirname(args.report), { recursive: true });
await writeFile(args.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  status: coverage.missing ? 'failed' : 'success',
  report: args.report,
  coverage,
  registryPacksVerified: packIntegrity.length,
  historicalFailures: report.historicalReport?.statuses ?? {},
}, null, 2));
if (coverage.missing) process.exitCode = 1;

export function classifyHistoricalFailure({ failure, plan, existing }) {
  const key = packKey(failure.name, failure.version);
  const currentPack = existing.get(key);
  const planned = plan.find((entry) => packKey(entry.name, entry.version) === key);
  const classification = classifyCatalogPackFailure(failure.error);
  if (currentPack) {
    return Object.freeze({
      name: failure.name,
      version: failure.version,
      historicalError: failure.error,
      ...classification,
      status: 'stale-pack-failure',
      reason: 'the exact version now has an integrity-verified Registry Pack; compile compatibility is not implied',
      pack: currentPack,
    });
  }
  if (planned?.state === 'incompatible') {
    return Object.freeze({
      name: failure.name,
      version: failure.version,
      historicalError: failure.error,
      ...classification,
      status: 'catalog-incompatible',
      architectures: planned.architectures,
    });
  }
  if (planned?.state === 'superseded') {
    return Object.freeze({
      name: failure.name,
      version: failure.version,
      historicalError: failure.error,
      ...classification,
      status: 'registry-superseded',
      replacement: planned.replacement,
    });
  }
  return Object.freeze({
    name: failure.name,
    version: failure.version,
    historicalError: failure.error,
    ...classification,
    status: 'unresolved-pack-failure',
  });
}

async function verifyRegistryPack(registryPath, libraryName, version) {
  const manifestPath = resolve(dirname(registryPath), ...version.pack.manifest.split('/'));
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.id !== version.pack.id || manifest.revision !== version.pack.revision) {
    throw new Error(`${libraryName}@${version.version} Registry Pack identity mismatch`);
  }
  const calculatedRevision = sha256(Buffer.from(browserToolchainPackRevisionInput(manifest)));
  if (calculatedRevision !== manifest.revision) {
    throw new Error(`${libraryName}@${version.version} Registry Pack revision mismatch`);
  }
  const artifact = manifest.artifacts?.find(({ id }) => id === version.pack.artifact);
  if (!artifact) throw new Error(`${libraryName}@${version.version} Registry Pack artifact is missing`);
  const artifactHash = createHash('sha256');
  let artifactBytes = 0;
  let transportBytes = 0;
  for (const chunk of artifact.chunks ?? []) {
    const transport = await readFile(resolve(dirname(manifestPath), ...chunk.path.split('/')));
    transportBytes += transport.byteLength;
    const expectedTransportSize = chunk.compression === 'gzip' ? chunk.compressedSize : chunk.size;
    const expectedTransportHash = chunk.compression === 'gzip' ? chunk.compressedSha256 : chunk.sha256;
    if (transport.byteLength !== expectedTransportSize || sha256(transport) !== expectedTransportHash) {
      throw new Error(`${libraryName}@${version.version} Registry Pack transport integrity mismatch`);
    }
    const decoded = chunk.compression === 'gzip' ? gunzipSync(transport) : transport;
    if (decoded.byteLength !== chunk.size || sha256(decoded) !== chunk.sha256) {
      throw new Error(`${libraryName}@${version.version} Registry Pack chunk integrity mismatch`);
    }
    artifactBytes += decoded.byteLength;
    artifactHash.update(decoded);
  }
  if (artifactBytes !== artifact.size || artifactHash.digest('hex') !== artifact.sha256) {
    throw new Error(`${libraryName}@${version.version} Registry Pack artifact integrity mismatch`);
  }
  return Object.freeze({ libraryName, version: version.version, artifactBytes, transportBytes });
}

function registryPackIndex(registry) {
  return new Map(registry.libraries.flatMap((library) => library.versions.map((version) => [
    packKey(library.name, version.version),
    Object.freeze({
      id: version.pack.id,
      revision: version.pack.revision,
      manifest: version.pack.manifest,
      artifact: version.pack.artifact,
    }),
  ])));
}

function registryHeaderProviders(registry) {
  const providers = new Map();
  for (const library of registry.libraries) {
    for (const version of library.versions) {
      const provider = Object.freeze({
        name: library.name,
        version: version.version,
        architectures: Object.freeze([...version.architectures]),
      });
      for (const header of version.publicHeaders) {
        const key = header.toLowerCase();
        const owners = providers.get(key) ?? [];
        owners.push(provider);
        providers.set(key, owners);
      }
    }
  }
  return providers;
}

function packKey(name, version) {
  return `${String(name).toLowerCase()}@${version}`;
}

function countBy(values, select) {
  const counts = new Map();
  for (const value of values) {
    const key = select(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function parseArgs(values) {
  const result = {
    catalog: resolve(ROOT, 'packages/core/src/library/catalog-data.ts'),
    registry: DEFAULT_REGISTRY,
    historicalReport: DEFAULT_HISTORICAL_REPORT,
    report: DEFAULT_REPORT,
    architecture: 'esp32',
  };
  for (let index = 0; index < values.length; index++) {
    const argument = values[index];
    const value = values[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    if (argument === '--catalog') result.catalog = resolve(value);
    else if (argument === '--registry') result.registry = resolve(value);
    else if (argument === '--historical-report') result.historicalReport = resolve(value);
    else if (argument === '--report') result.report = resolve(value);
    else if (argument === '--architecture') result.architecture = value.toLowerCase();
    else throw new Error(`unknown argument: ${argument}`);
  }
  return result;
}

async function readOptional(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

if (process.argv[1] && resolve(process.argv[1]) !== resolve(fileURLToPath(import.meta.url))) {
  // Imported by a test: all work above has already run only when this file is
  // executed as the CLI entrypoint, so guard against accidental imports.
}
