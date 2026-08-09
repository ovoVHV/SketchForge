// Deterministic project snapshot handling for browser imports.

export const PROJECT_FILE_LIMITS = Object.freeze({
  // Keep the browser import envelope aligned with the ESP32 compiler entry
  // point. Local Arduino libraries commonly contain more than a few dozen
  // source and header files, so the UI must not reject a project the planner
  // can safely compile.
  maxFiles: 128,
  maxBytes: 2 * 1024 * 1024,
  maxPathChars: 160,
  maxSegments: 8,
  maxSegmentChars: 64,
});

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const EXTENSIONS = new Map([
  ['ino', 'ino'], ['c', 'c'], ['cc', 'cc'], ['cpp', 'cpp'], ['cxx', 'cxx'],
  ['s', 'S'], ['asm', 'asm'], ['h', 'h'], ['hh', 'hh'], ['hpp', 'hpp'], ['hxx', 'hxx'],
  ['inc', 'inc'], ['ipp', 'ipp'], ['tpp', 'tpp'],
]);
const LIBRARY_METADATA = /^(?:libraries)\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\/(?:library\.properties|license|licence|copying|notice|authors|readme)$/i;
const CUSTOM_PARTITIONS = 'partitions.csv';

export class ProjectFileError extends Error {
  constructor(code, message, path = '') {
    super(message);
    this.name = 'ProjectFileError';
    this.code = code;
    this.path = path;
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function extensionOf(path) {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
}

function isSupportedPath(path) {
  if (path === CUSTOM_PARTITIONS) return true;
  if (EXTENSIONS.has(extensionOf(path))) return true;
  return LIBRARY_METADATA.test(path);
}

/** Normalize a browser-relative source path without accepting host paths. */
export function normalizeProjectPath(value) {
  if (typeof value !== 'string') throw new ProjectFileError('path', 'project file path must be a string');
  const raw = value.replaceAll('\\', '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw new ProjectFileError('path', `project file path is not relative: ${value}`, value);
  }
  const parts = raw.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) {
    throw new ProjectFileError('path', `project file path contains an invalid segment: ${value}`, value);
  }
  if (parts.length > PROJECT_FILE_LIMITS.maxSegments || raw.length > PROJECT_FILE_LIMITS.maxPathChars) {
    throw new ProjectFileError('path', `project file path is too long: ${value}`, value);
  }
  for (const part of parts) {
    if (!SEGMENT.test(part) || RESERVED.has(part.toLowerCase())) {
      throw new ProjectFileError('path', `project file path contains an invalid segment: ${value}`, value);
    }
  }
  const name = parts.at(-1);
  const extensionStart = name.lastIndexOf('.') + 1;
  const extension = name.slice(extensionStart).toLowerCase();
  if (parts.join('/') !== CUSTOM_PARTITIONS
    && !EXTENSIONS.has(extension) && !LIBRARY_METADATA.test(parts.join('/'))) {
    throw new ProjectFileError('extension', `unsupported project file extension: ${value}`, value);
  }
  return parts.join('/');
}

function entryPath(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return '';
  return typeof entry.path === 'string'
    ? entry.path
    : typeof entry.name === 'string'
      ? entry.name
      : '';
}

function entryContent(entry) {
  if (entry && typeof entry === 'object' && typeof entry.content === 'string') return entry.content;
  return null;
}

function stripDirectoryRoot(entries) {
  const paths = entries.map((entry) => {
    const path = typeof entry?.webkitRelativePath === 'string' && entry.webkitRelativePath
      ? entry.webkitRelativePath
      : entryPath(entry);
    return path.replaceAll('\\', '/');
  });
  const usesDirectoryPaths = entries.some((entry) => (
    typeof entry?.webkitRelativePath === 'string' && entry.webkitRelativePath.includes('/')
  ));
  if (!usesDirectoryPaths) return paths;
  const roots = paths.map((path) => path.split('/')[0]).filter(Boolean);
  if (!roots.length || roots.some((root) => root !== roots[0])) return paths;
  return paths.map((path) => path.slice(roots[0].length + 1));
}

function normalizedEntries(entries, { stripRoot = true } = {}) {
  const list = Array.from(entries ?? []);
  if (!list.length) throw new ProjectFileError('empty', 'project does not contain source files');
  const paths = stripRoot ? stripDirectoryRoot(list) : list.map(entryPath);
  return list.map((entry, index) => {
    const path = normalizeProjectPath(paths[index]);
    const content = entryContent(entry);
    if (content === null) throw new ProjectFileError('content', `project file content is unavailable: ${path}`, path);
    if (content.includes('\0')) throw new ProjectFileError('content', `project file contains NUL bytes: ${path}`, path);
    const bytes = new TextEncoder().encode(content).byteLength;
    if (bytes > PROJECT_FILE_LIMITS.maxBytes) throw new ProjectFileError('size', `project file is too large: ${path}`, path);
    return { name: path, content };
  });
}

/** Create a validated, sorted snapshot from already decoded source files. */
export function createProjectSnapshot(entries, { requireSketch = true, stripRoot = false } = {}) {
  const normalized = normalizedEntries(entries, { stripRoot });
  if (normalized.length > PROJECT_FILE_LIMITS.maxFiles) {
    throw new ProjectFileError('count', `project contains more than ${PROJECT_FILE_LIMITS.maxFiles} files`);
  }
  const names = new Set();
  const headerNames = new Set();
  let totalBytes = 0;
  let sketches = 0;
  for (const file of normalized) {
    const folded = file.name.toLowerCase();
    if (names.has(folded)) throw new ProjectFileError('duplicate', `duplicate project file: ${file.name}`, file.name);
    names.add(folded);
    const extension = extensionOf(file.name);
    if (extension === 'ino') {
      if (file.name.includes('/')) throw new ProjectFileError('sketch', 'the Arduino sketch must be at the project root', file.name);
      sketches += 1;
    }
    if (['h', 'hh', 'hpp', 'hxx', 'inc', 'ipp', 'tpp'].includes(extension)) {
      const basename = file.name.slice(file.name.lastIndexOf('/') + 1).toLowerCase();
      if (headerNames.has(basename)) throw new ProjectFileError('duplicate_header', `duplicate header basename: ${basename}`, file.name);
      headerNames.add(basename);
    }
    totalBytes += new TextEncoder().encode(file.content).byteLength;
  }
  if (totalBytes > PROJECT_FILE_LIMITS.maxBytes) {
    throw new ProjectFileError('size', `project exceeds ${PROJECT_FILE_LIMITS.maxBytes} bytes`);
  }
  if (requireSketch && sketches < 1) {
    throw new ProjectFileError('sketch', 'project must contain at least one root-level .ino sketch');
  }
  normalized.sort((left, right) => compareText(left.name, right.name));
  const sketchFiles = normalized.filter((file) => extensionOf(file.name) === 'ino');
  const sketch = sketchFiles.find((file) => file.name.toLowerCase() === 'main.ino')?.name
    ?? sketchFiles[0]?.name
    ?? null;
  return Object.freeze({
    files: Object.freeze(normalized.map((file) => Object.freeze({ ...file }))),
    sketch,
    sketches: Object.freeze(sketchFiles.map((file) => file.name)),
    totalBytes,
  });
}

async function readEntry(entry, path) {
  if (entryContent(entry) !== null) return entryContent(entry);
  if (typeof entry?.text === 'function') return entry.text();
  throw new ProjectFileError('content', `unable to read project file: ${path}`, path);
}

/** Read File/FileList entries, stripping the directory picker root when present. */
export async function readProjectSnapshot(entries, { requireSketch = true } = {}) {
  const list = Array.from(entries ?? []);
  if (!list.length) throw new ProjectFileError('empty', 'project does not contain source files');
  const allPaths = stripDirectoryRoot(list);
  const directoryImport = list.some((entry) => (
    typeof entry?.webkitRelativePath === 'string' && entry.webkitRelativePath.includes('/')
  ));
  const selected = list
    .map((entry, index) => ({ entry, path: allPaths[index] }))
    .filter(({ path }) => !directoryImport || isSupportedPath(path));
  if (!selected.length) throw new ProjectFileError('empty', 'project does not contain supported source files');
  const decoded = await Promise.all(selected.map(async ({ entry, path }) => ({
    name: path,
    content: await readEntry(entry, path),
  })));
  return createProjectSnapshot(decoded, { requireSketch });
}

/** Merge validated project files without silently replacing existing content. */
export function mergeProjectSnapshots(current, added) {
  const existing = new Set(current.files.map((file) => file.name.toLowerCase()));
  const conflicts = added.files
    .map((file) => file.name)
    .filter((name) => existing.has(name.toLowerCase()));
  if (conflicts.length > 0) {
    throw new ProjectFileError(
      'duplicate',
      `project already contains ${conflicts.join(', ')}`,
      conflicts[0],
    );
  }
  return createProjectSnapshot([...current.files, ...added.files]);
}

/** Add one empty source file to a project, applying the normal path limits. */
export function addProjectFile(snapshot, name) {
  const added = createProjectSnapshot([{ name, content: '' }], { requireSketch: false });
  return mergeProjectSnapshots(snapshot, added);
}

/** Rename one project file while preserving its content and project validity. */
export function renameProjectFile(snapshot, from, to) {
  const target = normalizeProjectPath(to);
  const sourceIndex = snapshot.files.findIndex((file) => file.name === from);
  if (sourceIndex < 0) throw new ProjectFileError('missing', `project file does not exist: ${from}`, from);
  const foldedTarget = target.toLowerCase();
  const conflict = snapshot.files.find((file, index) => (
    index !== sourceIndex && file.name.toLowerCase() === foldedTarget
  ));
  if (conflict) throw new ProjectFileError('duplicate', `project already contains ${conflict.name}`, conflict.name);
  return createProjectSnapshot(snapshot.files.map((file, index) => (
    index === sourceIndex ? { name: target, content: file.content } : file
  )));
}

export function projectSnapshotKey(snapshot) {
  return JSON.stringify(snapshot.files.map((file) => ({ name: file.name, content: file.content })));
}

export function projectSnapshotForRequest(snapshot) {
  return snapshot.files.map((file) => ({ name: file.name, content: file.content }));
}
