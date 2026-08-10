#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static boundary audit for the CK Build IR migration.
 *
 * This reads source and deployment configuration only. Runtime compiler and
 * hardware gates are listed in externalGates for the appropriate CI runners.
 */

const BROWSER_TARGETS = Object.freeze([
  'esp32:esp32:esp32',
  'esp32:esp32:esp32s2',
  'esp32:esp32:esp32s3',
  'esp32:esp32:esp32c3',
  'esp32:esp32:esp32c6',
]);

const BROWSER_BOUNDARY_FILES = Object.freeze([
  'packages/web/public/browser-esp32.js',
  'packages/web/public/ck-build-ir-envelope.js',
  'packages/web/public/ck-browser-executor.js',
  'packages/web/public/ck-esp32-partitions.js',
  'packages/web/public/ck-blockly-generator.js',
  'packages/web/public/ck-firmware-patch.js',
  'packages/web/public/esp32/v1/c3-runtime.js',
]);

const BROWSER_ADAPTER_FILES = Object.freeze([
  'packages/web/public/esp32/v2/c3-compiler.js',
  'packages/web/public/esp32/v2/c3-worker.js',
  'packages/web/public/esp32/v2/c6-worker.js',
  'packages/web/public/esp32/v2/esp32-worker.js',
  'packages/web/public/esp32/v2/s2-worker.js',
  'packages/web/public/esp32/v2/s3-worker.js',
]);

const ACTION_GRAPH_SCRIPTS = Object.freeze([
  'scripts/verify-ck-browser-esp32-action-graph.mjs',
  'scripts/verify-ck-browser-s2-action-graph.mjs',
  'scripts/verify-ck-browser-s3-action-graph.mjs',
  'scripts/verify-ck-browser-c3-action-graph.mjs',
  'scripts/verify-ck-browser-c6-action-graph.mjs',
  'scripts/verify-native-esp32-action-graph.ts',
  'scripts/ck-action-graph-evidence.mjs',
  'scripts/audit-ck-action-graph-evidence.mjs',
  'scripts/verify-ck-browser-library-matrix.mjs',
  'scripts/merge-ck-browser-library-matrix-reports.mjs',
  'scripts/audit-ck-browser-library-release.mjs',
]);

const DETERMINISTIC_PLANNING_FILES = Object.freeze([
  'packages/core/src/build-ir/platform-planning.ts',
  'packages/core/src/esp32/custom-partitions.ts',
  'packages/core/src/compile.ts',
  'packages/web/public/ck-platform-planning.js',
  'packages/web/public/ck-esp32-partitions.js',
  'packages/web/public/ck-build-ir-envelope.js',
  'scripts/publish-ck-platform-manifests.mjs',
]);

const RELEASE_PLATFORM_FILES = Object.freeze([
  'packages/core/src/featured-prebuild.ts',
  'packages/core/src/blocks/generator.ts',
  'packages/core/src/firmware/patch.ts',
  'packages/server/src/materialize-featured-libraries.ts',
  'packages/server/src/prebuild-firmware-assets.ts',
  'packages/server/src/prebuild-featured-firmware.ts',
  'docker/Dockerfile.worker-avr',
  'docker/Dockerfile.worker-esp32',
  '.github/workflows/prebuild-worker-images.yml',
]);

const AUTOSCALE_FILES = Object.freeze([
  'packages/server/src/autoscale.ts',
  'packages/server/src/autoscale-service.ts',
  'scripts/simulate-autoscale.ts',
  'docker/compose.distributed.yml',
]);

export const CK_BUILD_PLATFORM_AUDIT_POLICY = Object.freeze({
  browserTargets: BROWSER_TARGETS,
  browserBoundaryFiles: BROWSER_BOUNDARY_FILES,
  browserAdapterFiles: BROWSER_ADAPTER_FILES,
  actionGraphScripts: ACTION_GRAPH_SCRIPTS,
  deterministicPlanningFiles: DETERMINISTIC_PLANNING_FILES,
  releasePlatformFiles: RELEASE_PLATFORM_FILES,
  autoscaleFiles: AUTOSCALE_FILES,
  externalGates: Object.freeze([
    Object.freeze({
      id: 'browser-action-graph-runtime',
      command: 'npm run verify:ck-browser-action-graph-matrix',
      requires: 'Linux runner with the pinned Browser WASM Packs',
    }),
    Object.freeze({
      id: 'native-action-graph-runtime',
      command: 'npm run verify:ck-native-action-graph-matrix',
      requires: 'CI worker with the native Toolchain and Platform Packs',
    }),
    Object.freeze({
      id: 'browser-library-matrix-runtime',
      command: 'npm run verify:ck-browser-library-matrix',
      requires: 'Linux runner with all five pinned Browser WASM runtimes',
    }),
    Object.freeze({
      id: 'avr-corresponding-source-release',
      command: 'npm run gate:avr-commercial-release',
      requires: 'independently reproducible complete corresponding GCC/binutils source, patches, glue, and build scripts',
    }),
    Object.freeze({
      id: 'hardware-flash-matrix',
      command: 'manual/CI hardware flash matrix',
      requires: 'external runner with S2 / S3 / C5 / C6 / H2 / P4 boards, both P4 ChipVariants, and isolated serial ports',
    }),
  ]),
});

const DIRECT_HOST_TOOL = /(?:^|[("'\/\\])(?:avr-)?(?:gcc|g\+\+|gcc-ar|ar|ld|objcopy)(?:\.exe)?(?=$|["'\s])/m;
const PROCESS_API = /\b(?:child_process|spawnSync|execFileSync|execSync|fork|Deno\.Command|Bun\.spawn)\b/;

function finding(code, file, message) {
  return Object.freeze({ code, file, message });
}

/** Run the source/configuration audit without executing a build. */
export async function auditCkBuildPlatform({ root = process.cwd() } = {}) {
  const workspace = resolve(root);
  const findings = [];
  const checked = [];
  const texts = new Map();

  const load = async (relativePath) => {
    if (texts.has(relativePath)) return texts.get(relativePath);
    try {
      const text = await readFile(resolve(workspace, relativePath), 'utf8');
      texts.set(relativePath, text);
      checked.push(relativePath);
      return text;
    } catch (error) {
      findings.push(finding(
        'missing-file',
        relativePath,
        'required audit input is unavailable: ' + (error?.message ?? error),
      ));
      return null;
    }
  };

  const requireText = async (relativePath, needles, code = 'missing-symbol') => {
    const text = await load(relativePath);
    if (text === null) return;
    for (const needle of needles) {
      if (!text.includes(needle)) {
        findings.push(finding(code, relativePath, 'required marker is missing: ' + needle));
      }
    }
  };

  for (const relativePath of BROWSER_BOUNDARY_FILES) {
    const text = await load(relativePath);
    if (text === null) continue;
    if (PROCESS_API.test(text)) {
      findings.push(finding(
        'browser-process-api',
        relativePath,
        'Browser production boundary contains a host process API',
      ));
    }
    if (DIRECT_HOST_TOOL.test(text)) {
      findings.push(finding(
        'browser-host-tool',
        relativePath,
        'Browser production boundary contains a direct GCC/binutils executable token',
      ));
    }
  }

  for (const relativePath of BROWSER_ADAPTER_FILES) {
    const text = await load(relativePath);
    if (text === null) continue;
    if (PROCESS_API.test(text)) {
      findings.push(finding(
        'browser-adapter-process-api',
        relativePath,
        'Browser executor adapter contains a host process API',
      ));
    }
  }

  for (const relativePath of DETERMINISTIC_PLANNING_FILES) {
    const text = await load(relativePath);
    if (text?.includes('.localeCompare(')) {
      findings.push(finding(
        'locale-dependent-sort',
        relativePath,
        'Build planning identity must use an explicit code-unit comparator',
      ));
    }
  }

  await requireText('packages/web/public/browser-esp32.js', [
    'const BROWSER_ROUTES',
    'new BrowserWasmExecutor',
    'ESP32_BROWSER_ACTION_ADAPTER_POLICY',
    'adapterPolicyVersion:',
    'createEsp32BrowserBuildIR',
    ...BROWSER_TARGETS,
  ]);
  await requireText('packages/web/public/ck-browser-executor.js', [
    'CK_BROWSER_WASM_EXECUTOR_CACHE_POLICY',
    'browserActionCacheKey',
    'adapterPolicyVersion',
  ]);
  await requireText('packages/web/public/browser-avr.js', [
    'AVR_BROWSER_ACTION_ADAPTER_POLICY',
    'adapterPolicyVersion:',
  ]);
  await requireText('packages/web/public/ck-build-ir-envelope.js', [
    "from './ck-platform-planning.js'",
    "from './ck-esp32-partitions.js'",
    'derivePlatformArchiveCommand',
    'archiveOperation: archiveCommand.operation',
    'lowerPlatformBuildCommands',
    'planBuildIR',
  ]);
  await requireText('packages/web/public/ck-platform-planning.js', [
    'Generated from @sketchforge/core platform-planning',
    'derivePlatformArchiveCommand',
    'lowerPlatformBuildCommands',
  ]);
  await requireText('packages/web/public/ck-esp32-partitions.js', [
    'Generated from @sketchforge/core ESP32 custom partitions',
    'resolveCustomEsp32Partitions',
    'encodeEsp32PartitionCsv',
  ]);
  await requireText('packages/web/public/esp32/v2/c3-compiler.js', [
    'createEsp32BrowserActionExecutor',
    'platform:gen-esp32part',
    'resolveCustomEsp32Partitions',
    'runClang',
    'runLLVM',
  ]);
  await requireText('packages/web/public/esp32/v1/c3-runtime.js', [
    'createEsp32WorkerActionRequest',
    'validateEsp32WorkerActionRequest',
  ]);
  await requireText('packages/web/public/ck-blockly-generator.js', [
    'createBlocklyLibraryBundle',
    'assembleBlockProgram',
    'sourceMap',
  ]);
  await requireText('packages/web/public/ck-firmware-patch.js', [
    'patchAvrIntelHexByMagic',
    'patchEsp32ImageByMagic',
    'compileVmProgram',
  ]);
  await requireText('scripts/build-ck-browser-core.mjs', [
    'ck-esp32-partitions.js',
    'ck-blockly-generator.js',
    'ck-firmware-patch.js',
  ]);
  for (const legacySymbol of [
    'WorkerCompile',
    'createEsp32C3WorkerCompileRequest',
    'compileEsp32C3WorkerRequest',
  ]) {
    for (const relativePath of [
      'packages/web/public/esp32/v1/c3-runtime.js',
      'packages/web/public/esp32/v2/c3-compiler.js',
    ]) {
      const text = await load(relativePath);
      if (text?.includes(legacySymbol)) {
        findings.push(finding(
          'legacy-compile-abi',
          relativePath,
          'legacy symbol remains: ' + legacySymbol,
        ));
      }
    }
  }

  await requireText('packages/core/src/compile.ts', [
    "from './build-ir/platform-planning.js'",
    'archiveOperation: recipeCommands.archive.operation',
    'lowerPlatformBuildCommands',
    'policyIdentity: sha256Hex',
    'toolIntegrity: integrity',
  ]);
  await requireText('packages/core/src/executor/native.ts', [
    'class NativeExecutor',
    'CK_NATIVE_EXECUTOR_POLICY_IDENTITY',
    'effectiveCacheKey',
    'policyIdentity',
  ]);
  await requireText('packages/core/src/sandbox/bubblewrap.ts', ['class BubblewrapExecutor']);
  await requireText('packages/core/src/sandbox/nsjail.ts', ['class NsjailExecutor']);
  await requireText('docker/compose.distributed.production.yml', ['runtime: runsc']);
  await requireText('docker/deploy-distributed.sh', ['runsc', 'AF_ACK_HOST_ISOLATION']);
  await requireText('packages/server/src/worker.ts', ['bullmq', 'RedisActionCache', 'BullMQ']);
  await requireText('packages/server/src/gateway.ts', ['DistributedCompileQueue', 'RedisCompileEventStore']);

  for (const relativePath of RELEASE_PLATFORM_FILES) await load(relativePath);
  await requireText('packages/server/src/prebuild-firmware-assets.ts', [
    'compileStaticBuildIR',
    'parsePrebuildShard',
    'manifestSha256',
  ]);
  await requireText('packages/server/src/materialize-featured-libraries.ts', [
    'source artifact digest mismatch',
    'materialization.json',
  ]);
  await requireText('packages/server/src/prebuild-featured-firmware.ts', [
    'planFeaturedPrebuildMatrix',
    'Action cache replay missed',
    'staticArtifacts: []',
    'combinationIdentity',
  ]);
  for (const relativePath of ['docker/Dockerfile.worker-avr', 'docker/Dockerfile.worker-esp32']) {
    await requireText(relativePath, [
      'materialize-featured-libraries-cli.js',
      '/opt/sketchforge/featured-libraries',
    ]);
  }
  await requireText('.github/workflows/prebuild-worker-images.yml', [
    'static-firmware:',
    'AF_PREBUILD_SHARD',
    'featured-firmware:',
    'prebuild-featured-firmware-cli.js',
    'featured-manifest:',
  ], 'missing-ci-wiring');

  for (const relativePath of AUTOSCALE_FILES) await load(relativePath);
  await requireText('packages/server/src/autoscale.ts', [
    'decideWorkerReplicas',
    'AutoscaleWebhookAdapter',
    "'idempotency-key'",
    'autoscale webhook timed out',
  ]);
  await requireText('packages/server/src/autoscale-service.ts', [
    'listWorkerCapabilities',
    'queue.stats()',
    'currentCapacity',
  ]);
  await requireText('scripts/simulate-autoscale.ts', [
    'worker-loss',
    'cooldownObserved',
    'virtualHours',
  ]);
  await requireText('docker/compose.distributed.yml', [
    'profiles: [autoscale]',
    'AF_AUTOSCALE_WEBHOOK_URL',
    'packages/server/dist/autoscale-cli.js',
  ]);

  for (const relativePath of ACTION_GRAPH_SCRIPTS) await load(relativePath);

  const packageText = await load('package.json');
  if (packageText !== null) {
    try {
      const packageJson = JSON.parse(packageText);
      const scripts = packageJson.scripts ?? {};
      for (const name of [
        'verify:ck-browser-action-graph-matrix',
        'verify:ck-native-action-graph-matrix',
        'verify:ck-browser-library-matrix',
        'merge:ck-browser-library-matrix',
        'audit:ck-browser-library-release',
        'test:compile-cancellation',
        'verify:project-docs',
        'audit:avr-toolchain-source',
        'gate:avr-commercial-release',
        'prebuild:firmware-assets',
        'prebuild:featured-firmware',
        'verify:autoscale-simulation',
      ]) {
        if (typeof scripts[name] !== 'string' || !scripts[name]) {
          findings.push(finding(
            'missing-ci-command',
            'package.json',
            'required script is missing: ' + name,
          ));
        }
      }
      if (typeof scripts['audit:ck-build-platform'] !== 'string') {
        findings.push(finding(
          'missing-ci-command',
          'package.json',
          'required script is missing: audit:ck-build-platform',
        ));
      }
      if (typeof scripts['audit:ck-action-graph-evidence'] !== 'string') {
        findings.push(finding(
          'missing-ci-command',
          'package.json',
          'required script is missing: audit:ck-action-graph-evidence',
        ));
      }
    } catch (error) {
      findings.push(finding(
        'invalid-json',
        'package.json',
        'package.json is not valid JSON: ' + error.message,
      ));
    }
  }

  await requireText('.github/workflows/ck-build-platform.yml', [
    'npm run audit:ck-build-platform',
    'browser-action-graph',
    'browser-library-matrix',
    'browser-library-evidence',
    'verify-ck-browser-library-matrix.mjs',
    'merge:ck-browser-library-matrix',
    'audit:ck-browser-library-release',
    'ck-browser-library-release-evidence',
    'npm run test:compile-cancellation',
    'npm run verify:project-docs',
    'npm run audit:avr-toolchain-source',
    'native-action-graph',
    'runtime-evidence',
    'audit-ck-action-graph-evidence.mjs',
    'ck-action-graph-runtime-matrix',
  ], 'missing-ci-wiring');

  return Object.freeze({
    ok: findings.length === 0,
    findings: Object.freeze(findings),
    checked: Object.freeze([...new Set(checked)].sort()),
    externalGates: CK_BUILD_PLATFORM_AUDIT_POLICY.externalGates,
  });
}

async function main() {
  const result = await auditCkBuildPlatform();
  if (result.ok) {
    console.log('CK Build platform static audit passed (' + result.checked.length + ' files checked)');
  } else {
    for (const item of result.findings) {
      console.error('[' + item.code + '] ' + item.file + ': ' + item.message);
    }
    process.exitCode = 1;
  }
  console.log('Runtime and hardware gates remain external CI requirements:');
  for (const gate of result.externalGates) {
    console.log('- ' + gate.id + ': ' + gate.command + ' (' + gate.requires + ')');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
