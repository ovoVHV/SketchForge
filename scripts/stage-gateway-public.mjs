#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dockerIgnore from '@balena/dockerignore';
import ts from 'typescript';

import {
  browserToolchainPackRevisionInput,
  validateBrowserToolchainPackManifest,
} from '../packages/web/public/avr/v4/toolchain-pack.js';
import { auditCkActiveRelease } from './audit-ck-active-release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_RELATIVE = 'packages/web/public';
const RELEASE_RELATIVE = 'esp32/v1/release.js';
const ALLOWLIST_RELATIVE = 'docker/gateway-static-allowlist.json';
const DOCKERIGNORE_RELATIVE = 'docker/Dockerfile.gateway.dockerignore';
const BASE_DOCKERIGNORE_RELATIVE = '.dockerignore';
const SHA256 = /^[a-f0-9]{64}$/;
const STATIC_ENTRY_FILES = Object.freeze([
  'index.html',
  'demo.html',
  'toolchain-origins.js',
  'avr-compiler-sw.js',
]);
const MODULE_ENTRY_FILES = Object.freeze(['app.js']);
const DYNAMIC_LOCAL_LOADERS = Object.freeze({
  'esp32/v1/c3-runtime.js': Object.freeze([
    Object.freeze({
      kind: 'worker-url',
      expression: 'workerPath',
      valuesFromProperty: 'workerPath',
    }),
  ]),
  'esp32/v2/c3-clang-runtime.js': Object.freeze([
    Object.freeze({
      kind: 'dynamic-import',
      expression: 'url',
      staticUrl: './clang/bundle.js',
    }),
  ]),
});
const PACK_BACKED_MODULE_URLS = Object.freeze({
  'avr/v4/tools/avr-as.mjs': Object.freeze(['as-new.wasm']),
  'avr/v4/tools/avr-ld.mjs': Object.freeze(['ld-new.wasm']),
  'avr/v4/tools/avr-objcopy.mjs': Object.freeze(['objcopy.wasm']),
  'esp32/v2/clang/bundle.js': Object.freeze([
    './llvm.core.wasm',
    './llvm.core2.wasm',
    './llvm.core3.wasm',
    './llvm.core4.wasm',
    './llvm-resources.tar',
  ]),
  'esp32/v5/xtensa/clang/bundle.js': Object.freeze([
    './llvm.core.wasm',
    './llvm.core2.wasm',
    './llvm.core3.wasm',
    './llvm.core4.wasm',
    './llvm-resources.tar',
  ]),
});

export async function createGatewayStaticManifest({ root = ROOT } = {}) {
  const workspace = resolve(root);
  const publicRoot = resolve(workspace, PUBLIC_RELATIVE);
  assertBoundaryDirectory(workspace, 'Gateway repository root');
  assertNoSymlink(workspace, publicRoot, 'Gateway public root');
  assertBoundaryDirectory(publicRoot, 'Gateway public root');
  const releasePath = publicFile(publicRoot, RELEASE_RELATIVE, 'release module');
  const releaseBytes = readRegularFile(releasePath, publicRoot, 'release module');
  const release = await loadRelease(releasePath);
  const audit = await auditCkActiveRelease({ root: workspace });
  if (audit.state !== 'closed') {
    throw new Error(`active ESP32 release is not closed: ${JSON.stringify(audit.issues)}`);
  }

  const sourceFiles = new Set([
    RELEASE_RELATIVE,
    ...STATIC_ENTRY_FILES,
  ]);
  const generatedAvrFiles = collectGeneratedAvrFiles(workspace, publicRoot);

  for (const file of collectGatewayModuleClosure({ publicRoot, entries: MODULE_ENTRY_FILES })) {
    if (file.startsWith('avr/')) {
      if (!generatedAvrFiles.has(file)) {
        throw new Error(`Browser module depends on an unapproved AVR output: ${file}`);
      }
    } else {
      sourceFiles.add(file);
    }
  }

  addReleasePin({
    files: sourceFiles,
    publicRoot,
    base: dirname(releasePath),
    pin: release.capabilities,
    label: 'capabilities',
  });
  addActiveRuntimeClosure(sourceFiles, publicRoot, audit);
  const libraryCounts = addLibraryClosure({
    files: sourceFiles,
    publicRoot,
    releasePath,
    pin: release.libraries,
  });
  const platformCounts = addPlatformClosure({
    files: sourceFiles,
    publicRoot,
    releasePath,
    pin: release.platforms,
  });

  for (const file of sourceFiles) readRegularFile(publicFile(publicRoot, file, 'allowlisted file'), publicRoot, file);
  for (const file of generatedAvrFiles) readRegularFile(publicFile(publicRoot, file, 'generated AVR file'), publicRoot, file);

  const sortedSource = [...sourceFiles].sort(compareText);
  const sortedGenerated = [...generatedAvrFiles].sort(compareText);
  return Object.freeze({
    schema: 1,
    policy: 'gateway-static-active-release-closure',
    release: Object.freeze({
      path: RELEASE_RELATIVE,
      sha256: sha256(releaseBytes),
      runtimes: audit.counts.runtimes,
      descriptors: audit.counts.descriptors,
      releaseReports: audit.counts.releaseReports,
      compilerPacks: audit.counts.compilerPacks,
      compilerArtifacts: audit.counts.compilerArtifacts,
      compilerChunks: audit.counts.compilerChunks,
      compilerDownloadBytes: audit.counts.compilerDownloadBytes,
      libraries: libraryCounts.libraries,
      libraryVersions: libraryCounts.versions,
      platformEntries: platformCounts.entries,
    }),
    counts: Object.freeze({
      sourceFiles: sortedSource.length,
      generatedAvrFiles: sortedGenerated.length,
      totalFiles: sortedSource.length + sortedGenerated.length,
    }),
    sourceFiles: Object.freeze(sortedSource),
    generatedAvrFiles: Object.freeze(sortedGenerated),
  });
}

export function createGatewayDockerignore({ root = ROOT, manifest, baseDockerignore } = {}) {
  assertGatewayManifest(manifest);
  const workspace = resolve(root);
  assertBoundaryDirectory(workspace, 'Gateway repository root');
  const base = normalizeNewlines(baseDockerignore ?? readFileSync(
    resolve(workspace, BASE_DOCKERIGNORE_RELATIVE),
    'utf8',
  )).trimEnd();
  const tree = { directories: new Map(), files: new Set() };
  for (const file of manifest.sourceFiles) {
    const segments = file.split('/');
    let node = tree;
    for (const segment of segments.slice(0, -1)) {
      if (!node.directories.has(segment)) {
        node.directories.set(segment, { directories: new Map(), files: new Set() });
      }
      node = node.directories.get(segment);
    }
    node.files.add(segments.at(-1));
  }
  const allowRules = renderDockerignoreTree(tree, PUBLIC_RELATIVE);

  return `${base}\n\n${[
    '# Generated by scripts/stage-gateway-public.mjs --write. Do not edit.',
    '# The Gateway receives only the source side of the audited static release;',
    '# Browser AVR is rebuilt inside the builder and is intentionally absent here.',
    `${PUBLIC_RELATIVE}/**`,
    ...allowRules,
  ].join('\n')}\n`;
}

function renderDockerignoreTree(node, prefix) {
  const rules = [`!${prefix}/`, `${prefix}/*`];
  for (const file of [...node.files].sort(compareText)) rules.push(`!${prefix}/${file}`);
  for (const [directory, child] of [...node.directories.entries()].sort(([left], [right]) => compareText(left, right))) {
    rules.push(...renderDockerignoreTree(child, `${prefix}/${directory}`));
  }
  return rules;
}

export function stageGatewayStaticFiles({ publicRoot, outputRoot, files }) {
  const source = resolve(publicRoot);
  const output = resolve(outputRoot);
  assertBoundaryDirectory(source, 'Gateway public root');
  assertNoSymlinkAncestors(output, 'Gateway static staging root');
  if (existsSync(output)) assertBoundaryDirectory(output, 'Gateway static staging root');
  const sourceToOutput = relative(source, output);
  const outputToSource = relative(output, source);
  const isOutsideSource = sourceToOutput === '..' || sourceToOutput.startsWith(`..${sep}`);
  const sourceIsOutsideOutput = outputToSource === '..' || outputToSource.startsWith(`..${sep}`);
  if (!sourceToOutput || !isOutsideSource || !sourceIsOutsideOutput) {
    throw new Error('Gateway static staging output must stay outside the source public tree');
  }
  if (output === dirname(output)) throw new Error('refusing to replace a filesystem root');
  const normalized = normalizeFileList(files, 'staging files');

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  assertBoundaryDirectory(output, 'Gateway static staging root');
  for (const file of normalized) {
    const sourcePath = publicFile(source, file, 'staging source');
    readRegularFile(sourcePath, source, `staging source ${file}`);
    const destination = publicFile(output, file, 'staging destination');
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(sourcePath, destination);
  }
  return Object.freeze({ files: normalized.length, output });
}

export async function stageGatewayPublic({ root = ROOT, output } = {}) {
  if (!output) throw new Error('Gateway static staging requires an output directory');
  const workspace = resolve(root);
  const expected = await createGatewayStaticManifest({ root: workspace });
  const checked = readCheckedManifest(workspace);
  assertGeneratedState(workspace, expected, checked);
  return stageGatewayStaticFiles({
    publicRoot: resolve(workspace, PUBLIC_RELATIVE),
    outputRoot: resolve(workspace, output),
    files: [...expected.sourceFiles, ...expected.generatedAvrFiles].sort(compareText),
  });
}

function addActiveRuntimeClosure(files, publicRoot, audit) {
  for (const target of audit.targets) {
    files.add(normalizePublicPath(target.descriptor, 'runtime descriptor'));
    for (const pack of Object.values(target.packs)) {
      addPackClosure({
        files,
        publicRoot,
        manifestRelative: pack.manifest,
        expected: pack,
        label: `${pack.id} Pack`,
      });
    }
  }
  for (const report of audit.releaseReports) {
    files.add(normalizePublicPath(report.path, 'release report'));
  }
}

function addLibraryClosure({ files, publicRoot, releasePath, pin }) {
  const registryPath = addReleasePin({
    files,
    publicRoot,
    base: dirname(releasePath),
    pin,
    label: 'library Registry',
  });
  const registry = parseJson(readRegularFile(registryPath, publicRoot, 'library Registry'), 'library Registry');
  if (registry?.schema !== 2 || !Array.isArray(registry.libraries)) {
    throw new Error('library Registry must use schema 2');
  }
  let versions = 0;
  for (const library of registry.libraries) {
    if (!library || typeof library !== 'object' || !Array.isArray(library.versions)) {
      throw new Error('library Registry entry is invalid');
    }
    for (const version of library.versions) {
      const pack = version?.pack;
      if (!pack || typeof pack !== 'object' || typeof pack.artifact !== 'string' || !pack.artifact) {
        throw new Error('library Registry Pack pin is invalid');
      }
      const manifestPath = resolveRelative(dirname(registryPath), pack.manifest, publicRoot, 'library Pack');
      const manifestRelative = slash(relative(publicRoot, manifestPath));
      const manifest = addPackClosure({
        files,
        publicRoot,
        manifestRelative,
        expected: pack,
        artifactIds: new Set([pack.artifact]),
        label: `${library.name ?? 'library'} Pack`,
      });
      if (!manifest.artifacts.some((artifact) => artifact.id === pack.artifact)) {
        throw new Error(`library Pack omits selected artifact ${pack.artifact}`);
      }
      versions += 1;
    }
  }
  const notices = slash(relative(publicRoot, resolve(dirname(registryPath), 'THIRD_PARTY_NOTICES.md')));
  if (existsSync(publicFile(publicRoot, notices, 'library notices'))) files.add(notices);
  return Object.freeze({ libraries: registry.libraries.length, versions });
}

function addPlatformClosure({ files, publicRoot, releasePath, pin }) {
  const registryPath = addReleasePin({
    files,
    publicRoot,
    base: dirname(releasePath),
    pin,
    label: 'Platform Registry',
  });
  const registry = parseJson(readRegularFile(registryPath, publicRoot, 'Platform Registry'), 'Platform Registry');
  if (registry?.schemaVersion !== 1 || registry.kind !== 'ck-platform-manifest-registry'
    || !Array.isArray(registry.entries) || !registry.entries.length) {
    throw new Error('Platform Registry is invalid');
  }
  for (const entry of registry.entries) {
    if (!entry || typeof entry !== 'object' || !SHA256.test(entry.sha256 ?? '')) {
      throw new Error('Platform Registry entry is invalid');
    }
    const path = resolveRelative(dirname(registryPath), entry.path, publicRoot, 'Platform Manifest');
    const bytes = readRegularFile(path, publicRoot, 'Platform Manifest');
    const manifest = parseJson(bytes, 'Platform Manifest');
    const { sha256: declaredSha256, ...body } = manifest ?? {};
    if (declaredSha256 !== entry.sha256
      || sha256(Buffer.from(canonicalJson(body), 'utf8')) !== entry.sha256) {
      throw new Error('Platform Manifest identity does not match its Registry');
    }
    files.add(slash(relative(publicRoot, path)));
  }
  return Object.freeze({ entries: registry.entries.length });
}

function addReleasePin({ files, publicRoot, base, pin, label }) {
  if (!pin || typeof pin !== 'object' || !SHA256.test(pin.sha256 ?? '')) {
    throw new Error(`${label} release pin is invalid`);
  }
  const path = resolveRelative(base, pin.path, publicRoot, label);
  const bytes = readRegularFile(path, publicRoot, label);
  if (sha256(bytes) !== pin.sha256) throw new Error(`${label} SHA-256 does not match release.js`);
  files.add(slash(relative(publicRoot, path)));
  return path;
}

function addPackClosure({ files, publicRoot, manifestRelative, expected, artifactIds, label }) {
  const normalizedManifest = normalizePublicPath(manifestRelative, `${label} manifest`);
  const manifestPath = publicFile(publicRoot, normalizedManifest, `${label} manifest`);
  const source = parseJson(readRegularFile(manifestPath, publicRoot, `${label} manifest`), `${label} manifest`);
  const manifest = validateBrowserToolchainPackManifest(source);
  if (manifest.id !== expected.id || manifest.revision !== expected.revision) {
    throw new Error(`${label} identity does not match its release pin`);
  }
  const revision = sha256(Buffer.from(browserToolchainPackRevisionInput(source), 'utf8'));
  if (revision !== manifest.revision) throw new Error(`${label} revision is not content-addressed`);
  files.add(normalizedManifest);
  for (const artifact of manifest.artifacts) {
    if (artifactIds && !artifactIds.has(artifact.id)) continue;
    for (const chunk of artifact.chunks) {
      const chunkPath = resolveRelative(dirname(manifestPath), chunk.path, dirname(manifestPath), `${label} chunk`);
      const bytes = readRegularFile(chunkPath, dirname(manifestPath), `${label} chunk`);
      const expectedBytes = chunk.compressedSize ?? chunk.size;
      const expectedSha256 = chunk.compressedSha256 ?? chunk.sha256;
      if (bytes.byteLength !== expectedBytes || sha256(bytes) !== expectedSha256) {
        throw new Error(`${label} transport chunk integrity mismatch: ${chunk.path}`);
      }
      files.add(slash(relative(publicRoot, chunkPath)));
    }
  }
  return manifest;
}

function collectGeneratedAvrFiles(workspace, publicRoot) {
  const layout = parseJson(
    readRegularFile(resolve(workspace, 'packages/web/browser-toolchain/release-layout.json'), workspace, 'Browser release layout'),
    'Browser release layout',
  );
  if (layout?.schema !== 1 || layout.avr?.version !== 'v4' || layout.esp32Shared?.version !== 'v3'
    || !Array.isArray(layout.avr.sourceFiles) || !Array.isArray(layout.avr.toolchainFiles)
    || !Array.isArray(layout.avr.toolFiles) || !Array.isArray(layout.esp32Shared.files)) {
    throw new Error('Browser release layout is invalid');
  }
  const root = `avr/${layout.avr.version}`;
  const files = new Set([
    ...layout.avr.sourceFiles.map((file) => `${root}/${safeLeaf(file, 'AVR source file')}`),
    ...layout.avr.toolchainFiles.map((file) => `${root}/${safeLeaf(file, 'AVR toolchain file')}`),
    ...layout.avr.toolFiles.map((file) => `${root}/tools/${safeLeaf(file, 'AVR tool file')}`),
    `${root}/preprocess.js`,
    `${root}/THIRD_PARTY_NOTICES.md`,
    `${root}/WASM_SHA256SUMS`,
    `${root}/toolchain.json`,
    `${root}/platform.json`,
    `${root}/board.json`,
    `${root}/release.js`,
    `${root}/assets/manifest.json`,
    ...layout.esp32Shared.files.map((file) => (
      `avr/${layout.esp32Shared.version}/${safeLeaf(file, 'ESP32 shared AVR file')}`
    )),
  ]);
  const assetsPath = publicFile(publicRoot, `${root}/assets/manifest.json`, 'AVR asset manifest');
  const assets = parseJson(readRegularFile(assetsPath, publicRoot, 'AVR asset manifest'), 'AVR asset manifest');
  if (assets?.schema !== 3 || !assets.packs || typeof assets.packs !== 'object') {
    throw new Error('AVR asset manifest is invalid');
  }
  for (const value of Object.values(assets.packs)) {
    files.add(`${root}/assets/${safeLeaf(value?.assetPack?.file, 'AVR asset Pack')}`);
  }
  return files;
}

export function collectGatewayModuleClosure({
  publicRoot,
  entries,
  dynamicLocalLoaders = DYNAMIC_LOCAL_LOADERS,
  packBackedModuleUrls = PACK_BACKED_MODULE_URLS,
}) {
  const root = resolve(publicRoot);
  assertBoundaryDirectory(root, 'Gateway public root');
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error('Gateway Browser module entries must be a non-empty array');
  }
  assertDynamicLoaderPolicy(dynamicLocalLoaders);
  assertPackBackedUrlPolicy(packBackedModuleUrls);
  const files = new Set();
  const pending = [...entries];
  const parsedModules = new Set();
  while (pending.length) {
    const current = normalizePublicPath(pending.pop(), 'Browser module');
    if (parsedModules.has(current)) continue;
    const path = publicFile(root, current, 'Browser module');
    const source = readRegularFile(path, root, `Browser module ${current}`).toString('utf8');
    files.add(current);
    parsedModules.add(current);
    const references = browserModuleReferences({
      current,
      source,
      declarations: dynamicLocalLoaders[current] ?? [],
      packBackedUrls: packBackedModuleUrls[current] ?? [],
    });
    for (const specifier of references.assets) {
      const dependency = resolveBrowserReference(current, specifier, 'Browser static URL');
      if (dependency !== null) files.add(dependency);
    }
    for (const specifier of references.modules) {
      const dependency = resolveBrowserReference(current, specifier, 'Browser module dependency');
      if (dependency === null) continue;
      if (!parsedModules.has(dependency)) pending.push(dependency);
    }
  }
  for (const declaredModule of Object.keys(dynamicLocalLoaders)) {
    if (!parsedModules.has(declaredModule)) {
      throw new Error(`Dynamic local loader declaration is outside the Browser module closure: ${declaredModule}`);
    }
  }
  for (const declaredModule of Object.keys(packBackedModuleUrls)) {
    if (!parsedModules.has(declaredModule)) {
      throw new Error(`Pack-backed module URL declaration is outside the Browser module closure: ${declaredModule}`);
    }
  }
  return files;
}

function browserModuleReferences({ current, source, declarations, packBackedUrls }) {
  const sourceFile = ts.createSourceFile(
    current,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const parseErrors = sourceFile.parseDiagnostics ?? [];
  if (parseErrors.length) {
    const diagnostic = parseErrors[0];
    const location = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    throw new Error(
      `Browser module ${current} has invalid JavaScript at ${location.line + 1}:${location.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    );
  }

  const modules = new Set();
  const staticUrls = new Set();
  const dynamicSites = [];
  const propertyValues = new Map();

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      modules.add(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      modules.add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      const literal = staticString(argument);
      if (literal === null) {
        dynamicSites.push({
          kind: 'dynamic-import',
          expression: argument?.getText(sourceFile) ?? '<missing>',
        });
      } else {
        modules.add(literal);
      }
    }

    const moduleUrl = moduleRelativeUrl(node, sourceFile);
    if (moduleUrl && moduleUrl.specifier !== null && !moduleUrl.specifier.endsWith('/')) {
      staticUrls.add(moduleUrl.specifier);
      if (/\.m?js$/iu.test(moduleUrl.specifier)) modules.add(moduleUrl.specifier);
    }

    if (isWorkerConstruction(node)) {
      const workerArgument = node.arguments?.[0];
      const workerUrl = moduleRelativeUrl(workerArgument, sourceFile);
      const directWorkerUrl = staticString(workerArgument);
      if (workerUrl && workerUrl.specifier !== null) {
        if (!isLocalBrowserReference(workerUrl.specifier)) {
          throw new Error(`Browser module ${current} has a non-local Worker URL: ${workerUrl.specifier}`);
        }
        modules.add(workerUrl.specifier);
      } else if (directWorkerUrl !== null) {
        if (!isLocalBrowserReference(directWorkerUrl)) {
          throw new Error(`Browser module ${current} has a non-local Worker URL: ${directWorkerUrl}`);
        }
        modules.add(directWorkerUrl);
      } else {
        dynamicSites.push({
          kind: 'worker-url',
          expression: workerUrl?.expression ?? workerArgument?.getText(sourceFile) ?? '<missing>',
        });
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name !== null) {
        const values = propertyValues.get(name) ?? [];
        values.push({ literal: staticString(node.initializer), expression: node.initializer.getText(sourceFile) });
        propertyValues.set(name, values);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const matchedDeclarations = new Set();
  for (const site of dynamicSites) {
    const matches = declarations.filter((declaration) => (
      declaration.kind === site.kind && declaration.expression === site.expression
    ));
    if (matches.length !== 1) {
      throw new Error(
        `Browser module ${current} has an undeclared or ambiguous ${site.kind}: ${site.expression}`,
      );
    }
    const declaration = matches[0];
    matchedDeclarations.add(declaration);
    if (declaration.valuesFromProperty !== undefined) {
      const values = propertyValues.get(declaration.valuesFromProperty) ?? [];
      if (!values.length) {
        throw new Error(
          `Browser module ${current} dynamic ${site.kind} declaration has no ${declaration.valuesFromProperty} values`,
        );
      }
      for (const value of values) {
        if (value.literal === null) {
          throw new Error(
            `Browser module ${current} has a non-static ${declaration.valuesFromProperty} value: ${value.expression}`,
          );
        }
        if (!isLocalBrowserReference(value.literal)) {
          throw new Error(
            `Browser module ${current} has a non-local ${declaration.valuesFromProperty} value: ${value.literal}`,
          );
        }
        modules.add(value.literal);
      }
    }
    if (declaration.staticUrl !== undefined && !staticUrls.has(declaration.staticUrl)) {
      throw new Error(
        `Browser module ${current} dynamic ${site.kind} declaration has no matching static URL: ${declaration.staticUrl}`,
      );
    }
    if (declaration.staticUrl !== undefined) modules.add(declaration.staticUrl);
  }
  for (const declaration of declarations) {
    if (!matchedDeclarations.has(declaration)) {
      throw new Error(
        `Browser module ${current} has a stale dynamic ${declaration.kind} declaration: ${declaration.expression}`,
      );
    }
  }
  for (const value of packBackedUrls) {
    if (!staticUrls.delete(value)) {
      throw new Error(`Browser module ${current} has a stale Pack-backed URL declaration: ${value}`);
    }
  }
  const assets = staticUrls;
  return Object.freeze({ modules, assets });
}

function assertDynamicLoaderPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gateway dynamic local loader policy is invalid');
  }
  for (const [module, declarations] of Object.entries(value)) {
    normalizePublicPath(module, 'dynamic local loader module');
    if (!Array.isArray(declarations) || !declarations.length) {
      throw new Error(`Dynamic local loader declarations are invalid: ${module}`);
    }
    const identities = new Set();
    for (const declaration of declarations) {
      if (!declaration || typeof declaration !== 'object'
        || !['dynamic-import', 'worker-url'].includes(declaration.kind)
        || typeof declaration.expression !== 'string' || !declaration.expression.trim()
        || (declaration.valuesFromProperty !== undefined
          && (typeof declaration.valuesFromProperty !== 'string' || !declaration.valuesFromProperty))
        || (declaration.staticUrl !== undefined
          && (typeof declaration.staticUrl !== 'string' || !isLocalBrowserReference(declaration.staticUrl)))
        || (declaration.kind === 'dynamic-import' && declaration.staticUrl === undefined)
        || (declaration.kind === 'worker-url' && declaration.valuesFromProperty === undefined)) {
        throw new Error(`Dynamic local loader declaration is invalid: ${module}`);
      }
      const identity = `${declaration.kind}\0${declaration.expression}`;
      if (identities.has(identity)) throw new Error(`Dynamic local loader declaration is duplicated: ${module}`);
      identities.add(identity);
    }
  }
}

function assertPackBackedUrlPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gateway Pack-backed module URL policy is invalid');
  }
  for (const [module, specifiers] of Object.entries(value)) {
    normalizePublicPath(module, 'Pack-backed module URL module');
    if (!Array.isArray(specifiers) || !specifiers.length || new Set(specifiers).size !== specifiers.length
      || specifiers.some((specifier) => !isLocalBrowserReference(specifier))) {
      throw new Error(`Pack-backed module URL declarations are invalid: ${module}`);
    }
  }
}

function staticString(node) {
  return node && (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function moduleRelativeUrl(node, sourceFile) {
  if (!node || !ts.isNewExpression(node) || !ts.isIdentifier(node.expression)
    || node.expression.text !== 'URL' || node.arguments?.length !== 2
    || !isImportMetaUrl(node.arguments[1])) return null;
  return Object.freeze({
    expression: node.arguments[0].getText(sourceFile),
    specifier: staticString(node.arguments[0]),
  });
}

function isImportMetaUrl(node) {
  return ts.isPropertyAccessExpression(node)
    && node.name.text === 'url'
    && ts.isMetaProperty(node.expression)
    && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && node.expression.name.text === 'meta';
}

function isWorkerConstruction(node) {
  if (!ts.isNewExpression(node)) return false;
  const name = ts.isIdentifier(node.expression)
    ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : '';
  return /Worker(?:Class)?$/u.test(name);
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

function resolveBrowserReference(importer, specifier, label) {
  if (typeof specifier !== 'string' || !specifier || specifier.includes('\\')
    || specifier.includes('\0') || specifier.includes('#')) {
    throw new Error(`${label} from ${importer} is invalid: ${String(specifier)}`);
  }
  let reference = specifier;
  const queryIndex = reference.indexOf('?');
  if (queryIndex >= 0) {
    const query = reference.slice(queryIndex + 1);
    if (label !== 'Browser module dependency'
      || !query
      || reference.indexOf('?', queryIndex + 1) >= 0
      || !/^[A-Za-z0-9._~-]+=[A-Za-z0-9._~-]+(?:&[A-Za-z0-9._~-]+=[A-Za-z0-9._~-]+)*$/u.test(query)) {
      throw new Error(`${label} from ${importer} is invalid: ${specifier}`);
    }
    reference = reference.slice(0, queryIndex);
  }
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference);
  if (hasScheme || reference.startsWith('//')) return null;
  if (label === 'Browser module dependency' && !reference.startsWith('.') && !reference.startsWith('/')) {
    return null;
  }
  const joined = reference.startsWith('/')
    ? reference.slice(1)
    : posix.join(posix.dirname(importer), reference);
  return normalizePublicPath(posix.normalize(joined), `${label} from ${importer}`);
}

function isLocalBrowserReference(value) {
  return typeof value === 'string' && Boolean(value)
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    && !value.startsWith('//');
}

async function loadRelease(path) {
  const url = `${pathToFileURL(path).href}?gateway-static=${Date.now()}`;
  const module = await import(url);
  const release = module.ESP32_BROWSER_RELEASE;
  if (!release || typeof release !== 'object' || release.schema !== 1) {
    throw new Error('ESP32 browser release metadata must use schema 1');
  }
  return release;
}

function readCheckedManifest(workspace) {
  return parseJson(readFileSync(resolve(workspace, ALLOWLIST_RELATIVE)), 'Gateway static allowlist');
}

function assertGeneratedState(workspace, expected, checked = readCheckedManifest(workspace)) {
  assertManifestState(expected, checked);
  const expectedDockerignore = createGatewayDockerignore({ root: workspace, manifest: expected });
  const actualDockerignore = normalizeNewlines(readFileSync(resolve(workspace, DOCKERIGNORE_RELATIVE), 'utf8'));
  if (actualDockerignore !== expectedDockerignore) {
    throw new Error('Gateway Docker ignore allowlist is stale; run npm run generate:gateway-static-release');
  }
  return auditGatewayDockerContext({
    root: workspace,
    manifest: expected,
    dockerignoreSource: actualDockerignore,
  });
}

function assertManifestState(expected, checked) {
  assertGatewayManifest(checked);
  const expectedBody = jsonBody(expected);
  if (jsonBody(checked) !== expectedBody) {
    throw new Error('Gateway static allowlist is stale; run npm run generate:gateway-static-release');
  }
}

function writeGeneratedState(workspace, manifest) {
  const allowlistPath = resolve(workspace, ALLOWLIST_RELATIVE);
  const dockerignorePath = resolve(workspace, DOCKERIGNORE_RELATIVE);
  mkdirSync(dirname(allowlistPath), { recursive: true });
  writeFileSync(allowlistPath, jsonBody(manifest), 'utf8');
  writeFileSync(dockerignorePath, createGatewayDockerignore({ root: workspace, manifest }), 'utf8');
  return assertGeneratedState(workspace, manifest, manifest);
}

export function auditGatewayDockerContext({ root = ROOT, manifest, dockerignoreSource } = {}) {
  assertGatewayManifest(manifest);
  const workspace = resolve(root);
  const publicRoot = resolve(workspace, PUBLIC_RELATIVE);
  assertBoundaryDirectory(workspace, 'Gateway repository root');
  assertNoSymlink(workspace, publicRoot, 'Gateway public root');
  assertBoundaryDirectory(publicRoot, 'Gateway public root');
  const source = normalizeNewlines(dockerignoreSource ?? readFileSync(
    resolve(workspace, DOCKERIGNORE_RELATIVE),
    'utf8',
  ));
  const matcher = dockerIgnore({ ignorecase: false }).add(source);
  const allowlisted = new Set(manifest.sourceFiles);
  const publicFiles = collectPublicTreeFiles(publicRoot);
  const present = new Set(publicFiles.map((file) => file.path));
  const missing = manifest.sourceFiles.filter((file) => !present.has(file));
  if (missing.length) {
    throw new Error(`Gateway source allowlist files are missing: ${missing.slice(0, 5).join(', ')}`);
  }

  const mismatches = [];
  let includedFiles = 0;
  let includedBytes = 0;
  let excludedFiles = 0;
  let excludedBytes = 0;
  let publicBytes = 0;
  for (const file of publicFiles) {
    publicBytes += file.size;
    const expectedIgnored = !allowlisted.has(file.path);
    const contextPath = `${PUBLIC_RELATIVE}/${file.path}`;
    const ignored = matcher.ignores(contextPath);
    if (ignored !== expectedIgnored) mismatches.push(`${file.path}:${ignored ? 'ignored' : 'included'}`);
    if (expectedIgnored) {
      excludedFiles += 1;
      excludedBytes += file.size;
    } else {
      includedFiles += 1;
      includedBytes += file.size;
    }
  }
  if (mismatches.length) {
    throw new Error(
      `Gateway Docker ignore does not match the active source allowlist: ${mismatches.slice(0, 5).join(', ')}`,
    );
  }
  return Object.freeze({
    schema: 1,
    policy: 'gateway-docker-context-full-public-tree',
    publicFiles: publicFiles.length,
    publicBytes,
    includedFiles,
    includedBytes,
    excludedFiles,
    excludedBytes,
  });
}

function collectPublicTreeFiles(publicRoot) {
  const root = resolve(publicRoot);
  assertBoundaryDirectory(root, 'Gateway public root');
  const files = [];
  const pending = [{ path: root, relative: '' }];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current.path, { withFileTypes: true })) {
      const path = resolve(current.path, entry.name);
      const relativePath = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`Gateway public tree must not contain a symbolic link or junction: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        pending.push({ path, relative: relativePath });
      } else if (stat.isFile()) {
        files.push(Object.freeze({ path: relativePath, size: stat.size }));
      } else {
        throw new Error(`Gateway public tree contains a special filesystem entry: ${relativePath}`);
      }
    }
  }
  return files.sort((left, right) => compareText(left.path, right.path));
}

function assertGatewayManifest(value) {
  if (value?.schema !== 1 || value.policy !== 'gateway-static-active-release-closure'
    || !value.release || typeof value.release !== 'object'
    || !value.counts || typeof value.counts !== 'object') {
    throw new Error('Gateway static allowlist identity is invalid');
  }
  const sourceFiles = normalizeFileList(value.sourceFiles, 'Gateway source allowlist');
  const generatedAvrFiles = normalizeFileList(value.generatedAvrFiles, 'Gateway generated AVR allowlist');
  if (generatedAvrFiles.some((file) => !file.startsWith('avr/'))
    || sourceFiles.some((file) => file.startsWith('avr/'))
    || value.counts.sourceFiles !== sourceFiles.length
    || value.counts.generatedAvrFiles !== generatedAvrFiles.length
    || value.counts.totalFiles !== sourceFiles.length + generatedAvrFiles.length) {
    throw new Error('Gateway static allowlist counts or origins are invalid');
  }
}

function normalizeFileList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const normalized = value.map((file) => normalizePublicPath(file, label));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicates`);
  if (normalized.some((file, index) => index && compareText(normalized[index - 1], file) >= 0)) {
    throw new Error(`${label} must be sorted`);
  }
  return normalized;
}

function resolveRelative(base, value, boundary, label) {
  const normalized = normalizePublicPath(value, `${label} path`);
  const path = resolve(base, ...normalized.split('/'));
  assertInside(boundary, path, label);
  return path;
}

function publicFile(root, value, label) {
  const normalized = normalizePublicPath(value, label);
  const path = resolve(root, ...normalized.split('/'));
  assertInside(root, path, label);
  return path;
}

function normalizePublicPath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} path is invalid`);
  }
  const segments = value.replace(/^\.\//u, '').split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${label} path is invalid`);
  }
  return segments.join('/');
}

function safeLeaf(value, label) {
  const normalized = normalizePublicPath(value, label);
  if (normalized.includes('/')) throw new Error(`${label} must be one file name`);
  return normalized;
}

function readRegularFile(path, boundary, label) {
  assertInside(boundary, path, label);
  assertNoSymlink(boundary, path, label);
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
  return readFileSync(path);
}

function assertNoSymlink(boundary, path, label) {
  const root = resolve(boundary);
  const target = resolve(path);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`${label} boundary must not be a symbolic link or junction`);
  }
  const relativePath = relative(root, target);
  const parts = relativePath ? relativePath.split(sep) : [];
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} must not traverse a symbolic link or junction`);
    }
  }
}

function assertBoundaryDirectory(path, label) {
  const stat = lstatSync(resolve(path));
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link or junction`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
}

function assertNoSymlinkAncestors(path, label) {
  let current = resolve(path);
  while (true) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link or junction`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertInside(root, child, label) {
  const value = relative(resolve(root), resolve(child));
  if (!value || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay inside ${root}`);
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function slash(value) {
  return value.split(sep).join('/');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeNewlines(value) {
  return String(value).replaceAll('\r\n', '\n');
}

function jsonBody(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new TypeError('canonical JSON value is invalid');
  return `{${Object.keys(value).sort(compareText).map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function parseCli(values) {
  const options = { mode: null, root: ROOT, output: null };
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--write' || argument === '--check') {
      if (options.mode) throw new Error('choose exactly one Gateway static operation');
      options.mode = argument.slice(2);
    } else if (argument === '--stage') {
      if (options.mode) throw new Error('choose exactly one Gateway static operation');
      const output = values[++index];
      if (!output || output.startsWith('--')) throw new Error('--stage requires an output directory');
      options.mode = 'stage';
      options.output = output;
    } else if (argument === '--root') {
      const root = values[++index];
      if (!root || root.startsWith('--')) throw new Error('--root requires a workspace directory');
      options.root = resolve(root);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.mode) throw new Error('use --write, --check, or --stage <directory>');
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const manifest = await createGatewayStaticManifest({ root: options.root });
  if (options.mode === 'write') {
    const exclusions = writeGeneratedState(options.root, manifest);
    console.log(JSON.stringify({ state: 'written', counts: manifest.counts, exclusions, release: manifest.release }, null, 2));
    return;
  }
  if (options.mode === 'stage') {
    assertManifestState(manifest, readCheckedManifest(options.root));
    const result = stageGatewayStaticFiles({
      publicRoot: resolve(options.root, PUBLIC_RELATIVE),
      outputRoot: resolve(options.root, options.output),
      files: [...manifest.sourceFiles, ...manifest.generatedAvrFiles].sort(compareText),
    });
    console.log(JSON.stringify({ state: 'staged', ...result }, null, 2));
    return;
  }
  const exclusions = assertGeneratedState(options.root, manifest);
  console.log(JSON.stringify({ state: 'current', counts: manifest.counts, exclusions, release: manifest.release }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
