import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export const PLANNING_NORMALIZATION = 'executor-neutral-build-plan-v1';
export const PLANNING_EXCLUSIONS = Object.freeze([
  'packs.sha256',
  'actions.cacheKey',
  'actions.tool',
  'actions.arguments',
  'actions.environment',
  'actions.packDependencies',
  'actions.packInputs',
  'actions.resourceLimits',
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, item]) => [key, canonicalValue(item)]));
}

export function canonicalEvidenceJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function evidenceSha256(value) {
  return createHash('sha256').update(
    typeof value === 'string' || value instanceof Uint8Array
      ? value
      : canonicalEvidenceJson(value),
  ).digest('hex');
}

function safeSegment(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  if (!normalized || normalized.length > 96) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function requiredSourceRevision(value) {
  const revision = String(
    value ?? process.env.CK_SOURCE_REVISION ?? process.env.GITHUB_SHA ?? '',
  ).trim().toLowerCase();
  if (!SOURCE_REVISION.test(revision)) {
    throw new TypeError('sourceRevision must be the current 40- or 64-character commit digest');
  }
  return revision;
}

function normalizeArtifacts(result) {
  const values = [
    ...(Array.isArray(result?.artifacts) ? result.artifacts : []),
    ...(Array.isArray(result?.staticArtifacts) ? result.staticArtifacts : []),
  ];
  return values.map((artifact) => {
    const path = String(artifact?.path ?? artifact?.name ?? '');
    const sha256 = String(artifact?.sha256 ?? '');
    const size = Number(artifact?.size);
    if (!path || !SHA256.test(sha256) || !Number.isSafeInteger(size) || size < 0) {
      throw new TypeError(`runtime evidence contains an invalid artifact: ${path || '<unknown>'}`);
    }
    return Object.freeze({
      path,
      sha256,
      size,
      ...(artifact.offset === undefined ? {} : { offset: String(artifact.offset) }),
      ...(artifact.format === undefined ? {} : { format: String(artifact.format) }),
    });
  }).sort((left, right) => compareText(left.path, right.path) || compareText(left.sha256, right.sha256));
}

function normalizePacks(ir) {
  const libraries = Array.isArray(ir?.packs?.libraries?.packs) ? ir.packs.libraries.packs : [];
  const values = [ir?.packs?.toolchain, ir?.packs?.platform, ir?.packs?.board, ...libraries].filter(Boolean);
  return values.map((pack) => {
    if (!pack.kind || !pack.id || !pack.version || !SHA256.test(String(pack.sha256 ?? ''))) {
      throw new TypeError(`runtime evidence contains an invalid Pack: ${String(pack?.id ?? '<unknown>')}`);
    }
    return Object.freeze({
      kind: String(pack.kind),
      id: String(pack.id),
      version: String(pack.version),
      sha256: String(pack.sha256),
    });
  }).sort((left, right) => compareText(left.kind, right.kind) || compareText(left.id, right.id));
}

function actionSummary(ir) {
  const actions = Array.isArray(ir?.graph?.actions) ? ir.graph.actions : [];
  const kinds = {};
  for (const action of actions) kinds[action.kind] = (kinds[action.kind] ?? 0) + 1;
  return Object.freeze({
    count: actions.length,
    kinds: Object.freeze(Object.fromEntries(Object.entries(kinds).sort(([left], [right]) => compareText(left, right)))),
    keysSha256: evidenceSha256(actions.map((action) => ({ id: action.id, cacheKey: action.cacheKey }))),
  });
}

function normalizedActionPlan(action) {
  const common = {
    id: String(action?.id ?? ''),
    kind: String(action?.kind ?? ''),
    dependencies: [...(Array.isArray(action?.dependencies) ? action.dependencies : [])].map(String).sort(compareText),
    inputs: [...(Array.isArray(action?.inputs) ? action.inputs : [])]
      .map((input) => ({ path: String(input?.path ?? ''), ...(input?.role ? { role: String(input.role) } : {}) }))
      .sort((left, right) => compareText(left.path, right.path) || compareText(left.role ?? '', right.role ?? '')),
    outputs: [...(Array.isArray(action?.outputs) ? action.outputs : [])]
      .map((output) => ({ path: String(output?.path ?? ''), ...(output?.kind ? { kind: String(output.kind) } : {}) }))
      .sort((left, right) => compareText(left.path, right.path)),
  };
  if (action?.kind === 'compile') {
    return {
      ...common,
      compile: {
        language: String(action.compileUnit?.language ?? ''),
        source: String(action.compileUnit?.source ?? ''),
        output: String(action.compileUnit?.output ?? ''),
      },
    };
  }
  if (action?.kind === 'archive') {
    return {
      ...common,
      archive: {
        objects: [...(Array.isArray(action.archive?.objects) ? action.archive.objects : [])].map(String).sort(compareText),
        output: String(action.archive?.output ?? ''),
      },
    };
  }
  if (action?.kind === 'link') {
    return {
      ...common,
      link: {
        objects: [...(Array.isArray(action.link?.objects) ? action.link.objects : [])].map(String).sort(compareText),
        archives: [...(Array.isArray(action.link?.archives) ? action.link.archives : [])].map(String).sort(compareText),
        output: String(action.link?.output ?? ''),
        ...(action.link?.linkerScript ? { linkerScript: String(action.link.linkerScript) } : {}),
      },
    };
  }
  return {
    ...common,
    transform: {
      input: String(action?.transform?.input ?? ''),
      output: String(action?.transform?.output ?? ''),
      format: String(action?.transform?.format ?? ''),
    },
  };
}

/**
 * Compare planning semantics without pretending native and WASM tool bytes,
 * argv, resource limits, or their derived Action keys are interchangeable.
 */
export function createNormalizedPlanningSummary(ir) {
  const projectFiles = [...(Array.isArray(ir?.project?.files) ? ir.project.files : [])]
    .map((file) => {
      const sha256 = String(file?.sha256 ?? '');
      if (!file?.path || !SHA256.test(sha256)) throw new TypeError('CK Build IR project file is invalid');
      return {
        path: String(file.path),
        language: String(file.language ?? ''),
        generated: file.generated === true,
        sha256,
        size: Number(file.size),
      };
    })
    .sort((left, right) => compareText(left.path, right.path));
  const libraries = [...(Array.isArray(ir?.packs?.libraries?.packs) ? ir.packs.libraries.packs : [])]
    .map((pack) => ({ id: String(pack.id), version: String(pack.version) }))
    .sort((left, right) => compareText(left.id, right.id) || compareText(left.version, right.version));
  const actions = [...(Array.isArray(ir?.graph?.actions) ? ir.graph.actions : [])]
    .map(normalizedActionPlan)
    .sort((left, right) => compareText(left.id, right.id));
  const artifacts = [...(Array.isArray(ir?.artifacts) ? ir.artifacts : [])]
    .map((artifact) => ({
      path: String(artifact?.path ?? ''),
      format: String(artifact?.format ?? ''),
      ...(artifact?.offset === undefined ? {} : { offset: artifact.offset }),
    }))
    .sort((left, right) => compareText(left.path, right.path));
  const summary = canonicalValue({
    project: { files: projectFiles },
    target: {
      fqbn: String(ir?.target?.fqbn ?? ''),
      options: canonicalValue(ir?.target?.options ?? {}),
    },
    libraries: {
      roots: [...(Array.isArray(ir?.packs?.libraries?.roots) ? ir.packs.libraries.roots : [])].map(String).sort(compareText),
      packs: libraries,
    },
    actions,
    artifacts,
  });
  return Object.freeze({
    schema: 1,
    normalization: PLANNING_NORMALIZATION,
    exclusions: PLANNING_EXCLUSIONS,
    sha256: evidenceSha256(summary),
    projectSha256: evidenceSha256(summary.project),
    actionGraphSha256: evidenceSha256(summary.actions),
    summary,
  });
}

function resultStatus(result) {
  return result?.status === 'success' ? 'success' : 'error';
}

function resultDuration(result) {
  const duration = Number(result?.durationMs);
  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : undefined;
}

function cachedActions(result) {
  const actions = Array.isArray(result?.actions) ? result.actions : [];
  return Object.freeze({
    total: actions.length,
    cached: actions.filter((action) => action?.cached === true).length,
  });
}

function sameArtifacts(left, right) {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

function actionRole(action) {
  if (action.kind === 'link') return 'link';
  if (action.kind === 'transform') return 'image';
  if (/^(?:compile|archive)-core(?:-|$)/.test(action.id)) return 'core';
  if (/^(?:compile|archive)-library(?:-|$)/.test(action.id)) return 'library';
  if (/^compile-project(?:-|$)/.test(action.id)) return 'project';
  return 'other';
}

function changedUserProjectFiles(ir, incrementalIr) {
  const files = (value) => new Map(
    (Array.isArray(value?.project?.files) ? value.project.files : [])
      .filter((file) => file?.generated !== true)
      .map((file) => [String(file.path), String(file.sha256 ?? '')]),
  );
  const before = files(ir);
  const after = files(incrementalIr);
  const allPaths = [...new Set([...before.keys(), ...after.keys()])].sort(compareText);
  return {
    changed: allPaths.filter((path) => before.has(path) && after.has(path) && before.get(path) !== after.get(path)),
    added: allPaths.filter((path) => !before.has(path) && after.has(path)),
    removed: allPaths.filter((path) => before.has(path) && !after.has(path)),
  };
}

function incrementalEvidence(ir, incrementalIr, incrementalResult, baselineArtifacts, mainSourcePath) {
  const fail = (reason) => Object.freeze({ status: 'fail', reason });
  if (!incrementalIr) return fail('incremental Build IR was not provided');
  if (resultStatus(incrementalResult) !== 'success') return fail('incremental execution failed');

  const sourceDelta = changedUserProjectFiles(ir, incrementalIr);
  const inferredMain = mainSourcePath
    ?? sourceDelta.changed.find((path) => /(?:^|\/)main\.ino$/i.test(path))
    ?? sourceDelta.changed.find((path) => /\.ino$/i.test(path));
  if (
    sourceDelta.changed.length !== 1
    || sourceDelta.added.length !== 0
    || sourceDelta.removed.length !== 0
    || sourceDelta.changed[0] !== inferredMain
  ) return fail('incremental scenario must change only the selected main source file');
  if (ir?.target?.fqbn !== incrementalIr?.target?.fqbn) return fail('incremental scenario changed the target');
  if (!sameArtifacts(normalizePacks(ir), normalizePacks(incrementalIr))) {
    return fail('incremental scenario changed the Pack set');
  }

  const baselineActions = new Map((ir.graph?.actions ?? []).map((action) => [action.id, action]));
  const nextActions = new Map((incrementalIr.graph?.actions ?? []).map((action) => [action.id, action]));
  if (
    baselineActions.size !== nextActions.size
    || [...baselineActions.keys()].some((id) => !nextActions.has(id))
  ) return fail('incremental scenario changed the Action graph identity');

  const executions = new Map();
  for (const action of incrementalResult.actions ?? []) {
    if (!action?.actionId || executions.has(action.actionId)) return fail('incremental execution has invalid Action results');
    executions.set(action.actionId, action);
  }
  if (
    executions.size !== nextActions.size
    || [...nextActions.keys()].some((id) => !executions.has(id))
  ) return fail('incremental execution did not report every Action');

  const actionDelta = [];
  for (const [id, action] of nextActions) {
    const before = baselineActions.get(id);
    const execution = executions.get(id);
    const keyChanged = before.cacheKey !== action.cacheKey;
    if (typeof execution.cached !== 'boolean') return fail(`incremental Action ${id} has no cache result`);
    if (execution.actionKey !== undefined && execution.actionKey !== action.cacheKey) {
      return fail(`incremental Action ${id} reported the wrong Action key`);
    }
    if (keyChanged === execution.cached) {
      return fail(`incremental Action ${id} did not ${keyChanged ? 'rerun' : 'hit the cache'}`);
    }
    actionDelta.push({
      id,
      kind: action.kind,
      role: actionRole(action),
      keyChanged,
      cached: execution.cached,
    });
  }

  const requireRole = (role, keyChanged) => actionDelta.some((action) => (
    action.role === role && action.keyChanged === keyChanged && action.cached === !keyChanged
  ));
  if (!requireRole('core', false)) return fail('incremental scenario did not prove a Core cache hit');
  if (!requireRole('library', false)) return fail('incremental scenario did not prove a Library cache hit');
  if (!requireRole('project', true)) return fail('incremental scenario did not rerun a changed project Action');
  if (!requireRole('link', true)) return fail('incremental scenario did not rerun a changed link Action');
  if (!requireRole('image', true)) return fail('incremental scenario did not rerun a changed image Action');

  const artifacts = normalizeArtifacts(incrementalResult);
  const artifactPathsMatch = canonicalEvidenceJson(baselineArtifacts.map(({ path }) => path))
    === canonicalEvidenceJson(artifacts.map(({ path }) => path));
  const artifactIdentityChanged = artifactPathsMatch && !sameArtifacts(baselineArtifacts, artifacts);
  if (!artifactIdentityChanged) return fail('incremental main change did not change the output artifact identity');

  return Object.freeze({
    status: 'pass',
    mainSourcePath: inferredMain,
    buildIrSha256: evidenceSha256(incrementalIr),
    actionKeysSha256: actionSummary(incrementalIr).keysSha256,
    planningSha256: createNormalizedPlanningSummary(incrementalIr).sha256,
    execution: {
      status: 'success',
      durationMs: resultDuration(incrementalResult),
      ...cachedActions(incrementalResult),
    },
    changedActionIds: actionDelta.filter((action) => action.keyChanged).map((action) => action.id).sort(compareText),
    cachedActionIds: actionDelta.filter((action) => action.cached).map((action) => action.id).sort(compareText),
    actionDelta: actionDelta.sort((left, right) => compareText(left.id, right.id)),
    artifactIdentityChanged,
  });
}

export function createActionGraphEvidence({
  executor,
  target,
  fqbn,
  ir,
  firstResult,
  replayResult,
  incrementalIr,
  incrementalResult,
  mainSourcePath,
  replayFullyCached,
  startedAt = new Date().toISOString(),
  finishedAt = new Date().toISOString(),
  sourceRevision,
} = {}) {
  const normalizedExecutor = safeSegment(executor, 'executor');
  const normalizedTarget = safeSegment(target, 'target');
  if (typeof fqbn !== 'string' || fqbn.split(':').length !== 3) throw new TypeError('fqbn is invalid');
  if (!ir || !Number.isSafeInteger(ir.schemaVersion) || ir.schemaVersion < 1) {
    throw new TypeError('CK Build IR is invalid');
  }
  const revision = requiredSourceRevision(sourceRevision);

  const firstArtifacts = resultStatus(firstResult) === 'success' ? normalizeArtifacts(firstResult) : [];
  const replayArtifacts = resultStatus(replayResult) === 'success' ? normalizeArtifacts(replayResult) : [];
  const replayActions = cachedActions(replayResult);
  const fullyCached = replayFullyCached === undefined
    ? replayActions.total > 0 && replayActions.cached === replayActions.total
    : replayFullyCached === true;
  const artifactIdentityMatch = firstArtifacts.length > 0 && sameArtifacts(firstArtifacts, replayArtifacts);
  const incremental = incrementalEvidence(ir, incrementalIr, incrementalResult, firstArtifacts, mainSourcePath);
  const passed = resultStatus(firstResult) === 'success'
    && resultStatus(replayResult) === 'success'
    && fullyCached
    && artifactIdentityMatch
    && incremental.status === 'pass';

  const report = {
    schema: 2,
    verificationSchema: 2,
    scope: 'ck-action-graph-runtime',
    compatibilityClaim: 'complete-action-dag-cache-replay-and-main-incremental-rebuild',
    executor: normalizedExecutor,
    target: normalizedTarget,
    fqbn,
    status: passed ? 'pass' : 'fail',
    startedAt,
    finishedAt,
    sourceRevision: revision,
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      ci: process.env.CI === 'true',
    },
    buildIr: {
      schemaVersion: ir.schemaVersion,
      sha256: evidenceSha256(ir),
      ...actionSummary(ir),
    },
    planning: createNormalizedPlanningSummary(ir),
    packs: normalizePacks(ir),
    artifacts: firstArtifacts,
    firstExecution: {
      status: resultStatus(firstResult),
      durationMs: resultDuration(firstResult),
      ...cachedActions(firstResult),
      ...(firstResult?.reason ? { reason: String(firstResult.reason) } : {}),
      ...(firstResult?.message ? { message: String(firstResult.message) } : {}),
    },
    cacheReplay: {
      status: resultStatus(replayResult),
      durationMs: resultDuration(replayResult),
      ...replayActions,
      fullyCached,
      artifactIdentityMatch,
      ...(replayResult?.reason ? { reason: String(replayResult.reason) } : {}),
      ...(replayResult?.message ? { message: String(replayResult.message) } : {}),
    },
    incrementalMain: incremental,
  };
  return Object.freeze({
    ...report,
    reportSha256: evidenceSha256(report),
  });
}

export async function writeActionGraphEvidence(report, {
  directory = process.env.CK_ACTION_GRAPH_EVIDENCE_DIR,
} = {}) {
  if (!directory) return null;
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const filename = `${safeSegment(report.executor, 'executor')}-${safeSegment(report.target, 'target')}.json`;
  const destination = join(root, filename);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return destination;
}

export async function executeActionGraphWithEvidence({
  executor,
  target,
  fqbn,
  ir,
  incrementalIr,
  mainSourcePath,
  sourceRevision,
  buildExecutor,
  onProgress,
  evidenceDirectory,
} = {}) {
  if (!buildExecutor || typeof buildExecutor.execute !== 'function') {
    throw new TypeError('buildExecutor must implement execute()');
  }
  const startedAt = new Date().toISOString();
  const firstResult = await buildExecutor.execute(ir, { onProgress });
  const replayResult = firstResult?.status === 'success'
    ? await buildExecutor.execute(ir)
    : { status: 'error', reason: 'first_execution_failed', message: 'cache replay was not attempted' };
  const incrementalResult = replayResult?.status === 'success' && incrementalIr
    ? await buildExecutor.execute(incrementalIr)
    : { status: 'error', reason: 'incremental_execution_not_attempted', message: 'incremental execution was not attempted' };
  const evidence = createActionGraphEvidence({
    executor,
    target,
    fqbn,
    ir,
    firstResult,
    replayResult,
    incrementalIr,
    incrementalResult,
    mainSourcePath,
    sourceRevision,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  const evidencePath = await writeActionGraphEvidence(evidence, { directory: evidenceDirectory });
  return Object.freeze({ firstResult, replayResult, incrementalResult, evidence, evidencePath });
}
