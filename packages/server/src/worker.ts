import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Queue, Worker, type Job } from 'bullmq';
import {
  BoardRegistry,
  BubblewrapExecutor,
  CompileService,
  FileActionCache,
  LibraryRegistry,
  LibraryStore,
  LocalExecutor,
  NsjailExecutor,
  detectLocalToolchain,
  esp32BoardSupported,
  formatSelfTest,
  selfTestSandbox,
  publicBlocksMetadata,
  readBlocksMetadata,
  validateCompileRequest,
  type CompileEvent,
  type CompileResult,
  type Diagnostic,
  type SandboxExecutor,
} from '@arduinofast/core';
import { createArtifactStore } from './artifact-store.js';
import { CapabilityHeartbeat } from './capabilities.js';
import { createCompileRedisNamespace } from './compile-namespace.js';
import {
  loadCompilerRuntimeConfiguration,
  workerHostRuntimeIdentity,
} from './compiler-runtime-release.js';
import {
  CompileCapacityTimeoutError,
  RedisCompileCapacity,
  compileHostCapacityKey,
} from './compile-lease.js';
import { JobDeadline, JobDeadlineExecutor } from './deadline-executor.js';
import { RedisCompileEventStore } from './distributed-events.js';
import {
  WORKER_POOLS,
  bullQueueIdentityForNamespace,
  compileRequestByteLedgerKey,
  retainedCompileJobData,
  resolveCompileJobDeadlineAt,
  workerPoolForBoard,
  type CompileJobData,
  type WorkerPool,
} from './distributed-queue.js';
import { createRedisConnection, verifyRedis } from './redis.js';
import { RedisActionCache, TieredActionCache } from './shared-action-cache.js';
import { loadPublishedPlatformManifests } from './platform-manifests.js';
import { RedisCompileCancellationStore } from './compile-cancellation.js';
import { WorkerLifecycle } from './worker-lifecycle.js';
import { CompileTerminalCoordinator, RedisCompileQueueLock } from './queue-terminal.js';
import { workerRuntimeCacheDirectory } from './worker-runtime-cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function configuredPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer when configured`);
  }
  return value;
}

interface HostCapacityConfig {
  hostId: string;
  capacity: number;
  waitMs: number;
}

function hostCapacityConfig(jobTimeoutMs: number): HostCapacityConfig | null {
  const rawHostId = process.env.AF_WORKER_HOST_ID;
  const hostId = rawHostId?.trim();
  if (rawHostId !== undefined && !hostId) {
    throw new Error('AF_WORKER_HOST_ID cannot be empty when configured');
  }
  const capacity = configuredPositiveInt('AF_HOST_COMPILE_CAPACITY');
  if (!hostId && capacity === undefined) return null;
  if (!hostId || capacity === undefined) {
    throw new Error('AF_WORKER_HOST_ID and AF_HOST_COMPILE_CAPACITY must be configured together');
  }
  return {
    hostId,
    capacity,
    waitMs: configuredPositiveInt('AF_HOST_COMPILE_CAPACITY_WAIT_MS') ?? jobTimeoutMs + 60_000,
  };
}

function workerPoolFromEnv(): WorkerPool {
  const value = process.env.AF_WORKER_POOL;
  if (WORKER_POOLS.includes(value as WorkerPool)) return value as WorkerPool;
  throw new Error(`AF_WORKER_POOL must be one of: ${WORKER_POOLS.join(', ')}`);
}

function makeExecutor(): SandboxExecutor {
  switch (process.env.AF_SANDBOX) {
    case 'bubblewrap': return new BubblewrapExecutor();
    case 'nsjail': return new NsjailExecutor({ nsjailPath: process.env.AF_NSJAIL_PATH ?? 'nsjail' });
    default: return new LocalExecutor();
  }
}

function compactDiagnostic(diagnostic: Diagnostic): Diagnostic {
  return {
    ...diagnostic,
    message: diagnostic.message.slice(0, 4_000),
    ...(diagnostic.raw ? { raw: diagnostic.raw.slice(0, 4_000) } : {}),
  };
}

function compactResult(result: CompileResult, maxBytes: number): CompileResult {
  const base = {
    ...result,
    ...(result.status === 'error' ? { message: result.message.slice(0, 8_000) } : {}),
    diagnostics: [] as Diagnostic[],
  } as CompileResult;
  const diagnostics: Diagnostic[] = [];
  let omitted = false;
  for (const diagnostic of result.diagnostics) {
    const next = compactDiagnostic(diagnostic);
    const candidate = { ...base, diagnostics: [...diagnostics, next] };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maxBytes) {
      omitted = true;
      break;
    }
    diagnostics.push(next);
  }
  if (omitted && diagnostics.length > 0) {
    diagnostics.push({
      severity: 'info',
      file: diagnostics[0]!.file,
      line: 1,
      message: '诊断数量过多，事件流仅保留前面部分',
    });
  }
  return { ...base, diagnostics } as CompileResult;
}

function cancelledResult(): CompileResult {
  return {
    status: 'error',
    reason: 'cancelled',
    message: 'compile was cancelled',
    diagnostics: [],
    timings: {},
  };
}

function timeoutResult(): CompileResult {
  return {
    status: 'error',
    reason: 'timeout',
    message: 'compile job wall-clock deadline exceeded',
    diagnostics: [],
    timings: {},
  };
}

const pool = workerPoolFromEnv();
const bundleId = process.env.AF_COMPILER_BUNDLE_ID ?? 'development';
const queuePrefix = process.env.AF_QUEUE_PREFIX ?? 'arduinofast-compile';
const runtimeConfiguration = loadCompilerRuntimeConfiguration(process.env, bundleId, IS_PRODUCTION);
const hostRuntimeIdentity = workerHostRuntimeIdentity(runtimeConfiguration, pool, process.env);
const compileNamespace = createCompileRedisNamespace(
  queuePrefix,
  bundleId,
  runtimeConfiguration.releaseId,
);
const maxEventBytes = positiveInt('AF_MAX_EVENT_BYTES', 256 * 1024);
const jobTimeoutMs = positiveInt('AF_JOB_WALL_TIMEOUT_MS', pool === 'avr' ? 120_000 : 300_000);
const workerDrainTimeoutMs = positiveInt('AF_WORKER_DRAIN_TIMEOUT_MS', jobTimeoutMs + 30_000);
if (workerDrainTimeoutMs < jobTimeoutMs) {
  throw new Error('AF_WORKER_DRAIN_TIMEOUT_MS must be at least AF_JOB_WALL_TIMEOUT_MS');
}
const resultTtlSeconds = positiveInt('AF_RESULT_TTL_SECONDS', 24 * 60 * 60);
const consumerLeaseTtlSeconds = positiveInt('AF_COMPILE_CONSUMER_TTL_SECONDS', resultTtlSeconds);
const cancellationPollMs = positiveInt('AF_COMPILE_CANCEL_POLL_MS', 500);
const maxConsumersPerJob = positiveInt('AF_MAX_COMPILE_CONSUMERS_PER_JOB', 1_024);
const hostCapacity = hostCapacityConfig(jobTimeoutMs);
const detectedToolchain = detectLocalToolchain();
const runtimeCacheDir = workerRuntimeCacheDirectory(
  detectedToolchain.cacheDir,
  bundleId,
  runtimeConfiguration.releaseId,
  pool,
  hostRuntimeIdentity,
);
const toolchain = { ...detectedToolchain, cacheDir: runtimeCacheDir };
const boards = BoardRegistry.fromDirectory(join(REPO_ROOT, 'boards'));
const platformManifests = pool === 'avr'
  ? []
  : loadPublishedPlatformManifests({
      repoRoot: REPO_ROOT,
      ...(process.env.AF_PLATFORM_RELEASE_PATH
        ? { releasePath: process.env.AF_PLATFORM_RELEASE_PATH }
        : {}),
    });
const libraryStore = new LibraryStore(
  process.env.AF_LIBRARY_STORE_DIR ?? join(REPO_ROOT, 'var', 'library-store'),
);
const loadLibraries = () => {
  libraryStore.reload();
  return LibraryRegistry.fromDirectories([
    ...toolchain.librariesDirs,
    ...libraryStore.libraryDirs(),
  ]);
};
const libraries = loadLibraries();
const baseExecutor = makeExecutor();
const executor = new JobDeadlineExecutor(baseExecutor);
const selfTest = await selfTestSandbox(baseExecutor, toolchain.workDir);

if (IS_PRODUCTION && !selfTest.ok) {
  throw new Error(`worker sandbox self-test failed:\n${formatSelfTest(selfTest)}`);
}

const readyBoards = boards.list().filter((board) => {
  if (workerPoolForBoard(board) !== pool) return false;
  if (board.arch === 'avr') return Boolean(toolchain.avr);
  return Boolean(toolchain.esp32 && esp32BoardSupported(toolchain.esp32, board));
});
if (readyBoards.length === 0) throw new Error(`worker pool ${pool} has no usable board toolchain`);

const artifacts = createArtifactStore({
  rootDir: process.env.AF_ARTIFACT_DIR ?? join(REPO_ROOT, 'var', 'artifacts'),
  maxArtifactBytes: positiveInt('AF_MAX_ARTIFACT_BYTES', 32 * 1024 * 1024),
  ttlMs: positiveInt('AF_ARTIFACT_TTL_MS', 7 * 24 * 60 * 60 * 1_000),
  maxEntries: positiveInt('AF_ARTIFACT_MAX_ENTRIES', 20_000),
  maxTotalBytes: positiveInt('AF_ARTIFACT_MAX_BYTES', 4 * 1024 * 1024 * 1024),
});
const redis = createRedisConnection('worker');
// Worker-side event/capability writes may legitimately wait behind a busy
// Redis instance. Keep the gateway's short HTTP dependency timeout out of
// this data path so a slow event append cannot turn a successful compile into
// an infrastructure failure.
const dataRedis = createRedisConnection('events');
await Promise.all([verifyRedis(redis), verifyRedis(dataRedis)]);
const actionCacheTtlSeconds = positiveInt('AF_ACTION_CACHE_TTL_SECONDS', 7 * 24 * 60 * 60);
const actionCache = new TieredActionCache(
  new FileActionCache(join(toolchain.cacheDir, 'actions'), {
    ttlMs: actionCacheTtlSeconds * 1_000,
    maxEntries: positiveInt('AF_LOCAL_ACTION_CACHE_MAX_ENTRIES', 100_000),
    maxTotalBytes: positiveInt('AF_LOCAL_ACTION_CACHE_MAX_BYTES', 20 * 1024 * 1024 * 1024),
    pruneIntervalMs: positiveInt('AF_LOCAL_ACTION_CACHE_PRUNE_INTERVAL_MS', 5 * 60 * 1_000),
  }),
  new RedisActionCache(dataRedis, {
    namespace: `${process.env.AF_ACTION_CACHE_PREFIX ?? 'arduinofast-action-cache'}:${bundleId}`
      .replace(/[^A-Za-z0-9:_./-]/g, '_')
      + `:r${compileNamespace.releaseHash}`,
    ttlSeconds: actionCacheTtlSeconds,
    maxEntryBytes: positiveInt('AF_ACTION_CACHE_MAX_ENTRY_BYTES', 4 * 1024 * 1024),
  }),
);
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
  compilerBundleId: bundleId,
  actionCache,
  packCasLimits,
  platformManifests,
});
const eventStore = new RedisCompileEventStore(dataRedis, {
  namespace: compileNamespace,
  ttlSeconds: resultTtlSeconds,
  maxEvents: positiveInt('AF_MAX_JOB_EVENTS', 256),
  maxEventBytes,
});
const workerQueue = bullQueueIdentityForNamespace(compileNamespace, pool);
const terminalReader = new Queue<CompileJobData, CompileResult, 'compile'>(workerQueue.name, {
  connection: redis,
  prefix: workerQueue.prefix,
});
const terminalCoordinator = new CompileTerminalCoordinator(
  new RedisCompileQueueLock(dataRedis, {
    namespace: compileNamespace,
    ttlMs: positiveInt('AF_QUEUE_ADMISSION_LOCK_TTL_MS', 15_000),
    waitMs: positiveInt('AF_QUEUE_ADMISSION_WAIT_MS', 2_000),
  }),
  eventStore,
  async (jobId) => (await terminalReader.getJob(jobId)) ?? null,
  (error, jobId) => {
    console.error(`failed to notify terminal event for ${jobId}: ${String((error as Error).message)}`);
  },
);
const cancellations = new RedisCompileCancellationStore(dataRedis, {
  namespace: compileNamespace,
  leaseTtlMs: consumerLeaseTtlSeconds * 1_000,
  maxConsumersPerJob,
});

async function releaseCompileRequestStorage(
  job: Job<CompileJobData, CompileResult, 'compile'>,
): Promise<void> {
  if (!job.id) return;
  try {
    if (job.data.request) await job.updateData(retainedCompileJobData(job.data));
    await dataRedis.hdel(compileRequestByteLedgerKey(compileNamespace), job.id);
  } catch (error) {
    console.error(`failed to release compile request storage for ${job.id}: ${String((error as Error).message)}`);
  }
}
// Do not default this on: a generic host name would throttle same-pool workers
// on separate hosts. A deployment that shares CPU/RAM between worker pools
// opts in with an explicit, unique host ID and a measured total capacity.
const sharedHostCapacity = hostCapacity
  ? new RedisCompileCapacity(
      dataRedis,
      compileHostCapacityKey(
        process.env.AF_COMPILE_CAPACITY_PREFIX ?? 'af:compile-capacity',
        hostCapacity.hostId,
      ),
      {
        capacity: hostCapacity.capacity,
        ttlMs: jobTimeoutMs + 60_000,
        maxWaitMs: hostCapacity.waitMs,
      },
    )
  : null;

const heartbeat = new CapabilityHeartbeat(dataRedis, () => ({
  pool,
  boards: readyBoards.map((board) => board.fqbn),
  bundleId,
  compileReleaseId: runtimeConfiguration.releaseId,
  runtimeTrust: runtimeConfiguration.trust,
  hostRuntimeIdentity,
  capacity: 1,
  libraries: loadLibraries().list().map((library) => ({
    name: library.manifest.name,
    version: library.manifest.version,
    architectures: library.manifest.architectures,
    depends: library.manifest.depends,
    category: library.manifest.category ?? null,
    url: library.manifest.url ?? null,
    includes: library.manifest.includes,
    headerOnly: library.sources.length === 0,
    blocksMeta: publicBlocksMetadata(readBlocksMetadata(library.rootDir)),
  })),
}), { namespace: compileNamespace, runtimeConfiguration });
await heartbeat.start();

const worker = new Worker<CompileJobData, CompileResult, 'compile'>(
  workerQueue.name,
  async (job, _token, workerSignal) => {
    if (job.data.pool !== pool
      || job.data.bundleId !== bundleId
      || job.data.compileReleaseId !== runtimeConfiguration.releaseId
      || job.data.hostRuntimeIdentity !== hostRuntimeIdentity) {
      throw new Error('compile job routed to an incompatible worker runtime');
    }
    await terminalCoordinator.prepareInFlight(job.id!);
    const validation = validateCompileRequest(job.data.request);
    if (!validation.ok) {
      throw new Error(`queued compile request failed validation: ${validation.message}`);
    }
    const deadlineAt = resolveCompileJobDeadlineAt(job.data, jobTimeoutMs);
    const lifetime = new JobDeadline(deadlineAt, workerSignal);
    const interruptedResult = (): CompileResult => (
      lifetime.timedOut ? timeoutResult() : cancelledResult()
    );
    executor.beginAt(deadlineAt);

    let eventTail = Promise.resolve();
    let terminalStarted = false;
    const publish = (event: CompileEvent): void => {
      if (event.event === 'done' || lifetime.signal.aborted || terminalStarted) return;
      const bounded: CompileEvent = event.event === 'diagnostic'
        ? { event: 'diagnostic', diagnostic: compactDiagnostic(event.diagnostic) }
        : { ...event, ...(event.detail ? { detail: event.detail.slice(0, 2_000) } : {}) };
      eventTail = eventTail.then(async () => {
        if (terminalStarted) return;
        const envelope = await eventStore.append(job.id!, bounded);
        if (terminalStarted) return;
        await job.updateProgress(envelope);
      });
    };
    const finishProcessor = (result: CompileResult): CompileResult => {
      terminalStarted = true;
      return result;
    };

    let cancellationCheckRunning = false;
    const checkCancellation = async (): Promise<void> => {
      if (lifetime.signal.aborted || cancellationCheckRunning) return;
      cancellationCheckRunning = true;
      try {
        if (await cancellations.isCancellationRequested(job.id!)) {
          lifetime.abort(new Error('all compile consumers disconnected'));
        }
      } catch {
        // A transient Redis read must not cancel a valid compile. Event writes
        // still provide the authoritative dependency-health signal.
      } finally {
        cancellationCheckRunning = false;
      }
    };
    const compile = async (): Promise<CompileResult> => {
      // Online imports become visible per job. This synchronous refresh is
      // inside the same deadline as planning and execution.
      await lifetime.run(() => service.setLibraries(loadLibraries()));
      const planned = lifetime.signal.aborted
        ? null
        : await lifetime.run(() => service.planActionGraph(validation.request, {
            signal: lifetime.signal,
            deadlineAt,
          }));
      const compiled = !planned || lifetime.signal.aborted
        ? interruptedResult()
        : await lifetime.run(() => service.compileBuildIR(planned, publish, {
            signal: lifetime.signal,
            deadlineAt,
          }));
      await lifetime.run(() => eventTail);
      const externalized = lifetime.signal.aborted
        ? interruptedResult()
        : await lifetime.run(() => artifacts.externalize(compiled));
      const result = await lifetime.run(() => compactResult(
          lifetime.signal.aborted ? interruptedResult() : externalized,
          Math.max(16 * 1024, maxEventBytes - 4 * 1024),
        ));
      return finishProcessor(result);
    };
    let cancellationTimer: ReturnType<typeof setInterval> | undefined;
    try {
      await lifetime.run(checkCancellation);
      cancellationTimer = setInterval(() => { void checkCancellation(); }, cancellationPollMs);
      cancellationTimer.unref();
      return await (sharedHostCapacity ? sharedHostCapacity.run(compile, (waitedMs) => {
        const seconds = Math.floor(waitedMs / 1_000);
        publish({
          event: 'progress',
          stage: 'queued',
          percent: 0,
          detail: seconds === 0
            ? '正在等待同一物理主机释放编译容量'
            : `正在等待同一物理主机释放编译容量（已等待 ${seconds} 秒）`,
        });
      }, lifetime.signal) : compile());
    } catch (error) {
      if (lifetime.signal.aborted) {
        void eventTail.catch(() => { /* BullMQ terminal reconciliation is authoritative */ });
        const result = interruptedResult();
        return finishProcessor(result);
      }
      if (error instanceof CompileCapacityTimeoutError) {
        // This is deliberate admission backpressure, not a worker crash. Mark
        // the BullMQ job completed with a non-reusable result so reconnecting
        // clients receive the truthful outcome instead of "worker exited".
        try { await eventTail; } catch { /* BullMQ terminal reconciliation is authoritative */ }
        const result: CompileResult = {
          status: 'error',
          reason: 'internal',
          message: `当前编译容量繁忙，等待 ${Math.ceil(error.waitedMs / 1_000)} 秒后仍无可用槽位，请稍后重试`,
          diagnostics: [],
          timings: {},
        };
        return finishProcessor(result);
      }
      // Let queued progress writes settle before BullMQ records the failure.
      try { await eventTail; } catch { /* BullMQ terminal reconciliation is authoritative */ }
      throw error;
    } finally {
      if (cancellationTimer !== undefined) clearInterval(cancellationTimer);
      lifetime.dispose();
      executor.end();
    }
  },
  {
    connection: redis,
    prefix: workerQueue.prefix,
    concurrency: 1,
    maxStalledCount: 1,
    // A job can wait for an explicitly configured host token before it starts
    // compiling. Keep BullMQ's lock alive across that bounded wait and the
    // wall-clock compilation deadline.
    lockDuration: Math.max(30_000, jobTimeoutMs + (hostCapacity?.waitMs ?? 0) + 30_000),
  },
);

worker.on('failed', (job, error) => {
  console.error(`compile job ${job?.id ?? 'unknown'} failed: ${error.message}`);
  if (job?.id) {
    void terminalCoordinator.reconcile(job.id, async (current) => {
      await releaseCompileRequestStorage(current as Job<CompileJobData, CompileResult, 'compile'>);
    }).catch((terminalError) => {
      console.error(`failed to reconcile terminal state for ${job.id}: ${String((terminalError as Error).message)}`);
    });
  }
});
worker.on('completed', (job) => {
  void terminalCoordinator.reconcile(job.id!, async (current) => {
    // BullMQ has committed the terminal state, so stripping the request can no
    // longer break stalled-job recovery if this process exits immediately.
    await releaseCompileRequestStorage(current as Job<CompileJobData, CompileResult, 'compile'>);
  }).catch((error) => {
    console.error(`failed to reconcile terminal state for ${job.id}: ${String((error as Error).message)}`);
  });
});
worker.on('error', (error) => {
  console.error(`compile worker error: ${error.message}`);
});
const lifecycle = new WorkerLifecycle({
  worker,
  readiness: heartbeat,
  drainTimeoutMs: workerDrainTimeoutMs,
  onError: (phase, error) => {
    console.error(`worker ${phase} shutdown failed: ${String((error as Error).message)}`);
  },
});
await worker.waitUntilReady();
console.log(
  `arduinofast worker ${pool} ready for ${readyBoards.map((board) => board.fqbn).join(', ')}`
  + (hostCapacity ? `; host ${hostCapacity.hostId} capacity ${hostCapacity.capacity}` : '; local concurrency 1'),
);

let shutdownPromise: Promise<void> | undefined;
function shutdown(signal: string): Promise<void> {
  shutdownPromise ??= shutdownWorker(signal);
  return shutdownPromise;
}

async function shutdownWorker(signal: string): Promise<void> {
  console.log(`stopping worker ${pool} after ${signal}`);
  try {
    const result = await lifecycle.shutdown(signal);
    if (result.forced) {
      process.exitCode = 1;
      console.error(`worker ${pool} drain ${result.reason}; forced close after ${workerDrainTimeoutMs}ms`);
    }
  } catch (error) {
    process.exitCode = 1;
    console.error(`worker ${pool} shutdown failed: ${String((error as Error).message)}`);
  } finally {
    await Promise.allSettled([terminalReader.close(), Promise.resolve(artifacts.close?.())]);
    await Promise.allSettled([redis.quit(), dataRedis.quit()]);
  }
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
