#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = '@arduinofast/esp32-xtensa-clang-wasm';
export const EXPECTED_PACKAGE_FILES = Object.freeze([
  'LICENSE.txt',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'gen/bundle.js',
  'gen/llvm-resources.tar',
  'gen/llvm.core.wasm',
  'gen/llvm.core2.wasm',
  'gen/llvm.core3.wasm',
  'gen/llvm.core4.wasm',
  'lib/api.d.ts',
  'licenses/LLVM-LICENSE.TXT',
  'licenses/WASI-LIBC-LICENSE',
  'licenses/WASI-LIBC-LICENSE-APACHE',
  'licenses/WASI-LIBC-LICENSE-MIT',
  'licenses/YOWASP-RUNTIME-LICENSE.txt',
  'package.json',
]);

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..');
const TEMPLATE_DIRECTORY = join(SCRIPT_DIRECTORY, 'esp32-xtensa-wasm-package');
const COMPILER_LICENSE_DIRECTORY = join(
  REPOSITORY_ROOT,
  'packages',
  'web',
  'public',
  'esp32',
  'v2',
  'runtime',
  'licenses',
  'compiler',
);
const UPSTREAM_LICENSE_DIRECTORY = join(COMPILER_LICENSE_DIRECTORY, 'upstream');
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const PINNED_BUILD_DEPENDENCIES = Object.freeze({
  '@bytecodealliance/jco': '1.15.1',
  '@yowasp/runtime': '11.0.67',
  esbuild: '0.25.11',
});
const GENERATED_WASM_FILES = Object.freeze([
  'llvm.core.wasm',
  'llvm.core2.wasm',
  'llvm.core3.wasm',
  'llvm.core4.wasm',
]);

export function parseArguments(argv) {
  const options = {
    dryRun: false,
    help: false,
    keepWork: false,
  };
  const valueOptions = new Map([
    ['--llvm', 'llvm'],
    ['--wasi-prefix', 'wasiPrefix'],
    ['--resource-prefix', 'wasiPrefix'],
    ['--version', 'version'],
    ['--out', 'out'],
    ['--work-dir', 'workDirectory'],
    ['--llvm-license', 'llvmLicense'],
    ['--wasi-license-dir', 'wasiLicenseDirectory'],
    ['--wrapper-license', 'wrapperLicense'],
    ['--notices', 'notices'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (argument === '--keep-work') {
      options.keepWork = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const property = valueOptions.get(argument);
    if (!property) throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    options[property] = value;
    index += 1;
  }
  return options;
}

export function createPackagePlan(options, cwd = process.cwd()) {
  if (!options.llvm) throw new Error('--llvm is required');
  if (!options.wasiPrefix) throw new Error('--wasi-prefix is required');
  if (!options.version) throw new Error('--version is required; do not derive it from llvmorg tags');
  if (!VERSION_PATTERN.test(options.version)) {
    throw new Error(`--version must be a valid SemVer value: ${options.version}`);
  }

  const llvm = resolve(cwd, options.llvm);
  const wasiPrefix = resolve(cwd, options.wasiPrefix);
  const inferredProjectLicense = join(dirname(dirname(dirname(llvm))), 'llvm-project', 'LICENSE.TXT');
  const llvmLicense = options.llvmLicense
    ? resolve(cwd, options.llvmLicense)
    : existsSync(inferredProjectLicense)
      ? inferredProjectLicense
      : join(UPSTREAM_LICENSE_DIRECTORY, 'LLVM-LICENSE.TXT');
  const wasiLicenseDirectory = resolve(
    cwd,
    options.wasiLicenseDirectory ?? UPSTREAM_LICENSE_DIRECTORY,
  );

  return Object.freeze({
    schema: 1,
    package: Object.freeze({ name: PACKAGE_NAME, version: options.version }),
    inputs: Object.freeze({
      llvm,
      wasiPrefix,
      resourceRoot: join(wasiPrefix, 'usr'),
      licenses: Object.freeze({
        wrapper: resolve(
          cwd,
          options.wrapperLicense
            ?? join(COMPILER_LICENSE_DIRECTORY, 'YoWASP-Clang-LICENSE.txt'),
        ),
        llvm: llvmLicense,
        wasiDirectory: wasiLicenseDirectory,
        notices: resolve(cwd, options.notices ?? join(TEMPLATE_DIRECTORY, 'THIRD_PARTY_NOTICES.md')),
        runtime: 'copied from pinned @yowasp/runtime after npm ci',
      }),
    }),
    outputDirectory: resolve(
      cwd,
      options.out ?? join('var', 'work', 'esp32-xtensa-wasm-artifact'),
    ),
    workDirectory: options.workDirectory ? resolve(cwd, options.workDirectory) : null,
    keepWork: options.keepWork,
    steps: Object.freeze([
      Object.freeze({ tool: 'npm', arguments: ['ci', '--no-audit', '--no-fund'] }),
      Object.freeze({ tool: 'jco', arguments: ['new', llvm, '--wasi-command', '--output', 'llvm.wasm'] }),
      Object.freeze({
        tool: 'jco',
        arguments: [
          'transpile',
          'llvm.wasm',
          '--instantiation',
          'async',
          '--no-typescript',
          '--no-namespaced-exports',
          '--map',
          'wasi:io/*=runtime#io',
          '--map',
          'wasi:cli/*=runtime#cli',
          '--map',
          'wasi:clocks/*=runtime#*',
          '--map',
          'wasi:filesystem/*=runtime#fs',
          '--map',
          'wasi:random/*=runtime#random',
          '--out-dir',
          'gen',
        ],
      }),
      Object.freeze({
        tool: 'yowasp-pack-resources',
        arguments: ['gen/llvm-resources.js', 'gen', join(wasiPrefix, 'usr'), 'usr'],
      }),
      Object.freeze({
        tool: 'esbuild',
        arguments: [
          '--bundle',
          'lib/api.js',
          '--outfile=gen/bundle.js',
          '--format=esm',
          '--platform=node',
          `--define:VERSION=${JSON.stringify(options.version)}`,
        ],
      }),
      Object.freeze({ tool: 'npm', arguments: ['pack', '--json'] }),
    ]),
    includedFiles: EXPECTED_PACKAGE_FILES,
  });
}

export function validatePackagePlan(plan) {
  requireRegularFile(plan.inputs.llvm, 'WASI llvm-driver output');
  const header = Buffer.alloc(WASM_HEADER.byteLength);
  const descriptor = openSync(plan.inputs.llvm, 'r');
  let bytesRead;
  try {
    bytesRead = readSync(descriptor, header, 0, header.byteLength, 0);
  } finally {
    closeSync(descriptor);
  }
  if (bytesRead !== header.byteLength || !header.equals(WASM_HEADER)) {
    throw new Error(`WASI llvm-driver output is not a WebAssembly v1 module: ${plan.inputs.llvm}`);
  }
  requireDirectory(plan.inputs.wasiPrefix, 'WASI resource prefix');
  requireDirectory(plan.inputs.resourceRoot, 'WASI resource prefix usr directory');
  if (readdirSync(plan.inputs.resourceRoot).length === 0) {
    throw new Error(`WASI resource prefix usr directory is empty: ${plan.inputs.resourceRoot}`);
  }

  requireRegularFile(plan.inputs.licenses.wrapper, 'package wrapper license');
  requireRegularFile(plan.inputs.licenses.llvm, 'LLVM license');
  requireRegularFile(plan.inputs.licenses.notices, 'third-party notices');
  for (const name of [
    'WASI-LIBC-LICENSE',
    'WASI-LIBC-LICENSE-APACHE',
    'WASI-LIBC-LICENSE-MIT',
  ]) {
    requireRegularFile(join(plan.inputs.licenses.wasiDirectory, name), `wasi-libc license ${name}`);
  }
  validateTemplateContract();
  return plan;
}

export function validateTemplateContract() {
  for (const relativePath of [
    'package.json',
    'package-lock.json',
    'artifact-package.json',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    join('lib', 'api.js'),
    join('lib', 'api.d.ts'),
    join('lib', 'clang-driver-output.js'),
  ]) requireRegularFile(join(TEMPLATE_DIRECTORY, relativePath), `package template ${relativePath}`);

  const builder = readJson(join(TEMPLATE_DIRECTORY, 'package.json'), 'builder package manifest');
  if (builder.private !== true || builder.name !== '@arduinofast/esp32-xtensa-wasm-packager') {
    throw new Error('Xtensa package builder manifest has an unexpected identity');
  }
  if (JSON.stringify(builder.devDependencies) !== JSON.stringify(PINNED_BUILD_DEPENDENCIES)) {
    throw new Error('Xtensa package builder dependencies are not exactly pinned');
  }
  const lock = readJson(join(TEMPLATE_DIRECTORY, 'package-lock.json'), 'builder dependency lock');
  if (
    lock.lockfileVersion !== 3
    || JSON.stringify(lock.packages?.['']?.devDependencies) !== JSON.stringify(PINNED_BUILD_DEPENDENCIES)
  ) throw new Error('Xtensa package builder lock does not match its pinned dependencies');

  const artifact = readJson(join(TEMPLATE_DIRECTORY, 'artifact-package.json'), 'artifact package manifest');
  if (
    artifact.name !== PACKAGE_NAME
    || artifact.version !== '__VERSION__'
    || artifact.type !== 'module'
    || artifact.exports?.default !== './gen/bundle.js'
    || artifact.exports?.types !== './lib/api.d.ts'
  ) throw new Error('Xtensa artifact package template has an unexpected public contract');
  const expectedFiles = EXPECTED_PACKAGE_FILES.filter((path) => path !== 'package.json');
  if (JSON.stringify(artifact.files) !== JSON.stringify(expectedFiles)) {
    throw new Error('Xtensa artifact package files are not the audited whitelist');
  }

  const apiSource = readFileSync(join(TEMPLATE_DIRECTORY, 'lib', 'api.js'), 'utf8');
  const apiTypes = readFileSync(join(TEMPLATE_DIRECTORY, 'lib', 'api.d.ts'), 'utf8');
  if (!apiSource.includes('export { runLLVM, runClang };') || !apiTypes.includes('export const runClang: Command;')) {
    throw new Error('Xtensa package template does not preserve the runClang API');
  }
}

export function dryRun(argv, cwd = process.cwd()) {
  const options = parseArguments(argv);
  if (options.help) return null;
  return validatePackagePlan(createPackagePlan(options, cwd));
}

async function buildPackage(plan) {
  ensureOutputHasNoTarballs(plan.outputDirectory);
  const ownsWorkDirectory = plan.workDirectory === null;
  const workDirectory = ownsWorkDirectory
    ? mkdtempSync(join(tmpdir(), 'arduinofast-esp32-xtensa-package-'))
    : plan.workDirectory;
  if (!ownsWorkDirectory) ensureEmptyDirectory(workDirectory, 'work directory');
  const stage = join(workDirectory, 'npm-package');
  mkdirSync(join(stage, 'gen'), { recursive: true });
  mkdirSync(join(stage, 'lib'), { recursive: true });
  mkdirSync(join(stage, 'licenses'), { recursive: true });

  try {
    copyFileSync(join(TEMPLATE_DIRECTORY, 'package.json'), join(stage, 'package.json'));
    copyFileSync(join(TEMPLATE_DIRECTORY, 'package-lock.json'), join(stage, 'package-lock.json'));
    copyFileSync(join(TEMPLATE_DIRECTORY, 'README.md'), join(stage, 'README.md'));
    copyFileSync(join(TEMPLATE_DIRECTORY, 'lib', 'api.js'), join(stage, 'lib', 'api.js'));
    copyFileSync(join(TEMPLATE_DIRECTORY, 'lib', 'api.d.ts'), join(stage, 'lib', 'api.d.ts'));
    copyFileSync(
      join(TEMPLATE_DIRECTORY, 'lib', 'clang-driver-output.js'),
      join(stage, 'lib', 'clang-driver-output.js'),
    );
    copyFileSync(plan.inputs.licenses.wrapper, join(stage, 'LICENSE.txt'));
    copyFileSync(plan.inputs.licenses.llvm, join(stage, 'licenses', 'LLVM-LICENSE.TXT'));
    copyFileSync(plan.inputs.licenses.notices, join(stage, 'THIRD_PARTY_NOTICES.md'));
    for (const name of [
      'WASI-LIBC-LICENSE',
      'WASI-LIBC-LICENSE-APACHE',
      'WASI-LIBC-LICENSE-MIT',
    ]) copyFileSync(join(plan.inputs.licenses.wasiDirectory, name), join(stage, 'licenses', name));

    runCommand(npmExecutable(), ['ci', '--no-audit', '--no-fund'], stage);
    copyFileSync(
      join(stage, 'node_modules', '@yowasp', 'runtime', 'LICENSE.txt'),
      join(stage, 'licenses', 'YOWASP-RUNTIME-LICENSE.txt'),
    );

    runPackageBinary(stage, '@bytecodealliance/jco', 'jco', [
      'new',
      plan.inputs.llvm,
      '--wasi-command',
      '--output',
      'llvm.wasm',
    ]);
    runPackageBinary(stage, '@bytecodealliance/jco', 'jco', [
      'transpile',
      'llvm.wasm',
      '--instantiation',
      'async',
      '--no-typescript',
      '--no-namespaced-exports',
      '--map',
      'wasi:io/*=runtime#io',
      '--map',
      'wasi:cli/*=runtime#cli',
      '--map',
      'wasi:clocks/*=runtime#*',
      '--map',
      'wasi:filesystem/*=runtime#fs',
      '--map',
      'wasi:random/*=runtime#random',
      '--out-dir',
      'gen',
    ]);
    runPackageBinary(stage, '@yowasp/runtime', 'yowasp-pack-resources', [
      'gen/llvm-resources.js',
      'gen',
      plan.inputs.resourceRoot,
      'usr',
    ]);
    runPackageBinary(stage, 'esbuild', 'esbuild', [
      '--bundle',
      'lib/api.js',
      '--outfile=gen/bundle.js',
      '--format=esm',
      '--platform=node',
      `--define:VERSION=${JSON.stringify(plan.package.version)}`,
    ]);
    validateGeneratedFiles(stage);

    const artifactManifest = readJson(
      join(TEMPLATE_DIRECTORY, 'artifact-package.json'),
      'artifact package manifest',
    );
    artifactManifest.version = plan.package.version;
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(artifactManifest, null, 2)}\n`);
    mkdirSync(plan.outputDirectory, { recursive: true });
    const packed = runCommandCapture(npmExecutable(), [
      'pack',
      '--json',
      '--pack-destination',
      plan.outputDirectory,
    ], stage);
    const report = parsePackReport(packed);
    validatePackedFiles(report.files);
    const artifactPath = join(plan.outputDirectory, report.filename);
    requireRegularFile(artifactPath, 'packed Xtensa compiler artifact');
    return Object.freeze({
      package: `${plan.package.name}@${plan.package.version}`,
      artifact: artifactPath,
      size: report.size,
      integrity: report.integrity,
      workDirectory: plan.keepWork || !ownsWorkDirectory ? workDirectory : null,
    });
  } finally {
    if (ownsWorkDirectory && !plan.keepWork) rmSync(workDirectory, { recursive: true, force: true });
    else if (plan.keepWork) console.error(`kept package work directory: ${workDirectory}`);
  }
}

function validateGeneratedFiles(stage) {
  for (const relativePath of [
    join('gen', 'bundle.js'),
    join('gen', 'llvm-resources.tar'),
    ...GENERATED_WASM_FILES.map((name) => join('gen', name)),
  ]) requireNonemptyFile(join(stage, relativePath), `generated compiler resource ${relativePath}`);
  const wasmFiles = readdirSync(join(stage, 'gen'))
    .filter((name) => name.endsWith('.wasm'))
    .sort();
  if (JSON.stringify(wasmFiles) !== JSON.stringify([...GENERATED_WASM_FILES].sort())) {
    throw new Error(`jco emitted an unexpected WASM split: ${wasmFiles.join(', ')}`);
  }
  const bundle = readFileSync(join(stage, 'gen', 'bundle.js'), 'utf8');
  if (!bundle.includes('runClang')) throw new Error('generated compiler bundle does not contain runClang');
}

function parsePackReport(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(`npm pack did not return JSON: ${stdout.slice(0, 512)}`);
  }
  const report = Array.isArray(value) && value.length === 1 ? value[0] : null;
  if (
    !report
    || report.name !== PACKAGE_NAME
    || typeof report.filename !== 'string'
    || !Array.isArray(report.files)
  ) throw new Error('npm pack returned an unexpected artifact report');
  return report;
}

function validatePackedFiles(files) {
  const actual = files.map((file) => file.path).sort();
  const expected = [...EXPECTED_PACKAGE_FILES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const unexpected = actual.filter((path) => !expected.includes(path));
    const missing = expected.filter((path) => !actual.includes(path));
    throw new Error([
      'packed Xtensa compiler files differ from the audited whitelist',
      unexpected.length ? `unexpected: ${unexpected.join(', ')}` : '',
      missing.length ? `missing: ${missing.join(', ')}` : '',
    ].filter(Boolean).join('; '));
  }
}

function ensureOutputHasNoTarballs(directory) {
  if (!existsSync(directory)) return;
  requireDirectory(directory, 'artifact output directory');
  const tarballs = readdirSync(directory).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length) {
    throw new Error(`artifact output already contains tgz files: ${tarballs.join(', ')}`);
  }
}

function ensureEmptyDirectory(directory, label) {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
    return;
  }
  requireDirectory(directory, label);
  if (readdirSync(directory).length) throw new Error(`${label} must be empty: ${directory}`);
}

function requireDirectory(path, label) {
  if (!existsSync(path) || !lstatSync(path).isDirectory()) {
    throw new Error(`${label} is missing or is not a directory: ${path}`);
  }
}

function requireRegularFile(path, label) {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error(`${label} is missing or is not a regular file: ${path}`);
  }
}

function requireNonemptyFile(path, label) {
  requireRegularFile(path, label);
  if (lstatSync(path).size === 0) throw new Error(`${label} is empty: ${path}`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
}

function npmExecutable() {
  return 'npm';
}

function runPackageBinary(stage, packageName, binaryName, arguments_) {
  const packageRoot = join(stage, 'node_modules', ...packageName.split('/'));
  const manifest = readJson(
    join(packageRoot, 'package.json'),
    packageName + ' package manifest',
  );
  const relativeEntry = typeof manifest.bin === 'string'
    ? manifest.bin
    : manifest.bin?.[binaryName];
  if (typeof relativeEntry !== 'string') {
    throw new Error(packageName + ' does not provide the ' + binaryName + ' binary');
  }
  const entry = join(packageRoot, relativeEntry);
  requireRegularFile(entry, binaryName + ' JavaScript entry point');
  const native = isNativeExecutable(entry);
  runCommand(native ? entry : process.execPath, native ? arguments_ : [entry, ...arguments_], stage);
}

function isNativeExecutable(path) {
  const header = readFileSync(path).subarray(0, 4);
  return header.length >= 2 && (
    header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46
    || header[0] === 0x4d && header[1] === 0x5a
  );
}

function runCommand(executable, arguments_, cwd) {
  console.error(`$ ${basename(executable)} ${arguments_.map(shellDisplay).join(' ')}`);
  execFileSync(executable, arguments_, { cwd, stdio: 'inherit' });
}

function runCommandCapture(executable, arguments_, cwd) {
  console.error(`$ ${basename(executable)} ${arguments_.map(shellDisplay).join(' ')}`);
  return execFileSync(executable, arguments_, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function shellDisplay(value) {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function errorMessage(error) {
  return String(error?.message ?? error).trim().slice(0, 512);
}

function usage() {
  return `Usage:
  node scripts/package-esp32-xtensa-wasm.mjs \\
    --llvm <llvm-build/bin/llvm> \\
    --wasi-prefix <clang-resource-headers/wasi-prefix> \\
    --version <semver> \\
    [--out <artifact-directory>] [--dry-run]

The version is explicit because Espressif LLVM revisions are not required to
have llvmorg-* tags. The prefix must contain usr/. --resource-prefix is an
alias for --wasi-prefix. License inputs can be overridden with
--llvm-license, --wasi-license-dir, --wrapper-license, and --notices.
`;
}

export async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return null;
  }
  const plan = validatePackagePlan(createPackagePlan(options, cwd));
  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }
  const result = await buildPackage(plan);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`ERROR ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
