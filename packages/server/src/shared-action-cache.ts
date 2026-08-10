import {
  sha256Hex,
  type ActionCache,
  type ActionCacheEntry,
  type ActionOutputBlob,
  type MappedBuildDiagnostic,
} from '@sketchforge/core';
import type { Redis } from 'ioredis';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,255}$/;

interface RedisActionCacheOptions {
  /** Namespace includes the immutable compiler bundle identity. */
  namespace: string;
  ttlSeconds?: number;
  /** JSON/base64 envelope limit; large SDK outputs stay in the local cache. */
  maxEntryBytes?: number;
}

interface WireEntry {
  schema: 1;
  actionKey: string;
  outputs: Array<{ path: string; sha256: string; bytes: string }>;
  diagnostics?: MappedBuildDiagnostic[];
}

/**
 * Best-effort Redis Action cache. Redis is an accelerator, never a build
 * dependency: malformed, oversized, expired, or unavailable entries are
 * treated as misses and the local cache remains authoritative.
 */
export class RedisActionCache implements ActionCache {
  private readonly namespace: string;
  private readonly ttlSeconds: number;
  private readonly maxEntryBytes: number;

  constructor(
    private readonly redis: Redis,
    options: RedisActionCacheOptions,
  ) {
    if (!options.namespace || !/^[A-Za-z0-9:_./-]{1,160}$/.test(options.namespace)) {
      throw new TypeError('Redis Action cache namespace is invalid');
    }
    this.namespace = options.namespace;
    this.ttlSeconds = positiveInt(options.ttlSeconds, 7 * 24 * 60 * 60);
    this.maxEntryBytes = positiveInt(options.maxEntryBytes, 4 * 1024 * 1024);
  }

  async get(actionKey: string): Promise<ActionCacheEntry | null> {
    if (!SHA256.test(actionKey)) return null;
    try {
      const raw = await this.redis.get(this.keyFor(actionKey));
      if (!raw || Buffer.byteLength(raw, 'utf8') > this.maxEntryBytes) return null;
      const parsed = JSON.parse(raw) as unknown;
      const entry = decodeEntry(parsed, actionKey, this.maxEntryBytes);
      return entry;
    } catch {
      return null;
    }
  }

  async put(entry: ActionCacheEntry): Promise<void> {
    if (!SHA256.test(entry.actionKey)) return;
    const encoded = encodeEntry(entry, this.maxEntryBytes);
    if (!encoded) return;
    try {
      await this.redis.set(
        this.keyFor(entry.actionKey),
        encoded,
        'EX',
        this.ttlSeconds,
      );
    } catch {
      // Redis outages must not fail an otherwise successful compile.
    }
  }

  private keyFor(actionKey: string): string {
    return `${this.namespace}:action:${actionKey}`;
  }
}

/** Local-first tier with Redis fill/write-through for cross-worker reuse. */
export class TieredActionCache implements ActionCache {
  constructor(
    private readonly local: ActionCache,
    private readonly remote: ActionCache,
  ) {}

  async get(actionKey: string): Promise<ActionCacheEntry | null> {
    const local = await this.local.get(actionKey);
    if (local) return local;
    const remote = await this.remote.get(actionKey);
    if (remote) {
      try { await this.local.put(remote); } catch { /* local cache is advisory */ }
    }
    return remote;
  }

  async put(entry: ActionCacheEntry): Promise<void> {
    await this.local.put(entry);
    await this.remote.put(entry);
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function encodeEntry(entry: ActionCacheEntry, maxBytes: number): string | null {
  const outputs: WireEntry['outputs'] = [];
  const seen = new Set<string>();
  for (const output of entry.outputs) {
    if (!validOutput(output) || seen.has(output.path)) return null;
    seen.add(output.path);
    outputs.push({
      path: output.path,
      sha256: output.sha256,
      bytes: Buffer.from(output.bytes).toString('base64'),
    });
  }
  const encoded = JSON.stringify({
    schema: 1,
    actionKey: entry.actionKey,
    outputs,
    ...(entry.diagnostics === undefined
      ? {}
      : { diagnostics: entry.diagnostics.map((diagnostic) => ({ ...diagnostic })) }),
  } satisfies WireEntry);
  return Buffer.byteLength(encoded, 'utf8') <= maxBytes ? encoded : null;
}

function decodeEntry(value: unknown, actionKey: string, maxBytes: number): ActionCacheEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<WireEntry>;
  if (candidate.schema !== 1 || candidate.actionKey !== actionKey || !Array.isArray(candidate.outputs)) return null;
  const outputs: ActionOutputBlob[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of candidate.outputs) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const output = raw as Partial<WireEntry['outputs'][number]>;
    if (typeof output.path !== 'string' || !SAFE_PATH.test(output.path)
      || typeof output.sha256 !== 'string' || !SHA256.test(output.sha256)
      || typeof output.bytes !== 'string' || seen.has(output.path)) return null;
    const bytes = Buffer.from(output.bytes, 'base64');
    if (sha256Hex(bytes) !== output.sha256) return null;
    total += bytes.byteLength;
    if (total > maxBytes) return null;
    seen.add(output.path);
    outputs.push({ path: output.path, sha256: output.sha256, bytes: new Uint8Array(bytes) });
  }
  if (candidate.diagnostics !== undefined && !Array.isArray(candidate.diagnostics)) return null;
  return {
    actionKey,
    outputs,
    ...(candidate.diagnostics === undefined
      ? {}
      : { diagnostics: candidate.diagnostics.map((diagnostic) => ({ ...diagnostic })) }),
  };
}

function validOutput(output: ActionOutputBlob): boolean {
  return SAFE_PATH.test(output.path) && SHA256.test(output.sha256)
    && sha256Hex(output.bytes) === output.sha256;
}
