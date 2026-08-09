import type { BuildIRValidationResult } from './types.js';
import { createActionGraph, migrateBuildIR, normalizeBuildIR } from './builder.js';

/** Validate untrusted JSON before handing it to an executor. */
export function validateBuildIR(value: unknown): BuildIRValidationResult {
  try {
    const migrated = migrateBuildIR(value);
    const normalized = normalizeBuildIR(migrated);
    // Rebuilding the graph separately catches malformed action collections even
    // when a future normalizer becomes more permissive.
    createActionGraph(normalized.graph.actions);
    return { valid: true, errors: [], value: normalized };
  } catch (error) {
    return {
      valid: false,
      errors: [{ path: '', message: error instanceof Error ? error.message : String(error) }],
    };
  }
}

/** Validate an execution input without repairing its declared Action keys. */
export function validateBuildIRForExecution(value: unknown): BuildIRValidationResult {
  const validation = validateBuildIR(value);
  if (!validation.valid || !validation.value) return validation;

  const declaredActions = executionActions(value);
  if (!declaredActions) return invalid('CK Build IR is missing its declared Action graph');

  const expectedById = new Map(
    validation.value.graph.actions.map((action) => [action.id, action.cacheKey] as const),
  );
  if (declaredActions.length !== expectedById.size) {
    return invalid('CK Build IR Action key graph does not match the normalized graph');
  }
  for (const candidate of declaredActions) {
    if (!candidate || typeof candidate !== 'object') {
      return invalid('CK Build IR contains an invalid declared Action');
    }
    const action = candidate as Record<string, unknown>;
    if (typeof action.id !== 'string' || typeof action.cacheKey !== 'string') {
      return invalid(`CK Build IR Action ${String(action.id ?? '<unknown>')} is missing its cache key`);
    }
    const expected = expectedById.get(action.id);
    if (expected === undefined) {
      return invalid(`CK Build IR Action key calculator omitted ${action.id}`);
    }
    if (action.cacheKey !== expected) {
      return invalid(
        `CK Build IR Action cache key mismatch for ${action.id}: expected ${expected}, received ${action.cacheKey}`,
      );
    }
  }
  return validation;
}

function executionActions(value: unknown): unknown[] | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { schemaVersion?: unknown; graph?: unknown; actions?: unknown };
  if (candidate.schemaVersion === 0) {
    return Array.isArray(candidate.actions) ? candidate.actions : null;
  }
  const graph = candidate.graph;
  if (!graph || typeof graph !== 'object') return null;
  const actions = (graph as { actions?: unknown }).actions;
  return Array.isArray(actions) ? actions : null;
}

function invalid(message: string): BuildIRValidationResult {
  return { valid: false, errors: [{ path: 'graph.actions', message }] };
}
