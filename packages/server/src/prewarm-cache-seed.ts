/**
 * Filesystem-only cache seeding for a prewarmed worker image. The seed stays
 * outside the Docker volume mountpoint so a named volume cannot hide it.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isSafeEsp32PrewarmCacheDir } from '@sketchforge/core';

/** Legacy v1 marker. It is read for interruption recovery but never rewritten. */
export const LEGACY_PREWARM_CACHE_SEED_STATE_FILE = '.arduinofast-prewarm-seed.json';
/** v2 keeps one atomic marker per immutable bundle/seed version. */
export const PREWARM_CACHE_SEED_STATE_DIR = '.sketchforge-prewarm-seeds';
const SEED_STATE_VERSION = 2;
const DEFAULT_UNVERSIONED_SEED = 'unversioned-v2';
const L0_CACHE_NAMESPACE = 'l0';

export type PrewarmCacheSeedResult =
  | { status: 'seeded'; resumed: boolean; merged: boolean }
  | { status: 'already-seeded' }
  | { status: 'identity-mismatch' };

export interface PrewarmCacheSeedOptions {
  cacheDir: string;
  seedDir: string;
  runtimeBundleId?: string;
  seedBundleId?: string;
  /**
   * Immutable edition of this seed inside a compiler bundle. Docker includes
   * the target family and board allowlist so two valid seeds never share a
   * completion marker accidentally.
   */
  seedVersion?: string;
}

interface SeedState {
  version: typeof SEED_STATE_VERSION;
  status: 'in-progress' | 'complete';
  bundleId: string | null;
  seedVersion: string;
}

interface LegacySeedState {
  version: 1;
  status: 'in-progress' | 'complete';
  bundleId: string | null;
}

function normalized(value: string | undefined): string | null {
  return value?.trim() || null;
}

function resolvedSeedVersion(seedVersion: string | undefined, bundleId: string | null): string {
  return normalized(seedVersion) ?? bundleId ?? DEFAULT_UNVERSIONED_SEED;
}

function stateIdentity(bundleId: string | null, seedVersion: string): string {
  return createHash('sha256')
    .update('sketchforge-prewarm-seed-state-v2\0')
    .update(bundleId ?? '')
    .update('\0')
    .update(seedVersion)
    .digest('hex');
}

export function prewarmCacheSeedStatePath(
  cacheDir: string,
  bundleId?: string,
  seedVersion?: string,
): string {
  const normalizedBundleId = normalized(bundleId);
  const version = resolvedSeedVersion(seedVersion, normalizedBundleId);
  return join(
    resolve(cacheDir),
    PREWARM_CACHE_SEED_STATE_DIR,
    `${stateIdentity(normalizedBundleId, version)}.json`,
  );
}

function pathStat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function ensureRealDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o750 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Prewarm cache path is not a real directory: ${path}`);
  }
}

function writeSeedState(path: string, state: SeedState): void {
  ensureRealDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o640,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readSeedState(path: string, bundleId: string | null, seedVersion: string): SeedState | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SeedState>;
    if (
      parsed.version !== SEED_STATE_VERSION
      || (parsed.status !== 'in-progress' && parsed.status !== 'complete')
      || parsed.bundleId !== bundleId
      || parsed.seedVersion !== seedVersion
    ) {
      return null;
    }
    return {
      version: SEED_STATE_VERSION,
      status: parsed.status,
      bundleId,
      seedVersion,
    };
  } catch {
    return null;
  }
}

function readLegacySeedState(cacheDir: string, bundleId: string | null): LegacySeedState | null {
  try {
    const path = join(cacheDir, LEGACY_PREWARM_CACHE_SEED_STATE_FILE);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LegacySeedState>;
    if (
      parsed.version !== 1
      || (parsed.status !== 'in-progress' && parsed.status !== 'complete')
      || parsed.bundleId !== bundleId
    ) {
      return null;
    }
    return {
      version: 1,
      status: parsed.status,
      bundleId,
    };
  } catch {
    return null;
  }
}

function cacheHasData(cacheDir: string): boolean {
  return readdirSync(cacheDir).some((entry) => (
    entry !== LEGACY_PREWARM_CACHE_SEED_STATE_FILE
    && entry !== PREWARM_CACHE_SEED_STATE_DIR
  ));
}

function validateSeedTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Prewarm cache seed contains a symbolic link: ${path}`);
  }
  if (stat.isFile()) return;
  if (!stat.isDirectory()) {
    throw new Error(`Prewarm cache seed contains an unsupported filesystem entry: ${path}`);
  }
  for (const entry of readdirSync(path)) validateSeedTree(join(path, entry));
}

function destinationAppeared(error: unknown, destination: string): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return ['EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR', 'EPERM'].includes(code ?? '')
    && pathStat(destination) !== null;
}

/**
 * Publishes one immutable cache entry without replacing an existing path.
 * Files use an exclusive hard-link publish; directories are fully staged
 * before rename, so another worker never observes a half-copied ready entry.
 */
function copyEntryIfMissing(source: string, destination: string): boolean {
  if (pathStat(destination) !== null) return false;

  const temporary = join(
    dirname(destination),
    `.sketchforge-prewarm-copy.${process.pid}.${randomUUID()}.tmp`,
  );
  const sourceStat = lstatSync(source);
  try {
    cpSync(source, temporary, {
      recursive: sourceStat.isDirectory(),
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });

    if (sourceStat.isDirectory()) {
      if (pathStat(destination) !== null) return false;
      try {
        renameSync(temporary, destination);
        return true;
      } catch (error) {
        if (destinationAppeared(error, destination)) return false;
        throw error;
      }
    }

    try {
      // link(2) fails with EEXIST instead of replacing a concurrently
      // published cache file, unlike rename(2) on POSIX.
      linkSync(temporary, destination);
      return true;
    } catch (error) {
      if (destinationAppeared(error, destination)) return false;
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EXDEV', 'ENOSYS', 'ENOTSUP'].includes(code ?? '')) throw error;
      try {
        copyFileSync(temporary, destination, constants.COPYFILE_EXCL);
        return true;
      } catch (fallbackError) {
        if (destinationAppeared(fallbackError, destination)) return false;
        throw fallbackError;
      }
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

function mergeDirectoryChildren(source: string, destination: string, depth: number): number {
  const destinationStat = pathStat(destination);
  if (!destinationStat) return copyEntryIfMissing(source, destination) ? 1 : 0;
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) return 0;

  let copied = 0;
  for (const entry of readdirSync(source)) {
    const sourceEntry = join(source, entry);
    const destinationEntry = join(destination, entry);
    const sourceStat = lstatSync(sourceEntry);
    if (depth > 1 && sourceStat.isDirectory()) {
      copied += mergeDirectoryChildren(sourceEntry, destinationEntry, depth - 1);
    } else if (copyEntryIfMissing(sourceEntry, destinationEntry)) {
      copied++;
    }
  }
  return copied;
}

/**
 * Cache entries are content-addressed. Existing entries are opaque and never
 * changed; only missing entries are atomically added. L0 has one extra shard
 * directory, so it is merged one level deeper than derived-cache namespaces.
 */
function mergeSeedContents(seedDir: string, cacheDir: string): number {
  let copied = 0;
  for (const entry of readdirSync(seedDir)) {
    if (entry === LEGACY_PREWARM_CACHE_SEED_STATE_FILE || entry === PREWARM_CACHE_SEED_STATE_DIR) {
      continue;
    }
    const source = join(seedDir, entry);
    const destination = join(cacheDir, entry);
    const stat = lstatSync(source);
    if (stat.isDirectory()) {
      copied += mergeDirectoryChildren(source, destination, entry === L0_CACHE_NAMESPACE ? 2 : 1);
    } else if (copyEntryIfMissing(source, destination)) {
      copied++;
    }
  }
  return copied;
}

/**
 * Merges an immutable seed once per bundle/seed version. Content-addressed
 * entries already present in a production volume are retained byte-for-byte.
 * An in-progress marker is resumable because each published entry is itself
 * complete and missing-only.
 */
export function seedPrewarmedCache(options: PrewarmCacheSeedOptions): PrewarmCacheSeedResult {
  const cacheDir = resolve(options.cacheDir);
  const seedDir = resolve(options.seedDir);
  if (!isSafeEsp32PrewarmCacheDir(cacheDir)) {
    throw new Error(`Refusing filesystem root as AF_CACHE_DIR: ${cacheDir}`);
  }
  if (!isSafeEsp32PrewarmCacheDir(seedDir) || cacheDir === seedDir) {
    throw new Error(`Invalid prewarm cache seed directory: ${seedDir}`);
  }
  if (!existsSync(seedDir) || !lstatSync(seedDir).isDirectory()) {
    throw new Error(`Prewarm cache seed directory is missing: ${seedDir}`);
  }
  if (lstatSync(seedDir).isSymbolicLink()) {
    throw new Error(`Prewarm cache seed directory cannot be a symbolic link: ${seedDir}`);
  }
  if (readdirSync(seedDir).length === 0) {
    throw new Error(`Prewarm cache seed directory is empty: ${seedDir}`);
  }
  validateSeedTree(seedDir);

  const runtimeBundleId = normalized(options.runtimeBundleId);
  const seedBundleId = normalized(options.seedBundleId);
  // A versioned side with an unversioned peer cannot prove compatibility.
  if (runtimeBundleId !== seedBundleId) return { status: 'identity-mismatch' };

  const seedVersion = resolvedSeedVersion(options.seedVersion, seedBundleId);
  ensureRealDirectory(cacheDir);
  const statePath = prewarmCacheSeedStatePath(cacheDir, seedBundleId ?? undefined, seedVersion);
  const state = readSeedState(statePath, seedBundleId, seedVersion);
  if (state?.status === 'complete') return { status: 'already-seeded' };

  const legacyState = readLegacySeedState(cacheDir, seedBundleId);
  const resumed = state?.status === 'in-progress' || legacyState?.status === 'in-progress';
  const merged = cacheHasData(cacheDir);
  writeSeedState(statePath, {
    version: SEED_STATE_VERSION,
    status: 'in-progress',
    bundleId: seedBundleId,
    seedVersion,
  });
  mergeSeedContents(seedDir, cacheDir);
  writeSeedState(statePath, {
    version: SEED_STATE_VERSION,
    status: 'complete',
    bundleId: seedBundleId,
    seedVersion,
  });
  return { status: 'seeded', resumed, merged };
}
