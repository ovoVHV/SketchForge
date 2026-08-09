#!/usr/bin/env node

/**
 * Build browser ESP32 library source packs from CK's immutable Arduino catalog.
 *
 * This is deliberately separate from build-browser-esp32-libraries.mjs. The
 * checked-in registry is release-pinned and contains only packs that have been
 * reviewed and smoke-tested. This generator writes to an E:-backed staging
 * directory and never mutates that registry. Use the plan mode in CI to see
 * what can be built, then opt into a bounded number of archive downloads.
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gzipSync, gunzipSync, inflateRawSync } from 'node:zlib';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  isEsp32BrowserLibraryImmutableManifestPath,
  resolveEsp32BrowserLibraries,
  validateEsp32BrowserLibraryRegistry,
} from '../packages/web/public/esp32/v1/library-registry.js';

const WORKSPACE = resolve(import.meta.dirname, '..');
const DEFAULT_CATALOG = join(WORKSPACE, 'packages', 'core', 'src', 'library', 'catalog-data.ts');
const DEFAULT_REGISTRY = join(WORKSPACE, 'packages', 'web', 'public', 'esp32', 'v1', 'libraries', 'registry.json');
const DEFAULT_OUTPUT = join(WORKSPACE, 'var', 'browser-library-catalog-packs');
const SHA256 = /^[a-f0-9]{64}$/i;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const COMPILE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.S', '.s']);
const HEADER_EXTENSIONS = new Set(['.h', '.hh', '.hpp', '.hxx']);
const SOURCE_EXTENSIONS = new Set([...COMPILE_EXTENSIONS, ...HEADER_EXTENSIONS, '.inc', '.ipp', '.tpp']);
const IGNORED_DIRECTORY_NAMES = new Set([
  'example', 'examples', 'test', 'tests', 'benchmark', 'benchmarks', 'docs', 'doc', 'tools',
]);

/**
 * Classify a catalog build failure without tying the result to a library name.
 * The class is deliberately based on the bounded operation that failed so a
 * retry policy can distinguish transient downloads from immutable Pack limits.
 */
export function classifyCatalogPackFailure(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  if (/download timed out|download timeout|timed out|timeout/.test(normalized)) {
    return Object.freeze({ failureClass: 'download-timeout', retryable: true });
  }
  if (/returned http \d+|fetch failed|network|econn|enotfound|reset by peer/.test(normalized)) {
    return Object.freeze({ failureClass: 'download', retryable: true });
  }
  if (/checksum mismatch|sha-?256/.test(normalized)) {
    return Object.freeze({ failureClass: 'integrity', retryable: false });
  }
  if (/archive (?:exceeds|has no|is not|contains|entry|central|deflate|data|compression|uses unsupported)|zip/.test(normalized)) {
    return Object.freeze({ failureClass: 'archive-limit-or-invalid', retryable: false });
  }
  if (/source (?:tree|file count)|serialized source artifact|public header count|browser pack limit/.test(normalized)) {
    return Object.freeze({ failureClass: 'pack-limit', retryable: false });
  }
  return Object.freeze({ failureClass: 'pack-build', retryable: false });
}

// Large libraries are transported as independently verified 1 MiB gzip chunks,
// while their decoded source tree remains subject to a strict per-Pack bound.
// Archive and extraction limits are separate so ignored docs/assets are never
// inflated merely because the upstream release ZIP contains them.
export const CATALOG_PACK_LIMITS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxArchiveFiles: 10_000,
  maxArchiveEntryBytes: 512 * 1024 * 1024,
  maxArchiveDeclaredBytes: 2 * 1024 * 1024 * 1024,
  maxArchiveFileBytes: 64 * 1024 * 1024,
  maxArchiveTotalBytes: 128 * 1024 * 1024,
  maxArchiveRatio: 200,
  maxSourceFiles: 4096,
  maxSourceBytes: 64 * 1024 * 1024,
  maxPayloadBytes: 64 * 1024 * 1024,
  maxChunkBytes: 1024 * 1024,
  archiveDownloadTimeoutMs: 180_000,
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function slug(value) {
  const normalized = String(value).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return normalized || 'library';
}

function packId(name) {
  const value = `arduino-lib-${slug(name)}`;
  if (value.length <= 64) return value;
  return `${value.slice(0, 47)}-${sha256(Buffer.from(String(name), 'utf8')).slice(0, 16)}`;
}

function safePublicHeader(path) {
  if (typeof path !== 'string' || path.length > 256 || path.includes('\\') || !HEADER_EXTENSIONS.has(sourceExtension(path))) return false;
  const segments = path.split('/');
  return segments.length <= 8 && segments.every((segment) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(segment));
}

function safeArchivePath(raw, maxDepth = 20) {
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) throw new Error('archive entry path is invalid');
  const unified = raw.replaceAll('\\', '/');
  if (unified.startsWith('/') || unified.startsWith('//') || /^[A-Za-z]:/.test(unified)) {
    throw new Error(`archive entry path is absolute: ${raw}`);
  }
  const segments = unified.split('/').filter(Boolean);
  if (!segments.length || segments.includes('.') || segments.includes('..') || segments.length > maxDepth) {
    throw new Error(`archive entry path is unsafe: ${raw}`);
  }
  for (const segment of segments) {
    if (segment.length > 255 || /[\u0000-\u001f]/.test(segment)) throw new Error(`archive entry path is unsafe: ${raw}`);
  }
  return segments.join('/');
}

function findEndOfCentralDirectory(bytes) {
  // EOCD is followed by an optional comment of at most 65535 bytes.
  const start = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= start; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('catalog archive is not a ZIP file');
}

function crc32(bytes) {
  if (!crc32.table) {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) value = (value & 1) ? ((value >>> 1) ^ 0xedb88320) : (value >>> 1);
      table[i] = value >>> 0;
    }
    crc32.table = table;
  }
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crc32.table[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Parse a bounded ZIP archive without invoking a shell extractor. Arduino's
 * official library archives are ordinary ZIP files using store or deflate.
 */
export function parseCatalogZip(bytes, limits = CATALOG_PACK_LIMITS, includeEntry = () => true) {
  const archive = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (typeof includeEntry !== 'function') throw new TypeError('catalog archive entry filter must be a function');
  if (archive.length > limits.maxArchiveBytes) throw new Error('catalog archive exceeds its byte limit');
  const eocd = findEndOfCentralDirectory(archive);
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const entriesOnDisk = archive.readUInt16LE(eocd + 8);
  const entries = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('catalog archive uses unsupported ZIP64 or multi-disk metadata');
  }
  if (entries > limits.maxArchiveFiles || centralOffset + centralSize > archive.length) {
    throw new Error('catalog archive central directory is invalid');
  }

  const result = [];
  const paths = new Set();
  let offset = centralOffset;
  let totalBytes = 0;
  let totalCompressedBytes = 0;
  let totalDeclaredBytes = 0;
  const maxArchiveEntryBytes = limits.maxArchiveEntryBytes ?? limits.maxArchiveFileBytes;
  const maxArchiveDeclaredBytes = limits.maxArchiveDeclaredBytes ?? limits.maxArchiveTotalBytes;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('catalog archive central directory entry is invalid');
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const expectedCrc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > archive.length || uncompressedSize > maxArchiveEntryBytes || compressedSize > limits.maxArchiveBytes) {
      throw new Error('catalog archive entry exceeds its byte limit');
    }
    totalDeclaredBytes += uncompressedSize;
    if (totalDeclaredBytes > maxArchiveDeclaredBytes) throw new Error('catalog archive exceeds its declared extraction limit');
    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength);
    let rawName;
    try { rawName = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); }
    catch { throw new Error('catalog archive entry name is not valid UTF-8'); }
    const isDirectory = rawName.endsWith('/');
    const path = safeArchivePath(isDirectory ? rawName.slice(0, -1) : rawName);
    // A Unix mode of 0120000 denotes a symbolic link. Do not materialize it.
    if (((externalAttributes >>> 16) & 0xf000) === 0xa000) throw new Error(`catalog archive contains a symbolic link: ${path}`);
    offset = end;
    if (isDirectory) continue;
    if (flags & 0x1) throw new Error(`catalog archive entry is encrypted: ${path}`);
    if (paths.has(path)) throw new Error(`catalog archive contains a duplicate path: ${path}`);
    paths.add(path);
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`catalog archive local header is invalid: ${path}`);
    }
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (
      dataStart < 0
      || dataEnd > archive.length
      || localFlags !== flags
      || localMethod !== method
      || !localName.equals(nameBytes)
    ) throw new Error(`catalog archive data is invalid: ${path}`);
    if (!includeEntry(path)) continue;
    if (uncompressedSize > limits.maxArchiveFileBytes) throw new Error('catalog archive selected entry exceeds its byte limit');
    let content;
    if (method === 0) content = archive.subarray(dataStart, dataEnd);
    else if (method === 8) {
      try { content = inflateRawSync(archive.subarray(dataStart, dataEnd)); }
      catch { throw new Error(`catalog archive deflate stream is invalid: ${path}`); }
    } else throw new Error(`catalog archive compression method is unsupported: ${method}`);
    if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) {
      throw new Error(`catalog archive entry checksum mismatch: ${path}`);
    }
    totalBytes += content.length;
    totalCompressedBytes += compressedSize;
    if (totalBytes > limits.maxArchiveTotalBytes) throw new Error('catalog archive exceeds its total extraction limit');
    result.push(Object.freeze({ path, bytes: Buffer.from(content) }));
  }
  if (totalBytes / Math.max(1, totalCompressedBytes) > limits.maxArchiveRatio) {
    throw new Error('catalog archive compression ratio exceeds its limit');
  }
  return Object.freeze(result.sort((left, right) => asciiCompare(left.path, right.path)));
}

function stripArchiveRoot(files) {
  if (!files.length) return files;
  const first = files[0].path.split('/')[0];
  if (!first || !files.every((file) => file.path === first || file.path.startsWith(`${first}/`))) return files;
  return files.map((file) => Object.freeze({
    path: file.path === first ? '' : file.path.slice(first.length + 1),
    bytes: file.bytes,
  })).filter((file) => file.path);
}

function sourcePathExcluded(path) {
  let insideArduinoSourceTree = false;
  let sourceDepth = 0;
  const ignoredTree = /^(?:example|examples|benchmark|benchmarks|test|tests)(?:[_-].*)?$/;
  for (const segment of path.split('/')) {
    const normalized = segment.toLowerCase();
    if (normalized === 'src') {
      insideArduinoSourceTree = true;
      sourceDepth = 0;
      continue;
    }
    if (!insideArduinoSourceTree) {
      // Some archives keep their Arduino sources at the archive root instead
      // of under src/. Treat suffixed host/example trees consistently in both
      // layouts (for example examples_linux and examples_pico).
      if (IGNORED_DIRECTORY_NAMES.has(normalized) || ignoredTree.test(normalized)) return true;
      continue;
    }
    sourceDepth += 1;
    // A number of upstream libraries put host examples below src/ (for
    // example RF24/src/examples_linux). They are not part of the Arduino
    // library source closure and often include a different library layout.
    const nestedExample = /^(?:example|examples|benchmark|benchmarks)(?:[_-].*)?$/.test(normalized);
    const rootTest = sourceDepth === 1 && /^(?:test|tests)(?:[_-].*)?$/.test(normalized);
    if (nestedExample || rootTest) return true;
  }
  return false;
}

function catalogSourceArchiveEntry(path) {
  if (sourcePathExcluded(path)) return false;
  return path.toLowerCase().endsWith('/library.properties')
    || path.toLowerCase() === 'library.properties'
    || SOURCE_EXTENSIONS.has(sourceExtension(path));
}

function sourceExtension(path) {
  const match = /\.[A-Za-z0-9]+$/.exec(path);
  return match?.[0] ?? '';
}

function libraryPropertyIncludes(files) {
  const properties = files.find((file) => file.path.toLowerCase() === 'library.properties');
  if (!properties) return [];
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(properties.bytes); }
  catch { throw new Error('library.properties is not valid UTF-8'); }
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 0 || line.slice(0, separator).trim().toLowerCase() !== 'includes') continue;
    return line.slice(separator + 1).split(',').map((value) => value.trim()).filter(Boolean);
  }
  return [];
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || !record.name || !record.version || (!record.url && !record.source?.url)) {
    throw new TypeError('catalog record is invalid');
  }
  const source = record.source ?? record;
  const checksum = String(record.checksum ?? source.sha256 ?? '').replace(/^SHA-256:/i, '').toLowerCase();
  if (!SHA256.test(checksum)) throw new TypeError(`catalog checksum is invalid: ${record.name}`);
  if (!VERSION.test(String(record.version))) throw new TypeError(`catalog version is invalid: ${record.name}`);
  return Object.freeze({
    name: String(record.name).trim(),
    version: String(record.version),
    architectures: [...new Set((record.architectures?.length ? record.architectures : ['*']).map((value) => String(value).toLowerCase()))].sort(asciiCompare),
    dependencies: (record.dependencies ?? []).map((dependency) => Object.freeze({
      name: String(dependency.name),
      ...(dependency.version ? { version: String(dependency.version) } : {}),
    })),
    // readCatalogRecords() returns normalized rows and planCatalogPacks() also
    // accepts raw catalog rows, so normalization must remain idempotent.
    publicHeaders: [...new Set((record.providesIncludes ?? record.publicHeaders ?? []).map(String))].sort(asciiCompare),
    source: Object.freeze({
      url: String(record.url ?? source.url),
      sha256: checksum,
      ...((record.size ?? source.size) ? { size: Number(record.size ?? source.size) } : {}),
      ...((record.repository ?? source.repository) ? { repository: String(record.repository ?? source.repository) } : {}),
    }),
  });
}

/** Read the JSON array embedded in the generated catalog-data.ts file. */
export function readCatalogRecords(path = DEFAULT_CATALOG) {
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf('= [');
  const end = text.lastIndexOf('] as const;');
  if (start < 0 || end <= start) throw new Error(`catalog source is not generated JSON: ${path}`);
  const value = JSON.parse(text.slice(start + 2, end + 1));
  if (!Array.isArray(value)) throw new Error('catalog source does not contain an array');
  return Object.freeze(value.map(normalizeRecord));
}

/**
 * Reset catalog Pack hard dependencies before source inference. Arduino's
 * catalog `depends` metadata also covers examples and opt-in features, while
 * CK Registry `depends` is the default Action Graph closure. Reusing either a
 * previous inferred Registry or the broader Arduino list would make stale and
 * optional edges impossible to remove when the scanner becomes more precise.
 */
export function resetCatalogInferredDependencies(
  registry,
  records = readCatalogRecords(),
  architecture = 'esp32',
) {
  const catalogPacks = new Set(planCatalogPacks(records, { architecture }).map((entry) => (
    `${entry.name.toLowerCase()}@${entry.version}`
  )));
  const value = structuredClone(registry);
  const defaultVersions = new Map((value.libraries ?? []).map((library) => [
    String(library.name).toLowerCase(),
    String(library.defaultVersion ?? ''),
  ]));
  const registryVersions = new Set();
  for (const library of value.libraries ?? []) {
    for (const version of library.versions ?? []) {
      registryVersions.add(`${String(library.name).toLowerCase()}@${version.version}`);
    }
  }
  for (const library of value.libraries ?? []) {
    for (const version of library.versions ?? []) {
      version.depends = (version.depends ?? []).filter((dependency) => {
        const name = String(dependency.name).toLowerCase();
        const dependencyVersion = String(dependency.version ?? defaultVersions.get(name) ?? '');
        const identity = `${name}@${dependencyVersion}`;
        // Catalog Pack edges are rebuilt from source includes below, so clear
        // only edges that point at a Catalog Pack version. Platform/Core Pack
        // edges (and other curated Registry edges) must survive the reset.
        // This also removes stale catalog edges while retaining dependencies
        // such as SD@3.3.7 and SPI@3.3.7 that are supplied by the platform.
        return !catalogPacks.has(identity) && registryVersions.has(identity);
      });
    }
  }
  return value;
}

function readExistingRegistry(path = DEFAULT_REGISTRY) {
  try {
    const registry = JSON.parse(readFileSync(path, 'utf8'));
    const existing = new Map();
    const providedHeaders = new Map();
    for (const library of registry?.libraries ?? []) {
      const folded = String(library.name).toLowerCase();
      for (const version of library.versions ?? []) {
        existing.set(`${folded}@${version.version}`, version.pack);
        const provider = Object.freeze({
          name: library.name,
          version: version.version,
          architectures: Object.freeze([...(version.architectures ?? [])]),
        });
        for (const header of version.publicHeaders ?? []) {
          const key = String(header).toLowerCase();
          const owners = providedHeaders.get(key) ?? [];
          owners.push(provider);
          providedHeaders.set(key, owners);
        }
      }
    }
    return Object.freeze({ existing, providedHeaders });
  } catch {
    return Object.freeze({ existing: new Map(), providedHeaders: new Map() });
  }
}

function mergeStagingRegistry(baseRegistry, builtRows, replaceProviders = []) {
  const byName = new Map((baseRegistry?.libraries ?? []).map((library) => [
    String(library.name).toLowerCase(),
    structuredClone(library),
  ]));
  const replacements = new Set(replaceProviders.map((name) => String(name).toLowerCase()));
  for (const row of builtRows) {
    const addition = structuredClone(row.registryEntry);
    const key = addition.name.toLowerCase();
    if (replacements.has(key)) {
      const providedHeaders = new Set(addition.versions.flatMap((version) => version.publicHeaders.map((header) => header.toLowerCase())));
      const removed = new Set();
      for (const [currentKey, current] of byName) {
        if (currentKey === key) continue;
        const currentHeaders = new Set(current.versions.flatMap((version) => version.publicHeaders.map((header) => header.toLowerCase())));
        if (currentHeaders.size && [...currentHeaders].every((header) => providedHeaders.has(header))) {
          removed.add(currentKey);
          byName.delete(currentKey);
        }
      }
      for (const current of byName.values()) {
        for (const version of current.versions) {
          version.depends = version.depends.map((dependency) => (
            removed.has(dependency.name.toLowerCase())
              ? { name: addition.name, version: addition.defaultVersion }
              : dependency
          ));
        }
      }
    }
    const current = byName.get(key);
    if (!current) {
      byName.set(key, addition);
      continue;
    }
    for (const version of addition.versions) {
      if (!current.versions.some((candidate) => candidate.version === version.version)) current.versions.push(version);
    }
    current.versions.sort((left, right) => asciiCompare(left.version, right.version));
  }
  return {
    schema: 2,
    libraries: [...byName.values()].sort((left, right) => (
      asciiCompare(left.name.toLowerCase(), right.name.toLowerCase())
    )),
  };
}

export function catalogPackManifestPath(name, version, revision) {
  if (typeof version !== 'string' || !VERSION.test(version)) throw new TypeError('catalog Pack version is invalid');
  if (typeof revision !== 'string' || !SHA256.test(revision)) throw new TypeError('catalog Pack revision is invalid');
  return `${slug(name)}/${version}/${revision.toLowerCase()}/toolchain.json`;
}

/** Copy a complete Pack directory once, rejecting any attempt to mutate it. */
export function installImmutableCatalogPackDirectory(sourceDirectory, destinationDirectory) {
  const source = resolve(sourceDirectory);
  const destination = resolve(destinationDirectory);
  if (source === destination) return false;
  const sourceFiles = readDirectoryFiles(source);
  if (existsSync(destination)) {
    const destinationFiles = readDirectoryFiles(destination);
    if (sourceFiles.size !== destinationFiles.size
      || [...sourceFiles].some(([path, bytes]) => !bytes.equals(destinationFiles.get(path)))) {
      throw new Error(`immutable catalog Pack conflict: ${destination}`);
    }
    return false;
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
  return true;
}

function readDirectoryFiles(root) {
  if (!existsSync(root)) throw new Error(`catalog Pack directory is missing: ${root}`);
  const files = new Map();
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, path);
      else if (entry.isFile()) files.set(path, readFileSync(absolute));
      else throw new Error(`catalog Pack contains an unsupported filesystem entry: ${absolute}`);
    }
  };
  visit(root);
  return files;
}

/** Copy legacy registry packs into revision-addressed directories and repoint the clone. */
export function migrateCatalogRegistryToImmutablePaths(baseRegistry, registryPath, output) {
  const value = structuredClone(baseRegistry);
  const sourceRoot = dirname(registryPath);
  for (const library of value?.libraries ?? []) {
    for (const version of library.versions ?? []) {
      const manifest = String(version.pack?.manifest ?? '').replaceAll('\\', '/');
      const segments = manifest.split('/');
      if (segments.length < 2 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error(`base registry manifest path is invalid: ${manifest}`);
      }
      const immutableManifest = catalogPackManifestPath(library.name, version.version, version.pack?.revision);
      const source = resolve(sourceRoot, ...segments.slice(0, -1));
      const destination = resolve(output, ...immutableManifest.split('/').slice(0, -1));
      const sourceRelative = relative(sourceRoot, source);
      const destinationRelative = relative(output, destination);
      if (sourceRelative.startsWith('..') || destinationRelative.startsWith('..')) {
        throw new Error(`base registry manifest escapes its root: ${manifest}`);
      }
      installImmutableCatalogPackDirectory(source, destination);
      version.pack.manifest = immutableManifest;
    }
  }
  return value;
}

/**
 * Fill gaps in upstream `depends=` metadata from actual source includes.
 * Matching is entirely registry/header driven, so adding a new library never
 * requires a CK branch for its name.
 */
export function inferCatalogRegistryDependencies(registry, output) {
  const value = structuredClone(registry);
  const byName = new Map(value.libraries.map((library) => [library.name.toLowerCase(), library]));
  const headerOwners = new Map();
  const sourceByPack = new Map();
  const registerHeaderOwner = (header, library, version) => {
    const keys = new Set([header, header.split('/').at(-1)]);
    for (const key of keys) {
      const current = headerOwners.get(key);
      if (current && current.library.name.toLowerCase() !== library.name.toLowerCase()) {
        headerOwners.set(key, null);
      } else if (current !== null) {
        headerOwners.set(key, { library, version });
      }
    }
  };
  for (const library of value.libraries) {
    for (const version of library.versions) {
      for (const header of version.publicHeaders) registerHeaderOwner(header, library, version);
      const source = readRegistrySourceArtifact(output, version.pack);
      sourceByPack.set(version.pack.manifest, source);
      // Arduino permits compatibility headers beside the primary header even
      // when library.properties only declares one `includes=` entry. Index
      // every top-level header under src/ for dependency resolution while
      // keeping Registry publicHeaders unchanged as the user-facing surface.
      for (const file of source.files ?? []) {
        if (typeof file?.path !== 'string' || !/^src\/[^/]+$/.test(file.path)
          || !HEADER_EXTENSIONS.has(sourceExtension(file.path))) continue;
        registerHeaderOwner(file.path.slice('src/'.length), library, version);
      }
    }
  }

  for (const library of value.libraries) {
    for (const version of library.versions) {
      const declaredVersions = new Map(version.depends.map((dependency) => [
        dependency.name.toLowerCase(),
        dependency.version,
      ]));
      const inferred = new Map(version.depends.map((dependency) => [
        dependency.name.toLowerCase(),
        { ...dependency },
      ]));
      const source = sourceByPack.get(version.pack.manifest)
        ?? readRegistrySourceArtifact(output, version.pack);
      const publicHeaders = new Set(version.publicHeaders.map((header) => header.toLowerCase()));
      const sourceFiles = (source.files ?? []).filter((file) => (
        typeof file?.path === 'string'
        && typeof file?.content === 'string'
        && SOURCE_EXTENSIONS.has(sourceExtension(file.path))
      )).map((file) => Object.freeze({
        file,
        path: file.path.replace(/^src\//, '').toLowerCase(),
      }));
      const byPath = new Map(sourceFiles.map((entry) => [entry.path, entry]));
      const byBasename = new Map();
      for (const entry of sourceFiles) {
        const basename = entry.path.split('/').at(-1);
        if (!byBasename.has(basename)) byBasename.set(basename, entry);
        else if (byBasename.get(basename) !== entry) byBasename.set(basename, null);
      }
      const reachable = [];
      const reachability = new Map();
      const enqueue = (entry, optional = false) => {
        if (!entry) return;
        const previous = reachability.get(entry.path);
        // A required path is stronger than an optional one. Requeue an
        // optional header if another include later makes it required.
        if (previous === false || previous === optional) return;
        reachability.set(entry.path, optional);
        reachable.push({ entry, optional });
      };
      for (const entry of sourceFiles) {
        const extension = sourceExtension(entry.path);
        const basename = entry.path.split('/').at(-1);
        if (COMPILE_EXTENSIONS.has(extension) || publicHeaders.has(entry.path) || publicHeaders.has(basename)) enqueue(entry);
      }
      for (let cursor = 0; cursor < reachable.length; cursor++) {
        const { entry, optional } = reachable[cursor];
        if (reachability.get(entry.path) !== optional) continue;
        const { file, path } = entry;
        for (const { header: include, conditional } of sourceIncludes(file.content)) {
          const includeKey = include.toLowerCase();
          const basename = includeKey.split('/').at(-1);
          const separator = path.lastIndexOf('/');
          const relativeKey = separator < 0 ? includeKey : `${path.slice(0, separator + 1)}${includeKey}`;
          const local = byPath.get(relativeKey) ?? byPath.get(includeKey) ?? byBasename.get(basename);
          if (local) {
            enqueue(local, optional || conditional);
            continue;
          }
          // A dependency behind an unresolved feature/platform condition is
          // optional, not a hard Pack edge. Keep traversing conditional local
          // headers, but require users to select optional external Packs when
          // they enable the corresponding feature.
          if (optional || conditional) continue;
          const owner = resolveInferredHeaderOwner(headerOwners, include, version);
          if (!owner || owner.name.toLowerCase() === library.name.toLowerCase()) continue;
          const key = owner.name.toLowerCase();
          if (!inferred.has(key)) inferred.set(key, {
            name: owner.name,
            version: declaredVersions.get(key) ?? owner.defaultVersion,
          });
        }
      }
      version.depends = [...inferred.values()].sort((left, right) => (
        asciiCompare(left.name.toLowerCase(), right.name.toLowerCase())
        || asciiCompare(left.version, right.version)
      ));
    }
  }

  const registryUrl = new URL('registry.staging.json', `file:///${resolve(output).replaceAll('\\', '/')}/`).href;
  const validated = validateEsp32BrowserLibraryRegistry(value, registryUrl);
  for (const library of validated.libraries) {
    const result = resolveEsp32BrowserLibraries(validated, [{ name: library.name }], 'esp32');
    if (!result.supported) throw new Error(`inferred dependency graph is not resolvable: ${library.name}`);
  }
  return value;
}

export function resolveInferredHeaderOwner(headerOwners, include) {
  const normalized = String(include).replaceAll('\\', '/').replace(/^\.\//, '');
  const entry = headerOwners.get(normalized) ?? (!normalized.includes('/')
    ? headerOwners.get(normalized.split('/').at(-1))
    : undefined);
  if (!entry) return entry;
  return entry.library;
}

function readRegistrySourceArtifact(output, pack) {
  const manifestPath = resolve(output, ...String(pack.manifest).split('/'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const artifact = manifest.artifacts?.find((candidate) => candidate.id === pack.artifact);
  if (!artifact || artifact.kind !== 'library-source-json') {
    throw new Error(`library source artifact is missing: ${pack.manifest}`);
  }
  const directory = dirname(manifestPath);
  const bytes = Buffer.concat(artifact.chunks.map((chunk) => {
    const transport = readFileSync(resolve(directory, ...chunk.path.split('/')));
    let decoded = transport;
    if (chunk.compression !== undefined) {
      if (
        chunk.compression !== 'gzip'
        || transport.byteLength !== chunk.compressedSize
        || sha256(transport) !== chunk.compressedSha256
      ) throw new Error(`library source chunk transport integrity mismatch: ${pack.manifest}`);
      try { decoded = gunzipSync(transport); }
      catch { throw new Error(`library source chunk decompression failed: ${pack.manifest}`); }
    }
    if (decoded.byteLength !== chunk.size || sha256(decoded) !== chunk.sha256) {
      throw new Error(`library source chunk integrity mismatch: ${pack.manifest}`);
    }
    return decoded;
  }));
  if (bytes.byteLength !== artifact.size || sha256(bytes) !== artifact.sha256) {
    throw new Error(`library source artifact integrity mismatch: ${pack.manifest}`);
  }
  return JSON.parse(bytes.toString('utf8'));
}

export function sourceIncludes(source, buildMacros) {
  const includes = [];
  const conditions = [];
  // Arduino library Packs are planned for the current ESP32 3.x platform by
  // default. Callers building another platform revision may override these
  // build-context macros without adding library-specific inference rules.
  const definedMacros = new Map([
    ['ARDUINO', '1'],
    ['ESP32', '1'],
    ['ARDUINO_ARCH_ESP32', '1'],
    ['ESP_PLATFORM', '1'],
    // Arduino-ESP32 3.x is built on ESP-IDF 5.x. The major is part of the
    // platform build context, not a library-specific inference rule.
    ['ESP_IDF_VERSION_MAJOR', '5'],
  ]);
  for (const [name, value] of Object.entries(buildMacros ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`invalid dependency scan macro: ${name}`);
    if (value === undefined || value === null || value === false) definedMacros.delete(name);
    else definedMacros.set(name, value === true ? '1' : String(value));
  }
  let sawMeaningful = false;
  for (const line of withoutCxxComments(source).split(/\r?\n/)) {
    const directive = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(line);
    if (!directive) {
      if (line.trim()) {
        sawMeaningful = true;
        const pending = conditions.at(-1);
        if (pending?.awaitingGuardDefine) pending.awaitingGuardDefine = false;
      }
      continue;
    }
    const name = directive[1].toLowerCase();
    const body = directive[2].trim();
    const defaultCondition = (conditionName, conditionBody) => {
      const hasPlatformConfigMacro = /\b(?:CONFIG_[A-Za-z0-9_]*|SOC_[A-Za-z0-9_]*_SUPPORTED|ESP32|ARDUINO_ARCH_ESP32|ESP_PLATFORM)\b/.test(conditionBody);
      const evaluated = isDefaultActiveCondition(conditionName, conditionBody, definedMacros);
      return evaluated === undefined ? hasPlatformConfigMacro : evaluated;
    };
    if (name === 'if' || name === 'ifdef' || name === 'ifndef') {
      const macro = name === 'ifndef'
        ? /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(body)?.[1]
        : name === 'ifdef'
          ? /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(body)?.[1]
          : undefined;
      const guard = defaultCondition(name, body);
      conditions.push({
        // An `#ifndef FEATURE_DISABLED` branch is active unless callers
        // explicitly opt out, so its external includes belong in the default
        // Pack closure. ESP32 platform `CONFIG_*` symbols are generated by
        // the selected platform profile, as are `SOC_*_SUPPORTED` capability
        // macros and the core's ESP32 identity macros. Those branches are also
        // part of the default closure even
        // when expressed as `#if defined(...)`.
        // Other `#if` and `#ifdef` expressions remain optional because their
        // enabling definitions are not known to the offline Pack builder.
        guard,
        matched: guard,
        macro,
        awaitingGuardDefine: name === 'ifndef' && conditions.length === 0 && !sawMeaningful && Boolean(macro),
      });
      continue;
    }
    if (name === 'define') {
      const frame = conditions.at(-1);
      const macroMatch = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(body);
      const macro = macroMatch?.[1];
      const remainder = macroMatch?.[2] ?? '';
      const functionLike = remainder.startsWith('(');
      if (frame?.awaitingGuardDefine && macro === frame.macro) {
        frame.guard = true;
        frame.matched = true;
        frame.awaitingGuardDefine = false;
      }
      // Only unconditional object-like definitions can make a later #if
      // branch part of the default Pack closure. Function-like macros are
      // intentionally excluded because their name is not a boolean feature.
      // Definitions inside default-active include guards are unconditional
      // for the Pack's default closure. Recognize them so a later #if can
      // expose its required dependency (for example ETH.h -> SPI.h).
      if (macro && !conditions.some((condition) => !condition.guard) && !functionLike) {
        definedMacros.set(macro, remainder.trim() || '1');
      }
      continue;
    }
    if (name === 'else' || name === 'elif') {
      const frame = conditions.at(-1);
      if (frame) {
        const guard = name === 'else'
          ? !frame.matched
          : !frame.matched && defaultCondition('if', body);
        frame.guard = guard;
        if (guard) frame.matched = true;
        frame.awaitingGuardDefine = false;
      }
      continue;
    }
    if (name === 'endif') {
      conditions.pop();
      continue;
    }
    if (name !== 'include') continue;
    const match = /^[<"]([^>"]+)[>"]/.exec(body);
    if (!match) continue;
    const header = match[1].trim().replaceAll('\\', '/').replace(/^\.\//, '');
    if (safePublicHeader(header)) {
      includes.push(Object.freeze({
        header,
        conditional: conditions.some((condition) => !condition.guard),
      }));
    }
  }
  return includes;
}

function isDefaultActiveCondition(name, body, definedMacros) {
  if (name === 'ifndef') return !definedMacros.has(body.match(/^([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1]);
  if (name === 'ifdef') {
    const macro = body.match(/^([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1];
    if (definedMacros.has(macro)) return true;
    return isGeneratedPlatformMacro(macro) ? undefined : false;
  }
  return evaluatePreprocessorCondition(body, definedMacros);
}

function isGeneratedPlatformMacro(macro) {
  return typeof macro === 'string'
    && (/^CONFIG_[A-Za-z0-9_]*$/.test(macro) || /^SOC_[A-Za-z0-9_]*_SUPPORTED$/.test(macro));
}

// Evaluate the bounded expression subset used by Arduino library feature and
// platform guards. `undefined` means the expression depends on a macro that
// the offline Pack builder does not know; callers can then apply their
// platform-macro fallback without mistaking a known-false branch for active.
function evaluatePreprocessorCondition(source, definedMacros) {
  const tokens = tokenizePreprocessorCondition(source);
  if (!tokens) return undefined;
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = (value) => {
    if (peek() !== value) return false;
    cursor++;
    return true;
  };
  const boolean = (value) => value === undefined
    ? undefined
    : typeof value === 'boolean'
      ? value
      : value !== 0;
  const negate = (value) => {
    const resolved = boolean(value);
    return resolved === undefined ? undefined : !resolved;
  };
  const and = (left, right) => {
    const a = boolean(left);
    const b = boolean(right);
    if (a === false || b === false) return false;
    if (a === undefined || b === undefined) return undefined;
    return true;
  };
  const or = (left, right) => {
    const a = boolean(left);
    const b = boolean(right);
    if (a === true || b === true) return true;
    if (a === undefined || b === undefined) return undefined;
    return false;
  };
  const primary = () => {
    if (take('(')) {
      const value = disjunction();
      if (!take(')')) return undefined;
      return value;
    }
    const token = peek();
    if (!token) return undefined;
    cursor++;
    if (/^0[xX][0-9A-Fa-f]+$/.test(token)) return Number.parseInt(token.slice(2), 16);
    if (/^\d+$/.test(token)) return Number.parseInt(token, 10);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
      const value = resolveMacroValue(token, definedMacros);
      return value === undefined ? undefined : Number(value);
    }
    return undefined;
  };
  const unary = () => {
    if (take('!')) return negate(unary());
    if (take('+')) return unary();
    if (take('-')) {
      const value = unary();
      return typeof value === 'number' ? -value : undefined;
    }
    if (take('defined')) {
      const parenthesized = take('(');
      const macro = peek();
      if (!macro || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(macro)) return undefined;
      cursor++;
      if (parenthesized && !take(')')) return undefined;
      if (definedMacros.has(macro)) return true;
      return isGeneratedPlatformMacro(macro) ? undefined : false;
    }
    return primary();
  };
  const comparison = () => {
    let left = unary();
    while (/^(?:==|!=|<=|>=|<|>)$/.test(peek() ?? '')) {
      const operator = tokens[cursor++];
      const right = unary();
      if (left === undefined || right === undefined) left = undefined;
      else if (operator === '==') left = left === right;
      else if (operator === '!=') left = left !== right;
      else if (operator === '<=') left = left <= right;
      else if (operator === '>=') left = left >= right;
      else if (operator === '<') left = left < right;
      else left = left > right;
    }
    return left;
  };
  const conjunction = () => {
    let value = comparison();
    while (take('&&')) value = and(value, comparison());
    return value;
  };
  const disjunction = () => {
    let value = conjunction();
    while (take('||')) value = or(value, conjunction());
    return value;
  };
  const value = disjunction();
  return cursor === tokens.length ? boolean(value) : undefined;
}

function tokenizePreprocessorCondition(source) {
  const tokens = [];
  for (let cursor = 0; cursor < source.length;) {
    const rest = source.slice(cursor);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      cursor += whitespace[0].length;
      continue;
    }
    const token = /^(?:&&|\|\||==|!=|<=|>=|[()!+\-<>]|0[xX][0-9A-Fa-f]+|\d+|[A-Za-z_][A-Za-z0-9_]*)/.exec(rest)?.[0];
    if (!token) return undefined;
    tokens.push(token);
    cursor += token.length;
  }
  return tokens;
}

function unwrapCondition(value) {
  let expression = value.trim();
  while (expression.startsWith('(') && expression.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let index = 0; index < expression.length; index++) {
      if (expression[index] === '(') depth++;
      else if (expression[index] === ')') depth--;
      if (depth === 0 && index < expression.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps || depth !== 0) break;
    expression = expression.slice(1, -1).trim();
  }
  return expression;
}

function resolveMacroValue(token, definedMacros, seen = new Set()) {
  if (/^[-+]?(?:0[xX][0-9A-Fa-f]+|\d+)$/.test(token)) return String(Number(token));
  if (!definedMacros.has(token) || seen.has(token)) return undefined;
  seen.add(token);
  const value = unwrapCondition(String(definedMacros.get(token)).trim());
  if (/^[-+]?(?:0[xX][0-9A-Fa-f]+|\d+)$/.test(value)) return String(Number(value));
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return resolveMacroValue(value, definedMacros, seen);
  return undefined;
}

function withoutCxxComments(source) {
  let result = '';
  let state = 'normal';
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'line') {
      if (char === '\n') {
        result += char;
        state = 'normal';
      } else result += ' ';
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        result += '  ';
        index++;
        state = 'normal';
      } else result += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'string' || state === 'char') {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if ((state === 'string' && char === '"') || (state === 'char' && char === "'")) state = 'normal';
      continue;
    }
    if (char === '/' && next === '/') {
      result += '  ';
      index++;
      state = 'line';
    } else if (char === '/' && next === '*') {
      result += '  ';
      index++;
      state = 'block';
    } else {
      result += char;
      if (char === '"') state = 'string';
      else if (char === "'") state = 'char';
    }
  }
  return result;
}

/** Plan all catalog records without downloading archives. */
export function planCatalogPacks(records, {
  existing = new Map(),
  providedHeaders = new Map(),
  architecture = 'esp32',
  replaceProviders = [],
} = {}) {
  const normalizedRecords = records.map(normalizeRecord);
  const versionsByName = new Map(normalizedRecords.map((record) => [record.name.toLowerCase(), record.version]));
  const recordsByName = new Map(normalizedRecords.map((record) => [record.name.toLowerCase(), record]));
  const replacements = new Set(replaceProviders.map((name) => String(name).toLowerCase()));
  return Object.freeze(normalizedRecords.map((record) => {
    const key = `${record.name.toLowerCase()}@${record.version}`;
    const pack = existing.get(key);
    const compatible = record.architectures.some((candidate) => candidate === '*' || candidate === architecture);
    const replacement = compatible && !pack && record.publicHeaders.length && !replacements.has(record.name.toLowerCase())
      ? resolveHeaderReplacement(record, providedHeaders, architecture)
      : null;
    return Object.freeze({
      id: packId(record.name),
      name: record.name,
      version: record.version,
      architectures: record.architectures,
      dependencies: Object.freeze(record.dependencies.map((dependency) => {
        const target = recordsByName.get(dependency.name.toLowerCase());
        if (target && !target.architectures.some((candidate) => candidate === '*' || candidate === architecture)) return null;
        const version = dependency.version ?? versionsByName.get(dependency.name.toLowerCase());
        return version ? Object.freeze({ name: dependency.name, version }) : null;
      }).filter(Boolean)),
      publicHeaders: record.publicHeaders,
      source: record.source,
      state: !compatible ? 'incompatible' : pack ? 'existing' : replacement ? 'superseded' : 'candidate',
      ...(pack ? { pack } : {}),
      ...(replacement ? { replacement } : {}),
    });
  }));
}

function resolveHeaderReplacement(record, providedHeaders, architecture) {
  const providers = new Map();
  for (const header of record.publicHeaders) {
    const compatible = (providedHeaders.get(header.toLowerCase()) ?? []).filter((provider) => (
      provider.name.toLowerCase() !== record.name.toLowerCase()
      && provider.architectures.some((candidate) => candidate === '*' || candidate === architecture)
    ));
    if (!compatible.length) return null;
    for (const provider of compatible) {
      providers.set(`${provider.name.toLowerCase()}@${provider.version}`, provider);
    }
  }
  return Object.freeze([...providers.values()].sort((left, right) => (
    asciiCompare(left.name.toLowerCase(), right.name.toLowerCase())
    || asciiCompare(left.version, right.version)
  )));
}

function findIncludeHeader(path, files) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.?\//, '');
  const direct = files.find((file) => file.path === normalized);
  if (direct) return normalized;
  const suffix = `/${normalized}`;
  const matching = files.filter((file) => file.path.endsWith(suffix));
  return matching.length === 1 ? matching[0].path : null;
}

/** Convert one verified archive into the exact source payload used by the browser executor. */
export function createCatalogSourcePack(recordInput, archiveBytes, limits = CATALOG_PACK_LIMITS) {
  const files = stripArchiveRoot(parseCatalogZip(archiveBytes, limits, catalogSourceArchiveEntry));
  return createCatalogSourcePackFromFiles(recordInput, files, limits);
}

/** Build the same immutable Pack from an already verified platform source tree. */
export function createCatalogSourcePackFromFiles(recordInput, filesInput, limits = CATALOG_PACK_LIMITS) {
  const record = normalizeRecord(recordInput);
  if (!Array.isArray(filesInput) || !filesInput.length || filesInput.length > limits.maxArchiveFiles) {
    throw new TypeError(`${record.name} verified source file list is invalid`);
  }
  const seen = new Set();
  const files = filesInput.map((file) => {
    const path = safeArchivePath(file?.path);
    if (seen.has(path)) throw new Error(`${record.name} verified source tree contains a duplicate path: ${path}`);
    seen.add(path);
    if (!(file?.bytes instanceof Uint8Array) || file.bytes.byteLength > limits.maxArchiveFileBytes) {
      throw new TypeError(`${record.name} verified source file is invalid: ${path}`);
    }
    return Object.freeze({ path, bytes: Buffer.from(file.bytes) });
  }).sort((left, right) => asciiCompare(left.path, right.path));
  const selected = files.filter((file) => {
    if (sourcePathExcluded(file.path)) return false;
    return SOURCE_EXTENSIONS.has(sourceExtension(file.path));
  });
  const hasSrc = selected.some((file) => file.path === 'src' || file.path.startsWith('src/'));
  // Legacy Arduino libraries keep their compile units at the archive root;
  // nested trees are headers or optional host backends unless explicitly
  // included by a root source file. Index the complete verified source set,
  // but seed the closure with root files so referenced nested `.c` fragments
  // remain available without compiling every host backend independently.
  const sourceFiles = sourceTreeWithRelativeClosure(selected, !hasSrc);
  if (!sourceFiles.length) throw new Error(`${record.name} archive has no compilable source files`);
  if (sourceFiles.length > limits.maxSourceFiles) throw new Error(`${record.name} source file count exceeds the browser pack limit`);

  const published = sourceFiles
    .map((file) => Object.freeze({
      path: hasSrc ? file.path : `src/${file.path}`,
      bytes: file.bytes,
    }))
    .sort((left, right) => asciiCompare(left.path, right.path));
  const sourceBytes = published.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (sourceBytes > limits.maxSourceBytes) throw new Error(`${record.name} source tree exceeds the browser Pack limit`);

  const includeDirs = Object.freeze(hasSrc && sourceFiles.some((file) => !file.path.startsWith('src/'))
    ? ['.', 'src']
    : ['src']);
  const headers = new Set();
  const declaredHeaders = record.publicHeaders.length ? record.publicHeaders : libraryPropertyIncludes(files);
  for (const header of declaredHeaders) {
    const path = findIncludeHeader(header, published);
    if (path && path.startsWith('src/') && safePublicHeader(path.slice(4))) headers.add(path.slice(4));
  }
  // Arduino's default export surface is the set of headers directly in the
  // source root. Nested headers remain compilable but are not global registry
  // aliases, which avoids collisions on private names such as config.h.
  if (!headers.size) {
    for (const file of published) {
      const relativePath = file.path.startsWith('src/') ? file.path.slice(4) : '';
      if (!relativePath.includes('/') && HEADER_EXTENSIONS.has(sourceExtension(relativePath)) && safePublicHeader(relativePath)) {
        headers.add(relativePath);
      }
    }
  }
  if (!headers.size) throw new Error(`${record.name} archive has no public headers`);
  if (headers.size > 512) throw new Error(`${record.name} public header count exceeds the browser registry limit`);

  const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
  const legacyDecoder = new TextDecoder('windows-1252', { fatal: true });
  const lockedFiles = [];
  const payloadFiles = published.map((file) => {
    let content;
    let sourceEncoding = 'utf-8';
    try { content = utf8Decoder.decode(file.bytes); }
    catch {
      // A few long-lived Arduino libraries still contain Windows-1252 bytes
      // in generated C comments. Normalize those text files deterministically
      // instead of replacing bytes with U+FFFD or rejecting the whole Pack.
      sourceEncoding = 'windows-1252';
      content = legacyDecoder.decode(file.bytes);
    }
    const normalizedBytes = Buffer.from(content, 'utf8');
    lockedFiles.push(Object.freeze({
      path: file.path,
      bytes: normalizedBytes,
      ...(sourceEncoding === 'utf-8' ? {} : {
        sourceEncoding,
        upstreamSha256: sha256(file.bytes),
      }),
    }));
    return { path: file.path, content };
  });
  const payload = {
    schema: 1,
    name: record.name,
    version: record.version,
    architectures: record.architectures,
    includeDirs,
    files: payloadFiles,
  };
  const artifactBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const maxPayloadBytes = limits.maxPayloadBytes ?? limits.maxSourceBytes;
  if (artifactBytes.byteLength > maxPayloadBytes) throw new Error(`${record.name} serialized source artifact exceeds the browser Pack limit`);
  const digest = sha256(artifactBytes);
  const id = packId(record.name);
  const transportChunks = createSourceArtifactChunks(artifactBytes, limits);
  const artifact = Object.freeze({
    id: 'sources',
    kind: 'library-source-json',
    size: artifactBytes.byteLength,
    sha256: digest,
    chunks: Object.freeze(transportChunks.map(({ bytes: _bytes, ...chunk }) => Object.freeze(chunk))),
  });
  const pack = {
    id,
    version: record.version,
    revision: sha256(Buffer.from(JSON.stringify({ schema: 1, id, version: record.version, artifacts: [artifact] }), 'utf8')),
    artifact,
    publicHeaders: Object.freeze([...headers].sort((left, right) => asciiCompare(left.toLowerCase(), right.toLowerCase()) || asciiCompare(left, right))),
    bytes: artifactBytes,
    transportBytes: transportChunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0),
    chunks: Object.freeze(transportChunks),
    files: Object.freeze(lockedFiles),
  };
  return Object.freeze(pack);
}

function sourceTreeWithRelativeClosure(files, includeRootFiles = false) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const selected = new Map();
  const queue = [];
  const enqueue = (file) => {
    if (!file || selected.has(file.path)) return;
    selected.set(file.path, file);
    queue.push(file);
  };
  for (const file of files) {
    if (file.path.startsWith('src/') || (includeRootFiles && !file.path.includes('/'))) enqueue(file);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const file = queue[cursor];
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); }
    catch {
      try { source = new TextDecoder('windows-1252', { fatal: true }).decode(file.bytes); }
      catch { continue; }
    }
    const base = file.path.split('/').slice(0, -1);
    const expression = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/gm;
    const stripped = withoutCxxComments(source);
    for (let match = expression.exec(stripped); match; match = expression.exec(stripped)) {
      const include = match[2];
      const relativeTarget = match[1] === '"'
        ? resolveArchiveRelativePath(base, include)
        : undefined;
      const rootTarget = resolveArchiveRelativePath([], include);
      enqueue(byPath.get(relativeTarget) ?? byPath.get(rootTarget));
    }
  }
  return [...selected.values()].sort((left, right) => asciiCompare(left.path, right.path));
}

function resolveArchiveRelativePath(base, include) {
  if (!include || include.startsWith('/') || include.includes('\\') || include.includes('\0')) return undefined;
  const target = [...base];
  for (const segment of include.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!target.length) return undefined;
      target.pop();
    } else target.push(segment);
  }
  return target.join('/');
}

function createSourceArtifactChunks(bytes, limits) {
  const maxChunkBytes = limits.maxChunkBytes ?? Math.min(1024 * 1024, limits.maxSourceBytes);
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes <= 0) throw new TypeError('catalog source chunk limit is invalid');
  const chunks = [];
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += maxChunkBytes, index++) {
    const decoded = bytes.subarray(offset, Math.min(bytes.byteLength, offset + maxChunkBytes));
    const decodedSha256 = sha256(decoded);
    const compressed = gzipSync(decoded, { level: 9, mtime: 0 });
    const useCompression = compressed.byteLength < decoded.byteLength;
    const transport = useCompression ? compressed : Buffer.from(decoded);
    const transportSha256 = sha256(transport);
    const suffix = useCompression ? '.bin.gz' : '.bin';
    chunks.push(Object.freeze({
      path: `chunks/sources-${String(index).padStart(4, '0')}-${transportSha256.slice(0, 16)}${suffix}`,
      size: decoded.byteLength,
      sha256: decodedSha256,
      ...(useCompression ? {
        compression: 'gzip',
        compressedSize: transport.byteLength,
        compressedSha256: transportSha256,
      } : {}),
      bytes: transport,
    }));
  }
  return chunks;
}

function writeCatalogPack(output, plan, built) {
  const manifestPath = catalogPackManifestPath(plan.name, plan.version, built.revision);
  if (!isEsp32BrowserLibraryImmutableManifestPath(manifestPath, built.revision)) {
    throw new Error(`${plan.name} immutable manifest path is invalid`);
  }
  const directory = resolve(output, ...manifestPath.split('/').slice(0, -1));
  const temporary = `${directory}.build-${process.pid}-${Date.now()}`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(join(temporary, 'chunks'), { recursive: true });
  for (const chunk of built.chunks) writeFileSync(join(temporary, ...chunk.path.split('/')), chunk.bytes);
  const manifest = {
    schema: 1,
    id: built.id,
    version: built.version,
    revision: built.revision,
    artifacts: [built.artifact],
  };
  writeFileSync(join(temporary, 'toolchain.json'), stableJson(manifest), 'utf8');
  writeFileSync(join(temporary, 'source-lock.json'), stableJson({
    schema: 1,
    upstream: plan.source.repository,
    archive: { url: plan.source.url, sha256: plan.source.sha256 },
    files: built.files.map((file) => ({
      path: file.path,
      sha256: sha256(file.bytes),
      ...(file.sourceEncoding ? {
        sourceEncoding: file.sourceEncoding,
        upstreamSha256: file.upstreamSha256,
      } : {}),
    })),
  }), 'utf8');
  try {
    installImmutableCatalogPackDirectory(temporary, directory);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return Object.freeze({
    name: plan.name,
    defaultVersion: plan.version,
    versions: [{
      version: plan.version,
      architectures: plan.architectures,
      publicHeaders: built.publicHeaders,
      depends: plan.dependencies,
      pack: {
        id: built.id,
        revision: built.revision,
        manifest: manifestPath,
        artifact: 'sources',
      },
    }],
  });
}

async function fetchArchive(plan) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CATALOG_PACK_LIMITS.archiveDownloadTimeoutMs);
  try {
    const response = await fetch(plan.source.url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`${plan.name} archive returned HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > CATALOG_PACK_LIMITS.maxArchiveBytes) {
      throw new Error(`${plan.name} archive exceeds the byte limit`);
    }
    return verifyCatalogArchive(plan, Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${plan.name} archive download timed out`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Verify a downloaded or locally cached immutable catalog archive. */
export function verifyCatalogArchive(plan, archiveBytes) {
  const bytes = Buffer.isBuffer(archiveBytes) ? archiveBytes : Buffer.from(archiveBytes);
  if (bytes.length > CATALOG_PACK_LIMITS.maxArchiveBytes) throw new Error(`${plan.name} archive exceeds the byte limit`);
  if (plan.source.size !== undefined && bytes.length !== plan.source.size) {
    throw new Error(`${plan.name} archive size mismatch`);
  }
  if (sha256(bytes) !== plan.source.sha256) throw new Error(`${plan.name} archive checksum mismatch`);
  return bytes;
}

export function parseCatalogBuildArgs(argv) {
  const options = { catalog: DEFAULT_CATALOG, registry: DEFAULT_REGISTRY, output: DEFAULT_OUTPUT, architecture: 'esp32', limit: 0, concurrency: 4, build: false, names: [], replaceProviders: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--build') { options.build = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    if (argument === '--catalog') options.catalog = resolve(value);
    else if (argument === '--registry') options.registry = resolve(value);
    else if (argument === '--output') options.output = resolve(value);
    else if (argument === '--archive') options.archive = resolve(value);
    else if (argument === '--architecture') options.architecture = value.toLowerCase();
    else if (argument === '--limit') options.limit = Math.max(0, Math.floor(Number(value)));
    else if (argument === '--concurrency') options.concurrency = Math.max(1, Math.min(8, Math.floor(Number(value))));
    else if (argument === '--name') options.names.push(value.toLowerCase());
    else if (argument === '--replace-provider') options.replaceProviders.push(value.toLowerCase());
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!Number.isFinite(options.limit)) throw new Error('--limit must be a number');
  if (!Number.isFinite(options.concurrency)) throw new Error('--concurrency must be a number');
  if (!/^[a-z][a-z0-9._-]{0,31}$/.test(options.architecture)) throw new Error('--architecture is invalid');
  return options;
}

export async function buildCatalogPacks(options = {}) {
  const records = readCatalogRecords(options.catalog ?? DEFAULT_CATALOG);
  const registryPath = options.registry ?? DEFAULT_REGISTRY;
  const baseRegistry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const registryState = readExistingRegistry(registryPath);
  const plan = planCatalogPacks(records, {
    existing: registryState.existing,
    providedHeaders: registryState.providedHeaders,
    architecture: options.architecture ?? 'esp32',
    replaceProviders: options.replaceProviders ?? [],
  });
  const candidate = plan.filter((entry) => entry.state === 'candidate' && (!options.names?.length || options.names.includes(entry.name.toLowerCase())));
  const limit = options.limit > 0 ? options.limit : 0;
  const selected = limit ? candidate.slice(0, limit) : [];
  if (options.archive && (!options.build || selected.length !== 1)) {
    throw new Error('--archive requires --build with exactly one selected catalog candidate');
  }
  const output = resolve(options.output ?? DEFAULT_OUTPUT);
  mkdirSync(output, { recursive: true });
  const report = {
    schema: 2,
    generatedAt: new Date().toISOString(),
    architecture: options.architecture ?? 'esp32',
    catalog: { path: options.catalog ?? DEFAULT_CATALOG, count: plan.length },
    existing: plan.filter((entry) => entry.state === 'existing').length,
    incompatible: plan.filter((entry) => entry.state === 'incompatible').length,
    superseded: plan.filter((entry) => entry.state === 'superseded').length,
    candidates: candidate.length,
    selected: selected.length,
    pending: candidate.length - selected.length,
    status: options.build ? (candidate.length === selected.length ? 'complete' : 'partial') : 'plan',
    built: [],
    failed: [],
  };
  writeFileSync(join(output, 'catalog-pack-plan.json'), stableJson(plan), 'utf8');
  if (options.build) {
    const results = new Array(selected.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < selected.length) {
        const index = cursor++;
        const entry = selected[index];
        try {
          const archive = options.archive
            ? verifyCatalogArchive(entry, readFileSync(options.archive))
            : await fetchArchive(entry);
          const built = createCatalogSourcePack(entry, archive);
          const registryEntry = writeCatalogPack(output, entry, built);
          results[index] = { ok: true, value: {
            name: entry.name,
            version: entry.version,
            artifactBytes: built.artifact.size,
            transportBytes: built.transportBytes,
            chunks: built.artifact.chunks.length,
            registryEntry,
          } };
        } catch (error) {
          const failure = classifyCatalogPackFailure(error);
          results[index] = { ok: false, value: {
            name: entry.name,
            version: entry.version,
            error: error instanceof Error ? error.message : String(error),
            ...failure,
          } };
        }
      }
    };
    const concurrency = Math.min(selected.length, options.concurrency ?? 4);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    for (const result of results) (result.ok ? report.built : report.failed).push(result.value);
  }
  report.failureClasses = Object.fromEntries(
    [...new Set(report.failed.map(({ failureClass }) => failureClass).filter(Boolean))]
      .sort()
      .map((failureClass) => [failureClass, report.failed.filter((failure) => failure.failureClass === failureClass).length]),
  );
  const immutableBaseRegistry = migrateCatalogRegistryToImmutablePaths(baseRegistry, registryPath, output);
  let stagingRegistry = mergeStagingRegistry(immutableBaseRegistry, report.built, options.replaceProviders ?? []);
  stagingRegistry = resetCatalogInferredDependencies(
    stagingRegistry,
    records,
    options.architecture ?? 'esp32',
  );
  stagingRegistry = inferCatalogRegistryDependencies(stagingRegistry, output);
  const stagingRegistryBytes = Buffer.from(stableJson(stagingRegistry), 'utf8');
  const stagingRegistryPath = join(output, 'registry.staging.json');
  writeFileSync(stagingRegistryPath, stagingRegistryBytes);
  report.stagingRegistry = {
    path: stagingRegistryPath,
    sha256: sha256(stagingRegistryBytes),
    libraries: stagingRegistry.libraries.length,
  };
  writeFileSync(join(output, 'catalog-pack-build-report.json'), stableJson(report), 'utf8');
  return Object.freeze({
    output,
    plan,
    candidateCount: candidate.length,
    built: Object.freeze(report.built),
    failed: Object.freeze(report.failed),
    stagingRegistry: Object.freeze(report.stagingRegistry),
    reportPath: join(output, 'catalog-pack-build-report.json'),
  });
}

async function main() {
  const result = await buildCatalogPacks(parseCatalogBuildArgs(process.argv.slice(2)));
  console.log(`catalog=${result.plan.length}`);
  console.log(`existing=${result.plan.filter((entry) => entry.state === 'existing').length}`);
  console.log(`incompatible=${result.plan.filter((entry) => entry.state === 'incompatible').length}`);
  console.log(`candidates=${result.candidateCount}`);
  console.log(`built=${result.built.length}`);
  if (result.failed.length) console.log(`failed=${result.failed.length}`);
  console.log(`staging=${result.stagingRegistry.libraries}`);
  console.log(`output=${result.output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
