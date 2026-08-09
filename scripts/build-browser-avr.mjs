/** Build the immutable, independently versioned browser AVR v4 release. */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = process.cwd();
const sourceDir = resolve(root, 'packages', 'web', 'browser-avr');
const toolchainSourceDir = resolve(root, 'packages', 'web', 'browser-toolchain');
const publicDir = resolve(root, 'packages', 'web', 'public');
const runtimeRoot = resolve(publicDir, 'avr');
const releaseLayout = readReleaseLayout(join(toolchainSourceDir, 'release-layout.json'));
const runtimeVersion = releaseLayout.avr.version;
const esp32SharedRuntimeVersion = releaseLayout.esp32Shared.version;
const outputDir = resolve(runtimeRoot, runtimeVersion);
const esp32SharedOutputDir = resolve(runtimeRoot, esp32SharedRuntimeVersion);
const argumentsList = process.argv.slice(2);
const gatewayRelease = argumentsList.length === 1 && argumentsList[0] === '--gateway-release';
if (argumentsList.length && !gatewayRelease) {
  throw new Error(`unsupported Browser AVR build argument: ${argumentsList.join(' ')}`);
}
const releaseSpecs = Object.freeze({
  toolchain: Object.freeze({
    kind: 'toolchain',
    id: 'avr-gcc-atmega328p-wasm',
    version: '0.2.0-ck4',
    manifest: 'toolchain.json',
    artifactId: 'runtime-assets',
  }),
  platform: Object.freeze({
    kind: 'platform',
    id: 'arduino-avr-core',
    version: '1.8.6',
    manifest: 'platform.json',
    artifactId: 'core-assets',
  }),
  board: Object.freeze({
    kind: 'board',
    id: 'arduino-avr-uno-board',
    version: '1',
    manifest: 'board.json',
    artifactId: 'variant-assets',
  }),
});

if (dirname(runtimeRoot) !== publicDir
  || dirname(outputDir) !== runtimeRoot
  || dirname(esp32SharedOutputDir) !== runtimeRoot
  || outputDir === esp32SharedOutputDir
  || runtimeVersion !== 'v4'
  || esp32SharedRuntimeVersion !== 'v3') {
  throw new Error('refusing to clean unexpected Browser runtime paths');
}

const packageJsonPath = require.resolve('@horang-corp/avr-gcc-wasm/package.json');
const upstreamDir = dirname(packageJsonPath);
const upstreamPackage = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
if (upstreamPackage.version !== '0.2.0') {
  throw new Error(`browser AVR toolchain must remain pinned to 0.2.0, got ${upstreamPackage.version}`);
}

const upstreamManifest = JSON.parse(readFileSync(join(upstreamDir, 'assets', 'manifest.json'), 'utf8'));
const isDeviceHeader = (path) => /^\/sysroot\/avr\/include\/avr\/io[^/]*\.h$/.test(path);
const headerFiles = upstreamManifest.headerFiles.filter((path) => {
  if (path.startsWith('/libraries/') || path.startsWith('/arduino/libraries/')) return false;
  if (!isDeviceHeader(path)) return true;
  return path === '/sysroot/avr/include/avr/io.h' || path === '/sysroot/avr/include/avr/iom328p.h';
});
const objectFiles = [
  '/objects/core_abi.o',
  ...upstreamManifest.objectGroups.base.filter((path) => path.startsWith('/objects/core_')),
].filter((path, index, all) => all.indexOf(path) === index);
const libs = [...upstreamManifest.libs];

if (gatewayRelease) {
  rmSync(runtimeRoot, { recursive: true, force: true });
} else {
  rmSync(outputDir, { recursive: true, force: true });
}
mkdirSync(outputDir, { recursive: true });
mkdirSync(esp32SharedOutputDir, { recursive: true });

for (const file of releaseLayout.avr.sourceFiles) {
  cpSync(join(sourceDir, file), join(outputDir, file));
}
for (const file of releaseLayout.avr.toolchainFiles) {
  cpSync(join(toolchainSourceDir, file), join(outputDir, file));
}
cpSync(
  join(toolchainSourceDir, 'toolchain-pack.js'),
  join(esp32SharedOutputDir, 'toolchain-pack.js'),
);

const tools = releaseLayout.avr.toolFiles;
for (const file of tools) copyRelative(join(upstreamDir, 'tools'), join(outputDir, 'tools'), file);
cpSync(join(upstreamDir, 'THIRD_PARTY_NOTICES.md'), join(outputDir, 'THIRD_PARTY_NOTICES.md'));

const browserHeaders = [...new Set(headerFiles.map((path) => {
  for (const prefix of [
    '/sysroot/gcc/include/',
    '/sysroot/avr/include/',
    '/arduino/core/',
    '/arduino/variant/',
  ]) {
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return null;
}).filter(Boolean))].sort();

const headerSources = headerFiles.map((virtualPath) => ({
  path: `fs${virtualPath}`,
  root: join(upstreamDir, 'assets', 'fs'),
  relativePath: virtualPath.slice(1),
  virtualPath,
}));
const objectSources = objectFiles.map((virtualPath) => ({
  path: virtualPath.slice(1),
  root: join(upstreamDir, 'assets'),
  relativePath: virtualPath.slice(1),
  virtualPath,
}));
const librarySources = [...libs, '/ldscripts/avr5.xn'].map((virtualPath) => ({
  path: virtualPath.slice(1),
  root: join(upstreamDir, 'assets'),
  relativePath: virtualPath.slice(1),
  virtualPath,
}));
const sourceGroups = {
  toolchain: [
    ...headerSources.filter(({ virtualPath }) => virtualPath.startsWith('/sysroot/')),
    ...librarySources,
  ],
  platform: [
    ...headerSources.filter(({ virtualPath }) => virtualPath.startsWith('/arduino/core/')),
    ...objectSources,
  ],
  board: headerSources.filter(({ virtualPath }) => virtualPath.startsWith('/arduino/variant/')),
};
const groupedCount = Object.values(sourceGroups).reduce((total, entries) => total + entries.length, 0);
if (groupedCount !== headerSources.length + objectSources.length + librarySources.length) {
  throw new Error('AVR Pack split did not assign every runtime asset exactly once');
}

mkdirSync(join(outputDir, 'assets'), { recursive: true });
const assetPacks = {
  toolchain: writeAssetPack('avr-toolchain-assets', sourceGroups.toolchain),
  platform: writeAssetPack('avr-platform-assets', sourceGroups.platform),
  board: writeAssetPack('avr-board-assets', sourceGroups.board),
};

await build({
  entryPoints: [join(root, 'packages', 'core', 'src', 'preprocess', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  outfile: join(outputDir, 'preprocess.js'),
  legalComments: 'none',
});
cpSync(join(outputDir, 'preprocess.js'), join(esp32SharedOutputDir, 'preprocess.js'));

const checksums = [];
for (const file of tools.filter((name) => name.endsWith('.wasm'))) {
  const body = readFileSync(join(outputDir, 'tools', file));
  checksums.push(`${sha256(body)}  tools/${file}`);
}
writeFileSync(join(outputDir, 'WASM_SHA256SUMS'), `${checksums.join('\n')}\n`, 'utf8');

const toolchainArtifacts = [
  artifactDescriptor(releaseSpecs.toolchain.artifactId, 'asset-pack', `assets/${assetPacks.toolchain.file}`),
  artifactDescriptor('avr-as-wasm', 'wasm', 'tools/avr-as.wasm'),
  artifactDescriptor('avr-ld-wasm', 'wasm', 'tools/avr-ld.wasm'),
  artifactDescriptor('avr-objcopy-wasm', 'wasm', 'tools/avr-objcopy.wasm'),
  artifactDescriptor('cc1plus-wasm', 'wasm', 'tools/cc1plus.wasm'),
].sort((left, right) => left.id.localeCompare(right.id));
const platformArtifacts = [
  artifactDescriptor(releaseSpecs.platform.artifactId, 'asset-pack', `assets/${assetPacks.platform.file}`),
];
const boardArtifacts = [
  artifactDescriptor(releaseSpecs.board.artifactId, 'asset-pack', `assets/${assetPacks.board.file}`),
];
const publishedPacks = {
  toolchain: writePackManifest(releaseSpecs.toolchain, toolchainArtifacts),
  platform: writePackManifest(releaseSpecs.platform, platformArtifacts),
  board: writePackManifest(releaseSpecs.board, boardArtifacts),
};

const manifest = {
  schema: 3,
  target: 'atmega328p',
  board: 'arduino:avr:uno',
  upstream: {
    package: '@horang-corp/avr-gcc-wasm',
    version: upstreamPackage.version,
  },
  headerFiles,
  objectFiles,
  libs,
  browserHeaders,
  packs: Object.fromEntries(['toolchain', 'platform', 'board'].map((role) => [role, {
    kind: releaseSpecs[role].kind,
    id: publishedPacks[role].id,
    version: publishedPacks[role].version,
    revision: publishedPacks[role].revision,
    manifest: releaseSpecs[role].manifest,
    artifactId: releaseSpecs[role].artifactId,
    assetPack: assetPacks[role],
  }])),
};
writeFileSync(join(outputDir, 'assets', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

writeFileSync(
  join(outputDir, 'release.js'),
  '// Generated by scripts/build-browser-avr.mjs. Do not edit.\n'
    + releaseConstant('AVR_TOOLCHAIN_PACK', publishedPacks.toolchain)
    + releaseConstant('AVR_PLATFORM_PACK', publishedPacks.platform)
    + releaseConstant('AVR_BOARD_PACK', publishedPacks.board),
  'utf8',
);

if (gatewayRelease) assertGatewayRuntimeLayout();

const files = walkSize(outputDir);
console.log(`Browser AVR runtime: ${relative(root, outputDir)}`);
console.log(`  ${headerFiles.length} headers, ${objectFiles.length} core objects, ${files.count} files`);
for (const role of ['toolchain', 'platform', 'board']) {
  const descriptor = assetPacks[role];
  console.log(`  ${role}: ${descriptor.entries.length} assets, ${(descriptor.size / 1024 / 1024).toFixed(2)} MiB`);
}
console.log(`  ${(files.bytes / 1024 / 1024).toFixed(1)} MiB total`);
console.log(`ESP32 shared runtime: ${relative(root, esp32SharedOutputDir)} (${releaseLayout.esp32Shared.files.join(', ')})`);

function readReleaseLayout(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  assertExactKeys(value, ['schema', 'avr', 'esp32Shared'], 'Browser release layout');
  assertExactKeys(value.avr, ['version', 'sourceFiles', 'toolchainFiles', 'toolFiles'], 'AVR release layout');
  assertExactKeys(value.esp32Shared, ['version', 'files'], 'ESP32 shared release layout');
  if (value.schema !== 1 || value.avr.version !== 'v4' || value.esp32Shared.version !== 'v3') {
    throw new Error('unsupported Browser release layout');
  }
  for (const [label, files] of [
    ['AVR source', value.avr.sourceFiles],
    ['AVR toolchain', value.avr.toolchainFiles],
    ['AVR tool', value.avr.toolFiles],
    ['ESP32 shared', value.esp32Shared.files],
  ]) assertSafeFileList(files, label);
  if (JSON.stringify([...value.esp32Shared.files].sort())
    !== JSON.stringify(['preprocess.js', 'toolchain-pack.js'])) {
    throw new Error('ESP32 shared runtime must contain only preprocess.js and toolchain-pack.js');
  }
  if (!value.avr.toolchainFiles.includes('toolchain-pack.js')) {
    throw new Error('AVR runtime must publish the shared toolchain Pack loader');
  }
  return Object.freeze({
    schema: value.schema,
    avr: Object.freeze({
      version: value.avr.version,
      sourceFiles: Object.freeze([...value.avr.sourceFiles]),
      toolchainFiles: Object.freeze([...value.avr.toolchainFiles]),
      toolFiles: Object.freeze([...value.avr.toolFiles]),
    }),
    esp32Shared: Object.freeze({
      version: value.esp32Shared.version,
      files: Object.freeze([...value.esp32Shared.files]),
    }),
  });
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} is invalid`);
  }
}

function assertSafeFileList(value, label) {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length
    || value.some((file) => typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file))) {
    throw new Error(`${label} file allowlist is invalid`);
  }
}

function assertGatewayRuntimeLayout() {
  const versions = readdirSync(runtimeRoot, { withFileTypes: true });
  if (versions.some((entry) => !entry.isDirectory())
    || JSON.stringify(versions.map((entry) => entry.name).sort()) !== JSON.stringify(['v3', 'v4'])) {
    throw new Error('gateway Browser runtime must contain only v3 and v4 directories');
  }
  const sharedFiles = readdirSync(esp32SharedOutputDir, { withFileTypes: true });
  if (sharedFiles.some((entry) => !entry.isFile())
    || JSON.stringify(sharedFiles.map((entry) => entry.name).sort())
      !== JSON.stringify([...releaseLayout.esp32Shared.files].sort())) {
    throw new Error('gateway ESP32 shared runtime violates its file allowlist');
  }
  for (const file of [
    ...releaseLayout.avr.sourceFiles,
    ...releaseLayout.avr.toolchainFiles,
    'preprocess.js',
    'THIRD_PARTY_NOTICES.md',
    'WASM_SHA256SUMS',
    'toolchain.json',
    'platform.json',
    'board.json',
    'release.js',
  ]) {
    if (!existsSync(join(outputDir, file)) || !statSync(join(outputDir, file)).isFile()) {
      throw new Error(`gateway AVR v4 runtime is incomplete: ${file}`);
    }
  }
  for (const file of releaseLayout.avr.toolFiles) {
    if (!existsSync(join(outputDir, 'tools', file))) {
      throw new Error(`gateway AVR v4 tool is missing: ${file}`);
    }
  }
  if (!existsSync(join(outputDir, 'assets', 'manifest.json'))) {
    throw new Error('gateway AVR v4 asset manifest is missing');
  }
}

function writeAssetPack(prefix, sources) {
  const sorted = [...sources].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  if (!sorted.length) throw new Error(`${prefix} cannot be empty`);
  const chunks = [];
  const entries = [];
  let size = 0;
  for (const source of sorted) {
    if (entries.at(-1)?.path === source.path) throw new Error(`duplicate AVR Pack resource: ${source.path}`);
    const body = readRelative(source.root, source.relativePath);
    entries.push({ path: source.path, offset: size, length: body.byteLength });
    chunks.push(body);
    size += body.byteLength;
  }
  const body = Buffer.concat(chunks, size);
  const digest = sha256(body);
  const file = `${prefix}-${digest}.pack`;
  writeFileSync(join(outputDir, 'assets', file), body);
  return { file, size, sha256: digest, entries };
}

function writePackManifest(spec, artifacts) {
  const revision = sha256(JSON.stringify({
    schema: 1,
    id: spec.id,
    version: spec.version,
    artifacts,
  }));
  const manifestValue = {
    schema: 1,
    id: spec.id,
    version: spec.version,
    revision,
    artifacts,
  };
  writeFileSync(join(outputDir, spec.manifest), `${JSON.stringify(manifestValue, null, 2)}\n`, 'utf8');
  return manifestValue;
}

function releaseConstant(name, pack) {
  return `export const ${name} = Object.freeze(${JSON.stringify({
    id: pack.id,
    version: pack.version,
    revision: pack.revision,
  })});\n`;
}

function copyRelative(fromRoot, toRoot, relativePath) {
  const source = resolve(fromRoot, relativePath);
  const destination = resolve(toRoot, relativePath);
  if (!source.startsWith(`${resolve(fromRoot)}${sep}`)
    || !destination.startsWith(`${resolve(toRoot)}${sep}`)) {
    throw new Error(`invalid resource path: ${relativePath}`);
  }
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`resource does not exist: ${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}

function readRelative(fromRoot, relativePath) {
  const source = resolve(fromRoot, relativePath);
  if (!source.startsWith(`${resolve(fromRoot)}${sep}`)) throw new Error(`invalid resource path: ${relativePath}`);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`resource does not exist: ${source}`);
  return readFileSync(source);
}

function artifactDescriptor(id, kind, relativePath) {
  const body = readRelative(outputDir, relativePath);
  const digest = sha256(body);
  return {
    id,
    kind,
    size: body.byteLength,
    sha256: digest,
    chunks: [{ path: relativePath, size: body.byteLength, sha256: digest }],
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function walkSize(path) {
  const { readdirSync } = require('node:fs');
  let count = 0;
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      const nested = walkSize(child);
      count += nested.count;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      count++;
      bytes += statSync(child).size;
    }
  }
  return { count, bytes };
}
