import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NodeFilesystemActionCache } from './ck-node-action-cache.mjs';
import { validateBrowserLibraryRequest } from './ck-browser-library-request.mjs';
import {
  createVerifierExceptionResult,
  createVerifierResult,
  encodeVerifierResult,
} from './ck-verifier-result.mjs';

const verifierStartedAt = Date.now();
const verifierResultToken = process.env.CK_VERIFIER_RESULT_TOKEN;
let verifierResultEmitted = false;

function emitVerifierResult(result, callback) {
  if (!verifierResultToken || verifierResultEmitted) {
    callback?.();
    return;
  }
  const encoded = encodeVerifierResult(result, verifierResultToken);
  verifierResultEmitted = true;
  process.stdout.write(encoded, callback);
}

// Top-level initialization failures happen before the executor can return its
// normal result. Emit the same bounded protocol record so the matrix parent
// does not have to recover the first error from a truncated log tail.
process.once('uncaughtException', (error) => {
  console.error(error?.stack ?? error);
  emitVerifierResult(
    createVerifierExceptionResult(error, { elapsedMs: Date.now() - verifierStartedAt }),
    () => process.exit(1),
  );
});

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

const requestFile = process.argv[2] === '--request-file' ? process.argv[3] : undefined;
if (process.argv[2] === '--request-file' && (!requestFile || process.argv.length !== 4)) {
  throw new Error('--request-file requires exactly one JSON path');
}
const requestPayload = requestFile
  ? validateBrowserLibraryRequest(JSON.parse(await readFile(resolve(requestFile), 'utf8')))
  : undefined;
const manifestArgument = requestPayload?.manifest ?? process.argv[2];
if (!manifestArgument) {
  throw new Error(
    'usage: node scripts/verify-ck-browser-c3-library-pack.mjs <toolchain.json> [header] [esp32|s2|s3|c3|c6] '
      + '[--project-file <name> <content>]... [--project-file-base64 <name> <base64>]... '
      + '[--macro <name>[=<value>]]... [--macro-base64 <name> <base64-value>]... '
      + '[--registry <registry.json>] [--only-action <id-substring>] [--trace-compiler] '
      + '| --request-file <request.json>',
  );
}
const target = requestPayload?.target ?? process.argv[4] ?? 'c3';
const TARGETS = Object.freeze({
  esp32: Object.freeze({
    board: 'esp32:esp32:esp32',
    runtime: 'esp32-xtensa',
    architecture: 'xtensa',
    defaultRoot: 'packages/web/public/esp32/v5/xtensa',
    descriptor: 'esp32.json',
    imageBuilder: 'buildEsp32Image',
    compilerBundle: 'clang/bundle.js',
  }),
  s2: Object.freeze({
    board: 'esp32:esp32:esp32s2',
    runtime: 'esp32-xtensa',
    architecture: 'xtensa',
    defaultRoot: 'packages/web/public/esp32/v5/xtensa',
    descriptor: 'esp32s2.json',
    imageBuilder: 'buildEsp32S2Image',
    compilerBundle: 'clang/bundle.js',
  }),
  s3: Object.freeze({
    board: 'esp32:esp32:esp32s3',
    runtime: 'esp32-xtensa',
    architecture: 'xtensa',
    defaultRoot: 'packages/web/public/esp32/v5/xtensa',
    descriptor: 'esp32s3.json',
    imageBuilder: 'buildEsp32S3Image',
    compilerBundle: 'clang/bundle.js',
  }),
  c3: Object.freeze({
    board: 'esp32:esp32:esp32c3',
    runtime: 'esp32-riscv',
    architecture: 'riscv32',
    defaultRoot: 'packages/web/public/esp32/v2/runtime',
    descriptor: 'runtime.json',
    imageBuilder: 'buildEsp32C3Image',
  }),
  c6: Object.freeze({
    board: 'esp32:esp32:esp32c6',
    runtime: 'esp32-riscv',
    architecture: 'riscv32',
    defaultRoot: 'packages/web/public/esp32/v2/runtime-c6',
    descriptor: 'runtime.json',
    imageBuilder: 'buildEsp32C6Image',
  }),
});
if (!Object.hasOwn(TARGETS, target)) {
  throw new Error(`library Pack smoke target must be one of ${Object.keys(TARGETS).join(', ')}`);
}
const targetConfig = TARGETS[target];
const smokeOptions = parseSmokeOptions(requestPayload ? [] : process.argv.slice(5), requestPayload);
const projectFiles = smokeOptions.projectFiles;
const libraryManifestUrl = pathToFileURL(resolve(manifestArgument));
const libraryManifest = JSON.parse(await readFile(fileURLToPath(libraryManifestUrl), 'utf8'));
const sourceArtifact = libraryManifest.artifacts?.find((artifact) => artifact.kind === 'library-source-json');
if (!sourceArtifact) throw new Error('library pack does not contain a library-source-json artifact');

async function fileFetch(input, init = {}) {
  const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'file:') return fetch(input, init);
  if (method !== 'GET') return new Response('method not allowed', { status: 405 });
  try {
    const bytes = await readFile(fileURLToPath(url));
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': url.pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        'content-length': String(bytes.byteLength),
      },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

const { createBrowserToolchainPackLoader } = await import('../packages/web/public/avr/v3/toolchain-pack.js');
const { ESP32_BROWSER_LIBRARY_PACK_LIMITS } = await import('../packages/web/public/esp32/v1/library-registry.js');
const sourceLoader = createBrowserToolchainPackLoader({
  manifestUrl: libraryManifestUrl,
  expectedId: libraryManifest.id,
  expectedRevision: libraryManifest.revision,
  limits: ESP32_BROWSER_LIBRARY_PACK_LIMITS,
  fetchFn: fileFetch,
});
const sourceBytes = (await sourceLoader.loadArtifact(sourceArtifact.id)).bytes;
const source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes));
const header = requestPayload?.header
  ?? process.argv[3]
  ?? source.files?.find((file) => /\.(?:h|hh|hpp|hxx)$/i.test(file.path))?.path?.replace(/^src\//, '');
if (!header) throw new Error('library pack does not expose a header for its smoke sketch');

const {
  resolveEsp32BrowserLibraries,
  validateEsp32BrowserLibraryRegistry,
} = await import('../packages/web/public/esp32/v1/library-registry.js');

async function resolveLibrarySelections() {
  const root = resolve(dirname(fileURLToPath(libraryManifestUrl)), '..', '..');
  const registryUrls = smokeOptions.registry
    ? [pathToFileURL(smokeOptions.registry)]
    : ['registry.json', 'registry.staging.json'].map((name) => pathToFileURL(resolve(root, name)));
  for (const url of registryUrls) {
    try {
      const registry = validateEsp32BrowserLibraryRegistry(
        JSON.parse(await readFile(fileURLToPath(url), 'utf8')),
        url,
      );
      const result = resolveEsp32BrowserLibraries(registry, [{ name: source.name, version: source.version }]);
      if (!result.supported) throw new Error(`registry cannot resolve ${source.name}@${source.version}`);
      const requested = result.libraries.find((library) => (
        library.name === source.name && library.version === source.version
      ));
      if (!requested || requested.manifestUrl !== libraryManifestUrl.href) {
        throw new Error(`registry Pack does not match ${libraryManifestUrl.href}`);
      }
      return result.libraries;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return [Object.freeze({
    name: source.name,
    version: source.version,
    packId: libraryManifest.id,
    revision: libraryManifest.revision,
    manifestUrl: libraryManifestUrl.href,
    artifact: sourceArtifact.id,
    dependencies: [],
  })];
}

const runtimeRoot = resolve(process.env.CK_RUNTIME_ROOT ?? targetConfig.defaultRoot);
const descriptorUrl = pathToFileURL(resolve(
  process.env.CK_RUNTIME_DESCRIPTOR ?? resolve(runtimeRoot, targetConfig.descriptor),
));
const descriptor = JSON.parse(await readFile(fileURLToPath(descriptorUrl), 'utf8'));
if (descriptor.board !== targetConfig.board) {
  throw new Error(`runtime descriptor board mismatch: expected ${targetConfig.board}, got ${descriptor.board}`);
}
const compilerBundleUrl = targetConfig.compilerBundle
  ? pathToFileURL(resolve(runtimeRoot, targetConfig.compilerBundle))
  : undefined;
const createPackLoader = (options) => createBrowserToolchainPackLoader({ ...options, fetchFn: fileFetch });
const { createEsp32BrowserBuildIR } = await import('../packages/web/public/ck-build-ir-envelope.js');
const { loadEsp32BrowserBuildPlanning, createEsp32BrowserActionExecutor } = await import('../packages/web/public/esp32/v2/c3-compiler.js');
const { createEsp32BrowserPackProvider } = await import('../packages/web/public/esp32/v2/ck-pack-provider.js');
const { loadEsp32C3Toolchain } = await import('../packages/web/public/esp32/v2/c3-clang-runtime.js');
const { preprocess } = await import('../packages/web/public/avr/v3/preprocess.js');
const imageBuilder = (await import('../packages/web/public/esp32/v2/image-builder.js'))[targetConfig.imageBuilder];
if (typeof imageBuilder !== 'function') throw new Error(`missing image builder ${targetConfig.imageBuilder}`);
const { BrowserWasmExecutor } = await import('../packages/web/public/ck-browser-executor.js');

async function loadBrowserToolchain(loader) {
  const processRef = globalThis.process;
  try {
    globalThis.process = undefined;
    const toolchain = await loadEsp32C3Toolchain({
      loader,
      ...(compilerBundleUrl ? { bundleUrl: compilerBundleUrl } : {}),
    });
    if (!smokeOptions.traceCompiler) return toolchain;
    return {
      ...toolchain,
      runClang(args, files, callbacks = {}) {
        return toolchain.runClang([...args, '-H'], files, {
          ...callbacks,
          stdout(bytes) {
            if (bytes != null) processRef.stdout.write(bytes);
            callbacks.stdout?.(bytes);
          },
          stderr(bytes) {
            if (bytes != null) processRef.stderr.write(bytes);
            callbacks.stderr?.(bytes);
          },
        });
      },
      runLLVM(args, files, callbacks = {}) {
        return toolchain.runLLVM(args, files, {
          ...callbacks,
          stdout(bytes) {
            if (bytes != null) processRef.stdout.write(bytes);
            callbacks.stdout?.(bytes);
          },
          stderr(bytes) {
            if (bytes != null) processRef.stderr.write(bytes);
            callbacks.stderr?.(bytes);
          },
        });
      },
    };
  } finally {
    globalThis.process = processRef;
  }
}

const selections = await resolveLibrarySelections();
const planning = await loadEsp32BrowserBuildPlanning({
  descriptor,
  descriptorUrl: descriptorUrl.href,
  libraries: selections,
  createPackLoader,
});
const capability = {
  profile: {
    board: descriptor.board,
    architecture: targetConfig.architecture,
    runtime: targetConfig.runtime,
    imageBuilder: true,
  },
  pinnedRuntime: { descriptor, descriptorUrl: descriptorUrl.href },
  pinnedLibraries: selections,
};
const request = {
  board: descriptor.board,
  options: {},
  libraries: [{ name: source.name, version: source.version }],
  macros: smokeOptions.macros,
  files: [
    { name: 'main.ino', content: `#include <${header}>\nvoid setup() {}\nvoid loop() {}\n` },
    ...projectFiles,
  ],
};
const ir = await createEsp32BrowserBuildIR(request, capability, planning);
const executionIr = selectSmokeActions(ir, smokeOptions.onlyAction);
const packs = createEsp32BrowserPackProvider({ capability, planning, ir: executionIr, dependencies: { createPackLoader } });
const adapter = await createEsp32BrowserActionExecutor({
  init: { descriptor, descriptorUrl: descriptorUrl.href },
  dependencies: {
    createPackLoader,
    loadToolchain: loadBrowserToolchain,
    preprocess,
    buildImage: imageBuilder,
  },
});
const executor = new BrowserWasmExecutor({
  cache: new NodeFilesystemActionCache(
    process.env.CK_BROWSER_ACTION_CACHE_DIR
      ?? resolve(import.meta.dirname, '../var/cache/ck-browser-actions-v1', target),
  ),
  packs,
  runAction: (action, context) => adapter.execute(
    action,
    action.inputs.map((input) => ({ path: input.path, bytes: context.readFile(input.path) })),
  ),
});
const started = Date.now();
const result = await executor.execute(executionIr, {
  onProgress: ({ completed, total, action, cached }) => console.log(`${completed}/${total} ${action.id} ${cached ? 'cached' : 'run'}`),
});
const summary = {
  status: result.status,
  reason: result.reason,
  message: result.message,
  library: `${source.name}@${source.version}`,
  resolvedLibraries: selections.map(({ name, version }) => `${name}@${version}`),
  header,
  target: descriptor.board,
  actionCount: result.actions?.length,
  actionId: result.actionId,
  failedAction: result.actionId
    ? executionIr.graph.actions.find((action) => action.id === result.actionId)
    : undefined,
  diagnostics: result.diagnostics,
  elapsedMs: Date.now() - started,
};
console.log(JSON.stringify(summary, null, 2));
emitVerifierResult(createVerifierResult({ result, summary }));
if (result.status !== 'success') process.exitCode = 1;
adapter.close();

function parseSmokeOptions(values, request) {
  const files = request?.projectFiles ? [...request.projectFiles] : [];
  const macros = request?.macros ? { ...request.macros } : {};
  let onlyAction = request?.onlyAction;
  let traceCompiler = request?.traceCompiler ?? false;
  let registry = request?.registry;
  for (let index = 0; index < values.length; index++) {
    if (values[index] === '--only-action') {
      onlyAction = values[++index];
      if (!onlyAction) throw new Error('--only-action requires an id substring');
      continue;
    }
    if (values[index] === '--project-file') {
      const name = values[++index];
      const content = values[++index];
      if (!name || content === undefined) throw new Error('--project-file requires <name> and <content>');
      files.push({ name, content });
      continue;
    }
    if (values[index] === '--project-file-base64') {
      const name = values[++index];
      const content = values[++index];
      if (!name || content === undefined) {
        throw new Error('--project-file-base64 requires <name> and <base64>');
      }
      files.push({ name, content: Buffer.from(content, 'base64').toString('utf8') });
      continue;
    }
    if (values[index] === '--macro') {
      const definition = values[++index];
      if (!definition) throw new Error('--macro requires <name>[=<value>]');
      const separator = definition.indexOf('=');
      const name = separator < 0 ? definition : definition.slice(0, separator);
      const value = separator < 0 ? true : definition.slice(separator + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid macro name: ${name}`);
      macros[name] = value;
      continue;
    }
    if (values[index] === '--macro-base64') {
      const name = values[++index];
      const value = values[++index];
      if (!name || value === undefined) throw new Error('--macro-base64 requires <name> and <base64-value>');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid macro name: ${name}`);
      macros[name] = Buffer.from(value, 'base64').toString('utf8');
      continue;
    }
    if (values[index] === '--trace-compiler') {
      traceCompiler = true;
      continue;
    }
    if (values[index] === '--registry') {
      registry = values[++index];
      if (!registry) throw new Error('--registry requires a path');
      registry = resolve(registry);
      continue;
    }
    throw new Error(`unknown smoke option: ${values[index]}`);
  }
  return Object.freeze({
    projectFiles: Object.freeze(files),
    macros: Object.freeze(macros),
    onlyAction,
    traceCompiler,
    registry,
  });
}

function selectSmokeActions(ir, substring) {
  if (!substring) return ir;
  const matches = ir.graph.actions.filter((action) => action.id.includes(substring));
  if (matches.length !== 1) {
    throw new Error(`--only-action must match exactly one Build IR Action, received ${matches.length}`);
  }
  if (matches[0].dependencies.length) {
    throw new Error('--only-action currently requires an Action without generated dependencies');
  }
  return Object.freeze({
    ...ir,
    graph: Object.freeze({ ...ir.graph, actions: Object.freeze(matches) }),
    artifacts: Object.freeze([]),
  });
}
