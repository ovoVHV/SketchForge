#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MATRIX_TARGETS,
  matrixJobKey,
  selectPrimaryHeader,
  summarizeMatrixResults,
  validateFixtureManifest,
} from './verify-ck-browser-library-matrix.mjs';
import { validateEsp32BrowserLibraryRegistry } from '../packages/web/public/esp32/v1/library-registry.js';

const ROOT = resolve(import.meta.dirname, '..');
const RUNNER = resolve(ROOT, 'scripts/verify-ck-browser-library-matrix.mjs');
const VERIFIER = resolve(ROOT, 'scripts/verify-ck-browser-c3-library-pack.mjs');
const DEFAULT_BASELINE_REPORT = resolve(ROOT, 'var/reports/ck-browser-library-matrix-primary.json');
const DEFAULT_BASELINE_REGISTRY = resolve(
  ROOT,
  'packages/web/public/esp32/v1/libraries-catalog.previous-1785868231312/registry.json',
);
const DEFAULT_CURRENT_REGISTRY = resolve(ROOT, 'packages/web/public/esp32/v1/libraries-catalog/registry.json');
const DEFAULT_FIXTURES = resolve(ROOT, 'scripts/fixtures/ck-browser-library-compatibility.json');
const DEFAULT_CURRENT_REPORT = resolve(ROOT, 'var/reports/ck-browser-library-matrix-current-affected.json');
const DEFAULT_DNSSERVER_REPORT = resolve(ROOT, 'var/reports/ck-browser-library-matrix-current-dnsserver.json');
const DEFAULT_U8G2_REPORT = resolve(ROOT, 'var/reports/ck-browser-library-matrix-current-u8g2.json');
const DEFAULT_FULL_DELTA_REPORT = resolve(ROOT, 'var/reports/ck-browser-library-matrix-current-delta-full.json');
const DEFAULT_OUTPUT = resolve(ROOT, 'var/reports/ck-browser-library-matrix-evidence-current.json');
const VERIFICATION_SCHEMA = 1;
const SHA256 = /^[a-f0-9]{64}$/;

export function parseEvidenceArgs(values) {
  const options = {
    baselineReport: DEFAULT_BASELINE_REPORT,
    baselineRegistry: DEFAULT_BASELINE_REGISTRY,
    currentRegistry: DEFAULT_CURRENT_REGISTRY,
    fixtures: DEFAULT_FIXTURES,
    currentReports: [],
    output: DEFAULT_OUTPUT,
    targets: Object.keys(MATRIX_TARGETS),
    plan: false,
    help: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--baseline-report') {
      options.baselineReport = resolve(requireValue(values, ++index, argument));
    } else if (argument === '--baseline-registry') {
      options.baselineRegistry = resolve(requireValue(values, ++index, argument));
    } else if (argument === '--current-registry') {
      options.currentRegistry = resolve(requireValue(values, ++index, argument));
    } else if (argument === '--fixture-manifest') {
      options.fixtures = resolve(requireValue(values, ++index, argument));
    } else if (argument === '--current-report') {
      options.currentReports.push(resolve(requireValue(values, ++index, argument)));
    } else if (argument === '--output') {
      options.output = resolve(requireValue(values, ++index, argument));
    } else if (argument === '--target') {
      const value = requireValue(values, ++index, argument).toLowerCase();
      const targets = value === 'all' ? Object.keys(MATRIX_TARGETS) : value.split(',');
      if (!targets.length || targets.some((target) => !Object.hasOwn(MATRIX_TARGETS, target))) {
        throw new Error(`--target must be one of ${Object.keys(MATRIX_TARGETS).join(', ')}, or all`);
      }
      options.targets = [...new Set(targets)];
    } else if (argument === '--plan') {
      options.plan = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.currentReports.length) {
    options.currentReports.push(DEFAULT_CURRENT_REPORT, DEFAULT_DNSSERVER_REPORT, DEFAULT_U8G2_REPORT);
  }
  return Object.freeze({
    ...options,
    currentReports: Object.freeze([...options.currentReports]),
    targets: Object.freeze([...options.targets]),
  });
}

function requireValue(values, index, argument) {
  const value = values[index];
  if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
  return value;
}

function normalizeName(value) {
  return String(value).trim().toLowerCase();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function registryLibraries(registry) {
  return new Map(registry.libraries.map((library) => [normalizeName(library.name), library]));
}

function registryVersions(library) {
  return new Map((library?.versions ?? []).map((version) => [version.version, version]));
}

export function diffLibraryRegistries(baseline, current) {
  const baselineLibraries = registryLibraries(baseline);
  const currentLibraries = registryLibraries(current);
  const changes = [];
  for (const name of [...new Set([...baselineLibraries.keys(), ...currentLibraries.keys()])].sort()) {
    const before = baselineLibraries.get(name);
    const after = currentLibraries.get(name);
    const beforeVersions = registryVersions(before);
    const afterVersions = registryVersions(after);
    const versions = [];
    for (const version of [...new Set([...beforeVersions.keys(), ...afterVersions.keys()])].sort()) {
      const oldEntry = beforeVersions.get(version);
      const newEntry = afterVersions.get(version);
      if (!oldEntry) versions.push({ version, change: 'added' });
      else if (!newEntry) versions.push({ version, change: 'removed' });
      else if (canonicalJson(oldEntry) !== canonicalJson(newEntry)) {
        versions.push({
          version,
          change: 'modified',
          beforeRevision: oldEntry.pack?.revision,
          afterRevision: newEntry.pack?.revision,
          dependenciesChanged: canonicalJson(oldEntry.depends ?? []) !== canonicalJson(newEntry.depends ?? []),
          headersChanged: canonicalJson(oldEntry.publicHeaders ?? []) !== canonicalJson(newEntry.publicHeaders ?? []),
        });
      }
    }
    const defaultVersionChanged = before?.defaultVersion !== after?.defaultVersion;
    if (!before || !after || defaultVersionChanged || versions.length) {
      changes.push(Object.freeze({
        library: after?.name ?? before?.name,
        change: !before ? 'added' : !after ? 'removed' : 'modified',
        beforeDefaultVersion: before?.defaultVersion,
        afterDefaultVersion: after?.defaultVersion,
        defaultVersionChanged,
        versions: Object.freeze(versions.map(Object.freeze)),
      }));
    }
  }
  return Object.freeze(changes);
}

function reverseEdges(registry) {
  const edges = new Map();
  for (const library of registry.libraries) {
    const dependent = normalizeName(library.name);
    for (const version of library.versions) {
      for (const dependency of version.depends ?? []) {
        const dependencyName = normalizeName(dependency.name);
        if (!edges.has(dependencyName)) edges.set(dependencyName, new Set());
        edges.get(dependencyName).add(dependent);
      }
    }
  }
  return edges;
}

export function calculateReverseDependencyClosure(baseline, current, changedLibraries) {
  const baselineEdges = reverseEdges(baseline);
  const currentEdges = reverseEdges(current);
  const closure = new Set(changedLibraries.map((entry) => normalizeName(
    typeof entry === 'string' ? entry : entry.library,
  )));
  const queue = [...closure];
  while (queue.length) {
    const dependency = queue.shift();
    for (const edges of [baselineEdges, currentEdges]) {
      for (const dependent of edges.get(dependency) ?? []) {
        if (closure.has(dependent)) continue;
        closure.add(dependent);
        queue.push(dependent);
      }
    }
  }
  const baselineLibraries = registryLibraries(baseline);
  const currentLibraries = registryLibraries(current);
  return Object.freeze([...closure].sort().map((name) => Object.freeze({
    library: currentLibraries.get(name)?.name ?? baselineLibraries.get(name)?.name ?? name,
    presentInBaseline: baselineLibraries.has(name),
    presentInCurrent: currentLibraries.has(name),
    directChange: changedLibraries.some((entry) => normalizeName(
      typeof entry === 'string' ? entry : entry.library,
    ) === name),
  })));
}

function fixtureFor(fixtures, job) {
  const matches = fixtures.cases.filter((entry) => (
    normalizeName(entry.library) === normalizeName(job.library)
    && (entry.version === undefined || entry.version === job.version)
    && (!entry.headers.length || entry.headers.some((header) => normalizeName(header) === normalizeName(job.header)))
    && (!entry.targets.length || entry.targets.includes(job.target))
  ));
  if (matches.length > 1) throw new Error(`multiple compatibility fixtures match ${matrixJobKey(job)}`);
  return matches[0] ?? { projectFiles: [], macros: {} };
}

export function createExpectedPrimaryJobs(registry, libraryNames, targets, fixtures) {
  const filters = new Set(libraryNames.map(normalizeName));
  const jobs = [];
  for (const library of registry.libraries) {
    if (filters.size && !filters.has(normalizeName(library.name))) continue;
    for (const version of library.versions) {
      const header = selectPrimaryHeader(library.name, version.publicHeaders);
      for (const target of targets) {
        const job = {
          library: library.name,
          version: version.version,
          header,
          target,
          packId: version.pack.id,
          packRevision: version.pack.revision,
        };
        jobs.push(Object.freeze({ ...job, fixture: fixtureFor(fixtures, job) }));
      }
    }
  }
  return Object.freeze(jobs.sort((left, right) => matrixJobKey(left).localeCompare(matrixJobKey(right))));
}

export function createRetestJobs(registry, libraryNames, targets, fixtures) {
  if (!libraryNames.length) return Object.freeze([]);
  return createExpectedPrimaryJobs(registry, libraryNames, targets, fixtures);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function jobFingerprint(globalFingerprint, job) {
  return sha256(Buffer.from([
    globalFingerprint,
    matrixJobKey(job),
    job.packId,
    job.packRevision,
    JSON.stringify(job.fixture),
  ].join('\0')));
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function reportScopeJobs(registry, fixtures, configuration) {
  if (configuration.headers !== 'primary') throw new Error('only primary-header evidence is accepted');
  const targets = configuration.targets;
  const libraries = configuration.libraries ?? [];
  let jobs = createExpectedPrimaryJobs(registry, libraries, targets, fixtures);
  const versions = new Set(configuration.versions ?? []);
  if (versions.size) jobs = jobs.filter((job) => versions.has(job.version));
  const shard = configuration.shard;
  if (shard) jobs = jobs.filter((_, index) => index % shard.total === shard.index - 1);
  return jobs;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} is not a SHA-256 digest`);
}

export function auditMatrixReport({
  report,
  registry,
  registrySha256,
  fixtureSha256,
  fixtures,
  historicalFullPrimary = false,
}) {
  const errors = [];
  const reject = (message) => errors.push(message);
  if (report?.schema !== 1 || report?.verificationSchema !== VERIFICATION_SCHEMA) reject('unsupported report schema');
  if (report?.scope !== 'browser-wasm-library-compile') reject('unexpected report scope');
  try { assertDigest(report?.fingerprint, 'report fingerprint'); } catch (error) { reject(error.message); }
  if (report?.registry?.sha256 !== registrySha256) reject('report Registry hash does not match the audited Registry');
  if (report?.fixtureManifest?.sha256 !== fixtureSha256) reject('report fixture hash does not match the audited fixtures');
  if (report?.integrity?.stable !== true
    || report?.integrity?.startFingerprint !== report?.fingerprint
    || report?.integrity?.endFingerprint !== report?.fingerprint) {
    reject('report does not have a stable completed fingerprint');
  }
  if (!Array.isArray(report?.results)) reject('report results are invalid');
  const results = Array.isArray(report?.results) ? report.results : [];
  let expected = [];
  let expectedByKey = new Map();
  let selectedResults = [];
  let expectedCount = 0;
  if (historicalFullPrimary) {
    const configuration = report?.configuration ?? {};
    if (configuration.headers !== 'primary'
      || (configuration.libraries?.length ?? 0) !== 0
      || (configuration.versions?.length ?? 0) !== 0) {
      reject('historical baseline is not an unfiltered primary-header matrix');
    }
    const targets = new Set(configuration.targets ?? []);
    expectedCount = registry.libraries.reduce((sum, library) => sum + library.versions.length * targets.size, 0);
    const identities = new Set();
    for (const result of results) {
      const library = registryLibraries(registry).get(normalizeName(result.library));
      const version = registryVersions(library).get(result.version);
      const identity = `${normalizeName(result.library)}@${result.version}|${result.target}`;
      if (!library || !version) reject(`result is absent from the baseline Registry: ${result.key}`);
      else {
        if (!version.publicHeaders.some((header) => normalizeName(header) === normalizeName(result.header))) {
          reject(`result header is not public in the baseline Registry: ${result.key}`);
        }
        if (result.packId !== version.pack.id || result.packRevision !== version.pack.revision) {
          reject(`job Pack identity does not match: ${result.key}`);
        }
      }
      if (!targets.has(result.target)) reject(`result target is outside the baseline scope: ${result.key}`);
      if (identities.has(identity)) reject(`duplicate library/version/target result: ${identity}`);
      identities.add(identity);
      if (result.key !== matrixJobKey(result)) reject(`result key is invalid: ${result.key}`);
      const fixture = fixtureFor(fixtures, result);
      if (result.jobFingerprint !== jobFingerprint(report.fingerprint, { ...result, fixture })) {
        reject(`job fingerprint does not match: ${result.key}`);
      }
    }
    selectedResults = results;
  } else {
    try {
      expected = reportScopeJobs(registry, fixtures, report?.configuration ?? {});
    } catch (error) {
      reject(error.message);
    }
    expectedByKey = new Map(expected.map((job) => [matrixJobKey(job), job]));
    expectedCount = expected.length;
    selectedResults = results.filter((result) => expectedByKey.has(result.key));
  }
  const resultKeys = new Set();
  for (const result of selectedResults) {
    if (resultKeys.has(result.key)) reject(`duplicate result: ${result.key}`);
    resultKeys.add(result.key);
    if (!historicalFullPrimary) {
      const job = expectedByKey.get(result.key);
      if (result.jobFingerprint !== jobFingerprint(report.fingerprint, job)) {
        reject(`job fingerprint does not match: ${result.key}`);
      }
      if (result.packId !== job.packId || result.packRevision !== job.packRevision) {
        reject(`job Pack identity does not match: ${result.key}`);
      }
    }
  }
  // A report may retain unrelated results when resume is used. That is useful
  // operationally, but it is ambiguous as standalone evidence, so fail closed.
  if (results.length !== selectedResults.length) {
    reject('report contains results outside its declared configuration scope');
  } else if (!sameJson(summarizeMatrixResults(results, results.length), report?.summary)) {
    reject('aggregate summary does not match report results');
  }
  const summary = summarizeMatrixResults(selectedResults, expectedCount);
  if (!sameJson(summary, report?.scopeSummary)) reject('scope summary does not match report results');
  if (summary.pending !== 0) reject(`report is incomplete: ${summary.pending} jobs pending`);
  return Object.freeze({
    accepted: errors.length === 0,
    fingerprint: report?.fingerprint,
    expectedKeys: Object.freeze([...expectedByKey.keys()]),
    results: Object.freeze(selectedResults),
    summary,
    errors: Object.freeze(errors),
  });
}

export function groupCurrentEvidence(audits, requiredKeys, expectedFingerprint) {
  const required = new Set(requiredKeys);
  const groups = new Map();
  for (const audit of audits.filter((entry) => entry.audit.accepted)) {
    const fingerprint = audit.audit.fingerprint;
    if (!groups.has(fingerprint)) groups.set(fingerprint, { fingerprint, reports: [], results: new Map(), errors: [] });
    const group = groups.get(fingerprint);
    group.reports.push(audit.path);
    for (const result of audit.audit.results) {
      if (!required.has(result.key)) continue;
      if (group.results.has(result.key)) group.errors.push(`duplicate current evidence: ${result.key}`);
      else group.results.set(result.key, result);
    }
  }
  const summaries = [...groups.values()].map((group) => {
    const missingKeys = [...required].filter((key) => !group.results.has(key));
    const failedKeys = [...group.results.values()].filter((result) => result.status === 'failed').map((result) => result.key);
    const failedLibraries = [...new Set([...group.results.values()]
      .filter((result) => result.status === 'failed')
      .map((result) => result.library))].sort((left, right) => left.localeCompare(right));
    const unexpectedStatuses = [...group.results.values()].filter((result) => (
      !['success', 'not-recommended', 'unsupported'].includes(result.status)
    )).map((result) => result.key);
    const fingerprintCurrent = group.fingerprint === expectedFingerprint;
    const coverageComplete = fingerprintCurrent && !missingKeys.length && !group.errors.length;
    const compatibilityPassed = coverageComplete && !failedKeys.length && !unexpectedStatuses.length;
    return Object.freeze({
      fingerprint: group.fingerprint,
      fingerprintCurrent,
      reports: Object.freeze(group.reports),
      coveredJobs: group.results.size,
      requiredJobs: required.size,
      missingKeys: Object.freeze(missingKeys),
      failedKeys: Object.freeze(failedKeys),
      failedLibraries: Object.freeze(failedLibraries),
      unexpectedStatuses: Object.freeze(unexpectedStatuses),
      errors: Object.freeze(group.errors),
      coverageComplete,
      compatibilityPassed,
      complete: compatibilityPassed,
    });
  }).sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  return Object.freeze({
    groups: Object.freeze(summaries),
    coverageGroup: summaries.find((group) => group.coverageComplete),
    completeGroup: summaries.find((group) => group.complete),
  });
}

export function createCompositeProjection({
  baselineResults,
  currentResults,
  currentJobs,
  affectedKeys,
  baselineFingerprint,
  currentFingerprint,
}) {
  const baselineByKey = new Map(baselineResults.map((result) => [result.key, result]));
  const currentByKey = new Map(currentResults.map((result) => [result.key, result]));
  const affected = new Set(affectedKeys);
  const projected = [];
  const missingKeys = [];
  const provenance = { historicalBaseline: 0, currentDelta: 0 };
  for (const job of currentJobs) {
    const key = matrixJobKey(job);
    const candidate = affected.has(key) ? currentByKey.get(key) : baselineByKey.get(key);
    const expectedFingerprint = affected.has(key) ? currentFingerprint : baselineFingerprint;
    if (!candidate
      || candidate.packId !== job.packId
      || candidate.packRevision !== job.packRevision
      || candidate.jobFingerprint === undefined) {
      missingKeys.push(key);
      continue;
    }
    const source = affected.has(key) ? 'current-delta' : 'historical-baseline';
    provenance[affected.has(key) ? 'currentDelta' : 'historicalBaseline'] += 1;
    projected.push({ ...candidate, evidenceSource: source, evidenceFingerprint: expectedFingerprint });
  }
  const summary = summarizeMatrixResults(projected, currentJobs.length);
  const failed = projected.filter((result) => result.status === 'failed');
  const failedLibraries = [...new Set(failed.map((result) => result.library))]
    .sort((left, right) => left.localeCompare(right));
  const failureSources = Object.freeze({
    historicalBaseline: failed.filter((result) => result.evidenceSource === 'historical-baseline').length,
    currentDelta: failed.filter((result) => result.evidenceSource === 'current-delta').length,
  });
  return Object.freeze({
    kind: 'multi-fingerprint-composite-projection',
    currentFullMatrix: false,
    evidenceFingerprints: Object.freeze({
      historicalBaseline: baselineFingerprint,
      currentDelta: currentFingerprint,
    }),
    provenance: Object.freeze(provenance),
    summary,
    missingKeys: Object.freeze(missingKeys),
    failedKeys: Object.freeze(failed.map((result) => result.key)),
    failedLibraries: Object.freeze(failedLibraries),
    failureSources,
    compatibilityPassed: summary.pending === 0 && failed.length === 0,
  });
}

export function findPrimaryPlanDriftLibraries(baselineResults, currentJobs) {
  const baselineIdentities = new Map();
  for (const result of baselineResults) {
    baselineIdentities.set(`${normalizeName(result.library)}@${result.version}|${result.target}`, result);
  }
  const drift = new Set();
  for (const job of currentJobs) {
    const identity = `${normalizeName(job.library)}@${job.version}|${job.target}`;
    const historical = baselineIdentities.get(identity);
    if (historical && normalizeName(historical.header) !== normalizeName(job.header)) drift.add(job.library);
  }
  return Object.freeze([...drift].sort((left, right) => left.localeCompare(right)));
}

async function readTargetContexts(targets) {
  const contexts = [];
  for (const target of targets) {
    const definition = MATRIX_TARGETS[target];
    const descriptorPath = resolve(ROOT, definition.descriptor);
    const descriptorBytes = await readFile(descriptorPath);
    const descriptor = JSON.parse(descriptorBytes.toString('utf8'));
    const manifests = [];
    for (const pack of descriptor.packs ?? []) {
      const path = resolve(dirname(descriptorPath), ...String(pack.manifest).split('/'));
      manifests.push({ role: pack.role, bytes: await readFile(path) });
    }
    contexts.push({
      target,
      descriptorBytes,
      bundleBytes: await readFile(resolve(ROOT, definition.bundle)),
      manifests,
    });
  }
  return contexts;
}

export function hashFingerprintEntries(entries, seed = '') {
  const hash = createHash('sha256').update(seed).update('\0');
  for (const entry of entries) hash.update(String(entry.id)).update('\0').update(entry.bytes).update('\0');
  return hash.digest('hex');
}

export async function currentVerificationFingerprint(registryBytes, fixtureBytes, targets) {
  const entries = [
    { id: 'inputs/registry.json', bytes: registryBytes },
    { id: 'inputs/fixture-manifest.json', bytes: fixtureBytes },
  ];
  for (const [id, path] of [
    ['scripts/verify-ck-browser-library-matrix.mjs', RUNNER],
    ['scripts/verify-ck-browser-c3-library-pack.mjs', VERIFIER],
    ['scripts/ck-browser-library-request.mjs', resolve(ROOT, 'scripts/ck-browser-library-request.mjs')],
    ['scripts/ck-verifier-result.mjs', resolve(ROOT, 'scripts/ck-verifier-result.mjs')],
    ['scripts/ck-browser-library-policy.mjs', resolve(ROOT, 'scripts/ck-browser-library-policy.mjs')],
    ['scripts/ck-node-action-cache.mjs', resolve(ROOT, 'scripts/ck-node-action-cache.mjs')],
    ['packages/web/public/avr/v3/toolchain-pack.js', resolve(ROOT, 'packages/web/public/avr/v3/toolchain-pack.js')],
    ['packages/web/public/avr/v3/preprocess.js', resolve(ROOT, 'packages/web/public/avr/v3/preprocess.js')],
    ['packages/web/public/esp32/v1/library-registry.js', resolve(ROOT, 'packages/web/public/esp32/v1/library-registry.js')],
    ['packages/web/public/esp32/v1/c3-runtime.js', resolve(ROOT, 'packages/web/public/esp32/v1/c3-runtime.js')],
    ['packages/web/public/ck-build-ir-envelope.js', resolve(ROOT, 'packages/web/public/ck-build-ir-envelope.js')],
    ['packages/web/public/ck-project-resolver.js', resolve(ROOT, 'packages/web/public/ck-project-resolver.js')],
    ['packages/web/public/ck-rust-build-core.js', resolve(ROOT, 'packages/web/public/ck-rust-build-core.js')],
    ['packages/web/public/ck-build-core-wasm/build-manifest.json', resolve(ROOT, 'packages/web/public/ck-build-core-wasm/build-manifest.json')],
    ['packages/web/public/ck-build-core-wasm/ck_build_core_bg.wasm', resolve(ROOT, 'packages/web/public/ck-build-core-wasm/ck_build_core_bg.wasm')],
    ['packages/web/public/ck-browser-executor.js', resolve(ROOT, 'packages/web/public/ck-browser-executor.js')],
    ['packages/web/public/esp32/v2/c3-compiler.js', resolve(ROOT, 'packages/web/public/esp32/v2/c3-compiler.js')],
    ['packages/web/public/esp32/v2/ck-pack-provider.js', resolve(ROOT, 'packages/web/public/esp32/v2/ck-pack-provider.js')],
    ['packages/web/public/esp32/v2/c3-clang-runtime.js', resolve(ROOT, 'packages/web/public/esp32/v2/c3-clang-runtime.js')],
    ['packages/web/public/esp32/v2/image-builder.js', resolve(ROOT, 'packages/web/public/esp32/v2/image-builder.js')],
  ]) entries.push({ id, bytes: await readFile(path) });
  for (const context of (await readTargetContexts(targets)).sort((left, right) => left.target.localeCompare(right.target))) {
    entries.push({ id: `targets/${context.target}/descriptor.json`, bytes: context.descriptorBytes });
    entries.push({ id: `targets/${context.target}/clang/bundle.js`, bytes: context.bundleBytes });
    for (const pack of context.manifests) {
      entries.push({ id: `targets/${context.target}/packs/${pack.role}/manifest.json`, bytes: pack.bytes });
    }
  }
  return hashFingerprintEntries(entries, `ck-browser-library-matrix-v${VERIFICATION_SCHEMA}`);
}

function displayPath(path) {
  const local = relative(ROOT, path);
  return (local.startsWith('..') ? path : local).replaceAll('\\', '/');
}

async function readJsonEntry(path) {
  const bytes = await readFile(path);
  return { path, bytes, value: JSON.parse(bytes.toString('utf8')) };
}

async function validateBaselineSources(report) {
  const sources = [];
  for (const source of report.sourceReports ?? []) {
    const path = resolve(ROOT, source.path);
    const bytes = await readFile(path);
    const value = JSON.parse(bytes.toString('utf8'));
    sources.push({
      path: displayPath(path),
      sha256: sha256(bytes),
      expectedSha256: source.sha256,
      fingerprint: value.fingerprint,
      valid: sha256(bytes) === source.sha256 && value.fingerprint === report.fingerprint,
    });
  }
  return sources;
}

function shellQuote(value) {
  if (!/[\s"]/u.test(value)) return value;
  // PowerShell passes backslash literally inside double quotes; embedded
  // quotes are escaped with a backtick rather than a POSIX backslash.
  return `"${value.replaceAll('`', '``').replaceAll('"', '`"')}"`;
}

export async function createEvidence(options) {
  const [baselineReportEntry, baselineRegistryEntry, currentRegistryEntry, fixtureEntry] = await Promise.all([
    readJsonEntry(options.baselineReport),
    readJsonEntry(options.baselineRegistry),
    readJsonEntry(options.currentRegistry),
    readJsonEntry(options.fixtures),
  ]);
  const baselineRegistry = validateEsp32BrowserLibraryRegistry(
    baselineRegistryEntry.value,
    pathToFileURL(options.baselineRegistry),
  );
  const currentRegistry = validateEsp32BrowserLibraryRegistry(
    currentRegistryEntry.value,
    pathToFileURL(options.currentRegistry),
  );
  const fixtures = validateFixtureManifest(fixtureEntry.value);
  const baselineAudit = auditMatrixReport({
    report: baselineReportEntry.value,
    registry: baselineRegistry,
    registrySha256: sha256(baselineRegistryEntry.bytes),
    fixtureSha256: sha256(fixtureEntry.bytes),
    fixtures,
    historicalFullPrimary: true,
  });
  const baselineSources = await validateBaselineSources(baselineReportEntry.value);
  const baselineValid = baselineAudit.accepted && baselineSources.every((source) => source.valid);
  // Diff the source JSON rather than the validator's URL-resolved model. The
  // same relative manifest in two Registry directories is still the same entry.
  const changes = diffLibraryRegistries(baselineRegistryEntry.value, currentRegistryEntry.value);
  const closure = calculateReverseDependencyClosure(
    baselineRegistryEntry.value,
    currentRegistryEntry.value,
    changes,
  );
  const closureLibraries = closure.filter((entry) => entry.presentInCurrent).map((entry) => entry.library);
  const allCurrentJobs = createExpectedPrimaryJobs(
    currentRegistry,
    currentRegistry.libraries.map((library) => library.name),
    options.targets,
    fixtures,
  );
  const planDriftLibraries = findPrimaryPlanDriftLibraries(baselineAudit.results, allCurrentJobs);
  const retestLibraries = [...new Set([...closureLibraries, ...planDriftLibraries])]
    .sort((left, right) => left.localeCompare(right));
  // An empty reverse-closure means the current Registry is unchanged. Keep
  // that distinct from `undefined`/unfiltered library selection: no current
  // delta jobs are required, and the stable baseline remains the evidence
  // source for every current job.
  const expectedJobs = createRetestJobs(currentRegistry, retestLibraries, options.targets, fixtures);
  const requiredKeys = expectedJobs.map(matrixJobKey);
  const expectedFingerprint = await currentVerificationFingerprint(
    currentRegistryEntry.bytes,
    fixtureEntry.bytes,
    options.targets,
  );
  const currentReportEntries = await Promise.all((requiredKeys.length ? options.currentReports : []).map(async (path) => {
    try {
      const entry = await readJsonEntry(path);
      return {
        path: displayPath(path),
        sha256: sha256(entry.bytes),
        audit: auditMatrixReport({
          report: entry.value,
          registry: currentRegistry,
          registrySha256: sha256(currentRegistryEntry.bytes),
          fixtureSha256: sha256(fixtureEntry.bytes),
          fixtures,
        }),
      };
    } catch (error) {
      return {
        path: displayPath(path),
        audit: {
          accepted: false,
          errors: [error instanceof Error ? error.message : String(error)],
          results: [],
        },
      };
    }
  }));
  const grouped = groupCurrentEvidence(currentReportEntries, requiredKeys, expectedFingerprint);
  const coverageGroup = requiredKeys.length === 0
    ? Object.freeze({
      fingerprint: expectedFingerprint,
      reports: Object.freeze([]),
      coveredJobs: 0,
      requiredJobs: 0,
      missingKeys: Object.freeze([]),
      failedKeys: Object.freeze([]),
      failedLibraries: Object.freeze([]),
      unexpectedStatuses: Object.freeze([]),
      errors: Object.freeze([]),
      fingerprintCurrent: true,
      coverageComplete: true,
      compatibilityPassed: true,
      complete: true,
    })
    : grouped.coverageGroup;
  const currentAcceptedResults = currentReportEntries
    .filter((entry) => entry.audit.accepted && entry.audit.fingerprint === expectedFingerprint)
    .flatMap((entry) => entry.audit.results);
  const compositeProjection = coverageGroup ? createCompositeProjection({
    baselineResults: baselineAudit.results,
    currentResults: currentAcceptedResults,
    currentJobs: allCurrentJobs,
    affectedKeys: requiredKeys,
    baselineFingerprint: baselineReportEntry.value.fingerprint,
    currentFingerprint: expectedFingerprint,
  }) : undefined;
  const runnerArgs = [
    'scripts/verify-ck-browser-library-matrix.mjs',
    '--target', options.targets.join(','),
    ...retestLibraries.flatMap((library) => ['--library', library]),
    '--concurrency', '4',
    '--timeout-ms', '1200000',
    '--no-resume',
    '--report', displayPath(DEFAULT_FULL_DELTA_REPORT),
  ];
  const currentAuditArgs = [
    'scripts/audit-ck-browser-library-matrix-evidence.mjs',
    '--baseline-report', displayPath(options.baselineReport),
    '--baseline-registry', displayPath(options.baselineRegistry),
    '--current-registry', displayPath(options.currentRegistry),
    '--fixture-manifest', displayPath(options.fixtures),
    ...options.currentReports.flatMap((path) => ['--current-report', displayPath(path)]),
    '--output', displayPath(options.output),
  ];
  const fullRetestAuditArgs = [
    'scripts/audit-ck-browser-library-matrix-evidence.mjs',
    '--baseline-report', displayPath(options.baselineReport),
    '--baseline-registry', displayPath(options.baselineRegistry),
    '--current-registry', displayPath(options.currentRegistry),
    '--fixture-manifest', displayPath(options.fixtures),
    '--current-report', displayPath(DEFAULT_FULL_DELTA_REPORT),
    '--output', displayPath(options.output),
  ];
  const complete = baselineValid && Boolean(coverageGroup) && compositeProjection?.compatibilityPassed === true;
  return Object.freeze({
    schema: 1,
    scope: 'browser-wasm-library-compatibility-composite-evidence',
    generatedAt: new Date().toISOString(),
    status: complete ? 'success' : 'incomplete',
    claim: {
      kind: 'historical-stable-baseline-plus-current-registry-delta',
      currentFullMatrix: false,
      reason: 'The baseline and current delta use distinct fingerprints and remain separate evidence domains.',
    },
    baseline: {
      report: displayPath(options.baselineReport),
      reportSha256: sha256(baselineReportEntry.bytes),
      registry: displayPath(options.baselineRegistry),
      registrySha256: sha256(baselineRegistryEntry.bytes),
      fingerprint: baselineReportEntry.value.fingerprint,
      valid: baselineValid,
      summary: baselineAudit.summary,
      errors: baselineAudit.errors,
      sourceReports: baselineSources,
    },
    current: {
      registry: displayPath(options.currentRegistry),
      registrySha256: sha256(currentRegistryEntry.bytes),
      verificationFingerprint: expectedFingerprint,
      changedLibraries: changes,
      reverseDependencyClosure: closure,
      primaryPlanDriftLibraries: planDriftLibraries,
      retest: {
        targets: options.targets,
        headers: 'primary',
        libraries: retestLibraries,
        versions: expectedJobs.length / options.targets.length,
        requiredJobs: requiredKeys.length,
        requiredKeys,
      },
      reports: currentReportEntries.map((entry) => ({
        path: entry.path,
        sha256: entry.sha256,
        accepted: entry.audit.accepted,
        fingerprint: entry.audit.fingerprint,
        summary: entry.audit.summary,
        errors: entry.audit.errors,
      })),
      fingerprintGroups: grouped.groups,
      coverageFingerprint: grouped.coverageGroup?.fingerprint,
      completeFingerprint: grouped.completeGroup?.fingerprint,
    },
    compositeProjection,
    commands: {
      runnerArgs,
      fullRetest: `node ${runnerArgs.map(shellQuote).join(' ')}`,
      auditCurrentEvidence: `node ${currentAuditArgs.map(shellQuote).join(' ')}`,
      auditFullRetest: `node ${fullRetestAuditArgs.map(shellQuote).join(' ')}`,
    },
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
  const options = parseEvidenceArgs(process.argv.slice(2));
  if (options.help) {
    console.log([
      'Usage: npm run audit:ck-browser-library-matrix -- [options]',
      '  --baseline-report <report.json>   stable full-matrix report',
      '  --baseline-registry <registry>    immutable Registry matching the baseline report',
      '  --current-registry <registry>     Registry under test',
      '  --current-report <report.json>    current delta report (repeatable)',
      '  --fixture-manifest <fixtures>     compatibility fixture manifest',
      '  --target all|esp32,s2,s3,c3,c6   required targets',
      '  --output <evidence.json>          composite evidence output',
      '  --plan                            print the delta and command without writing',
    ].join('\n'));
    return;
  }
  const evidence = await createEvidence(options);
  if (!options.plan) await saveJson(options.output, evidence);
  console.log(JSON.stringify({
    status: evidence.status,
    output: options.plan ? undefined : displayPath(options.output),
    claim: evidence.claim,
    baseline: {
      fingerprint: evidence.baseline.fingerprint,
      valid: evidence.baseline.valid,
      summary: evidence.baseline.summary,
    },
    current: {
      fingerprint: evidence.current.verificationFingerprint,
      changedLibraries: evidence.current.changedLibraries.map((entry) => entry.library),
      retestLibraries: evidence.current.retest.libraries,
      requiredJobs: evidence.current.retest.requiredJobs,
      completeFingerprint: evidence.current.completeFingerprint,
    },
    compositeProjection: evidence.compositeProjection ? {
      summary: evidence.compositeProjection.summary,
      provenance: evidence.compositeProjection.provenance,
      failureSources: evidence.compositeProjection.failureSources,
      failedLibraries: evidence.compositeProjection.failedLibraries,
    } : undefined,
    commands: evidence.commands,
  }, null, 2));
  if (!options.plan && evidence.status !== 'success') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
