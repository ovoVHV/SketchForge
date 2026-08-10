import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  BoardRegistry,
  createArduinoCommonLibraryCatalog,
  importLibrary,
  LibraryFetchError,
  LibraryStore,
  parseRepoUrl,
  collectLibraryBlocks,
  libraryBlocksSourceSha256,
  loadLibrary,
  MAX_COMPILE_REQUEST_BYTES,
  buildOptions,
  fingerprintCompileRequest,
  resolveOptions,
  parseBlocksMetadata,
  readBlocksMetadata,
  reviewBlocksMetadata,
  validateCompileRequest,
  writeBlocksMetadata,
  type CompileEvent,
  type CompileRequest,
} from '@sketchforge/core';
import { createArtifactStore } from './artifact-store.js';
import { registerArtifactDownloadRoute } from './artifact-download.js';
import { listWorkerCapabilities, type WorkerCapability } from './capabilities.js';
import { CompileEventHub } from './compile-event-hub.js';
import { createCompileRedisNamespace } from './compile-namespace.js';
import { loadCompilerRuntimeConfiguration } from './compiler-runtime-release.js';
import { RedisCompileEventStore, type SequencedCompileEvent } from './distributed-events.js';
import {
  DistributedCompileQueue,
  DistributedQueueBusyError,
  DistributedQueueFullError,
  workerPoolForBoard,
} from './distributed-queue.js';
import { CompileTerminalCoordinator, RedisCompileQueueLock } from './queue-terminal.js';
import { RedisCompileRateLimiter } from './distributed-rate-limit.js';
import { GatewayCompileAdmission } from './gateway-compile-admission.js';
import { createRedisConnection, isRedisUnavailableError, verifyRedis } from './redis.js';
import { registerRetiredStaticPathGuard, setStaticHeaders } from './static-headers.js';
import { setGatewaySecurityHeaders } from './security-headers.js';
import { boardAvailabilityResponse, boardCompileOptionError } from './board-availability.js';
import { API_CORS_METHODS } from './cors.js';
import { normalizePublicBasePath, prefixPublicPath } from './public-base-path.js';
import {
  MAX_PROJECT_SNAPSHOT_BYTES,
  RedisProjectStorage,
  VISITOR_PATTERN,
  projectQuotaHttpFailure,
  readProjectStorageLimits,
  validProjectId,
} from './cloud-project-store.js';

export {
  DEFAULT_PROJECT_STORAGE_LIMITS,
  MAX_PROJECT_SNAPSHOT_BYTES,
  RedisProjectStorage,
  projectQuotaHttpFailure,
  readProjectStorageLimits,
  type ProjectQuotaHttpFailure,
  type ProjectStorageLimits,
  type ProjectStorageSaveResult,
  type RedisProjectStorageOptions,
} from './cloud-project-store.js';

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export async function startGateway(): Promise<void> {
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const BROWSER_ONLY_MODE = process.env.AF_BROWSER_ONLY === '1';
const ADMIN_TOKEN = process.env.AF_ADMIN_TOKEN ?? '';
const publicBasePath = normalizePublicBasePath(process.env.AF_PUBLIC_BASE_PATH);

if (BROWSER_ONLY_MODE && !IS_PRODUCTION) {
  throw new Error('AF_BROWSER_ONLY=1 requires NODE_ENV=production');
}

const port = positiveInt('PORT', 3000);
const host = process.env.HOST ?? '127.0.0.1';
const bundleId = process.env.AF_COMPILER_BUNDLE_ID ?? 'development';
const queuePrefix = process.env.AF_QUEUE_PREFIX ?? 'sketchforge-compile';
const runtimeConfiguration = loadCompilerRuntimeConfiguration(
  process.env,
  bundleId,
  IS_PRODUCTION && !BROWSER_ONLY_MODE,
);
const compileNamespace = createCompileRedisNamespace(
  queuePrefix,
  bundleId,
  runtimeConfiguration.releaseId,
);
const boards = BoardRegistry.fromDirectory(join(REPO_ROOT, 'boards'));
const libraryStoreDir = process.env.AF_LIBRARY_STORE_DIR ?? join(REPO_ROOT, 'var', 'library-store');
const libraryStore = new LibraryStore(libraryStoreDir);
mkdirSync(process.env.AF_LIBRARY_IMPORT_WORK_DIR ?? join(REPO_ROOT, 'var', 'library-imports'), { recursive: true });
const libraryCatalog = createArduinoCommonLibraryCatalog();
const redis = createRedisConnection('gateway');
const eventRedis = createRedisConnection('events');
await Promise.all([verifyRedis(redis), verifyRedis(eventRedis)]);

function requireAdmin(request: FastifyRequest, reply: FastifyReply): void {
  if (!ADMIN_TOKEN) {
    void reply.code(503).send({ error: 'admin_disabled', message: '库管理接口未配置' });
    return;
  }
  const authorization = request.headers.authorization ?? '';
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(ADMIN_TOKEN);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    reply.header('WWW-Authenticate', 'Bearer');
    void reply.code(401).send({ error: 'unauthorized', message: '需要管理员令牌' });
  }
}
const defaultQueueCapacity = positiveInt('AF_MAX_QUEUED_PER_POOL', 100);
const resultTtlSeconds = positiveInt('AF_RESULT_TTL_SECONDS', 24 * 60 * 60);
const consumerLeaseTtlSeconds = positiveInt('AF_COMPILE_CONSUMER_TTL_SECONDS', resultTtlSeconds);
const queueLockTtlMs = positiveInt('AF_QUEUE_ADMISSION_LOCK_TTL_MS', 15_000);
const queueLockWaitMs = positiveInt('AF_QUEUE_ADMISSION_WAIT_MS', 2_000);

const events = new RedisCompileEventStore(redis, {
  namespace: compileNamespace,
  ttlSeconds: resultTtlSeconds,
  maxEvents: positiveInt('AF_MAX_JOB_EVENTS', 256),
  maxEventBytes: positiveInt('AF_MAX_EVENT_BYTES', 256 * 1024),
});
const queueCoordination = new RedisCompileQueueLock(redis, {
  namespace: compileNamespace,
  ttlMs: queueLockTtlMs,
  waitMs: queueLockWaitMs,
});
const queue = new DistributedCompileQueue(redis, {
  namespace: compileNamespace,
  runtimeConfiguration,
  maxQueuedPerPool: {
    avr: positiveInt('AF_MAX_QUEUED_AVR', defaultQueueCapacity),
    'esp32-xtensa': positiveInt('AF_MAX_QUEUED_ESP32_XTENSA', defaultQueueCapacity),
    'esp32-riscv': positiveInt('AF_MAX_QUEUED_ESP32_RISCV', defaultQueueCapacity),
  },
  maxQueuedRequestBytes: positiveInt('AF_MAX_QUEUED_REQUEST_BYTES', 128 * 1024 * 1024),
  ...(process.env.AF_JOB_WALL_TIMEOUT_MS === undefined
    ? {}
    : { jobWallTimeoutMs: positiveInt('AF_JOB_WALL_TIMEOUT_MS', 300_000) }),
  completedRetentionSeconds: resultTtlSeconds,
  completedRetentionCount: positiveInt(
    'AF_MAX_COMPLETED_JOBS_PER_POOL',
    positiveInt('AF_MAX_COMPLETED_JOBS', 20_000),
  ),
  failedRetentionSeconds: positiveInt('AF_FAILED_JOB_TTL_SECONDS', 60 * 60),
  failedRetentionCount: positiveInt('AF_MAX_FAILED_JOBS_PER_POOL', 250),
  coordination: queueCoordination,
  consumerLeaseTtlMs: consumerLeaseTtlSeconds * 1_000,
  maxConsumersPerJob: positiveInt('AF_MAX_COMPILE_CONSUMERS_PER_JOB', 1_024),
});
const terminals = new CompileTerminalCoordinator(
  queueCoordination,
  events,
  (jobId) => queue.get(jobId),
);
const hub = new CompileEventHub(eventRedis, compileNamespace);
await hub.ready();
const artifacts = createArtifactStore({
  rootDir: process.env.AF_ARTIFACT_DIR ?? join(REPO_ROOT, 'var', 'artifacts'),
  maxArtifactBytes: positiveInt('AF_MAX_ARTIFACT_BYTES', 32 * 1024 * 1024),
  ttlMs: positiveInt('AF_ARTIFACT_TTL_MS', 7 * 24 * 60 * 60 * 1_000),
  maxEntries: positiveInt('AF_ARTIFACT_MAX_ENTRIES', 20_000),
  maxTotalBytes: positiveInt('AF_ARTIFACT_MAX_BYTES', 4 * 1024 * 1024 * 1024),
});
const rateLimiter = new RedisCompileRateLimiter(redis, {
  windowMs: positiveInt('AF_RATE_WINDOW_MS', 60_000),
  globalLimit: positiveInt('AF_COMPILE_GLOBAL_RATE', 600),
  ipLimit: positiveInt('AF_COMPILE_IP_RATE', 120),
  visitorLimit: positiveInt('AF_COMPILE_VISITOR_RATE', 60),
  keySalt: process.env.AF_RATE_KEY_SALT ?? 'sketchforge-public',
});
const maxLibraryImports = positiveInt('AF_MAX_LIBRARY_IMPORTS', 2);
let libraryImports = 0;
const projectStorageLimits = readProjectStorageLimits();
const projectStorage = new RedisProjectStorage(redis, {
  prefix: queuePrefix,
  ...projectStorageLimits,
});

function requestVisitor(request: { headers: Record<string, unknown> }): string | null {
  const raw = request.headers['x-af-visitor'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && VISITOR_PATTERN.test(value) ? value : null;
}
const avrCompileCost = positiveInt('AF_COMPILE_AVR_COST', 1);
const esp32CompileCost = positiveInt('AF_COMPILE_ESP32_COST', 8);
const compileAdmission = new GatewayCompileAdmission(rateLimiter, {
  avr: avrCompileCost,
  esp32: esp32CompileCost,
});

let capabilityCache: { expiresAt: number; rows: WorkerCapability[] } = { expiresAt: 0, rows: [] };
async function capabilities(): Promise<WorkerCapability[]> {
  if (capabilityCache.expiresAt > Date.now()) return capabilityCache.rows;
  const rows = await listWorkerCapabilities(redis, compileNamespace, runtimeConfiguration);
  capabilityCache = { expiresAt: Date.now() + 2_000, rows };
  return rows;
}

function namespacedFingerprint(request: CompileRequest): { hash: string; reusable: boolean } {
  const fingerprint = fingerprintCompileRequest(request);
  const hash = createHash('sha256')
    .update('sketchforge-job-v1\0')
    .update(bundleId)
    .update('\0')
    .update(runtimeConfiguration.releaseId)
    .update('\0')
    .update(fingerprint.baseHash)
    .digest('hex');
  return { hash, reusable: fingerprint.resultReusable };
}

const app = Fastify({
  logger: IS_PRODUCTION ? { level: process.env.AF_LOG_LEVEL ?? 'info' } : false,
  // Leave a small parser margin for malformed JSON, while keeping oversized
  // anonymous payloads out of Redis/BullMQ before request validation runs.
  bodyLimit: MAX_COMPILE_REQUEST_BYTES + 64 * 1024,
  trustProxy: process.env.AF_TRUST_PROXY === '1',
});
app.addHook('onRequest', (_request, reply, done) => {
  setGatewaySecurityHeaders(reply);
  done();
});
registerRetiredStaticPathGuard(app);
app.setErrorHandler((error, request, reply) => {
  const httpError = error as { statusCode?: unknown; code?: unknown };
  const statusCode = Number(httpError.statusCode);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
    request.log.warn({ err: error }, 'gateway rejected request');
    const tooLarge = httpError.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || statusCode === 413;
    return reply.code(statusCode).send({
      error: tooLarge ? 'request_too_large' : 'invalid_request',
      message: tooLarge
        ? `compile request exceeds the ${MAX_COMPILE_REQUEST_BYTES / 1024} KB limit`
        : 'invalid HTTP request',
    });
  }
  if (isRedisUnavailableError(error)) {
    request.log.warn({ err: error }, 'gateway dependency unavailable');
    reply.header('Retry-After', '2');
    return reply.code(503).send({
      error: 'compile_service_unavailable',
      message: '编译调度服务暂时不可用，请稍后重试',
    });
  }
  request.log.error({ err: error }, 'gateway request failed');
  return reply.code(500).send({ error: 'internal', message: '服务内部错误' });
});
const corsOrigins = (process.env.AF_CORS_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
await app.register(cors, {
  origin: IS_PRODUCTION ? (corsOrigins.length ? corsOrigins : false) : true,
  methods: API_CORS_METHODS,
});

app.get('/v1/boards', async () => {
  const ready = new Set((await capabilities()).flatMap((worker) => worker.boards));
  return boardAvailabilityResponse(boards, (fqbn) => ready.has(fqbn));
});

app.get<{ Querystring: { arch?: string } }>('/v1/libraries', async (request) => {
  const byName = new Map<string, WorkerCapability['libraries'][number]>();
  for (const worker of await capabilities()) {
    for (const library of worker.libraries) {
      if (request.query.arch && !library.architectures.some((arch) => arch === '*' || arch === request.query.arch)) continue;
      byName.set(`${library.name}@${library.version}`, library);
    }
  }
  return { libraries: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)) };
});

app.get<{ Querystring: { arch?: string; q?: string } }>('/v1/libraries/catalog', async (request) => {
  const rows = libraryCatalog.list({
    architecture: request.query.arch,
    text: request.query.q,
    limit: 128,
  });
  const installed = new Set(libraryStore.list().map((entry) => `${entry.name}@${entry.version}`.toLowerCase()));
  return {
    schema: libraryCatalog.schema,
    libraries: rows.map((library) => ({
      id: library.id,
      name: library.name,
      version: library.version,
      architectures: library.architectures,
      dependencies: library.dependencies,
      publicHeaders: library.publicHeaders,
      description: library.description ?? null,
      category: library.category ?? null,
      license: library.license ?? null,
      blocksMeta: library.blocksMeta ?? null,
      source: library.source,
      installed: installed.has(`${library.name}@${library.version}`.toLowerCase()),
    })),
  };
});

app.get('/v1/libraries/installed', async () => ({ libraries: libraryStore.list() }));

function storedLibrary(dir: string) {
  const entry = libraryStore.getByDir(dir);
  if (!entry) return null;
  const root = join(libraryStoreDir, entry.dir);
  const library = loadLibrary(root);
  return library ? { entry, root, library } : null;
}

app.get('/v1/libraries/imported', { preHandler: requireAdmin }, async () => ({
  entries: libraryStore.list().map((entry) => ({
    ...entry,
    blocksMeta: readBlocksMetadata(join(libraryStoreDir, entry.dir)),
  })),
}));

app.post<{ Params: { dir: string } }>(
  '/v1/libraries/imported/:dir/blocks/draft',
  { preHandler: requireAdmin },
  async (request, reply) => {
    const selected = storedLibrary(request.params.dir);
    if (!selected) return reply.code(404).send({ error: 'not_found', message: '库条目不存在' });
    const blocksMeta = collectLibraryBlocks(selected.library);
    writeBlocksMetadata(selected.root, blocksMeta);
    return { blocksMeta };
  },
);

app.put<{ Params: { dir: string }; Body: unknown }>(
  '/v1/libraries/imported/:dir/blocks',
  { preHandler: requireAdmin },
  async (request, reply) => {
    const selected = storedLibrary(request.params.dir);
    if (!selected) return reply.code(404).send({ error: 'not_found', message: '库条目不存在' });
    let blocksMeta;
    try { blocksMeta = parseBlocksMetadata(request.body); }
    catch (error) {
      return reply.code(400).send({ error: 'invalid_blocks_meta', message: (error as Error).message });
    }
    if (blocksMeta.review.status !== 'draft') {
      return reply.code(400).send({ error: 'invalid_blocks_meta', message: '编辑后的元数据必须先保存为 draft' });
    }
    if (blocksMeta.library.name !== selected.library.manifest.name
      || blocksMeta.library.version !== selected.library.manifest.version
      || blocksMeta.library.sourceSha256 !== libraryBlocksSourceSha256(selected.library)) {
      return reply.code(409).send({ error: 'stale_blocks_meta', message: '元数据与当前库源码身份不一致，请重新采集' });
    }
    writeBlocksMetadata(selected.root, blocksMeta);
    return { blocksMeta };
  },
);

app.post<{
  Params: { dir: string };
  Body: { status?: string; reviewer?: string; notes?: string };
}>(
  '/v1/libraries/imported/:dir/blocks/review',
  { preHandler: requireAdmin },
  async (request, reply) => {
    const selected = storedLibrary(request.params.dir);
    if (!selected) return reply.code(404).send({ error: 'not_found', message: '库条目不存在' });
    const status = request.body?.status;
    const reviewer = request.body?.reviewer?.trim() ?? '';
    if ((status !== 'approved' && status !== 'rejected') || !reviewer || reviewer.length > 128
      || (request.body?.notes?.length ?? 0) > 4_096) {
      return reply.code(400).send({ error: 'invalid_request', message: '需要 approved/rejected 状态和 reviewer' });
    }
    const current = readBlocksMetadata(selected.root, true);
    if (!current) return reply.code(404).send({ error: 'not_found', message: '尚未采集 blocks.json' });
    if (current.library.sourceSha256 !== libraryBlocksSourceSha256(selected.library)) {
      return reply.code(409).send({ error: 'stale_blocks_meta', message: '库源码已变化，请重新采集' });
    }
    const blocksMeta = reviewBlocksMetadata(current, status, reviewer, request.body?.notes);
    writeBlocksMetadata(selected.root, blocksMeta);
    return { blocksMeta };
  },
);

app.post('/v1/libraries/install', async (request, reply) => {
  const body = request.body as Record<string, unknown> | null;
  const repository = typeof body?.repository === 'string' ? body.repository.trim() : '';
  const ref = typeof body?.ref === 'string' && body.ref.trim() ? body.ref.trim() : 'HEAD';
  try {
    parseRepoUrl(repository, ref);
  } catch (error) {
    if (error instanceof LibraryFetchError) {
      return reply.code(400).send({ error: error.code, message: error.message });
    }
    throw error;
  }
  if (libraryImports >= maxLibraryImports) {
    reply.header('Retry-After', '5');
    return reply.code(429).send({ error: 'library_import_busy', message: '库导入任务过多，请稍后重试' });
  }
  libraryImports++;
  try {
    const result = await importLibrary(repository, ref, {
      store: libraryStore,
      githubToken: process.env.GITHUB_TOKEN,
      workDir: process.env.AF_LIBRARY_IMPORT_WORK_DIR ?? join(REPO_ROOT, 'var', 'library-imports'),
    });
    const code = result.status === 'accepted' ? 200 : result.status === 'rejected' ? 422 : 502;
    return reply.code(code).send(result);
  } finally {
    libraryImports--;
  }
});

app.get('/v1/projects', async (request, reply) => {
  const visitor = requestVisitor(request);
  if (!visitor) return reply.code(400).send({ error: 'invalid_visitor', message: '缺少有效的 X-AF-Visitor' });
  await projectStorage.cleanupVisitor(visitor);
  const rows = await redis.zrevrange(projectStorage.projectIndexKey(visitor), 0, -1, 'WITHSCORES');
  const projects = [];
  for (let index = 0; index < rows.length; index += 2) {
    const id = rows[index];
    const indexUpdatedAt = Number(rows[index + 1]);
    if (!id || !validProjectId(id)) continue;
    const raw = await redis.get(projectStorage.projectKey(visitor, id));
    if (!raw) {
      await projectStorage.delete(visitor, id);
      continue;
    }
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      const updatedAt = typeof value.updatedAt === 'number' && Number.isSafeInteger(value.updatedAt)
        ? value.updatedAt
        : indexUpdatedAt;
      projects.push({ id, name: value.name ?? id, board: value.board, updatedAt });
    } catch {
      await projectStorage.delete(visitor, id);
    }
  }
  return { projects };
});

app.get<{ Params: { projectId: string } }>('/v1/projects/:projectId', async (request, reply) => {
  const visitor = requestVisitor(request);
  if (!visitor || !validProjectId(request.params.projectId)) {
    return reply.code(400).send({ error: 'invalid_request', message: '项目标识或访客标识无效' });
  }
  const raw = await redis.get(projectStorage.projectKey(visitor, request.params.projectId));
  if (!raw) {
    await projectStorage.delete(visitor, request.params.projectId);
    return reply.code(404).send({ error: 'not_found', message: '项目不存在或已过期' });
  }
  try {
    return JSON.parse(raw);
  } catch {
    await projectStorage.delete(visitor, request.params.projectId);
    return reply.code(404).send({ error: 'not_found', message: '项目数据已损坏' });
  }
});

app.put<{ Params: { projectId: string } }>('/v1/projects/:projectId', async (request, reply) => {
  const visitor = requestVisitor(request);
  const projectId = request.params.projectId;
  if (!visitor || !validProjectId(projectId)) {
    return reply.code(400).send({ error: 'invalid_request', message: '项目标识或访客标识无效' });
  }
  const body = request.body as Record<string, unknown> | null;
  const board = typeof body?.board === 'string' ? body.board : '';
  const candidate = {
    board,
    files: body?.files,
    ...(body?.libraries === undefined ? {} : { libraries: body.libraries }),
    ...(body?.options === undefined ? {} : { options: body.options }),
  };
  const validation = validateCompileRequest(candidate);
  if (!validation.ok) return reply.code(400).send({ error: 'invalid_request', message: validation.message });
  const name = typeof body?.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, 120)
    : projectId;
  const value = {
    schema: 1,
    id: projectId,
    name,
    board: validation.request.board,
    files: validation.request.files,
    ...(validation.request.libraries ? { libraries: validation.request.libraries } : {}),
    ...(validation.request.options ? { options: validation.request.options } : {}),
    updatedAt: Date.now(),
  };
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PROJECT_SNAPSHOT_BYTES) {
    return reply.code(413).send({ error: 'project_too_large', message: '项目快照超过 600 KB' });
  }
  const stored = await projectStorage.save(visitor, projectId, encoded, value.updatedAt);
  if (!stored.ok) {
    const failure = projectQuotaHttpFailure(stored);
    return reply.code(failure.statusCode).send(failure.body);
  }
  return reply.code(200).send({ id: projectId, name, updatedAt: value.updatedAt });
});

app.delete<{ Params: { projectId: string } }>('/v1/projects/:projectId', async (request, reply) => {
  const visitor = requestVisitor(request);
  const projectId = request.params.projectId;
  if (!visitor || !validProjectId(projectId)) {
    return reply.code(400).send({ error: 'invalid_request', message: '项目标识或访客标识无效' });
  }
  await projectStorage.delete(visitor, projectId);
  return { deleted: true };
});

app.post('/v1/compile', { onRequest: compileAdmission.onRequest }, async (request, reply) => {
  if (BROWSER_ONLY_MODE) {
    reply.header('Retry-After', '60');
    return reply.code(503).send({
      error: 'server_compile_disabled',
      message: '当前实例为浏览器优先模式，服务端编译 Worker 尚未启用',
    });
  }
  const submittedAt = Date.now();
  const validation = validateCompileRequest(request.body);
  if (!validation.ok) return reply.code(400).send({ error: 'invalid_request', message: validation.message });
  const compileRequest = validation.request;
  const board = boards.get(compileRequest.board);
  if (!board) return reply.code(400).send({ error: 'invalid_request', message: `未知板子：${compileRequest.board}` });
  if (board.arch !== 'avr' && board.arch !== 'esp32') {
    return reply.code(400).send({ error: 'invalid_request', message: `${board.arch} 架构尚未接入` });
  }
  const unsupportedMessage = boardCompileOptionError(board, compileRequest.options);
  if (unsupportedMessage) {
    return reply.code(400).send({ error: 'invalid_request', message: unsupportedMessage });
  }
  if (!await compileAdmission.chargeArchitecture(request, reply, board.arch)) return;
  const resolvedOptions = resolveOptions(board, compileRequest.options);
  if (resolvedOptions.errors.length > 0) {
    return reply.code(400).send({ error: 'invalid_request', message: resolvedOptions.errors.join('；') });
  }
  const workerRequest: CompileRequest = {
    ...compileRequest,
    options: buildOptions(board, resolvedOptions.options),
  };

  const targetPool = workerPoolForBoard(board);
  const expectedRuntimeIdentity = runtimeConfiguration.runtimes[targetPool].hostRuntimeIdentity;
  const online = (await capabilities()).some((worker) => (
    worker.pool === targetPool
      && worker.hostRuntimeIdentity === expectedRuntimeIdentity
      && worker.boards.includes(board.fqbn)
  ));
  if (!online) {
    reply.header('Retry-After', '5');
    return reply.code(503).send({ error: 'worker_unavailable', message: `板子 ${board.fqbn} 当前没有可用编译 worker` });
  }

  const fingerprint = namespacedFingerprint(workerRequest);
  try {
    const job = await queue.submit(
      board,
      workerRequest,
      fingerprint.hash,
      bundleId,
      fingerprint.reusable,
      submittedAt,
    );
    reply.header('Cache-Control', 'no-store');
    return reply.code(202).send({
      jobId: job.id,
      stream: prefixPublicPath(publicBasePath, `/v1/compile/${job.id}/events`),
      reused: job.reused,
      ...(job.cancellation ? {
        cancellation: {
          requestId: job.cancellation.requestId,
          url: prefixPublicPath(
            publicBasePath,
            `/v1/compile/${job.id}/requests/${job.cancellation.requestId}`,
          ),
          token: job.cancellation.token,
          expiresAt: job.cancellation.expiresAt,
        },
      } : {}),
    });
  } catch (error) {
    if (error instanceof DistributedQueueFullError) {
      reply.header('Retry-After', '5');
      return reply.code(429).send({ error: 'queue_full', message: '编译队列已满，请稍后重试' });
    }
    if (error instanceof DistributedQueueBusyError) {
      reply.header('Retry-After', '1');
      return reply.code(503).send({ error: 'queue_busy', message: '编译调度繁忙，请稍后重试' });
    }
    throw error;
  }
});

app.get<{ Params: { jobId: string } }>('/v1/compile/:jobId', async (request, reply) => {
  const job = await queue.get(request.params.jobId);
  if (!job) return reply.code(404).send({ error: 'not_found', message: '作业不存在或已过期' });
  const state = await job.getState();
  return {
    jobId: job.id,
    state,
    ...(state === 'completed' ? { result: job.returnvalue } : {}),
    ...(state === 'failed' ? { error: 'worker_failed' } : {}),
  };
});

app.delete<{ Params: { jobId: string; requestId: string } }>(
  '/v1/compile/:jobId/requests/:requestId',
  async (request, reply) => {
    const rawToken = request.headers['x-af-cancel-token'];
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) {
      return reply.code(404).send({ error: 'not_found', message: 'cancellation handle does not exist or has expired' });
    }
    const result = await queue.cancelRequest(request.params.jobId, request.params.requestId, token);
    if (!result) {
      return reply.code(404).send({ error: 'not_found', message: 'cancellation handle does not exist or has expired' });
    }
    reply.header('Cache-Control', 'no-store');
    return result;
  },
);

const maxSseConnections = positiveInt('AF_MAX_SSE_CONNECTIONS', 1_000);
const maxSsePerJob = positiveInt('AF_MAX_SSE_PER_JOB', 4);
const maxSseBufferedBytes = positiveInt('AF_MAX_SSE_BUFFERED_BYTES', 4 * 1024 * 1024);
const heartbeatMs = positiveInt('AF_SSE_HEARTBEAT_MS', 15_000);
let sseConnections = 0;

app.get<{ Params: { jobId: string } }>('/v1/compile/:jobId/events', async (request, reply) => {
  const job = await queue.get(request.params.jobId);
  if (!job) return reply.code(404).send({ error: 'not_found', message: '作业不存在或已过期' });
  if (sseConnections >= maxSseConnections || hub.subscriberCount(job.id!) >= maxSsePerJob) {
    reply.header('Retry-After', '2');
    return reply.code(429).send({ error: 'stream_limit', message: '事件流连接过多，请稍后重连' });
  }

  sseConnections++;
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  let replaying = true;
  let heartbeat: NodeJS.Timeout | undefined;
  let lastSent = Number(Array.isArray(request.headers['last-event-id'])
    ? request.headers['last-event-id'][0]
    : request.headers['last-event-id'] ?? 0);
  if (!Number.isFinite(lastSent) || lastSent < 0) lastSent = 0;
  const pending: SequencedCompileEvent[] = [];
  let unsubscribe = () => {};

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    sseConnections--;
    if (!reply.raw.writableEnded) reply.raw.end();
  };
  const send = (envelope: SequencedCompileEvent) => {
    const sequence = Number(envelope.id);
    if (closed || !Number.isFinite(sequence) || sequence <= lastSent) return;
    if (reply.raw.destroyed) return close();
    const event = envelope.event as CompileEvent;
  const frame = `id: ${envelope.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
    if (reply.raw.writableLength + Buffer.byteLength(frame, 'utf8') > maxSseBufferedBytes) return close();
    lastSent = sequence;
    reply.raw.write(frame);
    if (event.event === 'done') close();
  };
  let checkingTerminal = false;
  const pumpTerminal = async (): Promise<void> => {
    if (closed || checkingTerminal) return;
    checkingTerminal = true;
    try {
      // Reconcile before replay. This both recovers terminal events missed by
      // a dead worker and removes an old terminal generation after a retry.
      await terminals.reconcile(job.id!);
      for (const event of await events.list(job.id!, String(lastSent))) send(event);
    } finally {
      checkingTerminal = false;
    }
  };
  unsubscribe = hub.subscribe(job.id!, (event) => {
    if (replaying) pending.push(event);
    else send(event);
  });
  request.raw.once('close', close);

  try {
    await pumpTerminal();
    replaying = false;
    pending.sort((left, right) => Number(left.id) - Number(right.id));
    for (const event of pending) send(event);
    await pumpTerminal();
    if (!closed) {
      heartbeat = setInterval(() => {
        if (reply.raw.destroyed || reply.raw.writableEnded) return close();
        void pumpTerminal().catch(() => close());
        if (closed) return;
        const frame = `: heartbeat ${Date.now()}\n\n`;
        if (reply.raw.writableLength + Buffer.byteLength(frame, 'utf8') > maxSseBufferedBytes) return close();
        reply.raw.write(frame);
      }, heartbeatMs);
      heartbeat.unref();
    }
  } catch {
    close();
  }
});

registerArtifactDownloadRoute(app, artifacts);

app.get('/healthz', async (_request, reply) => {
  try {
    await verifyRedis(redis);
    const workers = await capabilities();
    const readyBoards = new Set(workers.flatMap((worker) => worker.boards));
    const ok = BROWSER_ONLY_MODE || (workers.length > 0 && readyBoards.size > 0);
    if (!ok) reply.code(503);
    return {
      ok,
      mode: BROWSER_ONLY_MODE ? 'browser-only' : 'distributed-gateway',
      serverCompile: !BROWSER_ONLY_MODE,
      redis: true,
      workers: workers.length,
      boards: [...readyBoards].sort(),
      bundleId,
      compileReleaseId: runtimeConfiguration.releaseId,
      runtimeTrust: runtimeConfiguration.trust,
      artifactStore: artifacts.kind,
      sseConnections,
      maxSseConnections,
      queues: await queue.stats(),
    };
  } catch (error) {
    reply.code(503);
    return {
      ok: false,
      mode: BROWSER_ONLY_MODE ? 'browser-only' : 'distributed-gateway',
      serverCompile: !BROWSER_ONLY_MODE,
      redis: false,
      message: String((error as Error).message),
    };
  }
});

const publicRoot = join(REPO_ROOT, 'packages', 'web', 'public');
await app.register(fastifyStatic, { root: publicRoot, setHeaders: setStaticHeaders(publicRoot) });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'stopping distributed gateway');
  await app.close();
  await Promise.allSettled([hub.close(), queue.close(), Promise.resolve(artifacts.close?.())]);
  await Promise.allSettled([redis.quit(), eventRedis.quit()]);
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

await app.listen({ port, host });
console.log(`sketchforge distributed gateway listening on http://${host}:${port}`);
}

const gatewayEntryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (gatewayEntryPath === resolve(fileURLToPath(import.meta.url))) {
  await startGateway();
}
