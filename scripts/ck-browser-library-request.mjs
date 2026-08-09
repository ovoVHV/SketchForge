/**
 * Versioned request envelope used by the Node BrowserWasm library verifier.
 * Keeping fixture contents in a file avoids Windows CreateProcess command-line
 * limits and gives the planner and verifier one deterministic data contract.
 */
export const CK_BROWSER_LIBRARY_REQUEST_SCHEMA = 1;

const REQUEST_FIELDS = new Set([
  'schema',
  'manifest',
  'header',
  'target',
  'registry',
  'projectFiles',
  'macros',
  'onlyAction',
  'traceCompiler',
]);
const FILE_FIELDS = new Set(['name', 'content']);
const MACRO_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TARGET_NAME = /^[a-z][a-z0-9-]*$/;
const MAX_PROJECT_FILES = 256;
const MAX_FILE_NAME_LENGTH = 512;

export function createBrowserLibraryRequest({
  manifest,
  header,
  target,
  registry,
  projectFiles = [],
  macros = {},
  onlyAction,
  traceCompiler = false,
} = {}) {
  return validateBrowserLibraryRequest({
    schema: CK_BROWSER_LIBRARY_REQUEST_SCHEMA,
    manifest,
    header,
    target,
    registry,
    projectFiles,
    macros,
    ...(onlyAction === undefined ? {} : { onlyAction }),
    traceCompiler,
  });
}

export function validateBrowserLibraryRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('browser library verifier request is invalid');
  }
  if (value.schema !== CK_BROWSER_LIBRARY_REQUEST_SCHEMA) {
    throw new Error('unsupported browser library verifier request schema');
  }
  if ([...Object.keys(value)].some((key) => !REQUEST_FIELDS.has(key))) {
    throw new Error('browser library verifier request has unknown fields');
  }
  for (const field of ['manifest', 'header', 'registry']) {
    if (typeof value[field] !== 'string' || !value[field] || value[field].includes('\0')) {
      throw new Error(`browser library verifier request ${field} is invalid`);
    }
  }
  if (typeof value.target !== 'string' || !TARGET_NAME.test(value.target)) {
    throw new Error('browser library verifier request target is invalid');
  }

  const projectFiles = value.projectFiles ?? [];
  if (!Array.isArray(projectFiles) || projectFiles.length > MAX_PROJECT_FILES) {
    throw new Error('browser library verifier request projectFiles are invalid');
  }
  const names = new Set();
  const normalizedFiles = projectFiles.map((file, index) => {
    if (
      !file
      || typeof file !== 'object'
      || Array.isArray(file)
      || [...Object.keys(file)].some((key) => !FILE_FIELDS.has(key))
      || typeof file.name !== 'string'
      || !file.name
      || file.name.length > MAX_FILE_NAME_LENGTH
      || file.name.includes('\0')
      || /^[\\/]/.test(file.name)
      || /^[A-Za-z]:[\\/]/.test(file.name)
      || file.name.split(/[\\/]/).includes('..')
      || typeof file.content !== 'string'
      || names.has(file.name)
    ) {
      throw new Error(`browser library verifier request project file ${index} is invalid`);
    }
    names.add(file.name);
    return Object.freeze({ name: file.name, content: file.content });
  });

  const macros = value.macros ?? {};
  if (
    !macros
    || typeof macros !== 'object'
    || Array.isArray(macros)
    || Object.entries(macros).some(([name, macro]) => (
      !MACRO_NAME.test(name) || (macro !== true && typeof macro !== 'string')
    ))
  ) {
    throw new Error('browser library verifier request macros are invalid');
  }
  if (value.onlyAction !== undefined && (typeof value.onlyAction !== 'string' || !value.onlyAction)) {
    throw new Error('browser library verifier request onlyAction is invalid');
  }
  if (value.traceCompiler !== undefined && typeof value.traceCompiler !== 'boolean') {
    throw new Error('browser library verifier request traceCompiler is invalid');
  }

  return Object.freeze({
    schema: CK_BROWSER_LIBRARY_REQUEST_SCHEMA,
    manifest: value.manifest,
    header: value.header,
    target: value.target,
    registry: value.registry,
    projectFiles: Object.freeze(normalizedFiles),
    macros: Object.freeze({ ...macros }),
    ...(value.onlyAction === undefined ? {} : { onlyAction: value.onlyAction }),
    traceCompiler: value.traceCompiler ?? false,
  });
}

export function serializeBrowserLibraryRequest(value) {
  return `${JSON.stringify(validateBrowserLibraryRequest(value))}\n`;
}
