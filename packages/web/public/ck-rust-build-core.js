let bindingsPromise;

async function loadBindings() {
  if (!bindingsPromise) {
    bindingsPromise = (async () => {
      const bindings = await import('./ck-build-core-wasm/ck_build_core.js');
      const wasmUrl = new URL('./ck-build-core-wasm/ck_build_core_bg.wasm', import.meta.url);
      if (typeof process !== 'undefined' && process.versions?.node) {
        const { readFile } = await import('node:fs/promises');
        bindings.initSync({ module: await readFile(wasmUrl) });
      } else {
        await bindings.default({ module_or_path: wasmUrl });
      }
      return bindings;
    })();
  }
  return bindingsPromise;
}

async function callJson(operation, input) {
  const bindings = await loadBindings();
  const invoke = bindings[operation];
  if (typeof invoke !== 'function') throw new Error(`ck-build-core WASM operation is unavailable: ${operation}`);
  return JSON.parse(invoke(JSON.stringify(input)));
}

export function resolveProject(input) {
  return callJson('resolveProject', input);
}

export function resolveTarget(input) {
  return callJson('resolveTarget', input);
}

export function resolvePlatform(input) {
  return callJson('resolvePlatform', input);
}

export function resolveLibraries(input) {
  return callJson('resolveLibraries', Array.isArray(input) ? { packs: [...input] } : input);
}

export function createActionGraph(input) {
  return callJson('createActionGraph', input);
}

export function createBuildIR(input) {
  return callJson('createBuildIR', input);
}

export function planBuildActions(input) {
  return callJson('planBuildActions', input);
}

/** Plan CK Build IR with the same Rust/WASM core used by native services. */
export function planBuildIR(input) {
  return callJson('planBuildIR', input);
}

export function resolvePlatformManifest(input) {
  return callJson('resolvePlatformManifest', input);
}

export function calculateActionKeys(input) {
  return callJson('calculateActionKeys', input);
}

export function mapDiagnostics(diagnostics, map) {
  const input = map === undefined && diagnostics && !Array.isArray(diagnostics)
    ? diagnostics
    : {
        diagnostics,
        map: Array.isArray(map) ? { entries: [...map] } : map,
      };
  return callJson('mapDiagnostics', input);
}

export function migrateBuildIR(input) {
  return callJson('migrateBuildIR', input);
}

export async function validateBuildIR(input) {
  const bindings = await loadBindings();
  bindings.validateBuildIR(JSON.stringify(input));
}
