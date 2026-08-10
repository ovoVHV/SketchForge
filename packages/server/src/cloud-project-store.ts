import type { Redis } from 'ioredis';

const MAX_REDIS_COUNTER = Number.MAX_SAFE_INTEGER;

export const MAX_PROJECT_SNAPSHOT_BYTES = 600 * 1024;

export const DEFAULT_PROJECT_STORAGE_LIMITS = Object.freeze({
  ttlSeconds: 30 * 24 * 60 * 60,
  maxProjectsPerVisitor: 16,
  maxBytesPerVisitor: 4 * 1024 * 1024,
  maxGlobalBytes: 64 * 1024 * 1024,
});

export interface ProjectStorageLimits {
  ttlSeconds: number;
  maxProjectsPerVisitor: number;
  maxBytesPerVisitor: number;
  maxGlobalBytes: number;
}

function checkedPositiveInt(name: string, value: unknown, maximum = MAX_REDIS_COUNTER): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return Number(value);
}

function strictEnvPositiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum = MAX_REDIS_COUNTER,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} must be a base-10 positive integer`);
  }
  return checkedPositiveInt(name, Number(raw), maximum);
}

export function readProjectStorageLimits(env: NodeJS.ProcessEnv = process.env): ProjectStorageLimits {
  return {
    ttlSeconds: strictEnvPositiveInt(
      env,
      'AF_PROJECT_TTL_SECONDS',
      DEFAULT_PROJECT_STORAGE_LIMITS.ttlSeconds,
      365 * 24 * 60 * 60,
    ),
    maxProjectsPerVisitor: strictEnvPositiveInt(
      env,
      'AF_PROJECT_MAX_PER_VISITOR',
      DEFAULT_PROJECT_STORAGE_LIMITS.maxProjectsPerVisitor,
      10_000,
    ),
    maxBytesPerVisitor: strictEnvPositiveInt(
      env,
      'AF_PROJECT_VISITOR_MAX_BYTES',
      DEFAULT_PROJECT_STORAGE_LIMITS.maxBytesPerVisitor,
    ),
    maxGlobalBytes: strictEnvPositiveInt(
      env,
      'AF_PROJECT_GLOBAL_MAX_BYTES',
      DEFAULT_PROJECT_STORAGE_LIMITS.maxGlobalBytes,
    ),
  };
}

export const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const VISITOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function validProjectId(value: string): boolean {
  // `index` is the visitor sorted-set suffix and cannot share its key.
  return value !== 'index' && PROJECT_ID_PATTERN.test(value);
}

/**
 * All quota state is changed in one Redis script. The script deliberately
 * validates Redis types and stored numbers before the first target write:
 * Redis Lua scripts are atomic with respect to other clients, but a runtime
 * error does not roll back commands that already ran.
 */
export const PROJECT_STORAGE_SCRIPT = `
local action = ARGV[1]
local visitor = ARGV[2]
local project_id = ARGV[3]
local project_prefix = ARGV[4]
local visitor_bytes_prefix = ARGV[5]
local visitor_sizes_prefix = ARGV[6]
local ttl = tonumber(ARGV[7])
local max_projects = tonumber(ARGV[8])
local max_visitor_bytes = tonumber(ARGV[9])
local max_global_bytes = tonumber(ARGV[10])
local encoded = ARGV[11] or ''
local new_size = tonumber(ARGV[12] or '0')
local updated_at = tonumber(ARGV[13] or '0')

if not ttl or ttl <= 0 or not max_projects or max_projects <= 0
  or not max_visitor_bytes or max_visitor_bytes <= 0
  or not max_global_bytes or max_global_bytes <= 0 then
  error('invalid project storage limits')
end
if action == 'save' and (not new_size or new_size < 0 or new_size ~= math.floor(new_size)
  or not updated_at or updated_at <= 0 or updated_at ~= math.floor(updated_at)) then
  error('invalid project storage save arguments')
end

local function key_type(key)
  local reply = redis.call('TYPE', key)
  if type(reply) == 'table' then return reply['ok'] end
  return reply
end

local function assert_type(key, expected)
  local actual = key_type(key)
  if actual ~= 'none' and actual ~= expected then
    error('project storage key has an unexpected Redis type')
  end
end

-- Validate every fixed key before housekeeping can make a partial change.
assert_type(KEYS[1], 'string')
assert_type(KEYS[2], 'zset')
assert_type(KEYS[3], 'string')
assert_type(KEYS[4], 'string')
assert_type(KEYS[5], 'zset')
assert_type(KEYS[6], 'hash')
assert_type(KEYS[7], 'hash')

local clock = redis.call('TIME')
local now_ms = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)

local function integer_value(raw, label)
  if not raw then return nil end
  local value = tonumber(raw)
  if not value or value < 0 or value ~= math.floor(value) then
    error('invalid project storage counter')
  end
  return value
end

local function counter_value(key)
  return integer_value(redis.call('GET', key), key)
    or 0
end

local function decrement_counter(key, amount)
  if amount <= 0 then return end
  local current = counter_value(key)
  if current <= amount then
    redis.call('DEL', key)
  else
    redis.call('DECRBY', key, amount)
  end
end

local function adjust_counter(key, delta)
  if delta > 0 then
    redis.call('INCRBY', key, delta)
  elseif delta < 0 then
    decrement_counter(key, -delta)
  end
end

local function split_token(value)
  local separator = string.find(value, '|', 1, true)
  if not separator then return nil, nil end
  return string.sub(value, 1, separator - 1), string.sub(value, separator + 1)
end

local function assert_accounting_shape(value)
  local old_visitor, old_project_id = split_token(value)
  if not old_visitor or not old_project_id then
    error('invalid project storage accounting token')
  end
  assert_type(project_prefix .. old_visitor .. ':index', 'zset')
  assert_type(project_prefix .. old_visitor .. ':' .. old_project_id, 'string')
  assert_type(visitor_bytes_prefix .. old_visitor, 'string')
  assert_type(visitor_sizes_prefix .. old_visitor, 'hash')
  integer_value(redis.call('HGET', KEYS[6], value), KEYS[6])
  integer_value(redis.call('HGET', visitor_sizes_prefix .. old_visitor, old_project_id), KEYS[7])
end

local function remove_accounting(value, delete_project)
  local old_visitor, old_project_id = split_token(value)
  if not old_visitor or not old_project_id then
    error('invalid project storage accounting token')
  end
  local old_index_key = project_prefix .. old_visitor .. ':index'
  local old_project_key = project_prefix .. old_visitor .. ':' .. old_project_id
  local old_sizes_key = visitor_sizes_prefix .. old_visitor
  local global_size = integer_value(redis.call('HGET', KEYS[6], value), KEYS[6])
  local visitor_size = integer_value(redis.call('HGET', old_sizes_key, old_project_id), old_sizes_key)
  if global_size and visitor_size and global_size ~= visitor_size then
    error('inconsistent project storage accounting size')
  end
  local size = global_size or visitor_size

  redis.call('ZREM', KEYS[5], value)
  if size then
    redis.call('HDEL', KEYS[6], value)
    decrement_counter(KEYS[4], size)
    -- The current visitor is rebuilt from its index below. Other visitors
    -- can be updated directly while global expiry is being swept.
    if old_visitor ~= visitor then
      decrement_counter(visitor_bytes_prefix .. old_visitor, size)
    end
  end
  redis.call('HDEL', old_sizes_key, old_project_id)
  redis.call('ZREM', old_index_key, old_project_id)
  if delete_project then redis.call('DEL', old_project_key) end
  return size or 0
end

-- A missing global counter is repaired from the authoritative size hash.
-- This is only the recovery path; normal requests use the O(1) counter.
if not redis.call('GET', KEYS[4]) then
  local total = 0
  local values = redis.call('HVALS', KEYS[6])
  for _, raw in ipairs(values) do
    total = total + integer_value(raw, KEYS[6])
  end
  if total > 0 then redis.call('SET', KEYS[4], total) end
end

local expired = redis.call('ZRANGEBYSCORE', KEYS[5], '-inf', now_ms)
-- Preflight all records before removing any of them. This prevents a later
-- WRONGTYPE/counter error from leaving only half of an expiry sweep applied.
for _, expired_token in ipairs(expired) do
  assert_accounting_shape(expired_token)
end
for _, expired_token in ipairs(expired) do
  remove_accounting(expired_token, true)
end

local function account_existing(existing_project_id)
  local existing_key = project_prefix .. visitor .. ':' .. existing_project_id
  if redis.call('EXISTS', existing_key) == 0 then
    remove_accounting(visitor .. '|' .. existing_project_id, false)
    return nil
  end
  local remaining_ttl = redis.call('PTTL', existing_key)
  if remaining_ttl <= 0 then
    redis.call('DEL', existing_key)
    redis.call('ZREM', KEYS[2], existing_project_id)
    remove_accounting(visitor .. '|' .. existing_project_id, false)
    return nil
  end

  local actual_size = redis.call('STRLEN', existing_key)
  local token = visitor .. '|' .. existing_project_id
  local tracked_size = integer_value(redis.call('HGET', KEYS[6], token), KEYS[6])
  local visitor_size = integer_value(redis.call('HGET', KEYS[7], existing_project_id), KEYS[7])
  if tracked_size and visitor_size and tracked_size ~= visitor_size then
    error('inconsistent project storage accounting size')
  end
  if not tracked_size then
    adjust_counter(KEYS[4], actual_size)
    redis.call('HSET', KEYS[6], token, actual_size)
  elseif tracked_size ~= actual_size then
    adjust_counter(KEYS[4], actual_size - tracked_size)
    redis.call('HSET', KEYS[6], token, actual_size)
  end
  if visitor_size ~= actual_size then
    redis.call('HSET', KEYS[7], existing_project_id, actual_size)
  end
  redis.call('ZADD', KEYS[5], now_ms + remaining_ttl, token)
  return actual_size
end

local function set_visitor_total(total)
  if total <= 0 then
    redis.call('DEL', KEYS[3])
    return
  end
  local remaining_ttl = redis.call('PTTL', KEYS[7])
  if remaining_ttl > 0 then
    redis.call('SET', KEYS[3], total, 'PX', remaining_ttl)
  else
    redis.call('SET', KEYS[3], total)
  end
end

local function reconcile_visitor()
  local indexed_projects = redis.call('ZRANGE', KEYS[2], 0, -1)
  for _, indexed_project_id in ipairs(indexed_projects) do
    assert_type(project_prefix .. visitor .. ':' .. indexed_project_id, 'string')
    assert_accounting_shape(visitor .. '|' .. indexed_project_id)
  end

  local total = 0
  for _, indexed_project_id in ipairs(indexed_projects) do
    account_existing(indexed_project_id)
  end

  -- The visitor size hash is the quota authority. The sorted set is only the
  -- presentation index, so losing one index member cannot open a quota slot.
  local accounted_projects = redis.call('HKEYS', KEYS[7])
  for _, accounted_project_id in ipairs(accounted_projects) do
    assert_type(project_prefix .. visitor .. ':' .. accounted_project_id, 'string')
    assert_accounting_shape(visitor .. '|' .. accounted_project_id)
  end
  for _, accounted_project_id in ipairs(accounted_projects) do
    account_existing(accounted_project_id)
  end

  local values = redis.call('HVALS', KEYS[7])
  for _, raw in ipairs(values) do
    total = total + integer_value(raw, KEYS[7])
  end
  set_visitor_total(total)
  return redis.call('HLEN', KEYS[7]), total
end

local project_count, visitor_bytes = reconcile_visitor()

local function ensure_bookkeeping_ttls()
  for _, key in ipairs({ KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7] }) do
    if redis.call('EXISTS', key) == 1 and redis.call('PTTL', key) < 0 then
      redis.call('EXPIRE', key, ttl)
    end
  end
end

if action == 'cleanup' then
  for _, key in ipairs({ KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7] }) do
    if redis.call('EXISTS', key) == 1 then redis.call('EXPIRE', key, ttl) end
  end
  return { 0, 0, project_count, visitor_bytes, counter_value(KEYS[4]) }
end

if action == 'delete' then
  assert_accounting_shape(visitor .. '|' .. project_id)
  local existed = redis.call('EXISTS', KEYS[1])
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], project_id)
  remove_accounting(visitor .. '|' .. project_id, false)
  project_count, visitor_bytes = reconcile_visitor()
  if redis.call('HLEN', KEYS[6]) == 0 then
    redis.call('DEL', KEYS[4])
    redis.call('DEL', KEYS[5])
    redis.call('DEL', KEYS[6])
  end
  ensure_bookkeeping_ttls()
  return { 0, existed == 1 and 1 or 0, project_count, visitor_bytes, counter_value(KEYS[4]) }
end

if action ~= 'save' then error('unsupported project storage action') end

local target_exists = redis.call('EXISTS', KEYS[1])
local target_accounted = redis.call('HGET', KEYS[7], project_id) ~= false
local old_size = 0
if target_exists == 1 then
  local reconciled_size = account_existing(project_id)
  if reconciled_size then
    old_size = reconciled_size
  else
    target_exists = 0
  end
  if target_exists == 1 and not target_accounted then
    visitor_bytes = visitor_bytes + old_size
    set_visitor_total(visitor_bytes)
  end
else
  -- Remove an orphaned accounting entry before evaluating a new slot.
  assert_accounting_shape(visitor .. '|' .. project_id)
  remove_accounting(visitor .. '|' .. project_id, false)
end

local delta = new_size - old_size
local global_bytes = counter_value(KEYS[4])
local slot_required = not target_accounted

-- Every rejection is decided before the target SET. The accounting repairs
-- above only make the existing Redis state truthful.
if slot_required and project_count >= max_projects then
  ensure_bookkeeping_ttls()
  return { 1, 0, project_count, visitor_bytes, global_bytes }
end
if delta > 0 and visitor_bytes + delta > max_visitor_bytes then
  ensure_bookkeeping_ttls()
  return { 2, 0, project_count, visitor_bytes, global_bytes }
end
if delta > 0 and global_bytes + delta > max_global_bytes then
  ensure_bookkeeping_ttls()
  return { 3, 0, project_count, visitor_bytes, global_bytes }
end

-- SET is intentionally first in the commit section. All subsequent Redis
-- operations have already had their key types and numeric inputs validated.
redis.call('SET', KEYS[1], encoded, 'EX', ttl)
adjust_counter(KEYS[3], delta)
adjust_counter(KEYS[4], delta)
redis.call('HSET', KEYS[6], visitor .. '|' .. project_id, new_size)
redis.call('HSET', KEYS[7], project_id, new_size)
redis.call('ZADD', KEYS[5], now_ms + ttl * 1000, visitor .. '|' .. project_id)
redis.call('ZADD', KEYS[2], updated_at, project_id)

for _, key in ipairs({ KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7] }) do
  if redis.call('EXISTS', key) == 1 then redis.call('EXPIRE', key, ttl) end
end

local next_count = project_count + (slot_required and 1 or 0)
return { 0, target_exists == 0 and 1 or 0, next_count, visitor_bytes + delta, global_bytes + delta }
`;

export type ProjectStorageSaveResult =
  | {
      ok: true;
      created: boolean;
      projectCount: number;
      visitorBytes: number;
      globalBytes: number;
    }
  | {
      ok: false;
      reason: 'project_count' | 'visitor_bytes' | 'global_bytes';
      limit: number;
      projectCount: number;
      visitorBytes: number;
      globalBytes: number;
    };

export interface ProjectQuotaHttpFailure {
  statusCode: 429 | 507;
  body: {
    error: string;
    message: string;
    limit: number;
  };
}

export function projectQuotaHttpFailure(
  result: Extract<ProjectStorageSaveResult, { ok: false }>,
): ProjectQuotaHttpFailure {
  if (result.reason === 'project_count') {
    return {
      statusCode: 429,
      body: {
        error: 'project_count_limit',
        message: `每位访客最多保存 ${result.limit} 个云项目`,
        limit: result.limit,
      },
    };
  }
  if (result.reason === 'visitor_bytes') {
    return {
      statusCode: 429,
      body: {
        error: 'project_visitor_storage_limit',
        message: '该访客的云项目存储配额已用尽',
        limit: result.limit,
      },
    };
  }
  return {
    statusCode: 507,
    body: {
      error: 'project_storage_full',
      message: '云项目存储暂时已满，请稍后重试',
      limit: result.limit,
    },
  };
}

export interface RedisProjectStorageOptions extends Partial<ProjectStorageLimits> {
  prefix?: string;
}

export class RedisProjectStorage {
  readonly limits: ProjectStorageLimits;
  private readonly projectPrefix: string;
  private readonly visitorBytesPrefix: string;
  private readonly visitorSizesPrefix: string;
  private readonly globalBytesKey: string;
  private readonly globalExpiryKey: string;
  private readonly globalSizesKey: string;

  constructor(
    private readonly redis: Redis,
    options: RedisProjectStorageOptions = {},
  ) {
    const prefix = options.prefix ?? 'sketchforge-compile';
    if (!prefix || prefix.trim() !== prefix) throw new Error('project storage prefix must be non-empty and trimmed');
    this.limits = {
      ttlSeconds: checkedPositiveInt(
        'ttlSeconds',
        options.ttlSeconds ?? DEFAULT_PROJECT_STORAGE_LIMITS.ttlSeconds,
        365 * 24 * 60 * 60,
      ),
      maxProjectsPerVisitor: checkedPositiveInt(
        'maxProjectsPerVisitor',
        options.maxProjectsPerVisitor ?? DEFAULT_PROJECT_STORAGE_LIMITS.maxProjectsPerVisitor,
        10_000,
      ),
      maxBytesPerVisitor: checkedPositiveInt(
        'maxBytesPerVisitor',
        options.maxBytesPerVisitor ?? DEFAULT_PROJECT_STORAGE_LIMITS.maxBytesPerVisitor,
      ),
      maxGlobalBytes: checkedPositiveInt(
        'maxGlobalBytes',
        options.maxGlobalBytes ?? DEFAULT_PROJECT_STORAGE_LIMITS.maxGlobalBytes,
      ),
    };
    this.projectPrefix = `${prefix}:projects:v1:`;
    const quotaPrefix = `${prefix}:project-quota:v1`;
    this.visitorBytesPrefix = `${quotaPrefix}:visitor:`;
    this.visitorSizesPrefix = `${quotaPrefix}:visitor-projects:`;
    this.globalBytesKey = `${quotaPrefix}:global:bytes`;
    this.globalExpiryKey = `${quotaPrefix}:global:expiry`;
    this.globalSizesKey = `${quotaPrefix}:global:sizes`;
  }

  projectKey(visitor: string, projectId: string): string {
    this.validateIdentity(visitor, projectId);
    return `${this.projectPrefix}${visitor}:${projectId}`;
  }

  projectIndexKey(visitor: string): string {
    this.validateVisitor(visitor);
    return `${this.projectPrefix}${visitor}:index`;
  }

  private visitorBytesKey(visitor: string): string {
    return `${this.visitorBytesPrefix}${visitor}`;
  }

  private visitorSizesKey(visitor: string): string {
    return `${this.visitorSizesPrefix}${visitor}`;
  }

  private validateVisitor(visitor: string): void {
    if (!VISITOR_PATTERN.test(visitor)) throw new Error('invalid project visitor');
  }

  private validateIdentity(visitor: string, projectId: string): void {
    this.validateVisitor(visitor);
    if (!validProjectId(projectId)) throw new Error('invalid project id');
  }

  private async run(
    action: 'save' | 'delete' | 'cleanup',
    visitor: string,
    projectId = 'cleanup',
    encoded = '',
    updatedAt = 0,
  ): Promise<[number, number, number, number, number]> {
    this.validateIdentity(visitor, projectId);
    const encodedBytes = Buffer.byteLength(encoded, 'utf8');
    const result = await this.redis.eval(
      PROJECT_STORAGE_SCRIPT,
      7,
      this.projectKey(visitor, projectId),
      this.projectIndexKey(visitor),
      this.visitorBytesKey(visitor),
      this.globalBytesKey,
      this.globalExpiryKey,
      this.globalSizesKey,
      this.visitorSizesKey(visitor),
      action,
      visitor,
      projectId,
      this.projectPrefix,
      this.visitorBytesPrefix,
      this.visitorSizesPrefix,
      this.limits.ttlSeconds,
      this.limits.maxProjectsPerVisitor,
      this.limits.maxBytesPerVisitor,
      this.limits.maxGlobalBytes,
      encoded,
      encodedBytes,
      updatedAt,
    );
    if (!Array.isArray(result) || result.length < 5) {
      throw new Error('invalid Redis project storage response');
    }
    const values = result.map(Number);
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error('invalid Redis project storage counters');
    }
    return values as [number, number, number, number, number];
  }

  async save(visitor: string, projectId: string, encoded: string, updatedAt: number): Promise<ProjectStorageSaveResult> {
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) throw new Error('updatedAt must be a positive safe integer');
    const [code, created, projectCount, visitorBytes, globalBytes] = await this.run(
      'save',
      visitor,
      projectId,
      encoded,
      updatedAt,
    );
    if (code === 0) {
      return { ok: true, created: created === 1, projectCount, visitorBytes, globalBytes };
    }
    const reasons = {
      1: ['project_count', this.limits.maxProjectsPerVisitor],
      2: ['visitor_bytes', this.limits.maxBytesPerVisitor],
      3: ['global_bytes', this.limits.maxGlobalBytes],
    } as const;
    const rejection = reasons[code as keyof typeof reasons];
    if (!rejection) throw new Error(`unknown Redis project storage result: ${code}`);
    return {
      ok: false,
      reason: rejection[0],
      limit: rejection[1],
      projectCount,
      visitorBytes,
      globalBytes,
    };
  }

  async cleanupVisitor(visitor: string): Promise<void> {
    await this.run('cleanup', visitor);
  }

  async delete(visitor: string, projectId: string): Promise<boolean> {
    const [, existed] = await this.run('delete', visitor, projectId);
    return existed === 1;
  }
}
