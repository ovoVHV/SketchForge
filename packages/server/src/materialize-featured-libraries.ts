import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_PACK_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_LIBRARY_BYTES = 16 * 1024 * 1024;
const MAX_LIBRARY_FILES = 8_192;

interface RegistryDependency {
  name: string;
  version?: string;
}

interface RegistryVersion {
  version: string;
  architectures: string[];
  publicHeaders: string[];
  depends: RegistryDependency[];
  pack: { id: string; revision: string; manifest: string; artifact: string };
}

interface RegistryLibrary {
  name: string;
  defaultVersion: string;
  versions: RegistryVersion[];
}

interface SourcePack {
  schema: 1;
  name: string;
  version: string;
  architectures: string[];
  includeDirs: string[];
  files: Array<{ path: string; content: string }>;
}

export interface MaterializedFeaturedLibrary {
  name: string;
  version: string;
  dir: string;
  packId: string;
  revision: string;
  sourceSha256: string;
  files: number;
  bytes: number;
}

export interface FeaturedLibraryMaterialization {
  schema: 1;
  kind: 'ck-featured-library-materialization';
  registrySha256: string;
  libraries: MaterializedFeaturedLibrary[];
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || isAbsolute(value)) {
    throw new TypeError(`${label} path is invalid`);
  }
  const parts = value.split('/');
  if (parts.length > 16 || parts.some((part) => part === '..' || !SAFE_SEGMENT.test(part))) {
    throw new TypeError(`${label} path is invalid`);
  }
  return parts.join('/');
}

function inside(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError(`path escapes featured Pack root: ${path}`);
  }
  return target;
}

function readBounded(path: string, maximum: number): Buffer {
  const info = statSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) {
    throw new TypeError(`${path} size or file type is invalid`);
  }
  return readFileSync(path);
}

function stringArray(value: unknown, maximum: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maximum
    || value.some((item) => typeof item !== 'string' || !item.trim() || /[\r\n]/.test(item))) {
    throw new TypeError(`${label} is invalid`);
  }
  return value.map((item) => item.trim());
}

function registry(value: unknown): RegistryLibrary[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value as { schema?: unknown }).schema !== 2 || !Array.isArray((value as { libraries?: unknown }).libraries)) {
    throw new TypeError('featured library registry is invalid');
  }
  const libraries = (value as { libraries: unknown[] }).libraries;
  if (libraries.length < 1 || libraries.length > 512) throw new TypeError('featured library registry size is invalid');
  const names = new Set<string>();
  return libraries.map((raw, libraryIndex) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`library[${libraryIndex}] is invalid`);
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 256 || /[\r\n,]/.test(item.name)
      || typeof item.defaultVersion !== 'string' || !SAFE_VERSION.test(item.defaultVersion)
      || !Array.isArray(item.versions) || item.versions.length < 1 || item.versions.length > 32) {
      throw new TypeError(`library[${libraryIndex}] is invalid`);
    }
    const normalizedName = item.name.trim();
    const folded = normalizedName.toLowerCase();
    if (names.has(folded)) throw new TypeError(`duplicate featured library: ${item.name}`);
    names.add(folded);
    const versionIdentities = new Map<string, RegistryVersion['pack']>();
    const versions = item.versions.map((versionRaw, versionIndex) => {
      if (!versionRaw || typeof versionRaw !== 'object' || Array.isArray(versionRaw)) {
        throw new TypeError(`library[${libraryIndex}].versions[${versionIndex}] is invalid`);
      }
      const version = versionRaw as Record<string, unknown>;
      if (typeof version.version !== 'string' || !SAFE_VERSION.test(version.version)
        || !version.pack || typeof version.pack !== 'object' || Array.isArray(version.pack)) {
        throw new TypeError(`library[${libraryIndex}].versions[${versionIndex}] is invalid`);
      }
      const pack = version.pack as Record<string, unknown>;
      if (typeof pack.id !== 'string' || !SAFE_PACK_ID.test(pack.id)
        || typeof pack.revision !== 'string' || !SHA256.test(pack.revision)
        || typeof pack.manifest !== 'string' || typeof pack.artifact !== 'string') {
        throw new TypeError(`library[${libraryIndex}].versions[${versionIndex}].pack is invalid`);
      }
      const dependencies = Array.isArray(version.depends) ? version.depends.map((dependency) => {
        if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)
          || typeof (dependency as { name?: unknown }).name !== 'string'
          || /[\r\n,]/.test((dependency as { name: string }).name)) {
          throw new TypeError(`library[${libraryIndex}] dependency is invalid`);
        }
        const dep = dependency as { name: string; version?: unknown };
        if (dep.version !== undefined && (typeof dep.version !== 'string' || !SAFE_VERSION.test(dep.version))) {
          throw new TypeError(`library[${libraryIndex}] dependency version is invalid`);
        }
        return { name: dep.name.trim(), ...(typeof dep.version === 'string' ? { version: dep.version } : {}) };
      }) : [];
      const normalizedPack = {
        id: pack.id,
        revision: pack.revision,
        manifest: safeRelativePath(pack.manifest, 'Pack manifest'),
        artifact: pack.artifact,
      } as RegistryVersion['pack'];
      const existing = versionIdentities.get(version.version);
      if (existing) {
        const sameRevision = existing.id === normalizedPack.id
          && existing.revision === normalizedPack.revision
          && existing.manifest === normalizedPack.manifest
          && existing.artifact === normalizedPack.artifact;
        throw new TypeError(
          sameRevision
            ? `duplicate featured library version: ${normalizedName}@${version.version}`
            : `ambiguous featured Library Pack revision: ${normalizedName}@${version.version}`,
        );
      }
      versionIdentities.set(version.version, normalizedPack);
      return {
        version: version.version,
        architectures: stringArray(version.architectures, 32, 'architectures'),
        publicHeaders: stringArray(version.publicHeaders, 512, 'publicHeaders'),
        depends: dependencies,
        pack: normalizedPack,
      } satisfies RegistryVersion;
    });
    if (!versionIdentities.has(item.defaultVersion)) {
      throw new TypeError(`${normalizedName} default version is absent`);
    }
    return { name: normalizedName, defaultVersion: item.defaultVersion, versions };
  });
}

function sourcePack(value: unknown, expected: { name: string; version: string }): SourcePack {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('library source Pack is invalid');
  const source = value as Record<string, unknown>;
  if (source.schema !== 1 || source.name !== expected.name || source.version !== expected.version
    || !Array.isArray(source.files) || source.files.length > MAX_LIBRARY_FILES) {
    throw new TypeError(`library source Pack identity mismatch: ${expected.name}@${expected.version}`);
  }
  const paths = new Set<string>();
  const files = source.files.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`source file ${index} is invalid`);
    const file = raw as { path?: unknown; content?: unknown };
    const path = safeRelativePath(file.path, 'source file');
    if (paths.has(path)) throw new TypeError(`duplicate source file: ${path}`);
    paths.add(path);
    if (typeof file.content !== 'string') throw new TypeError(`source file ${path} content is invalid`);
    return { path, content: file.content };
  });
  return {
    schema: 1,
    name: source.name as string,
    version: source.version as string,
    architectures: stringArray(source.architectures, 32, 'source architectures'),
    includeDirs: stringArray(source.includeDirs, 64, 'source includeDirs').map((path) => safeRelativePath(path, 'include directory')),
    files,
  };
}

function loadSourcePack(registryRoot: string, library: RegistryLibrary, version: RegistryVersion): {
  source: SourcePack;
  sha256: string;
} {
  const manifestPath = inside(registryRoot, version.pack.manifest);
  const manifestBytes = readBounded(manifestPath, 1024 * 1024);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  if (manifest.schema !== 1 || manifest.id !== version.pack.id || manifest.revision !== version.pack.revision
    || !Array.isArray(manifest.artifacts)) {
    throw new TypeError(`${library.name}@${version.version} Pack manifest identity mismatch`);
  }
  const artifact = manifest.artifacts.find((candidate) => candidate && typeof candidate === 'object'
    && (candidate as { id?: unknown }).id === version.pack.artifact) as Record<string, unknown> | undefined;
  if (!artifact || artifact.kind !== 'library-source-json' || !SHA256.test(String(artifact.sha256))
    || !Number.isSafeInteger(artifact.size) || Number(artifact.size) < 1 || Number(artifact.size) > MAX_LIBRARY_BYTES
    || !Array.isArray(artifact.chunks) || artifact.chunks.length < 1 || artifact.chunks.length > 256) {
    throw new TypeError(`${library.name}@${version.version} source artifact is invalid`);
  }
  const parts: Buffer[] = [];
  let total = 0;
  for (const chunkRaw of artifact.chunks) {
    if (!chunkRaw || typeof chunkRaw !== 'object' || Array.isArray(chunkRaw)) throw new TypeError('source chunk is invalid');
    const chunk = chunkRaw as Record<string, unknown>;
    const path = safeRelativePath(chunk.path, 'source chunk');
    if (!SHA256.test(String(chunk.sha256)) || !Number.isSafeInteger(chunk.size) || Number(chunk.size) < 1) {
      throw new TypeError(`source chunk ${path} identity is invalid`);
    }
    const data = readBounded(inside(dirname(manifestPath), path), MAX_LIBRARY_BYTES);
    if (data.length !== chunk.size || sha256(data) !== chunk.sha256) throw new TypeError(`source chunk ${path} digest mismatch`);
    total += data.length;
    if (total > MAX_LIBRARY_BYTES) throw new RangeError('featured library source exceeds size limit');
    parts.push(data);
  }
  const body = Buffer.concat(parts, total);
  if (body.length !== artifact.size || sha256(body) !== artifact.sha256) {
    throw new TypeError(`${library.name}@${version.version} source artifact digest mismatch`);
  }
  return {
    source: sourcePack(JSON.parse(body.toString('utf8')) as unknown, {
      name: library.name,
      version: version.version,
    }),
    sha256: artifact.sha256 as string,
  };
}

function properties(library: RegistryLibrary, version: RegistryVersion): string {
  return [
    `name=${library.name}`,
    `version=${version.version}`,
    `architectures=${version.architectures.join(',')}`,
    `depends=${version.depends.map((dependency) => (
      dependency.version ? `${dependency.name} (=${dependency.version})` : dependency.name
    )).join(',')}`,
    `includes=${version.publicHeaders.join(',')}`,
  ].join('\n') + '\n';
}

export interface MaterializeFeaturedLibrariesOptions {
  registryPath: string;
  outputDir: string;
}

export function materializeFeaturedLibraries(options: MaterializeFeaturedLibrariesOptions): FeaturedLibraryMaterialization {
  const registryPath = resolve(options.registryPath);
  const outputDir = resolve(options.outputDir);
  if (existsSync(outputDir)) throw new TypeError(`featured library output already exists: ${outputDir}`);
  const registryBytes = readBounded(registryPath, MAX_REGISTRY_BYTES);
  const libraries = registry(JSON.parse(registryBytes.toString('utf8')) as unknown);
  const staging = `${outputDir}.tmp-${process.pid}-${randomUUID()}`;
  const materialized: MaterializedFeaturedLibrary[] = [];
  try {
    mkdirSync(dirname(outputDir), { recursive: true });
    mkdirSync(staging, { recursive: false });
    for (const library of libraries) {
      const version = library.versions.find((candidate) => candidate.version === library.defaultVersion)!;
      const loaded = loadSourcePack(dirname(registryPath), library, version);
      const dir = version.pack.id;
      const root = inside(staging, dir);
      mkdirSync(root, { recursive: true });
      let total = 0;
      for (const file of loaded.source.files) {
        const target = inside(root, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content, { encoding: 'utf8', flag: 'wx', mode: 0o444 });
        total += Buffer.byteLength(file.content, 'utf8');
      }
      const manifestText = properties(library, version);
      writeFileSync(inside(root, 'library.properties'), manifestText, { encoding: 'utf8', flag: 'wx', mode: 0o444 });
      total += Buffer.byteLength(manifestText, 'utf8');
      materialized.push({
        name: library.name,
        version: version.version,
        dir,
        packId: version.pack.id,
        revision: version.pack.revision,
        sourceSha256: loaded.sha256,
        files: loaded.source.files.length,
        bytes: total,
      });
    }
    const result: FeaturedLibraryMaterialization = {
      schema: 1,
      kind: 'ck-featured-library-materialization',
      registrySha256: sha256(registryBytes),
      libraries: materialized.sort((left, right) => left.name.localeCompare(right.name)),
    };
    writeFileSync(inside(staging, 'materialization.json'), `${JSON.stringify(result, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o444,
    });
    renameSync(staging, outputDir);
    return result;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
