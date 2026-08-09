import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireReportLock,
  classifyMatrixFailure,
  classifyStructuredMatrixFailure,
  createChildTerminationController,
  createMatrixJobs,
  createVerifierRequest,
  hashFingerprintEntries,
  parseMatrixArgs,
  parseShard,
  selectPrimaryHeader,
  summarizeMatrixResults,
  validateFixtureManifest,
} from './verify-ck-browser-library-matrix.mjs';
import {
  createVerifierResultStreamParser,
  encodeVerifierResult,
  publicVerifierResult,
} from './ck-verifier-result.mjs';
import {
  serializeBrowserLibraryRequest,
  validateBrowserLibraryRequest,
} from './ck-browser-library-request.mjs';
import { evaluateBrowserLibraryPolicy } from './ck-browser-library-policy.mjs';

const fixtures = validateFixtureManifest({ schema: 1, cases: [] });
const registry = {
  libraries: [{
    name: 'Example Library',
    versions: [{
      version: '1.2.3',
      publicHeaders: ['detail/Secondary.hpp', 'ExampleLibrary.h'],
      pack: {
        id: 'arduino-lib-example',
        revision: 'a'.repeat(64),
        manifestUrl: pathUrl('example/toolchain.json'),
      },
    }],
  }],
};

test('matrix argument parsing defaults to all five targets and supports deterministic shards', () => {
  const defaults = parseMatrixArgs([]);
  assert.deepEqual(defaults.targets, ['esp32', 's2', 's3', 'c3', 'c6']);
  const c3 = parseMatrixArgs(['--target', 'c3']);
  const shard = parseMatrixArgs(['--shard', '1/8']);
  const customRegistry = parseMatrixArgs(['--registry', 'staging-registry.json']);
  assert.notEqual(c3.report, defaults.report);
  assert.notEqual(shard.report, defaults.report);
  assert.notEqual(c3.report, shard.report);
  assert.notEqual(customRegistry.report, defaults.report);
  assert.equal(parseMatrixArgs(['--target', 'c3', '--report', 'custom.json']).report.endsWith('custom.json'), true);
  assert.equal(parseMatrixArgs(['--force-unlock']).forceUnlock, true);
  assert.deepEqual(parseShard('3/8'), { index: 3, total: 8 });
  assert.throws(() => parseShard('0/8'), /between 1 and TOTAL/);
  assert.throws(() => parseMatrixArgs(['--concurrency', '5']), /integer from 1 to 4/);
});

test('primary header selection prefers the library-named public header', () => {
  assert.equal(selectPrimaryHeader('Example Library', ['detail/Secondary.hpp', 'ExampleLibrary.h']), 'ExampleLibrary.h');
  assert.equal(selectPrimaryHeader('U8g2', ['MUIU8g2.h', 'U8g2lib.h', 'U8x8lib.h']), 'U8g2lib.h');
});

test('FastLED browser policy excludes only the measured 3.10.5 unity build', () => {
  for (const target of ['esp32', 's2', 's3', 'c3', 'c6']) {
    assert.deepEqual(evaluateBrowserLibraryPolicy({
      library: 'FastLED',
      libraryVersion: '3.10.5',
      target,
      platformVersion: '3.3.7',
    }), {
      status: 'unsupported',
      minPlatformVersion: '3.3.0',
      reason: 'FastLED 3.10.5 unity-build compile units exceed the CK Browser WASM Action execution budget; use FastLED 3.9.4 in the browser or the native executor',
    });
  }
  assert.equal(evaluateBrowserLibraryPolicy({
    library: 'FastLED',
    libraryVersion: '3.9.4',
    target: 'c3',
    platformVersion: '3.3.7',
  }), null);
  assert.equal(evaluateBrowserLibraryPolicy({
    library: 'FastLED',
    libraryVersion: '3.10.5',
    target: 'c3',
    platformVersion: '3.2.1',
  }), null);
});

test('matrix planning expands public headers and shards the stable sorted jobs', () => {
  const options = {
    ...parseMatrixArgs(['--target', 'esp32,c3', '--headers', 'all']),
    shard: { index: 1, total: 2 },
  };
  const plan = createMatrixJobs({
    registry,
    targets: options.targets,
    platformVersions: new Map([['esp32', '3.3.7'], ['c3', '3.3.7']]),
    fixtures,
    options,
  });
  assert.equal(plan.unsharded, 4);
  assert.equal(plan.jobs.length, 2);
  assert.deepEqual(plan.jobs.map((job) => job.target), ['c3', 'c3']);
  assert.deepEqual(plan.jobs.map((job) => job.header), ['detail/Secondary.hpp', 'ExampleLibrary.h']);
});

test('matrix planning accepts an executor-specific policy evaluator', () => {
  const options = parseMatrixArgs(['--target', 'c3']);
  const policy = Object.freeze({
    status: 'unsupported',
    reason: 'executor-specific test policy',
    minPlatformVersion: '3.3.0',
  });
  const calls = [];
  const plan = createMatrixJobs({
    registry,
    targets: options.targets,
    platformVersions: new Map([['c3', '3.3.7']]),
    fixtures,
    options,
    policyEvaluator(input) {
      calls.push(input);
      return policy;
    },
  });
  assert.deepEqual(calls, [{
    library: 'Example Library',
    libraryVersion: '1.2.3',
    target: 'c3',
    platformVersion: '3.3.7',
  }]);
  assert.equal(plan.jobs[0].policy, policy);
});

test('failure classification and report summaries remain explicit', () => {
  assert.equal(classifyMatrixFailure('fatal error: missing.h: No such file'), 'compiler');
  assert.equal(classifyMatrixFailure(JSON.stringify({
    status: 'error',
    reason: 'compile',
    message: "'PrivateDriver.h' file not found",
    failedAction: { packRevision: 'a'.repeat(64) },
  })), 'compiler');
  assert.equal(classifyMatrixFailure('undefined reference to symbol'), 'linker');
  assert.equal(classifyMatrixFailure('', { timedOut: true }), 'execution-limit');
  assert.equal(classifyMatrixFailure('Error: spawn failed', { internal: true }), 'executor');
  assert.equal(classifyStructuredMatrixFailure({ status: 'error', reason: 'compile', actionKind: 'compile' }), 'compiler');
  assert.equal(classifyStructuredMatrixFailure({ status: 'error', reason: 'compile', actionKind: 'link' }), 'linker');
  assert.equal(classifyStructuredMatrixFailure({ status: 'error', reason: 'integrity' }), 'pack-integrity');
  assert.equal(classifyStructuredMatrixFailure({ status: 'error', reason: 'timeout' }), 'execution-limit');
  assert.equal(classifyStructuredMatrixFailure({
    status: 'error',
    reason: 'resource_limit',
    message: 'heap out of memory',
  }), 'memory-limit');
  assert.deepEqual(summarizeMatrixResults([
    { status: 'success' },
    { status: 'failed', failureClass: 'compiler' },
  ], 3), {
    expected: 3,
    completed: 2,
    pending: 1,
    statuses: { failed: 1, success: 1 },
    failureClasses: { compiler: 1 },
  });
});

test('structured child results survive large logs and arbitrary stdout chunks', () => {
  const token = 'matrix-result-token';
  const parser = createVerifierResultStreamParser(token);
  const line = encodeVerifierResult({
    status: 'error',
    phase: 'execution',
    reason: 'compile',
    message: "'PrivateDriver.h' file not found",
    library: 'Example Library@1.2.3',
    header: 'ExampleLibrary.h',
    target: 'esp32:esp32:esp32c3',
    actionCount: 3,
    actionId: 'compile-library-example',
    actionKind: 'compile',
    diagnosticCount: 1,
    diagnostic: {
      severity: 'error',
      file: 'ExampleLibrary.cpp',
      line: 42,
      column: 7,
      message: "'PrivateDriver.h' file not found",
    },
    elapsedMs: 123,
  }, token);
  parser.push(Buffer.from(`${'compiler trace\n'.repeat(8_000)}CK_RESULT {"schema":1,"token":"spoofed"}\n`));
  for (let offset = 0; offset < line.length; offset += 7) parser.push(Buffer.from(line.slice(offset, offset + 7)));
  const parsed = parser.finish();
  assert.equal(parsed.error, undefined);
  assert.deepEqual(publicVerifierResult(parsed.result), {
    schema: 1,
    status: 'error',
    phase: 'execution',
    reason: 'compile',
    message: "'PrivateDriver.h' file not found",
    library: 'Example Library@1.2.3',
    header: 'ExampleLibrary.h',
    target: 'esp32:esp32:esp32c3',
    actionCount: 3,
    actionId: 'compile-library-example',
    actionKind: 'compile',
    diagnosticCount: 1,
    diagnostic: {
      severity: 'error',
      file: 'ExampleLibrary.cpp',
      line: 42,
      column: 7,
      message: "'PrivateDriver.h' file not found",
    },
    elapsedMs: 123,
  });
});

test('structured child result parser rejects duplicate authenticated results', () => {
  const token = 'matrix-result-token';
  const parser = createVerifierResultStreamParser(token);
  const result = encodeVerifierResult({
    status: 'success',
    phase: 'execution',
    diagnosticCount: 0,
    elapsedMs: 1,
  }, token);
  parser.push(Buffer.from(result + result));
  assert.match(parser.finish().error?.message ?? '', /more than one/);
});

test('large fixtures round-trip through the versioned request envelope', () => {
  const content = 'x'.repeat(128 * 1024);
  const request = createVerifierRequest({
    manifest: 'E:/packs/example/toolchain.json',
    header: 'Example.h',
    target: 'c3',
    fixture: {
      projectFiles: [{ name: 'lv_conf.h', content }],
      macros: { LV_CONF_PATH: '"lv_conf.h"' },
    },
  }, { registry: 'E:/catalog/registry.json' });
  const decoded = validateBrowserLibraryRequest(JSON.parse(serializeBrowserLibraryRequest(request)));
  assert.equal(decoded.projectFiles[0].content.length, content.length);
  assert.equal(decoded.projectFiles[0].content, content);
  assert.equal(decoded.macros.LV_CONF_PATH, '"lv_conf.h"');
});

test('child termination escalates from SIGTERM to SIGKILL and stops after close', async () => {
  const signals = [];
  const controller = createChildTerminationController({
    kill(signal) {
      signals.push(signal);
      return true;
    },
  }, { graceMs: 10 });
  controller.timeout();
  await wait(30);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  controller.close();
  controller.abort();
  await wait(20);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('report locks reject live owners and reclaim stale or forced owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ck-browser-matrix-lock-'));
  const report = join(directory, 'report.json');
  try {
    const live = await acquireReportLock(report);
    await assert.rejects(() => acquireReportLock(report), /already being written/);
    await live.release();

    const lockPath = `${report}.lock`;
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      schema: 1,
      pid: Number.MAX_SAFE_INTEGER,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      startedAtMs: Date.now() - 60_000,
      token: 'stale-token',
      report,
    }));
    const reclaimed = await acquireReportLock(report);
    assert.notEqual(reclaimed.token, 'stale-token');
    await reclaimed.release();

    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      schema: 1,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      token: 'active-token',
      report,
    }));
    const forced = await acquireReportLock(report, { forceUnlock: true });
    assert.notEqual(forced.token, 'active-token');
    await forced.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('content fingerprints use stable logical ids rather than host paths', () => {
  const bytes = Buffer.from('same content');
  const first = hashFingerprintEntries([{ id: 'scripts/verifier.mjs', bytes }], 'schema-1');
  const second = hashFingerprintEntries([{ id: 'scripts/verifier.mjs', bytes }], 'schema-1');
  assert.equal(first, second);
  assert.notEqual(first, hashFingerprintEntries([{ id: 'scripts/other.mjs', bytes }], 'schema-1'));
});

function pathUrl(path) {
  return new URL(path, 'file:///E:/matrix-fixtures/').href;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
