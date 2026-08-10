import type { Redis } from 'ioredis';
import {
  AutoscaleWebhookAdapter,
  decideWorkerReplicas,
  initialAutoscaleState,
  parseAutoscaleState,
  validateAutoscalePolicy,
  type AutoscalePolicy,
  type AutoscaleState,
} from './autoscale.js';
import { listWorkerCapabilities } from './capabilities.js';
import {
  compileRedisKey,
  createCompileRedisNamespace,
  type CompileRedisNamespace,
} from './compile-namespace.js';
import {
  loadCompilerRuntimeConfiguration,
  type CompilerRuntimeConfiguration,
} from './compiler-runtime-release.js';
import { DistributedCompileQueue, WORKER_POOLS, type WorkerPool } from './distributed-queue.js';
import { createRedisConnection, verifyRedis } from './redis.js';

interface AutoscaleServiceConfig {
  bundleId: string;
  namespace: CompileRedisNamespace;
  runtimeConfiguration: CompilerRuntimeConfiguration;
  intervalMs: number;
  stateTtlSeconds: number;
  policies: Record<WorkerPool, AutoscalePolicy>;
  webhook: AutoscaleWebhookAdapter;
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

function policyFor(env: NodeJS.ProcessEnv, pool: WorkerPool): AutoscalePolicy {
  const key = pool.toUpperCase().replaceAll('-', '_');
  const get = (suffix: string): string | undefined => env[`AF_AUTOSCALE_${key}_${suffix}`];
  const hysteresisPercent = nonNegativeInt(get('HYSTERESIS_PERCENT'), 20, `${key} hysteresis`);
  return validateAutoscalePolicy({
    minReplicas: nonNegativeInt(get('MIN_REPLICAS'), 1, `${key} min replicas`),
    maxReplicas: positiveInt(get('MAX_REPLICAS'), pool === 'avr' ? 20 : 10, `${key} max replicas`),
    targetJobsPerReplica: positiveInt(get('TARGET_JOBS_PER_REPLICA'), 2, `${key} target jobs`),
    hysteresis: hysteresisPercent / 100,
    scaleUpCooldownMs: nonNegativeInt(get('SCALE_UP_COOLDOWN_MS'), 15_000, `${key} scale-up cooldown`),
    scaleDownCooldownMs: nonNegativeInt(get('SCALE_DOWN_COOLDOWN_MS'), 300_000, `${key} scale-down cooldown`),
    idleGraceMs: nonNegativeInt(get('IDLE_GRACE_MS'), 600_000, `${key} idle grace`),
    capacityPerReplica: positiveInt(get('CAPACITY_PER_REPLICA'), 1, `${key} capacity`),
  });
}

function loadConfig(env: NodeJS.ProcessEnv): AutoscaleServiceConfig {
  const bundleId = env.AF_COMPILER_BUNDLE_ID?.trim() ?? '';
  const runtimeConfiguration = loadCompilerRuntimeConfiguration(
    env,
    bundleId,
    env.NODE_ENV === 'production',
  );
  const namespace = createCompileRedisNamespace(
    env.AF_QUEUE_PREFIX ?? 'sketchforge-compile',
    bundleId,
    runtimeConfiguration.releaseId,
  );
  const webhookUrl = env.AF_AUTOSCALE_WEBHOOK_URL?.trim() ?? '';
  const webhookToken = env.AF_AUTOSCALE_WEBHOOK_TOKEN ?? '';
  return {
    bundleId,
    namespace,
    runtimeConfiguration,
    intervalMs: positiveInt(env.AF_AUTOSCALE_INTERVAL_MS, 10_000, 'AF_AUTOSCALE_INTERVAL_MS'),
    stateTtlSeconds: positiveInt(env.AF_AUTOSCALE_STATE_TTL_SECONDS, 7 * 24 * 60 * 60, 'AF_AUTOSCALE_STATE_TTL_SECONDS'),
    policies: Object.fromEntries(WORKER_POOLS.map((pool) => [pool, policyFor(env, pool)])) as Record<WorkerPool, AutoscalePolicy>,
    webhook: new AutoscaleWebhookAdapter({
      url: webhookUrl,
      token: webhookToken,
      timeoutMs: positiveInt(env.AF_AUTOSCALE_REQUEST_TIMEOUT_MS, 5_000, 'AF_AUTOSCALE_REQUEST_TIMEOUT_MS'),
      allowInsecureHttp: env.AF_AUTOSCALE_ALLOW_INSECURE_WEBHOOK === '1',
    }),
  };
}

function stateKey(config: AutoscaleServiceConfig, pool: WorkerPool): string {
  return compileRedisKey(config.namespace, 'autoscale-state', 'v1', pool);
}

async function readState(
  redis: Redis,
  config: AutoscaleServiceConfig,
  pool: WorkerPool,
  currentReplicas: number,
): Promise<AutoscaleState> {
  const raw = await redis.get(stateKey(config, pool));
  if (!raw || raw.length > 16 * 1024) return initialAutoscaleState(currentReplicas);
  try {
    return parseAutoscaleState(JSON.parse(raw) as unknown, currentReplicas);
  } catch {
    return initialAutoscaleState(currentReplicas);
  }
}

async function writeState(
  redis: Redis,
  config: AutoscaleServiceConfig,
  pool: WorkerPool,
  state: AutoscaleState,
): Promise<void> {
  await redis.set(stateKey(config, pool), JSON.stringify(state), 'EX', config.stateTtlSeconds);
}

function waitingJobs(counts: Record<string, number>): number {
  return (counts.wait ?? 0) + (counts['waiting-children'] ?? 0) + (counts.delayed ?? 0);
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      signal.removeEventListener('abort', stop);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const stop = (): void => {
      clearTimeout(timer);
      finish();
    };
    signal.addEventListener('abort', stop, { once: true });
  });
}

export async function runAutoscaleService(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env);
  const redis = createRedisConnection('autoscaler');
  const queue = new DistributedCompileQueue(redis, {
    namespace: config.namespace,
    runtimeConfiguration: config.runtimeConfiguration,
  });
  const stopping = new AbortController();
  const stop = (): void => stopping.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await verifyRedis(redis);
    console.log(`autoscaler ready for bundle ${config.bundleId}`);
    while (!stopping.signal.aborted) {
      const startedAt = Date.now();
      try {
        const [stats, capabilities] = await Promise.all([
          queue.stats(),
          listWorkerCapabilities(redis, config.namespace, config.runtimeConfiguration),
        ]);
        for (const pool of WORKER_POOLS) {
          try {
            const workers = capabilities.filter((capability) => capability.bundleId === config.bundleId && capability.pool === pool);
            const currentReplicas = workers.length;
            const currentCapacity = workers.reduce((sum, worker) => sum + (worker.capacity ?? 1), 0);
            const state = await readState(redis, config, pool, currentReplicas);
            const result = decideWorkerReplicas({
              pool,
              waiting: waitingJobs(stats[pool]),
              active: stats[pool].active ?? 0,
              currentReplicas,
              currentCapacity,
              observedAt: startedAt,
            }, config.policies[pool], state);
            if (result.decision.changed) await config.webhook.apply(result.decision);
            await writeState(redis, config, pool, result.nextState);
            console.log(JSON.stringify({
              event: 'autoscale-decision',
              pool,
              waiting: result.decision.queue.waiting,
              active: result.decision.queue.active,
              currentReplicas,
              currentCapacity,
              desiredReplicas: result.decision.desiredReplicas,
              reason: result.decision.reason,
              decisionId: result.decision.decisionId,
            }));
          } catch (error) {
            console.error(`autoscale pool ${pool} failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } catch (error) {
        console.error(`autoscale iteration failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(Math.max(1, config.intervalMs - (Date.now() - startedAt)), stopping.signal);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await queue.close().catch(() => {});
    await redis.quit().catch(() => redis.disconnect());
  }
}
