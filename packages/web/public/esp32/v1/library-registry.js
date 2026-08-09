import { createBrowserToolchainPackLoader } from '../../avr/v3/toolchain-pack.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_PATH_SEGMENT = /^[a-f0-9]{64}$/i;
const PACK_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const LIBRARY_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const ARCHITECTURE = /^(?:\*|[a-z][a-z0-9._-]{0,31})$/;
const ARTIFACT_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const SAFE_MANIFEST_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}\.json$/;
const HEADER_EXTENSION = /\.(?:h|hh|hpp|hxx)$/i;
const HEADER_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export const ESP32_BROWSER_LIBRARY_CACHE_NAME = 'ck-esp32-library-packs-v1';
const CACHE_KEY_PREFIX = 'https://ck-library-cache.invalid/';

export const ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA = 2;
export const ESP32_BROWSER_LIBRARY_MAX_SELECTIONS = 32;
export const ESP32_BROWSER_LIBRARY_REGISTRY_MAX_BYTES = 256 * 1024;
export const ESP32_BROWSER_LIBRARY_PACK_LIMITS = Object.freeze({
  maxArtifacts: 4,
  maxChunksPerArtifact: 64,
  maxArtifactBytes: 64 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

/** Return true only for manifests stored below their full Pack revision. */
export function isEsp32BrowserLibraryImmutableManifestPath(value, revision) {
  if (typeof value !== 'string' || typeof revision !== 'string' || !SHA256.test(revision)) return false;
  const segments = value.split('/');
  return segments.length >= 4
    && segments.at(-1) === 'toolchain.json'
    && segments.at(-2) === revision;
}

/**
 * Create the generic pack loader used by BrowserWasmExecutor planning.
 * Installed library packs are served from CacheStorage first; runtime and
 * platform packs (which are not in the library cache) transparently fall back
 * to the caller's network fetch implementation.
 */
export function createEsp32BrowserLibraryPackLoader({
  cacheStorage = globalThis.caches,
  cacheName = ESP32_BROWSER_LIBRARY_CACHE_NAME,
  fetchFn = globalThis.fetch,
  ...options
} = {}) {
  if (typeof fetchFn !== 'function') throw new TypeError('fetch is required to load an ESP32 browser pack');
  const cachedFetch = createLibraryCacheFirstFetch({ cacheStorage, cacheName, fetchFn });
  const loader = createBrowserToolchainPackLoader({ ...options, fetchFn: cachedFetch });
  return Object.freeze({
    ...loader,
    reset() {
      cachedFetch.reset?.();
      loader.reset?.();
    },
  });
}

/** Load the same-origin registry only through the executable release pin. */
export async function loadEsp32BrowserLibraryRegistry({
  release,
  baseUrl = import.meta.url,
  fetchFn = globalThis.fetch,
  cryptoRef = globalThis.crypto,
} = {}) {
  const pin = normalizeRegistryReleasePin(release, baseUrl);
  if (!pin) throw new Error('ESP32 browser library registry is not release-pinned');
  if (typeof fetchFn !== 'function') throw new TypeError('fetch is required to load the ESP32 browser library registry');
  if (typeof cryptoRef?.subtle?.digest !== 'function') {
    throw new Error('Web Crypto is required to verify the ESP32 browser library registry');
  }

  const response = await fetchFn(pin.url, { cache: 'no-cache' });
  if (!response?.ok) {
    throw new Error(`ESP32 browser library registry returned HTTP ${response?.status ?? 'unknown'}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > ESP32_BROWSER_LIBRARY_REGISTRY_MAX_BYTES) {
    throw new Error('ESP32 browser library registry exceeds its byte limit');
  }
  if (await sha256Hex(bytes, cryptoRef) !== pin.sha256) {
    throw new Error('ESP32 browser library registry checksum mismatch');
  }

  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('ESP32 browser library registry is not valid UTF-8 JSON');
  }
  return validateEsp32BrowserLibraryRegistry(value, pin.url);
}

export function hasEsp32BrowserLibraryRegistryPin(release, baseUrl = import.meta.url) {
  return normalizeRegistryReleasePin(release, baseUrl) !== null;
}

/** Validate immutable registry metadata and resolve every pack below its directory. */
export function validateEsp32BrowserLibraryRegistry(value, registryUrl) {
  const registry = exactRecord(value, 'ESP32 browser library registry', ['schema', 'libraries']);
  if (registry.schema !== ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA) {
    throw new Error('unsupported ESP32 browser library registry schema');
  }
  if (!Array.isArray(registry.libraries) || registry.libraries.length > 512) {
    throw new Error('ESP32 browser library registry entries are invalid');
  }

  const base = registryDirectoryUrl(registryUrl);
  const libraries = [];
  const byName = new Map();
  let previousName = '';
  for (const rawLibrary of registry.libraries) {
    const library = exactRecord(rawLibrary, 'ESP32 browser library', ['name', 'defaultVersion', 'versions']);
    if (typeof library.name !== 'string' || !LIBRARY_NAME.test(library.name)) {
      throw new Error('ESP32 browser library name is invalid');
    }
    const foldedName = library.name.toLowerCase();
    if (foldedName <= previousName) throw new Error('ESP32 browser libraries must have sorted unique names');
    if (typeof library.defaultVersion !== 'string' || !VERSION.test(library.defaultVersion)) {
      throw new Error(`ESP32 browser library default version is invalid: ${library.name}`);
    }
    if (!Array.isArray(library.versions) || !library.versions.length || library.versions.length > 32) {
      throw new Error(`ESP32 browser library versions are invalid: ${library.name}`);
    }

    const versions = [];
    const byVersion = new Map();
    let previousVersion = '';
    for (const rawVersion of library.versions) {
      const version = validateLibraryVersion(rawVersion, library.name, base);
      if (version.version <= previousVersion) {
        throw new Error(`ESP32 browser library versions must be sorted and unique: ${library.name}`);
      }
      versions.push(version);
      byVersion.set(version.version, version);
      previousVersion = version.version;
    }
    if (!byVersion.has(library.defaultVersion)) {
      throw new Error(`ESP32 browser library default version is missing: ${library.name}`);
    }
    const normalized = Object.freeze({
      name: library.name,
      defaultVersion: library.defaultVersion,
      versions: Object.freeze(versions),
      byVersion,
    });
    libraries.push(normalized);
    byName.set(foldedName, normalized);
    previousName = foldedName;
  }

  for (const library of libraries) {
    for (const version of library.versions) {
      for (const dependency of version.depends) {
        const target = byName.get(dependency.name.toLowerCase());
        if (!target || !target.byVersion.has(dependency.version)) {
          throw new Error(`ESP32 browser library dependency is missing: ${library.name} -> ${dependency.name}@${dependency.version}`);
        }
      }
    }
  }
  const headerIndex = new Map();
  for (const library of libraries) {
    for (const version of library.versions) {
      for (const header of version.publicHeaders) {
        const key = header.toLowerCase();
        const candidates = headerIndex.get(key) ?? [];
        if (candidates.some((candidate) => candidate.name.toLowerCase() !== library.name.toLowerCase())) {
          throw new Error(`ESP32 browser library public header is ambiguous: ${header}`);
        }
        candidates.push(Object.freeze({
          name: library.name,
          version: version.version,
          architectures: version.architectures,
        }));
        headerIndex.set(key, candidates);
      }
    }
  }
  for (const [header, candidates] of headerIndex) headerIndex.set(header, Object.freeze(candidates));
  return Object.freeze({
    schema: ESP32_BROWSER_LIBRARY_REGISTRY_SCHEMA,
    libraries: Object.freeze(libraries),
    byName,
    headerIndex,
    registryUrl: new URL(String(registryUrl)).href,
  });
}

/** Resolve one include path through the registry's validated public-header index. */
export function resolveEsp32BrowserLibraryHeader(registry, header, refs = [], architecture = 'esp32') {
  if (!registry || !(registry.byName instanceof Map) || !(registry.headerIndex instanceof Map)) return null;
  if (!safePublicHeaderPath(header) || typeof architecture !== 'string' || !ARCHITECTURE.test(architecture)) return null;
  if (!Array.isArray(refs) || refs.length > ESP32_BROWSER_LIBRARY_MAX_SELECTIONS) return null;

  const requestedVersions = new Map();
  for (const ref of refs) {
    if (!isPlainRecord(ref) || typeof ref.name !== 'string' || !LIBRARY_NAME.test(ref.name)) return null;
    if (ref.version !== undefined && (typeof ref.version !== 'string' || !VERSION.test(ref.version))) return null;
    const folded = ref.name.toLowerCase();
    if (requestedVersions.has(folded)) return null;
    requestedVersions.set(folded, ref.version);
  }

  const matches = [];
  for (const candidate of registry.headerIndex.get(header.toLowerCase()) ?? []) {
    const library = registry.byName.get(candidate.name.toLowerCase());
    if (!library) continue;
    const requestedVersion = requestedVersions.has(candidate.name.toLowerCase())
      ? requestedVersions.get(candidate.name.toLowerCase())
      : library.defaultVersion;
    if (candidate.version !== (requestedVersion ?? library.defaultVersion)) continue;
    if (!candidate.architectures.some((value) => value === '*' || value === architecture)) continue;
    matches.push(candidate);
  }
  if (matches.length !== 1) return null;
  return Object.freeze({ name: matches[0].name, version: matches[0].version });
}

/** Resolve exact/default versions and their transitive dependencies. */
export function resolveEsp32BrowserLibraries(registry, refs, architecture = 'esp32') {
  if (!registry || !(registry.byName instanceof Map)) throw new TypeError('ESP32 browser library registry is invalid');
  if (!Array.isArray(refs) || refs.length > ESP32_BROWSER_LIBRARY_MAX_SELECTIONS) {
    return Object.freeze({ supported: false, reason: 'libraries' });
  }
  if (typeof architecture !== 'string' || !ARCHITECTURE.test(architecture)) {
    return Object.freeze({ supported: false, reason: 'libraries' });
  }

  const requested = [];
  const requestedNames = new Set();
  for (const rawRef of refs) {
    if (!isPlainRecord(rawRef) || !['name', 'version'].every((key) => key === 'version' || Object.hasOwn(rawRef, key))) {
      return Object.freeze({ supported: false, reason: 'request' });
    }
    const keys = Object.keys(rawRef);
    if (keys.some((key) => !['name', 'version'].includes(key))) {
      return Object.freeze({ supported: false, reason: 'request' });
    }
    if (typeof rawRef.name !== 'string' || !LIBRARY_NAME.test(rawRef.name)) {
      return Object.freeze({ supported: false, reason: 'request' });
    }
    if (rawRef.version !== undefined && (typeof rawRef.version !== 'string' || !VERSION.test(rawRef.version))) {
      return Object.freeze({ supported: false, reason: 'request' });
    }
    const folded = rawRef.name.toLowerCase();
    if (requestedNames.has(folded)) return Object.freeze({ supported: false, reason: 'request' });
    requestedNames.add(folded);
    requested.push({ name: rawRef.name, version: rawRef.version });
  }

  const ordered = [];
  const selected = new Map();
  const visiting = new Set();
  let failure = null;
  const visit = (name, requestedVersion) => {
    if (failure) return;
    const library = registry.byName.get(name.toLowerCase());
    if (!library) {
      failure = 'libraries';
      return;
    }
    const versionText = requestedVersion ?? library.defaultVersion;
    const existing = selected.get(library.name.toLowerCase());
    if (existing) {
      if (existing.version !== versionText) failure = 'libraries';
      return;
    }
    const version = library.byVersion.get(versionText);
    if (!version || !version.architectures.some((candidate) => candidate === '*' || candidate === architecture)) {
      failure = 'libraries';
      return;
    }
    const key = `${library.name.toLowerCase()}@${version.version}`;
    if (visiting.has(key)) {
      failure = 'libraries';
      return;
    }
    visiting.add(key);
    for (const dependency of version.depends) visit(dependency.name, dependency.version);
    visiting.delete(key);
    if (failure) return;
    const dependencies = version.depends.map((dependency) => {
      const dependencyLibrary = registry.byName.get(dependency.name.toLowerCase());
      const dependencyVersion = dependencyLibrary?.byVersion.get(dependency.version);
      if (!dependencyVersion) {
        failure = 'libraries';
        return null;
      }
      return Object.freeze({
        id: dependencyVersion.pack.id,
        version: dependencyVersion.version,
        sha256: dependencyVersion.pack.revision,
      });
    });
    if (failure) return;
    const selection = Object.freeze({
      name: library.name,
      version: version.version,
      packId: version.pack.id,
      revision: version.pack.revision,
      manifestUrl: version.pack.manifestUrl,
      artifact: version.pack.artifact,
      dependencies: Object.freeze(dependencies),
    });
    selected.set(library.name.toLowerCase(), selection);
    ordered.push(selection);
  };
  for (const ref of requested) visit(ref.name, ref.version);
  if (failure || ordered.length > ESP32_BROWSER_LIBRARY_MAX_SELECTIONS) {
    return Object.freeze({ supported: false, reason: failure ?? 'libraries' });
  }
  return Object.freeze({ supported: true, libraries: Object.freeze(ordered) });
}

/**
 * Download one registry-pinned library pack and persist it in CacheStorage.
 * The registry remains the source of truth; callers cannot install an
 * arbitrary manifest URL or revision through this API.
 */
export async function installEsp32BrowserLibraryPack({
  registry,
  selection,
  architecture = 'esp32',
  cacheStorage = globalThis.caches,
  cacheName = ESP32_BROWSER_LIBRARY_CACHE_NAME,
  fetchFn = globalThis.fetch,
  cryptoRef = globalThis.crypto,
  onProgress = () => {},
} = {}) {
  if (!registry || !(registry.byName instanceof Map)) throw new TypeError('ESP32 browser library registry is invalid');
  if (!cacheStorage || typeof cacheStorage.open !== 'function') throw new Error('CacheStorage is required to install a browser library');
  if (typeof fetchFn !== 'function') throw new TypeError('fetch is required to install a browser library');
  const normalized = normalizeInstallSelection(selection);
  const resolved = resolveEsp32BrowserLibraries(registry, [{ name: normalized.name, version: normalized.version }], architecture);
  if (!resolved.supported) {
    throw new Error(`ESP32 browser library is not available: ${normalized.name}@${normalized.version}`);
  }
  const expected = resolved.libraries.find((candidate) => (
    candidate.name.toLowerCase() === normalized.name.toLowerCase() && candidate.version === normalized.version
  ));
  if (!expected) throw new Error(`ESP32 browser library is not available: ${normalized.name}@${normalized.version}`);
  if (
    expected.packId !== normalized.packId
    || expected.revision !== normalized.revision
    || expected.manifestUrl !== normalized.manifestUrl
    || expected.artifact !== normalized.artifact
  ) throw new Error('ESP32 browser library selection does not match the pinned registry');

  const cache = await cacheStorage.open(cacheName);
  const capturedTransport = new Map();
  const captureFetch = async (input, init) => {
    const response = await fetchFn(input, init);
    if (response?.ok && init?.cache === 'force-cache') {
      capturedTransport.set(new URL(String(input), normalized.manifestUrl).href, response.clone());
    }
    return response;
  };
  const loader = createPackLoader({
    manifestUrl: normalized.manifestUrl,
    expectedId: normalized.packId,
    expectedRevision: normalized.revision,
    fetchFn: captureFetch,
    cryptoRef,
    limits: ESP32_BROWSER_LIBRARY_PACK_LIMITS,
    onProgress,
  });
  const manifest = await loader.loadManifest();
  const loaded = await loader.loadArtifact(normalized.artifact);
  const key = packCacheKey(normalized);
  const metadataKey = packMetadataKey(normalized);
  for (const [url, response] of capturedTransport) {
    await cache.put(packTransportCacheKey(normalized, url), response);
  }
  await cache.put(key, new Response(loaded.bytes, {
    headers: {
      'content-type': 'application/octet-stream',
      'x-ck-pack-id': normalized.packId,
      'x-ck-pack-revision': normalized.revision,
      'x-ck-pack-artifact': normalized.artifact,
      'x-ck-artifact-sha256': loaded.artifact.sha256,
    },
  }));
  await cache.put(metadataKey, new Response(JSON.stringify({
    schema: 1,
    selection: normalized,
    manifest,
    artifactSize: loaded.bytes.byteLength,
    installedAt: Date.now(),
  }), { headers: { 'content-type': 'application/json' } }));
  return Object.freeze({
    cached: true,
    cacheName,
    key,
    selection: normalized,
    manifest,
    artifactSize: loaded.bytes.byteLength,
  });
}

/** List metadata for packs installed through installEsp32BrowserLibraryPack. */
export async function listInstalledEsp32BrowserLibraryPacks({
  cacheStorage = globalThis.caches,
  cacheName = ESP32_BROWSER_LIBRARY_CACHE_NAME,
} = {}) {
  if (!cacheStorage || typeof cacheStorage.open !== 'function') throw new Error('CacheStorage is required to list browser libraries');
  const cache = await cacheStorage.open(cacheName);
  if (typeof cache.keys !== 'function' || typeof cache.match !== 'function') return Object.freeze([]);
  const keys = await cache.keys();
  const installed = [];
  for (const request of keys) {
    const url = typeof request === 'string' ? request : request?.url;
    if (typeof url !== 'string' || !url.startsWith(CACHE_KEY_PREFIX) || !url.includes('/meta/')) continue;
    const response = await cache.match(request);
    if (!response?.ok) continue;
    try {
      const value = await response.json();
      if (value?.schema === 1 && value.selection) installed.push(value);
    } catch { /* Ignore a corrupted cache entry; a later install repairs it. */ }
  }
  installed.sort((left, right) => String(left.selection.name).localeCompare(String(right.selection.name)));
  return Object.freeze(installed);
}

/** Read a verified installed artifact without touching the network. */
export async function loadInstalledEsp32BrowserLibraryPack({
  selection,
  cacheStorage = globalThis.caches,
  cacheName = ESP32_BROWSER_LIBRARY_CACHE_NAME,
  cryptoRef = globalThis.crypto,
} = {}) {
  if (!cacheStorage || typeof cacheStorage.open !== 'function') throw new Error('CacheStorage is required to load browser libraries');
  const normalized = normalizeInstallSelection(selection);
  const cache = await cacheStorage.open(cacheName);
  const response = await cache.match(packCacheKey(normalized));
  if (!response?.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const metadataResponse = await cache.match(packMetadataKey(normalized));
  if (!metadataResponse?.ok) throw new Error('cached ESP32 browser library metadata is missing');
  let metadata;
  try { metadata = await metadataResponse.json(); } catch { throw new Error('cached ESP32 browser library metadata is invalid'); }
  const artifact = metadata?.manifest?.artifacts?.find((candidate) => candidate.id === normalized.artifact);
  if (!artifact || typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) {
    throw new Error('cached ESP32 browser library artifact metadata is invalid');
  }
  if (await sha256Hex(bytes, cryptoRef) !== artifact.sha256) {
    throw new Error('cached ESP32 browser library artifact checksum mismatch');
  }
  return Object.freeze({ selection: normalized, bytes });
}

/** Remove one installed pack and its metadata. */
export async function removeInstalledEsp32BrowserLibraryPack({
  selection,
  cacheStorage = globalThis.caches,
  cacheName = ESP32_BROWSER_LIBRARY_CACHE_NAME,
} = {}) {
  if (!cacheStorage || typeof cacheStorage.open !== 'function') throw new Error('CacheStorage is required to remove browser libraries');
  const normalized = normalizeInstallSelection(selection);
  const cache = await cacheStorage.open(cacheName);
  let metadata;
  if (typeof cache.match === 'function') {
    try {
      const response = await cache.match(packMetadataKey(normalized));
      if (response?.ok) metadata = await response.json();
    } catch { /* Corrupted metadata must not prevent removal of the main entries. */ }
  }
  let removedTransport = false;
  for (const artifact of metadata?.manifest?.artifacts ?? []) {
    for (const chunk of artifact?.chunks ?? []) {
      try {
        const url = new URL(chunk.path, new URL('./', normalized.manifestUrl)).href;
        if (typeof cache.delete === 'function') {
          removedTransport = await cache.delete(packTransportCacheKey(normalized, url)) || removedTransport;
        }
      } catch { /* Ignore malformed cached metadata; the pinned registry is unchanged. */ }
    }
  }
  const removedArtifact = typeof cache.delete === 'function' ? await cache.delete(packCacheKey(normalized)) : false;
  const removedMetadata = typeof cache.delete === 'function' ? await cache.delete(packMetadataKey(normalized)) : false;
  return Boolean(removedArtifact || removedMetadata || removedTransport);
}

function normalizeInstallSelection(value) {
  const selection = value && typeof value === 'object' ? {
    name: value.name,
    version: value.version,
    packId: value.packId,
    revision: value.revision,
    manifestUrl: value.manifestUrl,
    artifact: value.artifact,
  } : value;
  const [normalized] = normalizeEsp32WorkerLibrarySelections([selection], value?.manifestUrl ?? import.meta.url);
  return normalized;
}

function packCacheKey(selection) {
  return `${CACHE_KEY_PREFIX}pack/${encodeURIComponent(selection.packId)}/${encodeURIComponent(selection.revision)}/${encodeURIComponent(selection.artifact)}`;
}

function packMetadataKey(selection) {
  return `${CACHE_KEY_PREFIX}meta/${encodeURIComponent(selection.packId)}/${encodeURIComponent(selection.revision)}/${encodeURIComponent(selection.artifact)}.json`;
}

function packTransportCacheKey(selection, url) {
  return `${CACHE_KEY_PREFIX}transport/${encodeURIComponent(selection.packId)}/${encodeURIComponent(selection.revision)}/${encodeURIComponent(url)}`;
}

function createPackLoader(options) {
  return createBrowserToolchainPackLoader(options);
}

function createLibraryCacheFirstFetch({ cacheStorage, cacheName, fetchFn }) {
  let entriesPromise;
  const loadEntries = async () => {
    if (!cacheStorage || typeof cacheStorage.open !== 'function') return [];
    if (!entriesPromise) {
      entriesPromise = (async () => {
        const cache = await cacheStorage.open(cacheName);
        if (typeof cache.keys !== 'function' || typeof cache.match !== 'function') return [];
        const entries = [];
        for (const request of await cache.keys()) {
          const url = typeof request === 'string' ? request : request?.url;
          if (typeof url !== 'string' || !url.startsWith(CACHE_KEY_PREFIX) || !url.includes('/meta/')) continue;
          const response = await cache.match(request);
          if (!response?.ok) continue;
          try {
            const value = await response.json();
            if (value?.schema === 1 && value.selection && value.manifest) entries.push(value);
          } catch { /* Ignore malformed entries and let the network path handle them. */ }
        }
        return entries;
      })();
      entriesPromise = entriesPromise.catch((error) => {
        entriesPromise = undefined;
        throw error;
      });
    }
    return entriesPromise;
  };

  const cachedFetch = async (input, init) => {
    const requestUrl = new URL(String(input), import.meta.url).href;
    try {
      const entries = await loadEntries();
      const hit = await cachedLibraryResponse(requestUrl, entries, cacheStorage, cacheName);
      if (hit) return hit;
    } catch {
      // CacheStorage is an optimization. If it is unavailable or corrupted,
      // retain the normal release-pinned network behavior.
    }
    return fetchFn(input, init);
  };
  cachedFetch.reset = () => { entriesPromise = undefined; };
  return cachedFetch;
}

async function cachedLibraryResponse(requestUrl, entries, cacheStorage, cacheName) {
  for (const entry of entries) {
    const manifestUrl = new URL(String(entry.selection?.manifestUrl), import.meta.url).href;
    if (requestUrl === manifestUrl) {
      return new Response(JSON.stringify(entry.manifest), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-ck-cache': 'library-pack' },
      });
    }

    const base = new URL('./', manifestUrl);
    for (const artifact of entry.manifest?.artifacts ?? []) {
      for (const chunk of artifact.chunks ?? []) {
        const chunkUrl = new URL(chunk.path, base).href;
        if (chunkUrl !== requestUrl) continue;
        const cache = await cacheStorage.open(cacheName);
        if (typeof cache.match !== 'function') return null;
        const transportResponse = await cache.match(packTransportCacheKey(entry.selection, requestUrl));
        if (transportResponse?.ok) return transportResponse;
        if (chunk.compression) return null;
        const artifactResponse = await cache.match(packCacheKey(entry.selection));
        if (!artifactResponse?.ok) return null;
        const bytes = new Uint8Array(await artifactResponse.arrayBuffer());
        let offset = 0;
        for (const candidate of artifact.chunks) {
          if (candidate.path === chunk.path) break;
          offset += candidate.size;
        }
        const end = offset + chunk.size;
        if (end > bytes.byteLength) return null;
        return new Response(bytes.slice(offset, end), {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(chunk.size),
            'x-ck-cache': 'library-pack',
          },
        });
      }
    }
  }
  return null;
}

/** Revalidate the structured-cloned library selection at the Worker boundary. */
export function normalizeEsp32WorkerLibrarySelections(value, runtimeUrl) {
  if (!Array.isArray(value) || value.length < 1 || value.length > ESP32_BROWSER_LIBRARY_MAX_SELECTIONS) {
    throw new Error('ESP32 Worker library selection is invalid');
  }
  const runtime = safeAbsoluteUrl(runtimeUrl, 'ESP32 Worker runtime URL');
  const names = new Set();
  const packIds = new Set();
  return Object.freeze(value.map((raw) => {
    const selection = exactRecord(raw, 'ESP32 Worker library', [
      'name', 'version', 'packId', 'revision', 'manifestUrl', 'artifact',
    ]);
    if (typeof selection.name !== 'string' || !LIBRARY_NAME.test(selection.name)) {
      throw new Error('ESP32 Worker library name is invalid');
    }
    const folded = selection.name.toLowerCase();
    if (names.has(folded)) throw new Error('ESP32 Worker library names are duplicated');
    names.add(folded);
    if (typeof selection.version !== 'string' || !VERSION.test(selection.version)) {
      throw new Error('ESP32 Worker library version is invalid');
    }
    if (typeof selection.packId !== 'string' || !PACK_ID.test(selection.packId) || packIds.has(selection.packId)) {
      throw new Error('ESP32 Worker library pack id is invalid or duplicated');
    }
    packIds.add(selection.packId);
    if (typeof selection.revision !== 'string' || !SHA256.test(selection.revision)) {
      throw new Error('ESP32 Worker library revision is invalid');
    }
    if (typeof selection.artifact !== 'string' || !ARTIFACT_ID.test(selection.artifact)) {
      throw new Error('ESP32 Worker library artifact is invalid');
    }
    const manifestUrl = safeAbsoluteUrl(selection.manifestUrl, 'ESP32 Worker library manifest URL');
    if (manifestUrl.origin !== runtime.origin) {
      throw new Error('ESP32 Worker library manifest must share the runtime origin');
    }
    return Object.freeze({
      name: selection.name,
      version: selection.version,
      packId: selection.packId,
      revision: selection.revision,
      manifestUrl: manifestUrl.href,
      artifact: selection.artifact,
    });
  }));
}

function validateLibraryVersion(value, name, baseUrl) {
  const version = exactRecord(value, `ESP32 browser library version ${name}`, [
    'version', 'architectures', 'publicHeaders', 'depends', 'pack',
  ]);
  if (typeof version.version !== 'string' || !VERSION.test(version.version)) {
    throw new Error(`ESP32 browser library version is invalid: ${name}`);
  }
  if (
    !Array.isArray(version.architectures)
    || !version.architectures.length
    || version.architectures.length > 16
    || version.architectures.some((candidate) => typeof candidate !== 'string' || !ARCHITECTURE.test(candidate))
    || new Set(version.architectures).size !== version.architectures.length
  ) throw new Error(`ESP32 browser library architectures are invalid: ${name}@${version.version}`);
  if (!Array.isArray(version.publicHeaders) || !version.publicHeaders.length || version.publicHeaders.length > 512) {
    throw new Error(`ESP32 browser library public headers are invalid: ${name}@${version.version}`);
  }
  const publicHeaders = [];
  let previousHeader = '';
  for (const header of version.publicHeaders) {
    if (!safePublicHeaderPath(header) || header.toLowerCase() <= previousHeader) {
      throw new Error(`ESP32 browser library public headers are invalid: ${name}@${version.version}`);
    }
    publicHeaders.push(header);
    previousHeader = header.toLowerCase();
  }
  if (!Array.isArray(version.depends) || version.depends.length > 32) {
    throw new Error(`ESP32 browser library dependencies are invalid: ${name}@${version.version}`);
  }
  const dependencyNames = new Set();
  const depends = version.depends.map((rawDependency) => {
    const dependency = exactRecord(rawDependency, 'ESP32 browser library dependency', ['name', 'version']);
    if (
      typeof dependency.name !== 'string' || !LIBRARY_NAME.test(dependency.name)
      || typeof dependency.version !== 'string' || !VERSION.test(dependency.version)
      || dependencyNames.has(dependency.name.toLowerCase())
    ) throw new Error(`ESP32 browser library dependency is invalid: ${name}@${version.version}`);
    dependencyNames.add(dependency.name.toLowerCase());
    return Object.freeze({ name: dependency.name, version: dependency.version });
  });
  const pack = exactRecord(version.pack, 'ESP32 browser library pack', [
    'id', 'revision', 'manifest', 'artifact',
  ]);
  if (typeof pack.id !== 'string' || !PACK_ID.test(pack.id)) throw new Error('ESP32 browser library pack id is invalid');
  if (typeof pack.revision !== 'string' || !SHA256.test(pack.revision)) {
    throw new Error('ESP32 browser library pack revision is invalid');
  }
  if (typeof pack.artifact !== 'string' || !ARTIFACT_ID.test(pack.artifact)) {
    throw new Error('ESP32 browser library pack artifact is invalid');
  }
  const manifestSegments = typeof pack.manifest === 'string' ? pack.manifest.split('/') : [];
  const pathRevision = manifestSegments.at(-2);
  if (typeof pathRevision === 'string' && SHA256_PATH_SEGMENT.test(pathRevision)
    && !isEsp32BrowserLibraryImmutableManifestPath(pack.manifest, pack.revision)) {
    throw new Error('ESP32 browser library manifest revision path does not match the Pack revision');
  }
  const manifestUrl = resolveManifestUrl(pack.manifest, baseUrl);
  return Object.freeze({
    version: version.version,
    architectures: Object.freeze([...version.architectures]),
    publicHeaders: Object.freeze(publicHeaders),
    depends: Object.freeze(depends),
    pack: Object.freeze({
      id: pack.id,
      revision: pack.revision,
      manifest: pack.manifest,
      manifestUrl: manifestUrl.href,
      artifact: pack.artifact,
    }),
  });
}

function safePublicHeaderPath(value) {
  if (typeof value !== 'string' || !value.length || value.length > 256 || value.includes('\\') || !HEADER_EXTENSION.test(value)) {
    return false;
  }
  const segments = value.split('/');
  return segments.length <= 8 && segments.every((segment) => HEADER_SEGMENT.test(segment));
}

function normalizeRegistryReleasePin(release, baseUrl) {
  const value = release?.libraries;
  if (!isPlainRecord(value) || typeof value.path !== 'string' || !SAFE_MANIFEST_PATH.test(value.path)) return null;
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) return null;
  if (value.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return null;
  let root;
  let url;
  try {
    root = new URL('./', baseUrl);
    url = new URL(value.path, root);
  } catch {
    return null;
  }
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.search || url.hash) return null;
  return Object.freeze({ url, sha256: value.sha256 });
}

function registryDirectoryUrl(value) {
  const registry = safeAbsoluteUrl(value, 'ESP32 browser library registry URL');
  return new URL('./', registry);
}

function resolveManifestUrl(value, base) {
  if (typeof value !== 'string' || !SAFE_MANIFEST_PATH.test(value)) {
    throw new Error('ESP32 browser library manifest path is invalid');
  }
  if (value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('ESP32 browser library manifest path is invalid');
  }
  const url = new URL(value, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash) {
    throw new Error('ESP32 browser library manifest escapes the registry directory');
  }
  return url;
}

function safeAbsoluteUrl(value, label) {
  if (typeof value !== 'string' && !(value instanceof URL)) throw new TypeError(`${label} is required`);
  const url = new URL(value, import.meta.url);
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:', 'file:'].includes(url.protocol)) {
    throw new Error(`${label} is invalid`);
  }
  return url;
}

function exactRecord(value, label, keys) {
  if (!isPlainRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error(`${label} has an invalid shape`);
  }
  return value;
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function sha256Hex(bytes, cryptoRef) {
  const digest = new Uint8Array(await cryptoRef.subtle.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}
