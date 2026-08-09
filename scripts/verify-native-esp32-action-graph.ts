import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  BoardRegistry,
  CompileService,
  LocalExecutor,
  detectLocalToolchain,
  type BuildIR,
  type CompileResult,
  type SandboxExecutor,
} from '../packages/core/src/index.js';
import { loadPublishedPlatformManifests } from '../packages/server/src/platform-manifests.js';
import {
  createActionGraphEvidence,
  writeActionGraphEvidence,
} from './ck-action-graph-evidence.mjs';

const TARGETS = [
  { fqbn: 'esp32:esp32:esp32', sdkTarget: 'esp32', bootloaderOffset: '0x1000' },
  { fqbn: 'esp32:esp32:esp32s2', sdkTarget: 'esp32s2', bootloaderOffset: '0x1000' },
  { fqbn: 'esp32:esp32:esp32s3', sdkTarget: 'esp32s3', bootloaderOffset: '0x0' },
  { fqbn: 'esp32:esp32:esp32c3', sdkTarget: 'esp32c3', bootloaderOffset: '0x0' },
  { fqbn: 'esp32:esp32:esp32c6', sdkTarget: 'esp32c6', bootloaderOffset: '0x0' },
] as const;

interface EvidenceActionResult {
  actionId: string;
  actionKey: string;
  cached: boolean;
}

type EvidenceCompileResult = CompileResult & {
  durationMs: number;
  actions: EvidenceActionResult[];
};

function sourceRevisionFromEnvironment(): string {
  const revision = String(process.env.CK_SOURCE_REVISION ?? process.env.GITHUB_SHA ?? '').trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) {
    throw new Error('CK_SOURCE_REVISION or GITHUB_SHA must provide the current 40- or 64-character commit digest');
  }
  return revision;
}

async function compileWithActionEvidence(
  compiler: CompileService,
  ir: BuildIR,
): Promise<EvidenceCompileResult> {
  const actions: EvidenceActionResult[] = [];
  const started = Date.now();
  const result = await compiler.compileBuildIR(ir, () => {}, {
    onProgress: ({ action, cached }) => {
      actions.push({ actionId: action.id, actionKey: action.cacheKey, cached });
    },
  });
  return { ...result, durationMs: Date.now() - started, actions };
}

async function main(): Promise<void> {
  const sourceRevision = sourceRevisionFromEnvironment();
  const root = join(process.cwd(), 'var', 'verify-native-esp32-dag');
  const runRoot = join(root, `run-${sourceRevision.slice(0, 12)}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const detected = detectLocalToolchain();
  if (!detected.esp32?.riscvBinDir || !detected.esp32.xtensaBinDir) {
    throw new Error('ESP32 RISC-V and Xtensa native toolchains are required');
  }
  const cliTargets = process.argv.slice(2);
  const configuredTargets = cliTargets.length > 0
    ? cliTargets
    : [process.env.CK_ESP32_NATIVE_TARGETS ?? TARGETS.map((target) => target.fqbn).join(',')];
  const selectedFqbns = new Set(
    configuredTargets
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const targets = TARGETS.filter((target) => selectedFqbns.has(target.fqbn));
  const unknownTargets = [...selectedFqbns].filter((fqbn) => !TARGETS.some((target) => target.fqbn === fqbn));
  if (unknownTargets.length > 0) throw new Error(`unknown ESP32 native target(s): ${unknownTargets.join(', ')}`);
  if (targets.length === 0) throw new Error('no ESP32 native targets selected');
  for (const target of targets) {
    if (!detected.esp32.sdkRootFor(target.sdkTarget)) {
      throw new Error(`ESP32 native SDK is required for ${target.fqbn} (${target.sdkTarget})`);
    }
  }
  const local = new LocalExecutor();
  const tracingExecutor: SandboxExecutor = {
    name: local.name,
    isolationLevel: local.isolationLevel,
    exec: async (request) => {
      const result = await local.exec(request);
      if (result.code !== 0) {
        console.error(JSON.stringify({ command: request.command, args: request.args }, null, 2));
        console.error(result.stderr || result.stdout);
      }
      return result;
    },
  };
  const compiler = new CompileService({
    boards: BoardRegistry.fromDirectory(join(process.cwd(), 'boards')),
    toolchain: {
      ...detected,
      cacheDir: join(runRoot, 'cache'),
      workDir: join(runRoot, 'work'),
    },
    executor: tracingExecutor,
    compilerBundleId: 'native-esp32-action-graph-smoke-v1',
    platformManifests: loadPublishedPlatformManifests({ repoRoot: process.cwd() }),
  });
  const results = [];
  for (const target of targets) {
      const request = {
        board: target.fqbn,
        files: [{
          name: 'main.ino',
          content: 'void setup() { pinMode(8, OUTPUT); }\nvoid loop() { digitalWrite(8, HIGH); delay(10); }\n',
        }],
      };
      const ir = await compiler.planActionGraph(request);
      const incrementalRequest = {
        ...request,
        files: request.files.map((file) => ({
          ...file,
          content: file.name === 'main.ino' ? file.content.replace('delay(10)', 'delay(11)') : file.content,
        })),
      };
      if (incrementalRequest.files[0]?.content === request.files[0]?.content) {
        throw new Error(`${target.fqbn} incremental evidence did not modify main.ino`);
      }
      const incrementalIr = await compiler.planActionGraph(incrementalRequest);
      const result = await compileWithActionEvidence(compiler, ir);
      const firstMs = result.durationMs;
      assertFirmware(result, target.bootloaderOffset);
      const replay = await compileWithActionEvidence(compiler, ir);
      const replayMs = replay.durationMs;
      assertFirmware(replay, target.bootloaderOffset);
      if (replay.actions.length !== ir.graph.actions.length || replay.actions.some((action) => !action.cached)) {
        throw new Error(`${target.fqbn} did not replay every Action from the Action cache`);
      }
      assertArtifactIdentity(result, replay);
      const incremental = await compileWithActionEvidence(compiler, incrementalIr);
      assertFirmware(incremental, target.bootloaderOffset);
      const evidence = createActionGraphEvidence({
        executor: 'native',
        target: target.sdkTarget,
        fqbn: target.fqbn,
        ir,
        firstResult: result,
        replayResult: replay,
        incrementalIr,
        incrementalResult: incremental,
        mainSourcePath: 'main.ino',
        sourceRevision,
      });
      const evidencePath = await writeActionGraphEvidence(evidence);
      if (evidence.status !== 'pass') {
        throw new Error(`${target.fqbn} did not produce passing runtime evidence`);
      }
      results.push({
        board: request.board,
        actions: ir.graph.actions.length,
        actionKinds: Object.fromEntries(['compile', 'archive', 'link', 'transform'].map((kind) => [
          kind, ir.graph.actions.filter((action) => action.kind === kind).length,
        ])),
        firmwareBytes: result.artifacts.find((artifact) => artifact.name === 'firmware.bin')!.size,
        firmwareSha256: result.artifacts.find((artifact) => artifact.name === 'firmware.bin')!.sha256,
        staticArtifacts: result.staticArtifacts.map((artifact) => ({
          name: artifact.name,
          offset: artifact.offset,
          size: artifact.size,
          sha256: artifact.sha256,
        })),
        firstCached: result.cached,
        replayCached: replay.cached,
        firstMs,
        replayMs,
        incrementalMs: incremental.durationMs,
        buildIrSha256: evidence.buildIr.sha256,
        evidence: evidencePath,
      });
  }
  console.log(JSON.stringify({
    status: 'pass',
    targets: results,
  }, null, 2));
}

function assertFirmware(
  result: CompileResult,
  bootloaderOffset: string,
): asserts result is Extract<CompileResult, { status: 'success' }> {
  if (result.status === 'error') {
    const diagnostics = result.diagnostics.map((item) => `${item.file}:${item.line}: ${item.message}`).join('\n');
    throw new Error(`${result.reason}: ${result.message}${diagnostics ? `\n${diagnostics}` : ''}`);
  }
  const firmware = result.artifacts.find((artifact) => artifact.name === 'firmware.bin');
  if (!firmware || firmware.offset !== '0x10000' || firmware.size < 1_000 || !firmware.base64) {
    throw new Error('native ESP32 DAG produced no valid firmware.bin at 0x10000');
  }
  const expectedStatic = new Map([
    ['bootloader.bin', bootloaderOffset],
    ['partitions.bin', '0x8000'],
    ['boot_app0.bin', '0xe000'],
  ]);
  if (result.staticArtifacts.length !== expectedStatic.size) {
    throw new Error(`native ESP32 DAG produced ${result.staticArtifacts.length} static artifacts, expected ${expectedStatic.size}`);
  }
  for (const artifact of result.staticArtifacts) {
    if (
      expectedStatic.get(artifact.name) !== artifact.offset
      || artifact.size <= 0
      || !artifact.base64
      || !artifact.sha256
    ) {
      throw new Error(`native ESP32 DAG produced invalid static artifact: ${artifact.name}`);
    }
  }
}

function assertArtifactIdentity(
  first: Extract<CompileResult, { status: 'success' }>,
  replay: Extract<CompileResult, { status: 'success' }>,
): void {
  const identity = (result: Extract<CompileResult, { status: 'success' }>) => (
    [...result.artifacts, ...result.staticArtifacts]
      .map((artifact) => ({ name: artifact.name, offset: artifact.offset, sha256: artifact.sha256, size: artifact.size }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  );
  if (JSON.stringify(identity(first)) !== JSON.stringify(identity(replay))) {
    throw new Error(
      'native ESP32 Action-cache replay changed artifact identity\n'
      + `first=${JSON.stringify(identity(first))}\n`
      + `replay=${JSON.stringify(identity(replay))}`,
    );
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
