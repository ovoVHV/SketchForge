import { AVR_TOOLCHAIN_PACK } from './release.js';

export const AVR_WORKER_ABI = 1;

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const FAILURE_REASONS = new Set([
  'invalid_ir', 'integrity', 'tool', 'compile', 'timeout', 'resource_limit', 'cancelled', 'internal',
]);
const TOOLS = new Set([
  'ck:arduino-preprocess',
  `toolchain:${AVR_TOOLCHAIN_PACK.id}:avr-g++`,
  `toolchain:${AVR_TOOLCHAIN_PACK.id}:avr-ld`,
  `toolchain:${AVR_TOOLCHAIN_PACK.id}:avr-objcopy`,
]);

export function createAvrWorkerInitRequest({ id, assetsBase } = {}) {
  return validateAvrWorkerInitRequest({
    abi: AVR_WORKER_ABI,
    type: 'init',
    id,
    assetsBase: String(assetsBase),
  });
}

export function validateAvrWorkerInitRequest(value) {
  exactKeys(value, ['abi', 'type', 'id', 'assetsBase'], 'AVR Worker init request');
  if (value.abi !== AVR_WORKER_ABI || value.type !== 'init') throw new TypeError('unsupported AVR Worker init request');
  validateId(value.id);
  const url = new URL(value.assetsBase);
  if (!['file:', 'http:', 'https:'].includes(url.protocol)) throw new TypeError('AVR Worker assets URL is invalid');
  return Object.freeze({ abi: AVR_WORKER_ABI, type: 'init', id: value.id, assetsBase: url.href });
}

export function createAvrWorkerActionRequest({ id, action, inputs } = {}) {
  return validateAvrWorkerActionRequest({ abi: AVR_WORKER_ABI, type: 'action', id, action, inputs });
}

export function validateAvrWorkerActionRequest(value) {
  exactKeys(value, ['abi', 'type', 'id', 'action', 'inputs'], 'AVR Worker Action request');
  if (value.abi !== AVR_WORKER_ABI || value.type !== 'action') throw new TypeError('unsupported AVR Worker Action request');
  validateId(value.id);
  const action = validateAction(value.action);
  const inputs = normalizeFiles(value.inputs, action.inputs, 'input');
  return Object.freeze({ abi: AVR_WORKER_ABI, type: 'action', id: value.id, action, inputs });
}

export function createAvrWorkerControlRequest(type, id) {
  if (!['close', 'cancel'].includes(type)) throw new TypeError('AVR Worker control type is invalid');
  return validateAvrWorkerControlRequest({ abi: AVR_WORKER_ABI, type, id });
}

export function validateAvrWorkerControlRequest(value) {
  exactKeys(value, ['abi', 'type', 'id'], 'AVR Worker control request');
  if (value.abi !== AVR_WORKER_ABI || !['close', 'cancel'].includes(value.type)) {
    throw new TypeError('unsupported AVR Worker control request');
  }
  validateId(value.id);
  return Object.freeze({ abi: AVR_WORKER_ABI, type: value.type, id: value.id });
}

export function validateAvrWorkerResponse(value, { expectedType, id, action } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('AVR Worker response is invalid');
  if (value.abi !== AVR_WORKER_ABI || value.type !== expectedType || value.id !== id || typeof value.ok !== 'boolean') {
    throw new TypeError('AVR Worker response is out of sequence');
  }
  if (!value.ok) {
    exactKeys(value, ['abi', 'type', 'id', 'ok', 'error'], 'AVR Worker error response');
    return Object.freeze({ ...value, error: normalizeError(value.error, action) });
  }
  if (expectedType !== 'action-result') {
    exactKeys(value, ['abi', 'type', 'id', 'ok'], 'AVR Worker success response');
    return Object.freeze({ abi: AVR_WORKER_ABI, type: expectedType, id, ok: true });
  }
  exactKeys(value, ['abi', 'type', 'id', 'ok', 'result'], 'AVR Worker Action response');
  if (!action) throw new TypeError('AVR Worker Action response context is missing');
  const result = value.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('AVR Worker Action result is invalid');
  const allowed = new Set(['outputs', 'diagnostics', 'cacheable']);
  if (Object.keys(result).some((key) => !allowed.has(key)) || !Object.hasOwn(result, 'outputs')) {
    throw new TypeError('AVR Worker Action result shape is invalid');
  }
  if (result.cacheable !== undefined && typeof result.cacheable !== 'boolean') {
    throw new TypeError('AVR Worker Action cacheable flag is invalid');
  }
  return Object.freeze({
    abi: AVR_WORKER_ABI,
    type: 'action-result',
    id,
    ok: true,
    result: Object.freeze({
      outputs: normalizeFiles(result.outputs, action.outputs, 'output'),
      diagnostics: Object.freeze(normalizeDiagnostics(result.diagnostics ?? [])),
      ...(result.cacheable === undefined ? {} : { cacheable: result.cacheable }),
    }),
  });
}

export function avrWorkerSuccess(type, id, result) {
  return result === undefined
    ? { abi: AVR_WORKER_ABI, type, id, ok: true }
    : { abi: AVR_WORKER_ABI, type, id, ok: true, result };
}

export function avrWorkerFailure(type, id, error, action) {
  let normalized;
  try {
    normalized = normalizeError({
      code: error?.code ?? 'internal',
      reason: error?.reason ?? 'internal',
      message: errorMessage(error),
      diagnostics: error?.diagnostics ?? [],
    }, action);
  } catch (normalizationError) {
    normalized = Object.freeze({
      code: 'internal',
      reason: 'internal',
      message: errorMessage(normalizationError),
      diagnostics: Object.freeze([]),
    });
  }
  return { abi: AVR_WORKER_ABI, type, id, ok: false, error: normalized };
}

export function avrActionTransferList(result) {
  return result.outputs.map((output) => output.bytes.buffer);
}

function validateAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('AVR Worker Action is invalid');
  const taskKey = value.kind === 'compile' ? 'compileUnit' : value.kind === 'link' ? 'link' : 'transform';
  const required = [
    'arguments', 'cacheKey', 'dependencies', 'environment', 'id', 'inputs', 'kind', 'outputs',
    'packDependencies', 'resourceLimits', 'tool', taskKey,
  ];
  const optional = new Set(['packInputs']);
  const requiredSet = new Set(required);
  if (required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !requiredSet.has(key) && !optional.has(key))) {
    throw new TypeError('AVR Worker Action shape is invalid');
  }
  if (!['compile', 'link', 'transform'].includes(value.kind) || !TOOLS.has(value.tool)) {
    throw new TypeError('AVR Worker Action tool is invalid');
  }
  if (typeof value.id !== 'string' || !value.id || value.id.length > 256
    || !Array.isArray(value.arguments) || value.arguments.some((entry) => typeof entry !== 'string' || entry.includes('\0'))
    || !Array.isArray(value.inputs) || !Array.isArray(value.outputs)) {
    throw new TypeError('AVR Worker Action metadata is invalid');
  }
  const inputPaths = validateDeclarations(value.inputs, 'input');
  validateDeclarations(value.outputs, 'output');
  if (value.kind === 'compile') validateCompileTask(value.compileUnit, inputPaths);
  if (value.kind === 'link') validateLinkTask(value.link, inputPaths);
  if (value.kind === 'transform') validateTransformTask(value.transform, inputPaths);
  return value;
}

function validateCompileTask(task, inputs) {
  if (!task || task.language !== 'c++' || !inputs.has(task.source) || !isLogicalPath(task.output)
    || !Array.isArray(task.flags) || !Array.isArray(task.includePaths)
    || !task.macros || typeof task.macros !== 'object' || Array.isArray(task.macros)) {
    throw new TypeError('AVR Worker compile task is invalid');
  }
}

function validateLinkTask(task, inputs) {
  if (!task || !isLogicalPath(task.output) || !Array.isArray(task.objects) || !Array.isArray(task.archives)
    || !Array.isArray(task.flags) || [...task.objects, ...task.archives].some((path) => !inputs.has(path))
    || (task.linkerScript !== undefined && !inputs.has(task.linkerScript))) {
    throw new TypeError('AVR Worker link task is invalid');
  }
}

function validateTransformTask(task, inputs) {
  if (!task || !inputs.has(task.input) || !isLogicalPath(task.output)
    || !['other', 'hex'].includes(task.format) || !Array.isArray(task.flags)) {
    throw new TypeError('AVR Worker transform task is invalid');
  }
}

function validateDeclarations(value, label) {
  const paths = new Set();
  for (const declaration of value) {
    if (!declaration || typeof declaration !== 'object' || !isLogicalPath(declaration.path) || paths.has(declaration.path)) {
      throw new TypeError(`AVR Worker Action ${label} declaration is invalid`);
    }
    paths.add(declaration.path);
  }
  return paths;
}

function normalizeFiles(value, declarations, label) {
  if (!Array.isArray(value) || value.length !== declarations.length) {
    throw new TypeError(`AVR Worker Action ${label} count is invalid`);
  }
  let total = 0;
  return Object.freeze(value.map((file, index) => {
    if (!file || typeof file !== 'object' || file.path !== declarations[index].path || !(file.bytes instanceof Uint8Array)) {
      throw new TypeError(`AVR Worker Action ${label} ${index} is invalid`);
    }
    const bytes = new Uint8Array(file.bytes);
    if (bytes.byteLength > MAX_FILE_BYTES || (total += bytes.byteLength) > MAX_TOTAL_BYTES) {
      throw new TypeError(`AVR Worker Action ${label} bytes exceed the limit`);
    }
    return Object.freeze({ path: file.path, bytes });
  }));
}

function normalizeError(value, action) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.code !== 'string' || !ERROR_CODE.test(value.code)
    || typeof value.message !== 'string' || !value.message || value.message.length > 4096) {
    throw new TypeError('AVR Worker error is invalid');
  }
  const reason = FAILURE_REASONS.has(value.reason) ? value.reason : 'internal';
  return Object.freeze({
    code: value.code,
    reason,
    message: value.message,
    diagnostics: Object.freeze(normalizeDiagnostics(value.diagnostics ?? [], action)),
  });
}

function normalizeDiagnostics(value) {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError('AVR Worker diagnostics are invalid');
  return value.map((diagnostic) => {
    if (!diagnostic || typeof diagnostic !== 'object' || !['error', 'warning', 'info', 'note', 'fatal error'].includes(diagnostic.severity)
      || typeof diagnostic.file !== 'string' || !diagnostic.file
      || !Number.isSafeInteger(diagnostic.line) || diagnostic.line < 1
      || (diagnostic.column !== undefined && (!Number.isSafeInteger(diagnostic.column) || diagnostic.column < 1))
      || typeof diagnostic.message !== 'string' || !diagnostic.message) {
      throw new TypeError('AVR Worker diagnostic is invalid');
    }
    return Object.freeze({
      severity: diagnostic.severity,
      file: diagnostic.file,
      line: diagnostic.line,
      ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
      message: diagnostic.message,
      ...(typeof diagnostic.raw === 'string' ? { raw: diagnostic.raw } : {}),
    });
  });
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || expected.some((key, index) => actual[index] !== key)) {
    throw new TypeError(`${label} shape is invalid`);
  }
}

function validateId(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('AVR Worker request id is invalid');
}

function isLogicalPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !value.includes('\\') && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
    && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
