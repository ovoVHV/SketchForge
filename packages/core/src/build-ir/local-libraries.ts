import { canonicalJson, sha256Hex } from './canonical.js';
import { resolveProject } from './builder.js';
import type {
  LibraryDependencyRef,
  LibraryPackRef,
  ProjectFileInput,
  SourceLanguage,
} from './types.js';

export interface LocalLibrarySource {
  pack: LibraryPackRef;
  files: ProjectFileInput[];
  includePaths: string[];
  rootPath: string;
}

export interface LocalLibraryResolution {
  projectFiles: ProjectFileInput[];
  projectCompilePaths: string[];
  libraries: LocalLibrarySource[];
}

export interface LocalLibraryDependencyRequest {
  name: string;
}

interface LocalLibraryCandidate {
  rootPath: string;
  manifestText: string;
  manifest: LocalManifest;
  files: ProjectFileInput[];
  layout: '1.0' | '1.5';
}

interface LocalManifest {
  name: string;
  version: string;
  architectures: string[];
  depends: string[];
  category?: string;
  license?: string;
}

const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.S', '.s']);
const HEADER_EXTENSIONS = new Set(['.h', '.hh', '.hpp', '.hxx']);
const INCLUDE_FRAGMENT_EXTENSIONS = new Set(['.inc', '.ipp', '.tpp']);
const METADATA_NAMES = new Set(['library.properties', 'license', 'licence', 'copying', 'notice', 'authors', 'readme']);

/** Resolve Arduino libraries embedded in a project snapshot. */
export function resolveLocalLibraries(
  files: readonly ProjectFileInput[],
  architecture: string,
  externalLibraries: readonly LibraryPackRef[] = [],
): LocalLibraryResolution {
  const projectFiles = files.map((file) => ({ ...file, path: normalizeProjectPath(file.path) }));
  const candidates = discoverCandidates(projectFiles, architecture);
  if (!candidates.length) {
    return {
      projectFiles,
      projectCompilePaths: projectFiles.map((file) => file.path),
      libraries: [],
    };
  }

  const byName = new Map<string, LocalLibraryCandidate>();
  for (const candidate of candidates) {
    const key = candidate.manifest.name.toLowerCase();
    if (byName.has(key)) throw new TypeError('duplicate local library name: ' + candidate.manifest.name);
    byName.set(key, candidate);
  }
  const externalByName = new Map<string, LibraryPackRef>();
  for (const pack of externalLibraries) externalByName.set(pack.name.toLowerCase(), pack);

  const hashMemo = new Map<string, string>();
  const hashVisiting = new Set<string>();

  const localId = new Map<string, string>();
  for (const candidate of candidates) {
    const stem = candidate.manifest.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'library';
    localId.set(candidate.manifest.name.toLowerCase(), 'local-library-' + stem + '-' + sha256Hex(candidate.rootPath).slice(0, 12));
  }

  const libraries = candidates.map((candidate): LocalLibrarySource => {
    const dependencies = candidate.manifest.depends.map((name): LibraryDependencyRef => {
      const local = localId.get(name.toLowerCase());
      if (local) {
        const dependency = byName.get(name.toLowerCase())!;
        return {
          id: local,
          version: dependency.manifest.version,
          sha256: packHash(dependency, localId, byName, externalByName, hashMemo, hashVisiting),
        };
      }
      const external = externalByName.get(name.toLowerCase());
      if (external) return { id: external.id, version: external.version, sha256: external.sha256 };
      throw new TypeError('local library ' + candidate.manifest.name + ' references missing dependency ' + name);
    });
    const pack: LibraryPackRef = {
      kind: 'library',
      id: localId.get(candidate.manifest.name.toLowerCase())!,
      name: candidate.manifest.name,
      version: candidate.manifest.version,
      sha256: packHash(candidate, localId, byName, externalByName, hashMemo, hashVisiting),
      architectures: candidate.manifest.architectures,
      ...(candidate.manifest.license ? { license: candidate.manifest.license } : {}),
      manifest: manifestRecord(candidate.manifest),
      dependencies,
    };
    return {
      pack,
      files: candidate.files,
      includePaths: candidate.layout === '1.5' ? ['src'] : ['.', 'utility'],
      rootPath: candidate.rootPath,
    };
  });

  const localRoots = candidates.map((candidate) => candidate.rootPath);
  const isLocal = (path: string) => localRoots.some((root) => path === root || path.startsWith(root + '/'));
  return {
    projectFiles,
    projectCompilePaths: projectFiles.filter((file) => !isLocal(file.path)).map((file) => file.path),
    libraries,
  };
}

/** External roots declared by project-local library manifests. */
export function discoverLocalLibraryExternalDependencies(
  files: readonly ProjectFileInput[],
): LocalLibraryDependencyRequest[] {
  const manifests = files
    .map((file) => ({ ...file, path: normalizeProjectPath(file.path) }))
    .filter((file) => /^libraries\/[^/]+\/library\.properties$/.test(file.path))
    .sort((left, right) => compareText(left.path, right.path))
    .map((file) => {
      const manifest = parseLocalManifest(file.content);
      if (!manifest.name) throw new TypeError('local library manifest has no name: ' + file.path);
      return manifest;
    });
  const localNames = new Set<string>();
  for (const manifest of manifests) {
    const key = manifest.name.toLowerCase();
    if (localNames.has(key)) throw new TypeError('duplicate local library name: ' + manifest.name);
    localNames.add(key);
  }
  const dependencies = new Map<string, string>();
  for (const manifest of manifests) {
    for (const name of manifest.depends) {
      const key = name.toLowerCase();
      if (!localNames.has(key) && !dependencies.has(key)) dependencies.set(key, name);
    }
  }
  return [...dependencies]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, name]) => ({ name }));
}

function discoverCandidates(files: readonly ProjectFileInput[], architecture: string): LocalLibraryCandidate[] {
  const byRoot = new Map<string, Map<string, ProjectFileInput>>();
  for (const file of files) {
    const match = /^libraries\/([^/]+)\/(.+)$/.exec(file.path);
    if (!match) continue;
    const rootPath = 'libraries/' + match[1];
    let entries = byRoot.get(rootPath);
    if (!entries) { entries = new Map(); byRoot.set(rootPath, entries); }
    entries.set(match[2]!, file);
  }
  const result: LocalLibraryCandidate[] = [];
  for (const [rootPath, entries] of [...byRoot].sort(([a], [b]) => compareText(a, b))) {
    const manifestFile = entries.get('library.properties');
    if (!manifestFile) continue;
    const manifest = parseLocalManifest(manifestFile.content);
    if (!manifest.name) throw new TypeError('local library manifest has no name: ' + rootPath + '/library.properties');
    if (!manifest.architectures.some((value) => value === '*' || value.toLowerCase() === architecture.toLowerCase())) {
      throw new TypeError('local library ' + manifest.name + ' does not support architecture ' + architecture);
    }
    const hasSrc = [...entries.keys()].some((path) => path.startsWith('src/'));
    const includeFiles = [...entries.entries()]
      .filter(([path]) => isIncludedLibraryFile(path, hasSrc))
      .sort(([a], [b]) => compareText(a, b))
      .map(([path, file]) => ({ path, content: file.content, language: inferLanguage(path) }));
    if (!includeFiles.some((file) => (
      SOURCE_EXTENSIONS.has(extension(file.path))
      || HEADER_EXTENSIONS.has(extension(file.path))
      || INCLUDE_FRAGMENT_EXTENSIONS.has(extension(file.path))
    ))) {
      throw new TypeError('local library ' + manifest.name + ' has no source or headers');
    }
    result.push({
      rootPath,
      manifestText: manifestFile.content,
      manifest,
      files: includeFiles,
      layout: hasSrc ? '1.5' : '1.0',
    });
  }
  return result;
}

function isIncludedLibraryFile(path: string, hasSrc: boolean): boolean {
  if (path.startsWith('examples/') || path.startsWith('extras/')) return false;
  if (hasSrc) return path.startsWith('src/') || METADATA_NAMES.has(path.toLowerCase());
  if (path.startsWith('utility/')) return !path.slice('utility/'.length).includes('/');
  return !path.includes('/') || METADATA_NAMES.has(path.toLowerCase());
}

function packHash(
  candidate: LocalLibraryCandidate,
  localId: ReadonlyMap<string, string>,
  byName: ReadonlyMap<string, LocalLibraryCandidate>,
  external: ReadonlyMap<string, LibraryPackRef>,
  memo: Map<string, string>,
  visiting: Set<string>,
): string {
  const candidateKey = candidate.manifest.name.toLowerCase();
  const cached = memo.get(candidateKey);
  if (cached) return cached;
  if (visiting.has(candidateKey)) {
    throw new TypeError('local library dependency cycle contains ' + candidate.manifest.name);
  }
  visiting.add(candidateKey);
  const dependencies = candidate.manifest.depends.map((name) => {
    const local = localId.get(name.toLowerCase());
    if (local) {
      const dep = byName.get(name.toLowerCase())!;
      return {
        id: local,
        name: dep.manifest.name,
        version: dep.manifest.version,
        sha256: packHash(dep, localId, byName, external, memo, visiting),
      };
    }
    const pack = external.get(name.toLowerCase());
    return pack ? { id: pack.id, name: pack.name, version: pack.version, sha256: pack.sha256 } : { name };
  });
  const content = resolveProject(candidate.files).files.map((file) => ({ path: file.path, sha256: file.sha256 }));
  const hash = sha256Hex(canonicalJson({
    schema: 1,
    manifest: candidate.manifestText,
    name: candidate.manifest.name,
    version: candidate.manifest.version,
    architectures: candidate.manifest.architectures,
    dependencies,
    content,
  }));
  visiting.delete(candidateKey);
  memo.set(candidateKey, hash);
  return hash;
}

function manifestRecord(manifest: LocalManifest): Record<string, string> {
  return Object.fromEntries(Object.entries({
    name: manifest.name,
    version: manifest.version,
    architectures: manifest.architectures.join(','),
    ...(manifest.depends.length ? { depends: manifest.depends.join(',') } : {}),
    ...(manifest.category ? { category: manifest.category } : {}),
    ...(manifest.license ? { license: manifest.license } : {}),
  }).sort(([a], [b]) => compareText(a, b)));
}

function parseLocalManifest(text: string): LocalManifest {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    values.set(trimmed.slice(0, separator).trim().toLowerCase(), trimmed.slice(separator + 1).trim());
  }
  const list = (key: string) => (values.get(key) ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return {
    name: values.get('name') ?? '',
    version: values.get('version') ?? '0.0.0',
    architectures: list('architectures').length ? list('architectures') : ['*'],
    depends: list('depends').map((value) => value.replace(/\s*\(.*\)\s*$/, '').trim()).filter(Boolean),
    ...(values.get('category') ? { category: values.get('category') } : {}),
    ...(values.get('license') ? { license: values.get('license') } : {}),
  };
}

function inferLanguage(path: string): SourceLanguage {
  const ext = extension(path);
  if (ext === '.ino') return 'ino';
  if (ext === '.c') return 'c';
  if (ext === '.s') return 'asm';
  if (SOURCE_EXTENSIONS.has(ext)) return 'c++';
  if (HEADER_EXTENSIONS.has(ext)) return 'header';
  return 'other';
}

function extension(path: string): string { return path.slice(path.lastIndexOf('.')).toLowerCase(); }

function normalizeProjectPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError('project file path is invalid: ' + path);
  }
  return normalized;
}

function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
