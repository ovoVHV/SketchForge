#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  auditMatrixReport,
  currentVerificationFingerprint,
} from './audit-ck-browser-library-matrix-evidence.mjs';
import {
  MATRIX_TARGETS,
  validateFixtureManifest,
} from './verify-ck-browser-library-matrix.mjs';
import { validateEsp32BrowserLibraryRegistry } from '../packages/web/public/esp32/v1/library-registry.js';

const ROOT = resolve(import.meta.dirname, '..');
const RUNNER = fileURLToPath(import.meta.url);
const DEFAULT_REPORT = resolve(ROOT, 'var/reports/ck-browser-library-matrix-primary.json');
const DEFAULT_REGISTRY = resolve(ROOT, 'packages/web/public/esp32/v1/libraries-catalog/registry.json');
const DEFAULT_FIXTURES = resolve(ROOT, 'scripts/fixtures/ck-browser-library-compatibility.json');
const DEFAULT_OUTPUT = resolve(ROOT, 'var/reports/ck-browser-library-release-evidence.json');
const EXPECTED_SHARDS = 8;
const ACCEPTED_STATUSES = new Set(['success', 'unsupported', 'not-recommended']);

export function parseReleaseAuditArgs(values) {
  const options = {
    report: DEFAULT_REPORT,
    registry: DEFAULT_REGISTRY,
    fixtures: DEFAULT_FIXTURES,
    output: DEFAULT_OUTPUT,
    expectedShards: EXPECTED_SHARDS,
    help: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--report') options.report = resolve(requireValue(values, ++index, argument));
    else if (argument === '--registry') options.registry = resolve(requireValue(values, ++index, argument));
    else if (argument === '--fixture-manifest') options.fixtures = resolve(requireValue(values, ++index, argument));
    else if (argument === '--output') options.output = resolve(requireValue(values, ++index, argument));
    else if (argument === '--expected-shards') {
      const value = Number(requireValue(values, ++index, argument));
      if (!Number.isSafeInteger(value) || value < 1 || value > 1024) throw new Error('--expected-shards must be an integer from 1 to 1024');
      options.expectedShards = value;
    } else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return Object.freeze(options);
}

function requireValue(values, index, argument) {
  const value = values[index];
  if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
  return value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameValues(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function releaseMatrixGateFindings({
  report,
  audit,
  expectedFingerprint,
  registrySha256,
  registryLibraries,
  registryVersions,
  targets = Object.keys(MATRIX_TARGETS),
  expectedShards = EXPECTED_SHARDS,
}) {
  const findings = [...audit.errors.map((message) => `report audit: ${message}`)];
  if (!audit.accepted) findings.push('deep matrix report audit did not pass');
  if (report.fingerprint !== expectedFingerprint) findings.push('report fingerprint does not match current verification inputs');
  if (report.registry?.sha256 !== registrySha256) findings.push('report Registry SHA-256 does not match the candidate Registry');
  if (report.registry?.libraries !== registryLibraries || report.registry?.versions !== registryVersions) {
    findings.push('report Registry counts do not match the candidate Registry');
  }
  if (report.mergeSchema !== 1 || report.verificationComplete !== true || report.supportScopePassed !== true) {
    findings.push('report is not a successful merged release matrix');
  }
  if (report.configuration?.headers !== 'primary'
    || !sameValues(report.configuration?.targets, targets)
    || (report.configuration?.libraries?.length ?? 0) !== 0
    || (report.configuration?.versions?.length ?? 0) !== 0
    || report.configuration?.ignorePolicy !== false) {
    findings.push('report does not cover the unfiltered five-target primary-header scope');
  }
  if (report.configuration?.shards !== expectedShards
    || report.integrity?.expectedShards !== expectedShards
    || report.integrity?.mergedShards !== expectedShards
    || report.integrity?.duplicateJobs !== 0
    || report.integrity?.completedJobs !== report.integrity?.expectedJobs) {
    findings.push(`report is not a complete ${expectedShards}-shard merge`);
  }
  if (!Array.isArray(report.sourceReports)
    || report.sourceReports.length !== expectedShards
    || report.sourceReports.some((source) => !/^[a-f0-9]{64}$/.test(source?.sha256 ?? ''))) {
    findings.push('report does not preserve every source shard digest');
  }
  const results = Array.isArray(report.results) ? report.results : [];
  const unexpected = results.filter((result) => !ACCEPTED_STATUSES.has(result.status));
  if (unexpected.length) findings.push(`report contains ${unexpected.length} failed or unexpected results`);
  if ((audit.summary?.pending ?? 1) !== 0 || (audit.summary?.completed ?? 0) !== (audit.summary?.expected ?? -1)) {
    findings.push('report summary is incomplete');
  }
  return Object.freeze(findings);
}

export async function createBrowserLibraryReleaseEvidence({
  report,
  reportBytes,
  registryJson,
  registryBytes,
  registryUrl,
  fixtureJson,
  fixtureBytes,
  expectedShards = EXPECTED_SHARDS,
}) {
  const registry = validateEsp32BrowserLibraryRegistry(registryJson, registryUrl);
  const fixtures = validateFixtureManifest(fixtureJson);
  const targets = Object.keys(MATRIX_TARGETS);
  const registrySha256 = sha256(registryBytes);
  const fixtureSha256 = sha256(fixtureBytes);
  const expectedFingerprint = await currentVerificationFingerprint(registryBytes, fixtureBytes, targets);
  const audit = auditMatrixReport({
    report,
    registry,
    registrySha256,
    fixtureSha256,
    fixtures,
  });
  const versions = registry.libraries.reduce((sum, library) => sum + library.versions.length, 0);
  const findings = releaseMatrixGateFindings({
    report,
    audit,
    expectedFingerprint,
    registrySha256,
    registryLibraries: registry.libraries.length,
    registryVersions: versions,
    targets,
    expectedShards,
  });
  return Object.freeze({
    schema: 1,
    scope: 'browser-wasm-library-release-evidence',
    generatedAt: new Date().toISOString(),
    status: findings.length ? 'rejected' : 'success',
    registry: Object.freeze({
      sha256: registrySha256,
      libraries: registry.libraries.length,
      versions,
    }),
    matrix: Object.freeze({
      reportSha256: sha256(reportBytes),
      fingerprint: report.fingerprint,
      expectedFingerprint,
      shards: report.integrity?.mergedShards,
      summary: audit.summary,
      sourceReports: report.sourceReports,
    }),
    findings,
  });
}

export async function auditBrowserLibraryReleaseFiles({
  report: reportPath = DEFAULT_REPORT,
  registry: registryPath = DEFAULT_REGISTRY,
  fixtures: fixturePath = DEFAULT_FIXTURES,
  expectedShards = EXPECTED_SHARDS,
}) {
  const [reportBytes, registryBytes, fixtureBytes] = await Promise.all([
    readFile(reportPath),
    readFile(registryPath),
    readFile(fixturePath),
  ]);
  return createBrowserLibraryReleaseEvidence({
    report: JSON.parse(reportBytes.toString('utf8')),
    reportBytes,
    registryJson: JSON.parse(registryBytes.toString('utf8')),
    registryBytes,
    registryUrl: pathToFileURL(registryPath),
    fixtureJson: JSON.parse(fixtureBytes.toString('utf8')),
    fixtureBytes,
    expectedShards,
  });
}

async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  const options = parseReleaseAuditArgs(process.argv.slice(2));
  if (options.help) {
    console.log([
      'Usage: npm run audit:ck-browser-library-release -- [options]',
      '  --report <merged-report.json>   complete merged primary-header matrix',
      '  --registry <registry.json>      candidate release Registry',
      '  --fixture-manifest <json>       compatibility fixtures used by the matrix',
      '  --expected-shards <count>       required source shard count (default: 8)',
      '  --output <evidence.json>        write audited release evidence',
    ].join('\n'));
    return;
  }
  const evidence = await auditBrowserLibraryReleaseFiles(options);
  await saveJson(options.output, evidence);
  console.log(JSON.stringify({
    status: evidence.status,
    output: options.output,
    registry: evidence.registry,
    matrix: {
      fingerprint: evidence.matrix.fingerprint,
      shards: evidence.matrix.shards,
      summary: evidence.matrix.summary,
    },
    findings: evidence.findings,
  }, null, 2));
  if (evidence.status !== 'success') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === RUNNER) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
