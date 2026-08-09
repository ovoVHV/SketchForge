import {
  PROJECT_STATE_SCHEMA_VERSION,
  normalizeProjectState,
} from './project-state.js';

export const PROJECT_ARCHIVE_FORMAT = 'arduinofast-project';
export const PROJECT_ARCHIVE_VERSION = 1;
export const MAX_PROJECT_ARCHIVE_BYTES = 8 * 1024 * 1024;

export function encodeProjectArchive(value) {
  const project = normalizeProjectState({
    ...value,
    schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
  });
  if (!project) throw new Error('project state is invalid');
  return `${JSON.stringify({
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    project,
  }, null, 2)}\n`;
}

export function decodeProjectArchive(text) {
  if (typeof text !== 'string') throw new Error('project archive must be text');
  if (new TextEncoder().encode(text).byteLength > MAX_PROJECT_ARCHIVE_BYTES) {
    throw new Error('project archive is too large');
  }
  let archive;
  try {
    archive = JSON.parse(text);
  } catch {
    throw new Error('project archive is not valid JSON');
  }
  if (archive?.format !== PROJECT_ARCHIVE_FORMAT || archive?.version !== PROJECT_ARCHIVE_VERSION) {
    throw new Error('unsupported project archive format');
  }
  const project = normalizeProjectState(archive.project);
  if (!project) throw new Error('project archive contains invalid state');
  return project;
}

export function safeDownloadFilename(value, fallback = 'project') {
  const normalized = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 80);
  return normalized || fallback;
}

export function projectArchiveFilename(value) {
  return `${safeDownloadFilename(value)}.arduinofast.json`;
}
