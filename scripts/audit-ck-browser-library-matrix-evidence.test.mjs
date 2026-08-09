import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditMatrixReport,
  calculateReverseDependencyClosure,
  createCompositeProjection,
  diffLibraryRegistries,
  findPrimaryPlanDriftLibraries,
  groupCurrentEvidence,
  parseEvidenceArgs,
  createRetestJobs,
} from './audit-ck-browser-library-matrix-evidence.mjs';

function version(version, revision, depends = []) {
  return {
    version,
    architectures: ['*'],
    publicHeaders: [`${version}.h`],
    depends,
    pack: { id: `pack-${version}`, revision, manifest: `${version}/toolchain.json`, artifact: 'sources' },
  };
}

function library(name, versions, defaultVersion = versions[0].version) {
  return { name, defaultVersion, versions };
}

function registry(libraries) {
  return { schema: 2, libraries };
}

test('Registry diff and reverse closure use both the old and new dependency graph', () => {
  const baseline = registry([
    library('A', [version('1', 'a'.repeat(64))]),
    library('OldDependent', [version('1', 'b'.repeat(64), [{ name: 'A', version: '1' }])]),
    library('Transitive', [version('1', 'c'.repeat(64), [{ name: 'OldDependent', version: '1' }])]),
    library('Unrelated', [version('1', 'd'.repeat(64))]),
  ]);
  const current = registry([
    library('A', [version('1', 'e'.repeat(64))]),
    library('OldDependent', [version('1', 'b'.repeat(64))]),
    library('Transitive', [version('1', 'c'.repeat(64), [{ name: 'OldDependent', version: '1' }])]),
    library('Unrelated', [version('1', 'd'.repeat(64))]),
  ]);
  const changes = diffLibraryRegistries(baseline, current);
  assert.deepEqual(changes.map((entry) => entry.library), ['A', 'OldDependent']);
  assert.deepEqual(
    calculateReverseDependencyClosure(baseline, current, changes).map((entry) => entry.library),
    ['A', 'OldDependent', 'Transitive'],
  );
});

test('current evidence never combines different fingerprints', () => {
  const keys = ['a@1|a.h|c3', 'b@1|b.h|c3'];
  const result = (key) => ({ key, status: 'success' });
  const audits = [
    { path: 'one.json', audit: { accepted: true, fingerprint: '1'.repeat(64), results: [result(keys[0])] } },
    { path: 'two.json', audit: { accepted: true, fingerprint: '2'.repeat(64), results: [result(keys[1])] } },
  ];
  const grouped = groupCurrentEvidence(audits, keys, '2'.repeat(64));
  assert.equal(grouped.completeGroup, undefined);
  assert.deepEqual(grouped.groups.map((group) => group.coveredJobs), [1, 1]);
});

test('report audit rejects unrelated retained results', () => {
  const digest = 'a'.repeat(64);
  const registry = {
    schema: 2,
    libraries: [{
      name: 'A',
      defaultVersion: '1',
      versions: [version('1', 'b'.repeat(64))],
    }],
  };
  const fixtures = { schema: 1, cases: [] };
  const report = {
    schema: 1,
    verificationSchema: 1,
    scope: 'browser-wasm-library-compile',
    fingerprint: digest,
    registry: { sha256: digest },
    fixtureManifest: { sha256: digest },
    configuration: {
      headers: 'primary', targets: ['c3'], libraries: ['A'], versions: [],
      shard: { index: 1, total: 1 },
    },
    integrity: { stable: true, startFingerprint: digest, endFingerprint: digest },
    results: [{ key: 'unrelated@1|x.h|c3', status: 'success' }],
    scopeSummary: { expected: 1, completed: 0, pending: 1, statuses: {}, failureClasses: {} },
    summary: { expected: 1, completed: 1, pending: 0, statuses: { success: 1 }, failureClasses: {} },
  };
  const audit = auditMatrixReport({
    report, registry, registrySha256: digest, fixtureSha256: digest, fixtures,
  });
  assert.equal(audit.accepted, false);
  assert.match(audit.errors.join('\n'), /outside its declared configuration scope/);
});

test('only one complete current fingerprint can satisfy the delta', () => {
  const keys = ['a@1|a.h|c3', 'b@1|b.h|c3'];
  const result = (key) => ({ key, status: 'success' });
  const fingerprint = '3'.repeat(64);
  const grouped = groupCurrentEvidence([
    { path: 'complete.json', audit: { accepted: true, fingerprint, results: keys.map(result) } },
    { path: 'stale.json', audit: { accepted: true, fingerprint: '4'.repeat(64), results: keys.map(result) } },
  ], keys, fingerprint);
  assert.equal(grouped.completeGroup.fingerprint, fingerprint);
  assert.equal(grouped.coverageGroup.fingerprint, fingerprint);
  assert.equal(grouped.groups.find((group) => group.fingerprint === '4'.repeat(64)).complete, false);
});

test('composite projection keeps baseline and delta provenance separate', () => {
  const job = (library, revision) => ({
    library,
    version: '1',
    header: `${library}.h`,
    target: 'c3',
    packId: `pack-${library}`,
    packRevision: revision,
  });
  const a = job('a', 'a'.repeat(64));
  const b = job('b', 'b'.repeat(64));
  const result = (entry, status) => ({
    ...entry,
    key: `${entry.library}@1|${entry.library}.h|c3`,
    jobFingerprint: 'f'.repeat(64),
    status,
  });
  const projection = createCompositeProjection({
    baselineResults: [result(a, 'failed'), result(b, 'failed')],
    currentResults: [result(a, 'success')],
    currentJobs: [a, b],
    affectedKeys: [result(a, 'success').key],
    baselineFingerprint: '1'.repeat(64),
    currentFingerprint: '2'.repeat(64),
  });
  assert.deepEqual(projection.provenance, { historicalBaseline: 1, currentDelta: 1 });
  assert.deepEqual(projection.failureSources, { historicalBaseline: 1, currentDelta: 0 });
  assert.equal(projection.compatibilityPassed, false);
});

test('primary plan drift becomes explicit delta work', () => {
  const currentJobs = [{ library: 'U8g2', version: '1', target: 'c3', header: 'U8g2lib.h' }];
  const baselineResults = [{ library: 'U8g2', version: '1', target: 'c3', header: 'U8x8lib.h' }];
  assert.deepEqual(findPrimaryPlanDriftLibraries(baselineResults, currentJobs), ['U8g2']);
});

test('an unchanged Registry produces no retest jobs', () => {
  const current = registry([library('A', [version('1', 'a'.repeat(64))])]);
  assert.deepEqual(createRetestJobs(current, [], ['c3'], { schema: 1, cases: [] }), []);
  assert.equal(createRetestJobs(current, ['A'], ['c3'], { schema: 1, cases: [] }).length, 1);
});

test('CLI defaults to an explicit immutable baseline and accepts repeated current reports', () => {
  const defaults = parseEvidenceArgs([]);
  assert.match(defaults.baselineRegistry, /libraries-catalog\.previous-1785868231312[\\/]registry\.json$/);
  assert.equal(defaults.currentReports.length, 3);
  const options = parseEvidenceArgs(['--current-report', 'one.json', '--current-report', 'two.json', '--target', 'c3,c6']);
  assert.equal(options.currentReports.length, 2);
  assert.deepEqual(options.targets, ['c3', 'c6']);
});
