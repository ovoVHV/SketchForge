function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export const ACTIVE_COMPILE_RECORD_SCHEMA_VERSION = 2;

function validAcceptanceId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,192}$/.test(value);
}

export function compactStoredCompileContext(context) {
  if (!isRecord(context)) return context;
  const storedContext = { ...context };
  if (Array.isArray(context.files) && context.files.length > 0) {
    delete storedContext.source;
  }
  return storedContext;
}

export function normalizeStoredCompile(value) {
  const hasSource = typeof value?.context?.source === 'string';
  const hasFiles = Array.isArray(value?.context?.files) && value.context.files.length > 0;
  if (
    !isRecord(value)
    || (value.schemaVersion !== undefined
      && value.schemaVersion !== ACTIVE_COMPILE_RECORD_SCHEMA_VERSION)
    || typeof value.jobId !== 'string'
    || !value.jobId
    || typeof value.stream !== 'string'
    || !value.stream
    || typeof value.startedAt !== 'number'
    || !Number.isFinite(value.startedAt)
    || !isRecord(value.context)
    || (!hasSource && !hasFiles)
    || typeof value.context.board !== 'string'
    || !value.context.board
    || !isRecord(value.context.options)
  ) return null;
  return {
    schemaVersion: ACTIVE_COMPILE_RECORD_SCHEMA_VERSION,
    jobId: value.jobId,
    stream: value.stream,
    startedAt: value.startedAt,
    ...(typeof value.acceptedAt === 'number' && Number.isFinite(value.acceptedAt)
      ? { acceptedAt: value.acceptedAt }
      : {}),
    ...(validAcceptanceId(value.acceptanceId)
      ? { acceptanceId: value.acceptanceId }
      : {}),
    ...(Number.isSafeInteger(value.acceptanceEpoch) && value.acceptanceEpoch >= 0
      ? { acceptanceEpoch: value.acceptanceEpoch }
      : {}),
    ...(typeof value.savedAt === 'number' && Number.isFinite(value.savedAt)
      ? { savedAt: value.savedAt }
      : {}),
    context: compactStoredCompileContext(value.context),
    ...(isRecord(value.cancellation) ? { cancellation: { ...value.cancellation } } : {}),
  };
}

export function loadStoredCompileRecord(storage, key) {
  try {
    const raw = storage?.getItem?.(key);
    if (raw === null || raw === undefined) return null;
    const saved = normalizeStoredCompile(JSON.parse(raw));
    if (!saved) storage?.removeItem?.(key);
    return saved;
  } catch {
    try { storage?.removeItem?.(key); } catch { /* ignored */ }
    return null;
  }
}

export function compileRecoveryBoardDisposition(boards, fqbn) {
  return (Array.isArray(boards) ? boards : []).some((board) => board?.fqbn === fqbn)
    ? 'restore'
    : 'defer';
}
