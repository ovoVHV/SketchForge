import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { platform } from 'node:os';

export const DERIVED_CACHE_NAMESPACES = [
  'cores',
  'libs',
  'esp32',
  'esp32-pch',
  'esp32-static',
] as const;

export interface DerivedCacheQuota {
  maxTotalBytes: number;
  maxEntries: number;
}

export const DEFAULT_DERIVED_CACHE_QUOTA: Readonly<DerivedCacheQuota> = Object.freeze({
  maxTotalBytes: 1024 * 1024 * 1024,
  maxEntries: 2_048,
});

const PRUNE_INTERVAL_MS = 30_000;
const HANDOFF_GRACE_MS = 5_000;
const READY_MARKER = '.sketchforge-ready';
const LEGACY_READY_MARKER = '.arduinofast-ready';
const READY_MARKER_CONTENT = 'ready\n';

export function isDerivedCacheEntryReady(entryPath: string, artifacts: string[]): boolean {
  try {
    const ready = [READY_MARKER, LEGACY_READY_MARKER].some((marker) => {
      try {
        return readFileSync(join(entryPath, marker), 'utf8') === READY_MARKER_CONTENT;
      } catch {
        return false;
      }
    });
    if (!ready) {
      return false;
    }
    return artifacts.every((artifact) => {
      const stat = lstatSync(artifact);
      return stat.isFile() && !stat.isSymbolicLink();
    });
  } catch {
    return false;
  }
}

export function markDerivedCacheEntryReady(entryPath: string): boolean {
  const marker = join(entryPath, READY_MARKER);
  let temp = join(entryPath, `.${READY_MARKER}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, READY_MARKER_CONTENT, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temp, marker);
    temp = '';
    return true;
  } catch {
    return false;
  } finally {
    if (temp) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // A failed marker write only disables this cache entry for future hits.
      }
    }
  }
}

export function discardDerivedCacheEntry(entryPath: string): void {
  try {
    rmSync(entryPath, { recursive: true, force: true });
  } catch {
    // Partial cache cleanup is best effort and must not mask the build result.
  }
}

export interface DerivedCachePruneResult {
  scannedEntries: number;
  removedEntries: number;
  totalBytes: number;
  totalEntries: number;
  quotaSatisfied: boolean;
}

interface CacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

function envInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function derivedCacheQuotaFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DerivedCacheQuota {
  return {
    maxTotalBytes: envInteger(
      env.AF_DERIVED_CACHE_MAX_BYTES,
      DEFAULT_DERIVED_CACHE_QUOTA.maxTotalBytes,
    ),
    maxEntries: envInteger(
      env.AF_DERIVED_CACHE_MAX_ENTRIES,
      DEFAULT_DERIVED_CACHE_QUOTA.maxEntries,
    ),
  };
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return platform() === 'win32' ? absolute.toLowerCase() : absolute;
}

function entrySize(path: string): number | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;

    let total = 0;
    for (const name of readdirSync(path)) {
      const childSize = entrySize(join(path, name));
      if (childSize === null) return null;
      total = Math.min(Number.MAX_SAFE_INTEGER, total + childSize);
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * Total quota for process-shared derived caches.
 *
 * Leases are deliberately process-local. They prevent this process from
 * evicting entries it is building or reading, but they are not a distributed
 * lock between Node processes sharing one cache directory.
 */
export class DerivedCacheManager {
  private readonly leases = new Map<string, number>();
  private readonly protectedUntil = new Map<string, number>();
  private lastPruneAt = 0;
  private prunePending = false;
  private pruneTimer: NodeJS.Timeout | undefined;
  private pruneTimerAt = 0;

  constructor(
    private readonly root: string,
    readonly quota: DerivedCacheQuota = derivedCacheQuotaFromEnv(),
  ) {}

  acquire(entryPath: string): () => void {
    const key = pathKey(entryPath);
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.leases.get(key) ?? 0;
      if (count <= 1) {
        this.leases.delete(key);
        if (this.prunePending && !this.pruneTimer) this.schedulePrune(0);
      } else {
        this.leases.set(key, count - 1);
      }
    };
  }

  async withLease<T>(entryPath: string, task: () => Promise<T>): Promise<T> {
    const release = this.acquire(entryPath);
    try {
      return await task();
    } finally {
      release();
    }
  }

  withLeaseSync<T>(entryPath: string, task: () => T): T {
    const release = this.acquire(entryPath);
    try {
      return task();
    } finally {
      release();
    }
  }

  touch(entryPath: string): void {
    this.protectedUntil.set(pathKey(entryPath), Date.now() + HANDOFF_GRACE_MS);
    try {
      const now = new Date();
      utimesSync(entryPath, now, now);
    } catch {
      // Cache recency is advisory; failed metadata writes must not fail builds.
    }
  }

  maybePrune(now = Date.now()): void {
    if (this.lastPruneAt !== 0 && now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.prune();
  }

  private cancelScheduledPrune(): void {
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.pruneTimer = undefined;
    this.pruneTimerAt = 0;
  }

  private schedulePrune(delayMs: number): void {
    const delay = Math.max(0, delayMs);
    const scheduledAt = Date.now() + delay;
    if (this.pruneTimer && this.pruneTimerAt <= scheduledAt) return;
    this.cancelScheduledPrune();

    const timer = setTimeout(() => {
      if (this.pruneTimer !== timer) return;
      this.pruneTimer = undefined;
      this.pruneTimerAt = 0;
      this.prune();
    }, delay);
    timer.unref();
    this.pruneTimer = timer;
    this.pruneTimerAt = scheduledAt;
  }

  prune(): DerivedCachePruneResult {
    const now = Date.now();
    this.lastPruneAt = now;
    for (const [key, until] of this.protectedUntil) {
      if (until <= now) this.protectedUntil.delete(key);
    }
    const entries: CacheEntry[] = [];

    for (const namespace of DERIVED_CACHE_NAMESPACES) {
      const namespacePath = join(this.root, namespace);
      try {
        const namespaceStat = lstatSync(namespacePath);
        if (!namespaceStat.isDirectory() || namespaceStat.isSymbolicLink()) continue;

        for (const name of readdirSync(namespacePath)) {
          const path = join(namespacePath, name);
          try {
            const stat = lstatSync(path);
            const size = entrySize(path);
            if (size === null) continue;
            entries.push({ path, size, mtimeMs: stat.mtimeMs });
          } catch {
            // A concurrent build or cleanup may move an entry during scanning.
          }
        }
      } catch {
        // Missing and temporarily unreadable namespaces are normal.
      }
    }

    entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
    let totalBytes = entries.reduce(
      (sum, entry) => Math.min(Number.MAX_SAFE_INTEGER, sum + entry.size),
      0,
    );
    let totalEntries = entries.length;
    let removedEntries = 0;
    let blockedByLease = false;
    let earliestProtectionExpiry = Number.POSITIVE_INFINITY;

    for (const entry of entries) {
      if (
        totalBytes <= this.quota.maxTotalBytes
        && totalEntries <= this.quota.maxEntries
      ) break;
      const key = pathKey(entry.path);
      if (this.leases.has(key)) {
        blockedByLease = true;
        continue;
      }
      const protectedUntil = this.protectedUntil.get(key) ?? 0;
      if (protectedUntil > now) {
        earliestProtectionExpiry = Math.min(earliestProtectionExpiry, protectedUntil);
        continue;
      }

      try {
        const stat = lstatSync(entry.path);
        rmSync(entry.path, stat.isDirectory() && !stat.isSymbolicLink()
          ? { recursive: true, force: true }
          : { force: true });
        totalBytes = Math.max(0, totalBytes - entry.size);
        totalEntries -= 1;
        removedEntries += 1;
        this.protectedUntil.delete(key);
      } catch {
        // Quota enforcement is best effort and never blocks compilation.
      }
    }

    const quotaSatisfied = totalBytes <= this.quota.maxTotalBytes
      && totalEntries <= this.quota.maxEntries;
    if (quotaSatisfied) {
      this.prunePending = false;
      this.cancelScheduledPrune();
    } else if (blockedByLease || Number.isFinite(earliestProtectionExpiry)) {
      this.prunePending = true;
      if (Number.isFinite(earliestProtectionExpiry)) {
        this.schedulePrune(earliestProtectionExpiry - now + 1);
      }
    } else {
      // I/O failures are retried on the next normal cache operation, not in a busy loop.
      this.prunePending = false;
      this.cancelScheduledPrune();
    }

    return {
      scannedEntries: entries.length,
      removedEntries,
      totalBytes,
      totalEntries,
      quotaSatisfied,
    };
  }
}

const managers = new Map<string, DerivedCacheManager>();

export function getDerivedCacheManager(cacheRoot: string): DerivedCacheManager {
  const key = pathKey(cacheRoot);
  let manager = managers.get(key);
  if (!manager) {
    manager = new DerivedCacheManager(cacheRoot);
    managers.set(key, manager);
  }
  return manager;
}
