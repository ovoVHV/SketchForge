/**
 * ESP32 cache preparation shared by the local development command and the
 * compiled worker-image CLI. This is intentionally not an HTTP or worker
 * runtime feature: it only prepares immutable toolchain-derived caches.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BoardRegistry,
  CompileService,
  LibraryRegistry,
  LocalExecutor,
  detectLocalToolchain,
  esp32BoardSupported,
  isSafeEsp32PrewarmCacheDir,
  parseEsp32PrewarmBoardAllowlist,
  planPrebuildMatrix,
  resolveEsp32PrewarmCacheDir,
  selectEsp32PrewarmBoards,
  type CompileEvent,
  type CompileResult,
} from '@sketchforge/core';
import { loadPublishedPlatformManifests } from './platform-manifests.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, '..', '..', '..');
const MINIMAL_SKETCH = `void setup() {}
void loop() {}
`;

type PrewarmMatrixMode = 'default' | 'core' | 'static' | 'all';

function prewarmMatrixMode(raw: string | undefined): PrewarmMatrixMode {
  const value = (raw ?? 'default').trim().toLowerCase();
  if (value === 'default' || value === 'core' || value === 'static' || value === 'all') return value;
  throw new Error('AF_PREWARM_MATRIX must be default, core, static, or all');
}

export interface Esp32PrewarmOptions {
  /** Repository root containing the checked-in boards directory. */
  repoRoot?: string;
  /** Injectable for tests; defaults to the current process environment. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for callers that need to collect preparation progress. */
  log?: (message: string) => void;
  error?: (message: string) => void;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  return `${(ms / 1_000).toFixed(1)} s`;
}

function errorSummary(result: Extract<CompileResult, { status: 'error' }>): string {
  const diagnostics = result.diagnostics
    .slice(0, 3)
    .map((diagnostic) => `${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`);
  return [result.reason, result.message, ...diagnostics].filter(Boolean).join('\n      ');
}

/**
 * Prepares the local ESP32 Action cache for every selected board.
 * It never clears or serves a cache, and deliberately uses LocalExecutor so
 * image construction does not depend on runtime sandbox privileges.
 */
export async function prewarmEsp32Caches(options: Esp32PrewarmOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;

  log('ESP32 cache prewarm: CI/build-image preparation only.');
  log('No service is started, no public host is contacted, and this command never clears the cache.');

  const toolchain = detectLocalToolchain();
  if (!toolchain.esp32) {
    throw new Error('No local ESP32 toolchain was found; prewarm must run inside the ESP32 build image or CI worker.');
  }

  const cacheDir = resolveEsp32PrewarmCacheDir(
    toolchain.cacheDir,
    env.AF_PREWARM_CACHE_DIR,
  );
  if (!isSafeEsp32PrewarmCacheDir(cacheDir)) {
    throw new Error(`Refusing filesystem root as AF_PREWARM_CACHE_DIR: ${cacheDir}`);
  }

  const boards = BoardRegistry.fromDirectory(join(repoRoot, 'boards'));
  const platformManifests = loadPublishedPlatformManifests({
    repoRoot,
    ...(env.AF_PLATFORM_RELEASE_PATH ? { releasePath: env.AF_PLATFORM_RELEASE_PATH } : {}),
  });
  const allowlist = parseEsp32PrewarmBoardAllowlist(env.AF_PREWARM_BOARDS);
  const selection = selectEsp32PrewarmBoards(
    boards.list(),
    (board) => esp32BoardSupported(toolchain.esp32!, board),
    allowlist,
  );

  for (const board of selection.unavailable) {
    log(`SKIP ${board.fqbn}: local toolchain does not include its compiler or SDK inputs`);
  }
  if (selection.errors.length > 0) {
    throw new Error(selection.errors.join('\n'));
  }

  log(`Cache directory: ${cacheDir} (reused; never cleared by this command)`);
  log(`Boards: ${selection.boards.map((board) => board.fqbn).join(', ')}`);
  const matrixMode = prewarmMatrixMode(env.AF_PREWARM_MATRIX);
  const planned = matrixMode === 'default'
    ? selection.boards.map((board) => ({
        id: `${board.fqbn}-default`, fqbn: board.fqbn, options: {} as Record<string, string>,
      }))
    : planPrebuildMatrix(
        selection.boards,
        matrixMode === 'core' ? ['core'] : matrixMode === 'static' ? ['static-firmware'] : ['core', 'static-firmware'],
      );
  const entries = [...new Map(planned.map((candidate) => [
    `${candidate.fqbn}:${JSON.stringify(candidate.options)}`,
    candidate,
  ])).values()];
  log(`Prewarm matrix: ${matrixMode} (${entries.length} unique board/option identities)`);

  // Match the fallback worker's identity. CI must pass the same
  // AF_COMPILER_BUNDLE_ID that production workers will use, otherwise a
  // prebuilt cache would correctly be treated as belonging to another bundle.
  const compilerBundleId = env.AF_COMPILER_BUNDLE_ID ?? 'development';
  const libraries = LibraryRegistry.fromDirectories(toolchain.librariesDirs);
  const serviceOptions = {
    boards,
    toolchain: { ...toolchain, cacheDir },
    executor: new LocalExecutor(),
    libraries,
    compilerBundleId,
    platformManifests,
  };
  const service = new CompileService(serviceOptions);

  let failures = 0;
  for (const entry of entries) {
    const board = selection.boards.find((candidate) => candidate.fqbn === entry.fqbn)!;
    let lastProgress = '';
    const onEvent = (event: CompileEvent): void => {
      if (event.event !== 'progress') return;
      const progress = `${event.stage}\0${event.detail ?? ''}`;
      if (progress === lastProgress) return;
      lastProgress = progress;
      const detail = event.detail ? `: ${event.detail}` : '';
      log(`  ${board.fqbn} [${event.stage}]${detail}`);
    };

    log(`\nPREWARM ${board.fqbn} ${JSON.stringify(entry.options)}`);
    const startedAt = Date.now();
    const request = {
      board: board.fqbn,
      files: [{ name: 'prewarm.ino', content: MINIMAL_SKETCH }],
      ...(Object.keys(entry.options).length === 0 ? {} : { options: entry.options }),
    };
    const ir = await service.planActionGraph(request);
    const first = await service.compileBuildIR(ir, onEvent);
    const firstElapsed = Date.now() - startedAt;

    if (first.status !== 'success') {
      failures++;
      error(`FAIL ${board.fqbn}  ${formatDuration(firstElapsed)}\n      ${errorSummary(first)}`);
      continue;
    }

    const replayStartedAt = Date.now();
    const replay = await service.compileBuildIR(ir);
    const replayElapsed = Date.now() - replayStartedAt;
    if (replay.status !== 'success') {
      failures++;
      error(`FAIL ${board.fqbn} replay  ${formatDuration(replayElapsed)}\n      ${errorSummary(replay)}`);
      continue;
    }
    if (!replay.cached) {
      failures++;
      error(`FAIL ${board.fqbn}: Action cache replay was not fully cached`);
      continue;
    }
    log(
      `OK   ${board.fqbn}  ${ir.graph.actions.length} Actions ${formatDuration(firstElapsed)}; ` +
      `Action cache replay ${formatDuration(replayElapsed)}`,
    );
  }

  if (failures > 0) {
    throw new Error(`ESP32 cache prewarm failed for ${failures}/${entries.length} matrix entries`);
  }
  log(`\nESP32 cache prewarm completed for ${entries.length} matrix entries.`);
}

export async function runEsp32PrewarmCli(): Promise<void> {
  try {
    await prewarmEsp32Caches();
  } catch (error) {
    console.error(`ESP32 cache prewarm failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
