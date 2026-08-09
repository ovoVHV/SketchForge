import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256Hex } from '../build-ir/canonical.js';
import type { MappedBuildDiagnostic } from '../build-ir/types.js';
import type { ActionCache, ActionCacheEntry, ActionOutputBlob } from './types.js';

const SHA256 = /^[a-f0-9]{64}$/;
const KEY = SHA256;
const SHARD = /^[a-f0-9]{2}$/;
const TEMPORARY = /^\.action-[A-Za-z0-9_-]+$/;
const TEMPORARY_GRACE_MS = 5 * 60 * 1_000;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60 * 1_000;

interface CacheManifest {
  schema: 1;
  actionKey: string;
  outputs: Array<{ path: string; sha256: string; size: number }>;
  diagnostics?: MappedBuildDiagnostic[];
}

export interface FileActionCacheOptions {
  /** Entry lifetime since its last successful read. Zero disables TTL expiry. */
  ttlMs?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
  /** Minimum delay between filesystem scans. Zero scans after every operation. */
  pruneIntervalMs?: number;
}

interface CacheEntryUsage {
  path: string;
  bytes: number;
  lastUsedMs: number;
}

/** Persistent content-addressed Action cache for NativeExecutor workers. */
export class FileActionCache implements ActionCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly pruneIntervalMs: number;
  private lastPruneAt = 0;
  private pendingPrune: Promise<void> | undefined;

  constructor(private readonly root: string, options: FileActionCacheOptions = {}) {
    this.ttlMs = nonNegativeInteger(options.ttlMs, DEFAULT_TTL_MS, 'Action cache ttlMs');
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 'Action cache maxEntries');
    this.maxTotalBytes = positiveInteger(
      options.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      'Action cache maxTotalBytes',
    );
    this.pruneIntervalMs = nonNegativeInteger(
      options.pruneIntervalMs,
      DEFAULT_PRUNE_INTERVAL_MS,
      'Action cache pruneIntervalMs',
    );
    mkdirSync(root, { recursive: true });
  }

  async get(actionKey: string): Promise<ActionCacheEntry | null> {
    if (!KEY.test(actionKey)) return null;
    await this.maybePrune();
    const directory = this.directoryFor(actionKey);
    try {
      const manifestPath = join(directory, 'manifest.json');
      const manifestStat = lstatSync(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return null;
      if (this.ttlMs > 0 && manifestStat.mtimeMs <= Date.now() - this.ttlMs) {
        rmSync(directory, { recursive: true, force: true });
        return null;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
      if (!isManifest(manifest) || manifest.actionKey !== actionKey) return null;
      const outputs: ActionOutputBlob[] = [];
      for (const entry of manifest.outputs) {
        const path = join(directory, 'blobs', `${entry.sha256}.bin`);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size) throw new Error('invalid cache blob');
        const bytes = new Uint8Array(readFileSync(path));
        if (sha256Hex(bytes) !== entry.sha256) throw new Error('cache blob hash mismatch');
        outputs.push({ path: entry.path, sha256: entry.sha256, bytes });
      }
      const now = new Date();
      try { utimesSync(manifestPath, now, now); } catch { /* recency is best effort */ }
      return {
        actionKey,
        outputs,
        ...(manifest.diagnostics === undefined
          ? {}
          : { diagnostics: manifest.diagnostics.map((diagnostic) => ({ ...diagnostic })) }),
      };
    } catch {
      // A corrupt or partially written entry is a miss, never a build failure.
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
      return null;
    }
  }

  async put(entry: ActionCacheEntry): Promise<void> {
    if (!KEY.test(entry.actionKey)) return;
    const outputs = entry.outputs.map(validateOutput);
    const shard = join(this.root, entry.actionKey.slice(0, 2));
    mkdirSync(shard, { recursive: true });
    const temporary = mkdtempSync(join(shard, '.action-'));
    try {
      const blobs = join(temporary, 'blobs');
      mkdirSync(blobs, { recursive: true });
      const manifest: CacheManifest = {
        schema: 1,
        actionKey: entry.actionKey,
        outputs: outputs.map(({ path, sha256, bytes }) => ({ path, sha256, size: bytes.byteLength })),
        ...(entry.diagnostics === undefined
          ? {}
          : { diagnostics: entry.diagnostics.map((diagnostic) => ({ ...diagnostic })) }),
      };
      const written = new Set<string>();
      for (const output of outputs) {
        if (written.has(output.sha256)) continue;
        written.add(output.sha256);
        writeFileSync(join(blobs, `${output.sha256}.bin`), output.bytes, { flag: 'wx' });
      }
      writeFileSync(join(temporary, 'manifest.json'), JSON.stringify(manifest), { encoding: 'utf8', flag: 'wx' });
      const destination = this.directoryFor(entry.actionKey);
      try {
        renameSync(temporary, destination);
      } catch {
        // Another worker won the race. The existing complete entry is valid.
        rmSync(temporary, { recursive: true, force: true });
      }
    } catch {
      try { rmSync(temporary, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    await this.maybePrune();
  }

  clear(): void {
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { recursive: true });
    this.lastPruneAt = 0;
  }

  /** Run bounded-cache housekeeping immediately. Failures remain cache misses, never build failures. */
  async prune(): Promise<void> {
    if (this.pendingPrune) return this.pendingPrune;
    this.lastPruneAt = Date.now();
    const pending = this.pruneEntries()
      .catch(() => {})
      .finally(() => {
        if (this.pendingPrune === pending) this.pendingPrune = undefined;
      });
    this.pendingPrune = pending;
    return pending;
  }

  private directoryFor(actionKey: string): string {
    return join(this.root, actionKey.slice(0, 2), actionKey);
  }

  private async maybePrune(): Promise<void> {
    if (this.pendingPrune) return this.pendingPrune;
    if (Date.now() - this.lastPruneAt < this.pruneIntervalMs) return;
    await this.prune();
  }

  private async pruneEntries(): Promise<void> {
    const now = Date.now();
    const entries: CacheEntryUsage[] = [];
    let shards;
    try { shards = await readdir(this.root, { withFileTypes: true }); } catch { return; }

    for (const shard of shards) {
      if (!shard.isDirectory() || shard.isSymbolicLink() || !SHARD.test(shard.name)) continue;
      const shardPath = join(this.root, shard.name);
      let children;
      try { children = await readdir(shardPath, { withFileTypes: true }); } catch { continue; }
      for (const child of children) {
        const path = join(shardPath, child.name);
        if (child.isSymbolicLink() || !child.isDirectory()) continue;
        if (TEMPORARY.test(child.name)) {
          const modified = await modifiedTime(path);
          if (modified !== null && modified <= now - TEMPORARY_GRACE_MS) await removeDirectory(path);
          continue;
        }
        if (!KEY.test(child.name) || child.name.slice(0, 2) !== shard.name) continue;
        const usage = await inspectEntry(path, child.name);
        if (!usage) {
          await removeDirectory(path);
          continue;
        }
        if (this.ttlMs > 0 && usage.lastUsedMs <= now - this.ttlMs) {
          await removeDirectory(path);
          continue;
        }
        entries.push(usage);
      }
    }

    entries.sort((left, right) => left.lastUsedMs - right.lastUsedMs || left.path.localeCompare(right.path));
    let count = entries.length;
    let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries) {
      if (count <= this.maxEntries && bytes <= this.maxTotalBytes) break;
      if (await removeDirectory(entry.path)) {
        count--;
        bytes -= entry.bytes;
      }
    }
  }
}

async function inspectEntry(path: string, actionKey: string): Promise<CacheEntryUsage | null> {
  const manifestPath = join(path, 'manifest.json');
  let manifestStat;
  try { manifestStat = await lstat(manifestPath); } catch { return null; }
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return null;
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown; } catch { return null; }
  if (!isManifest(manifest) || manifest.actionKey !== actionKey) return null;
  const bytes = await directorySize(path);
  if (bytes === null) return null;
  return { path, bytes, lastUsedMs: manifestStat.mtimeMs };
}

async function directorySize(path: string): Promise<number | null> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return null; }
  let bytes = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return null;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      const nested = await directorySize(child);
      if (nested === null) return null;
      bytes += nested;
      continue;
    }
    if (!entry.isFile()) return null;
    try { bytes += (await lstat(child)).size; } catch { return null; }
  }
  return bytes;
}

async function modifiedTime(path: string): Promise<number | null> {
  try { return (await lstat(path)).mtimeMs; } catch { return null; }
}

async function removeDirectory(path: string): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new TypeError(`${label} must be a positive integer`);
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return resolved;
}

function validateOutput(output: ActionOutputBlob): ActionOutputBlob {
  if (!output.path || output.path.includes('\\') || output.path.startsWith('/')
    || output.path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError(`invalid Action output path: ${output.path}`);
  }
  if (!SHA256.test(output.sha256) || sha256Hex(output.bytes) !== output.sha256) {
    throw new TypeError(`invalid Action output hash: ${output.path}`);
  }
  return { path: output.path, sha256: output.sha256, bytes: new Uint8Array(output.bytes) };
}

function isManifest(value: unknown): value is CacheManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Partial<CacheManifest>;
  return manifest.schema === 1
    && typeof manifest.actionKey === 'string' && KEY.test(manifest.actionKey)
    && Array.isArray(manifest.outputs)
    && manifest.outputs.every((output) => Boolean(output) && safeOutputPath(output.path)
      && SHA256.test(output.sha256) && Number.isInteger(output.size) && output.size >= 0)
    && (manifest.diagnostics === undefined || Array.isArray(manifest.diagnostics));
}

function safeOutputPath(path: unknown): path is string {
  return typeof path === 'string' && Boolean(path) && !path.includes('\\') && !path.startsWith('/')
    && !/^[A-Za-z]:/.test(path)
    && path.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..');
}
