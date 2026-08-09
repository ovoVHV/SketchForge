import { Buffer } from 'node:buffer';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_STORAGE_LIMITS,
  RedisProjectStorage,
  PROJECT_STORAGE_SCRIPT,
  projectQuotaHttpFailure,
  readProjectStorageLimits,
  type RedisProjectStorageOptions,
} from '../src/cloud-project-store.js';

interface StoredProject {
  encoded: string;
  expiresAt: number;
  size: number;
  updatedAt: number;
}

class FakeAtomicProjectRedis {
  now = 1_000_000;
  lastScript = '';
  private readonly projects = new Map<string, StoredProject>();
  private readonly indexes = new Map<string, Map<string, number>>();
  private readonly visitorUsage = new Map<string, number>();
  private globalUsage = 0;
  private tail: Promise<void> = Promise.resolve();
  private nextEvalFailure: Error | null = null;

  async eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<number[]> {
    this.lastScript = script;
    expect(keyCount).toBe(7);
    const argv = args.slice(keyCount).map(String);
    let unlock = () => {};
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try {
      await Promise.resolve();
      if (this.nextEvalFailure) {
        const failure = this.nextEvalFailure;
        this.nextEvalFailure = null;
        throw failure;
      }
      return this.execute(argv);
    } finally {
      unlock();
    }
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
  }

  failNextEval(message = 'simulated Redis EVAL failure'): void {
    this.nextEvalFailure = new Error(message);
  }

  dropIndexEntry(visitor: string, projectId: string): void {
    this.indexes.get(visitor)?.delete(projectId);
  }

  expiresAt(visitor: string, projectId: string): number | undefined {
    return this.projects.get(this.token(visitor, projectId))?.expiresAt;
  }

  encoded(visitor: string, projectId: string): string | undefined {
    this.cleanupExpired();
    return this.projects.get(this.token(visitor, projectId))?.encoded;
  }

  projectCount(visitor: string): number {
    this.cleanupExpired();
    let count = 0;
    for (const token of this.projects.keys()) {
      if (token.startsWith(`${visitor}|`)) count++;
    }
    return count;
  }

  visitorBytes(visitor: string): number {
    this.cleanupExpired();
    return this.visitorUsage.get(visitor) ?? 0;
  }

  globalBytes(): number {
    this.cleanupExpired();
    return this.globalUsage;
  }

  private token(visitor: string, projectId: string): string {
    return `${visitor}|${projectId}`;
  }

  private index(visitor: string): Map<string, number> {
    let index = this.indexes.get(visitor);
    if (!index) {
      index = new Map();
      this.indexes.set(visitor, index);
    }
    return index;
  }

  private cleanupExpired(): void {
    for (const [token, project] of this.projects) {
      if (project.expiresAt > this.now) continue;
      const [visitor, projectId] = token.split('|');
      if (!visitor || !projectId) throw new Error(`invalid fake project token: ${token}`);
      this.remove(visitor, projectId);
    }
  }

  private remove(visitor: string, projectId: string): boolean {
    const token = this.token(visitor, projectId);
    const project = this.projects.get(token);
    this.indexes.get(visitor)?.delete(projectId);
    if (this.indexes.get(visitor)?.size === 0) this.indexes.delete(visitor);
    if (!project) return false;
    this.projects.delete(token);
    const nextVisitorBytes = (this.visitorUsage.get(visitor) ?? 0) - project.size;
    if (nextVisitorBytes > 0) this.visitorUsage.set(visitor, nextVisitorBytes);
    else this.visitorUsage.delete(visitor);
    this.globalUsage -= project.size;
    return true;
  }

  private counters(visitor: string): [number, number, number] {
    return [
      this.projectCount(visitor),
      this.visitorUsage.get(visitor) ?? 0,
      this.globalUsage,
    ];
  }

  private execute(argv: string[]): number[] {
    const [
      action,
      visitor,
      projectId,
      _projectPrefix,
      _visitorBytesPrefix,
      _visitorSizesPrefix,
      ttlRaw,
      maxProjectsRaw,
      maxVisitorBytesRaw,
      maxGlobalBytesRaw,
      encoded = '',
      newSizeRaw = '0',
      updatedAtRaw = '0',
    ] = argv;
    if (!action || !visitor || !projectId) throw new Error('invalid fake project script arguments');
    const ttlMs = Number(ttlRaw) * 1_000;
    const maxProjects = Number(maxProjectsRaw);
    const maxVisitorBytes = Number(maxVisitorBytesRaw);
    const maxGlobalBytes = Number(maxGlobalBytesRaw);
    const newSize = Number(newSizeRaw);
    const updatedAt = Number(updatedAtRaw);
    this.cleanupExpired();

    if (action === 'cleanup') {
      const [count, visitorBytes, globalBytes] = this.counters(visitor);
      return [0, 0, count, visitorBytes, globalBytes];
    }
    if (action === 'delete') {
      const existed = this.remove(visitor, projectId);
      const [count, visitorBytes, globalBytes] = this.counters(visitor);
      return [0, existed ? 1 : 0, count, visitorBytes, globalBytes];
    }
    if (action !== 'save') throw new Error(`unsupported fake action: ${action}`);

    expect(Buffer.byteLength(encoded, 'utf8')).toBe(newSize);
    const token = this.token(visitor, projectId);
    const old = this.projects.get(token);
    const count = this.projectCount(visitor);
    const visitorBytes = this.visitorUsage.get(visitor) ?? 0;
    const delta = newSize - (old?.size ?? 0);

    if (!old && count >= maxProjects) return [1, 0, count, visitorBytes, this.globalUsage];
    if (delta > 0 && visitorBytes + delta > maxVisitorBytes) {
      return [2, 0, count, visitorBytes, this.globalUsage];
    }
    if (delta > 0 && this.globalUsage + delta > maxGlobalBytes) {
      return [3, 0, count, visitorBytes, this.globalUsage];
    }

    this.projects.set(token, { encoded, expiresAt: this.now + ttlMs, size: newSize, updatedAt });
    this.index(visitor).set(projectId, updatedAt);
    this.visitorUsage.set(visitor, visitorBytes + delta);
    this.globalUsage += delta;
    return [0, old ? 0 : 1, old ? count : count + 1, visitorBytes + delta, this.globalUsage];
  }
}

function createStorage(
  redis: FakeAtomicProjectRedis,
  options: RedisProjectStorageOptions = {},
): RedisProjectStorage {
  return new RedisProjectStorage(redis as unknown as Redis, {
    prefix: 'test-compile',
    ttlSeconds: 60,
    maxProjectsPerVisitor: 10,
    maxBytesPerVisitor: 1_000,
    maxGlobalBytes: 10_000,
    ...options,
  });
}

describe('gateway anonymous project quotas', () => {
  it('uses conservative defaults and rejects malformed environment values', () => {
    expect(readProjectStorageLimits({})).toEqual(DEFAULT_PROJECT_STORAGE_LIMITS);
    expect(readProjectStorageLimits({
      AF_PROJECT_TTL_SECONDS: '3600',
      AF_PROJECT_MAX_PER_VISITOR: '7',
      AF_PROJECT_VISITOR_MAX_BYTES: '2048',
      AF_PROJECT_GLOBAL_MAX_BYTES: '8192',
    })).toEqual({
      ttlSeconds: 3_600,
      maxProjectsPerVisitor: 7,
      maxBytesPerVisitor: 2_048,
      maxGlobalBytes: 8_192,
    });

    for (const invalid of ['', '0', '-1', '1.5', ' 2', '2 ', '9007199254740992']) {
      expect(() => readProjectStorageLimits({ AF_PROJECT_GLOBAL_MAX_BYTES: invalid }))
        .toThrow(/AF_PROJECT_GLOBAL_MAX_BYTES/);
    }
    expect(() => readProjectStorageLimits({ AF_PROJECT_MAX_PER_VISITOR: '10001' }))
      .toThrow(/AF_PROJECT_MAX_PER_VISITOR/);
  });

  it('rejects the legacy index key suffix before Redis is touched', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis);
    await expect(storage.save('visitor-a', 'index', 'x', 1)).rejects.toThrow(/invalid project id/);
    expect(redis.lastScript).toBe('');
  });

  it('charges only the replacement delta when an overwrite grows or shrinks', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis);

    await expect(storage.save('visitor-a', 'main', 'abc', 1)).resolves.toMatchObject({
      ok: true,
      created: true,
      projectCount: 1,
      visitorBytes: 3,
      globalBytes: 3,
    });
    await expect(storage.save('visitor-a', 'main', 'abcdef', 2)).resolves.toMatchObject({
      ok: true,
      created: false,
      projectCount: 1,
      visitorBytes: 6,
      globalBytes: 6,
    });
    await expect(storage.save('visitor-a', 'main', 'x', 3)).resolves.toMatchObject({
      ok: true,
      created: false,
      projectCount: 1,
      visitorBytes: 1,
      globalBytes: 1,
    });
    expect(redis.encoded('visitor-a', 'main')).toBe('x');
  });

  it('rejects excess project cardinality without a partial project or counter write', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis, { maxProjectsPerVisitor: 2 });
    await storage.save('visitor-a', 'one', '1', 1);
    await storage.save('visitor-a', 'two', '22', 2);

    const rejected = await storage.save('visitor-a', 'three', '333', 3);
    expect(rejected).toMatchObject({ ok: false, reason: 'project_count', limit: 2 });
    expect(redis.encoded('visitor-a', 'three')).toBeUndefined();
    expect(redis.projectCount('visitor-a')).toBe(2);
    expect(redis.visitorBytes('visitor-a')).toBe(3);
    expect(redis.globalBytes()).toBe(3);

    await storage.delete('visitor-a', 'one');
    await expect(storage.save('visitor-a', 'three', '333', 4)).resolves.toMatchObject({ ok: true });
  });

  it('enforces visitor bytes and preserves the old value after a rejected growth', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis, { maxBytesPerVisitor: 5 });
    await storage.save('visitor-a', 'one', '1234', 1);

    await expect(storage.save('visitor-a', 'two', '12', 2)).resolves.toMatchObject({
      ok: false,
      reason: 'visitor_bytes',
    });
    await expect(storage.save('visitor-a', 'one', '123456', 3)).resolves.toMatchObject({
      ok: false,
      reason: 'visitor_bytes',
    });
    expect(redis.encoded('visitor-a', 'one')).toBe('1234');
    expect(redis.encoded('visitor-a', 'two')).toBeUndefined();
    expect(redis.visitorBytes('visitor-a')).toBe(4);

    await storage.save('visitor-a', 'one', '1', 4);
    await expect(storage.save('visitor-a', 'two', '234', 5)).resolves.toMatchObject({
      ok: true,
      visitorBytes: 4,
    });
  });

  it('returns 507 at the global byte boundary and allows a shrink to free capacity', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis, { maxGlobalBytes: 6 });
    await storage.save('visitor-a', 'one', '1234', 1);

    const rejected = await storage.save('visitor-b', 'two', '567', 2);
    expect(rejected).toMatchObject({ ok: false, reason: 'global_bytes', limit: 6 });
    if (rejected.ok) throw new Error('expected global quota rejection');
    expect(projectQuotaHttpFailure(rejected)).toMatchObject({
      statusCode: 507,
      body: { error: 'project_storage_full', limit: 6 },
    });
    expect(redis.encoded('visitor-b', 'two')).toBeUndefined();
    expect(redis.globalBytes()).toBe(4);

    await storage.save('visitor-a', 'one', '12', 3);
    await expect(storage.save('visitor-b', 'two', '567', 4)).resolves.toMatchObject({
      ok: true,
      globalBytes: 5,
    });
  });

  it('maps visitor-owned quota failures to explicit 429 responses', () => {
    expect(projectQuotaHttpFailure({
      ok: false,
      reason: 'project_count',
      limit: 16,
      projectCount: 16,
      visitorBytes: 10,
      globalBytes: 10,
    })).toMatchObject({ statusCode: 429, body: { error: 'project_count_limit', limit: 16 } });
    expect(projectQuotaHttpFailure({
      ok: false,
      reason: 'visitor_bytes',
      limit: 100,
      projectCount: 1,
      visitorBytes: 100,
      globalBytes: 100,
    })).toMatchObject({ statusCode: 429, body: { error: 'project_visitor_storage_limit', limit: 100 } });
  });

  it('serializes concurrent creators at the last available project slot', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis, { maxProjectsPerVisitor: 1 });
    const results = await Promise.all([
      storage.save('visitor-a', 'one', '1', 1),
      storage.save('visitor-a', 'two', '2', 2),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === 'project_count')).toHaveLength(1);
    expect(redis.projectCount('visitor-a')).toBe(1);
    expect(redis.visitorBytes('visitor-a')).toBe(1);
    expect(redis.globalBytes()).toBe(1);
  });

  it('serializes visitors competing for the last global bytes', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis, { maxGlobalBytes: 3 });
    const results = await Promise.all([
      storage.save('visitor-a', 'one', '12', 1),
      storage.save('visitor-b', 'two', '34', 2),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === 'global_bytes')).toHaveLength(1);
    expect(redis.globalBytes()).toBe(2);
  });

  it('uses UTF-8 bytes rather than JavaScript character count', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis, { maxBytesPerVisitor: 6 });

    await expect(storage.save('visitor-a', 'main', '你好', 1)).resolves.toMatchObject({
      ok: true,
      visitorBytes: 6,
      globalBytes: 6,
    });
    await expect(storage.save('visitor-a', 'main', '你好!', 2)).resolves.toMatchObject({
      ok: false,
      reason: 'visitor_bytes',
    });
    expect(redis.encoded('visitor-a', 'main')).toBe('你好');
  });

  it('does not expose a project slot when only the presentation index is lost', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis, { maxProjectsPerVisitor: 1 });
    await storage.save('visitor-a', 'main', '1', 1);
    redis.dropIndexEntry('visitor-a', 'main');

    await expect(storage.save('visitor-a', 'other', '2', 2)).resolves.toMatchObject({
      ok: false,
      reason: 'project_count',
    });
    await expect(storage.save('visitor-a', 'main', 'updated', 3)).resolves.toMatchObject({
      ok: true,
      created: false,
      projectCount: 1,
    });
    expect(redis.projectCount('visitor-a')).toBe(1);
  });

  it('leaves payload, counters, and TTL unchanged when Redis rejects the atomic call', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis);
    await storage.save('visitor-a', 'main', 'old', 1);
    const expiresAt = redis.expiresAt('visitor-a', 'main');
    redis.failNextEval();

    await expect(storage.save('visitor-a', 'main', 'replacement', 2)).rejects.toThrow(/EVAL failure/);
    expect(redis.encoded('visitor-a', 'main')).toBe('old');
    expect(redis.projectCount('visitor-a')).toBe(1);
    expect(redis.visitorBytes('visitor-a')).toBe(3);
    expect(redis.globalBytes()).toBe(3);
    expect(redis.expiresAt('visitor-a', 'main')).toBe(expiresAt);
  });

  it('releases count and byte quotas exactly once on explicit deletion', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis, { maxProjectsPerVisitor: 1, maxGlobalBytes: 4 });
    await storage.save('visitor-a', 'one', '1234', 1);

    await expect(storage.delete('visitor-a', 'one')).resolves.toBe(true);
    await expect(storage.delete('visitor-a', 'one')).resolves.toBe(false);
    expect(redis.projectCount('visitor-a')).toBe(0);
    expect(redis.visitorBytes('visitor-a')).toBe(0);
    expect(redis.globalBytes()).toBe(0);
    await expect(storage.save('visitor-a', 'two', '5678', 2)).resolves.toMatchObject({ ok: true });
  });

  it('reclaims expired payload, visitor index, and both byte counters together', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis, {
      ttlSeconds: 2,
      maxProjectsPerVisitor: 1,
      maxBytesPerVisitor: 3,
      maxGlobalBytes: 3,
    });
    await storage.save('visitor-a', 'old', '123', 1);
    redis.advance(2_001);
    await storage.cleanupVisitor('visitor-a');

    expect(redis.encoded('visitor-a', 'old')).toBeUndefined();
    expect(redis.projectCount('visitor-a')).toBe(0);
    expect(redis.visitorBytes('visitor-a')).toBe(0);
    expect(redis.globalBytes()).toBe(0);
    await expect(storage.save('visitor-a', 'new', '456', 2)).resolves.toMatchObject({ ok: true });
  });

  it('reclaims another visitor\'s expired bytes before enforcing the global limit', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis, { ttlSeconds: 2, maxGlobalBytes: 3 });
    await storage.save('visitor-a', 'old', '123', 1);
    redis.advance(2_001);

    await expect(storage.save('visitor-b', 'new', '456', 2)).resolves.toMatchObject({
      ok: true,
      globalBytes: 3,
    });
    expect(redis.encoded('visitor-a', 'old')).toBeUndefined();
    expect(redis.projectCount('visitor-a')).toBe(0);
    expect(redis.globalBytes()).toBe(3);
  });

  it('does not refresh a project TTL when an overwrite is rejected', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis, { ttlSeconds: 2, maxBytesPerVisitor: 3 });
    await storage.save('visitor-a', 'main', '123', 1);
    const expiresAt = redis.expiresAt('visitor-a', 'main');
    redis.advance(1_500);

    await expect(storage.save('visitor-a', 'main', '1234', 2)).resolves.toMatchObject({
      ok: false,
      reason: 'visitor_bytes',
    });
    expect(redis.expiresAt('visitor-a', 'main')).toBe(expiresAt);
    redis.advance(501);
    expect(redis.encoded('visitor-a', 'main')).toBeUndefined();
    expect(redis.globalBytes()).toBe(0);
  });

  it('preflights failures and places every quota rejection before the project SET', async () => {
    const redis = new FakeAtomicProjectRedis();
    const storage = createStorage(redis);
    await storage.save('visitor-a', 'main', 'x', 1);

    expect(redis.lastScript).toBe(PROJECT_STORAGE_SCRIPT);
    const preflight = redis.lastScript.indexOf("assert_type(KEYS[1], 'string')");
    const firstQuotaCheck = redis.lastScript.indexOf('if slot_required and project_count >= max_projects');
    const targetWrite = redis.lastScript.indexOf("redis.call('SET', KEYS[1], encoded, 'EX', ttl)");
    const visitorLedgerWrite = redis.lastScript.indexOf("redis.call('HSET', KEYS[7], project_id, new_size)");
    expect(preflight).toBeGreaterThan(-1);
    expect(firstQuotaCheck).toBeGreaterThan(-1);
    expect(targetWrite).toBeGreaterThan(firstQuotaCheck);
    expect(visitorLedgerWrite).toBeGreaterThan(targetWrite);
  });
});
