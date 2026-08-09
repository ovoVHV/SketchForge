import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const crateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(process.argv[2] ?? path.join(crateRoot, 'dist', 'web'));
const jsPath = path.join(outputDir, 'ck_build_core.js');
const buildManifestPath = path.join(outputDir, 'build-manifest.json');
const platformManifestFixturePath = path.join(
  crateRoot,
  'tests',
  'fixtures',
  'platform-manifest-resolution-input.json',
);
const buildManifest = JSON.parse(await readFile(buildManifestPath, 'utf8'));

assert.equal(buildManifest.schemaVersion, 1, 'unsupported WASM build manifest schema');
assert.ok(Array.isArray(buildManifest.files), 'WASM build manifest files must be an array');

const publishedFiles = new Map();
for (const record of buildManifest.files) {
  assert.equal(typeof record?.path, 'string', 'WASM build manifest path must be a string');
  assert.ok(record.path.length > 0, 'WASM build manifest path must not be empty');
  assert.equal(record.path.includes('\\'), false, `WASM build manifest path must use /: ${record.path}`);
  assert.equal(publishedFiles.has(record.path), false, `duplicate WASM build manifest path: ${record.path}`);
  assert.ok(Number.isSafeInteger(record.bytes) && record.bytes >= 0,
    `invalid WASM build manifest byte count: ${record.path}`);
  assert.match(record.sha256, /^[a-f0-9]{64}$/,
    `invalid WASM build manifest SHA-256: ${record.path}`);

  const artifactPath = path.resolve(outputDir, record.path);
  const relativeArtifactPath = path.relative(outputDir, artifactPath);
  assert.ok(
    relativeArtifactPath.length > 0
      && relativeArtifactPath !== '..'
      && !relativeArtifactPath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativeArtifactPath),
    `unsafe WASM build manifest path: ${record.path}`,
  );
  const bytes = await readFile(artifactPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(bytes.byteLength, record.bytes, `WASM byte count mismatch: ${record.path}`);
  assert.equal(sha256, record.sha256, `WASM SHA-256 mismatch: ${record.path}`);
  publishedFiles.set(record.path, bytes);
}

for (const name of [
  'ck_build_core.d.ts',
  'ck_build_core.js',
  'ck_build_core_bg.wasm',
  'ck_build_core_bg.wasm.d.ts',
]) {
  assert.ok(publishedFiles.has(name), `missing WASM build manifest file ${name}`);
}

const wasmBytes = publishedFiles.get('ck_build_core_bg.wasm');
const bindings = await import(`${pathToFileURL(jsPath).href}?smoke=${Date.now()}`);

bindings.initSync({ module: wasmBytes });

for (const name of [
  'resolveProject',
  'resolveTarget',
  'resolvePlatform',
  'resolvePlatformManifest',
  'resolveLibraries',
  'createActionGraph',
  'createBuildIR',
  'planBuildActions',
  'planBuildIR',
  'calculateActionKeys',
  'mapDiagnostics',
  'migrateBuildIR',
  'validateBuildIR',
]) {
  assert.equal(typeof bindings[name], 'function', `missing WASM export ${name}`);
}

const platformManifestInput = JSON.parse(await readFile(platformManifestFixturePath, 'utf8'));
assert.equal(platformManifestInput.manifest.schemaVersion, 2);
assert.equal(
  platformManifestInput.manifest.sha256,
  '7454d87ed52269241177303df422447d1a23b6e5f438e235b8ca6ade065c9dd4',
);
assert.equal(
  platformManifestInput.manifest.recipeLowering.sha256,
  'e87b3e0dad526a331f7ce5808d060db5e7e8829f2c12f6cc1d1111199bfd4559',
);

const resolvedPlatformManifest = JSON.parse(
  bindings.resolvePlatformManifest(JSON.stringify(platformManifestInput)),
);
assert.equal(resolvedPlatformManifest.manifestSha256, platformManifestInput.manifest.sha256);
assert.equal(resolvedPlatformManifest.id, 'espressif-arduino');
assert.equal(resolvedPlatformManifest.version, '3.3.7');
assert.equal(resolvedPlatformManifest.vendor, 'esp32');
assert.equal(resolvedPlatformManifest.architecture, 'esp32');
assert.equal(resolvedPlatformManifest.board.id, 'esp32c3');
assert.equal(resolvedPlatformManifest.board.fqbn, 'esp32:esp32:esp32c3');
assert.equal(resolvedPlatformManifest.board.variant, 'esp32c3');
assert.deepEqual(resolvedPlatformManifest.options, { PartitionScheme: 'minimal' });
assert.equal(resolvedPlatformManifest.properties['build.partitions'], 'min_spiffs');
assert.deepEqual(resolvedPlatformManifest.resolvedRecipes.map((recipe) => recipe.id), [
  'recipe.cpp.o',
  'recipe.c.o',
  'recipe.S.o',
  'recipe.ar',
  'recipe.c.combine',
]);
assert.equal(
  resolvedPlatformManifest.recipeLowering.sha256,
  platformManifestInput.manifest.recipeLowering.sha256,
);
assert.deepEqual(resolvedPlatformManifest.recipeLowering.bindings, {
  archive: 'recipe.ar',
  compile: { asm: 'recipe.S.o', c: 'recipe.c.o', cxx: 'recipe.cpp.o' },
  link: 'recipe.c.combine',
});

const legacyPlatformManifestInput = JSON.parse(JSON.stringify(platformManifestInput));
legacyPlatformManifestInput.manifest.schemaVersion = 1;
delete legacyPlatformManifestInput.manifest.recipeLowering;
assert.throws(
  () => bindings.resolvePlatformManifest(JSON.stringify(legacyPlatformManifestInput)),
  /unsupported platform manifest schema 1/i,
);

const project = JSON.parse(bindings.resolveProject(JSON.stringify([
  { path: 'src\\pins.S', content: 'nop', generated: true },
  { path: './main.ino', content: 'void setup() {}' },
])));
assert.deepEqual(project.files.map((file) => file.path), ['main.ino', 'src/pins.S']);
assert.deepEqual(project.files.map((file) => file.language), ['ino', 'asm']);
assert.match(project.sha256, /^[a-f0-9]{64}$/);
assert.throws(() => bindings.resolveProject(JSON.stringify([
  { path: 'main.ino', content: 'void setup() {}' },
  { path: 'MAIN.ino', content: 'void loop() {}' },
])), /duplicate project file/i);

const graph = JSON.parse(bindings.createActionGraph('[]'));
assert.deepEqual(graph, { actions: [] });

const board = {
  kind: 'board', id: 'board:test', version: '1', sha256: 'b'.repeat(64),
  fqbn: 'esp32:esp32:test', variant: 'test',
};
const planned = JSON.parse(bindings.planBuildIR(JSON.stringify({
  project: [{ path: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
  target: { fqbn: board.fqbn, options: {}, boardPack: board },
  packs: {
    toolchain: {
      kind: 'toolchain', id: 'toolchain:test', version: '1', sha256: 'a'.repeat(64),
      abi: 'test-elf', instructionSet: 'test',
    },
    platform: {
      kind: 'platform', id: 'platform:test', version: '1', sha256: 'c'.repeat(64),
      platform: 'test',
    },
    board,
    libraries: { roots: [], packs: [] },
  },
})));
assert.deepEqual(planned.graph.actions.map((action) => action.kind), [
  'compile', 'link', 'transform', 'transform',
]);
assert.ok(planned.graph.actions.every((action) => /^[a-f0-9]{64}$/.test(action.cacheKey)));
assert.equal(planned.diagnosticMap.entries.length, 2);

const archivePlanned = JSON.parse(bindings.planBuildIR(JSON.stringify({
  project: [{ path: 'main.cpp', content: 'int main() { return 0; }\n' }],
  target: { fqbn: board.fqbn, options: {}, boardPack: board },
  packs: planned.packs,
  platform: {
    core: { files: [{ path: 'Core.cpp', content: 'void core() {}\n' }] },
  },
  archiveOperation: 'crs',
  archiveFlags: ['D'],
})));
const archiveAction = archivePlanned.graph.actions.find((action) => action.kind === 'archive');
assert.equal(archiveAction.arguments[0], 'crs');
assert.deepEqual(archiveAction.archive.flags, ['D']);

const complexTabs = JSON.parse(bindings.planBuildIR(JSON.stringify({
  project: [
    {
      path: 'main.ino',
      content: 'template <typename T>\nT ignored(T value) { return value; }\nvoid setup(\n)\n{\n}\n',
    },
    {
      path: 'Auxiliary.ino',
      content: 'int\nhelper(\n  int value\n)\n{\n  return value;\n}\nvoid loop() {}\n',
    },
    { path: '\ud83d\ude00.ino', content: 'int non_bmp_tab() { return 1; }\n' },
    { path: '\ue000.ino', content: 'int bmp_tab() { return 2; }\n' },
  ],
  target: { fqbn: board.fqbn, options: {}, boardPack: board },
  packs: planned.packs,
})));
const complexPreprocess = complexTabs.graph.actions.find((action) => action.tool === 'ck:preprocess');
assert.deepEqual(complexPreprocess.arguments.slice(0, 4), [
  'main.ino', 'Auxiliary.ino', '\ud83d\ude00.ino', '\ue000.ino',
]);
assert.deepEqual(complexTabs.diagnosticMap.entries.map((entry) => [
  entry.generatedLine, entry.sourceFile, entry.sourceLine,
]), [
  [1, 'main.ino', 3],
  [2, 'Auxiliary.ino', 1],
  [3, 'Auxiliary.ino', 8],
  [4, '\ud83d\ude00.ino', 1],
  [5, '\ue000.ino', 1],
]);

const legacy = {
  kind: 'ck-build-ir',
  schemaVersion: 0,
  project: planned.project.files.map((file) => ({
    name: file.path,
    content: file.content,
    language: file.language,
    generated: file.generated,
  })),
  target: { board: planned.target.fqbn, options: planned.target.options },
  packs: planned.packs,
  actions: planned.graph.actions.map((action) => ({ ...action, cacheKey: '0'.repeat(64) })),
  artifacts: planned.artifacts,
  diagnostics: planned.diagnosticMap.entries,
};
const migrated = JSON.parse(bindings.migrateBuildIR(JSON.stringify(legacy)));
assert.equal(migrated.schemaVersion, 1);
assert.equal(migrated.target.fqbn, planned.target.fqbn);
assert.equal(migrated.project.files[0].path, planned.project.files[0].path);
assert.ok(migrated.graph.actions.every((action) => action.cacheKey !== '0'.repeat(64)));

const mapped = JSON.parse(bindings.mapDiagnostics(JSON.stringify({
  diagnostics: [{ severity: 'error', file: 'generated.cpp', line: 4, column: 2, message: 'bad' }],
  map: { entries: [{ generatedFile: 'generated.cpp', generatedLine: 4, sourceFile: 'main.ino', sourceLine: 2 }] },
})));
assert.equal(mapped[0].sourceFile, 'main.ino');
assert.equal(mapped[0].sourceLine, 2);
assert.equal(mapped[0].fromGenerated, true);

const wasmRecord = buildManifest.files.find((record) => record.path === 'ck_build_core_bg.wasm');
console.log(`CK Build Core WASM smoke passed (${wasmBytes.length} bytes, SHA-256 ${wasmRecord.sha256})`);
