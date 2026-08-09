import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseReleaseAuditArgs,
  releaseMatrixGateFindings,
} from './audit-ck-browser-library-release.mjs';

const digest = 'a'.repeat(64);
const targets = ['esp32', 's2', 's3', 'c3', 'c6'];

function fixture() {
  return {
    report: {
      fingerprint: digest,
      registry: { sha256: digest, libraries: 145, versions: 147 },
      mergeSchema: 1,
      verificationComplete: true,
      supportScopePassed: true,
      configuration: {
        headers: 'primary', targets, libraries: [], versions: [], ignorePolicy: false, shards: 8,
      },
      integrity: {
        expectedShards: 8, mergedShards: 8, duplicateJobs: 0, expectedJobs: 735, completedJobs: 735,
      },
      sourceReports: Array.from({ length: 8 }, () => ({ sha256: digest })),
      results: [{ status: 'success' }, { status: 'unsupported' }, { status: 'not-recommended' }],
    },
    audit: { accepted: true, errors: [], summary: { expected: 735, completed: 735, pending: 0 } },
    expectedFingerprint: digest,
    registrySha256: digest,
    registryLibraries: 145,
    registryVersions: 147,
    targets,
    expectedShards: 8,
  };
}

test('release matrix gate accepts a complete current eight-shard report', () => {
  assert.deepEqual(releaseMatrixGateFindings(fixture()), []);
});

test('release matrix gate rejects stale Registry evidence and failed results', () => {
  const input = fixture();
  input.report.registry.sha256 = 'b'.repeat(64);
  input.report.results.push({ status: 'failed' });
  const findings = releaseMatrixGateFindings(input);
  assert.equal(findings.some((item) => item.includes('Registry SHA-256')), true);
  assert.equal(findings.some((item) => item.includes('unexpected results')), true);
});

test('release audit CLI parses explicit evidence paths and shard count', () => {
  const options = parseReleaseAuditArgs([
    '--report', 'matrix.json',
    '--registry', 'registry.json',
    '--fixture-manifest', 'fixtures.json',
    '--output', 'evidence.json',
    '--expected-shards', '4',
  ]);
  assert.equal(options.report.endsWith('matrix.json'), true);
  assert.equal(options.expectedShards, 4);
});
