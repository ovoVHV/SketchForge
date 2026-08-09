const RESOURCE_DEFINITIONS = Object.freeze([
  Object.freeze({ file: 'llvm.core.wasm', artifact: 'llvm.core.wasm', kind: 'wasm', contentType: 'application/wasm' }),
  Object.freeze({ file: 'llvm.core2.wasm', artifact: 'llvm.core2.wasm', kind: 'wasm', contentType: 'application/wasm' }),
  Object.freeze({ file: 'llvm.core3.wasm', artifact: 'llvm.core3.wasm', kind: 'wasm', contentType: 'application/wasm' }),
  Object.freeze({ file: 'llvm.core4.wasm', artifact: 'llvm.core4.wasm', kind: 'wasm', contentType: 'application/wasm' }),
  Object.freeze({ file: 'llvm-resources.tar', artifact: 'llvm-resources.tar', kind: 'tar', contentType: 'application/x-tar' }),
]);

export const ESP32_C3_CLANG_RESOURCE_ARTIFACTS = Object.freeze(Object.fromEntries(
  RESOURCE_DEFINITIONS.map(({ file, artifact }) => [file, artifact]),
));

/** Load both compiler-driver and LLVM utility entry points for CK Action execution. */
export async function loadEsp32C3Toolchain({
  loader,
  importModule = (url) => import(url),
  bundleUrl = new URL('./clang/bundle.js', import.meta.url),
  globalRef = globalThis,
  ResponseClass = globalThis.Response,
} = {}) {
  const module = await loadEsp32C3CompilerModule({
    loader, importModule, bundleUrl, globalRef, ResponseClass,
  });
  if (typeof module.runClang !== 'function' || typeof module.runLLVM !== 'function') {
    throw new Error('ESP32-C3 Clang bundle does not expose the CK Action toolchain');
  }
  return Object.freeze({ runClang: module.runClang, runLLVM: module.runLLVM });
}

async function loadEsp32C3CompilerModule({
  loader,
  importModule,
  bundleUrl,
  globalRef,
  ResponseClass,
}) {
  if (typeof loader?.loadArtifact !== 'function') {
    throw new TypeError('ESP32-C3 verified compiler pack loader is required');
  }
  if (typeof importModule !== 'function') throw new TypeError('ESP32-C3 Clang module importer is required');
  if (typeof ResponseClass !== 'function') throw new TypeError('Response is required to load ESP32-C3 Clang resources');
  if (!globalRef || (typeof globalRef !== 'object' && typeof globalRef !== 'function')) {
    throw new TypeError('ESP32-C3 Clang global object is invalid');
  }

  const trustedModule = new URL(import.meta.url);
  const bundle = new URL(bundleUrl, trustedModule);
  if (
    bundle.protocol !== trustedModule.protocol
    || bundle.origin !== trustedModule.origin
    || bundle.username
    || bundle.password
    || bundle.search
    || bundle.hash
    || !bundle.pathname.endsWith('/clang/bundle.js')
  ) throw new Error('ESP32-C3 Clang bundle must be trusted same-origin code');

  const resourceBase = new URL('./', bundle);
  const resources = new Map(RESOURCE_DEFINITIONS.map((definition) => [
    new URL(definition.file, resourceBase).href,
    definition,
  ]));
  const originalFetch = globalRef.fetch;
  const hadOwnFetch = Object.hasOwn(globalRef, 'fetch');
  const verifiedFetch = async (input, init) => {
    const url = requestUrl(input, resourceBase);
    const definition = resources.get(url.href);
    if (!definition) {
      if (typeof originalFetch !== 'function') throw new Error(`fetch is unavailable for ${url.href}`);
      return originalFetch.call(globalRef, input, init);
    }
    if (requestMethod(input, init) !== 'GET') {
      throw new Error(`ESP32-C3 Clang resource only supports GET: ${definition.file}`);
    }
    const loaded = await loader.loadArtifact(definition.artifact);
    validateCompilerArtifact(loaded, definition);
    return new ResponseClass(loaded.bytes, {
      status: 200,
      headers: {
        'content-type': definition.contentType,
        'content-length': String(loaded.bytes.byteLength),
      },
    });
  };

  let module;
  globalRef.fetch = verifiedFetch;
  try {
    module = await importModule(bundle.href);
  } finally {
    if (hadOwnFetch) globalRef.fetch = originalFetch;
    else delete globalRef.fetch;
  }
  if (!module || typeof module !== 'object') throw new Error('ESP32-C3 Clang bundle is invalid');
  return module;
}

function requestUrl(input, base) {
  if (typeof input === 'string' || input instanceof URL) return new URL(input, base);
  if (typeof input?.url === 'string') return new URL(input.url, base);
  throw new TypeError('ESP32-C3 Clang resource request URL is invalid');
}

function requestMethod(input, init) {
  return String(init?.method ?? input?.method ?? 'GET').toUpperCase();
}

function validateCompilerArtifact(loaded, definition) {
  if (
    !loaded
    || typeof loaded !== 'object'
    || !loaded.artifact
    || typeof loaded.artifact !== 'object'
    || loaded.artifact.id !== definition.artifact
    || loaded.artifact.kind !== definition.kind
    || !Number.isSafeInteger(loaded.artifact.size)
    || !(loaded.bytes instanceof Uint8Array)
    || !loaded.bytes.byteLength
    || loaded.artifact.size !== loaded.bytes.byteLength
  ) throw new Error(`ESP32-C3 compiler artifact is invalid: ${definition.artifact}`);
}
