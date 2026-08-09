import type { CompileEvent, CompileResult } from '@arduinofast/core';
import type { Redis } from 'ioredis';
import { compileRedisKey, type CompileRedisNamespace } from './compile-namespace.js';

const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface SequencedCompileEvent {
  id: string;
  event: CompileEvent;
}

export interface RedisCompileEventStoreOptions {
  namespace: CompileRedisNamespace;
  ttlSeconds?: number;
  maxEvents?: number;
  maxEventBytes?: number;
}

export interface CompileEventKeys {
  list: string;
  sequence: string;
  terminal: string;
}

const APPEND_EVENT_SCRIPT = `
local terminal = redis.call('GET', KEYS[3])
if not terminal then
  for _, candidate in ipairs(redis.call('LRANGE', KEYS[1], 0, -1)) do
    local ok, decoded = pcall(cjson.decode, candidate)
    if ok and type(decoded) == 'table' and type(decoded.event) == 'table'
      and decoded.event.event == 'done' then
      terminal = candidate
      redis.call('SET', KEYS[3], terminal, 'EX', ARGV[2])
      break
    end
  end
end
if terminal then
  return redis.error_reply('compile event stream is already terminal')
end
local sequence = redis.call('INCR', KEYS[2])
local envelope = cjson.encode({ id = tostring(sequence), event = cjson.decode(ARGV[1]) })
if string.len(envelope) > tonumber(ARGV[4]) then
  return redis.error_reply('compile event exceeds byte limit')
end
redis.call('RPUSH', KEYS[1], envelope)
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[3]), -1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return envelope
`;

const APPEND_TERMINAL_SCRIPT = `
local existing = redis.call('GET', KEYS[3])
if not existing then
  for _, candidate in ipairs(redis.call('LRANGE', KEYS[1], 0, -1)) do
    local ok, decoded = pcall(cjson.decode, candidate)
    if ok and type(decoded) == 'table' and type(decoded.event) == 'table'
      and decoded.event.event == 'done' then
      existing = candidate
      redis.call('SET', KEYS[3], existing, 'EX', ARGV[2])
      break
    end
  end
end
if existing then
  if not redis.call('LPOS', KEYS[1], existing) then
    redis.call('RPUSH', KEYS[1], existing)
    redis.call('LTRIM', KEYS[1], -tonumber(ARGV[3]), -1)
  end
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  redis.call('EXPIRE', KEYS[2], ARGV[2])
  redis.call('EXPIRE', KEYS[3], ARGV[2])
  return existing
end

local sequence = redis.call('INCR', KEYS[2])
local envelope = cjson.encode({ id = tostring(sequence), event = cjson.decode(ARGV[1]) })
if string.len(envelope) > tonumber(ARGV[4]) then
  return redis.error_reply('compile event exceeds byte limit')
end
redis.call('RPUSH', KEYS[1], envelope)
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[3]), -1)
redis.call('SET', KEYS[3], envelope, 'EX', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return envelope
`;

const RESET_TERMINAL_SCRIPT = `
local found = 0
local existing = redis.call('GET', KEYS[3])
if existing then
  found = 1
  redis.call('LREM', KEYS[1], 0, existing)
else
  for _, candidate in ipairs(redis.call('LRANGE', KEYS[1], 0, -1)) do
    local ok, decoded = pcall(cjson.decode, candidate)
    if ok and type(decoded) == 'table' and type(decoded.event) == 'table'
      and decoded.event.event == 'done' then
      found = 1
      redis.call('LREM', KEYS[1], 0, candidate)
    end
  end
end
if found == 1 then redis.call('DEL', KEYS[1], KEYS[2], KEYS[3]) end
return found
`;

export function compileEventNamespace(namespace: CompileRedisNamespace): string {
  return compileRedisKey(namespace, 'events', 'v1');
}

export function compileEventKeys(
  namespace: CompileRedisNamespace,
  jobId: string,
): CompileEventKeys {
  if (!SAFE_JOB_ID.test(jobId)) throw new Error('invalid compile job id');
  const prefix = compileEventNamespace(namespace);
  return {
    list: `${prefix}:${jobId}:list`,
    sequence: `${prefix}:${jobId}:seq`,
    terminal: `${prefix}:${jobId}:terminal`,
  };
}

/** Bounded replay buffer for cross-instance SSE. */
export class RedisCompileEventStore {
  private readonly prefix: string;
  private readonly ttlSeconds: number;
  private readonly maxEvents: number;
  private readonly maxEventBytes: number;

  constructor(
    private readonly redis: Redis,
    options: RedisCompileEventStoreOptions,
  ) {
    this.prefix = compileEventNamespace(options.namespace);
    this.ttlSeconds = options.ttlSeconds ?? 24 * 60 * 60;
    this.maxEvents = options.maxEvents ?? 256;
    this.maxEventBytes = options.maxEventBytes ?? 256 * 1024;
    for (const [name, value] of [
      ['ttlSeconds', this.ttlSeconds],
      ['maxEvents', this.maxEvents],
      ['maxEventBytes', this.maxEventBytes],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    }
  }

  async append(jobId: string, event: CompileEvent): Promise<SequencedCompileEvent> {
    this.assertJobId(jobId);
    if (event.event === 'done') {
      throw new Error('terminal compile events must be committed by the queue terminal coordinator');
    }
    const largestEnvelope = JSON.stringify({ id: '9'.repeat(16), event });
    if (Buffer.byteLength(largestEnvelope, 'utf8') > this.maxEventBytes) {
      throw new Error(`compile event exceeds ${this.maxEventBytes} byte limit`);
    }
    const keys = compileEventKeysFromPrefix(this.prefix, jobId);
    const encoded = await this.redis.eval(
      APPEND_EVENT_SCRIPT,
      3,
      keys.list,
      keys.sequence,
      keys.terminal,
      JSON.stringify(event),
      String(this.ttlSeconds),
      String(this.maxEvents),
      String(this.maxEventBytes),
    );
    if (typeof encoded !== 'string') throw new Error('invalid compile event response');
    const parsed = parseSequencedEvent(encoded);
    if (!parsed) throw new Error('invalid durable compile event');
    return parsed;
  }

  /** Atomically persists one terminal frame and returns it on every recovery attempt. */
  async appendTerminal(jobId: string, result: CompileResult): Promise<SequencedCompileEvent> {
    this.assertJobId(jobId);
    const event: CompileEvent = { event: 'done', result };
    const eventJson = JSON.stringify(event);
    // Reserve enough room for any safe integer sequence before entering Lua.
    const largestEnvelope = JSON.stringify({ id: '9'.repeat(16), event });
    if (Buffer.byteLength(largestEnvelope, 'utf8') > this.maxEventBytes) {
      throw new Error(`compile event exceeds ${this.maxEventBytes} byte limit`);
    }
    const keys = compileEventKeysFromPrefix(this.prefix, jobId);
    const encoded = await this.redis.eval(
      APPEND_TERMINAL_SCRIPT,
      3,
      keys.list,
      keys.sequence,
      keys.terminal,
      eventJson,
      String(this.ttlSeconds),
      String(this.maxEvents),
      String(this.maxEventBytes),
    );
    if (typeof encoded !== 'string') throw new Error('invalid terminal compile event response');
    const parsed = parseSequencedEvent(encoded);
    if (!parsed || parsed.event.event !== 'done') {
      throw new Error('invalid durable terminal compile event');
    }
    return parsed;
  }

  /** Clears a prior terminal generation only when a BullMQ job is retried in flight. */
  async resetTerminal(jobId: string): Promise<boolean> {
    this.assertJobId(jobId);
    const keys = compileEventKeysFromPrefix(this.prefix, jobId);
    return Number(await this.redis.eval(
      RESET_TERMINAL_SCRIPT,
      3,
      keys.list,
      keys.sequence,
      keys.terminal,
    )) > 0;
  }

  async clear(jobId: string): Promise<void> {
    this.assertJobId(jobId);
    const keys = compileEventKeysFromPrefix(this.prefix, jobId);
    await this.redis.del(keys.list, keys.sequence, keys.terminal);
  }

  async list(jobId: string, afterId = '0'): Promise<SequencedCompileEvent[]> {
    this.assertJobId(jobId);
    const after = Number(afterId);
    const rows = await this.redis.lrange(this.listKey(jobId), 0, -1);
    const events: SequencedCompileEvent[] = [];
    for (const row of rows) {
      try {
        const parsed = parseSequencedEvent(row);
        if (parsed && Number(parsed.id) > (Number.isFinite(after) ? after : 0)) events.push(parsed);
      } catch {
        // Ignore a corrupt row; the queue's final result remains authoritative.
      }
    }
    return events;
  }

  private listKey(jobId: string): string {
    return compileEventKeysFromPrefix(this.prefix, jobId).list;
  }

  private assertJobId(jobId: string): void {
    if (!SAFE_JOB_ID.test(jobId)) throw new Error('invalid compile job id');
  }
}

function compileEventKeysFromPrefix(prefix: string, jobId: string): CompileEventKeys {
  if (!SAFE_JOB_ID.test(jobId)) throw new Error('invalid compile job id');
  return {
    list: `${prefix}:${jobId}:list`,
    sequence: `${prefix}:${jobId}:seq`,
    terminal: `${prefix}:${jobId}:terminal`,
  };
}

function parseSequencedEvent(encoded: string): SequencedCompileEvent | null {
  try {
    const parsed = JSON.parse(encoded) as Partial<SequencedCompileEvent>;
    if (
      typeof parsed.id === 'string'
      && parsed.event
      && typeof parsed.event === 'object'
      && typeof (parsed.event as { event?: unknown }).event === 'string'
    ) return parsed as SequencedCompileEvent;
  } catch {
    // The caller decides whether corrupt durable data is fatal or skippable.
  }
  return null;
}
