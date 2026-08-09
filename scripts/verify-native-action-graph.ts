import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  BoardRegistry,
  CompileService,
  LocalExecutor,
  detectLocalToolchain,
  type CompileRequest,
  type CompileResult,
} from '../packages/core/src/index.js';

async function main(): Promise<void> {
  const root = join(process.cwd(), 'var');
  mkdirSync(root, { recursive: true });
  const temporary = mkdtempSync(join(root, 'verify-native-dag-'));

  try {
  const detected = detectLocalToolchain();
  if (!detected.avr) throw new Error('AVR toolchain is not installed');
  const toolchain = {
    ...detected,
    cacheDir: join(temporary, 'cache'),
    workDir: join(temporary, 'work'),
  };
  const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
  const compiler = new CompileService({
    boards,
    toolchain,
    executor: new LocalExecutor(),
    compilerBundleId: 'native-action-graph-smoke-v1',
  });
  const requests: CompileRequest[] = [{
    board: 'arduino:avr:uno',
    files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
  }];
  if (compiler.libraries.get('Wire', 'avr')) {
    requests.push({
      board: 'arduino:avr:uno',
      files: [{
        name: 'main.ino',
        content: '#include <Wire.h>\nvoid setup() { Wire.begin(); }\nvoid loop() {}\n',
      }],
    });
  }

  const summaries = [];
  for (const request of requests) {
    const ir = await compiler.planActionGraph(request);
    if (!ir.graph.actions.some((action) => action.kind === 'compile')
      || !ir.graph.actions.some((action) => action.kind === 'archive')
      || !ir.graph.actions.some((action) => action.kind === 'link')
      || !ir.graph.actions.some((action) => action.kind === 'transform')) {
      throw new Error('planned IR does not contain the complete native Action Graph');
    }

    const first = await compiler.compile(request);
    assertFirmware(first, false);
    const second = await compiler.compileBuildIR(ir);
    assertFirmware(second, true);
    summaries.push({
      board: request.board,
      libraries: ir.packs.libraries.packs.map((pack) => pack.name),
      actions: ir.graph.actions.length,
      firmwareBytes: first.status === 'success' ? first.artifacts[0]!.size : 0,
      cached: second.status === 'success' && second.cached,
    });
  }
    console.log(JSON.stringify({ status: 'pass', builds: summaries }, null, 2));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function assertFirmware(result: CompileResult, cached: boolean): void {
  if (result.status === 'error') throw new Error(`${result.reason}: ${result.message}`);
  const firmware = result.artifacts.find((artifact) => artifact.name === 'firmware.hex');
  if (!firmware || firmware.size === 0 || !firmware.base64) throw new Error('native DAG produced no firmware.hex');
  if (result.cached !== cached) throw new Error(`expected cached=${String(cached)}, got ${String(result.cached)}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
