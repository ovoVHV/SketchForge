const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const FQBN = /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

export const ESP32_BROWSER_PLATFORM_REGISTRY_SCHEMA = 1;
export const ESP32_BROWSER_PLATFORM_REGISTRY_MAX_BYTES = 256 * 1024;
export const ESP32_BROWSER_PLATFORM_MANIFEST_MAX_BYTES = 512 * 1024;

/** Load the same-origin Platform registry only through an executable release pin. */
export async function loadEsp32BrowserPlatformRegistry({
  release,
  baseUrl = import.meta.url,
  fetchFn = globalThis.fetch,
  cryptoRef = globalThis.crypto,
} = {}) {
  const pin = normalizePlatformRegistryReleasePin(release, baseUrl);
  if (!pin) throw new Error('ESP32 browser Platform registry is not release-pinned');
  if (typeof fetchFn !== 'function') throw new TypeError('fetch is required to load the ESP32 Platform registry');
  if (typeof cryptoRef?.subtle?.digest !== 'function') {
    throw new Error('Web Crypto is required to verify the ESP32 Platform registry');
  }

  const response = await fetchFn(pin.url, { cache: 'no-cache' });
  if (!response?.ok) {
    throw new Error(`ESP32 browser Platform registry returned HTTP ${response?.status ?? 'unknown'}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > ESP32_BROWSER_PLATFORM_REGISTRY_MAX_BYTES) {
    throw new Error('ESP32 browser Platform registry exceeds its byte limit');
  }
  if (await sha256Hex(bytes, cryptoRef) !== pin.sha256) {
    throw new Error('ESP32 browser Platform registry checksum mismatch');
  }

  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('ESP32 browser Platform registry is not valid UTF-8 JSON');
  }
  return validateEsp32BrowserPlatformRegistry(value, pin.url);
}

export function hasEsp32BrowserPlatformRegistryPin(release, baseUrl = import.meta.url) {
  return normalizePlatformRegistryReleasePin(release, baseUrl) !== null;
}

/** Validate registry metadata and make each FQBN lookup deterministic. */
export function validateEsp32BrowserPlatformRegistry(value, registryUrl) {
  if (!isPlainRecord(value)
    || value.kind !== 'ck-platform-manifest-registry'
    || value.schemaVersion !== ESP32_BROWSER_PLATFORM_REGISTRY_SCHEMA
    || !Array.isArray(value.entries)
    || value.entries.length > 64) {
    throw new Error('ESP32 browser Platform registry has an invalid shape');
  }

  const entries = [];
  const byFqbn = new Map();
  let previousFqbn = '';
  for (const rawEntry of value.entries) {
    const entry = validateRegistryEntry(rawEntry);
    if (entry.fqbn <= previousFqbn) {
      throw new Error('ESP32 browser Platform registry entries must be sorted and unique');
    }
    if (byFqbn.has(entry.fqbn)) throw new Error(`duplicate Platform registry FQBN: ${entry.fqbn}`);
    const manifestUrl = new URL(entry.path, registryUrl);
    const normalized = Object.freeze({ ...entry, manifestUrl: manifestUrl.href });
    entries.push(normalized);
    byFqbn.set(entry.fqbn, normalized);
    previousFqbn = entry.fqbn;
  }

  return Object.freeze({
    kind: 'ck-platform-manifest-registry',
    schemaVersion: ESP32_BROWSER_PLATFORM_REGISTRY_SCHEMA,
    entries: Object.freeze(entries),
    byFqbn,
    registryUrl: new URL(String(registryUrl)).href,
  });
}

/** Load and verify one content-addressed standard Platform Manifest. */
export async function loadEsp32BrowserPlatformManifest({
  registry,
  fqbn,
  sdkPack,
  fetchFn = globalThis.fetch,
  cryptoRef = globalThis.crypto,
} = {}) {
  if (!registry || !(registry.byFqbn instanceof Map)) {
    throw new TypeError('ESP32 browser Platform registry is invalid');
  }
  const entry = registry.byFqbn.get(fqbn);
  if (!entry) throw new Error(`ESP32 browser Platform Manifest is not published: ${fqbn}`);
  if (sdkPack !== undefined && !samePackIdentity(entry.sdkPack, sdkPack)) {
    throw new Error(`${fqbn} Platform Manifest SDK Pack does not match the runtime descriptor`);
  }
  if (typeof fetchFn !== 'function') throw new TypeError('fetch is required to load a Platform Manifest');
  if (typeof cryptoRef?.subtle?.digest !== 'function') {
    throw new Error('Web Crypto is required to verify a Platform Manifest');
  }

  const response = await fetchFn(entry.manifestUrl, { cache: 'no-cache' });
  if (!response?.ok) {
    throw new Error(`${fqbn} Platform Manifest returned HTTP ${response?.status ?? 'unknown'}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > ESP32_BROWSER_PLATFORM_MANIFEST_MAX_BYTES) {
    throw new Error(`${fqbn} Platform Manifest exceeds its byte limit`);
  }

  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${fqbn} Platform Manifest is not valid UTF-8 JSON`);
  }
  const manifest = await validateEsp32BrowserPlatformManifest(value, fqbn, cryptoRef);
  if (manifest.id !== entry.id || manifest.version !== entry.version || manifest.sha256 !== entry.sha256) {
    throw new Error(`${fqbn} Platform Manifest identity does not match its registry entry`);
  }
  return Object.freeze({
    entry,
    manifest,
    manifestUrl: entry.manifestUrl,
  });
}

/** Validate the immutable fields needed before a Manifest can enter planning. */
export async function validateEsp32BrowserPlatformManifest(value, fqbn, cryptoRef = globalThis.crypto) {
  if (!isPlainRecord(value)
    || value.kind !== 'ck-platform-pack'
    || value.schemaVersion !== 2
    || !IDENTIFIER.test(value.id)
    || typeof value.version !== 'string'
    || !VERSION.test(value.version)
    || !SHA256.test(value.sha256)
    || !Array.isArray(value.boards)
    || !Array.isArray(value.recipes)
    || !Array.isArray(value.tools)
    || !Array.isArray(value.files)
    || !(await validateRecipeLoweringContract(value.recipeLowering, cryptoRef))) {
    throw new Error(`${fqbn} Platform Manifest is invalid`);
  }
  const bindings = value.recipeLowering.bindings;
  const recipeIds = [bindings.compile.c, bindings.compile.cxx, bindings.compile.asm, bindings.archive, bindings.link];
  if (recipeIds.some((id) => value.recipes.filter((recipe) => recipe?.id === id).length !== 1)) {
    throw new Error(`${fqbn} Platform Manifest recipe bindings are invalid`);
  }
  if (typeof fqbn === 'string' && value.boards.filter((board) => board?.fqbn === fqbn).length !== 1) {
    throw new Error(`${fqbn} Platform Manifest must contain exactly one matching board`);
  }
  const toolIds = new Set();
  for (const tool of value.tools) {
    if (!isPlainRecord(tool)
      || !IDENTIFIER.test(tool.id)
      || typeof tool.version !== 'string'
      || !VERSION.test(tool.version)
      || !SHA256.test(tool.sha256)
      || toolIds.has(tool.id)) {
      throw new Error(`${fqbn} Platform Manifest tool requirement is invalid`);
    }
    toolIds.add(tool.id);
  }
  if (value.files.length > 10000) throw new Error(`${fqbn} Platform Manifest has too many files`);
  if (typeof cryptoRef?.subtle?.digest !== 'function') {
    throw new Error('Web Crypto is required to verify a Platform Manifest hash');
  }
  const { sha256, ...withoutHash } = value;
  if (await sha256CanonicalJson(withoutHash, cryptoRef) !== sha256) {
    throw new Error(`${fqbn} Platform Manifest hash mismatch`);
  }
  return Object.freeze(value);
}

async function validateRecipeLoweringContract(value, cryptoRef) {
  if (!isPlainRecord(value)
    || !sameKeys(value, [
      'archive', 'bindings', 'compatibility', 'paths', 'publication',
      'responseFiles', 'schemaVersion', 'sha256',
    ])
    || value.schemaVersion !== 2
    || !SHA256.test(value.sha256)) return false;
  const { sha256, ...body } = value;
  if (await sha256CanonicalJson(body, cryptoRef) !== sha256) return false;
  const bindings = value.bindings;
  if (!isPlainRecord(bindings) || !sameKeys(bindings, ['archive', 'compile', 'link'])
    || !isPlainRecord(bindings.compile)
    || !sameKeys(bindings.compile, ['asm', 'c', 'cxx'])
    || Object.values(bindings.compile).some((entry) => typeof entry !== 'string' || !entry)
    || [bindings.archive, bindings.link].some((entry) => typeof entry !== 'string' || !entry)) return false;
  const paths = value.paths;
  if (!isPlainRecord(paths) || !isPlainRecord(paths.logicalToAction)) return false;
  const layout = paths.logicalToAction;
  if (!sameKeys(layout, ['exact', 'prefixes'])
    || !isPlainRecord(layout.exact) || !isPlainRecord(layout.prefixes)) return false;
  if ([...Object.entries(layout.exact), ...Object.entries(layout.prefixes)]
    .some(([from, to]) => typeof from !== 'string' || typeof to !== 'string'
      || !from || !to || from.includes('\\') || to.includes('\\')
      || from.startsWith('/') || to.startsWith('/'))) return false;
  const response = value.responseFiles;
  if (!isPlainRecord(response) || response.marker !== '@'
    || !isPlainRecord(response.roles) || !isPlainRecord(response.languageFiles)
    || !sameKeys(response.roles, ['compiler', 'linker'])
    || !sameKeys(response.languageFiles, ['asm', 'c', 'cxx'])
    || Object.values(response.roles).some((entry) => typeof entry !== 'string' || !entry)
    || Object.values(response.languageFiles).some((entry) => typeof entry !== 'string' || !entry)) return false;
  const compatibility = value.compatibility;
  if (!isPlainRecord(compatibility) || !isPlainRecord(compatibility.compiler)
    || !isPlainRecord(compatibility.linker)) return false;
  if (typeof compatibility.compiler.disableBuiltinCxxIncludes !== 'boolean'
    || !Array.isArray(compatibility.compiler.runtimeIncludes)
    || !Array.isArray(compatibility.linker.searchPaths)
    || !Array.isArray(compatibility.linker.responseFiles)
    || !['all', 'none'].includes(compatibility.linker.runtimeLibraryDirectories)
    || !Array.isArray(compatibility.linker.forceLldTargetPrefixes)) return false;
  const archive = value.archive;
  if (!isPlainRecord(archive) || !sameKeys(archive, ['argumentOrder', 'command', 'operation'])
    || archive.command !== 'ar'
    || archive.operation !== 'rcs'
    || !Array.isArray(archive.argumentOrder)
    || archive.argumentOrder.join('\0') !== 'operation\0output\0inputs\0flags') return false;
  const publication = value.publication;
  if (!isPlainRecord(publication) || !sameKeys(publication, ['sdkArchiveRewrites'])
    || !Array.isArray(publication.sdkArchiveRewrites)
    || publication.sdkArchiveRewrites.some((entry) => !['strip-debug', 'deterministic-archives'].includes(entry))) return false;
  return true;
}

function validateRegistryEntry(value) {
  if (!isPlainRecord(value)
    || !FQBN.test(value.fqbn)
    || !IDENTIFIER.test(value.id)
    || typeof value.version !== 'string'
    || !VERSION.test(value.version)
    || !SHA256.test(value.sha256)
    || typeof value.path !== 'string'
    || !SAFE_PATH.test(value.path)
    || value.path !== `${value.id}/${value.sha256}/manifest.json`
    || !samePackShape(value.sdkPack)) {
    throw new Error(`ESP32 browser Platform registry entry is invalid: ${String(value?.fqbn)}`);
  }
  return Object.freeze({
    fqbn: value.fqbn,
    id: value.id,
    version: value.version,
    sha256: value.sha256,
    path: value.path,
    sdkPack: Object.freeze({ id: value.sdkPack.id, revision: value.sdkPack.revision }),
  });
}

function samePackShape(value) {
  return isPlainRecord(value) && IDENTIFIER.test(value.id) && SHA256.test(value.revision);
}

function samePackIdentity(left, right) {
  return samePackShape(right) && left.id === right.id && left.revision === right.revision;
}

function normalizePlatformRegistryReleasePin(release, baseUrl) {
  const pin = release?.platforms;
  if (!isPlainRecord(pin) || typeof pin.path !== 'string' || !SHA256.test(pin.sha256)) return null;
  try {
    return Object.freeze({ url: new URL(pin.path, baseUrl), sha256: pin.sha256 });
  } catch {
    return null;
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isPlainRecord(value)) throw new TypeError('Platform Manifest canonical JSON value is invalid');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

async function sha256CanonicalJson(value, cryptoRef) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return sha256Hex(bytes, cryptoRef);
}

async function sha256Hex(bytes, cryptoRef) {
  const digest = await cryptoRef.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
