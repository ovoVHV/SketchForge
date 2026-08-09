import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  CapabilityHeartbeat,
  listWorkerCapabilities,
  workerCapabilityNamespace,
  type WorkerCapability,
} from '../src/capabilities.js';
import { createCompileRedisNamespace } from '../src/compile-namespace.js';
import {
  compilerRuntimeConfigurationFromRelease,
  createCompilerRuntimeRelease,
} from '../src/compiler-runtime-release.js';

class FakeCapabilityRedis {
  readonly patterns: string[] = [];

  constructor(private readonly records: Record<string, string>) {}

  async scan(_cursor: string, _match: string, pattern: string) {
    this.patterns.push(pattern);
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    return ['0', Object.keys(this.records).filter((key) => key.startsWith(prefix))] as [string, string[]];
  }
  async mget(...keys: string[]) { return keys.map((key) => this.records[key] ?? null); }
}

class FakeHeartbeatRedis {
  readonly records = new Map<string, string>();
  setCalls = 0;
  delCalls = 0;
  failNextSet = false;
  failDelete = false;
  blockNextSet = false;
  private releaseBlockedSet?: () => void;

  async set(key: string, value: string): Promise<'OK'> {
    this.setCalls++;
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('Redis SET failed');
    }
    if (this.blockNextSet) {
      this.blockNextSet = false;
      await new Promise<void>((resolve) => { this.releaseBlockedSet = resolve; });
    }
    this.records.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    this.delCalls++;
    if (this.failDelete) throw new Error('Redis DEL failed');
    return this.records.delete(key) ? 1 : 0;
  }

  releaseSet(): void {
    this.releaseBlockedSet?.();
    this.releaseBlockedSet = undefined;
  }
}

function heartbeatCapability() {
  return {
    pool: 'avr' as const,
    boards: ['arduino:avr:uno'],
    libraries: [],
    bundleId: 'bundle-v1',
    compileReleaseId: 'unverified-local',
    runtimeTrust: 'unverified-local' as const,
    hostRuntimeIdentity: 'unverified-local',
    capacity: 1,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

function capability(overrides: Partial<WorkerCapability> = {}): WorkerCapability {
  const now = Date.now();
  return {
    id: 'worker-1',
    pool: 'avr',
    boards: ['arduino:avr:uno'],
    libraries: [{
      name: 'Wire',
      version: '1.0.0',
      architectures: ['avr'],
      depends: [],
      category: null,
      url: null,
      includes: ['Wire.h'],
      headerOnly: false,
      blocksMeta: null,
    }],
    bundleId: 'bundle-v1',
    compileReleaseId: 'unverified-local',
    runtimeTrust: 'unverified-local',
    hostRuntimeIdentity: 'unverified-local',
    startedAt: now - 10_000,
    updatedAt: now,
    ...overrides,
  };
}

describe('listWorkerCapabilities', () => {
  it('returns only current, structurally valid worker advertisements', async () => {
    const namespace = createCompileRedisNamespace('test-compile', 'bundle-v1');
    const prefix = workerCapabilityNamespace(namespace);
    const validB = capability({ id: 'worker-b' });
    const validA = capability({ id: 'worker-a' });
    const malformed = { ...capability({ id: 'broken' }), pool: 'unknown' };
    const badLibrary = capability({
      id: 'bad-library',
      libraries: [{ ...capability().libraries[0]!, architectures: undefined as unknown as string[] }],
    });
    const stale = capability({ id: 'stale', updatedAt: Date.now() - 120_000 });
    const redis = new FakeCapabilityRedis({
      [`${prefix}:b`]: JSON.stringify(validB),
      [`${prefix}:a`]: JSON.stringify(validA),
      [`${prefix}:malformed`]: JSON.stringify(malformed),
      [`${prefix}:library`]: JSON.stringify(badLibrary),
      [`${prefix}:stale`]: JSON.stringify(stale),
      [`${prefix}:json`]: '{',
      [`${workerCapabilityNamespace(createCompileRedisNamespace('test-compile', 'bundle-v2'))}:foreign`]:
        JSON.stringify(capability({ id: 'foreign', bundleId: 'bundle-v2' })),
    });

    const rows = await listWorkerCapabilities(redis as unknown as Redis, namespace);
    expect(rows.map((row) => row.id)).toEqual(['worker-a', 'worker-b']);
    expect(redis.patterns).toEqual([`${prefix}:*`]);
  });

  it('accepts only the target pool identity from the active runtime release', async () => {
    const release = createCompilerRuntimeRelease('bundle-v1', [
      {
        schema: 1,
        pool: 'avr',
        platform: 'linux/amd64',
        imageRepository: 'ghcr.io/example/worker-avr',
        imageDigest: `sha256:${'1'.repeat(64)}`,
      },
      {
        schema: 1,
        pool: 'esp32-xtensa',
        platform: 'linux/amd64',
        imageRepository: 'ghcr.io/example/worker-esp32-xtensa',
        imageDigest: `sha256:${'2'.repeat(64)}`,
      },
      {
        schema: 1,
        pool: 'esp32-riscv',
        platform: 'linux/amd64',
        imageRepository: 'ghcr.io/example/worker-esp32-riscv',
        imageDigest: `sha256:${'3'.repeat(64)}`,
      },
    ]);
    const runtimeConfiguration = compilerRuntimeConfigurationFromRelease(release);
    const namespace = createCompileRedisNamespace(
      'test-compile',
      'bundle-v1',
      release.releaseId,
    );
    const prefix = workerCapabilityNamespace(namespace);
    const avrIdentity = runtimeConfiguration.runtimes.avr.hostRuntimeIdentity;
    const valid = capability({
      id: 'accepted',
      compileReleaseId: release.releaseId,
      runtimeTrust: 'accepted',
      hostRuntimeIdentity: avrIdentity,
    });
    const redis = new FakeCapabilityRedis({
      [`${prefix}:accepted`]: JSON.stringify(valid),
      [`${prefix}:wrong-identity`]: JSON.stringify({
        ...valid,
        id: 'wrong-identity',
        hostRuntimeIdentity: runtimeConfiguration.runtimes['esp32-xtensa'].hostRuntimeIdentity,
      }),
      [`${prefix}:local-claim`]: JSON.stringify({
        ...valid,
        id: 'local-claim',
        runtimeTrust: 'unverified-local',
      }),
    });

    await expect(listWorkerCapabilities(redis as unknown as Redis, namespace))
      .rejects.toThrow(/does not match/);
    await expect(listWorkerCapabilities(
      redis as unknown as Redis,
      namespace,
      runtimeConfiguration,
    )).resolves.toEqual([valid]);
  });
});

describe('CapabilityHeartbeat lifecycle', () => {
  it('withdraws its key once and never refreshes after close', async () => {
    vi.useFakeTimers();
    const redis = new FakeHeartbeatRedis();
    const heartbeat = new CapabilityHeartbeat(
      redis as unknown as Redis,
      heartbeatCapability(),
      {
        namespace: createCompileRedisNamespace('test-compile', 'bundle-v1'),
        intervalMs: 100,
        ttlMs: 1_000,
      },
    );

    await Promise.all([heartbeat.start(), heartbeat.start()]);
    expect(redis.setCalls).toBe(1);
    expect(redis.records.size).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(redis.setCalls).toBe(2);

    await Promise.all([heartbeat.close(), heartbeat.close()]);
    expect(redis.delCalls).toBe(1);
    expect(redis.records.size).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    await heartbeat.start();
    expect(redis.setCalls).toBe(2);
    expect(redis.records.size).toBe(0);
  });

  it('waits for an in-flight refresh before the final delete', async () => {
    vi.useFakeTimers();
    const redis = new FakeHeartbeatRedis();
    const heartbeat = new CapabilityHeartbeat(
      redis as unknown as Redis,
      heartbeatCapability(),
      {
        namespace: createCompileRedisNamespace('test-compile', 'bundle-v1'),
        intervalMs: 100,
        ttlMs: 1_000,
      },
    );
    await heartbeat.start();

    redis.blockNextSet = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(redis.setCalls).toBe(2);

    const closing = heartbeat.close();
    expect(redis.delCalls).toBe(0);
    redis.releaseSet();
    await closing;

    expect(redis.delCalls).toBe(1);
    expect(redis.records.size).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(redis.setCalls).toBe(2);
  });

  it('does not arm refreshes after a failed initial write and tolerates delete failure', async () => {
    vi.useFakeTimers();
    const redis = new FakeHeartbeatRedis();
    redis.failNextSet = true;
    redis.failDelete = true;
    const heartbeat = new CapabilityHeartbeat(
      redis as unknown as Redis,
      heartbeatCapability(),
      {
        namespace: createCompileRedisNamespace('test-compile', 'bundle-v1'),
        intervalMs: 100,
        ttlMs: 1_000,
      },
    );

    await expect(heartbeat.start()).rejects.toThrow('Redis SET failed');
    await expect(heartbeat.close()).resolves.toBeUndefined();
    await expect(heartbeat.close()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(redis.setCalls).toBe(1);
    expect(redis.delCalls).toBe(1);
  });
});
