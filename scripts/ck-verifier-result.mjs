import { StringDecoder } from 'node:string_decoder';

export const CK_VERIFIER_RESULT_SCHEMA = 1;
export const CK_VERIFIER_RESULT_PREFIX = 'CK_RESULT ';

const MAX_PROTOCOL_LINE_LENGTH = 64 * 1024;
const MAX_MESSAGE_LENGTH = 16 * 1024;
const MAX_RAW_DIAGNOSTIC_LENGTH = 16 * 1024;
const FAILURE_REASONS = new Set([
  'invalid_ir',
  'integrity',
  'tool',
  'compile',
  'timeout',
  'resource_limit',
  'cancelled',
  'internal',
]);
const ACTION_KINDS = new Set(['compile', 'archive', 'link', 'transform']);

/** Encode the authenticated, bounded one-line result consumed by the matrix parent. */
export function encodeVerifierResult(value, token) {
  const result = validateVerifierResult({ ...value, schema: CK_VERIFIER_RESULT_SCHEMA, token }, token);
  const line = `${CK_VERIFIER_RESULT_PREFIX}${JSON.stringify(result)}`;
  if (line.length > MAX_PROTOCOL_LINE_LENGTH) {
    throw new Error('CK verifier result exceeds the protocol line limit');
  }
  return `${line}\n`;
}

export function createVerifierResult({ result, summary, phase = 'execution' }) {
  const failedAction = summary.failedAction;
  const diagnostic = selectPrimaryDiagnostic(summary.diagnostics);
  return {
    status: result.status === 'success' ? 'success' : 'error',
    phase,
    ...(result.status === 'success' ? {} : {
      reason: FAILURE_REASONS.has(result.reason) ? result.reason : 'internal',
      message: truncate(result.message || diagnostic?.message || 'browser verifier failed', MAX_MESSAGE_LENGTH),
    }),
    library: summary.library,
    header: summary.header,
    target: summary.target,
    actionCount: summary.actionCount,
    ...(summary.actionId ? { actionId: summary.actionId } : {}),
    ...(ACTION_KINDS.has(failedAction?.kind) ? { actionKind: failedAction.kind } : {}),
    ...(typeof failedAction?.tool === 'string' && failedAction.tool ? { tool: failedAction.tool } : {}),
    diagnosticCount: Array.isArray(summary.diagnostics) ? summary.diagnostics.length : 0,
    ...(diagnostic ? { diagnostic: normalizeDiagnostic(diagnostic) } : {}),
    elapsedMs: summary.elapsedMs,
  };
}

export function createVerifierExceptionResult(error, { elapsedMs = 0 } = {}) {
  return {
    status: 'error',
    phase: 'initialization',
    reason: 'internal',
    message: truncate(errorMessage(error), MAX_MESSAGE_LENGTH),
    ...(typeof error?.code === 'string' && error.code ? { errorCode: truncate(error.code, 128) } : {}),
    elapsedMs,
  };
}

/**
 * Incrementally parse stdout. It keeps at most one bounded line, so compiler
 * output cannot make result capture consume unbounded memory.
 */
export function createVerifierResultStreamParser(expectedToken, { maxLineLength = MAX_PROTOCOL_LINE_LENGTH } = {}) {
  if (typeof expectedToken !== 'string' || !expectedToken) throw new TypeError('verifier result token is required');
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let overflow = false;
  let result;
  let error;

  const consumeLine = (line) => {
    if (!line.startsWith(CK_VERIFIER_RESULT_PREFIX)) return;
    let candidate;
    try {
      candidate = JSON.parse(line.slice(CK_VERIFIER_RESULT_PREFIX.length));
    } catch {
      return;
    }
    // Compiler output is untrusted. Only a line carrying the per-child token
    // is protocol data; CK_RESULT-looking diagnostics remain ordinary output.
    if (candidate?.token !== expectedToken) return;
    try {
      const validated = validateVerifierResult(candidate, expectedToken);
      if (result) throw new Error('child verifier emitted more than one CK result');
      result = validated;
    } catch (caught) {
      error = error ?? caught;
    }
  };

  const consume = (text, flush = false) => {
    let offset = 0;
    for (;;) {
      const newline = text.indexOf('\n', offset);
      if (newline < 0) break;
      const fragment = text.slice(offset, newline);
      if (!overflow && pending.length + fragment.length <= maxLineLength) {
        consumeLine(`${pending}${fragment}`.replace(/\r$/, ''));
      }
      pending = '';
      overflow = false;
      offset = newline + 1;
    }
    const remainder = text.slice(offset);
    if (remainder) {
      if (!overflow && pending.length + remainder.length <= maxLineLength) pending += remainder;
      else {
        pending = '';
        overflow = true;
      }
    }
    if (flush && !overflow && pending) consumeLine(pending.replace(/\r$/, ''));
    if (flush) pending = '';
  };

  return Object.freeze({
    push(chunk) {
      consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    },
    finish() {
      consume(decoder.end(), true);
      return Object.freeze({ result, error });
    },
    get result() { return result; },
    get error() { return error; },
  });
}

export function publicVerifierResult(value) {
  if (!value) return undefined;
  const { token: _token, ...result } = value;
  return Object.freeze(result);
}

function validateVerifierResult(value, expectedToken) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CK verifier result is invalid');
  if (value.schema !== CK_VERIFIER_RESULT_SCHEMA) throw new Error('unsupported CK verifier result schema');
  if (value.token !== expectedToken) throw new Error('CK verifier result token mismatch');
  if (!['success', 'error'].includes(value.status)) throw new Error('CK verifier result status is invalid');
  if (!['initialization', 'execution'].includes(value.phase)) throw new Error('CK verifier result phase is invalid');
  if (value.status === 'error' && !FAILURE_REASONS.has(value.reason)) throw new Error('CK verifier result reason is invalid');
  if (value.status === 'error' && (typeof value.message !== 'string' || !value.message)) {
    throw new Error('CK verifier result message is invalid');
  }
  if (value.actionKind !== undefined && !ACTION_KINDS.has(value.actionKind)) {
    throw new Error('CK verifier result action kind is invalid');
  }
  for (const field of ['library', 'header', 'target', 'actionId', 'tool', 'errorCode']) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || !value[field] || value[field].includes('\0'))) {
      throw new Error(`CK verifier result ${field} is invalid`);
    }
  }
  for (const field of ['actionCount', 'diagnosticCount', 'elapsedMs']) {
    if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field] < 0)) {
      throw new Error(`CK verifier result ${field} is invalid`);
    }
  }
  if (value.diagnostic !== undefined) validateDiagnostic(value.diagnostic);
  return Object.freeze({ ...value, ...(value.diagnostic ? { diagnostic: Object.freeze({ ...value.diagnostic }) } : {}) });
}

function selectPrimaryDiagnostic(diagnostics) {
  if (!Array.isArray(diagnostics)) return undefined;
  return diagnostics.find((diagnostic) => diagnostic?.severity === 'error') ?? diagnostics[0];
}

function normalizeDiagnostic(diagnostic) {
  return {
    severity: ['error', 'warning', 'info'].includes(diagnostic.severity) ? diagnostic.severity : 'error',
    file: truncate(String(diagnostic.file ?? '<unknown>'), 2048),
    line: Number.isSafeInteger(diagnostic.line) && diagnostic.line > 0 ? diagnostic.line : 1,
    ...(Number.isSafeInteger(diagnostic.column) && diagnostic.column > 0 ? { column: diagnostic.column } : {}),
    message: truncate(String(diagnostic.message ?? 'compiler failed'), MAX_MESSAGE_LENGTH),
    ...(typeof diagnostic.raw === 'string' && diagnostic.raw
      ? { raw: truncate(diagnostic.raw, MAX_RAW_DIAGNOSTIC_LENGTH) }
      : {}),
  };
}

function validateDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CK verifier result diagnostic is invalid');
  if (!['error', 'warning', 'info'].includes(value.severity)) throw new Error('CK verifier result diagnostic severity is invalid');
  if (typeof value.file !== 'string' || !value.file || typeof value.message !== 'string' || !value.message) {
    throw new Error('CK verifier result diagnostic is invalid');
  }
  if (!Number.isSafeInteger(value.line) || value.line < 1) throw new Error('CK verifier result diagnostic line is invalid');
  if (value.column !== undefined && (!Number.isSafeInteger(value.column) || value.column < 1)) {
    throw new Error('CK verifier result diagnostic column is invalid');
  }
  if (value.raw !== undefined && typeof value.raw !== 'string') throw new Error('CK verifier result diagnostic raw text is invalid');
}

function truncate(value, maximum) {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 14)}...[truncated]`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
