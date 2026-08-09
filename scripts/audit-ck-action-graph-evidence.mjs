#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalEvidenceJson,
  evidenceSha256,
  PLANNING_EXCLUSIONS,
  PLANNING_NORMALIZATION,
} from './ck-action-graph-evidence.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REQUIRED = Object.freeze([
  ['browser-wasm', 'esp32:esp32:esp32'],
  ['browser-wasm', 'esp32:esp32:esp32s2'],
  ['browser-wasm', 'esp32:esp32:esp32s3'],
  ['browser-wasm', 'esp32:esp32:esp32c3'],
  ['browser-wasm', 'esp32:esp32:esp32c6'],
  ['native', 'esp32:esp32:esp32'],
  ['native', 'esp32:esp32:esp32s2'],
  ['native', 'esp32:esp32:esp32s3'],
  ['native', 'esp32:esp32:esp32c3'],
  ['native', 'esp32:esp32:esp32c6'],
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function jsonFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /^(?:browser-wasm|native)-[a-z0-9._-]+\.json$/.test(entry.name)) files.push(path);
    }
  }
  await visit(root);
  return files.sort(compareText);
}

function validateReport(report, path) {
  const fail = (message) => { throw new Error(`${path}: ${message}`); };
  if (!report || typeof report !== 'object') fail('report must be an object');
  if (report.schema !== 2 || report.verificationSchema !== 2) fail('unsupported evidence schema');
  if (report.scope !== 'ck-action-graph-runtime') fail('unexpected evidence scope');
  if (report.status !== 'pass') fail(`runtime verification did not pass (${String(report.status)})`);
  if (!['browser-wasm', 'native'].includes(report.executor)) fail('unexpected executor');
  if (typeof report.fqbn !== 'string' || report.fqbn.split(':').length !== 3) fail('invalid FQBN');
  if (!SOURCE_REVISION.test(String(report.sourceRevision ?? ''))) fail('sourceRevision is missing or invalid');
  if (!SHA256.test(String(report.buildIr?.sha256 ?? ''))) fail('invalid Build IR hash');
  if (!Number.isSafeInteger(report.buildIr?.count) || report.buildIr.count < 1) fail('invalid Action count');
  if (!SHA256.test(String(report.buildIr?.keysSha256 ?? ''))) fail('invalid Action key-set hash');
  if (
    report.planning?.schema !== 1
    || report.planning?.normalization !== PLANNING_NORMALIZATION
    || canonicalEvidenceJson(report.planning?.exclusions) !== canonicalEvidenceJson(PLANNING_EXCLUSIONS)
    || !report.planning?.summary
    || evidenceSha256(report.planning.summary) !== report.planning.sha256
    || evidenceSha256(report.planning.summary.project) !== report.planning.projectSha256
    || evidenceSha256(report.planning.summary.actions) !== report.planning.actionGraphSha256
  ) fail('invalid normalized planning summary');
  if (!Array.isArray(report.packs) || report.packs.length < 3
    || report.packs.some((pack) => !SHA256.test(String(pack?.sha256 ?? '')))) fail('invalid Pack evidence');
  if (!Array.isArray(report.artifacts) || report.artifacts.length < 1
    || report.artifacts.some((artifact) => !SHA256.test(String(artifact?.sha256 ?? '')))) fail('invalid artifact evidence');
  if (report.firstExecution?.status !== 'success') fail('first execution failed');
  if (report.cacheReplay?.status !== 'success'
    || report.cacheReplay?.fullyCached !== true
    || report.cacheReplay?.artifactIdentityMatch !== true) fail('cache replay is incomplete');
  if (
    report.incrementalMain?.status !== 'pass'
    || typeof report.incrementalMain?.mainSourcePath !== 'string'
    || !SHA256.test(String(report.incrementalMain?.buildIrSha256 ?? ''))
    || !SHA256.test(String(report.incrementalMain?.actionKeysSha256 ?? ''))
    || !SHA256.test(String(report.incrementalMain?.planningSha256 ?? ''))
    || report.incrementalMain?.execution?.status !== 'success'
    || !Array.isArray(report.incrementalMain?.actionDelta)
    || report.incrementalMain.actionDelta.length !== report.buildIr.count
    || report.incrementalMain?.artifactIdentityChanged !== true
  ) fail('incremental main rebuild evidence is incomplete');
  const deltas = report.incrementalMain.actionDelta;
  const proves = (role, keyChanged) => deltas.some((action) => (
    action?.role === role && action?.keyChanged === keyChanged && action?.cached === !keyChanged
  ));
  if (!proves('core', false) || !proves('library', false)) {
    fail('incremental main rebuild does not prove Core and Library cache hits');
  }
  if (!proves('project', true) || !proves('link', true) || !proves('image', true)) {
    fail('incremental main rebuild does not prove project, link, and image reruns');
  }
  const { reportSha256, ...unsigned } = report;
  if (!SHA256.test(String(reportSha256 ?? '')) || evidenceSha256(unsigned) !== reportSha256) {
    fail('report integrity hash mismatch');
  }
  return report;
}

export async function auditActionGraphEvidence({
  root,
  required = REQUIRED,
  expectedSourceRevision,
} = {}) {
  const evidenceRoot = resolve(root ?? 'var/ck-action-graph-evidence');
  const expectedRevision = String(
    expectedSourceRevision ?? process.env.CK_SOURCE_REVISION ?? process.env.GITHUB_SHA ?? '',
  ).trim().toLowerCase();
  if (!SOURCE_REVISION.test(expectedRevision)) {
    throw new Error('expectedSourceRevision must bind the audit to the current 40- or 64-character commit digest');
  }
  const files = await jsonFiles(evidenceRoot);
  const reports = [];
  const byKey = new Map();
  for (const path of files) {
    const report = validateReport(JSON.parse(await readFile(path, 'utf8')), path);
    const key = `${report.executor}:${report.fqbn}`;
    if (byKey.has(key)) throw new Error(`duplicate runtime evidence: ${key}`);
    byKey.set(key, report);
    reports.push(report);
  }
  const missing = required
    .map(([executor, fqbn]) => `${executor}:${fqbn}`)
    .filter((key) => !byKey.has(key));
  if (missing.length > 0) throw new Error(`missing runtime evidence: ${missing.join(', ')}`);

  const revisions = [...new Set(reports.map((report) => report.sourceRevision))];
  if (revisions.length > 1) throw new Error(`runtime evidence mixes source revisions: ${revisions.join(', ')}`);
  if (revisions[0] !== expectedRevision) {
    throw new Error(`runtime evidence revision ${String(revisions[0])} does not match current revision ${expectedRevision}`);
  }
  const selected = required.map(([executor, fqbn]) => byKey.get(`${executor}:${fqbn}`));
  const pairs = [];
  for (const fqbn of [...new Set(required.map(([, value]) => value))].sort(compareText)) {
    const browser = byKey.get(`browser-wasm:${fqbn}`);
    const native = byKey.get(`native:${fqbn}`);
    if (!browser || !native) continue;
    if (browser.planning.sha256 !== native.planning.sha256) {
      throw new Error(
        `Browser/Native normalized planning mismatch for ${fqbn}: `
        + `${browser.planning.sha256} != ${native.planning.sha256}`,
      );
    }
    pairs.push({
      fqbn,
      normalization: PLANNING_NORMALIZATION,
      planningSha256: browser.planning.sha256,
      projectSha256: browser.planning.projectSha256,
      actionGraphSha256: browser.planning.actionGraphSha256,
    });
  }
  const merged = {
    schema: 2,
    scope: 'ck-action-graph-runtime-matrix',
    compatibilityClaim: 'browser-and-native-normalized-plan-cache-replay-and-main-incremental-rebuild',
    status: 'pass',
    sourceRevision: expectedRevision,
    planningNormalization: {
      id: PLANNING_NORMALIZATION,
      exclusions: PLANNING_EXCLUSIONS,
    },
    required: required.map(([executor, fqbn]) => ({ executor, fqbn })),
    reports: selected.map((report) => ({
      executor: report.executor,
      target: report.target,
      fqbn: report.fqbn,
      buildIrSha256: report.buildIr.sha256,
      actionKeysSha256: report.buildIr.keysSha256,
      normalizedPlanningSha256: report.planning.sha256,
      incrementalBuildIrSha256: report.incrementalMain.buildIrSha256,
      incrementalActionKeysSha256: report.incrementalMain.actionKeysSha256,
      packSetSha256: evidenceSha256(report.packs),
      artifactSetSha256: evidenceSha256(report.artifacts),
      reportSha256: report.reportSha256,
    })),
    pairs,
  };
  return Object.freeze({
    ...merged,
    matrixSha256: evidenceSha256(merged),
  });
}

async function save(path, report) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function parseArgs(args) {
  const options = {
    root: 'var/ck-action-graph-evidence',
    output: 'var/ck-action-graph-evidence/matrix.json',
    sourceRevision: process.env.CK_SOURCE_REVISION ?? process.env.GITHUB_SHA,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--root') options.root = args[++index];
    else if (value === '--output') options.output = args[++index];
    else if (value === '--source-revision') options.sourceRevision = args[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!options.root || !options.output || !options.sourceRevision) {
    throw new Error('evidence root, output, and current source revision are required');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await auditActionGraphEvidence({
    root: options.root,
    expectedSourceRevision: options.sourceRevision,
  });
  await save(resolve(options.output), report);
  console.log(JSON.stringify({
    status: report.status,
    reports: report.reports.length,
    matrixSha256: report.matrixSha256,
    output: resolve(options.output),
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
