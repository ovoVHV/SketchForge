#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const RUNNER = fileURLToPath(import.meta.url);
const FILES = Object.freeze({
  readme: 'README.md',
  progress: 'MIXLU.md',
  compile: 'packages/core/src/compile.ts',
  browserAvr: 'packages/web/public/browser-avr.js',
  buildAvr: 'scripts/build-browser-avr.mjs',
  releaseLayout: 'packages/web/browser-toolchain/release-layout.json',
  browserEsp32Doc: 'packages/web/browser-esp32/README.md',
  browserToolchainDoc: 'packages/web/browser-toolchain/README.md',
  riscvToolchainDoc: 'toolchains/esp32c3-riscv-wasm/README.md',
  xtensaToolchainDoc: 'toolchains/esp32-xtensa-wasm/README.md',
  sourceNotice: 'packages/web/browser-avr/TOOLCHAIN_SOURCE.md',
  publishedSourceNotice: 'packages/web/public/avr/v4/TOOLCHAIN_SOURCE.md',
  registry: 'packages/web/public/esp32/v1/libraries-catalog/registry.json',
  release: 'packages/web/public/esp32/v1/release.js',
  cors: 'packages/server/src/cors.ts',
  gateway: 'packages/server/src/gateway.ts',
  distributedCompose: 'docker/compose.distributed.yml',
  projectFiles: 'packages/web/public/project-files.js',
  browserEsp32: 'packages/web/public/browser-esp32.js',
  packageJson: 'package.json',
  serverPackageJson: 'packages/server/package.json',
  workflow: '.github/workflows/ck-build-platform.yml',
});

function evaluateNumber(node) {
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''));
  if (ts.isParenthesizedExpression(node)) return evaluateNumber(node.expression);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    return -evaluateNumber(node.operand);
  }
  if (ts.isBinaryExpression(node)) {
    const left = evaluateNumber(node.left);
    const right = evaluateNumber(node.right);
    if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
    if (node.operatorToken.kind === ts.SyntaxKind.MinusToken) return left - right;
  }
  throw new Error('unsupported numeric constant expression');
}

function sourceConstant(source, name, kind) {
  const sourceFile = ts.createSourceFile('contract.ts', source, ts.ScriptTarget.Latest, true);
  let value;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      if (kind === 'number') value = evaluateNumber(node.initializer);
      else if (kind === 'string' && ts.isStringLiteralLike(node.initializer)) value = node.initializer.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (value === undefined) throw new Error(`source constant is missing: ${name}`);
  return value;
}

function setMembers(source, name) {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`).exec(source);
  if (!match) throw new Error(`source Set is missing: ${name}`);
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1].toLowerCase());
}

function mib(bytes) {
  return `${bytes / (1024 * 1024)} MiB`;
}

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function finding(code, file, message) {
  return Object.freeze({ code, file, message });
}

export async function auditProjectDocs({ root = ROOT, overrides = {} } = {}) {
  const cache = new Map();
  const load = async (path) => {
    if (cache.has(path)) return cache.get(path);
    const value = Object.hasOwn(overrides, path)
      ? String(overrides[path])
      : await readFile(resolve(root, path), 'utf8');
    cache.set(path, value);
    return value;
  };
  const entries = await Promise.all(Object.values(FILES).map(async (path) => [path, await load(path)]));
  const documents = Object.fromEntries(entries);
  const findings = [];
  const requireText = (file, value, code = 'missing-current-fact') => {
    const normalizedDocument = documents[file].replace(/\s+/gu, ' ');
    const normalizedValue = value.replace(/\s+/gu, ' ');
    if (!normalizedDocument.includes(normalizedValue)) findings.push(finding(code, file, `missing: ${value}`));
  };
  const forbid = (file, pattern, code = 'stale-documentation') => {
    if (pattern.test(documents[file])) findings.push(finding(code, file, `stale claim matches ${pattern}`));
  };

  const maxFiles = sourceConstant(documents[FILES.compile], 'MAX_PROJECT_FILES', 'number');
  const sourceBytes = sourceConstant(documents[FILES.compile], 'MAX_SOURCE_BYTES', 'number');
  const requestBytes = sourceConstant(documents[FILES.compile], 'MAX_COMPILE_REQUEST_BYTES', 'number');
  const sourceExtensions = setMembers(documents[FILES.compile], 'PROJECT_SOURCE_EXTENSIONS');
  const headerExtensions = setMembers(documents[FILES.compile], 'PROJECT_HEADER_EXTENSIONS');
  for (const extension of ['.c', '.cc', '.cpp', '.cxx', '.s', '.asm']) {
    if (!sourceExtensions.includes(extension)) findings.push(finding('server-extension-drift', FILES.compile, `missing source extension ${extension}`));
  }
  for (const extension of ['.h', '.hh', '.hpp', '.hxx', '.inc', '.ipp', '.tpp']) {
    if (!headerExtensions.includes(extension)) findings.push(finding('server-extension-drift', FILES.compile, `missing header extension ${extension}`));
  }
  for (const extension of ['ipp', 'tpp']) {
    requireText(FILES.projectFiles, `['${extension}', '${extension}']`, 'web-extension-drift');
    if (!new RegExp(`HEADER_EXTENSION\\s*=.*${extension}`).test(documents[FILES.browserEsp32])) {
      findings.push(finding('web-extension-drift', FILES.browserEsp32, `missing header extension ${extension}`));
    }
  }

  let runtimeVersion;
  try {
    const releaseLayout = JSON.parse(documents[FILES.releaseLayout]);
    runtimeVersion = releaseLayout?.avr?.version;
  } catch (error) {
    findings.push(finding(
      'avr-version-drift',
      FILES.releaseLayout,
      `release layout is not valid JSON: ${error?.message ?? error}`,
    ));
  }
  if (typeof runtimeVersion !== 'string' || !/^v[0-9]+$/u.test(runtimeVersion)) {
    findings.push(finding(
      'avr-version-drift',
      FILES.releaseLayout,
      'release layout does not provide a valid AVR runtime version',
    ));
  }
  requireText(FILES.buildAvr, 'const runtimeVersion = releaseLayout.avr.version;', 'avr-version-drift');
  const browserVersion = /\.\/avr\/(v\d+)\//.exec(documents[FILES.browserAvr])?.[1];
  if (!browserVersion || browserVersion !== runtimeVersion) {
    findings.push(finding('avr-version-drift', FILES.browserAvr, `browser=${browserVersion ?? 'missing'}, builder=${runtimeVersion}`));
  }
  requireText(FILES.browserToolchainDoc, `AVR \`${runtimeVersion}\` runtime`, 'avr-version-drift');
  requireText(FILES.browserToolchainDoc, `AVR ${runtimeVersion} emits`, 'avr-version-drift');

  const registry = JSON.parse(documents[FILES.registry]);
  const libraries = registry.libraries.length;
  const versions = registry.libraries.reduce((sum, library) => sum + library.versions.length, 0);
  const registrySha256 = sha256(documents[FILES.registry]);
  const releasePin = /libraries:\s*Object\.freeze\(\{[\s\S]*?sha256:\s*'([a-f0-9]{64})'/.exec(documents[FILES.release])?.[1];
  if (releasePin !== registrySha256) {
    findings.push(finding('registry-release-pin-drift', FILES.release, `release=${releasePin ?? 'missing'}, registry=${registrySha256}`));
  }
  requireText(FILES.readme, `${libraries} 个库、${versions} 个锁定版本`, 'registry-count-drift');
  for (const file of [FILES.browserEsp32Doc, FILES.browserToolchainDoc]) {
    requireText(file, `${libraries} libraries and ${versions} locked versions`, 'registry-count-drift');
  }

  requireText(FILES.readme, `总计最多 ${maxFiles} 个项目文件`, 'project-limit-drift');
  requireText(FILES.readme, `项目源码总量不超过 ${mib(sourceBytes)}`, 'project-limit-drift');
  requireText(FILES.readme, `完整 JSON 请求体不超过 ${mib(requestBytes)}`, 'project-limit-drift');
  requireText(FILES.browserEsp32Doc, `at most ${maxFiles} files in total`, 'project-limit-drift');
  requireText(FILES.browserEsp32Doc, `at most ${mib(sourceBytes)} of UTF-8 source`, 'project-limit-drift');
  requireText(FILES.browserEsp32Doc, 'The Worker ABI is Action-only', 'legacy-worker-documentation');
  requireText(FILES.riscvToolchainDoc, 'release-pinned C3 and C6 browser runtimes', 'stale-toolchain-status');
  requireText(FILES.riscvToolchainDoc, 'Current C3/C6 descriptors', 'stale-toolchain-status');
  requireText(FILES.xtensaToolchainDoc, 'current v5 runtime', 'stale-toolchain-status');

  for (const [file, patterns] of [
    [FILES.readme, [/最多 31 个/u, /P2 进行中/u, /当前固定 \*\*12 个库/u, /唯一未在仓库内完成/u]],
    [FILES.browserEsp32Doc, [/legacy single-sketch/u, /up to 31 additional/u, /512 KiB/u, /100 libraries/u, /101 locked versions/u, /not implemented yet/u]],
    [FILES.browserToolchainDoc, [/AVR v3/u, /AVR `v3`/u, /110 libraries/u, /112 locked versions/u]],
    [FILES.riscvToolchainDoc, [/C3 browser routing remains disabled/u, /The C3 link still needs/u, /Before it can be published/u]],
    [FILES.progress, [
      /\| 5\. 发布配置与遗留入口清理 \| 进行中 \| 45%/u,
      /custom partitions 的 compile\/planner\/executor\/browser 集成仍未开始/iu,
      /重发 current-only SDK\/Board Pack/u,
      /再退役 TS\/Rust schema 1/u,
    ]],
  ]) {
    for (const pattern of patterns) forbid(file, pattern);
  }
  requireText(FILES.progress, 'exact root `partitions.csv`', 'progress-record-drift');

  for (const value of ['AbortController', '`POST /v1/compile` 仍在途', '立即发送', '`DELETE`', '跨源部署', '`OPTIONS`']) {
    requireText(FILES.readme, value, 'cancel-protocol-documentation');
  }
  requireText(FILES.cors, 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS', 'cancel-cors-drift');

  for (const value of [
    "failedRetentionSeconds: positiveInt('AF_FAILED_JOB_TTL_SECONDS', 60 * 60)",
    "failedRetentionCount: positiveInt('AF_MAX_FAILED_JOBS_PER_POOL', 250)",
  ]) {
    requireText(FILES.gateway, value, 'failed-job-retention-drift');
  }
  for (const value of [
    'AF_FAILED_JOB_TTL_SECONDS: "3600"',
    'AF_MAX_FAILED_JOBS_PER_POOL: "25"',
  ]) {
    requireText(FILES.distributedCompose, value, 'failed-job-retention-drift');
  }
  for (const value of [
    '`AF_MAX_FAILED_JOBS_PER_POOL=25`',
    '`AF_FAILED_JOB_TTL_SECONDS=3600`',
  ]) {
    requireText(FILES.readme, value, 'failed-job-retention-drift');
  }
  for (const value of [
    'AF_PROJECT_TTL_SECONDS: "2592000"',
    'AF_PROJECT_MAX_PER_VISITOR: "16"',
    'AF_PROJECT_VISITOR_MAX_BYTES: "4194304"',
    'AF_PROJECT_GLOBAL_MAX_BYTES: "67108864"',
  ]) {
    requireText(FILES.distributedCompose, value, 'project-storage-quota-drift');
  }
  for (const value of [
    '每位访客限制为 16 个项目和 4 MiB',
    '`AF_PROJECT_GLOBAL_MAX_BYTES=67108864`',
  ]) {
    requireText(FILES.readme, value, 'project-storage-quota-drift');
  }

  const unchecked = [...documents[FILES.readme].matchAll(/^- \[ \] (.+)$/gm)].map((match) => match[1]);
  if (unchecked.length !== 1 || !unchecked[0].includes('真实硬件 runner')) {
    findings.push(finding('unchecked-work-drift', FILES.readme, `unexpected unchecked items: ${JSON.stringify(unchecked)}`));
  }
  requireText(FILES.readme, 'AVR GPL 对应源码是商业公开发布门禁', 'avr-source-gate-missing');
  requireText(FILES.sourceNotice, 'not the final compliance sign-off', 'avr-source-gate-missing');
  if (documents[FILES.sourceNotice] !== documents[FILES.publishedSourceNotice]) {
    findings.push(finding('avr-source-notice-drift', FILES.publishedSourceNotice, 'published v4 source notice differs from its source document'));
  }

  const packageJson = JSON.parse(documents[FILES.packageJson]);
  const serverPackageJson = JSON.parse(documents[FILES.serverPackageJson]);
  const requireScript = (file, packageDocument, name, expected) => {
    const actual = packageDocument.scripts?.[name];
    if (actual !== expected) {
      findings.push(finding('default-server-entrypoint-drift', file, `script ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
    }
  };
  for (const [name, expected] of Object.entries({
    dev: 'npm run dev:gateway --workspace @arduinofast/server',
    start: 'npm run start:gateway --workspace @arduinofast/server',
    'dev:monolith': 'npm run dev:monolith --workspace @arduinofast/server',
    'start:monolith': 'npm run start:monolith --workspace @arduinofast/server',
  })) {
    requireScript(FILES.packageJson, packageJson, name, expected);
  }
  for (const [name, expected] of Object.entries({
    dev: 'tsx watch src/gateway.ts',
    'dev:gateway': 'tsx watch src/gateway.ts',
    'dev:monolith': 'tsx watch src/index.ts',
    start: 'node dist/gateway.js',
    'start:gateway': 'node dist/gateway.js',
    'start:monolith': 'node dist/index.js',
  })) {
    requireScript(FILES.serverPackageJson, serverPackageJson, name, expected);
  }
  for (const value of [
    '根目录的 `npm run dev` 与 `npm start` 默认启动完整 Gateway',
    '`/v1/projects`、`/v1/libraries/catalog`、`/v1/libraries/installed`、队列与静态网页 API',
    '旧的本机单进程 NativeExecutor 入口仍可显式运行',
    'npm run dev:monolith',
    'npm run start:monolith',
  ]) {
    requireText(FILES.readme, value, 'default-server-entrypoint-documentation');
  }
  for (const script of [
    'audit:project-docs',
    'test:project-docs',
    'verify:project-docs',
    'audit:avr-toolchain-source',
    'gate:avr-commercial-release',
  ]) {
    if (typeof packageJson.scripts?.[script] !== 'string') findings.push(finding('docs-ci-wiring', FILES.packageJson, `missing script ${script}`));
  }
  requireText(FILES.workflow, 'npm run verify:project-docs', 'docs-ci-wiring');
  requireText(FILES.workflow, 'npm run audit:avr-toolchain-source', 'docs-ci-wiring');

  return Object.freeze({
    ok: findings.length === 0,
    findings: Object.freeze(findings),
    facts: Object.freeze({ maxFiles, sourceBytes, requestBytes, runtimeVersion, libraries, versions, registrySha256 }),
  });
}

async function main() {
  const result = await auditProjectDocs();
  if (!result.ok) {
    for (const item of result.findings) console.error(`[${item.code}] ${item.file}: ${item.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Project documentation audit passed: ${result.facts.maxFiles} files, ${mib(result.facts.sourceBytes)} source, ${mib(result.facts.requestBytes)} request, AVR ${result.facts.runtimeVersion}, ${result.facts.libraries} libraries/${result.facts.versions} versions`);
}

if (process.argv[1] && resolve(process.argv[1]) === RUNNER) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
