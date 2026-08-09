import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { Library } from '../toolchain/library.js';
import {
  publicBlocksMetadata,
  validateBlocksMetadata,
  type BlocksMetadata,
} from '../blocks/schema.js';
import { CK_ARDUINO_COMMON_LIBRARY_INDEX } from './catalog-data.js';

/** Versioned, executor-independent catalog schema. */
export const CK_LIBRARY_CATALOG_SCHEMA = 1;
export const CK_LIBRARY_CATALOG_MAX_SELECTIONS = 64;

export type LibraryCatalogSource =
  | {
      kind: 'archive';
      url: string;
      sha256: string;
      size?: number;
      repository?: string;
    }
  | {
      kind: 'local';
      path: string;
      sha256: string;
    }
  | {
      kind: 'pack';
      packId: string;
      revision: string;
    };

export interface LibraryCatalogDependency {
  name: string;
  /** Arduino Library Index dependencies may omit a version. */
  version?: string;
}

export interface LibraryCatalogVersion {
  id: string;
  name: string;
  version: string;
  architectures: readonly string[];
  dependencies: readonly LibraryCatalogDependency[];
  /** Public headers known without unpacking the archive. */
  publicHeaders: readonly string[];
  source: LibraryCatalogSource;
  description?: string;
  category?: string;
  license?: string;
  /** Approved generator metadata. Drafts remain local to the review API. */
  blocksMeta?: BlocksMetadata;
}

export interface LibraryCatalogEntry {
  id: string;
  name: string;
  defaultVersion: string;
  versions: readonly LibraryCatalogVersion[];
}

export interface LibraryCatalogRef {
  name: string;
  version?: string;
}

export interface LibraryCatalogResolution {
  libraries: readonly LibraryCatalogVersion[];
  errors: readonly string[];
}

export interface LibraryCatalogQuery {
  architecture?: string;
  text?: string;
  limit?: number;
}

export interface ArduinoLibraryIndexRecord {
  name: string;
  version: string;
  architectures?: string[];
  dependencies?: Array<{ name: string; version?: string }>;
  providesIncludes?: string[];
  sentence?: string;
  category?: string;
  license?: string;
  repository?: string;
  url: string;
  size?: number;
  checksum: string;
}

const SHA256 = /^[a-f0-9]{64}$/i;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const ARCH = /^(?:\*|[A-Za-z][A-Za-z0-9._-]{0,31})$/;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fold(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function slug(value: string): string {
  const result = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return result || 'library';
}

function assertVersion(value: string, label: string): void {
  if (!VERSION.test(value)) throw new TypeError(`${label} has an invalid version`);
}

function assertSource(source: LibraryCatalogSource): void {
  if (!source || typeof source !== 'object') throw new TypeError('library catalog source is required');
  if (source.kind === 'archive') {
    if (!source.url || typeof source.url !== 'string' || !SHA256.test(source.sha256)) {
      throw new TypeError('library archive source must have a URL and SHA-256');
    }
    if (source.size !== undefined && (!Number.isSafeInteger(source.size) || source.size <= 0)) {
      throw new TypeError('library archive source size is invalid');
    }
    return;
  }
  if (source.kind === 'local') {
    if (!source.path || typeof source.path !== 'string' || !SHA256.test(source.sha256)) {
      throw new TypeError('local library source must have a path and SHA-256');
    }
    return;
  }
  if (source.kind === 'pack') {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(source.packId) || !SHA256.test(source.revision)) {
      throw new TypeError('library pack source identity is invalid');
    }
    return;
  }
  throw new TypeError('unknown library catalog source kind');
}

function sourceIdentity(source: LibraryCatalogSource): string {
  if (source.kind === 'archive') {
    return `archive\0${source.url}\0${source.sha256}\0${source.size ?? ''}\0${source.repository ?? ''}`;
  }
  if (source.kind === 'local') return `local\0${source.path}\0${source.sha256}`;
  return `pack\0${source.packId}\0${source.revision}`;
}

function normalizeVersion(value: LibraryCatalogVersion): LibraryCatalogVersion {
  if (!value || typeof value !== 'object' || !value.name.trim()) {
    throw new TypeError('library catalog version is invalid');
  }
  assertVersion(value.version, `${value.name} catalog entry`);
  if (!value.id || !/^[a-z][a-z0-9._-]{0,127}$/.test(value.id)) {
    throw new TypeError(`library catalog id is invalid: ${value.name}`);
  }
  const architectures = [...new Set(value.architectures.map((arch) => arch.trim().toLowerCase()))].sort(compareText);
  if (!architectures.length || architectures.some((arch) => !ARCH.test(arch))) {
    throw new TypeError(`library catalog architectures are invalid: ${value.name}`);
  }
  const dependencyNames = new Set<string>();
  const dependencies = value.dependencies.map((dependency) => {
    if (!dependency || !dependency.name.trim()) throw new TypeError(`library dependency is invalid: ${value.name}`);
    const dependencyKey = fold(dependency.name);
    if (dependencyNames.has(dependencyKey)) throw new TypeError(`duplicate library dependency: ${value.name} -> ${dependency.name}`);
    dependencyNames.add(dependencyKey);
    if (dependency.version !== undefined) assertVersion(dependency.version, `${dependency.name} dependency`);
    return Object.freeze({ name: dependency.name.trim(), ...(dependency.version ? { version: dependency.version } : {}) });
  });
  const publicHeaders = [...new Set(value.publicHeaders.map((header) => header.trim()))]
    .filter(Boolean)
    .sort(compareText);
  assertSource(value.source);
  if (value.blocksMeta !== undefined) {
    const validation = validateBlocksMetadata(value.blocksMeta);
    if (!validation.valid || validation.value?.review.status !== 'approved'
      || validation.value.library.name !== value.name || validation.value.library.version !== value.version) {
      throw new TypeError(`library catalog blocks metadata is invalid: ${value.name}@${value.version}`);
    }
  }
  return Object.freeze({
    ...value,
    id: value.id,
    name: value.name.trim(),
    version: value.version,
    architectures: Object.freeze(architectures),
    dependencies: Object.freeze(dependencies),
    publicHeaders: Object.freeze(publicHeaders),
    source: Object.freeze({ ...value.source }),
  });
}

function normalizeEntries(entries: readonly LibraryCatalogEntry[]): readonly LibraryCatalogEntry[] {
  const names = new Set<string>();
  const ids = new Set<string>();
  const normalized = entries.map((entry) => {
    if (!entry || !entry.name.trim() || !entry.id || !/^[a-z][a-z0-9._-]{0,127}$/.test(entry.id)) {
      throw new TypeError('library catalog entry is invalid');
    }
    const nameKey = fold(entry.name);
    if (names.has(nameKey) || ids.has(entry.id)) throw new TypeError(`duplicate library catalog entry: ${entry.name}`);
    names.add(nameKey);
    ids.add(entry.id);
    if (!entry.versions.length) throw new TypeError(`library catalog entry has no versions: ${entry.name}`);
    const versions = entry.versions.map(normalizeVersion).sort((a, b) => compareText(a.version, b.version));
    const versionKeys = new Map<string, LibraryCatalogVersion>();
    for (const version of versions) {
      const existing = versionKeys.get(version.version);
      if (existing) {
        const label = sourceIdentity(existing.source) === sourceIdentity(version.source)
          ? 'duplicate library version'
          : 'ambiguous library source revision';
        throw new TypeError(`${label}: ${entry.name}@${version.version}`);
      }
      versionKeys.set(version.version, version);
    }
    if (!versionKeys.has(entry.defaultVersion)) {
      throw new TypeError(`library catalog default version is missing: ${entry.name}`);
    }
    return Object.freeze({
      id: entry.id,
      name: entry.name.trim(),
      defaultVersion: entry.defaultVersion,
      versions: Object.freeze(versions),
    });
  }).sort((a, b) => compareText(fold(a.name), fold(b.name)));

  const byName = new Map(normalized.map((entry) => [fold(entry.name), entry]));
  for (const entry of normalized) {
    for (const version of entry.versions) {
      for (const dependency of version.dependencies) {
        const target = byName.get(fold(dependency.name));
        if (!target) throw new TypeError(`library catalog dependency is missing: ${entry.name} -> ${dependency.name}`);
        if (dependency.version && !target.versions.some((candidate) => candidate.version === dependency.version)) {
          throw new TypeError(`library catalog dependency version is missing: ${entry.name} -> ${dependency.name}@${dependency.version}`);
        }
      }
    }
  }
  return Object.freeze(normalized);
}

/** Immutable catalog shared by native and browser planning code. */
export class LibraryCatalog {
  readonly schema = CK_LIBRARY_CATALOG_SCHEMA;
  readonly entries: readonly LibraryCatalogEntry[];
  private readonly byName: ReadonlyMap<string, LibraryCatalogEntry>;
  private readonly byId: ReadonlyMap<string, LibraryCatalogEntry>;

  constructor(entries: readonly LibraryCatalogEntry[]) {
    this.entries = normalizeEntries(entries);
    this.byName = new Map(this.entries.map((entry) => [fold(entry.name), entry]));
    this.byId = new Map(this.entries.flatMap((entry) => [
      [entry.id, entry] as const,
      ...entry.versions.map((version) => [version.id, entry] as const),
    ]));
  }

  static fromArduinoLibraryIndex(records: readonly ArduinoLibraryIndexRecord[]): LibraryCatalog {
    const byName = new Map<string, ArduinoLibraryIndexRecord>();
    for (const record of records) {
      if (!record || !record.name || !record.version || !record.url || !record.checksum) continue;
      const sha256 = record.checksum.replace(/^SHA-256:/i, '').toLowerCase();
      if (!SHA256.test(sha256)) continue;
      const current = byName.get(fold(record.name));
      // The official index is sorted by release, but compare versions so an
      // externally supplied index cannot silently select an older release.
      if (!current || compareVersions(current.version, record.version) < 0) byName.set(fold(record.name), record);
    }
    const entries: LibraryCatalogEntry[] = [];
    for (const record of byName.values()) {
      const version = catalogVersionFromIndex(record);
      entries.push({ id: slug(record.name), name: record.name, defaultVersion: version.version, versions: [version] });
    }
    return new LibraryCatalog(entries);
  }

  /** Build a catalog from already loaded, content-addressed local libraries. */
  static fromLibraries(libraries: readonly Library[]): LibraryCatalog {
    return new LibraryCatalog(libraries.map((library) => {
      const manifest = library.manifest;
      const source: LibraryCatalogSource = {
        kind: 'local',
        path: library.rootDir,
        sha256: libraryContentHash(library),
      };
      const version: LibraryCatalogVersion = {
        id: slug(manifest.name),
        name: manifest.name,
        version: manifest.version,
        architectures: manifest.architectures,
        dependencies: manifest.depends.map((name) => ({ name })),
        publicHeaders: library.headers,
        source,
        ...(manifest.category ? { category: manifest.category } : {}),
        ...(manifest.license ? { license: manifest.license } : {}),
        ...(manifest.url ? { description: manifest.url } : {}),
        ...(publicBlocksMetadata(library.blocksMeta) ? { blocksMeta: publicBlocksMetadata(library.blocksMeta)! } : {}),
      };
      return { id: version.id, name: version.name, defaultVersion: version.version, versions: [version] };
    }));
  }

  get(nameOrId: string, version?: string): LibraryCatalogVersion | undefined {
    const entry = this.byName.get(fold(nameOrId)) ?? this.byId.get(nameOrId);
    if (!entry) return undefined;
    return entry.versions.find((candidate) => candidate.version === (version ?? entry.defaultVersion));
  }

  list(query: LibraryCatalogQuery = {}): readonly LibraryCatalogVersion[] {
    const architecture = query.architecture?.toLowerCase();
    const text = query.text?.trim().toLowerCase();
    const limit = query.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(query.limit));
    const result: LibraryCatalogVersion[] = [];
    for (const entry of this.entries) {
      const version = entry.versions.find((candidate) => candidate.version === entry.defaultVersion)!;
      if (architecture && !version.architectures.some((candidate) => candidate === '*' || candidate === architecture)) continue;
      if (text && !`${version.name} ${version.description ?? ''}`.toLowerCase().includes(text)) continue;
      result.push(version);
      if (result.length >= limit) break;
    }
    return Object.freeze(result);
  }

  /** Resolve exact/default versions and all transitive dependencies. */
  resolve(refs: readonly LibraryCatalogRef[], architecture?: string): LibraryCatalogResolution {
    if (refs.length > CK_LIBRARY_CATALOG_MAX_SELECTIONS) {
      return { libraries: Object.freeze([]), errors: Object.freeze(['too many library selections']) };
    }
    const ordered: LibraryCatalogVersion[] = [];
    const selected = new Map<string, string>();
    const visiting = new Set<string>();
    const errors: string[] = [];
    const visit = (name: string, requestedVersion: string | undefined, chain: string[]): void => {
      const entry = this.byName.get(fold(name)) ?? this.byId.get(name);
      if (!entry) { errors.push(`library not found: ${name}`); return; }
      const versionText = requestedVersion ?? entry.defaultVersion;
      const existing = selected.get(fold(entry.name));
      if (existing) {
        if (existing !== versionText) errors.push(`library version conflict: ${entry.name}@${existing} vs ${versionText}`);
        return;
      }
      const version = entry.versions.find((candidate) => candidate.version === versionText);
      if (!version) { errors.push(`library version not found: ${entry.name}@${versionText}`); return; }
      if (architecture && !version.architectures.some((candidate) => candidate === '*' || candidate === architecture.toLowerCase())) {
        errors.push(`library ${entry.name}@${version.version} does not support ${architecture}`); return;
      }
      const key = `${fold(entry.name)}@${version.version}`;
      if (visiting.has(key)) { errors.push(`library dependency cycle: ${[...chain, key].join(' -> ')}`); return; }
      visiting.add(key);
      const errorsBeforeDependencies = errors.length;
      for (const dependency of version.dependencies) visit(dependency.name, dependency.version, [...chain, key]);
      visiting.delete(key);
      if (errors.length === errorsBeforeDependencies) {
        selected.set(fold(entry.name), version.version);
        ordered.push(version);
      }
    };
    for (const ref of refs) visit(ref.name, ref.version, []);
    return { libraries: Object.freeze(ordered), errors: Object.freeze(errors) };
  }

  /** Entries that have a cryptographically verifiable archive or pack source. */
  installable(query: LibraryCatalogQuery = {}): readonly LibraryCatalogVersion[] {
    return Object.freeze(this.list(query).filter((entry) => entry.source.kind !== 'local'));
  }

  toJSON(): { schema: number; libraries: readonly LibraryCatalogEntry[] } {
    return { schema: this.schema, libraries: this.entries };
  }
}

/** Build the checked-in common catalog generated from Arduino's official index. */
export function createArduinoCommonLibraryCatalog(): LibraryCatalog {
  return LibraryCatalog.fromArduinoLibraryIndex(CK_ARDUINO_COMMON_LIBRARY_INDEX);
}

export function catalogVersionFromIndex(record: ArduinoLibraryIndexRecord): LibraryCatalogVersion {
  const checksum = record.checksum.replace(/^SHA-256:/i, '').toLowerCase();
  if (!SHA256.test(checksum)) throw new TypeError(`invalid Arduino Library Index checksum: ${record.name}`);
  return {
    id: `${slug(record.name)}-${record.version.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: record.name,
    version: record.version,
    architectures: record.architectures?.length ? record.architectures : ['*'],
    dependencies: (record.dependencies ?? []).map((dependency) => ({
      name: dependency.name,
      ...(dependency.version ? { version: dependency.version } : {}),
    })),
    publicHeaders: record.providesIncludes ?? [],
    source: {
      kind: 'archive',
      url: record.url,
      sha256: checksum,
      ...(record.size !== undefined ? { size: record.size } : {}),
      ...(record.repository ? { repository: record.repository } : {}),
    },
    ...(record.sentence ? { description: record.sentence } : {}),
    ...(record.category ? { category: record.category } : {}),
    ...(record.license ? { license: record.license } : {}),
  };
}

function compareVersions(left: string, right: string): number {
  const tokenize = (value: string) => value.split(/[.+-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part.toLowerCase());
  const a = tokenize(left);
  const b = tokenize(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (typeof x === 'number' && typeof y === 'number' && x !== y) return x - y;
    const result = compareText(String(x), String(y));
    if (result) return result;
  }
  return 0;
}

function libraryContentHash(library: Library): string {
  const hash = createHash('sha256');
  const files = library.allFiles
    .map((path) => ({ path, relative: path.replace(library.rootDir, '').replaceAll('\\', '/').replace(/^\//, '') }))
    .sort((a, b) => compareText(a.relative, b.relative));
  hash.update('ck-library-content-v1\0');
  hash.update(JSON.stringify(library.manifest));
  for (const file of files) {
    hash.update(`\0${file.relative}\0`);
    try { hash.update(requireFile(file.path)); } catch { hash.update('\0missing'); }
  }
  return hash.digest('hex');
}

// Kept behind a tiny indirection so catalog construction stays deterministic
// and does not expose mutable file buffers to callers.
function requireFile(path: string): Buffer {
  return readFileSync(path);
}
