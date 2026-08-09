#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { readFileSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evaluateBrowserLibraryPolicy } from './ck-browser-library-policy.mjs';
import {
  createBrowserLibraryRequest,
  serializeBrowserLibraryRequest,
} from './ck-browser-library-request.mjs';
import {
  createVerifierResultStreamParser,
  publicVerifierResult,
} from './ck-verifier-result.mjs';
import { validateEsp32BrowserLibraryRegistry } from '../packages/web/public/esp32/v1/library-registry.js';

const ROOT = resolve(import.meta.dirname, '..');
const RUNNER = fileURLToPath(import.meta.url);
const VERIFIER = resolve(ROOT, 'scripts/verify-ck-browser-c3-library-pack.mjs');
const DEFAULT_REGISTRY = resolve(ROOT, 'packages/web/public/esp32/v1/libraries-catalog/registry.json');
const DEFAULT_FIXTURES = resolve(ROOT, 'scripts/fixtures/ck-browser-library-compatibility.json');
const DEFAULT_REPORT = resolve(ROOT, 'var/reports/ck-browser-library-matrix.json');
const VERIFICATION_SCHEMA = 1;
const REUSABLE_STATUSES = new Set(['success']);

export const MATRIX_TARGETS = Object.freeze({
  esp32: Object.freeze({
    board: 'esp32:esp32:esp32',
    descriptor: 'packages/web/public/esp32/v5/xtensa/esp32.json',
    bundle: 'packages/web/public/esp32/v5/xtensa/clang/bundle.js',
  }),
  s2: Object.freeze({
    board: 'esp32:esp32:esp32s2',
    descriptor: 'packages/web/public/esp32/v5/xtensa/esp32s2.json',
    bundle: 'packages/web/public/esp32/v5/xtensa/clang/bundle.js',
  }),
  s3: Object.freeze({
    board: 'esp32:esp32:esp32s3',
    descriptor: 'packages/web/public/esp32/v5/xtensa/esp32s3.json',
    bundle: 'packages/web/public/esp32/v5/xtensa/clang/bundle.js',
  }),
  c3: Object.freeze({
    board: 'esp32:esp32:esp32c3',
    descriptor: 'packages/web/public/esp32/v2/runtime/runtime.json',
    bundle: 'packages/web/public/esp32/v2/clang/bundle.js',
  }),
  c6: Object.freeze({
    board: 'esp32:esp32:esp32c6',
    descriptor: 'packages/web/public/esp32/v2/runtime-c6/runtime.json',
    bundle: 'packages/web/public/esp32/v2/clang/bundle.js',
  }),
});

export function parseMatrixArgs(values) {
  const options = {
    registry: DEFAULT_REGISTRY,
    fixtures: DEFAULT_FIXTURES,
    report: DEFAULT_REPORT,
    reportExplicit: false,
    forceUnlock: false,
    targets: [],
    libraries: [],
    versions: [],
    headers: 'primary',
    shard: { index: 1, total: 1 },
    concurrency: 1,
    timeoutMs: 10 * 60 * 1000,
    maxJobs: undefined,
    resume: true,
    failFast: false,
    ignorePolicy: false,
    plan: false,
    verbose: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--target') {
      const target = requireValue(values, ++index, argument).toLowerCase();
      const targets = target === 'all' ? Object.keys(MATRIX_TARGETS) : target.split(',');
      for (const value of targets) {
        if (!Object.hasOwn(MATRIX_TARGETS, value)) {
          throw new Error(`--target must be one of ${Object.keys(MATRIX_TARGETS).join(', ')}, or all`);
        }
        if (!options.targets.includes(value)) options.targets.push(value);
      }
    } else if (argument === '--library') {
      options.libraries.push(requireValue(values, ++index, argument));
    } else if (argument === '--version') {
      options.versions.push(requireValue(values, ++index, argument));
    } else if (argument === '--headers') {
      const mode = requireValue(values, ++index, argument).toLowerCase();
      if (!['primary', 'all'].includes(mode)) throw new Error('--headers must be primary or all');
      options.headers = mode;
    } else if (argument === '--shard') {
      options.shard = parseShard(requireValue(values, ++index, argument));
    } else if (argument === '--concurrency') {
      options.concurrency = parseInteger(requireValue(values, ++index, argument), argument, 1, 4);
    } else if (argument === '--timeout-ms') {
      options.timeoutMs = parseInteger(requireValue(values, ++index, argument), argument, 1_000, 60 * 60 * 1000);
    } else if (argument === '--max-jobs') {
      options.maxJobs = parseInteger(requireValue(values, ++index, argument), argument, 1, 100_000);
    } else if (argument === '--registry') {
      options.registry = resolve(requireValue(values, ++index, argument));
    } else if (argument === '--fixture-manifest') {
      options.fixtures = resolve(requireValue(values, ++index, argument));
    } else if (argument === '--report') {
      options.report = resolve(requireValue(values, ++index, argument));
      options.reportExplicit = true;
    } else if (argument === '--force-unlock') {
      options.forceUnlock = true;
    } else if (argument === '--no-resume') {
      options.resume = false;
    } else if (argument === '--fail-fast') {
      options.failFast = true;
    } else if (argument === '--ignore-policy') {
      options.ignorePolicy = true;
    } else if (argument === '--plan') {
      options.plan = true;
    } else if (argument === '--verbose') {
      options.verbose = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.targets.length) options.targets = Object.keys(MATRIX_TARGETS);
  if (!options.reportExplicit && !isDefaultReportScope(options)) {
    options.report = scopedReportPath(options);
  }
  return Object.freeze({
    ...options,
    targets: Object.freeze([...options.targets]),
    libraries: Object.freeze([...options.libraries]),
    versions: Object.freeze([...options.versions]),
    shard: Object.freeze(options.shard),
  });
}

function isDefaultReportScope(options) {
  return options.registry === DEFAULT_REGISTRY
    && options.fixtures === DEFAULT_FIXTURES
    && options.targets.length === Object.keys(MATRIX_TARGETS).length
    && options.targets.every((target, index) => target === Object.keys(MATRIX_TARGETS)[index])
    && options.libraries.length === 0
    && options.versions.length === 0
    && options.headers === 'primary'
    && options.shard.total === 1
    && options.maxJobs === undefined
    && !options.ignorePolicy;
}

function scopedReportPath(options) {
  const scope = JSON.stringify({
    targets: options.targets,
    libraries: options.libraries,
    versions: options.versions,
    headers: options.headers,
    shard: options.shard,
    maxJobs: options.maxJobs,
    ignorePolicy: options.ignorePolicy,
    registry: options.registry,
    fixtures: options.fixtures,
  });
  return DEFAULT_REPORT.replace(/\.json$/i, `.${sha256(Buffer.from(scope)).slice(0, 12)}.json`);
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

export function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) throw new Error('--shard must use the form INDEX/TOTAL');
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || total > 1024 || index < 1 || index > total) {
    throw new Error('--shard INDEX must be between 1 and TOTAL, and TOTAL must not exceed 1024');
  }
  return Object.freeze({ index, total });
}

export function selectPrimaryHeader(libraryName, publicHeaders) {
  if (!Array.isArray(publicHeaders) || !publicHeaders.length) throw new Error(`${libraryName} has no public headers`);
  const normalizedName = normalizeHeaderStem(libraryName);
  return [...publicHeaders].sort((left, right) => {
    const leftBase = left.split('/').at(-1).replace(/\.(?:h|hh|hpp|hxx)$/i, '');
    const rightBase = right.split('/').at(-1).replace(/\.(?:h|hh|hpp|hxx)$/i, '');
    const leftScore = normalizeHeaderStem(leftBase) === normalizedName ? 0 : left.includes('/') ? 2 : 1;
    const rightScore = normalizeHeaderStem(rightBase) === normalizedName ? 0 : right.includes('/') ? 2 : 1;
    return leftScore - rightScore || left.length - right.length || left.localeCompare(right);
  })[0];
}

function normalizeHeaderStem(value) {
  const normalized = String(value).toLowerCase().replace(/\blibrary\b/g, '').replace(/[^a-z0-9]+/g, '');
  // Arduino headers commonly use a trailing `lib` suffix while the catalog
  // name does not (for example U8g2lib.h). Treat it as descriptive so the
  // library's primary API wins over shorter helper headers.
  return normalized.length > 3 && normalized.endsWith('lib')
    ? normalized.slice(0, -3)
    : normalized;
}

export function validateFixtureManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1 || !Array.isArray(value.cases)) {
    throw new Error('library compatibility fixture manifest is invalid');
  }
  const cases = value.cases.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`fixture case ${index} is invalid`);
    const allowed = new Set(['library', 'version', 'headers', 'targets', 'projectFiles', 'macros']);
    if (Object.keys(entry).some((key) => !allowed.has(key))) throw new Error(`fixture case ${index} has unknown fields`);
    if (typeof entry.library !== 'string' || !entry.library.trim()) throw new Error(`fixture case ${index} library is invalid`);
    if (entry.version !== undefined && (typeof entry.version !== 'string' || !entry.version)) {
      throw new Error(`fixture case ${index} version is invalid`);
    }
    for (const [field, values] of [['headers', entry.headers], ['targets', entry.targets]]) {
      if (values !== undefined && (!Array.isArray(values) || values.some((item) => typeof item !== 'string' || !item))) {
        throw new Error(`fixture case ${index} ${field} is invalid`);
      }
    }
    const projectFiles = entry.projectFiles ?? [];
    if (!Array.isArray(projectFiles) || projectFiles.some((file) => (
      !file || typeof file !== 'object' || Array.isArray(file)
      || Object.keys(file).some((key) => !['name', 'content'].includes(key))
      || typeof file.name !== 'string' || !file.name
      || typeof file.content !== 'string'
    ))) throw new Error(`fixture case ${index} projectFiles are invalid`);
    const macros = entry.macros ?? {};
    if (!macros || typeof macros !== 'object' || Array.isArray(macros) || Object.entries(macros).some(([name, macro]) => (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || (macro !== true && typeof macro !== 'string')
    ))) throw new Error(`fixture case ${index} macros are invalid`);
    return Object.freeze({
      library: entry.library,
      version: entry.version,
      headers: Object.freeze([...(entry.headers ?? [])]),
      targets: Object.freeze([...(entry.targets ?? [])]),
      projectFiles: Object.freeze(projectFiles.map((file) => Object.freeze({ name: file.name, content: file.content }))),
      macros: Object.freeze({ ...macros }),
    });
  });
  return Object.freeze({ schema: 1, cases: Object.freeze(cases) });
}

function fixtureFor(fixtures, job) {
  const matches = fixtures.cases.filter((entry) => (
    entry.library.toLowerCase() === job.library.toLowerCase()
    && (entry.version === undefined || entry.version === job.version)
    && (!entry.headers.length || entry.headers.some((header) => header.toLowerCase() === job.header.toLowerCase()))
    && (!entry.targets.length || entry.targets.includes(job.target))
  ));
  if (matches.length > 1) throw new Error(`multiple compatibility fixtures match ${matrixJobKey(job)}`);
  return matches[0] ?? Object.freeze({ projectFiles: Object.freeze([]), macros: Object.freeze({}) });
}

export function createMatrixJobs({
  registry,
  targets,
  platformVersions,
  fixtures,
  options,
  policyEvaluator = evaluateBrowserLibraryPolicy,
}) {
  if (typeof policyEvaluator !== 'function') throw new Error('matrix policy evaluator must be a function');
  const libraryFilters = new Set(options.libraries.map((value) => value.toLowerCase()));
  const versionFilters = new Set(options.versions);
  const matchedLibraries = new Set();
  const matchedVersions = new Set();
  const jobs = [];
  for (const library of registry.libraries) {
    if (libraryFilters.size && !libraryFilters.has(library.name.toLowerCase())) continue;
    matchedLibraries.add(library.name.toLowerCase());
    for (const version of library.versions) {
      if (versionFilters.size && !versionFilters.has(version.version)) continue;
      matchedVersions.add(version.version);
      const headers = options.headers === 'all'
        ? version.publicHeaders
        : [selectPrimaryHeader(library.name, version.publicHeaders)];
      for (const target of targets) {
        for (const header of headers) {
          const base = {
            library: library.name,
            version: version.version,
            target,
            board: MATRIX_TARGETS[target]?.board ?? target,
            header,
            manifest: fileURLToPath(version.pack.manifestUrl),
            packId: version.pack.id,
            packRevision: version.pack.revision,
            platformVersion: platformVersions.get(target),
          };
          const fixture = fixtureFor(fixtures, base);
          const policy = options.ignorePolicy ? null : policyEvaluator({
            library: library.name,
            libraryVersion: version.version,
            target,
            platformVersion: base.platformVersion,
          });
          jobs.push(Object.freeze({ ...base, fixture, policy }));
        }
      }
    }
  }
  const missingLibraries = [...libraryFilters].filter((name) => !matchedLibraries.has(name));
  if (missingLibraries.length) throw new Error(`Registry library filter did not match: ${missingLibraries.join(', ')}`);
  const missingVersions = [...versionFilters].filter((version) => !matchedVersions.has(version));
  if (missingVersions.length) throw new Error(`Registry version filter did not match: ${missingVersions.join(', ')}`);
  jobs.sort((left, right) => matrixJobKey(left).localeCompare(matrixJobKey(right)));
  const unsharded = jobs.length;
  const sharded = jobs.filter((_, index) => index % options.shard.total === options.shard.index - 1);
  return Object.freeze({
    unsharded,
    jobs: Object.freeze(options.maxJobs === undefined ? sharded : sharded.slice(0, options.maxJobs)),
  });
}

export function matrixJobKey(job) {
  return `${job.library.toLowerCase()}@${job.version}|${job.header.toLowerCase()}|${job.target}`;
}

export function classifyMatrixFailure(output, { timedOut = false, internal = false, aborted = false } = {}) {
  const normalized = String(output ?? '').toLowerCase();
  if (internal || aborted) return 'executor';
  if (timedOut || /timed out|time limit|execution limit|terminated by|exceed(?:s|ed).*time/.test(normalized)) return 'execution-limit';
  if (/heap out of memory|allocation failed|memory limit|out of memory/.test(normalized)) return 'memory-limit';
  if (/"reason"\s*:\s*"compile"/.test(normalized)) return 'compiler';
  if (/"reason"\s*:\s*"link"/.test(normalized)) return 'linker';
  if (/integrity(?: check)? (?:failed|mismatch)|checksum (?:failed|mismatch)|(?:revision|artifact).*mismatch|pack.*invalid/.test(normalized)) return 'pack-integrity';
  if (/registry|dependency.*missing|public header.*ambiguous|cannot resolve/.test(normalized)) return 'dependency-resolution';
  if (/undefined reference|linker command failed|\blink\b.*failed/.test(normalized)) return 'linker';
  if (/fatal error:|file not found|compilation terminated|\berror:/.test(normalized)) return 'compiler';
  return 'executor';
}

export function classifyStructuredMatrixFailure(result) {
  if (!result || result.status !== 'error') return undefined;
  if (result.reason === 'timeout') return 'execution-limit';
  if (result.reason === 'resource_limit') {
    return /memory|heap|allocation/i.test(`${result.message ?? ''}\n${result.diagnostic?.message ?? ''}`)
      ? 'memory-limit'
      : 'execution-limit';
  }
  if (result.reason === 'integrity') return 'pack-integrity';
  if (result.reason === 'compile') return result.actionKind === 'link' ? 'linker' : 'compiler';
  return undefined;
}

export function summarizeMatrixResults(results, expected) {
  const statuses = countBy(results, (result) => result.status);
  const failureClasses = countBy(results.filter((result) => result.failureClass), (result) => result.failureClass);
  return Object.freeze({
    expected,
    completed: results.length,
    pending: Math.max(0, expected - results.length),
    statuses,
    failureClasses,
  });
}

function countBy(values, select) {
  const counts = new Map();
  for (const value of values) {
    const key = select(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

async function readTargetContexts(targets) {
  const contexts = new Map();
  for (const target of targets) {
    const definition = MATRIX_TARGETS[target];
    const descriptorPath = resolve(ROOT, definition.descriptor);
    const descriptorBytes = await readFile(descriptorPath);
    const descriptor = JSON.parse(descriptorBytes.toString('utf8'));
    if (descriptor.board !== definition.board) throw new Error(`${target} runtime descriptor targets ${descriptor.board}`);
    const manifests = [];
    for (const pack of descriptor.packs ?? []) {
      const path = resolve(dirname(descriptorPath), ...String(pack.manifest).split('/'));
      const bytes = await readFile(path);
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (manifest.id !== pack.id || manifest.revision !== pack.revision) {
        throw new Error(`${target} ${pack.role} Pack does not match its runtime descriptor`);
      }
      manifests.push({ role: pack.role, path, bytes, manifest });
    }
    const sdk = manifests.find(({ role }) => role === 'sdk');
    if (!sdk || typeof sdk.manifest.version !== 'string') throw new Error(`${target} SDK Pack version is missing`);
    contexts.set(target, Object.freeze({
      target,
      descriptorPath,
      descriptorBytes,
      bundlePath: resolve(ROOT, definition.bundle),
      manifests: Object.freeze(manifests),
      platformVersion: sdk.manifest.version,
    }));
  }
  return contexts;
}

export function hashFingerprintEntries(entries, seed = '') {
  const hash = createHash('sha256').update(seed).update('\0');
  for (const entry of entries) {
    hash.update(String(entry.id)).update('\0').update(entry.bytes).update('\0');
  }
  return hash.digest('hex');
}

async function verificationFingerprint(registryBytes, fixtureBytes, contexts) {
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
  for (const context of [...contexts.values()].sort((left, right) => left.target.localeCompare(right.target))) {
    entries.push({ id: `targets/${context.target}/descriptor.json`, bytes: context.descriptorBytes });
    entries.push({ id: `targets/${context.target}/clang/bundle.js`, bytes: await readFile(context.bundlePath) });
    for (const pack of context.manifests) {
      entries.push({ id: `targets/${context.target}/packs/${pack.role}/manifest.json`, bytes: pack.bytes });
    }
  }
  return hashFingerprintEntries(entries, `ck-browser-library-matrix-v${VERIFICATION_SCHEMA}`);
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

export function createVerifierRequest(job, options) {
  return createBrowserLibraryRequest({
    manifest: job.manifest,
    header: job.header,
    target: job.target,
    registry: options.registry,
    projectFiles: job.fixture.projectFiles,
    macros: job.fixture.macros,
  });
}

async function writeVerifierRequest(job, options) {
  const temporaryRoot = resolve(ROOT, 'var/tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'ck-browser-library-matrix-'));
  try {
    const path = join(directory, 'request.json');
    await writeFile(path, serializeBrowserLibraryRequest(createVerifierRequest(job, options)), 'utf8');
    return Object.freeze({ directory, path });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

const CHILD_TERMINATION_GRACE_MS = 5_000;

/** Send SIGTERM first, then SIGKILL if a child does not close promptly. */
export function createChildTerminationController(child, { graceMs = CHILD_TERMINATION_GRACE_MS } = {}) {
  const state = { timedOut: false, aborted: false };
  let closed = false;
  let termSent = false;
  let escalationTimer;
  const terminate = (reason) => {
    if (closed) return;
    state[reason] = true;
    if (!termSent) {
      termSent = true;
      try { child.kill('SIGTERM'); } catch { /* close/error reports the failure */ }
    }
    if (!escalationTimer) {
      escalationTimer = setTimeout(() => {
        if (closed) return;
        try { child.kill('SIGKILL'); } catch { /* best effort */ }
      }, Math.max(1, graceMs));
      escalationTimer.unref?.();
    }
  };
  return Object.freeze({
    timeout: () => terminate('timedOut'),
    abort: () => terminate('aborted'),
    close() {
      closed = true;
      if (escalationTimer) clearTimeout(escalationTimer);
    },
    get timedOut() { return state.timedOut; },
    get aborted() { return state.aborted; },
  });
}

async function runVerifier(job, options) {
  const request = await writeVerifierRequest(job, options);
  try {
    return await new Promise((resolveResult, reject) => {
      const environment = { ...process.env };
      delete environment.CK_RUNTIME_ROOT;
      delete environment.CK_RUNTIME_DESCRIPTOR;
      environment.TEMP = resolve(ROOT, 'var/tmp');
      environment.TMP = environment.TEMP;
      environment.TMPDIR = environment.TEMP;
      const resultToken = randomUUID();
      environment.CK_VERIFIER_RESULT_TOKEN = resultToken;
      const resultParser = createVerifierResultStreamParser(resultToken);
      const child = spawn(process.execPath, [
        '--max-old-space-size=2048',
        VERIFIER,
        '--request-file',
        request.path,
      ], { cwd: ROOT, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      options.activeChildren?.add(child);
      let tail = '';
      let outputBytes = 0;
      const outputHash = createHash('sha256');
      let settled = false;
      const termination = createChildTerminationController(child, {
        graceMs: options.terminationGraceMs ?? CHILD_TERMINATION_GRACE_MS,
      });
      const capture = (chunk, stream, protocolParser) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += bytes.byteLength;
        outputHash.update(bytes);
        tail = appendTail(tail, bytes.toString('utf8'), 64 * 1024);
        protocolParser?.push(bytes);
        if (options.verbose) stream.write(bytes);
      };
      child.stdout.on('data', (chunk) => capture(chunk, process.stdout, resultParser));
      child.stderr.on('data', (chunk) => capture(chunk, process.stderr));
      const timeout = setTimeout(() => termination.timeout(), options.timeoutMs);
      timeout.unref?.();
      const abort = () => termination.abort();
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => {
        clearTimeout(timeout);
        termination.close();
        options.signal?.removeEventListener('abort', abort);
        options.activeChildren?.delete(child);
      };
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        const protocol = resultParser.finish();
        resolveResult(Object.freeze({
          exitCode: termination.timedOut || termination.aborted || signal ? 1 : (code ?? 1),
          signal,
          timedOut: termination.timedOut,
          aborted: termination.aborted,
          outputBytes,
          outputSha256: outputHash.digest('hex'),
          outputTail: tail,
          structuredResult: publicVerifierResult(protocol.result),
          protocolError: protocol.error?.message,
        }));
      });
    });
  } finally {
    await rm(request.directory, { recursive: true, force: true }).catch(() => {});
  }
}

function appendTail(previous, next, maximum) {
  const joined = previous + next;
  return joined.length <= maximum ? joined : joined.slice(joined.length - maximum);
}

function summarizeFailure(output) {
  const lines = String(output ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const messages = lines.flatMap((line) => {
    const match = /^"message"\s*:\s*("(?:\\.|[^"\\])*")[,]?$/.exec(line);
    if (!match) return [];
    try { return [JSON.parse(match[1])]; } catch { return []; }
  });
  return [...new Set([...messages.slice(-3), ...lines.slice(-10)])].join('\n').slice(-4096) || undefined;
}

function summarizeStructuredFailure(result) {
  if (!result) return undefined;
  return [...new Set([
    result.message,
    result.diagnostic?.message,
    result.diagnostic?.raw,
  ].filter((value) => typeof value === 'string' && value))].join('\n').slice(0, 4096) || undefined;
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function saveReport(path, report) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

const REPORT_LOCK_SCHEMA = 1;
const REPORT_LOCK_INIT_GRACE_MS = 5_000;
const REPORT_LOCK_RETRY_COUNT = 40;
const REPORT_LOCK_RETRY_DELAY_MS = 50;

export async function acquireReportLock(path, { forceUnlock = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const ownerPath = join(lockPath, 'owner.json');
  for (let attempt = 0; attempt < REPORT_LOCK_RETRY_COUNT; attempt += 1) {
    const token = randomUUID();
    let created = false;
    try {
      // A directory is created atomically, so a competing process never sees
      // a partially-created owner file as an invitation to steal the lock.
      await mkdir(lockPath);
      created = true;
      const owner = {
        schema: REPORT_LOCK_SCHEMA,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        startedAtMs: Date.now(),
        token,
        report: path,
      };
      await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { flag: 'wx' });
      let released = false;
      const cleanupSync = () => {
        if (released) return;
        try {
          const current = JSON.parse(readFileSync(ownerPath, 'utf8'));
          if (current?.token === token) rmSync(lockPath, { recursive: true, force: true });
        } catch { /* best effort during process exit */ }
      };
      process.once('exit', cleanupSync);
      return Object.freeze({
        token,
        path: lockPath,
        async release() {
          if (released) return;
          released = true;
          process.removeListener('exit', cleanupSync);
          const current = await readLockOwner(lockPath);
          if (current?.token !== token) return;
          await rm(lockPath, { recursive: true, force: true });
        },
      });
    } catch (error) {
      // If owner-file creation failed after this process created the directory,
      // no competing process can own it yet, so remove the incomplete lock.
      if (created) await rm(lockPath, { recursive: true, force: true }).catch(() => {});
      if (error?.code !== 'EEXIST') throw error;

      const inspection = await inspectReportLock(lockPath);
      if (inspection.active && !forceUnlock) {
        const detail = Number.isSafeInteger(inspection.owner?.pid) ? ` by PID ${inspection.owner.pid}` : '';
        throw new Error(`matrix report is already being written${detail}: ${path}`);
      }
      if (!forceUnlock && !inspection.reclaimable) {
        await delay(REPORT_LOCK_RETRY_DELAY_MS);
        continue;
      }
      if (await quarantineReportLock(lockPath)) continue;
    }
  }
  throw new Error(`matrix report lock is still initializing: ${path}`);
}

async function readLockOwner(lockPath) {
  try {
    const directory = await stat(lockPath);
    const ownerPath = directory.isDirectory() ? join(lockPath, 'owner.json') : lockPath;
    return JSON.parse(await readFile(ownerPath, 'utf8'));
  } catch {
    return undefined;
  }
}

async function inspectReportLock(lockPath) {
  let metadata;
  try { metadata = await stat(lockPath); } catch { return { active: false, reclaimable: true }; }
  const owner = await readLockOwner(lockPath);
  const ageMs = Math.max(0, Date.now() - metadata.mtimeMs);
  const hasOwnerPid = Number.isSafeInteger(owner?.pid) && owner.pid > 0;
  const validOwner = owner?.schema === REPORT_LOCK_SCHEMA
    && hasOwnerPid
    && typeof owner.token === 'string'
    && owner.token.length > 0
    && Number.isSafeInteger(owner.startedAtMs);
  let active = false;
  if (hasOwnerPid) {
    try {
      process.kill(owner.pid, 0);
      active = true;
    } catch (error) {
      // EPERM means the process exists but cannot be signalled by this user.
      active = error?.code === 'EPERM';
    }
  }
  return {
    owner: hasOwnerPid ? owner : undefined,
    active,
    reclaimable: !active && (hasOwnerPid || validOwner || ageMs >= REPORT_LOCK_INIT_GRACE_MS),
  };
}

async function quarantineReportLock(lockPath) {
  const quarantine = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'EPERM'].includes(error?.code)) return false;
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function reportResult(job, fingerprint, verification) {
  const structured = verification.structuredResult;
  const protocolMismatch = verification.protocolError
    || (verification.exitCode === 0 && structured?.status !== 'success')
    || (verification.exitCode !== 0 && structured?.status === 'success');
  const succeeded = verification.exitCode === 0 && structured?.status === 'success' && !protocolMismatch;
  const structuredFailureClass = classifyStructuredMatrixFailure(structured);
  const failureOutput = protocolMismatch
    ? verification.protocolError ?? 'child verifier exit status does not match its CK result'
    : summarizeStructuredFailure(structured) ?? summarizeFailure(verification.outputTail);
  const classificationInput = summarizeStructuredFailure(structured) ?? verification.outputTail;
  return Object.freeze({
    key: matrixJobKey(job),
    jobFingerprint: fingerprint,
    library: job.library,
    version: job.version,
    target: job.target,
    board: job.board,
    header: job.header,
    packId: job.packId,
    packRevision: job.packRevision,
    platformVersion: job.platformVersion,
    status: succeeded ? 'success' : 'failed',
    elapsedMs: verification.elapsedMs,
    exitCode: verification.exitCode,
    outputBytes: verification.outputBytes,
    outputSha256: verification.outputSha256,
    ...(structured ? { verifierResult: structured } : {}),
    ...(succeeded ? {} : {
      failureClass: protocolMismatch
        ? 'executor'
        : structuredFailureClass ?? classifyMatrixFailure(classificationInput, verification),
      ...(failureOutput ? { failureOutput } : {}),
      ...(!structured ? { protocolMissing: true } : {}),
      ...(verification.signal ? { signal: verification.signal } : {}),
    }),
  });
}

function policyResult(job, fingerprint) {
  return Object.freeze({
    key: matrixJobKey(job),
    jobFingerprint: fingerprint,
    library: job.library,
    version: job.version,
    target: job.target,
    board: job.board,
    header: job.header,
    packId: job.packId,
    packRevision: job.packRevision,
    platformVersion: job.platformVersion,
    ...job.policy,
  });
}

async function main() {
  const options = parseMatrixArgs(process.argv.slice(2));
  if (options.help) {
    console.log([
      'Usage: npm run verify:ck-browser-library-matrix -- [options]',
      '  --plan                         print the deterministic plan without compiling',
      '  --target all|esp32,s2,s3,c3,c6 select one or more targets (default: all)',
      '  --library <exact name>         select an exact Registry library (repeatable)',
      '  --version <exact version>      select an exact version (repeatable)',
      '  --headers primary|all          verify one primary or every public header',
      '  --shard INDEX/TOTAL            run one deterministic shard',
      '  --concurrency <1..4>           child verifier concurrency (default: 1)',
      '  --max-jobs <count>             cap jobs after filtering and sharding',
      '  --no-resume                    do not reuse successful report entries',
      '  --force-unlock                reclaim a stale or active report lock',
      '  --fail-fast                    stop scheduling after the first failure',
      '  --ignore-policy                compile policy-classified jobs too',
      '  --verbose                      forward complete child verifier output',
    ].join('\n'));
    return;
  }

  const [registryBytes, fixtureBytes, contexts] = await Promise.all([
    readFile(options.registry),
    readFile(options.fixtures),
    readTargetContexts(options.targets),
  ]);
  const registry = validateEsp32BrowserLibraryRegistry(
    JSON.parse(registryBytes.toString('utf8')),
    pathToFileURL(options.registry),
  );
  const fixtures = validateFixtureManifest(JSON.parse(fixtureBytes.toString('utf8')));
  const platformVersions = new Map([...contexts].map(([target, context]) => [target, context.platformVersion]));
  const plan = createMatrixJobs({
    registry,
    targets: options.targets,
    platformVersions,
    fixtures,
    options,
    policyEvaluator: evaluateBrowserLibraryPolicy,
  });
  const fingerprint = await verificationFingerprint(registryBytes, fixtureBytes, contexts);
  const registryStats = Object.freeze({
    libraries: registry.libraries.length,
    versions: registry.libraries.reduce((sum, library) => sum + library.versions.length, 0),
    publicHeaders: registry.libraries.reduce((sum, library) => (
      sum + library.versions.reduce((versionSum, version) => versionSum + version.publicHeaders.length, 0)
    ), 0),
  });
  const planSummary = {
    status: 'planned',
    executor: 'browser-wasm',
    fingerprint,
    registry: registryStats,
    headers: options.headers,
    targets: options.targets,
    filters: { libraries: options.libraries, versions: options.versions },
    shard: options.shard,
    unshardedJobs: plan.unsharded,
    selectedJobs: plan.jobs.length,
    executableJobs: plan.jobs.filter((job) => !job.policy).length,
    classifiedJobs: plan.jobs.filter((job) => job.policy).length,
    estimatedSerialMinutesAt30SecondsPerJob: Math.ceil(plan.jobs.filter((job) => !job.policy).length * 30 / 60),
  };
  if (options.plan) {
    console.log(JSON.stringify(planSummary, null, 2));
    return;
  }

  const reportLock = await acquireReportLock(options.report, { forceUnlock: options.forceUnlock });
  let stopped = false;
  const abortController = new AbortController();
  const activeChildren = new Set();
  const stopForSignal = () => {
    stopped = true;
    abortController.abort();
  };
  process.once('SIGINT', stopForSignal);
  process.once('SIGTERM', stopForSignal);
  try {
  const previous = options.resume ? await readOptionalJson(options.report) : undefined;
  const previousResults = previous?.fingerprint === fingerprint && previous?.verificationSchema === VERIFICATION_SCHEMA
    ? previous.results ?? []
    : [];
  const resultsByKey = new Map(previousResults.map((result) => [result.key ?? matrixJobKey(result), result]));
  const reusable = new Map(previousResults
    .filter((result) => REUSABLE_STATUSES.has(result.status))
    .map((result) => [result.key ?? matrixJobKey(result), result]));
  const selectedKeys = new Set(plan.jobs.map(matrixJobKey));
  let cursor = 0;
  let saveChain = Promise.resolve();
  const startedAt = new Date().toISOString();
  const report = {
    schema: 1,
    verificationSchema: VERIFICATION_SCHEMA,
    scope: 'browser-wasm-library-compile',
    compatibilityClaim: 'compile-archive-link-and-artifact-generation-only',
    fingerprint,
    generatedAt: startedAt,
    registry: { path: options.registry, sha256: sha256(registryBytes), ...registryStats },
    fixtureManifest: { path: options.fixtures, sha256: sha256(fixtureBytes) },
    configuration: {
      headers: options.headers,
      targets: options.targets,
      shard: options.shard,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      libraries: options.libraries,
      versions: options.versions,
      ignorePolicy: options.ignorePolicy,
    },
    results: [...resultsByKey.values()],
  };

  const persist = () => {
    report.generatedAt = new Date().toISOString();
    report.results = [...resultsByKey.values()].sort((left, right) => (
      (left.key ?? matrixJobKey(left)).localeCompare(right.key ?? matrixJobKey(right))
    ));
    const selected = report.results.filter((result) => selectedKeys.has(result.key ?? matrixJobKey(result)));
    report.scopeSummary = summarizeMatrixResults(selected, plan.jobs.length);
    report.summary = summarizeMatrixResults(report.results, report.results.length);
    saveChain = saveChain.then(() => saveReport(options.report, report));
    return saveChain;
  };

  async function worker() {
    while (!stopped) {
      const index = cursor++;
      if (index >= plan.jobs.length) return;
      const job = plan.jobs[index];
      const key = matrixJobKey(job);
      const fingerprintForJob = jobFingerprint(fingerprint, job);
      if (job.policy) {
        const result = policyResult(job, fingerprintForJob);
        resultsByKey.set(key, result);
        console.log(`[${index + 1}/${plan.jobs.length}] ${key}: ${result.status}`);
        await persist();
        continue;
      }
      const cached = reusable.get(key);
      if (cached?.jobFingerprint === fingerprintForJob) {
        resultsByKey.set(key, { ...cached, resumed: true });
        console.log(`[${index + 1}/${plan.jobs.length}] ${key}: resume ${cached.status}`);
        continue;
      }
      console.log(`[${index + 1}/${plan.jobs.length}] ${key}: start`);
      const started = Date.now();
      let verification;
      try {
        verification = await runVerifier(job, {
          ...options,
          signal: abortController.signal,
          activeChildren,
        });
      } catch (error) {
        const output = error instanceof Error ? error.stack ?? error.message : String(error);
        verification = {
          exitCode: 1,
          signal: undefined,
          timedOut: false,
          outputBytes: Buffer.byteLength(output),
          outputSha256: sha256(Buffer.from(output)),
          outputTail: output,
          internal: true,
        };
      }
      verification = { ...verification, elapsedMs: Date.now() - started };
      const result = reportResult(job, fingerprintForJob, verification);
      resultsByKey.set(key, result);
      await persist();
      console.log(`[${index + 1}/${plan.jobs.length}] ${key}: ${result.status} (${result.elapsedMs} ms)`);
      if (result.status === 'failed' && options.failFast) stopped = true;
    }
  }

  const workers = Array.from({ length: Math.min(options.concurrency, plan.jobs.length) }, () => worker());
  try {
    await Promise.all(workers);
  } catch (error) {
    stopped = true;
    abortController.abort();
    await Promise.allSettled(workers);
    throw error;
  }
  const [finalRegistryBytes, finalFixtureBytes, finalContexts] = await Promise.all([
    readFile(options.registry),
    readFile(options.fixtures),
    readTargetContexts(options.targets),
  ]);
  const finalFingerprint = await verificationFingerprint(finalRegistryBytes, finalFixtureBytes, finalContexts);
  report.integrity = {
    startFingerprint: fingerprint,
    endFingerprint: finalFingerprint,
    stable: finalFingerprint === fingerprint,
  };
  await persist();
  await saveChain;
  const selected = report.results.filter((result) => selectedKeys.has(result.key ?? matrixJobKey(result)));
  const summary = summarizeMatrixResults(selected, plan.jobs.length);
  const failures = selected.filter((result) => result.status === 'failed');
  console.log(JSON.stringify({
    status: failures.length || summary.pending || !report.integrity.stable ? 'failed' : 'success',
    report: options.report,
    fingerprint,
    summary,
    elapsedFrom: startedAt,
  }, null, 2));
  if (failures.length || summary.pending || !report.integrity.stable) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stopForSignal);
    process.removeListener('SIGTERM', stopForSignal);
    abortController.abort();
    await reportLock.release();
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

if (process.argv[1] && resolve(process.argv[1]) === RUNNER) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
