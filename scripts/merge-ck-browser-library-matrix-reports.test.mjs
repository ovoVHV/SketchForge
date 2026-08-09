import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeMatrixReports,
  parseMergeArgs,
  planMatrixReportRetries,
  serializeMergedReport,
} from './merge-ck-browser-library-matrix-reports.mjs';

const fingerprint = 'a'.repeat(64);

function result(key, status = 'success') {
  const [identity, header, target] = key.split('|');
  const at = identity.lastIndexOf('@');
  return {
    key,
    jobFingerprint: 'b'.repeat(64),
    library: identity.slice(0, at),
    version: identity.slice(at + 1),
    header,
    target,
    status,
    ...(status === 'failed' ? { failureClass: 'compiler' } : {}),
  };
}

function shard(index, results, overrides = {}, total = 2) {
  const summary = {
    expected: results.length,
    completed: results.length,
    pending: 0,
    statuses: Object.fromEntries([...new Set(results.map((entry) => entry.status))].sort().map((status) => [
      status,
      results.filter((entry) => entry.status === status).length,
    ])),
    failureClasses: results.some((entry) => entry.status === 'failed') ? { compiler: 1 } : {},
  };
  const report = {
    schema: 1,
    verificationSchema: 1,
    scope: 'browser-wasm-library-compile',
    compatibilityClaim: 'compile-archive-link-and-artifact-generation-only',
    fingerprint,
    generatedAt: `2026-08-04T00:00:0${index}.000Z`,
    registry: { path: 'registry.json', sha256: 'c'.repeat(64), libraries: 4, versions: 4, publicHeaders: 4 },
    fixtureManifest: { path: 'fixtures.json', sha256: 'd'.repeat(64) },
    configuration: {
      headers: 'primary',
      targets: ['c3'],
      libraries: [],
      versions: [],
      ignorePolicy: false,
      shard: { index, total },
      concurrency: 1,
      timeoutMs: 600_000,
    },
    results,
    scopeSummary: summary,
    summary,
    integrity: { startFingerprint: fingerprint, endFingerprint: fingerprint, stable: true },
    ...overrides,
  };
  const bytes = Buffer.from(JSON.stringify(report));
  return { path: `shard-${index}.json`, bytes, report };
}

const a = result('a@1.0.0|example.h|c3');
const b = result('b@1.0.0|example.h|c3', 'failed');
const c = result('c@1.0.0|example.h|c3');
const d = result('d@1.0.0|example.h|c3');

test('merge arguments generate deterministic default shard paths', () => {
  const defaults = parseMergeArgs([]);
  assert.equal(defaults.shards, 8);
  assert.equal(defaults.expectedJobs, undefined);
  const options = parseMergeArgs([
    '--shards', '2',
    '--expected-jobs', '4',
    '--current-fingerprint', fingerprint,
  ]);
  assert.equal(options.inputs.length, 2);
  assert.match(options.inputs[0], /primary-shard-1-of-2\.json$/);
  assert.equal(options.expectedJobs, 4);
  assert.equal(options.currentFingerprint, fingerprint);
  assert.match(parseMergeArgs(['--retry-plan']).retryPlan, /ck-browser-library-matrix-retry-plan\.json$/);
});

test('complete stable shards merge in global job order', () => {
  const merged = mergeMatrixReports(
    [shard(2, [b, d]), shard(1, [a, c])],
    { expectedJobs: 4, expectedShards: 2 },
  );
  assert.deepEqual(merged.results.map((entry) => entry.key), [a.key, b.key, c.key, d.key]);
  assert.deepEqual(merged.scopeSummary, {
    expected: 4,
    completed: 4,
    pending: 0,
    statuses: { failed: 1, success: 3 },
    failureClasses: { compiler: 1 },
  });
  assert.equal(merged.integrity.stable, true);
  assert.deepEqual(merged.dispositions, { passed: 3, failed: 1, policyExcluded: 0, pending: 0 });
  assert.equal(merged.verificationComplete, true);
  assert.equal(merged.supportScopePassed, false);
  assert.equal(merged.allJobsCompatible, false);
  assert.equal(merged.sourceReports.length, 2);
  assert.equal(
    serializeMergedReport(merged),
    serializeMergedReport(mergeMatrixReports(
      [shard(1, [a, c]), shard(2, [b, d])],
      { expectedJobs: 4, expectedShards: 2 },
    )),
  );
});

test('merge rejects incomplete, unstable, duplicate, or incorrectly assigned shards', () => {
  const incomplete = shard(1, [a, c]);
  incomplete.report.scopeSummary = { ...incomplete.report.scopeSummary, completed: 1, pending: 1 };
  assert.throws(() => mergeMatrixReports(
    [incomplete, shard(2, [b, d])],
    { expectedJobs: 4, expectedShards: 2 },
  ), /incomplete|summary does not match/);

  const unstable = shard(1, [a, c]);
  unstable.report.integrity = { ...unstable.report.integrity, stable: false };
  assert.throws(() => mergeMatrixReports(
    [unstable, shard(2, [b, d])],
    { expectedJobs: 4, expectedShards: 2 },
  ), /stable fingerprint/);

  const unsupported = shard(1, [a, c], { verificationSchema: 2 });
  assert.throws(() => mergeMatrixReports([unsupported, shard(2, [b, d])]), /schema is unsupported/);

  const driftedConfiguration = shard(2, [b, d]);
  driftedConfiguration.report.configuration = {
    ...driftedConfiguration.report.configuration,
    timeoutMs: 300_000,
  };
  assert.throws(() => mergeMatrixReports(
    [shard(1, [a, c]), driftedConfiguration],
    { expectedJobs: 4, expectedShards: 2 },
  ), /scope does not match/);

  const invalidConfiguration = shard(2, [b, d]);
  invalidConfiguration.report.configuration = { ...invalidConfiguration.report.configuration };
  delete invalidConfiguration.report.configuration.concurrency;
  assert.throws(() => mergeMatrixReports(
    [shard(1, [a, c]), invalidConfiguration],
    { expectedJobs: 4, expectedShards: 2 },
  ), /concurrency is invalid/);

  assert.throws(() => mergeMatrixReports(
    [shard(1, [a, c]), shard(1, [a, c])],
    { expectedJobs: 4, expectedShards: 2 },
  ), /duplicated/);
  assert.throws(() => mergeMatrixReports(
    [shard(1, [b, c]), shard(2, [a, d])],
    { expectedJobs: 4, expectedShards: 2 },
  ), /belongs to shard/);
});

test('merge enforces the requested global job count', () => {
  assert.throws(() => mergeMatrixReports(
    [shard(1, [a, c]), shard(2, [b, d])],
    { expectedJobs: 5, expectedShards: 2 },
  ), /declare 4/);
  assert.throws(() => mergeMatrixReports(
    [shard(1, [a, c]), shard(2, [b, d])],
    { expectedJobs: 4, expectedShards: 8 },
  ), /expected 8 matrix shards/);
});

test('merge and retry planning reject reports from a stale fingerprint', () => {
  const entries = [shard(1, [a, c]), shard(2, [b, d])];
  const currentFingerprint = 'e'.repeat(64);
  assert.throws(() => mergeMatrixReports(
    entries,
    { expectedJobs: 4, expectedShards: 2, currentFingerprint },
  ), /does not match current fingerprint/);
  assert.throws(() => planMatrixReportRetries(
    entries,
    { expectedJobs: 4, expectedShards: 2, currentFingerprint },
  ), /does not match current fingerprint/);
});

test('default merge accepts the complete 8-shard 750-job distribution', () => {
  const allResults = Array.from({ length: 750 }, (_, index) => result(
    `library${String(index).padStart(3, '0')}@1.0.0|example.h|c3`,
  ));
  const entries = Array.from({ length: 8 }, (_, shardIndex) => shard(
    shardIndex + 1,
    allResults.filter((_, index) => index % 8 === shardIndex),
    {},
    8,
  ));
  const merged = mergeMatrixReports(entries);
  assert.equal(merged.results.length, 750);
  assert.deepEqual(merged.scopeSummary, {
    expected: 750,
    completed: 750,
    pending: 0,
    statuses: { success: 750 },
    failureClasses: {},
  });
  assert.equal(merged.integrity.expectedShards, 8);
  assert.equal(merged.integrity.expectedJobs, 750);
});

test('default merge derives a changed registry job count instead of assuming 750', () => {
  const allResults = Array.from({ length: 735 }, (_, index) => result(
    `library${String(index).padStart(3, '0')}@1.0.0|example.h|c3`,
  ));
  const entries = Array.from({ length: 8 }, (_, shardIndex) => shard(
    shardIndex + 1,
    allResults.filter((_, index) => index % 8 === shardIndex),
    {},
    8,
  ));
  const merged = mergeMatrixReports(entries);
  assert.equal(merged.results.length, 735);
  assert.equal(merged.integrity.expectedJobs, 735);
});

test('retry planner audits partial reports without making a compatibility claim', () => {
  const first = shard(1, [a], {}, 2);
  first.report.scopeSummary = {
    expected: 2,
    completed: 1,
    pending: 1,
    statuses: { success: 1 },
    failureClasses: {},
  };
  first.report.summary = first.report.scopeSummary;
  delete first.report.integrity;
  const second = shard(2, [b, d], {}, 2);
  const plan = planMatrixReportRetries([second, first], { expectedShards: 2, expectedJobs: 4 });
  assert.deepEqual(plan.summary, {
    expected: 4,
    completed: 3,
    pending: 1,
    dispositions: { passed: 2, failed: 1, policyExcluded: 0, pending: 1 },
  });
  assert.equal(plan.verificationComplete, false);
  assert.equal(plan.supportScopePassed, false);
  assert.equal(plan.allJobsCompatible, false);
  assert.deepEqual(plan.failureClasses, { compiler: 1 });
  assert.deepEqual(plan.failedLibraries, { b: 1 });
  assert.deepEqual(plan.failedJobs, [{ key: b.key, failureClass: 'compiler', shard: 2 }]);
  assert.equal(plan.retryCommands.length, 2);
  assert.match(plan.retryCommands[0], /--shard 1\/2/);
  assert.match(plan.retryCommands[0], /--report 'shard-1\.json'/);
  assert.match(plan.compatibilityClaim, /no-compatibility-claim/);
});

test('policy classifications are excluded from all-jobs compatibility', () => {
  const policy = result('b@1.0.0|example.h|c3', 'unsupported');
  const merged = mergeMatrixReports(
    [shard(1, [a, c]), shard(2, [policy, d])],
    { expectedJobs: 4, expectedShards: 2 },
  );
  assert.deepEqual(merged.dispositions, { passed: 3, failed: 0, policyExcluded: 1, pending: 0 });
  assert.equal(merged.supportScopePassed, true);
  assert.equal(merged.allJobsCompatible, false);
});

test('retry planner rejects mismatched fingerprints and unknown statuses', () => {
  const drifted = shard(2, [b, d]);
  drifted.report.fingerprint = 'e'.repeat(64);
  drifted.report.integrity = {
    startFingerprint: drifted.report.fingerprint,
    endFingerprint: drifted.report.fingerprint,
    stable: true,
  };
  assert.throws(() => planMatrixReportRetries(
    [shard(1, [a, c]), drifted],
    { expectedJobs: 4, expectedShards: 2 },
  ), /scope does not match/);

  const unknown = result('b@1.0.0|example.h|c3', 'skipped');
  assert.throws(() => planMatrixReportRetries(
    [shard(1, [a, c]), shard(2, [unknown, d])],
    { expectedJobs: 4, expectedShards: 2 },
  ), /unsupported status/);
});

test('retry planner output is deterministic for the same immutable shard bytes', () => {
  const entries = [shard(1, [a, c]), shard(2, [b, d])];
  assert.deepEqual(
    planMatrixReportRetries(entries, { expectedJobs: 4, expectedShards: 2 }),
    planMatrixReportRetries([...entries].reverse(), { expectedJobs: 4, expectedShards: 2 }),
  );
});
