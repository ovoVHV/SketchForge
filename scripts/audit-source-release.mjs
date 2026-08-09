#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const APACHE_2_LICENSE_SHA256 =
  'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';

const forbiddenSegments = new Set([
  '.deploy',
  '.secrets',
  'node_modules',
  'var',
]);

const forbiddenSuffixes = [
  '.a',
  '.bin',
  '.elf',
  '.gz',
  '.key',
  '.map',
  '.o',
  '.pack',
  '.pem',
  '.tar.gz',
  '.wasm',
  '.zip',
];

const requiredFiles = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'docs/SUPPORT_MATRIX.md',
  'docker/Dockerfile.gateway.dockerignore',
  'docker/gateway-static-allowlist.json',
  'scripts/esp32-xtensa-wasm-package/LICENSE.txt',
  'scripts/esp32-xtensa-wasm-package/licenses/LLVM-LICENSE.TXT',
  'scripts/esp32-xtensa-wasm-package/licenses/WASI-LIBC-LICENSE',
  'scripts/esp32-xtensa-wasm-package/licenses/YOWASP-RUNTIME-LICENSE.txt',
  'toolchains/esp32-xtensa-wasm/espressif-llvm-wasi.patch',
  'toolchains/esp32-xtensa-wasm/source-lock.json',
  'toolchains/esp32c3-riscv-wasm/source-lock.json',
  'toolchains/esp32c3-riscv-wasm/yowasp-riscv-backend.patch',
];

const secretSignatures = [
  /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
];

function trackedAndPendingFiles() {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8' },
  );
  return [...new Set(output.split('\0').filter(Boolean))].sort();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const files = trackedAndPendingFiles();
const fileSet = new Set(files);
const failures = [];

for (const required of requiredFiles) {
  if (!fileSet.has(required)) {
    failures.push(`required release file is missing: ${required}`);
  }
}

for (const file of files) {
  const normalized = file.replaceAll('\\', '/');
  const lower = normalized.toLowerCase();
  const segments = lower.split('/');

  if (segments.some((segment) => forbiddenSegments.has(segment))) {
    failures.push(`forbidden release path: ${normalized}`);
  }
  if (
    lower === '.env'
    || (lower.startsWith('.env.') && lower !== '.env.example')
    || lower.includes('/packages/web/gateway-public/')
    || forbiddenSuffixes.some((suffix) => lower.endsWith(suffix))
  ) {
    failures.push(`forbidden generated or secret file: ${normalized}`);
  }

  const size = statSync(file).size;
  if (size > MAX_FILE_BYTES) {
    failures.push(`file exceeds ${MAX_FILE_BYTES} bytes: ${normalized}`);
    continue;
  }

  if (size <= 1024 * 1024 && !lower.endsWith('.lock')) {
    const content = readFileSync(file, 'utf8');
    if (secretSignatures.some((signature) => signature.test(content))) {
      failures.push(`possible credential material: ${normalized}`);
    }
  }
}

if (fileSet.has('LICENSE') && sha256('LICENSE') !== APACHE_2_LICENSE_SHA256) {
  failures.push('root LICENSE is not the canonical Apache-2.0 text');
}

if (fileSet.has('.github/workflows/source-check.yml')) {
  const workflow = readFileSync('.github/workflows/source-check.yml', 'utf8');
  const actionLines = workflow.split(/\r?\n/).filter((line) => /\buses:/.test(line));
  if (
    actionLines.length === 0
    || actionLines.some((line) => !/@[0-9a-f]{40}(?:\s+#.*)?\s*$/.test(line))
  ) {
    failures.push('GitHub Actions dependencies must use full commit SHAs');
  }
}

if (failures.length > 0) {
  console.error('Source-release audit failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Source-release audit passed (${files.length} files).`);
}
