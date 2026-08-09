import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const lockPath = resolve(root, 'toolchains', 'esp32c3-riscv-wasm', 'source-lock.json');
const patchPath = resolve(root, 'toolchains', 'esp32c3-riscv-wasm', 'yowasp-riscv-backend.patch');
const dockerfilePath = resolve(root, 'docker', 'Dockerfile.browser-esp32c3-toolchain');
const dockerignorePath = resolve(root, 'docker', 'Dockerfile.browser-esp32c3-toolchain.dockerignore');
const workflowPath = resolve(root, '.github', 'workflows', 'browser-esp32c3-riscv-wasm.yml');
const readmePath = resolve(root, 'toolchains', 'esp32c3-riscv-wasm', 'README.md');
const sdkAcceptancePath = resolve(root, 'scripts', 'verify-esp32c3-riscv-wasm-arduino-sdk.ts');
const smokePath = resolve(root, 'scripts', 'smoke-esp32c3-riscv-wasm.mjs');
const sourceDir = process.argv[2] ? resolve(root, process.argv[2]) : null;

const sourceLock = parseLock(readFileSync(lockPath, 'utf8'));
const patch = readFileSync(patchPath, 'utf8');
const dockerfile = readFileSync(dockerfilePath, 'utf8');
const dockerignore = readFileSync(dockerignorePath, 'utf8');
const workflow = readFileSync(workflowPath, 'utf8');
const readme = readFileSync(readmePath, 'utf8');
const sdkAcceptance = readFileSync(sdkAcceptancePath, 'utf8');
const smoke = readFileSync(smokePath, 'utf8');
validatePatch(patch);
validateDockerfile(dockerfile, sourceLock);
validateDockerignore(dockerignore);
validateWorkflow(workflow);
validateBuilderDocumentation(readme);
validateWasmDriverContract(sdkAcceptance, smoke);

if (sourceDir) validateCheckout(sourceDir, sourceLock);

console.log(`PASS ESP32-C3 RISC-V WASM source lock ${sourceLock.compiler.revision}`);

function parseLock(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('ESP32-C3 RISC-V WASM source lock is not valid JSON');
  }
  const allowed = new Set(['schema', 'status', 'compiler', 'sdk']);
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('ESP32-C3 RISC-V WASM source lock has an invalid shape');
  }
  if (value.schema !== 1 || value.status !== 'feasibility-only') {
    throw new Error('ESP32-C3 RISC-V WASM source lock has an unsupported schema or status');
  }
  const compiler = exactRecord(value.compiler, [
    'repository', 'revision', 'llvmRevision', 'wasiLibcRevision', 'backend', 'hostTriple',
  ]);
  const sdk = exactRecord(value.sdk, [
    'arduinoEsp32Version', 'board', 'target', 'march',
  ]);
  if (
    compiler.repository !== 'https://github.com/YoWASP/clang.git'
    || !sha1(compiler.revision)
    || !sha1(compiler.llvmRevision)
    || !sha1(compiler.wasiLibcRevision)
    || compiler.backend !== 'RISCV'
    || compiler.hostTriple !== 'wasm32-wasip1'
  ) throw new Error('ESP32-C3 RISC-V WASM compiler source lock is invalid');
  if (
    sdk.arduinoEsp32Version !== '3.3.7'
    || sdk.board !== 'esp32:esp32:esp32c3'
    || sdk.target !== 'riscv32-esp-elf'
    || sdk.march !== 'rv32imc_zicsr_zifencei'
  ) throw new Error('ESP32-C3 RISC-V WASM SDK source lock is invalid');
  return Object.freeze({
    schema: value.schema,
    status: value.status,
    compiler: Object.freeze(compiler),
    sdk: Object.freeze(sdk),
  });
}

function validatePatch(value) {
  const removed = value.match(/^-    -DLLVM_TARGETS_TO_BUILD=WebAssembly \\$/gm) ?? [];
  const added = value.match(/^\+    -DLLVM_TARGETS_TO_BUILD=RISCV \\$/gm) ?? [];
  const removedIndented = value.match(/^-  -DLLVM_TARGETS_TO_BUILD=WebAssembly \\$/gm) ?? [];
  const addedIndented = value.match(/^\+  -DLLVM_TARGETS_TO_BUILD=RISCV \\$/gm) ?? [];
  if (removed.length !== 1 || added.length !== 1 || removedIndented.length !== 1 || addedIndented.length !== 1) {
    throw new Error('ESP32-C3 RISC-V WASM patch must replace exactly two LLVM backend selections');
  }
  if (!value.includes('diff --git a/build.sh b/build.sh')) {
    throw new Error('ESP32-C3 RISC-V WASM patch targets an unexpected file');
  }
  if (
    !value.includes('diff --git a/npmjs/package-in.json b/npmjs/package-in.json')
    || !value.includes('-    "name": "@yowasp/clang"')
    || !value.includes('+    "name": "@arduinofast/esp32c3-clang-wasm"')
  ) throw new Error('ESP32-C3 RISC-V WASM patch must use a distinct experimental package name');
}

function validateDockerfile(value, sourceLock) {
  const pins = [
    ['YOWASP_CLANG_REV', sourceLock.compiler.revision],
    ['YOWASP_LLVM_REV', sourceLock.compiler.llvmRevision],
    ['WASI_LIBC_REV', sourceLock.compiler.wasiLibcRevision],
  ];
  for (const [name, revision] of pins) {
    if (!value.includes(`ARG ${name}=${revision}`)) {
      throw new Error(`ESP32-C3 RISC-V WASM Dockerfile does not match source lock: ${name}`);
    }
  }
  if (
    !value.includes('git apply --check /tmp/yowasp-riscv-backend.patch')
    || !value.includes('FROM scratch AS artifact')
    || !value.includes('bison build-essential')
    || !value.includes('curl flex git')
    || !value.includes('Modules/Platform/WASI.cmake')
    || !value.includes('ARG BUILD_JOBS=4')
    || !value.includes('CMAKE_BUILD_PARALLEL_LEVEL=${BUILD_JOBS}')
    || !value.includes('python3 prepare.py')
    || !value.includes('npm run all')
    || !value.includes('npm pack --pack-destination dist')
    || !value.includes('LICENSE.txt npmjs/LICENSE.txt')
    || !value.includes('node_modules/@yowasp/runtime/LICENSE.txt licenses/YOWASP-RUNTIME-LICENSE.txt')
    || !value.includes('THIRD_PARTY_NOTICES.md')
  ) throw new Error('ESP32-C3 RISC-V WASM Dockerfile is missing its patch or artifact boundary');

  const packIndex = value.indexOf('npm pack --pack-destination dist');
  for (const packagedNotice of [
    'LICENSE.txt npmjs/LICENSE.txt',
    'node_modules/@yowasp/runtime/LICENSE.txt licenses/YOWASP-RUNTIME-LICENSE.txt',
    "'' > THIRD_PARTY_NOTICES.md",
  ]) {
    const noticeIndex = value.indexOf(packagedNotice);
    if (noticeIndex < 0 || noticeIndex > packIndex) {
      throw new Error(`ESP32-C3 RISC-V WASM Dockerfile packages ${packagedNotice} too late`);
    }
  }
}

function validateDockerignore(value) {
  const required = [
    '*',
    '!toolchains/',
    '!toolchains/esp32c3-riscv-wasm/',
    '!toolchains/esp32c3-riscv-wasm/yowasp-riscv-backend.patch',
  ];
  if (required.some((line) => !value.split(/\r?\n/).includes(line))) {
    throw new Error('ESP32-C3 RISC-V Docker build context is not minimized');
  }
}

function validateWorkflow(value) {
  const required = [
    'workflow_dispatch:',
    'runs-on: [self-hosted, linux, x64, esp32c3-wasm]',
    'run: npm ci',
    'bash scripts/check-esp32c3-riscv-wasm-runner.sh',
    '--target artifact',
    'scripts/verify-esp32c3-riscv-wasm-artifact.mjs',
    'scripts/smoke-esp32c3-riscv-wasm.mjs',
    'actions/upload-artifact@v4',
    'status: feasibility-only',
  ];
  for (const marker of required) {
    if (!value.includes(marker)) {
      throw new Error(`ESP32-C3 RISC-V WASM workflow is missing: ${marker}`);
    }
  }
  if (!/^permissions:\r?\n  contents: read$/m.test(value)) {
    throw new Error('ESP32-C3 RISC-V WASM workflow must have read-only repository permissions');
  }
  if (/npm publish|browser-esp32\.js|release\.js/.test(value)) {
    throw new Error('ESP32-C3 RISC-V WASM workflow must not publish or activate browser routing');
  }
  const dependencyInstall = value.indexOf('run: npm ci');
  const contractValidation = value.indexOf('run: npm run check:browser-esp32c3-ci');
  if (dependencyInstall > contractValidation) {
    throw new Error('ESP32-C3 RISC-V WASM workflow must install dependencies before validation');
  }
  const objectValidation = value.indexOf('scripts/verify-esp32c3-riscv-wasm-artifact.mjs');
  const executableSmoke = value.indexOf('scripts/smoke-esp32c3-riscv-wasm.mjs');
  if (executableSmoke < objectValidation) {
    throw new Error('ESP32-C3 RISC-V WASM workflow must link-smoke the verified compiler artifact');
  }
}

function validateBuilderDocumentation(value) {
  const required = [
    'CI builder',
    'not a browser download size',
    'not an end-user device requirement',
    'server-side fallback',
  ];
  for (const marker of required) {
    if (!value.includes(marker)) {
      throw new Error(`ESP32-C3 RISC-V WASM builder documentation is missing: ${marker}`);
    }
  }
}

function validateWasmDriverContract(sdkAcceptance, smoke) {
  const sources = [
    ['ESP32-C3 SDK acceptance', sdkAcceptance],
    ['ESP32-C3 freestanding smoke', smoke],
  ];
  for (const [name, source] of sources) {
    // YoWASP's RISC-V driver routes to its embedded ELF LLD by default, but
    // rejects this selector. Keep it out of the browser-side invocation path.
    if (/(?:^|[,[{])\s*['"]-fuse-ld=lld['"]/m.test(source)) {
      throw new Error(`${name} must not pass -fuse-ld=lld to the YoWASP RISC-V driver`);
    }
  }
  if (!sdkAcceptance.includes('`--target=${target}`') || !sdkAcceptance.includes('`-march=${march}`')) {
    throw new Error('ESP32-C3 SDK acceptance must retain its locked RISC-V compiler target');
  }
  if (!smoke.includes('`--target=${TARGET}`') || !smoke.includes('`-march=${MARCH}`')) {
    throw new Error('ESP32-C3 freestanding smoke must retain its locked RISC-V compiler target');
  }
}

function validateCheckout(directory, sourceLock) {
  const revision = git(directory, ['rev-parse', 'HEAD']);
  const llvmRevision = git(resolve(directory, 'llvm-src'), ['rev-parse', 'HEAD']);
  const wasiLibcRevision = git(resolve(directory, 'wasi-libc-src'), ['rev-parse', 'HEAD']);
  if (revision !== sourceLock.compiler.revision) {
    throw new Error(`YoWASP checkout mismatch: expected ${sourceLock.compiler.revision}, got ${revision}`);
  }
  if (llvmRevision !== sourceLock.compiler.llvmRevision) {
    throw new Error(`YoWASP LLVM submodule mismatch: expected ${sourceLock.compiler.llvmRevision}, got ${llvmRevision}`);
  }
  if (wasiLibcRevision !== sourceLock.compiler.wasiLibcRevision) {
    throw new Error(`YoWASP WASI libc submodule mismatch: expected ${sourceLock.compiler.wasiLibcRevision}, got ${wasiLibcRevision}`);
  }
  try {
    execFileSync('git', ['apply', '--check', patchPath], { cwd: directory, stdio: 'pipe' });
  } catch (error) {
    throw new Error(`ESP32-C3 RISC-V WASM patch does not apply to ${directory}: ${errorMessage(error)}`);
  }
}

function git(directory, args) {
  try {
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    throw new Error(`cannot inspect Git checkout ${directory}: ${errorMessage(error)}`);
  }
}

function exactRecord(value, keys) {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => typeof value[key] !== 'string')) {
    throw new Error('ESP32-C3 RISC-V WASM source lock has an invalid record');
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function sha1(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function errorMessage(error) {
  return String(error?.stderr?.toString?.() || error?.message || error).trim().slice(0, 512);
}
