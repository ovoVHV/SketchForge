/** Release-time AVR Core/LTO cache preparation. No service is started. */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BoardRegistry,
  CompileService,
  LibraryRegistry,
  LocalExecutor,
  detectLocalToolchain,
  isSafeEsp32PrewarmCacheDir,
  planPrebuildMatrix,
  resolveEsp32PrewarmCacheDir,
  type CompileResult,
} from '@sketchforge/core';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKETCH = 'void setup() {}\nvoid loop() {}\n';

export interface AvrPrewarmOptions {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

function selectedBoards(raw: string | undefined, available: readonly string[]): string[] {
  if (raw === undefined || !raw.trim()) return [...available];
  const selected = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
  if (selected.length === 0) throw new Error('AF_PREWARM_BOARDS does not contain a board FQBN');
  const unknown = selected.filter((fqbn) => !available.includes(fqbn));
  if (unknown.length > 0) throw new Error(`unknown AVR prewarm board(s): ${unknown.join(', ')}`);
  return selected;
}

function summary(result: Extract<CompileResult, { status: 'error' }>): string {
  return [result.reason, result.message, ...result.diagnostics.slice(0, 3).map((item) => item.message)]
    .filter(Boolean).join('; ');
}

export async function prewarmAvrCaches(options: AvrPrewarmOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const detected = detectLocalToolchain();
  if (!detected.avr) throw new Error('No local AVR toolchain was found; prewarm must run in the AVR release image');

  const cacheDir = resolveEsp32PrewarmCacheDir(detected.cacheDir, env.AF_PREWARM_CACHE_DIR);
  if (!isSafeEsp32PrewarmCacheDir(cacheDir)) throw new Error(`Refusing filesystem root as AF_PREWARM_CACHE_DIR: ${cacheDir}`);
  const registry = BoardRegistry.fromDirectory(join(repoRoot, 'boards'));
  const available = registry.list().filter((board) => board.arch === 'avr');
  const allowlist = new Set(selectedBoards(env.AF_PREWARM_BOARDS, available.map((board) => board.fqbn)));
  const boards = available.filter((board) => allowlist.has(board.fqbn));
  const entries = planPrebuildMatrix(boards, ['core']);
  const compiler = new CompileService({
    boards: registry,
    toolchain: { ...detected, cacheDir },
    executor: new LocalExecutor(),
    libraries: LibraryRegistry.fromDirectories(detected.librariesDirs),
    compilerBundleId: env.AF_COMPILER_BUNDLE_ID ?? 'development',
  });

  log(`AVR release prewarm: ${entries.length} board/MCU/LTO identities in ${cacheDir}`);
  let failures = 0;
  for (const entry of entries) {
    const ir = await compiler.planActionGraph({
      board: entry.fqbn,
      options: entry.options,
      files: [{ name: 'prewarm.ino', content: SKETCH }],
    });
    const first = await compiler.compileBuildIR(ir);
    if (first.status !== 'success') {
      failures++;
      error(`FAIL ${entry.fqbn} ${JSON.stringify(entry.options)}: ${summary(first)}`);
      continue;
    }
    const replay = await compiler.compileBuildIR(ir);
    if (replay.status !== 'success' || !replay.cached) {
      failures++;
      error(`FAIL ${entry.fqbn} ${JSON.stringify(entry.options)}: Action cache replay missed`);
      continue;
    }
    log(`OK ${entry.fqbn} ${JSON.stringify(entry.options)} (${ir.graph.actions.length} Actions)`);
  }
  if (failures > 0) throw new Error(`AVR cache prewarm failed for ${failures}/${entries.length} identities`);
}

export async function runAvrPrewarmCli(): Promise<void> {
  try {
    await prewarmAvrCaches();
  } catch (error) {
    console.error(`AVR cache prewarm failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
