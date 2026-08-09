import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { evaluateBrowserLibraryPolicy } from './ck-browser-library-policy.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const CATALOG = resolve(ROOT, 'packages/web/public/esp32/v1/libraries-catalog');
const REGISTRY = resolve(CATALOG, 'registry.json');
const VERIFIER = resolve(ROOT, 'scripts/verify-ck-browser-c3-library-pack.mjs');
const DEFAULT_REPORT = resolve(ROOT, 'var/reports/ck-browser-large-library-matrix.json');
const VERIFICATION_SCHEMA = 3;
const TARGETS = new Set(['c3', 'c6']);
/** @type {readonly MatrixCandidate[]} */
const CANDIDATES = Object.freeze([
  { name: 'AceButton', version: '1.10.1', header: 'AceButton.h' },
  { name: 'Adafruit TinyUSB Library', version: '3.7.7', header: 'Adafruit_TinyUSB.h' },
  { name: 'TFT_eSPI', version: '2.5.43', header: 'TFT_eSPI.h' },
  { name: 'U8g2', version: '2.36.19', header: 'U8g2lib.h' },
  { name: 'GxEPD2', version: '1.6.9', header: 'GxEPD2.h' },
  { name: 'IRremoteESP8266', version: '2.9.0', header: 'IRremoteESP8266.h' },
  { name: 'ESP8266Audio', version: '2.4.1', header: 'ESP8266Audio.h' },
  // FastLED 3.9.4 is the Registry default and is compatible with the
  // Arduino-ESP32 3.3.7 ESP32 RISC-V Pack. 3.10.x remains an upgrade
  // candidate until its fl/stl cstring declarations are fixed upstream.
  { name: 'FastLED', version: '3.9.4', header: 'FastLED.h' },
]);

const args = parseArgs(process.argv.slice(2));
const registryBytes = await readFile(REGISTRY);
const registry = JSON.parse(registryBytes.toString('utf8'));
const selectedCandidates = CANDIDATES.filter(({ name }) => !args.libraries.size || args.libraries.has(name));
if (!selectedCandidates.length) throw new Error('no large-library candidates matched --library');
const platformVersions = new Map(await Promise.all(args.targets.map(async (target) => [
  target,
  await readTargetPlatformVersion(target),
])));

const entries = new Map(registry.libraries.map((entry) => [entry.name, entry]));
const jobs = [];
/** @type {MatrixResult[]} */
const classified = [];
for (const candidate of selectedCandidates) {
  const entry = entries.get(candidate.name);
  const version = entry?.versions?.find((item) => item.version === candidate.version);
  if (!version) throw new Error(`registry is missing ${candidate.name}@${candidate.version}`);
  if (!version.publicHeaders?.includes(candidate.header)) {
    throw new Error(`${candidate.name}@${candidate.version} does not publish ${candidate.header}`);
  }
  for (const target of args.targets) {
    const policy = evaluateBrowserLibraryPolicy({
      library: candidate.name,
      libraryVersion: candidate.version,
      target,
      platformVersion: platformVersions.get(target),
    });
    if (policy) {
      classified.push({
        library: candidate.name,
        version: candidate.version,
        target,
        header: candidate.header,
        packRevision: version.pack.revision,
        platformVersion: platformVersions.get(target),
        ...policy,
      });
      continue;
    }
    jobs.push({
      ...candidate,
      target,
      manifest: resolve(CATALOG, version.pack.manifest),
      packRevision: version.pack.revision,
      platformVersion: platformVersions.get(target),
    });
  }
}
const fingerprint = await verificationFingerprint(registryBytes);
const selectedKeys = new Set([
  ...jobs.map(jobKey),
  ...classified.map(jobKey),
]);

const previous = args.resume ? await readReport(args.report) : undefined;
const sameFingerprint = previous?.fingerprint === fingerprint;
const reusable = sameFingerprint
  ? new Map(previous.results?.filter(({ status }) => status === 'success').map((result) => [jobKey(result), result]))
  : new Map();
const reportTargets = [...new Set([
  ...(sameFingerprint && Array.isArray(previous.targets) ? previous.targets : []),
  ...args.targets,
])].sort();
const reportCandidates = mergeCandidates(
  sameFingerprint && Array.isArray(previous.candidates) ? previous.candidates : [],
  selectedCandidates,
);
const report = {
  schema: 2,
  verificationSchema: VERIFICATION_SCHEMA,
  fingerprint,
  registrySha256: sha256(registryBytes),
  generatedAt: new Date().toISOString(),
  sequential: true,
  maxNodeHeapMiB: 2048,
  targets: reportTargets,
  candidates: reportCandidates,
  expected: reportTargets.length * reportCandidates.length,
  results: [
    ...(sameFingerprint
      ? previous.results?.filter((result) => !selectedKeys.has(jobKey(result))) ?? []
      : []),
    ...classified,
  ],
};

for (const [index, job] of jobs.entries()) {
  const key = jobKey(job);
  const cached = reusable.get(key);
  if (cached?.packRevision === job.packRevision) {
    report.results.push({ ...cached, resumed: true });
    console.log(`[${index + 1}/${jobs.length}] ${key}: resume success`);
    continue;
  }

  console.log(`[${index + 1}/${jobs.length}] ${key}: start`);
  const started = Date.now();
  const verification = await runVerifier(job);
  /** @type {MatrixResult} */
  const result = {
    library: job.name,
    version: job.version,
    target: job.target,
    header: job.header,
    packRevision: job.packRevision,
    platformVersion: job.platformVersion,
    status: verification.exitCode === 0 ? 'success' : 'failed',
    exitCode: verification.exitCode,
    elapsedMs: Date.now() - started,
    ...(verification.exitCode === 0 ? {} : {
      failureClass: classifyMatrixFailure(verification.output),
      failureOutput: summarizeMatrixFailure(verification.output),
    }),
  };
  report.results.push(result);
  report.generatedAt = new Date().toISOString();
  await saveReport(args.report, report);
  console.log(`[${index + 1}/${jobs.length}] ${key}: ${result.status} (${result.elapsedMs} ms)`);
  if (verification.exitCode !== 0 && args.failFast) break;
}

report.results = deduplicateResults(report.results)
  .sort((left, right) => jobKey(left).localeCompare(jobKey(right)));
const selectedResults = report.results.filter((result) => selectedKeys.has(jobKey(result)));
report.scope = {
  targets: [...args.targets],
  candidates: selectedCandidates.map(({ name, version, header }) => ({ name, version, header })),
  expected: selectedKeys.size,
  summary: summarizeMatrixResults(selectedResults, selectedKeys.size),
};
report.summary = summarizeMatrixResults(report.results, report.expected);
await saveReport(args.report, report);
const failures = selectedResults.filter(({ status }) => status === 'failed');
const total = selectedKeys.size;
const pending = total - selectedResults.length;
console.log(JSON.stringify({
  status: failures.length || pending ? 'failed' : 'success',
  fingerprint,
  report: args.report,
  completed: selectedResults.length,
  total,
  notRecommended: selectedResults.filter(({ status }) => status === 'not-recommended').map(jobKey),
  unsupported: selectedResults.filter(({ status }) => status === 'unsupported').map(jobKey),
  failures: failures.map(jobKey),
  failureClasses: report.scope.summary.failureClasses,
}, null, 2));
if (failures.length || pending) process.exitCode = 1;

function parseArgs(values) {
  const result = {
    targets: ['c3', 'c6'],
    libraries: new Set(),
    report: DEFAULT_REPORT,
    resume: true,
    failFast: false,
  };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === '--target') {
      const target = values[++index];
      if (!TARGETS.has(target)) throw new Error('--target must be c3 or c6');
      result.targets = [target];
    } else if (value === '--library') {
      const name = values[++index];
      if (!name) throw new Error('--library requires an exact Registry name');
      result.libraries.add(name);
    } else if (value === '--report') {
      const path = values[++index];
      if (!path) throw new Error('--report requires a path');
      result.report = resolve(path);
    } else if (value === '--no-resume') {
      result.resume = false;
    } else if (value === '--fail-fast') {
      result.failFast = true;
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  return result;
}

async function verificationFingerprint(registryBytes) {
  const c3Descriptor = resolve(ROOT, 'packages/web/public/esp32/v2/runtime/runtime.json');
  const c6Descriptor = resolve(ROOT, 'packages/web/public/esp32/v2/runtime-c6/runtime.json');
  const paths = [
    resolve(ROOT, 'scripts/ck-browser-library-policy.mjs'),
    resolve(ROOT, 'scripts/ck-node-action-cache.mjs'),
    VERIFIER,
    resolve(ROOT, 'packages/web/public/avr/v3/toolchain-pack.js'),
    resolve(ROOT, 'packages/web/public/avr/v3/preprocess.js'),
    resolve(ROOT, 'packages/web/public/esp32/v1/library-registry.js'),
    resolve(ROOT, 'packages/web/public/ck-build-ir-envelope.js'),
    resolve(ROOT, 'packages/web/public/ck-project-resolver.js'),
    resolve(ROOT, 'packages/web/public/ck-browser-executor.js'),
    resolve(ROOT, 'packages/web/public/esp32/v2/c3-compiler.js'),
    resolve(ROOT, 'packages/web/public/esp32/v2/ck-pack-provider.js'),
    resolve(ROOT, 'packages/web/public/esp32/v2/c3-clang-runtime.js'),
    resolve(ROOT, 'packages/web/public/esp32/v2/image-builder.js'),
    c3Descriptor,
    c6Descriptor,
    await runtimePackManifestPath(c3Descriptor, 'sdk'),
    await runtimePackManifestPath(c6Descriptor, 'sdk'),
  ];
  const hash = createHash('sha256')
    .update(`ck-browser-large-library-verification-v${VERIFICATION_SCHEMA}\0`)
    .update(registryBytes)
    .update(JSON.stringify(CANDIDATES));
  for (const path of paths) hash.update(await readFile(path));
  return hash.digest('hex');
}

async function readTargetPlatformVersion(target) {
  const descriptorPath = target === 'c3'
    ? resolve(ROOT, 'packages/web/public/esp32/v2/runtime/runtime.json')
    : resolve(ROOT, 'packages/web/public/esp32/v2/runtime-c6/runtime.json');
  const manifestPath = await runtimePackManifestPath(descriptorPath, 'sdk');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error(`ESP32 ${target} SDK Pack version is missing`);
  }
  return manifest.version;
}

async function runtimePackManifestPath(descriptorPath, role) {
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  const pack = descriptor.packs?.find((candidate) => candidate.role === role);
  if (!pack || typeof pack.manifest !== 'string') {
    throw new Error(`${role} Pack is missing from ${descriptorPath}`);
  }
  return resolve(dirname(descriptorPath), ...pack.manifest.split('/'));
}

/** @param {MatrixJob} job */
function runVerifier(job) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [
      '--max-old-space-size=2048',
      VERIFIER,
      job.manifest,
      job.header,
      job.target,
      ...(job.projectFiles ?? []).flatMap(({ name, content }) => ['--project-file', name, content]),
      ...Object.entries(job.macros ?? {}).map(([name, value]) => (
        value === true ? ['--macro', name] : ['--macro', `${name}=${value}`]
      )).flat(),
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    let outputBytes = 0;
    const capture = (chunk, stream) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      stream.write(text);
      // Failure classification only needs a bounded diagnostic tail. Keep the
      // complete child output on the console while retaining at most 64 KiB.
      if (outputBytes < 64 * 1024) {
        const remaining = 64 * 1024 - outputBytes;
        const retained = text.slice(0, remaining);
        output.push(retained);
        outputBytes += retained.length;
      }
    };
    child.stdout?.on('data', (chunk) => capture(chunk, process.stdout));
    child.stderr?.on('data', (chunk) => capture(chunk, process.stderr));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolveResult({
        exitCode: signal ? 1 : (code ?? 1),
        output: `${output.join('')}${signal ? `\nverifier terminated by ${signal}` : ''}`,
      });
    });
  });
}

function classifyMatrixFailure(output) {
  const normalized = String(output ?? '').toLowerCase();
  if (/timed out|time limit|execution limit|terminated by|exceed(?:s|ed).*time/.test(normalized)) return 'execution-limit';
  if (/integrity|checksum|revision|artifact.*mismatch|pack.*invalid/.test(normalized)) return 'pack-integrity';
  if (/registry|dependency.*missing|public header.*ambiguous/.test(normalized)) return 'registry';
  if (/diagnostic|compile|link|undefined reference|error:/.test(normalized)) return 'compiler';
  return 'executor';
}

function summarizeMatrixFailure(output) {
  const text = String(output ?? '').trim();
  if (!text) return undefined;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const messages = lines
    .map((line) => /^"message"\s*:\s*("(?:\\.|[^"\\])*")[,]?$/.exec(line)?.[1])
    .filter(Boolean)
    .map((message) => {
      try { return JSON.parse(message); } catch { return undefined; }
    })
    .filter(Boolean);
  const summary = [...new Set([...messages.slice(-3), ...lines.slice(-8)])].join('\n');
  return summary.slice(-2048);
}

function summarizeMatrixResults(results, expected) {
  const failureClasses = Object.fromEntries(
    [...new Set(results.map(({ failureClass }) => failureClass).filter(Boolean))]
      .sort()
      .map((failureClass) => [failureClass, results.filter((result) => result.failureClass === failureClass).length]),
  );
  return {
    expected,
    completed: results.length,
    pending: Math.max(0, expected - results.length),
    statuses: Object.fromEntries(
      [...new Set(results.map(({ status }) => status))]
        .sort()
        .map((status) => [status, results.filter((result) => result.status === status).length]),
    ),
    failureClasses,
  };
}

function mergeCandidates(previous, selected) {
  const merged = new Map();
  for (const candidate of [...previous, ...selected]) {
    if (!candidate || typeof candidate.name !== 'string' || typeof candidate.version !== 'string') continue;
    merged.set(`${candidate.name.toLowerCase()}@${candidate.version}`, {
      name: candidate.name,
      version: candidate.version,
      header: candidate.header,
    });
  }
  return [...merged.values()].sort((left, right) => (
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  ));
}

function deduplicateResults(results) {
  const byKey = new Map();
  for (const result of results) byKey.set(jobKey(result), result);
  return [...byKey.values()];
}

async function readReport(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function saveReport(path, report) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/** @param {{ library?: string, name?: string, version: string, target: string }} value */
function jobKey({ library, name, version, target }) {
  return `${library ?? name ?? 'unknown'}@${version}:${target}`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @typedef {object} MatrixCandidate
 * @property {string} name
 * @property {string} version
 * @property {string} header
 * @property {readonly {name: string, content: string}[]} [projectFiles]
 * @property {Readonly<Record<string, string | true>>} [macros]
 */

/**
 * @typedef {MatrixCandidate & { target: string, manifest: string, packRevision: string, platformVersion: string }} MatrixJob
 */

/**
 * @typedef {object} MatrixResult
 * @property {string} library
 * @property {string} version
 * @property {string} target
 * @property {string} header
 * @property {string} packRevision
 * @property {string} [platformVersion]
 * @property {'success' | 'failed' | 'not-recommended' | 'unsupported'} status
 * @property {string} [reason]
 * @property {number} [exitCode]
 * @property {number} [elapsedMs]
 * @property {'execution-limit' | 'pack-integrity' | 'registry' | 'compiler' | 'executor'} [failureClass]
 * @property {string} [failureOutput]
 * @property {boolean} [resumed]
 */
