import { ESP32_BROWSER_RELEASE, esp32BrowserCapabilitiesUrl } from './esp32/v1/release.js';
import {
  ESP32_BROWSER_LIBRARY_MAX_SELECTIONS,
  hasEsp32BrowserLibraryRegistryPin,
  createEsp32BrowserLibraryPackLoader,
  installEsp32BrowserLibraryPack,
  listInstalledEsp32BrowserLibraryPacks,
  loadInstalledEsp32BrowserLibraryPack,
  removeInstalledEsp32BrowserLibraryPack,
  loadEsp32BrowserLibraryRegistry,
  resolveEsp32BrowserLibraryHeader,
  resolveEsp32BrowserLibraries,
} from './esp32/v1/library-registry.js';

export {
  createEsp32BrowserLibraryPackLoader,
  installEsp32BrowserLibraryPack,
  listInstalledEsp32BrowserLibraryPacks,
  loadInstalledEsp32BrowserLibraryPack,
  removeInstalledEsp32BrowserLibraryPack,
} from './esp32/v1/library-registry.js';
import {
  createEsp32C3RuntimeDescriptorLoader,
  createEsp32C3WorkerLauncher,
  createEsp32C6RuntimeDescriptorLoader,
  createEsp32C6WorkerLauncher,
  createEsp32RuntimeDescriptorLoader,
  createEsp32S2RuntimeDescriptorLoader,
  createEsp32S3RuntimeDescriptorLoader,
  createEsp32WorkerLauncher,
  createEsp32S2WorkerLauncher,
  createEsp32S3WorkerLauncher,
  getEsp32C3BrowserMemoryEligibility,
} from './esp32/v1/c3-runtime.js';
import { BrowserActionCache, BrowserCacheStorageActionCache, BrowserWasmExecutor } from './ck-browser-executor.js';
import { loadEsp32BrowserBuildPlanning } from './esp32/v2/c3-compiler.js';
import { createEsp32BrowserPackProvider } from './esp32/v2/ck-pack-provider.js';
import {
  createEsp32BrowserBuildIR,
  customEsp32PartitionsForBuildIR,
} from './ck-build-ir-envelope.js';
import {
  assertEsp32ApplicationFitsSlot,
  Esp32CustomPartitionsError,
} from './ck-esp32-partitions.js';
import { discoverLocalLibraryExternalDependencies } from './ck-project-resolver.js';
import { validateBuildIR as validateBuildIRWithRust } from './ck-rust-build-core.js';
import {
  hasEsp32BrowserPlatformRegistryPin,
  loadEsp32BrowserPlatformManifest,
  loadEsp32BrowserPlatformRegistry,
} from './esp32/v1/platform-registry.js';

const MAX_PROJECT_FILES = 128;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_PATH_CHARS = 160;
const SAFE_SOURCE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const SAFE_SOURCE_EXTENSION = /\.(?:ino|c|cc|cpp|cxx|s|asm|h|hh|hpp|hxx|inc|ipp|tpp)$/i;
const CUSTOM_PARTITIONS_PATH = 'partitions.csv';
const HEADER_EXTENSION = /\.(?:h|hh|hpp|hxx|inc|ipp|tpp)$/i;
const RESERVED_SOURCE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const SHA256 = /^[a-f0-9]{64}$/;
const LIBRARY_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/;
const LIBRARY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const INCLUDE_DIRECTIVE = /^[ \t]*#[ \t]*include[ \t]*([<"])([^>"\r\n]+)[>"]/gm;
const MISSING_HEADER_DIAGNOSTIC = /(?:file not found|no such file or directory|cannot open (?:source )?file)/i;
const RUNTIME_STATES = new Set(['unavailable', 'image-builder-only', 'ready']);
const C3_BOARD = 'esp32:esp32:esp32c3';
const C3_RUNTIME = 'esp32-riscv';
const ESP32_FQBN = /^esp32:esp32:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ESP32_BROWSER_ACTION_ADAPTER_POLICY = 'ck-esp32-browser-action-adapter-v3';
const ESP32_PRODUCT_IDS = new Set([
  'application', 'bootloader', 'partitions', 'boot-app0', 'merged',
]);
const ESP32_FLASH_PRODUCTS = Object.freeze([
  'application', 'bootloader', 'partitions', 'boot-app0',
]);
const ESP32_STATIC_PRODUCTS = Object.freeze([
  'bootloader', 'partitions', 'boot-app0',
]);
const ESP32_PRODUCT_FILENAMES = Object.freeze({
  application: 'firmware.bin',
  bootloader: 'bootloader.bin',
  partitions: 'partitions.bin',
  'boot-app0': 'boot_app0.bin',
  merged: 'firmware.merged.bin',
});
const ESP32_FLASH_OFFSET = /^0x[0-9a-f]+$/i;

// Arduino-ESP32 and C/C++ headers are part of the pinned SDK/toolchain and do
// not require a separately selected browser library pack. This is a routing
// allowlist, not a compiler capability claim; the Worker still validates the
// actual include and falls back if a SDK header is absent.
const ESP32_SDK_HEADER_NAMES = new Set([
  'arduino.h', 'base64.h', 'binary.h', 'cbuf.h', 'chip-debug-report.h',
  'client.h', 'colorformat.h', 'core_version.h', 'esp.h', 'esp_arduino_version.h',
  'esp32-hal.h', 'esp8266-compat.h', 'extra_attr.h', 'firmware_msc_fat.h',
  'firmwaremsc.h', 'freertos_stats.h', 'functionalinterrupt.h', 'hardwarei2c.h',
  'hardwareserial.h', 'hashbuilder.h', 'hexbuilder.h', 'hwcdc.h', 'io_pin_remap.h',
  'ipaddress.h', 'macaddress.h', 'md5builder.h', 'pgmspace.h', 'print.h',
  'printable.h', 'server.h', 'stdlib_noniso.h', 'stream.h', 'streamstring.h',
  'udp.h', 'usb.h', 'usbcdc.h', 'usbmsc.h', 'wcharacter.h', 'wiring_private.h',
  'wstring.h',
  'esp_bt.h', 'esp_event.h', 'esp_http_client.h', 'esp_http_server.h',
  'esp_log.h', 'esp_now.h', 'esp_partition.h', 'esp_sleep.h', 'esp_system.h',
  'esp_task_wdt.h', 'esp_timer.h', 'esp_wifi.h', 'freertos.h', 'mdns.h',
  'netif.h', 'nvs.h', 'soc.h', 'tcp.h',
  'assert.h', 'ctype.h', 'errno.h', 'float.h', 'limits.h', 'math.h',
  'stdint.h', 'stdio.h', 'stdlib.h', 'stddef.h', 'string.h', 'time.h',
  'algorithm', 'any', 'array', 'atomic', 'barrier', 'bit', 'bitset', 'cassert',
  'cctype', 'cerrno', 'cfenv', 'cfloat', 'charconv', 'chrono', 'cinttypes',
  'climits', 'clocale', 'cmath', 'codecvt', 'compare', 'complex', 'concepts',
  'condition_variable', 'coroutine', 'csetjmp', 'csignal', 'cstdarg', 'cstddef',
  'cstdint', 'cstdio', 'cstdlib', 'cstring', 'ctime', 'cuchar', 'cwchar',
  'cwctype', 'deque', 'exception', 'execution', 'filesystem', 'format',
  'forward_list', 'fstream', 'functional', 'future', 'initializer_list',
  'iomanip', 'ios', 'iosfwd', 'iostream', 'istream', 'iterator', 'latch', 'limits',
  'list', 'locale', 'map', 'memory', 'memory_resource', 'mutex', 'new', 'numbers',
  'numeric', 'optional', 'ostream', 'queue', 'random', 'ranges', 'ratio', 'regex',
  'scoped_allocator', 'semaphore', 'set', 'shared_mutex', 'source_location',
  'span', 'sstream', 'stack', 'stdexcept', 'stop_token', 'streambuf', 'string',
  'string_view', 'syncstream', 'system_error', 'thread', 'tuple', 'type_traits',
  'typeindex', 'typeinfo', 'unordered_map', 'unordered_set', 'utility', 'valarray',
  'variant', 'vector', 'version',
]);
const ESP32_SDK_HEADER_PREFIXES = Object.freeze([
  'sdk/include/', 'core/', 'backward/', 'bits/', 'ext/',
  'driver/', 'esp32/', 'esp_adc/', 'esp_bt/', 'esp_codec_dev/', 'esp_common/',
  'esp_event/', 'esp_eth/', 'esp_http_client/', 'esp_http_server/', 'esp_https_ota/',
  'esp_netif/', 'esp_partition/', 'esp_pm/', 'esp_private/', 'esp_system/',
  'esp_timer/', 'freertos/', 'hal/', 'lwip/', 'mbedtls/', 'rom/', 'soc/',
  'sys/', 'xtensa/',
]);
// Executable adapters cannot live in JSON. Board ownership, architecture, and
// image-builder eligibility come from the signed capability manifest; this map
// only binds an implemented board route to its loader and Worker launcher.
const BROWSER_RUNTIME_ADAPTERS = Object.freeze({
  'esp32-riscv': Object.freeze({
    architecture: 'riscv32',
    routes: Object.freeze({
      [C3_BOARD]: Object.freeze({
        createDescriptorLoader: createEsp32C3RuntimeDescriptorLoader,
        createWorkerLauncher: createEsp32C3WorkerLauncher,
      }),
      'esp32:esp32:esp32c6': Object.freeze({
        createDescriptorLoader: createEsp32C6RuntimeDescriptorLoader,
        createWorkerLauncher: createEsp32C6WorkerLauncher,
      }),
    }),
  }),
  'esp32-xtensa': Object.freeze({
    architecture: 'xtensa',
    routes: Object.freeze({
      'esp32:esp32:esp32': Object.freeze({
        createDescriptorLoader: createEsp32RuntimeDescriptorLoader,
        createWorkerLauncher: createEsp32WorkerLauncher,
      }),
      'esp32:esp32:esp32s2': Object.freeze({
        createDescriptorLoader: createEsp32S2RuntimeDescriptorLoader,
        createWorkerLauncher: createEsp32S2WorkerLauncher,
      }),
      'esp32:esp32:esp32s3': Object.freeze({
        createDescriptorLoader: createEsp32S3RuntimeDescriptorLoader,
        createWorkerLauncher: createEsp32S3WorkerLauncher,
      }),
    }),
  }),
});

const BROWSER_ROUTES = Object.freeze(Object.fromEntries(
  Object.entries(BROWSER_RUNTIME_ADAPTERS).flatMap(([runtime, adapter]) => (
    Object.entries(adapter.routes).map(([board, route]) => [board, Object.freeze({ ...route, runtime })])
  )),
));

const BOARD_PROFILES = Object.freeze(Object.fromEntries(
  Object.entries(BROWSER_ROUTES).map(([board, route]) => [board, Object.freeze({
    board,
    architecture: BROWSER_RUNTIME_ADAPTERS[route.runtime].architecture,
    runtime: route.runtime,
    imageBuilder: true,
  })]),
));

let capabilityPromise;
let libraryRegistryPromise;
let platformRegistryPromise;
const pinnedPlatformManifestPromises = new Map();
const pinnedRuntimePromises = new Map();
const browserBuildCache = typeof globalThis.caches === 'undefined'
  ? new BrowserActionCache()
  : new BrowserCacheStorageActionCache();

export const ESP32_BROWSER_BOARD_PROFILES = BOARD_PROFILES;

export function isEsp32BrowserBoard(board) {
  // Keep this synchronous predicate limited to routes with an executable
  // adapter. Capability metadata may retain unimplemented boards so the UI
  // can explain that their Pack is pending, but those boards must not enter
  // the browser compiler path.
  return typeof board === 'string'
    && Object.hasOwn(BROWSER_ROUTES, board)
    && BOARD_PROFILES[board]?.imageBuilder === true;
}

/**
 * Determine whether a request may use a browser ESP32 runtime.
 *
 * A board becomes eligible only when both same-origin capability metadata and
 * executable release pins select its exact descriptor and compiler revision.
 */
export async function browserEsp32Capability(request = {}) {
  if (!request || typeof request !== 'object' || typeof request.board !== 'string' || !ESP32_FQBN.test(request.board)) {
    return { supported: false, reason: 'board' };
  }
  if (!Object.hasOwn(BROWSER_ROUTES, request.board)) {
    return { supported: false, reason: 'board' };
  }

  const requestReason = validateRequest(request);
  const compatibilityProfile = BOARD_PROFILES[request.board];
  if (requestReason) {
    return {
      supported: false,
      reason: requestReason,
      ...(compatibilityProfile ? { profile: publicProfile(compatibilityProfile) } : {}),
    };
  }
  if (!browserPrimitivesAvailable()) {
    return {
      supported: false,
      reason: 'browser',
      ...(compatibilityProfile ? { profile: publicProfile(compatibilityProfile) } : {}),
    };
  }

  const manifest = await loadEsp32BrowserCapabilityManifest();
  const profile = manifest.profilesByBoard.get(request.board);
  if (!profile) return { supported: false, reason: 'board' };
  const runtime = manifest.byBoard.get(profile.board);
  if (!runtime) {
    throw new Error(`ESP32 browser capability manifest does not describe ${profile.board}`);
  }

  const result = {
    supported: false,
    profile: publicProfile(profile),
    runtime: { id: runtime.id, state: runtime.state },
  };
  const activation = browserEsp32RuntimeActivation(runtime, profile.board);
  if (!activation.enabled) return { ...result, reason: activation.reason };
  const route = BROWSER_ROUTES[profile.board];
  if (!profile.imageBuilder || !route) {
    return { ...result, reason: 'runtime_not_implemented' };
  }
  if (route.runtime !== runtime.id) {
    throw new Error(`ESP32 browser route runtime does not match the capability manifest for ${profile.board}`);
  }
  if (!getEsp32C3BrowserMemoryEligibility().eligible) {
    return { ...result, reason: 'device_memory' };
  }

  const localExternalDependencies = discoverLocalLibraryExternalDependencies(
    request.files.map((file) => ({ path: file.name, content: file.content })),
  );
  const explicitLibraries = mergeLibraryRefs(request.libraries ?? [], localExternalDependencies);
  let registry = null;
  let includeResolution = inspectEsp32BrowserIncludes(request.files, explicitLibraries);
  if (!includeResolution.supported || explicitLibraries.length > 0) {
    registry = await loadPinnedLibraryRegistry();
    if (!registry) return { ...result, reason: 'libraries' };
    includeResolution = inspectEsp32BrowserIncludes(request.files, explicitLibraries, registry);
  }
  if (!includeResolution.supported) return { ...result, reason: 'libraries' };
  // Explicit library selections still need registry resolution even when the
  // source has no direct include (for example a library used by generated code).

  const libraryResolution = await resolvePinnedLibraries(includeResolution.libraries, registry);
  if (!libraryResolution.supported) return { ...result, reason: libraryResolution.reason };

  const pinnedRuntime = await loadPinnedRuntime(profile, runtime);
  if (!hasEsp32BrowserPlatformRegistryPin(ESP32_BROWSER_RELEASE)) {
    return { ...result, reason: 'platform' };
  }
  const pinnedPlatformManifest = await loadPinnedPlatformManifest(profile.board, pinnedRuntime);
  return {
    ...result,
    supported: true,
    pinnedRuntime,
    pinnedPlatformManifest,
    pinnedLibraries: libraryResolution.libraries,
    ...(profile.board === C3_BOARD ? { c3Runtime: pinnedRuntime } : {}),
  };
}

function mergeLibraryRefs(primary, additional) {
  const merged = [];
  const names = new Set();
  for (const ref of [...primary, ...additional]) {
    const key = ref.name.toLowerCase();
    if (names.has(key)) continue;
    names.add(key);
    merged.push(ref);
  }
  return merged;
}

/**
 * Compile one release-pinned browser profile locally. The Worker returns
 * bytes; adapt them to the regular artifact API before the UI or flash layer
 * observes the result.
 */
export async function compileEsp32InBrowser(request, onProgress = () => {}, { signal } = {}) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  let started;
  try {
    if (signal?.aborted) return cancelledBrowserBuild();
    const capability = await browserEsp32Capability(request);
    if (signal?.aborted) return cancelledBrowserBuild();
    if (!capability.supported) return { handled: false, ...capability };

    started = clockNow();
    const route = BROWSER_ROUTES[capability.profile.board];
    const launcher = route.createWorkerLauncher({ enabled: true });
    const result = await compileEsp32ActionGraph({ request, capability, launcher, progress, started, signal });
    if (esp32WorkerResultNeedsServerFallback(result)) {
      return { handled: false, reason: 'libraries' };
    }
    return { handled: true, result };
  } catch (error) {
    if (signal?.aborted || error?.code === 'aborted') return cancelledBrowserBuild(started);
    try { progress({ stage: 'fallback', percent: 0, detail: 'browser runtime unavailable' }); } catch { /* Progress is advisory. */ }
    return {
      handled: false,
      reason: browserFallbackReason(error),
      retryable: browserAssetErrorRetryable(error),
      error,
    };
  }
}

async function compileEsp32ActionGraph({ request, capability, launcher, progress, started, signal }) {
  progress({ stage: 'assets', percent: 0, detail: 'Resolving CK Platform and Library Packs' });
  const planning = await loadEsp32BrowserBuildPlanning({
    descriptor: capability.pinnedRuntime.descriptor,
    descriptorUrl: capability.pinnedRuntime.descriptorUrl,
    publishedPlatformManifest: capability.pinnedPlatformManifest?.manifest,
    libraries: capability.pinnedLibraries ?? [],
    createPackLoader: createEsp32BrowserLibraryPackLoader,
  });
  if (signal?.aborted) return cancelledBrowserBuild(started).result;
  const ir = await createEsp32BrowserBuildIR(request, capability, planning);
  if (signal?.aborted) return cancelledBrowserBuild(started).result;
  const packs = createEsp32BrowserPackProvider({ capability, planning, ir });
  let session;
  try {
    session = await launcher.openActionSession({
      descriptor: capability.pinnedRuntime.descriptor,
      descriptorUrl: capability.pinnedRuntime.descriptorUrl,
      onProgress: progress,
      signal,
    });
    const executor = new BrowserWasmExecutor({
      cache: browserBuildCache,
      packs,
      adapterPolicyVersion: ESP32_BROWSER_ACTION_ADAPTER_POLICY,
      validateIR: async (candidate) => {
        await validateBuildIRWithRust(candidate);
      },
      runAction(action, context) {
        return session.runAction(action, {
          inputs: action.inputs.map((input) => ({ path: input.path, bytes: context.readFile(input.path) })),
          signal: context.signal,
          onProgress: progress,
        });
      },
    });
    const execution = await executor.execute(ir, {
      signal,
      onProgress: ({ completed, total, action, cached }) => {
        progress(actionProgress(action, completed, total, cached));
      },
    });
    return adaptEsp32BuildExecution(execution, started, ir);
  } finally {
    if (session) {
      try { await session.close(); } catch { /* The Worker is already a disposable isolation boundary. */ }
    }
  }
}

function actionProgress(action, completed, total, cached) {
  const stage = action?.kind === 'compile'
    ? 'compiling'
    : action?.kind === 'link'
      ? 'linking'
      : action?.kind === 'archive'
        ? 'archiving'
        : action?.kind === 'transform'
          ? 'imaging'
          : 'assets';
  return {
    stage,
    percent: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 100,
    detail: `${action?.id ?? 'CK Build IR action'}${cached ? ' (cached)' : ''}`,
  };
}

export async function adaptEsp32BuildExecution(execution, started, ir) {
  if (!execution || typeof execution !== 'object') throw new Error('CK browser executor returned no execution');
  if (execution.status === 'error') {
    const error = executionError(execution);
    if (execution.reason === 'cancelled') {
      return adaptEsp32WorkerResult({
        status: 'error',
        reason: 'cancelled',
        message: execution.message,
        diagnostics: execution.diagnostics ?? [],
        timings: { total: execution.durationMs },
      }, started);
    }
    if (execution.reason !== 'compile') throw error;
    return adaptEsp32WorkerResult({
      status: 'error',
      reason: 'compile_error',
      message: execution.message,
      diagnostics: execution.diagnostics ?? error.diagnostics ?? [],
      timings: { total: execution.durationMs },
    }, started);
  }
  if (execution.status !== 'success' || !Array.isArray(execution.artifacts)) {
    throw new Error('CK browser executor returned an invalid execution');
  }
  const products = indexEsp32ExecutionProducts(execution.artifacts, ir);
  const firmware = esp32FlashArtifact('application', products.get('application'));
  const customPartitions = customEsp32PartitionsForBuildIR(ir);
  if (customPartitions) {
    try {
      assertEsp32ApplicationFitsSlot(firmware.bytes?.byteLength, customPartitions.applicationSlot);
    } catch (error) {
      if (!(error instanceof Esp32CustomPartitionsError) || error.code !== 'capacity') throw error;
      return adaptEsp32WorkerResult({
        status: 'error',
        reason: 'resource_limit',
        message: error.message,
        diagnostics: execution.diagnostics ?? [],
        timings: { total: execution.durationMs },
      }, started);
    }
  }
  const staticArtifacts = ESP32_STATIC_PRODUCTS.map((productId) => (
    esp32FlashArtifact(productId, products.get(productId))
  ));
  const merged = products.get('merged');
  const workerResult = {
    status: 'success',
    artifacts: [firmware],
    staticArtifacts,
    downloadArtifacts: [{ name: ESP32_PRODUCT_FILENAMES.merged, bytes: merged.bytes }],
    diagnostics: execution.diagnostics ?? [],
    timings: { total: execution.durationMs },
  };
  return adaptEsp32WorkerResult(workerResult, started);
}

function indexEsp32ExecutionProducts(artifacts, ir) {
  const actionProducts = indexEsp32ActionOutputProducts(ir);
  const products = new Map();
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object' || typeof artifact.path !== 'string') continue;
    const directProductId = declaredEsp32ProductId(artifact, `artifact ${artifact.path}`);
    const actionProductId = actionProducts.get(artifact.path);
    if (directProductId && actionProductId && directProductId !== actionProductId) {
      throw new Error(`CK browser executor product identity mismatch for ${artifact.path}`);
    }
    const productId = directProductId ?? actionProductId;
    if (!productId) continue;
    if (products.has(productId)) {
      throw new Error(`CK browser executor returned duplicate ${productId} product`);
    }
    products.set(productId, artifact);
  }
  for (const productId of ESP32_PRODUCT_IDS) {
    if (!products.has(productId)) {
      throw new Error(`CK browser executor returned no ${productId} product`);
    }
  }
  return products;
}

function indexEsp32ActionOutputProducts(ir) {
  const products = new Map();
  if (ir === undefined || ir === null) return products;
  const actions = ir?.graph?.actions;
  if (!Array.isArray(actions)) throw new Error('CK browser Build IR has no Action graph');
  for (const action of actions) {
    for (const output of Array.isArray(action?.outputs) ? action.outputs : []) {
      if (!output || typeof output.path !== 'string') continue;
      const productId = declaredEsp32ProductId(output, `Action output ${output.path}`);
      if (!productId) continue;
      const existing = products.get(output.path);
      if (existing && existing !== productId) {
        throw new Error(`CK browser Build IR has conflicting product identities for ${output.path}`);
      }
      products.set(output.path, productId);
    }
  }
  return products;
}

function declaredEsp32ProductId(value, label) {
  const productId = ESP32_PRODUCT_IDS.has(value?.productId) ? value.productId : undefined;
  const kind = ESP32_PRODUCT_IDS.has(value?.kind) ? value.kind : undefined;
  if (productId && kind && productId !== kind) {
    throw new Error(`${label} has conflicting productId and kind`);
  }
  return productId ?? kind;
}

function esp32FlashArtifact(productId, artifact) {
  const offset = artifact?.offset;
  if (!ESP32_FLASH_PRODUCTS.includes(productId) || typeof offset !== 'string' || !ESP32_FLASH_OFFSET.test(offset)) {
    throw new Error(`CK browser executor returned no valid ${productId} flash offset`);
  }
  return {
    name: ESP32_PRODUCT_FILENAMES[productId],
    offset,
    bytes: artifact.bytes,
  };
}

function cancelledBrowserBuild(started = clockNow()) {
  return {
    handled: true,
    result: {
      status: 'error',
      reason: 'cancelled',
      message: 'compile was cancelled',
      diagnostics: [],
      timings: { total: Math.max(0, clockNow() - started) },
      cached: false,
      execution: 'browser',
    },
  };
}

function executionError(execution) {
  const error = new Error(String(execution?.message ?? 'CK browser build failed'));
  error.code = execution?.reason;
  error.diagnostics = Array.isArray(execution?.diagnostics) ? execution.diagnostics : [];
  return error;
}

/**
 * Inspect user-provided source before starting a browser build. The browser
 * route only claims a project when every include is either a project header,
 * a pinned SDK header, or a library header it can resolve from the registry.
 * This keeps a missing third-party library on the server path.
 */
export function inspectEsp32BrowserIncludes(files, explicitLibraries = [], registry = null) {
  const projectHeaders = projectHeaderNames(files);
  const libraries = [];
  const libraryNames = new Set();
  const explicitNames = new Set(
    Array.isArray(explicitLibraries)
      ? explicitLibraries
        .filter((ref) => ref && typeof ref === 'object' && typeof ref.name === 'string')
        .map((ref) => ref.name.toLowerCase())
      : [],
  );
  let unknown = false;

  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file.content !== 'string') continue;
    const source = stripCppComments(file.content);
    INCLUDE_DIRECTIVE.lastIndex = 0;
    let match;
    while ((match = INCLUDE_DIRECTIVE.exec(source))) {
      const delimiter = match[1];
      const spec = match[2].trim();
      if (!spec || spec.length > MAX_SOURCE_PATH_CHARS || spec.includes('\\')) {
        unknown = true;
        continue;
      }
      const normalized = spec.toLowerCase();
      const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
      if (projectHeaders.has(normalized) || projectHeaders.has(basename)) continue;

      // A validated Registry exact match outranks the broad SDK heuristics.
      // Several real Arduino libraries intentionally begin with "ESP32".
      const library = resolveEsp32BrowserLibraryHeader(registry, normalized, explicitLibraries, 'esp32');
      if (library) {
        const folded = library.name.toLowerCase();
        if (!libraryNames.has(folded) && !explicitNames.has(folded)) {
          libraryNames.add(folded);
          libraries.push({ name: library.name, version: library.version });
        }
        continue;
      }
      if (isEsp32SdkHeader(normalized, basename, { allowHeuristic: registry !== null })) continue;

      // An explicitly supplied source pack may contain private headers that
      // are not part of the public header map. Let the Worker validate it; a
      // missing nested header is caught by esp32WorkerResultNeedsServerFallback.
      if (explicitNames.size > 0 && delimiter === '<') continue;
      unknown = true;
    }
  }

  if (unknown) return Object.freeze({ supported: false, libraries: Object.freeze([]) });
  const requested = [];
  const requestedNames = new Set();
  for (const ref of Array.isArray(explicitLibraries) ? explicitLibraries : []) {
    if (!ref || typeof ref !== 'object' || typeof ref.name !== 'string') continue;
    const folded = ref.name.toLowerCase();
    if (requestedNames.has(folded)) continue;
    requestedNames.add(folded);
    requested.push({ name: ref.name, ...(ref.version === undefined ? {} : { version: ref.version }) });
  }
  for (const ref of libraries) {
    const folded = ref.name.toLowerCase();
    if (requestedNames.has(folded)) continue;
    requestedNames.add(folded);
    requested.push(ref);
  }
  return Object.freeze({ supported: true, libraries: Object.freeze(requested) });
}

/** Return true only for a compiler failure caused by an unavailable header. */
export function esp32WorkerResultNeedsServerFallback(result) {
  if (!result || result.status !== 'error' || result.reason !== 'compile_error') return false;
  if (MISSING_HEADER_DIAGNOSTIC.test(String(result.message ?? ''))) return true;
  return Array.isArray(result.diagnostics)
    && result.diagnostics.some((diagnostic) => MISSING_HEADER_DIAGNOSTIC.test(String(diagnostic?.message ?? '')));
}

/**
 * Load same-origin capability data and verify it against release.js before it
 * influences routing. The capability JSON is not eligible for a CDN override.
 */
class Esp32BrowserCapabilityHttpError extends Error {
  constructor(status) {
    super(`ESP32 browser capability manifest returned ${status}`);
    this.status = status;
  }
}

function isRetryableAssetHttpStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

async function loadEsp32BrowserCapabilityManifestAttempt(url, cache) {
  const response = await fetch(url, { cache });
  if (!response.ok) throw new Esp32BrowserCapabilityHttpError(response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 64 * 1024) throw new Error('ESP32 browser capability manifest exceeds 64 KiB');
  const actual = await sha256Hex(bytes);
  if (actual !== ESP32_BROWSER_RELEASE.capabilities.sha256) {
    throw new Error('ESP32 browser capability manifest checksum mismatch');
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('ESP32 browser capability manifest is not valid UTF-8 JSON');
  }
  return validateEsp32BrowserCapabilityManifest(value);
}

export async function loadEsp32BrowserCapabilityManifest() {
  if (!capabilityPromise) {
    const pending = (async () => {
      const url = esp32BrowserCapabilitiesUrl();
      try {
        return await loadEsp32BrowserCapabilityManifestAttempt(url, 'no-cache');
      } catch (error) {
        if (
          error instanceof Esp32BrowserCapabilityHttpError
          && !isRetryableAssetHttpStatus(error.status)
        ) throw error;
        return loadEsp32BrowserCapabilityManifestAttempt(url, 'reload');
      }
    })();
    const wrapped = pending.catch((error) => {
      if (capabilityPromise === wrapped) capabilityPromise = undefined;
      throw error;
    });
    capabilityPromise = wrapped;
  }
  return capabilityPromise;
}

/** Validate the narrow manifest surface before browser routing consumes it. */
export function validateEsp32BrowserCapabilityManifest(value) {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1
    || !Array.isArray(value.runtimes) || value.runtimes.length === 0 || value.runtimes.length > 32
  ) {
    throw new Error('ESP32 browser capability manifest has an invalid shape');
  }
  const runtimes = [];
  const byBoard = new Map();
  const profilesByBoard = new Map();
  const ids = new Set();
  for (const valueRuntime of value.runtimes) {
    const runtime = validateRuntime(valueRuntime);
    if (ids.has(runtime.id)) throw new Error(`ESP32 browser capability runtime is duplicated: ${runtime.id}`);
    ids.add(runtime.id);

    const adapter = BROWSER_RUNTIME_ADAPTERS[runtime.id];
    if (adapter && runtime.architecture !== adapter.architecture) {
      throw new Error(`ESP32 browser capability architecture is invalid for ${runtime.id}`);
    }
    for (const board of runtime.boards) {
      if (byBoard.has(board)) throw new Error(`ESP32 browser board is declared twice: ${board}`);
      byBoard.set(board, runtime);
      profilesByBoard.set(board, Object.freeze({
        board,
        architecture: runtime.architecture,
        runtime: runtime.id,
        imageBuilder: runtime.imageBuilderBoards.includes(board),
      }));
    }
    runtimes.push(runtime);
  }
  return { schema: 1, runtimes, byBoard, profilesByBoard };
}

/**
 * A ready runtime must match release.js before it is allowed to become
 * eligible. Same-origin release code is the only activation authority.
 */
export function browserEsp32RuntimeActivation(runtime, board) {
  if (runtime.state !== 'ready') return { enabled: false, reason: 'runtime_unavailable' };
  const releaseRuntime = ESP32_BROWSER_RELEASE.runtimes[runtime.id];
  if (!releaseRuntime?.enabled) return { enabled: false, reason: 'runtime_unavailable' };
  if (
    !runtime.toolchain
    || runtime.toolchain.id !== releaseRuntime.toolchainId
    || runtime.toolchain.revision !== releaseRuntime.revision
  ) return { enabled: false, reason: 'runtime_unpinned' };

  const boards = board
    ? [board]
    : runtime.id === C3_RUNTIME
      ? [C3_BOARD]
      : Array.isArray(runtime.boards)
        ? runtime.boards.filter((candidate) => Object.hasOwn(BROWSER_ROUTES, candidate))
        : [];
  for (const candidate of boards) {
    if (Object.hasOwn(BROWSER_ROUTES, candidate) && !descriptorReleasePin(releaseRuntime, candidate)) {
      return { enabled: false, reason: 'runtime_unpinned' };
    }
  }
  return { enabled: true };
}

/** Load one board descriptor only through a release-provided SHA-256 pin. */
async function loadPinnedRuntime(profile, runtime) {
  const route = BROWSER_ROUTES[profile.board];
  const releaseRuntime = ESP32_BROWSER_RELEASE.runtimes[runtime.id];
  const pin = descriptorReleasePin(releaseRuntime, profile.board);
  if (!route || !pin) throw new Error(`${profile.board} runtime descriptor is not release-pinned`);
  const key = `${profile.board}\0${pin.url.href}\0${pin.sha256}\0${runtime.toolchain.id}\0${runtime.toolchain.revision}`;
  const existing = pinnedRuntimePromises.get(key);
  if (existing) return existing;

  const pending = (async () => {
    const descriptor = await route.createDescriptorLoader({
      descriptorUrl: pin.url,
      expectedSha256: pin.sha256,
    }).load();
    const compiler = descriptor.packs.find((pack) => pack.role === 'compiler');
    if (
      !compiler
      || compiler.id !== runtime.toolchain.id
      || compiler.revision !== runtime.toolchain.revision
    ) throw new Error(`${profile.board} descriptor compiler pack does not match the release pin`);
    return Object.freeze({ descriptor, descriptorUrl: pin.url.href });
  })();
  const wrapped = pending.catch((error) => {
    if (pinnedRuntimePromises.get(key) === wrapped) pinnedRuntimePromises.delete(key);
    throw error;
  });
  pinnedRuntimePromises.set(key, wrapped);
  return wrapped;
}

/** Resolve one board descriptor only from the uniform per-board release map. */
function descriptorReleasePin(releaseRuntime, board) {
  if (!releaseRuntime || typeof releaseRuntime !== 'object') return null;
  const boardPin = releaseRuntime.descriptors?.[board];
  const path = boardPin?.url ?? boardPin?.path;
  const sha256 = boardPin?.sha256;
  if (typeof path !== 'string' || !SHA256.test(sha256)) return null;
  try {
    return Object.freeze({
      url: new URL(path, import.meta.url),
      sha256,
    });
  } catch {
    return null;
  }
}

async function adaptEsp32WorkerResult(result, started) {
  if (!result || typeof result !== 'object') throw new Error('ESP32 Worker returned no result');
  const timings = normalizedTimings(result.timings, started);
  if (result.status === 'error') {
    return {
      status: 'error',
      reason: result.reason,
      message: result.message,
      diagnostics: result.diagnostics,
      timings,
      cached: false,
      execution: 'browser',
    };
  }
  if (result.status !== 'success') throw new Error('ESP32 Worker result status is invalid');
  const downloadArtifacts = Array.isArray(result.downloadArtifacts)
    ? await Promise.all(result.downloadArtifacts.map(adaptEsp32Artifact))
    : [];
  return {
    status: 'success',
    artifacts: await Promise.all(result.artifacts.map(adaptEsp32Artifact)),
    staticArtifacts: await Promise.all(result.staticArtifacts.map(adaptEsp32Artifact)),
    ...(downloadArtifacts.length === 0 ? {} : { downloadArtifacts }),
    diagnostics: result.diagnostics,
    timings,
    ...(result.memory === undefined ? {} : { memory: result.memory }),
    cached: false,
    execution: 'browser',
  };
}

async function adaptEsp32Artifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || !(artifact.bytes instanceof Uint8Array)) {
    throw new Error('ESP32 Worker artifact is invalid');
  }
  const bytes = new Uint8Array(artifact.bytes);
  if (!bytes.byteLength) throw new Error('ESP32 Worker artifact is empty');
  return {
    name: artifact.name,
    ...(artifact.offset === undefined ? {} : { offset: artifact.offset }),
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    base64: bytesToBase64(bytes),
  };
}

function browserFallbackReason(error) {
  if (error?.code === 'resource_limit') return 'device_memory';
  return 'assets';
}

function browserAssetErrorRetryable(error) {
  if (error?.retryable === true) return true;
  if (error?.retryable === false) return false;
  if (['aborted', 'resource_limit', 'timeout', 'worker_error', 'worker_protocol', 'worker_post'].includes(error?.code)) {
    return false;
  }
  const status = Number(error?.status ?? String(error?.message ?? '').match(/\bHTTP\s+(\d{3})\b/i)?.[1]);
  if (Number.isInteger(status)) return status === 408 || status === 429 || (status >= 500 && status <= 599);
  const message = String(error?.message ?? '').toLowerCase();
  if (/(checksum mismatch|invalid|unexpected|not valid|not published|not release-pinned|identity does not match|exceeds|unsupported|missing)/i.test(message)) {
    return false;
  }
  return true;
}

function normalizedTimings(value, started) {
  const timings = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  if (!Number.isFinite(timings.total) || timings.total < 0) timings.total = Math.max(0, clockNow() - started);
  return timings;
}

function clockNow() {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}

function validateRequest(request) {
  const files = request.files;
  const fileReason = validateProjectFiles(files);
  if (fileReason) return fileReason;
  const options = request.options ?? {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) return 'request';
  const libraries = request.libraries ?? [];
  const libraryReason = validateLibraryRefs(libraries);
  if (libraryReason) return libraryReason;
  const macros = request.macros ?? {};
  if (!macros || typeof macros !== 'object' || Array.isArray(macros)) return 'request';
  const macroEntries = Object.entries(macros);
  if (macroEntries.length > 64) return 'request';
  for (const [name, value] of macroEntries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'request';
    if (value !== true && (typeof value !== 'string' || value.length > 256 || value.includes('\0'))) return 'request';
  }
  return null;
}

function validateLibraryRefs(value) {
  if (!Array.isArray(value) || value.length > ESP32_BROWSER_LIBRARY_MAX_SELECTIONS) return 'request';
  const names = new Set();
  for (const ref of value) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return 'request';
    const keys = Object.keys(ref);
    if (keys.some((key) => !['name', 'version'].includes(key)) || !Object.hasOwn(ref, 'name')) return 'request';
    if (typeof ref.name !== 'string' || !LIBRARY_NAME.test(ref.name)) return 'request';
    if (ref.version !== undefined && (typeof ref.version !== 'string' || !LIBRARY_VERSION.test(ref.version))) {
      return 'request';
    }
    const folded = ref.name.toLowerCase();
    if (names.has(folded)) return 'request';
    names.add(folded);
  }
  return null;
}

function projectHeaderNames(files) {
  const names = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file.name !== 'string' || !HEADER_EXTENSION.test(file.name)) continue;
    const normalized = file.name.toLowerCase();
    names.add(normalized);
    names.add(normalized.slice(normalized.lastIndexOf('/') + 1));
  }
  return names;
}

function stripCppComments(value) {
  return String(value)
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, ' '))
    .replace(/\/\/[^\r\n]*/g, '');
}

function isEsp32SdkHeader(normalized, basename, { allowHeuristic = true } = {}) {
  return ESP32_SDK_HEADER_NAMES.has(basename)
    || ESP32_SDK_HEADER_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    || (allowHeuristic && /^(?:esp|sdk|idf|hal|freertos|lwip|mbedtls|soc|rom|sys)[A-Za-z0-9_/-]*\.h$/.test(normalized));
}

async function loadPinnedLibraryRegistry() {
  if (!hasEsp32BrowserLibraryRegistryPin(ESP32_BROWSER_RELEASE)) return null;
  if (!libraryRegistryPromise) {
    const pending = loadEsp32BrowserLibraryRegistry({ release: ESP32_BROWSER_RELEASE });
    const wrapped = pending.catch((error) => {
      if (libraryRegistryPromise === wrapped) libraryRegistryPromise = undefined;
      throw error;
    });
    libraryRegistryPromise = wrapped;
  }
  return libraryRegistryPromise;
}

async function loadPinnedPlatformRegistry() {
  if (!hasEsp32BrowserPlatformRegistryPin(ESP32_BROWSER_RELEASE)) return null;
  if (!platformRegistryPromise) {
    const pending = loadEsp32BrowserPlatformRegistry({ release: ESP32_BROWSER_RELEASE });
    const wrapped = pending.catch((error) => {
      if (platformRegistryPromise === wrapped) platformRegistryPromise = undefined;
      throw error;
    });
    platformRegistryPromise = wrapped;
  }
  return platformRegistryPromise;
}

async function loadPinnedPlatformManifest(board, pinnedRuntime) {
  const descriptor = pinnedRuntime?.descriptor;
  const sdkPack = descriptor?.packs?.find((pack) => pack?.role === 'sdk');
  if (!sdkPack) throw new Error(`${board} runtime descriptor SDK Pack is missing`);
  const registry = await loadPinnedPlatformRegistry();
  if (!registry) throw new Error('ESP32 browser Platform registry is not release-pinned');
  const entry = registry.byFqbn.get(board);
  if (!entry) throw new Error(`${board} Platform Manifest is not release-pinned`);
  const key = `${board}\0${entry.manifestUrl}\0${entry.sha256}\0${sdkPack.id}\0${sdkPack.revision}`;
  const existing = pinnedPlatformManifestPromises.get(key);
  if (existing) return existing;

  const pending = loadEsp32BrowserPlatformManifest({
    registry,
    fqbn: board,
    sdkPack,
  });
  const wrapped = pending.catch((error) => {
    if (pinnedPlatformManifestPromises.get(key) === wrapped) pinnedPlatformManifestPromises.delete(key);
    throw error;
  });
  pinnedPlatformManifestPromises.set(key, wrapped);
  return wrapped;
}

async function resolvePinnedLibraries(refs, registry = null) {
  if (!refs.length) return Object.freeze({ supported: true, libraries: Object.freeze([]) });
  const pinnedRegistry = registry ?? await loadPinnedLibraryRegistry();
  if (!pinnedRegistry) return Object.freeze({ supported: false, reason: 'libraries' });
  return resolveEsp32BrowserLibraries(pinnedRegistry, refs, 'esp32');
}

function validateProjectFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_PROJECT_FILES) return 'request';
  const names = new Set();
  const headerNames = new Set();
  let sketchCount = 0;
  let totalBytes = 0;
  for (const file of files) {
    if (
      !file || typeof file !== 'object' || Array.isArray(file)
      || typeof file.name !== 'string' || !safeProjectPath(file.name)
      || typeof file.content !== 'string'
    ) return 'request';
    const foldedName = file.name.toLowerCase();
    if (names.has(foldedName)) return 'request';
    names.add(foldedName);
    if (file.content.includes('\0')) return 'request';
    if (/\.ino$/i.test(file.name)) {
      if (file.name.includes('/')) return 'request';
      sketchCount += 1;
    }
    if (HEADER_EXTENSION.test(file.name)) {
      const headerName = file.name.slice(file.name.lastIndexOf('/') + 1).toLowerCase();
      if (headerNames.has(headerName)) return 'request';
      headerNames.add(headerName);
    }
    const bytes = new TextEncoder().encode(file.content).byteLength;
    if (bytes > MAX_SOURCE_BYTES) return 'source_size';
    totalBytes += bytes;
    if (totalBytes > MAX_SOURCE_BYTES) return 'source_size';
  }
  return sketchCount === 1 ? null : 'request';
}

function safeProjectPath(value) {
  const libraryMetadata = /^libraries\/[^/]+\/(?:library\.properties|license|licence|copying|notice|authors|readme)$/i.test(value);
  const customPartitions = value === CUSTOM_PARTITIONS_PATH;
  if (!value || value.length > MAX_SOURCE_PATH_CHARS || value.includes('\\')
    || (!SAFE_SOURCE_EXTENSION.test(value) && !libraryMetadata && !customPartitions)) {
    return false;
  }
  const segments = value.split('/');
  return segments.length <= 8 && segments.every((segment) => (
    SAFE_SOURCE_SEGMENT.test(segment) && !RESERVED_SOURCE_SEGMENTS.has(segment.toLowerCase())
  ));
}

function browserPrimitivesAvailable() {
  return typeof globalThis.Worker !== 'undefined'
    && typeof globalThis.WebAssembly !== 'undefined'
    && typeof globalThis.DecompressionStream === 'function'
    && typeof globalThis.TextEncoder !== 'undefined'
    && typeof globalThis.TextDecoder !== 'undefined'
    && typeof globalThis.crypto?.subtle?.digest === 'function';
}

function validateRuntime(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ESP32 browser capability runtime is invalid');
  }
  const { id, architecture, boards, state, imageBuilderBoards, toolchain } = value;
  if (
    typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
    || typeof architecture !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(architecture)
    || !RUNTIME_STATES.has(state)
  ) {
    throw new Error('ESP32 browser capability runtime has invalid metadata');
  }
  if (
    !stringArray(boards) || !boards.every((board) => ESP32_FQBN.test(board)) || new Set(boards).size !== boards.length
    || !stringArray(imageBuilderBoards, { allowEmpty: true })
    || new Set(imageBuilderBoards).size !== imageBuilderBoards.length
    || !imageBuilderBoards.every((board) => boards.includes(board))
  ) {
    throw new Error(`ESP32 browser capability board list is invalid for ${id}`);
  }
  if (state === 'ready') {
    if (
      !toolchain || typeof toolchain !== 'object' || Array.isArray(toolchain)
      || typeof toolchain.id !== 'string' || !SHA256.test(toolchain.revision)
    ) throw new Error(`ESP32 browser runtime ${id} is ready without a pinned toolchain revision`);
  } else if (toolchain !== null) {
    throw new Error(`ESP32 browser runtime ${id} has a toolchain before it is ready`);
  }
  return {
    id,
    architecture,
    boards: [...boards],
    state,
    imageBuilderBoards: [...imageBuilderBoards],
    toolchain: state === 'ready' ? { id: toolchain.id, revision: toolchain.revision } : null,
  };
}

function stringArray(value, { allowEmpty = false } = {}) {
  return Array.isArray(value)
    && (allowEmpty || value.length > 0)
    && value.length <= 32
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 128);
}

function publicProfile(profile) {
  return {
    board: profile.board,
    architecture: profile.architecture,
    runtime: profile.runtime,
    imageBuilder: profile.imageBuilder,
  };
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
