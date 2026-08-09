#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  matrixJobKey,
  summarizeMatrixResults,
} from './verify-ck-browser-library-matrix.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const RUNNER = fileURLToPath(import.meta.url);
const DEFAULT_REPORT_DIR = resolve(ROOT, 'var/reports');
const DEFAULT_OUTPUT = resolve(DEFAULT_REPORT_DIR, 'ck-browser-library-matrix-primary.json');
const DEFAULT_SHARDS = 8;
const DEFAULT_RETRY_PLAN = resolve(DEFAULT_REPORT_DIR, 'ck-browser-library-matrix-retry-plan.json');
const SHA256 = /^[a-f0-9]{64}$/;
const RESULT_STATUSES = new Set(['success', 'failed', 'unsupported', 'not-recommended']);

export function parseMergeArgs(values) {
  const options = {
    inputs: [],
    output: DEFAULT_OUTPUT,
    shards: DEFAULT_SHARDS,
    expectedJobs: undefined,
    retryPlan: undefined,
    currentFingerprint: undefined,
    help: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--input') {
      options.inputs.push(resolve(requireValue(values, ++index, argument)));
    } else if (argument === '--output') {
      options.output = resolve(requireValue(values, ++index, argument));
    } else if (argument === '--shards') {
      options.shards = parseInteger(requireValue(values, ++index, argument), argument, 1, 1024);
    } else if (argument === '--expected-jobs') {
      options.expectedJobs = parseInteger(requireValue(values, ++index, argument), argument, 1, 100_000);
    } else if (argument === '--retry-plan') {
      const value = values[index + 1];
      if (value && !value.startsWith('--')) {
        options.retryPlan = resolve(value);
        index += 1;
      } else {
        options.retryPlan = DEFAULT_RETRY_PLAN;
      }
    } else if (argument === '--current-fingerprint') {
      options.currentFingerprint = assertSha256(requireValue(values, ++index, argument), argument);
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.inputs.length) {
    options.inputs = Array.from({ length: options.shards }, (_, index) => resolve(
      DEFAULT_REPORT_DIR,
      `ck-browser-library-matrix-primary-shard-${index + 1}-of-${options.shards}.json`,
    ));
  }
  return Object.freeze({
    ...options,
    inputs: Object.freeze([...options.inputs]),
  });
}

function requireValue(values, index, argument) {
  const value = values[index];
  if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
  return value;
}

function parseInteger(value, argument, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${argument} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value;
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} is not a SHA-256 digest`);
  return value;
}

function canonicalScope(report) {
  const configuration = assertObject(report.configuration, 'matrix report configuration');
  return JSON.stringify({
    schema: report.schema,
    verificationSchema: report.verificationSchema,
    scope: report.scope,
    compatibilityClaim: report.compatibilityClaim,
    fingerprint: report.fingerprint,
    registry: {
      sha256: report.registry?.sha256,
      libraries: report.registry?.libraries,
      versions: report.registry?.versions,
      publicHeaders: report.registry?.publicHeaders,
    },
    fixtureSha256: report.fixtureManifest?.sha256,
    headers: configuration.headers,
    targets: configuration.targets,
    libraries: configuration.libraries,
    versions: configuration.versions,
    ignorePolicy: configuration.ignorePolicy,
    concurrency: configuration.concurrency,
    timeoutMs: configuration.timeoutMs,
  });
}

function validateConfiguration(configuration, label) {
  assertObject(configuration, `${label} configuration`);
  if (!['primary', 'all'].includes(configuration.headers)) {
    throw new Error(`${label} headers are invalid`);
  }
  if (!Array.isArray(configuration.targets) || !configuration.targets.length
    || configuration.targets.some((target) => typeof target !== 'string' || !target)) {
    throw new Error(`${label} targets are invalid`);
  }
  for (const field of ['libraries', 'versions']) {
    if (!Array.isArray(configuration[field]) || configuration[field].some((value) => typeof value !== 'string')) {
      throw new Error(`${label} ${field} are invalid`);
    }
  }
  if (typeof configuration.ignorePolicy !== 'boolean') {
    throw new Error(`${label} ignorePolicy is invalid`);
  }
  if (!Number.isSafeInteger(configuration.concurrency) || configuration.concurrency < 1 || configuration.concurrency > 4) {
    throw new Error(`${label} concurrency is invalid`);
  }
  if (!Number.isSafeInteger(configuration.timeoutMs) || configuration.timeoutMs < 1_000 || configuration.timeoutMs > 60 * 60 * 1000) {
    throw new Error(`${label} timeoutMs is invalid`);
  }
}

function sameSummary(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizedSourcePath(path) {
  const local = relative(ROOT, path);
  return (local.startsWith('..') ? resolve(path) : local).replaceAll('\\', '/');
}

const PASS_STATUS = 'success';
const RETRYABLE_STATUS = 'failed';

function resultDisposition(result) {
  if (result.status === PASS_STATUS) return 'passed';
  if (result.status === RETRYABLE_STATUS) return 'failed';
  return 'policy-excluded';
}

function countDispositions(results, pending) {
  const dispositions = countValues(results.map(resultDisposition));
  return Object.freeze({
    passed: dispositions.passed ?? 0,
    failed: dispositions.failed ?? 0,
    policyExcluded: dispositions['policy-excluded'] ?? 0,
    pending,
  });
}

function countValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function shardRetryCommand(entry) {
  const configuration = entry.report.configuration;
  const arguments_ = [
    'npm run verify:ck-browser-library-matrix --',
    `--shard ${entry.shard.index}/${entry.shard.total}`,
    `--headers ${configuration.headers}`,
    `--target ${configuration.targets.join(',')}`,
    `--concurrency ${configuration.concurrency}`,
    `--timeout-ms ${configuration.timeoutMs}`,
    `--registry ${shellQuote(normalizedSourcePath(entry.report.registry.path))}`,
    `--fixture-manifest ${shellQuote(normalizedSourcePath(entry.report.fixtureManifest.path))}`,
    `--report ${shellQuote(normalizedSourcePath(entry.path))}`,
  ];
  for (const library of configuration.libraries) arguments_.push(`--library ${shellQuote(library)}`);
  for (const version of configuration.versions) arguments_.push(`--version ${shellQuote(version)}`);
  if (configuration.ignorePolicy) arguments_.push('--ignore-policy');
  return arguments_.join(' ');
}

function validateCompleteShardOwnership(validated, results) {
  const owners = new Map();
  for (const entry of validated) {
    for (const result of entry.report.results) owners.set(result.key, entry.shard.index);
  }
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const expectedShard = index % validated.length + 1;
    const owner = owners.get(result.key);
    if (owner !== expectedShard) {
      throw new Error(`matrix job ${result.key} belongs to shard ${expectedShard}/${validated.length}, not ${owner}/${validated.length}`);
    }
  }
}

function validateShardEntries(entries, { expectedShards } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('at least one matrix shard report is required');
  const validated = entries.map((entry, position) => {
    const report = assertObject(entry?.report, `matrix shard report ${position + 1}`);
    if (report.schema !== 1 || report.verificationSchema !== 1) {
      throw new Error(`matrix shard report ${position + 1} schema is unsupported`);
    }
    if (report.scope !== 'browser-wasm-library-compile') {
      throw new Error(`matrix shard report ${position + 1} has an unexpected scope`);
    }
    if (report.compatibilityClaim !== 'compile-archive-link-and-artifact-generation-only') {
      throw new Error(`matrix shard report ${position + 1} has an unexpected compatibility claim`);
    }
    const fingerprint = assertSha256(report.fingerprint, `matrix shard report ${position + 1} fingerprint`);
    assertSha256(report.registry?.sha256, `matrix shard report ${position + 1} registry hash`);
    assertSha256(report.fixtureManifest?.sha256, `matrix shard report ${position + 1} fixture manifest hash`);
    validateConfiguration(report.configuration, `matrix shard report ${position + 1}`);
    const shard = assertObject(report.configuration?.shard, `matrix shard report ${position + 1} shard`);
    if (
      !Number.isSafeInteger(shard.index)
      || !Number.isSafeInteger(shard.total)
      || shard.total < 1
      || shard.index < 1
      || shard.index > shard.total
    ) throw new Error(`matrix shard report ${position + 1} shard is invalid`);
    if (!Array.isArray(report.results)) throw new Error(`matrix shard report ${position + 1} results are invalid`);
    const expected = report.scopeSummary?.expected;
    if (!Number.isSafeInteger(expected) || expected < 0) throw new Error(`matrix shard ${shard.index}/${shard.total} expected count is invalid`);
    if (report.results.length > expected) throw new Error(`matrix shard ${shard.index}/${shard.total} contains results outside its declared scope`);
    const summary = summarizeMatrixResults(report.results, expected);
    if (!sameSummary(summary, report.scopeSummary)) {
      throw new Error(`matrix shard ${shard.index}/${shard.total} summary does not match its results`);
    }
    for (const result of report.results) {
      if (!result || typeof result !== 'object' || result.key !== matrixJobKey(result)) {
        throw new Error(`matrix shard ${shard.index}/${shard.total} contains an invalid job key`);
      }
      if (!RESULT_STATUSES.has(result.status)) {
        throw new Error(`matrix job ${result.key} has an unsupported status: ${result.status}`);
      }
      assertSha256(result.jobFingerprint, `matrix job ${result.key} fingerprint`);
    }
    const integrity = report.integrity;
    const stable = integrity?.stable === true
      && integrity.startFingerprint === fingerprint
      && integrity.endFingerprint === fingerprint;
    return Object.freeze({
      path: entry.path ?? `shard-${shard.index}-of-${shard.total}.json`,
      bytes: entry.bytes,
      report,
      shard,
      summary,
      stable,
    });
  }).sort((left, right) => left.shard.index - right.shard.index);

  const shardTotal = validated[0].shard.total;
  if (expectedShards !== undefined && shardTotal !== expectedShards) {
    throw new Error(`expected ${expectedShards} matrix shards, reports declare ${shardTotal}`);
  }
  if (validated.length !== shardTotal) throw new Error(`expected ${shardTotal} shard reports, received ${validated.length}`);
  const shardIndexes = new Set();
  const scope = canonicalScope(validated[0].report);
  for (const entry of validated) {
    if (entry.shard.total !== shardTotal) throw new Error('matrix shard totals do not match');
    if (shardIndexes.has(entry.shard.index)) throw new Error(`matrix shard ${entry.shard.index}/${shardTotal} is duplicated`);
    shardIndexes.add(entry.shard.index);
    if (canonicalScope(entry.report) !== scope) throw new Error(`matrix shard ${entry.shard.index}/${shardTotal} scope does not match`);
  }
  for (let index = 1; index <= shardTotal; index += 1) {
    if (!shardIndexes.has(index)) throw new Error(`matrix shard ${index}/${shardTotal} is missing`);
  }
  const totalExpected = validated.reduce((sum, entry) => sum + entry.summary.expected, 0);
  const quotient = Math.floor(totalExpected / shardTotal);
  const remainder = totalExpected % shardTotal;
  for (const entry of validated) {
    const distributed = quotient + (entry.shard.index <= remainder ? 1 : 0);
    if (entry.summary.expected !== distributed) {
      throw new Error(`matrix shard ${entry.shard.index}/${shardTotal} expected count is inconsistent`);
    }
  }
  return validated;
}

export function planMatrixReportRetries(
  entries,
  { expectedJobs, expectedShards, currentFingerprint } = {},
) {
  const validated = validateShardEntries(entries, { expectedShards });
  if (currentFingerprint !== undefined && validated[0].report.fingerprint !== currentFingerprint) {
    throw new Error(`matrix reports fingerprint ${validated[0].report.fingerprint} does not match current fingerprint ${currentFingerprint}`);
  }
  const totalExpected = validated.reduce((sum, entry) => sum + entry.summary.expected, 0);
  if (expectedJobs !== undefined && totalExpected !== expectedJobs) {
    throw new Error(`expected ${expectedJobs} matrix jobs, shard reports declare ${totalExpected}`);
  }
  const seenKeys = new Map();
  for (const entry of validated) {
    for (const result of entry.report.results) {
      const previous = seenKeys.get(result.key);
      if (previous) throw new Error(`matrix job is duplicated in shards ${previous}/${entry.shard.index}: ${result.key}`);
      seenKeys.set(result.key, entry.shard.index);
    }
  }
  const completed = validated.reduce((sum, entry) => sum + entry.summary.completed, 0);
  const pending = totalExpected - completed;
  const results = validated.flatMap((entry) => entry.report.results).sort((left, right) => left.key.localeCompare(right.key));
  const failedResults = results.filter((result) => result.status === RETRYABLE_STATUS);
  const retryShards = validated.filter((entry) => entry.summary.pending > 0 || entry.summary.statuses.failed > 0);
  const dispositions = countDispositions(results, pending);
  const complete = pending === 0 && validated.every((entry) => entry.stable);
  if (complete) validateCompleteShardOwnership(validated, results);
  return Object.freeze({
    schema: 1,
    scope: 'browser-wasm-library-compile-retry-plan',
    compatibilityClaim: 'no-compatibility-claim; retry-planning-only',
    fingerprint: validated[0].report.fingerprint,
    sourceScope: JSON.parse(canonicalScope(validated[0].report)),
    summary: Object.freeze({ expected: totalExpected, completed, pending, dispositions }),
    verificationComplete: complete,
    supportScopePassed: complete && dispositions.failed === 0,
    allJobsCompatible: complete && dispositions.failed === 0 && dispositions.policyExcluded === 0,
    failureClasses: countValues(failedResults.map((result) => result.failureClass ?? 'unclassified')),
    failedLibraries: countValues(failedResults.map((result) => result.library.toLowerCase())),
    failedJobs: Object.freeze(failedResults.map((result) => Object.freeze({
      key: result.key,
      failureClass: result.failureClass ?? 'unclassified',
      shard: seenKeys.get(result.key),
    }))),
    shards: Object.freeze(validated.map((entry) => Object.freeze({
      index: entry.shard.index,
      total: entry.shard.total,
      path: normalizedSourcePath(entry.path),
      sha256: entry.bytes ? sha256(entry.bytes) : undefined,
      stable: entry.stable,
      summary: entry.summary,
      dispositions: countDispositions(entry.report.results, entry.summary.pending),
      needsRetry: entry.summary.pending > 0 || entry.summary.statuses.failed > 0,
      retryCommand: entry.summary.pending > 0 || entry.summary.statuses.failed > 0
        ? shardRetryCommand(entry)
        : undefined,
    }))),
    retryCommands: Object.freeze(retryShards.map(shardRetryCommand)),
  });
}

export function mergeMatrixReports(
  entries,
  { expectedJobs, expectedShards = DEFAULT_SHARDS, currentFingerprint } = {},
) {
  const validated = validateShardEntries(entries, { expectedShards });
  if (currentFingerprint !== undefined && validated[0].report.fingerprint !== currentFingerprint) {
    throw new Error(`matrix reports fingerprint ${validated[0].report.fingerprint} does not match current fingerprint ${currentFingerprint}`);
  }

  for (const entry of validated) {
    if (!entry.stable) throw new Error(`matrix shard report ${entry.shard.index} did not finish with a stable fingerprint`);
    if (entry.summary.completed !== entry.summary.expected || entry.summary.pending !== 0) {
      throw new Error(`matrix shard ${entry.shard.index}/${entry.shard.total} is incomplete`);
    }
    if (!sameSummary(entry.summary, entry.report.summary)) {
      throw new Error(`matrix shard ${entry.shard.index}/${entry.shard.total} aggregate summary does not match its results`);
    }
  }

  const shardTotal = validated[0].shard.total;
  const totalExpected = validated.reduce((sum, entry) => sum + entry.summary.expected, 0);
  if (expectedJobs !== undefined && totalExpected !== expectedJobs) {
    throw new Error(`expected ${expectedJobs} matrix jobs, shard reports declare ${totalExpected}`);
  }
  const results = validated.flatMap((entry) => entry.report.results).sort((left, right) => left.key.localeCompare(right.key));
  const keys = new Set();
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (keys.has(result.key)) throw new Error(`matrix job is duplicated: ${result.key}`);
    keys.add(result.key);
  }
  validateCompleteShardOwnership(validated, results);
  if (results.length !== totalExpected) throw new Error(`matrix merge completed ${results.length} of ${totalExpected} jobs`);

  const first = validated[0].report;
  const summary = summarizeMatrixResults(results, totalExpected);
  const dispositions = countDispositions(results, 0);
  const generatedAt = validated.map((entry) => entry.report.generatedAt).filter(Boolean).sort().at(-1);
  return Object.freeze({
    schema: 1,
    verificationSchema: first.verificationSchema,
    mergeSchema: 1,
    scope: first.scope,
    compatibilityClaim: first.compatibilityClaim,
    fingerprint: first.fingerprint,
    generatedAt,
    registry: first.registry,
    fixtureManifest: first.fixtureManifest,
    configuration: {
      headers: first.configuration.headers,
      targets: first.configuration.targets,
      libraries: first.configuration.libraries,
      versions: first.configuration.versions,
      ignorePolicy: first.configuration.ignorePolicy,
      concurrency: first.configuration.concurrency,
      timeoutMs: first.configuration.timeoutMs,
      shards: shardTotal,
    },
    sourceReports: validated.map((entry) => ({
      path: normalizedSourcePath(entry.path),
      sha256: entry.bytes ? sha256(entry.bytes) : undefined,
      shard: entry.shard,
      summary: entry.summary,
    })),
    results,
    scopeSummary: summary,
    summary,
    dispositions,
    verificationComplete: true,
    supportScopePassed: dispositions.failed === 0,
    allJobsCompatible: dispositions.failed === 0 && dispositions.policyExcluded === 0,
    integrity: {
      startFingerprint: first.fingerprint,
      endFingerprint: first.fingerprint,
      stable: true,
      expectedShards: shardTotal,
      mergedShards: validated.length,
      duplicateJobs: 0,
      expectedJobs: totalExpected,
      completedJobs: results.length,
    },
  });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function serializeMergedReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function saveReport(path, report) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, serializeMergedReport(report), 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  const options = parseMergeArgs(process.argv.slice(2));
  if (options.help) {
    console.log([
      'Usage: npm run merge:ck-browser-library-matrix -- [options]',
      '  --input <report.json>          add an input report (repeatable)',
      '  --output <report.json>         select the merged report path',
      '  --shards <count>               use default shard paths for this count',
      '  --expected-jobs <count>        require an exact job count (optional)',
      '  --current-fingerprint <sha256> require reports from the current verification inputs',
      '  --retry-plan [report.json]     audit partial shards and write retry commands',
    ].join('\n'));
    return;
  }
  const entries = await Promise.all(options.inputs.map(async (path) => {
    const bytes = await readFile(path);
    return { path, bytes, report: JSON.parse(bytes.toString('utf8')) };
  }));
  if (options.retryPlan) {
    const plan = planMatrixReportRetries(entries, {
      expectedJobs: options.expectedJobs,
      expectedShards: options.shards,
      currentFingerprint: options.currentFingerprint,
    });
    await saveReport(options.retryPlan, plan);
    const status = plan.verificationComplete
      ? plan.supportScopePassed ? 'verified' : 'failures'
      : 'incomplete';
    console.log(JSON.stringify({
      status,
      report: options.retryPlan,
      fingerprint: plan.fingerprint,
      summary: plan.summary,
      verificationComplete: plan.verificationComplete,
      supportScopePassed: plan.supportScopePassed,
      allJobsCompatible: plan.allJobsCompatible,
      retryCommands: plan.retryCommands,
    }, null, 2));
    if (!plan.supportScopePassed) process.exitCode = 1;
    return;
  }
  const report = mergeMatrixReports(entries, {
    expectedJobs: options.expectedJobs,
    expectedShards: options.shards,
    currentFingerprint: options.currentFingerprint,
  });
  await saveReport(options.output, report);
  const status = report.supportScopePassed
    ? report.allJobsCompatible ? 'success' : 'verified-with-policy-exclusions'
    : 'failures';
  console.log(JSON.stringify({
    status,
    report: options.output,
    fingerprint: report.fingerprint,
    summary: report.scopeSummary,
    dispositions: report.dispositions,
    verificationComplete: report.verificationComplete,
    supportScopePassed: report.supportScopePassed,
    allJobsCompatible: report.allJobsCompatible,
    integrity: report.integrity,
  }, null, 2));
  if (!report.supportScopePassed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === RUNNER) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
