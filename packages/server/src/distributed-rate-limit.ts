import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

const VISITOR_ID = /^[A-Za-z0-9_-]{16,128}$/;

const TAKE_SCRIPT = `
local cost = tonumber(ARGV[1])
local global_limit = tonumber(ARGV[2])
local ip_limit = tonumber(ARGV[3])
local visitor_limit = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local function fits(key, limit)
  local current = tonumber(redis.call('GET', key) or '0')
  return current + cost <= limit
end

-- Rejected requests must not burn the global budget. Otherwise one blocked IP
-- could exhaust the platform-wide allowance just by continuing to retry.
if not fits(KEYS[1], global_limit)
  or not fits(KEYS[2], ip_limit)
  or not fits(KEYS[3], visitor_limit) then
  return 0
end

for _, key in ipairs(KEYS) do
  local value = redis.call('INCRBY', key, cost)
  if value == cost or redis.call('PTTL', key) < 0 then
    redis.call('PEXPIRE', key, ttl)
  end
end
return 1
`;

export interface RedisRateLimiterOptions {
  prefix?: string;
  windowMs?: number;
  globalLimit?: number;
  ipLimit?: number;
  visitorLimit?: number;
  keySalt?: string;
}

/** Atomic anonymous limiter shared by every gateway instance. */
export class RedisCompileRateLimiter {
  private readonly prefix: string;
  private readonly windowMs: number;
  private readonly globalLimit: number;
  private readonly ipLimit: number;
  private readonly visitorLimit: number;
  private readonly keySalt: string;

  constructor(
    private readonly redis: Redis,
    options: RedisRateLimiterOptions = {},
  ) {
    this.prefix = options.prefix ?? 'af:compile-rate';
    this.windowMs = options.windowMs ?? 60_000;
    this.globalLimit = options.globalLimit ?? 600;
    this.ipLimit = options.ipLimit ?? 120;
    this.visitorLimit = options.visitorLimit ?? 60;
    this.keySalt = options.keySalt ?? 'arduinofast-public';
    for (const [name, value] of [
      ['windowMs', this.windowMs],
      ['globalLimit', this.globalLimit],
      ['ipLimit', this.ipLimit],
      ['visitorLimit', this.visitorLimit],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    }
  }

  async take(
    ip: string,
    suppliedVisitorId: unknown,
    cost = 1,
  ): Promise<{ allowed: boolean; retryAfterMs: number }> {
    if (!Number.isInteger(cost) || cost <= 0) throw new Error('rate limit cost must be a positive integer');
    const now = Date.now();
    const bucket = Math.floor(now / this.windowMs);
    const visitorId = typeof suppliedVisitorId === 'string' && VISITOR_ID.test(suppliedVisitorId)
      ? suppliedVisitorId
      : `ip-${ip}`;
    const digest = (value: string) => createHash('sha256')
      .update(this.keySalt)
      .update('\0')
      .update(value)
      .digest('hex')
      .slice(0, 32);
    const keys = [
      `${this.prefix}:global:${bucket}`,
      `${this.prefix}:ip:${digest(ip)}:${bucket}`,
      `${this.prefix}:visitor:${digest(visitorId)}:${bucket}`,
    ];
    const allowed = Number(await this.redis.eval(
      TAKE_SCRIPT,
      keys.length,
      ...keys,
      cost,
      this.globalLimit,
      this.ipLimit,
      this.visitorLimit,
      this.windowMs + 1_000,
    )) === 1;
    const retryAfterMs = this.windowMs - (now % this.windowMs);
    return { allowed, retryAfterMs };
  }
}
