import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { compileRedisKey, type CompileRedisNamespace } from './compile-namespace.js';

const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_REQUEST_ID = /^[a-f0-9-]{36}$/;

const ACQUIRE_SCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1 and ARGV[6] ~= '1' then
  return 0
end
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, request_id in ipairs(expired) do
  redis.call('HDEL', KEYS[1], request_id)
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[7]) then
  return -1
end
redis.call('HSET', KEYS[1], ARGV[3], ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
redis.call('PEXPIRE', KEYS[2], ARGV[5])
if ARGV[6] == '1' then
  redis.call('DEL', KEYS[3])
end
return redis.call('ZCARD', KEYS[2])
`;

const CANCEL_SCRIPT = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, request_id in ipairs(expired) do
  redis.call('HDEL', KEYS[1], request_id)
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
local actual = redis.call('HGET', KEYS[1], ARGV[2])
if not actual or actual ~= ARGV[3] then
  return {0, redis.call('ZCARD', KEYS[2])}
end
redis.call('HDEL', KEYS[1], ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[2])
local remaining = redis.call('ZCARD', KEYS[2])
if remaining == 0 then
  redis.call('SET', KEYS[3], '1', 'PX', ARGV[4])
end
return {1, remaining}
`;

const CHECK_SCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1 then
  return 1
end
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, request_id in ipairs(expired) do
  redis.call('HDEL', KEYS[1], request_id)
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[2]) == 0 then
  redis.call('SET', KEYS[3], '1', 'PX', ARGV[2])
  return 1
end
return 0
`;

const RELEASE_SCRIPT = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, request_id in ipairs(expired) do
  redis.call('HDEL', KEYS[1], request_id)
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
local actual = redis.call('HGET', KEYS[1], ARGV[2])
if not actual or actual ~= ARGV[3] then
  return {0, redis.call('ZCARD', KEYS[2])}
end
redis.call('HDEL', KEYS[1], ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[2])
return {1, redis.call('ZCARD', KEYS[2])}
`;

export interface CompileConsumerLease {
  requestId: string;
  token: string;
  expiresAt: number;
}

export interface CompileLeaseCancellation {
  found: boolean;
  remaining: number;
}

export interface CompileCancellationStore {
  acquire(jobId: string, resetCancellation?: boolean): Promise<CompileConsumerLease | null>;
  cancel(jobId: string, requestId: string, token: string): Promise<CompileLeaseCancellation>;
  release(jobId: string, requestId: string, token: string): Promise<CompileLeaseCancellation>;
  isCancellationRequested(jobId: string): Promise<boolean>;
  hasCancellationMarker(jobId: string): Promise<boolean>;
  clear(jobId: string): Promise<void>;
}

export interface RedisCompileCancellationOptions {
  namespace: CompileRedisNamespace;
  leaseTtlMs?: number;
  maxConsumersPerJob?: number;
}

export function compileCancellationNamespace(namespace: CompileRedisNamespace): string {
  return compileRedisKey(namespace, 'consumers', 'v1');
}

export class RedisCompileCancellationStore implements CompileCancellationStore {
  private readonly namespace: string;
  private readonly leaseTtlMs: number;
  private readonly maxConsumersPerJob: number;

  constructor(
    private readonly redis: Redis,
    options: RedisCompileCancellationOptions,
  ) {
    this.namespace = compileCancellationNamespace(options.namespace);
    this.leaseTtlMs = options.leaseTtlMs ?? 24 * 60 * 60_000;
    this.maxConsumersPerJob = options.maxConsumersPerJob ?? 1_024;
    if (!Number.isInteger(this.leaseTtlMs) || this.leaseTtlMs <= 0) {
      throw new Error('compile consumer lease TTL must be a positive integer');
    }
    if (!Number.isInteger(this.maxConsumersPerJob) || this.maxConsumersPerJob <= 0) {
      throw new Error('max compile consumers per job must be a positive integer');
    }
  }

  async acquire(jobId: string, resetCancellation = false): Promise<CompileConsumerLease | null> {
    this.assertJobId(jobId);
    const requestId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.tokenHash(token);
    const now = Date.now();
    const expiresAt = now + this.leaseTtlMs;
    const keys = this.keys(jobId);
    const acquired = await this.redis.eval(
      ACQUIRE_SCRIPT,
      3,
      keys.requests,
      keys.expirations,
      keys.cancelled,
      now,
      expiresAt,
      requestId,
      tokenHash,
      this.leaseTtlMs,
      resetCancellation ? '1' : '0',
      this.maxConsumersPerJob,
    );
    return Number(acquired) > 0 ? { requestId, token, expiresAt } : null;
  }

  async cancel(jobId: string, requestId: string, token: string): Promise<CompileLeaseCancellation> {
    this.assertJobId(jobId);
    if (!SAFE_REQUEST_ID.test(requestId) || token.length < 32 || token.length > 128) {
      return { found: false, remaining: 0 };
    }
    const keys = this.keys(jobId);
    const raw = await this.redis.eval(
      CANCEL_SCRIPT,
      3,
      keys.requests,
      keys.expirations,
      keys.cancelled,
      Date.now(),
      requestId,
      this.tokenHash(token),
      this.leaseTtlMs,
    );
    const tuple = Array.isArray(raw) ? raw : [];
    return {
      found: Number(tuple[0]) === 1,
      remaining: Math.max(0, Number(tuple[1]) || 0),
    };
  }

  async release(jobId: string, requestId: string, token: string): Promise<CompileLeaseCancellation> {
    this.assertJobId(jobId);
    if (!SAFE_REQUEST_ID.test(requestId) || token.length < 32 || token.length > 128) {
      return { found: false, remaining: 0 };
    }
    const keys = this.keys(jobId);
    const raw = await this.redis.eval(
      RELEASE_SCRIPT,
      2,
      keys.requests,
      keys.expirations,
      Date.now(),
      requestId,
      this.tokenHash(token),
    );
    const tuple = Array.isArray(raw) ? raw : [];
    return {
      found: Number(tuple[0]) === 1,
      remaining: Math.max(0, Number(tuple[1]) || 0),
    };
  }

  async isCancellationRequested(jobId: string): Promise<boolean> {
    this.assertJobId(jobId);
    const keys = this.keys(jobId);
    const result = await this.redis.eval(
      CHECK_SCRIPT,
      3,
      keys.requests,
      keys.expirations,
      keys.cancelled,
      Date.now(),
      this.leaseTtlMs,
    );
    return Number(result) === 1;
  }

  async hasCancellationMarker(jobId: string): Promise<boolean> {
    this.assertJobId(jobId);
    return (await this.redis.exists(this.keys(jobId).cancelled)) === 1;
  }

  async clear(jobId: string): Promise<void> {
    this.assertJobId(jobId);
    const keys = this.keys(jobId);
    await this.redis.del(keys.requests, keys.expirations, keys.cancelled);
  }

  private keys(jobId: string): { requests: string; expirations: string; cancelled: string } {
    const base = `${this.namespace}:${jobId}`;
    return {
      requests: `${base}:requests`,
      expirations: `${base}:expirations`,
      cancelled: `${base}:cancelled`,
    };
  }

  private tokenHash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private assertJobId(jobId: string): void {
    if (!SAFE_JOB_ID.test(jobId)) throw new Error('invalid compile job id');
  }
}
