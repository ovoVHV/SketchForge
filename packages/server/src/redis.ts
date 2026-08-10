import { Redis } from 'ioredis';

export type RedisRole = 'gateway' | 'worker' | 'events' | 'autoscaler';

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createRedisConnection(role: RedisRole, url = process.env.AF_REDIS_URL): Redis {
  if (!url) throw new Error('AF_REDIS_URL is required for distributed mode');
  return new Redis(url, {
    // BullMQ workers use blocking commands and explicitly require null here.
    maxRetriesPerRequest: role === 'worker' || role === 'events' ? null : 1,
    // Public HTTP requests must fail closed quickly during a Redis outage. Do
    // not put a command timeout on BullMQ's blocking worker/event connections.
    ...(role === 'gateway' || role === 'autoscaler'
      ? { commandTimeout: positiveInt(process.env.AF_REDIS_COMMAND_TIMEOUT_MS, 1_500) }
      : {}),
    connectTimeout: positiveInt(process.env.AF_REDIS_CONNECT_TIMEOUT_MS, 2_000),
    enableReadyCheck: true,
    connectionName: `sketchforge-${role}-${process.pid}`,
  });
}

export async function verifyRedis(redis: Redis): Promise<void> {
  const reply = await redis.ping();
  if (reply !== 'PONG') throw new Error(`unexpected Redis PING response: ${reply}`);
}

/** Narrow classification used to turn dependency failures into HTTP 503. */
export function isRedisUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:redis|max\s*retries\s*per\s*request|command timed out|connection is closed|econn(?:refused|reset)|socket closed|stream isn't writeable|offline queue)/i
    .test(`${error.name}: ${error.message}`);
}
