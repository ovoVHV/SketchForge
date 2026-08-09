import {
  createProjectSnapshot,
  projectSnapshotForRequest,
} from './project-files.js';

export const PROJECT_STATE_SCHEMA_VERSION = 2;
export const PROJECT_STATE_STORAGE_KEY = 'arduinofast.project.v2';
export const LEGACY_PROJECT_STORAGE_KEY = 'arduinofast.project.v1';
export const LEGACY_LIBRARY_STORAGE_KEY = 'arduinofast.library-selection.v1';

const MAX_BOARD_CHARS = 512;
const MAX_OPTIONS = 64;
const MAX_OPTION_VALUE_CHARS = 256;
const MAX_LIBRARIES = 64;
const MAX_LIBRARY_FIELD_CHARS = 160;
const OPTION_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validText(value, maxChars, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > maxChars) return null;
  const normalized = value.trim();
  if (!allowEmpty && !normalized) return null;
  return normalized;
}

function normalizeOptions(value) {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_OPTIONS) return null;
  const normalized = [];
  for (const [key, rawValue] of entries) {
    if (!OPTION_ID.test(key) || RESERVED_KEYS.has(key.toLowerCase())) return null;
    const optionValue = validText(rawValue, MAX_OPTION_VALUE_CHARS, { allowEmpty: true });
    if (optionValue === null) return null;
    normalized.push([key, optionValue]);
  }
  normalized.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return Object.freeze(Object.fromEntries(normalized));
}

function normalizeLibraries(value) {
  if (!Array.isArray(value) || value.length > MAX_LIBRARIES) return null;
  const libraries = [];
  const seen = new Set();
  for (const item of value) {
    if (!isRecord(item)) return null;
    const name = validText(item.name, MAX_LIBRARY_FIELD_CHARS);
    const version = item.version === undefined
      ? undefined
      : validText(item.version, MAX_LIBRARY_FIELD_CHARS);
    if (name === null || version === null) return null;
    const key = `${name.toLowerCase()}@${version ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    libraries.push(Object.freeze({ name, ...(version ? { version } : {}) }));
  }
  libraries.sort((left, right) => {
    const leftKey = `${left.name.toLowerCase()}@${left.version ?? ''}`;
    const rightKey = `${right.name.toLowerCase()}@${right.version ?? ''}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return Object.freeze(libraries);
}

function normalizeState(value, { legacyLibraries = [] } = {}) {
  if (!isRecord(value) || !Array.isArray(value.files)) return null;
  try {
    const snapshot = createProjectSnapshot(value.files);
    const activeFile = typeof value.activeFile === 'string'
      && snapshot.files.some((file) => file.name === value.activeFile)
      ? value.activeFile
      : snapshot.sketch;
    const board = validText(value.board ?? '', MAX_BOARD_CHARS, { allowEmpty: true });
    const options = normalizeOptions(value.options ?? {});
    const libraries = normalizeLibraries(value.libraries ?? legacyLibraries);
    if (board === null || options === null || libraries === null) return null;
    return Object.freeze({
      schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
      files: Object.freeze(projectSnapshotForRequest(snapshot).map((file) => Object.freeze(file))),
      activeFile,
      board,
      options,
      libraries,
    });
  } catch {
    return null;
  }
}

function readJson(storage, key) {
  try {
    const raw = storage?.getItem?.(key);
    if (typeof raw !== 'string') return { present: false, value: null };
    return { present: true, value: JSON.parse(raw) };
  } catch {
    return { present: true, value: null };
  }
}

export function normalizeProjectState(value) {
  if (!isRecord(value) || value.schemaVersion !== PROJECT_STATE_SCHEMA_VERSION) return null;
  if (!Object.hasOwn(value, 'board') || !Object.hasOwn(value, 'options') || !Object.hasOwn(value, 'libraries')) {
    return null;
  }
  return normalizeState(value);
}

export function loadProjectState(storage) {
  const current = readJson(storage, PROJECT_STATE_STORAGE_KEY);
  if (current.present) {
    const normalized = normalizeProjectState(current.value);
    if (normalized) return normalized;
  }

  const legacyProject = readJson(storage, LEGACY_PROJECT_STORAGE_KEY);
  if (!legacyProject.present || !isRecord(legacyProject.value)) return null;
  if (Object.hasOwn(legacyProject.value, 'schemaVersion') && legacyProject.value.schemaVersion !== 1) return null;
  const legacyLibraries = readJson(storage, LEGACY_LIBRARY_STORAGE_KEY);
  return normalizeState(legacyProject.value, {
    legacyLibraries: Array.isArray(legacyLibraries.value) ? legacyLibraries.value : [],
  });
}

export function saveProjectState(storage, value) {
  let normalized;
  try {
    normalized = normalizeProjectState({ ...value, schemaVersion: PROJECT_STATE_SCHEMA_VERSION });
  } catch {
    return false;
  }
  if (!normalized) return false;
  try {
    storage?.setItem?.(PROJECT_STATE_STORAGE_KEY, JSON.stringify(normalized));
    return typeof storage?.setItem === 'function';
  } catch {
    return false;
  }
}
