/**
 * 底座 HTTP 服务。
 *
 * 设计纪律：这里不允许出现任何图形化 / 积木相关的概念。
 * 对外只承诺一句：给我 .ino，还你精确到 行/列 的结构化诊断。
 * 积木 ID ←→ 行号 的 source map 由上层前端自己维护。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';

import {
  BoardRegistry, CompileService, FileActionCache, LocalExecutor, NsjailExecutor, BubblewrapExecutor,
  LibraryRegistry, LibraryStore, importLibrary, loadLibrary,
  collectLibraryBlocks, libraryBlocksSourceSha256, parseBlocksMetadata,
  publicBlocksMetadata, readBlocksMetadata, reviewBlocksMetadata, writeBlocksMetadata,
  detectLocalToolchain, describeToolchain, esp32BoardSupported, selfTestSandbox, formatSelfTest,
  validateCompileRequest, MAX_COMPILE_REQUEST_BYTES,
  type CompileRequest, type SandboxExecutor, type TrialCompileResult,
} from '@sketchforge/core';
import { JobManager, QueueClosedError, QueueFullError } from './jobs.js';
import { FixedWindowRateLimiter } from './rate-limit.js';
import { registerRetiredStaticPathGuard, setStaticHeaders } from './static-headers.js';
import { boardAvailabilityResponse, boardCompileOptionError } from './board-availability.js';
import { loadPublishedPlatformManifests } from './platform-manifests.js';
import { API_CORS_METHODS } from './cors.js';
import { normalizePublicBasePath, prefixPublicPath } from './public-base-path.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ADMIN_TOKEN = process.env.AF_ADMIN_TOKEN ?? '';
const publicBasePath = normalizePublicBasePath(process.env.AF_PUBLIC_BASE_PATH);

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

const toolchain = detectLocalToolchain();
const boards = BoardRegistry.fromDirectory(join(REPO_ROOT, 'boards'));

/**
 * Arduino's package manager installs versioned toolchain directories. For a
 * local preview, treating those package roots as a stable snapshot avoids
 * reading every byte of every ESP SDK file before the first compile. That
 * full scan is still available for people modifying a toolchain in place.
 *
 * Public workers must use AF_COMPILER_BUNDLE_ID instead; this is deliberately
 * disabled in production and does not cover mutable user libraries.
 */
function localToolchainIdentityHint(): string | undefined {
  if (IS_PRODUCTION || process.env.AF_STRICT_LOCAL_TOOLCHAIN_IDENTITY === '1') return undefined;
  const configured = process.env.AF_LOCAL_TOOLCHAIN_IDENTITY?.trim();
  if (configured) return configured;

  const hash = createHash('sha256').update('sketchforge-local-toolchain-v1\0');
  const addPath = (label: string, path: string | undefined) => {
    hash.update(label).update('\0').update(path ?? 'not-configured').update('\0');
    if (!path) return;
    try {
      const stat = statSync(path);
      hash.update(`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
    } catch {
      hash.update('unreadable');
    }
    hash.update('\0');
  };

  addPath('avr-root', toolchain.avr?.rootDir ?? toolchain.avr?.binDir);
  addPath('avr-core', toolchain.avr?.coreDir);
  addPath('avr-variants', toolchain.avr?.variantsDir);
  addPath('esp32-xtensa-root', toolchain.esp32?.xtensaRootDir ?? toolchain.esp32?.xtensaBinDir);
  addPath('esp32-riscv-root', toolchain.esp32?.riscvRootDir ?? toolchain.esp32?.riscvBinDir);
  addPath('esp32-core', toolchain.esp32?.coreDir);
  addPath('esp32-variants', toolchain.esp32?.variantsDir);
  addPath('esp32-platform', toolchain.esp32?.platformDir);
  addPath('esp32-esptool', toolchain.esp32?.esptool);

  const sdkTargets = new Set<string>();
  for (const board of boards.list()) {
    if (board.arch !== 'esp32') continue;
    sdkTargets.add(board.build.sdkTarget ?? board.build.mcu);
    for (const effects of Object.values(board.build.optionEffects ?? {})) {
      for (const effect of Object.values(effects)) {
        if (effect.sdkTarget) sdkTargets.add(effect.sdkTarget);
      }
    }
  }
  for (const target of [...sdkTargets].sort()) {
    let root: string | null = null;
    try { root = toolchain.esp32?.sdkRootFor(target) ?? null; } catch { /* added as unavailable below */ }
    addPath(`esp32-sdk:${target}`, root ?? undefined);
  }

  for (const board of [...boards.list()].sort((left, right) => left.fqbn.localeCompare(right.fqbn))) {
    hash.update(JSON.stringify(board)).update('\0');
  }
  return `local-${hash.digest('hex')}`;
}

const developmentToolchainIdentityHint = localToolchainIdentityHint();
const platformManifests = loadPublishedPlatformManifests({
  repoRoot: REPO_ROOT,
  ...(process.env.AF_PLATFORM_RELEASE_PATH
    ? { releasePath: process.env.AF_PLATFORM_RELEASE_PATH }
    : {}),
});

/**
 * 已导入库的存储。它的根目录直接加进 librariesDirs ——
 * 该目录下每个子目录就是一个库根，LibraryRegistry 能直接消费；
 * 同时也让整个目录一次性只读挂进沙箱，不必逐库挂载。
 */
const baseLibraryDirs = [...toolchain.librariesDirs];
const importedLibrariesDir = join(toolchain.cacheDir, 'imported');
const libraryStore = new LibraryStore(importedLibrariesDir, {
  maxTotalBytes: Number(process.env.AF_LIB_QUOTA_BYTES ?? 2 * 1024 * 1024 * 1024),
  maxEntries: Number(process.env.AF_LIB_QUOTA_ENTRIES ?? 500),
});
toolchain.librariesDirs = [...baseLibraryDirs, importedLibrariesDir];

/** 本机自带库始终可用；导入库只有 featured 后才进入公共编译注册表。 */
const loadPublishedLibraries = () => {
  const registry = LibraryRegistry.fromDirectories(baseLibraryDirs);
  for (const entry of libraryStore.list()) {
    if (entry.curation !== 'featured') continue;
    const library = loadLibrary(join(importedLibrariesDir, entry.dir));
    if (library) registry.add(library);
  }
  return registry;
};

let libraries = loadPublishedLibraries();
const rebuildLibraries = () => {
  libraries = loadPublishedLibraries();
  service.setLibraries(libraries);
  return libraries;
};

const boardReady = (fqbn: string): boolean => {
  const board = boards.get(fqbn);
  if (!board) return false;
  return board.arch === 'avr' ? Boolean(toolchain.avr)
    : board.arch === 'esp32' ? Boolean(toolchain.esp32 && esp32BoardSupported(toolchain.esp32, board))
      : false;
};

const readyBoards = () => boards.list().filter((board) => boardReady(board.fqbn));

function makeExecutor(): SandboxExecutor {
  switch (process.env.AF_SANDBOX) {
    // 生产默认。nsjail 不在 Debian 稳定版仓库，bubblewrap 在 main 且是 Flatpak 的沙箱底座
    case 'bubblewrap':
      return new BubblewrapExecutor();
    case 'nsjail':
      return new NsjailExecutor({ nsjailPath: process.env.AF_NSJAIL_PATH ?? 'nsjail' });
    default:
      return new LocalExecutor();
  }
}

const executor: SandboxExecutor = makeExecutor();

/**
 * 沙箱启动自检 —— **真的跑一遍，不相信声明**。
 *
 * 只检查 `isolationLevel` 是不够的：那是执行器的静态声明。
 * 实测踩过的坑：容器里服务正常启动、/healthz 一片绿、声明 namespace 隔离，
 * 但 bubblewrap 因为 Docker 默认 seccomp 根本创建不了命名空间，
 * 直到第一个用户点编译才暴露。生产表现就是「健康检查全绿，所有编译失败」。
 */
const selfTest = await selfTestSandbox(executor, toolchain.workDir);

if (IS_PRODUCTION && !selfTest.ok) {
  console.error(`\n✗ 生产模式拒绝启动：沙箱自检未通过（执行器 "${executor.name}"）\n`);
  console.error(formatSelfTest(selfTest));
  if (executor.name === 'bubblewrap') {
    console.error(
      `\n  若失败原因是「无法创建命名空间」，容器需要放宽 seccomp：\n` +
      `      docker run --security-opt seccomp=unconfined ...\n` +
      `  实测不需要 --cap-add SYS_ADMIN，也不需要 --privileged。\n`,
    );
  }
  process.exit(1);
}

const configuredCompilerBundleId = process.env.AF_COMPILER_BUNDLE_ID?.trim();
const actionCacheTtlSeconds = positiveInt('AF_ACTION_CACHE_TTL_SECONDS', 7 * 24 * 60 * 60);
const actionCache = new FileActionCache(join(toolchain.cacheDir, 'actions'), {
  ttlMs: actionCacheTtlSeconds * 1_000,
  maxEntries: positiveInt('AF_LOCAL_ACTION_CACHE_MAX_ENTRIES', 100_000),
  maxTotalBytes: positiveInt('AF_LOCAL_ACTION_CACHE_MAX_BYTES', 20 * 1024 * 1024 * 1024),
  pruneIntervalMs: positiveInt('AF_LOCAL_ACTION_CACHE_PRUNE_INTERVAL_MS', 5 * 60 * 1_000),
});
const packCasLimits = {
  ttlMs: positiveInt('AF_PACK_CAS_TTL_SECONDS', 7 * 24 * 60 * 60) * 1_000,
  maxEntries: positiveInt('AF_PACK_CAS_MAX_ENTRIES', 250_000),
  maxTotalBytes: positiveInt('AF_PACK_CAS_MAX_BYTES', 10 * 1024 * 1024 * 1024),
  pruneIntervalMs: positiveInt('AF_PACK_CAS_PRUNE_INTERVAL_MS', 5 * 60 * 1_000),
};
const service = new CompileService({
  boards,
  toolchain,
  executor,
  libraries,
  actionCache,
  packCasLimits,
  ...(configuredCompilerBundleId ? { compilerBundleId: configuredCompilerBundleId } : {}),
  ...(developmentToolchainIdentityHint ? { toolchainIdentityHint: developmentToolchainIdentityHint } : {}),
  platformManifests,
});
const maxConcurrent = positiveInt('AF_MAX_CONCURRENT', Math.max(1, Math.min(4, Number(process.env.UV_THREADPOOL_SIZE ?? 2))));
const esp32Slots = positiveInt('AF_ESP32_SLOTS', maxConcurrent);
const jobs = new JobManager(service, {
  maxConcurrent,
  maxQueued: positiveInt('AF_MAX_QUEUED', 64),
  maxRetainedJobs: positiveInt('AF_MAX_RETAINED_JOBS', 256),
  maxRetainedBytes: positiveInt('AF_MAX_RETAINED_BYTES', 128 * 1024 * 1024),
  maxEventBytes: positiveInt('AF_MAX_JOB_EVENT_BYTES', 8 * 1024 * 1024),
  estimateSlots: (req) => boards.get(req.board)?.arch === 'esp32' ? esp32Slots : 1,
});
const compileRateLimiter = IS_PRODUCTION
  ? new FixedWindowRateLimiter({
      windowMs: positiveInt('AF_RATE_WINDOW_MS', 60_000),
      globalLimit: positiveInt('AF_COMPILE_GLOBAL_RATE', 600),
      keyLimit: positiveInt('AF_COMPILE_CLIENT_RATE', 120),
      maxKeys: positiveInt('AF_RATE_MAX_CLIENTS', 20_000),
    })
  : null;
const maxSseConnections = positiveInt('AF_MAX_SSE_CONNECTIONS', IS_PRODUCTION ? 1_000 : 10_000);
const maxSsePerJob = positiveInt('AF_MAX_SSE_PER_JOB', 2);
const sseHeartbeatMs = positiveInt('AF_SSE_HEARTBEAT_MS', 15_000);
const maxSseBufferedBytes = positiveInt('AF_MAX_SSE_BUFFERED_BYTES', 16 * 1024 * 1024);
let sseConnections = 0;

const app = Fastify({
  logger: IS_PRODUCTION ? { level: process.env.AF_LOG_LEVEL ?? 'info' } : false,
  bodyLimit: MAX_COMPILE_REQUEST_BYTES + 64 * 1024,
  trustProxy: process.env.AF_TRUST_PROXY === '1',
});
registerRetiredStaticPathGuard(app);
const corsOrigins = (process.env.AF_CORS_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
await app.register(cors, {
  origin: IS_PRODUCTION ? (corsOrigins.length ? corsOrigins : false) : true,
  methods: API_CORS_METHODS,
});
const publicRoot = join(REPO_ROOT, 'packages', 'web', 'public');
await app.register(fastifyStatic, { root: publicRoot, setHeaders: setStaticHeaders(publicRoot) });

function requireAdmin(req: FastifyRequest, reply: FastifyReply): void {
  if (!ADMIN_TOKEN) {
    void reply.code(503).send({ error: 'admin_disabled', message: '库管理接口未配置' });
    return;
  }
  const authorization = req.headers.authorization ?? '';
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(ADMIN_TOKEN);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    reply.header('WWW-Authenticate', 'Bearer');
    void reply.code(401).send({ error: 'unauthorized', message: '需要管理员令牌' });
  }
}

// ---------------------------------------------------------------------------
// GET /v1/boards —— 前端渲染引脚下拉框和编译选项的数据源
// ---------------------------------------------------------------------------

app.get('/v1/boards', async () => boardAvailabilityResponse(boards, boardReady));

// ---------------------------------------------------------------------------
// GET /v1/libraries
//
// `blocksMeta` 是给图形化平台的**透传字段** —— 它靠这份元数据自动生成积木
// （block 定义 + 代码生成器 + toolbox 条目），底座只存储和转发，不解释内容。
// 这样「新增一个白名单库 = 写一份 JSON，积木自动出现」，
// 而不是每个库手写几十个生成器函数。
// ---------------------------------------------------------------------------

app.get<{ Querystring: { arch?: string } }>('/v1/libraries', async (req) => {
  const arch = req.query.arch;
  const all = libraries.list();
  const filtered = arch ? all.filter((l) => libraries.supportsArch(l, arch)) : all;

  return {
    libraries: filtered
      .map((l) => ({
        name: l.manifest.name,
        version: l.manifest.version,
        architectures: l.manifest.architectures,
        depends: l.manifest.depends,
        category: l.manifest.category ?? null,
        url: l.manifest.url ?? null,
        /** 声明的主头文件，前端可用来给"手写代码"模式做补全提示 */
        includes: l.manifest.includes,
        /** 纯头文件库不产出 .a */
        headerOnly: l.sources.length === 0,
        /** 图形化平台的积木元数据。库系统采集后填入，底座原样透传 */
        blocksMeta: publicBlocksMetadata(l.blocksMeta),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
});

// ---------------------------------------------------------------------------
// POST /v1/libraries/import —— 从 GitHub 导入库
//
// 安全模型分三层，各司其职：
//   · 服务器安全      → 沙箱（已实测 11/11 拦截），与本流程无关
//   · 编译期 RCE      → 硬闸门（platform.txt 等），确定性判断
//   · "这库好不好"     → 人工策展，系统只产出报告，不替人做判断
// ---------------------------------------------------------------------------

/**
 * 试编译：拿库的主头文件拼一个最小 sketch 去编。
 * 编不过就直接拒，省掉人工时间；编得过则顺带把该库的 `.a`
 * 写进 L1 缓存 —— **审核动作本身就是预编译动作**。
 */
async function trialCompile(libraryDir: string): Promise<TrialCompileResult[]> {
  const lib = loadLibrary(libraryDir);
  if (!lib) return [{ board: '-', ok: false, output: '无法读取库' }];

  // 优先用清单里声明的主头文件，其次挑一个同名的，最后随便取一个
  const header =
    lib.manifest.includes[0] ??
    lib.headers.find((h) => h.replace(/\.[^.]+$/, '') === lib.manifest.name.replace(/\s+/g, '_')) ??
    lib.headers[0];
  if (!header) return [{ board: '-', ok: false, output: '库里没有可引用的头文件' }];

  const source = `#include <${header}>\nvoid setup() {}\nvoid loop() {}\n`;

  // 临时把库挂进索引，让本次编译能解析到它
  const probeRegistry = loadPublishedLibraries();
  probeRegistry.add(lib);
  // 使用独立服务实例，避免试编译期间替换公共注册表造成并发请求串库。
  const probeService = new CompileService({
    boards,
    toolchain,
    executor,
    libraries: probeRegistry,
    platformManifests,
  });

  const results: TrialCompileResult[] = [];
  for (const board of readyBoards()) {
    if (!probeRegistry.supportsArch(lib, board.arch)) continue;
    const compileRequest: CompileRequest = {
      board: board.fqbn,
      files: [{ name: 'probe.ino', content: source }],
      libraries: [{ name: lib.manifest.name }],
    };
    const r = await jobs.withCapacity(compileRequest, async () => (
      probeService.compileBuildIR(await probeService.planActionGraph(compileRequest))
    ));
    results.push({
      board: board.fqbn,
      ok: r.status === 'success',
      ...(r.status === 'error' ? { output: r.message.slice(0, 2000) } : {}),
    });
  }
  return results;
}

app.post<{ Body: { repoUrl?: string; ref?: string } }>(
  '/v1/libraries/import',
  { preHandler: requireAdmin },
  async (req, reply) => {
  const { repoUrl, ref } = req.body ?? {};
  if (!repoUrl || typeof repoUrl !== 'string') {
    return reply.code(400).send({ error: 'invalid_request', message: '需要 repoUrl' });
  }

  const result = await importLibrary(repoUrl, typeof ref === 'string' && ref ? ref : 'HEAD', {
    store: libraryStore,
    trialCompile,
    ...(process.env.GITHUB_TOKEN ? { githubToken: process.env.GITHUB_TOKEN } : {}),
    workDir: toolchain.workDir,
  });

  const code = result.status === 'accepted' ? 200 : result.status === 'rejected' ? 422 : 502;
  return reply.code(code).send(result);
  },
);

/** 已导入库清单 + 人工策展状态 */
app.get('/v1/libraries/imported', { preHandler: requireAdmin }, async () => ({
  quotaBytesUsed: libraryStore.totalBytes(),
  entries: libraryStore.list().sort((a, b) => b.importedAt - a.importedAt).map((entry) => ({
    ...entry,
    blocksMeta: readBlocksMetadata(join(importedLibrariesDir, entry.dir)),
  })),
}));

function importedLibrary(dir: string) {
  const entry = libraryStore.getByDir(dir);
  if (!entry) return null;
  const root = join(importedLibrariesDir, entry.dir);
  const library = loadLibrary(root);
  return library ? { entry, root, library } : null;
}

app.post<{ Params: { dir: string } }>(
  '/v1/libraries/imported/:dir/blocks/draft',
  { preHandler: requireAdmin },
  async (req, reply) => {
    const selected = importedLibrary(req.params.dir);
    if (!selected) return reply.code(404).send({ error: 'not_found', message: '库条目不存在' });
    const metadata = collectLibraryBlocks(selected.library);
    writeBlocksMetadata(selected.root, metadata);
    rebuildLibraries();
    return { blocksMeta: metadata };
  },
);

app.put<{ Params: { dir: string }; Body: unknown }>(
  '/v1/libraries/imported/:dir/blocks',
  { preHandler: requireAdmin },
  async (req, reply) => {
    const selected = importedLibrary(req.params.dir);
    if (!selected) return reply.code(404).send({ error: 'not_found', message: '库条目不存在' });
    let metadata;
    try { metadata = parseBlocksMetadata(req.body); }
    catch (error) {
      return reply.code(400).send({ error: 'invalid_blocks_meta', message: (error as Error).message });
    }
    if (metadata.review.status !== 'draft') {
      return reply.code(400).send({ error: 'invalid_blocks_meta', message: '编辑后的元数据必须先保存为 draft' });
    }
    if (metadata.library.name !== selected.library.manifest.name
      || metadata.library.version !== selected.library.manifest.version
      || metadata.library.sourceSha256 !== libraryBlocksSourceSha256(selected.library)) {
      return reply.code(409).send({ error: 'stale_blocks_meta', message: '元数据与当前库源码身份不一致，请重新采集' });
    }
    writeBlocksMetadata(selected.root, metadata);
    rebuildLibraries();
    return { blocksMeta: metadata };
  },
);

app.post<{
  Params: { dir: string };
  Body: { status?: string; reviewer?: string; notes?: string };
}>(
  '/v1/libraries/imported/:dir/blocks/review',
  { preHandler: requireAdmin },
  async (req, reply) => {
    const selected = importedLibrary(req.params.dir);
    if (!selected) return reply.code(404).send({ error: 'not_found', message: '库条目不存在' });
    const status = req.body?.status;
    const reviewer = req.body?.reviewer?.trim() ?? '';
    if ((status !== 'approved' && status !== 'rejected') || !reviewer || reviewer.length > 128
      || (req.body?.notes?.length ?? 0) > 4_096) {
      return reply.code(400).send({ error: 'invalid_request', message: '需要 approved/rejected 状态和 reviewer' });
    }
    const current = readBlocksMetadata(selected.root, true);
    if (!current) return reply.code(404).send({ error: 'not_found', message: '尚未采集 blocks.json' });
    if (current.library.sourceSha256 !== libraryBlocksSourceSha256(selected.library)) {
      return reply.code(409).send({ error: 'stale_blocks_meta', message: '库源码已变化，请重新采集' });
    }
    const metadata = reviewBlocksMetadata(current, status, reviewer, req.body?.notes);
    writeBlocksMetadata(selected.root, metadata);
    rebuildLibraries();
    return { blocksMeta: metadata };
  },
);

/**
 * 人工策展：标记进精选池 / 隐藏。
 * featured 的条目在配额淘汰时永不被清 —— 否则图形化平台的积木会凭空消失。
 */
app.patch<{ Params: { dir: string }; Body: { curation?: string } }>(
  '/v1/libraries/imported/:dir',
  { preHandler: requireAdmin },
  async (req, reply) => {
    const c = req.body?.curation;
    if (c !== 'unreviewed' && c !== 'featured' && c !== 'hidden') {
      return reply.code(400).send({ error: 'invalid_request', message: 'curation 必须是 unreviewed / featured / hidden' });
    }
    if (!libraryStore.setCuration(req.params.dir, c)) {
      return reply.code(404).send({ error: 'not_found', message: '条目不存在' });
    }
    rebuildLibraries();
    return { ok: true };
  },
);

app.delete<{ Params: { dir: string } }>(
  '/v1/libraries/imported/:dir',
  { preHandler: requireAdmin },
  async (req, reply) => {
  if (!libraryStore.remove(req.params.dir)) {
    return reply.code(404).send({ error: 'not_found', message: '条目不存在' });
  }
  rebuildLibraries();
  return { ok: true };
  },
);

// ---------------------------------------------------------------------------
// POST /v1/compile —— 202 + job_id，事件走 SSE
// ---------------------------------------------------------------------------

app.post('/v1/compile', async (req, reply) => {
  const admission = compileRateLimiter?.take(req.ip);
  if (admission && !admission.allowed) {
    reply.header('Retry-After', String(Math.max(1, Math.ceil(admission.retryAfterMs / 1_000))));
    return reply.code(429).send({
      error: 'rate_limited',
      message: admission.scope === 'client' ? '请求过于频繁，请稍后重试' : '平台当前请求过多，请稍后重试',
    });
  }
  const validation = validateCompileRequest(req.body);
  if (!validation.ok) {
    return reply.code(400).send({ error: 'invalid_request', message: validation.message });
  }
  const body = validation.request;
  const board = typeof body.board === 'string' ? boards.get(body.board) : undefined;
  if (board) {
    const unsupportedMessage = boardCompileOptionError(board, body.options);
    if (unsupportedMessage) {
      return reply.code(400).send({ error: 'invalid_request', message: unsupportedMessage });
    }
  }
  if (typeof body.board === 'string' && boards.get(body.board) && !boardReady(body.board)) {
    return reply.code(503).send({
      error: 'toolchain_unavailable',
      message: `板子 ${body.board} 的编译工具链当前不可用`,
    });
  }
  try {
    const job = jobs.submit(body);
    reply.header('Cache-Control', 'no-store');
    return reply.code(202).send({
      jobId: job.id,
      stream: prefixPublicPath(publicBasePath, `/v1/compile/${job.id}/events`),
      cancellation: {
        requestId: job.cancellation.requestId,
        url: prefixPublicPath(
          publicBasePath,
          `/v1/compile/${job.id}/requests/${job.cancellation.requestId}`,
        ),
        token: job.cancellation.token,
      },
    });
  } catch (err) {
    if (err instanceof QueueFullError) {
      // 背压：过载时明确拒绝，不把请求无限堆进内存
      return reply.code(429).send({ error: 'queue_full', message: err.message });
    }
    if (err instanceof QueueClosedError) {
      reply.header('Retry-After', '5');
      return reply.code(503).send({ error: 'draining', message: err.message });
    }
    throw err;
  }
});

// GET /v1/compile/:jobId —— 与分布式 gateway 同形，供 SSE 断流/刷新后的轮询恢复。
app.get<{ Params: { jobId: string } }>('/v1/compile/:jobId', async (req, reply) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return reply.code(404).send({ error: 'not_found', message: '作业不存在或已过期' });

  return {
    jobId: job.id,
    state: job.state,
    ...((job.state === 'completed' || job.state === 'cancelled') && job.result ? { result: job.result } : {}),
    ...(job.state === 'failed' ? { error: 'worker_failed' } : {}),
  };
});

app.delete<{ Params: { jobId: string; requestId: string } }>(
  '/v1/compile/:jobId/requests/:requestId',
  async (req, reply) => {
    const rawToken = req.headers['x-af-cancel-token'];
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) {
      return reply.code(404).send({ error: 'not_found', message: '取消句柄不存在或已过期' });
    }
    const result = jobs.cancel(req.params.jobId, req.params.requestId, token);
    if (!result) {
      return reply.code(404).send({ error: 'not_found', message: '取消句柄不存在或已过期' });
    }
    reply.header('Cache-Control', 'no-store');
    return result;
  },
);

// ---------------------------------------------------------------------------
// GET /v1/compile/:jobId/events —— SSE
// 诊断是边编译边推的独立事件，前端可以在编译还没结束时就把红波浪线画上
// ---------------------------------------------------------------------------

app.get<{ Params: { jobId: string } }>('/v1/compile/:jobId/events', (req, reply) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    void reply.code(404).send({ error: 'not_found', message: '作业不存在或已过期' });
    return;
  }
  if (sseConnections >= maxSseConnections || job.subscribers.size >= maxSsePerJob) {
    reply.header('Retry-After', '2');
    void reply.code(429).send({ error: 'stream_limit', message: '事件流连接过多，请稍后重连' });
    return;
  }

  sseConnections++;
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 关掉 nginx 缓冲，否则 SSE 会被攒起来一次性吐出
  });

  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let unsubscribe = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    sseConnections--;
    if (!reply.raw.writableEnded) reply.raw.end();
  };

  const send = (e: { event: string }) => {
    if (closed || reply.raw.destroyed) return close();
    const frame = `event: ${e.event}\ndata: ${JSON.stringify(e)}\n\n`;
    if (reply.raw.writableLength + Buffer.byteLength(frame, 'utf8') > maxSseBufferedBytes) {
      return close();
    }
    reply.raw.write(frame);
    if (e.event === 'done') close();
  };

  unsubscribe = jobs.subscribe(job, send);
  // 订阅时作业可能已经结束（缓冲已回放完），直接收尾
  if (closed || job.done) {
    close();
  } else {
    heartbeat = setInterval(() => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return close();
      const frame = `: heartbeat ${Date.now()}\n\n`;
      if (reply.raw.writableLength + Buffer.byteLength(frame, 'utf8') > maxSseBufferedBytes) return close();
      reply.raw.write(frame);
    }, sseHeartbeatMs);
    heartbeat.unref();
  }

  req.raw.once('close', close);
});

// ---------------------------------------------------------------------------

app.get('/healthz', async () => ({
  // 沙箱自检没过时不能报 ok —— 否则健康检查会掩盖「所有编译都失败」
  ok: (selfTest.ok || !IS_PRODUCTION) && (!IS_PRODUCTION || readyBoards().length > 0),
  sandbox: {
    name: executor.name,
    isolation: executor.isolationLevel,
    /** 声明之外的**实测**结果。二者不一致正是最危险的状态 */
    verified: selfTest.ok,
    checks: selfTest.checks,
  },
  toolchains: {
    avr: Boolean(toolchain.avr),
    esp32: Boolean(toolchain.esp32),
    boards: readyBoards().map((board) => board.fqbn),
  },
  sseConnections,
  maxSseConnections,
  ...jobs.stats,
}));

const shutdownTimeoutMs = positiveInt('AF_SHUTDOWN_TIMEOUT_MS', 45_000);
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  jobs.stopAccepting();
  app.log.info({ signal }, 'stopping compile admission and draining jobs');

  const closePromise = app.close();
  const idle = await jobs.waitForIdle(shutdownTimeoutMs);
  if (!idle) {
    app.log.error({ signal, shutdownTimeoutMs, stats: jobs.stats }, 'job drain timed out');
    process.exitCode = 1;
    return;
  }
  await closePromise;
  app.log.info({ signal }, 'shutdown complete');
};

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

await app.listen({ port: PORT, host: HOST });

console.log(`
╭─ sketchforge 编译底座 ────────────────────────────────
│ 监听    http://${HOST}:${PORT}
│ 沙箱    ${executor.name} (${executor.isolationLevel})  自检: ${
  selfTest.skipped ? '⚠ 未隔离，仅限开发' : selfTest.ok ? '✓ 通过' : '✗ 未通过'
}${selfTest.skipped || selfTest.ok ? '' : '\n' + formatSelfTest(selfTest).replace(/^/gm, '│  ')}
│ 板子    ${boards.list().map((b) => b.fqbn).join(', ') || '（无）'}
│ 库      ${libraries.list().length} 个
│ 工具链  ${describeToolchain(toolchain).replace(/\n\s+/g, '\n│         ')}
╰───────────────────────────────────────────────────────
`);
