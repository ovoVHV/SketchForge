/** Entrypoint used only by the Docker `prewarmed` worker target. */

import { spawn } from 'node:child_process';
import { seedPrewarmedCache, type PrewarmCacheSeedResult } from './prewarm-cache-seed.js';
import {
  loadCompilerRuntimeConfiguration,
  workerHostRuntimeIdentity,
} from './compiler-runtime-release.js';
import { WORKER_POOLS, type WorkerPool } from './worker-pools.js';
import { workerRuntimeCacheDirectory } from './worker-runtime-cache.js';

function logSeedResult(result: PrewarmCacheSeedResult): void {
  switch (result.status) {
    case 'seeded':
      if (result.resumed) {
        console.log('prewarmed cache seed resumed; missing immutable entries merged');
      } else if (result.merged) {
        console.log('prewarmed cache seed merged into existing runtime volume without replacing entries');
      } else {
        console.log('prewarmed cache seeded into empty runtime volume');
      }
      return;
    case 'already-seeded':
      console.log('prewarmed cache bundle and seed version already initialized');
      return;
    case 'identity-mismatch':
      console.warn('prewarmed cache seed skipped because its compiler bundle identity differs from runtime');
  }
}

async function runCommand(command: string, args: string[]): Promise<number> {
  const child = spawn(command, args, { stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals): void => {
    if (!child.killed) child.kill(signal);
  };
  process.once('SIGTERM', () => forward('SIGTERM'));
  process.once('SIGINT', () => forward('SIGINT'));

  return await new Promise((resolveExit) => {
    child.once('error', (error) => {
      console.error(`failed to start worker command: ${error.message}`);
      resolveExit(1);
    });
    child.once('exit', (code, signal) => {
      resolveExit(code ?? (signal ? 1 : 0));
    });
  });
}

async function main(): Promise<void> {
  const cacheRoot = process.env.AF_CACHE_DIR ?? '/var/afcache';
  const compilerBundleId = process.env.AF_COMPILER_BUNDLE_ID ?? 'development';
  const pool = process.env.AF_WORKER_POOL as WorkerPool;
  if (!WORKER_POOLS.includes(pool)) throw new Error('AF_WORKER_POOL is invalid');
  const runtimeConfiguration = loadCompilerRuntimeConfiguration(
    process.env,
    compilerBundleId,
    process.env.NODE_ENV === 'production',
  );
  const hostRuntimeIdentity = workerHostRuntimeIdentity(
    runtimeConfiguration,
    pool,
    process.env,
  );
  const cacheDir = workerRuntimeCacheDirectory(
    cacheRoot,
    compilerBundleId,
    runtimeConfiguration.releaseId,
    pool,
    hostRuntimeIdentity,
  );
  const seedDir = process.env.AF_PREWARM_SEED_DIR ?? '/opt/sketchforge/prewarm-cache';
  logSeedResult(seedPrewarmedCache({
    cacheDir,
    seedDir,
    runtimeBundleId: compilerBundleId,
    seedBundleId: process.env.AF_PREWARM_SEED_BUNDLE_ID,
    seedVersion: process.env.AF_PREWARM_SEED_VERSION,
  }));
  // The child worker or publication CLI must consume the same runtime-scoped
  // cache that received the immutable seed. The directory resolver is
  // idempotent, so worker.ts can safely verify it again.
  process.env.AF_CACHE_DIR = cacheDir;

  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('prewarmed cache entrypoint requires a worker command');
  process.exitCode = await runCommand(command, args);
}

void main().catch((error: unknown) => {
  console.error(`prewarmed cache initialization failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
