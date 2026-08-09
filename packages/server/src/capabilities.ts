import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { validateBlocksMetadata, type BlocksMetadata } from '@arduinofast/core';
import { compileRedisKey, type CompileRedisNamespace } from './compile-namespace.js';
import {
  assertRuntimeConfigurationNamespace,
  createUnverifiedLocalRuntimeConfiguration,
  type CompilerRuntimeConfiguration,
} from './compiler-runtime-release.js';
import { WORKER_POOLS, type WorkerPool } from './distributed-queue.js';

export interface PublicLibraryCapability {
  name: string;
  version: string;
  architectures: string[];
  depends: string[];
  category: string | null;
  url: string | null;
  includes: string[];
  headerOnly: boolean;
  blocksMeta: BlocksMetadata | null;
}

export interface WorkerCapability {
  id: string;
  pool: WorkerPool;
  boards: string[];
  libraries: PublicLibraryCapability[];
  bundleId: string;
  compileReleaseId: string;
  runtimeTrust: 'accepted' | 'unverified-local';
  hostRuntimeIdentity: string;
  /** Concurrent compile slots published by this worker process. */
  capacity?: number;
  startedAt: number;
  updatedAt: number;
}

export interface CapabilityHeartbeatOptions {
  namespace: CompileRedisNamespace;
  ttlMs?: number;
  intervalMs?: number;
  runtimeConfiguration?: CompilerRuntimeConfiguration;
}

type WorkerCapabilitySnapshot = Omit<WorkerCapability, 'id' | 'startedAt' | 'updatedAt'>;
type WorkerCapabilitySource = WorkerCapabilitySnapshot | (() => WorkerCapabilitySnapshot);

const MAX_CAPABILITY_RECORDS = 1_000;

function stringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= maxLength);
}

function publicLibrary(value: unknown): value is PublicLibraryCapability {
  if (!value || typeof value !== 'object') return false;
  const library = value as Partial<PublicLibraryCapability>;
  return typeof library.name === 'string'
    && library.name.length > 0
    && library.name.length <= 256
    && typeof library.version === 'string'
    && library.version.length > 0
    && library.version.length <= 128
    && stringArray(library.architectures, 32, 64)
    && stringArray(library.depends, 256, 256)
    && (library.category === null || (typeof library.category === 'string' && library.category.length <= 128))
    && (library.url === null || (typeof library.url === 'string' && library.url.length <= 2_048))
    && stringArray(library.includes, 512, 256)
    && typeof library.headerOnly === 'boolean'
    && (library.blocksMeta === null || (() => {
      const validation = validateBlocksMetadata(library.blocksMeta);
      return validation.valid && validation.value?.review.status === 'approved';
    })());
}

function workerCapability(
  value: unknown,
  now: number,
  runtimeConfiguration: CompilerRuntimeConfiguration,
): value is WorkerCapability {
  if (!value || typeof value !== 'object') return false;
  const capability = value as Partial<WorkerCapability>;
  return typeof capability.id === 'string'
    && capability.id.length > 0
    && capability.id.length <= 256
    && WORKER_POOLS.includes(capability.pool as WorkerPool)
    && typeof capability.bundleId === 'string'
    && capability.bundleId.length > 0
    && capability.bundleId.length <= 256
    && capability.bundleId === runtimeConfiguration.compilerBundleId
    && capability.compileReleaseId === runtimeConfiguration.releaseId
    && capability.runtimeTrust === runtimeConfiguration.trust
    && typeof capability.hostRuntimeIdentity === 'string'
    && capability.hostRuntimeIdentity === runtimeConfiguration.runtimes[
      capability.pool as WorkerPool
    ]?.hostRuntimeIdentity
    && (capability.capacity === undefined
      || (Number.isSafeInteger(capability.capacity) && capability.capacity >= 1 && capability.capacity <= 1_000))
    && typeof capability.startedAt === 'number'
    && Number.isFinite(capability.startedAt)
    && capability.startedAt > 0
    && typeof capability.updatedAt === 'number'
    && Number.isFinite(capability.updatedAt)
    && capability.updatedAt >= capability.startedAt
    && capability.updatedAt <= now + 5_000
    && now - capability.updatedAt <= 60_000
    && stringArray(capability.boards, 256, 256)
    && Array.isArray(capability.libraries)
    && capability.libraries.length <= 5_000
    && capability.libraries.every(publicLibrary);
}

export class CapabilityHeartbeat {
  readonly id = `${process.env.HOSTNAME ?? 'worker'}-${process.pid}-${randomUUID()}`;
  private readonly prefix: string;
  private readonly namespace: CompileRedisNamespace;
  private readonly ttlMs: number;
  private readonly intervalMs: number;
  private readonly runtimeConfiguration: CompilerRuntimeConfiguration;
  private readonly startedAt = Date.now();
  private readonly pendingBeats = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(
    private readonly redis: Redis,
    private readonly capability: WorkerCapabilitySource,
    options: CapabilityHeartbeatOptions,
  ) {
    this.namespace = options.namespace;
    this.runtimeConfiguration = options.runtimeConfiguration
      ?? createUnverifiedLocalRuntimeConfiguration(this.namespace.bundleId);
    assertRuntimeConfigurationNamespace(this.runtimeConfiguration, this.namespace);
    this.prefix = workerCapabilityNamespace(this.namespace);
    this.ttlMs = options.ttlMs ?? 30_000;
    this.intervalMs = options.intervalMs ?? 10_000;
  }

  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.startPromise ??= this.startHeartbeat();
    return this.startPromise;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.closePromise = this.revoke();
    return this.closePromise;
  }

  private async startHeartbeat(): Promise<void> {
    await this.beat();
    if (this.closed) return;
    this.timer = setInterval(() => {
      void this.beat().catch(() => { /* health endpoint observes expiry */ });
    }, this.intervalMs);
    this.timer.unref();
  }

  private beat(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const pending = this.writeCapability();
    this.pendingBeats.add(pending);
    void pending.then(
      () => { this.pendingBeats.delete(pending); },
      () => { this.pendingBeats.delete(pending); },
    );
    return pending;
  }

  private async writeCapability(): Promise<void> {
    const now = Date.now();
    const snapshot = typeof this.capability === 'function' ? this.capability() : this.capability;
    if (snapshot.bundleId !== this.namespace.bundleId) {
      throw new Error('worker capability bundle does not match its Redis namespace');
    }
    if (snapshot.compileReleaseId !== this.runtimeConfiguration.releaseId
      || snapshot.runtimeTrust !== this.runtimeConfiguration.trust
      || snapshot.hostRuntimeIdentity
        !== this.runtimeConfiguration.runtimes[snapshot.pool].hostRuntimeIdentity) {
      throw new Error('worker capability runtime does not match its compile release');
    }
    const payload: WorkerCapability = {
      ...snapshot,
      id: this.id,
      startedAt: this.startedAt,
      updatedAt: now,
    };
    await this.redis.set(`${this.prefix}:${this.id}`, JSON.stringify(payload), 'PX', this.ttlMs);
  }

  private async revoke(): Promise<void> {
    const pending = [...this.pendingBeats];
    if (pending.length > 0) await Promise.allSettled(pending);
    try { await this.redis.del(`${this.prefix}:${this.id}`); } catch { /* key TTL is the fallback */ }
  }
}

export async function listWorkerCapabilities(
  redis: Redis,
  namespace: CompileRedisNamespace,
  configuredRuntime?: CompilerRuntimeConfiguration,
): Promise<WorkerCapability[]> {
  const runtimeConfiguration = configuredRuntime
    ?? createUnverifiedLocalRuntimeConfiguration(namespace.bundleId);
  assertRuntimeConfigurationNamespace(runtimeConfiguration, namespace);
  const prefix = workerCapabilityNamespace(namespace);
  let cursor = '0';
  const keys: string[] = [];
  do {
    const [next, page] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100);
    cursor = next;
    keys.push(...page.slice(0, MAX_CAPABILITY_RECORDS - keys.length));
  } while (cursor !== '0' && keys.length < MAX_CAPABILITY_RECORDS);
  if (keys.length === 0) return [];

  const now = Date.now();
  const rows = await redis.mget(...keys);
  const result: WorkerCapability[] = [];
  for (const row of rows) {
    if (!row) continue;
    try {
      const value: unknown = JSON.parse(row);
      if (workerCapability(value, now, runtimeConfiguration)) result.push(value);
    } catch {
      // Expired or corrupt capability records are ignored.
    }
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

export function workerCapabilityNamespace(namespace: CompileRedisNamespace): string {
  return compileRedisKey(namespace, 'worker-capabilities', 'v1');
}
