/**
 * Narrow, disabled-by-default browser runtime contract for ESP32-C3.
 *
 * This module deliberately does not compile anything. It establishes the
 * trusted-data boundary and Worker ABI a real RISC-V toolchain must satisfy:
 * local executable code, release-pinned descriptor bytes, and independently
 * pinned immutable Compiler, Platform, and Board Packs.
 */

export const ESP32_C3_RUNTIME_DESCRIPTOR_SCHEMA = 2;
export const ESP32_C3_WORKER_ABI = 1;
export const ESP32_C3_RUNTIME_ID = 'esp32-c3-arduino';
export const ESP32_C3_BOARD = 'esp32:esp32:esp32c3';
export const ESP32_C6_RUNTIME_ID = 'esp32-c6-arduino';
export const ESP32_C6_BOARD = 'esp32:esp32:esp32c6';
export const ESP32_H2_RUNTIME_ID = 'esp32-h2-arduino';
export const ESP32_H2_BOARD = 'esp32:esp32:esp32h2';
export const ESP32_C5_RUNTIME_ID = 'esp32-c5-arduino';
export const ESP32_C5_BOARD = 'esp32:esp32:esp32c5';
export const ESP32_P4_RUNTIME_ID = 'esp32-p4-arduino';
export const ESP32_P4_BOARD = 'esp32:esp32:esp32p4';
export const ESP32_RUNTIME_ID = 'esp32-arduino';
export const ESP32_BOARD = 'esp32:esp32:esp32';
export const ESP32_S2_RUNTIME_ID = 'esp32-s2-arduino';
export const ESP32_S2_BOARD = 'esp32:esp32:esp32s2';
export const ESP32_S3_RUNTIME_ID = 'esp32-s3-arduino';
export const ESP32_S3_BOARD = 'esp32:esp32:esp32s3';
export const ESP32_C3_RUNTIME_PACK_ROLES = Object.freeze(['compiler', 'sdk', 'board']);
export const ESP32_C3_DESCRIPTOR_MAX_BYTES = 64 * 1024;
export const ESP32_C3_WORKER_TIMEOUT_MS = 10 * 60_000;
// This checks actual browser heap headroom only when Chromium exposes it. It
// is not a total-device-RAM requirement and does not reserve browser memory.
export const ESP32_C3_BROWSER_MIN_HEAP_HEADROOM_BYTES = 768 * 1024 * 1024;
// These byte limits are deliberately narrower than the generic pack-loader
// defaults. The C3 compiler must stay usable on ordinary browser devices;
// optional ESP-IDF features belong in separately selected SDK artifacts.
export const ESP32_C3_RUNTIME_PACK_LIMITS = Object.freeze({
  compiler: Object.freeze({
    maxArtifacts: 16,
    maxChunksPerArtifact: 64,
    maxArtifactBytes: 128 * 1024 * 1024,
    maxTotalBytes: 128 * 1024 * 1024,
  }),
  sdk: Object.freeze({
    maxArtifacts: 96,
    maxChunksPerArtifact: 128,
    maxArtifactBytes: 64 * 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024,
  }),
  board: Object.freeze({
    maxArtifacts: 16,
    maxChunksPerArtifact: 32,
    maxArtifactBytes: 16 * 1024 * 1024,
    maxTotalBytes: 32 * 1024 * 1024,
  }),
});

/**
 * Decide whether a device may attempt the future local C3 compiler. A browser
 * may supply a coarse device-memory value for telemetry, but it is never a
 * requirement. When Chromium exposes current heap capacity, use that direct
 * headroom signal to retain a server fallback before a Worker is created.
 */
export function getEsp32C3BrowserMemoryEligibility({
  navigatorRef = globalThis.navigator,
  performanceRef = globalThis.performance,
} = {}) {
  const reportedDeviceMemoryGiB = typeof navigatorRef?.deviceMemory === 'number'
    && Number.isFinite(navigatorRef.deviceMemory)
    ? navigatorRef.deviceMemory
    : null;
  const heapHeadroomBytes = browserHeapHeadroomBytes(performanceRef);
  if (
    heapHeadroomBytes !== null
    && heapHeadroomBytes < ESP32_C3_BROWSER_MIN_HEAP_HEADROOM_BYTES
  ) {
    return Object.freeze({
      eligible: false,
      reason: 'heap_headroom',
      minimumHeapHeadroomBytes: ESP32_C3_BROWSER_MIN_HEAP_HEADROOM_BYTES,
      heapHeadroomBytes,
      reportedDeviceMemoryGiB,
    });
  }
  return Object.freeze({
    eligible: true,
    heapHeadroomBytes,
    reportedDeviceMemoryGiB,
  });
}

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/;
const SAFE_MANIFEST_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}\.json$/;
const RESERVED_PROJECT_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const DIAGNOSTIC_SEVERITIES = new Set(['error', 'warning', 'info']);
// Action failures use BrowserWasmExecutor's canonical reason vocabulary on
// the session boundary. Legacy compiler reasons are normalized below while
// their original machine-readable code remains available to callers.
const ACTION_FAILURE_REASONS = new Set([
  'invalid_ir',
  'integrity',
  'tool',
  'compile',
  'timeout',
  'resource_limit',
  'cancelled',
  'internal',
]);
const PROGRESS_STAGES = new Set(['assets', 'libraries', 'preprocess', 'compiling', 'linking', 'imaging']);
const MAX_DIAGNOSTICS = 128;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 8 * 1024;
const ACTION_KINDS = new Set(['compile', 'archive', 'link', 'transform']);
const ACTION_LANGUAGES = new Set(['c', 'c++', 'asm']);
const ACTION_TRANSFORM_FORMATS = new Set([
  'elf', 'bin', 'hex', 'bootloader', 'partition', 'boot-app0', 'other',
]);
const MAX_ACTION_ID_CHARS = 256;
const MAX_ACTION_TOOL_CHARS = 512;
const MAX_ACTION_ARGUMENTS = 4096;
const MAX_ACTION_ARGUMENT_CHARS = 16 * 1024;
const MAX_ACTION_ENVIRONMENT = 256;
const MAX_ACTION_DEPENDENCIES = 4096;
const MAX_ACTION_INPUTS = 4096;
const MAX_ACTION_OUTPUTS = 256;
const MAX_ACTION_DIAGNOSTICS = 1024;
const MAX_ACTION_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ACTION_TOTAL_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_ACTION_TOTAL_OUTPUT_BYTES = 128 * 1024 * 1024;
const RUNTIME_TARGETS = Object.freeze({
  c3: Object.freeze({
    label: 'ESP32-C3', runtimeId: ESP32_C3_RUNTIME_ID, board: ESP32_C3_BOARD,
  }),
  c6: Object.freeze({
    label: 'ESP32-C6', runtimeId: ESP32_C6_RUNTIME_ID, board: ESP32_C6_BOARD,
  }),
  h2: Object.freeze({
    label: 'ESP32-H2', runtimeId: ESP32_H2_RUNTIME_ID, board: ESP32_H2_BOARD,
  }),
  c5: Object.freeze({
    label: 'ESP32-C5', runtimeId: ESP32_C5_RUNTIME_ID, board: ESP32_C5_BOARD,
  }),
  p4: Object.freeze({
    label: 'ESP32-P4', runtimeId: ESP32_P4_RUNTIME_ID, board: ESP32_P4_BOARD,
  }),
  esp32: Object.freeze({
    label: 'ESP32', runtimeId: ESP32_RUNTIME_ID, board: ESP32_BOARD,
  }),
  s2: Object.freeze({
    label: 'ESP32-S2', runtimeId: ESP32_S2_RUNTIME_ID, board: ESP32_S2_BOARD,
  }),
  s3: Object.freeze({
    label: 'ESP32-S3', runtimeId: ESP32_S3_RUNTIME_ID, board: ESP32_S3_BOARD,
  }),
});

/**
 * Validate only the data contract for a C3 runtime descriptor. The descriptor
 * is not trusted until createEsp32C3RuntimeDescriptorLoader verifies its
 * release-provided SHA-256 pin.
 */
export function validateEsp32C3RuntimeDescriptor(value) {
  return validateEsp32RuntimeDescriptorForTarget(value, RUNTIME_TARGETS.c3);
}

export function validateEsp32C6RuntimeDescriptor(value) {
  return validateEsp32RuntimeDescriptorForTarget(value, RUNTIME_TARGETS.c6);
}

export function validateEsp32H2RuntimeDescriptor(value) {
  return validateEsp32RuntimeDescriptorForTarget(value, RUNTIME_TARGETS.h2);
}

export function validateEsp32C5RuntimeDescriptor(value) {
  return validateEsp32RuntimeDescriptorForTarget(value, RUNTIME_TARGETS.c5);
}

export function validateEsp32P4RuntimeDescriptor(value) {
  return validateEsp32RuntimeDescriptorForTarget(value, RUNTIME_TARGETS.p4);
}

export function validateEsp32RuntimeDescriptor(value) {
  return validateEsp32RuntimeDescriptorForTarget(value, RUNTIME_TARGETS.esp32);
}

export function validateEsp32S2RuntimeDescriptor(value) {
  return validateEsp32RuntimeDescriptorForTarget(value, RUNTIME_TARGETS.s2);
}

export function validateEsp32S3RuntimeDescriptor(value) {
  return validateEsp32RuntimeDescriptorForTarget(value, RUNTIME_TARGETS.s3);
}

function validateEsp32RuntimeDescriptorForTarget(value, target) {
  const descriptor = exactRecord(value, `${target.label} runtime descriptor`, [
    'schema', 'id', 'abi', 'board', 'packs',
  ]);
  if (descriptor.schema !== ESP32_C3_RUNTIME_DESCRIPTOR_SCHEMA) {
    fail(`unsupported ${target.label} runtime descriptor schema`);
  }
  if (descriptor.id !== target.runtimeId) {
    fail(`unexpected ${target.label} runtime id`);
  }
  if (descriptor.abi !== ESP32_C3_WORKER_ABI) {
    fail(`unsupported ${target.label} Worker ABI`);
  }
  if (descriptor.board !== target.board) {
    fail(`${target.label} runtime descriptor targets an unexpected board`);
  }
  const packRoles = ESP32_C3_RUNTIME_PACK_ROLES;
  if (!Array.isArray(descriptor.packs) || descriptor.packs.length !== packRoles.length) {
    fail(`${target.label} runtime descriptor has an invalid pack list`);
  }

  const seenIds = new Set();
  const seenManifestPaths = new Set();
  const packs = descriptor.packs.map((valuePack, index) => {
    const pack = exactRecord(valuePack, `${target.label} runtime pack`, ['role', 'id', 'revision', 'manifest']);
    const expectedRole = packRoles[index];
    if (pack.role !== expectedRole) {
      fail(`${target.label} runtime packs must be ordered as ${packRoles.join(', ')}`);
    }
    if (typeof pack.id !== 'string' || !IDENTIFIER.test(pack.id)) {
      fail(`invalid ${target.label} ${pack.role} pack id`);
    }
    if (typeof pack.revision !== 'string' || !SHA256.test(pack.revision)) {
      fail(`invalid ${target.label} ${pack.role} pack revision`);
    }
    if (!isSafeManifestPath(pack.manifest, pack)) {
      fail(`invalid ${target.label} ${pack.role} pack manifest path`);
    }
    if (seenIds.has(pack.id)) fail(`${target.label} runtime pack id is duplicated: ${pack.id}`);
    if (seenManifestPaths.has(pack.manifest)) {
      fail(`${target.label} runtime pack manifest path is duplicated: ${pack.manifest}`);
    }
    seenIds.add(pack.id);
    seenManifestPaths.add(pack.manifest);
    return Object.freeze({
      role: pack.role,
      id: pack.id,
      revision: pack.revision,
      manifest: pack.manifest,
    });
  });

  return Object.freeze({
    schema: ESP32_C3_RUNTIME_DESCRIPTOR_SCHEMA,
    id: target.runtimeId,
    abi: ESP32_C3_WORKER_ABI,
    board: target.board,
    packs: Object.freeze(packs),
  });
}

/**
 * Fetch a descriptor only when its SHA-256 is pinned by local release code.
 * The returned descriptor has no activation flag: activation remains the
 * caller's responsibility after a real toolchain/hardware probe exists.
 */
export function createEsp32C3RuntimeDescriptorLoader(options = {}) {
  return createEsp32RuntimeDescriptorLoaderForTarget(options, RUNTIME_TARGETS.c3);
}

export function createEsp32C6RuntimeDescriptorLoader(options = {}) {
  return createEsp32RuntimeDescriptorLoaderForTarget(options, RUNTIME_TARGETS.c6);
}

export function createEsp32RuntimeDescriptorLoader(options = {}) {
  return createEsp32RuntimeDescriptorLoaderForTarget(options, RUNTIME_TARGETS.esp32);
}

export function createEsp32S2RuntimeDescriptorLoader(options = {}) {
  return createEsp32RuntimeDescriptorLoaderForTarget(options, RUNTIME_TARGETS.s2);
}

export function createEsp32S3RuntimeDescriptorLoader(options = {}) {
  return createEsp32RuntimeDescriptorLoaderForTarget(options, RUNTIME_TARGETS.s3);
}

class Esp32RuntimeDescriptorHttpError extends Error {
  constructor(target, status) {
    super(`${target.label} runtime descriptor returned HTTP ${status}`);
    this.status = status;
  }
}

function isRetryableDescriptorHttpStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function createEsp32RuntimeDescriptorLoaderForTarget({
  descriptorUrl,
  expectedSha256,
  fetchFn = globalThis.fetch,
  cryptoRef = globalThis.crypto,
  maxBytes = ESP32_C3_DESCRIPTOR_MAX_BYTES,
}, target) {
  const url = normalizeDescriptorUrl(descriptorUrl);
  if (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256)) {
    throw new TypeError(`${target.label} runtime descriptor SHA-256 pin is invalid`);
  }
  if (typeof fetchFn !== 'function') throw new TypeError(`fetch is required to load an ${target.label} runtime descriptor`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > ESP32_C3_DESCRIPTOR_MAX_BYTES) {
    throw new TypeError(`${target.label} runtime descriptor size limit is invalid`);
  }

  const loadAttempt = async (cache) => {
    const response = await fetchFn(url, { cache });
    if (!response?.ok) {
      throw new Esp32RuntimeDescriptorHttpError(target, response?.status ?? 'unknown');
    }
    const contentLength = response.headers?.get?.('content-length');
    if (contentLength != null && contentLength !== '') {
      const length = Number(contentLength);
      if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
        throw new Error(`${target.label} runtime descriptor exceeds its size limit`);
      }
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`${target.label} runtime descriptor exceeds its size limit`);
    const actualSha256 = await sha256Hex(bytes, cryptoRef);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`${target.label} runtime descriptor checksum mismatch`);
    }
    return validateEsp32RuntimeDescriptorForTarget(
      parseUtf8Json(bytes, `${target.label} runtime descriptor`),
      target,
    );
  };

  let descriptorPromise;
  const load = () => {
    if (!descriptorPromise) {
      const pending = (async () => {
        try {
          return await loadAttempt('no-cache');
        } catch (error) {
          if (
            error instanceof Esp32RuntimeDescriptorHttpError
            && !isRetryableDescriptorHttpStatus(error.status)
          ) throw error;
          return loadAttempt('reload');
        }
      })();
      const wrapped = pending.catch((error) => {
        if (descriptorPromise === wrapped) descriptorPromise = undefined;
        throw error;
      });
      descriptorPromise = wrapped;
    }
    return descriptorPromise;
  };

  return Object.freeze({
    load,
    reset() { descriptorPromise = undefined; },
  });
}

/**
 * Turn a verified descriptor into immutable generic-pack loader inputs. The
 * caller supplies the generic pack loader, keeping this ABI independent of a
 * particular Emscripten/GCC implementation.
 */
export function createEsp32C3RuntimePackLoaders({
  descriptor,
  descriptorUrl,
  createPackLoader,
  onProgress = () => {},
} = {}) {
  return createEsp32RuntimePackLoadersForTarget({
    descriptor, descriptorUrl, createPackLoader, onProgress,
  }, RUNTIME_TARGETS.c3);
}

export function createEsp32C6RuntimePackLoaders({
  descriptor,
  descriptorUrl,
  createPackLoader,
  onProgress = () => {},
} = {}) {
  return createEsp32RuntimePackLoadersForTarget({
    descriptor, descriptorUrl, createPackLoader, onProgress,
  }, RUNTIME_TARGETS.c6);
}

export function createEsp32H2RuntimePackLoaders({
  descriptor,
  descriptorUrl,
  createPackLoader,
  onProgress = () => {},
} = {}) {
  return createEsp32RuntimePackLoadersForTarget({
    descriptor, descriptorUrl, createPackLoader, onProgress,
  }, RUNTIME_TARGETS.h2);
}

export function createEsp32C5RuntimePackLoaders({
  descriptor,
  descriptorUrl,
  createPackLoader,
  onProgress = () => {},
} = {}) {
  return createEsp32RuntimePackLoadersForTarget({
    descriptor, descriptorUrl, createPackLoader, onProgress,
  }, RUNTIME_TARGETS.c5);
}

export function createEsp32P4RuntimePackLoaders({
  descriptor,
  descriptorUrl,
  createPackLoader,
  onProgress = () => {},
} = {}) {
  return createEsp32RuntimePackLoadersForTarget({
    descriptor, descriptorUrl, createPackLoader, onProgress,
  }, RUNTIME_TARGETS.p4);
}

export function createEsp32RuntimePackLoaders({
  descriptor,
  descriptorUrl,
  createPackLoader,
  onProgress = () => {},
} = {}) {
  return createEsp32RuntimePackLoadersForTarget({
    descriptor, descriptorUrl, createPackLoader, onProgress,
  }, RUNTIME_TARGETS.esp32);
}

export function createEsp32S2RuntimePackLoaders({
  descriptor,
  descriptorUrl,
  createPackLoader,
  onProgress = () => {},
} = {}) {
  return createEsp32RuntimePackLoadersForTarget({
    descriptor, descriptorUrl, createPackLoader, onProgress,
  }, RUNTIME_TARGETS.s2);
}

export function createEsp32S3RuntimePackLoaders({
  descriptor,
  descriptorUrl,
  createPackLoader,
  onProgress = () => {},
} = {}) {
  return createEsp32RuntimePackLoadersForTarget({
    descriptor, descriptorUrl, createPackLoader, onProgress,
  }, RUNTIME_TARGETS.s3);
}

function createEsp32RuntimePackLoadersForTarget({
  descriptor,
  descriptorUrl,
  createPackLoader,
  onProgress,
}, target) {
  if (typeof createPackLoader !== 'function') {
    throw new TypeError(`${target.label} runtime pack loader factory is required`);
  }
  if (typeof onProgress !== 'function') throw new TypeError(`${target.label} runtime progress callback must be a function`);

  const plan = esp32RuntimePackPlanForTarget(descriptor, descriptorUrl, target);
  const loaders = {};
  for (const pack of plan) {
    const loader = createPackLoader({
      manifestUrl: pack.manifestUrl,
      expectedId: pack.id,
      expectedRevision: pack.revision,
      limits: ESP32_C3_RUNTIME_PACK_LIMITS[pack.role],
      onProgress(progress) {
        onProgress({
          role: pack.role,
          ...(isPlainRecord(progress) ? progress : { detail: String(progress ?? '') }),
        });
      },
    });
    if (!loader || (typeof loader !== 'object' && typeof loader !== 'function')) {
      throw new TypeError(`${target.label} ${pack.role} pack loader is invalid`);
    }
    loaders[pack.role] = loader;
  }
  return Object.freeze(loaders);
}

/** Return fixed, checksum-pinned generic-pack locations for a descriptor. */
export function esp32C3RuntimePackPlan(descriptor, descriptorUrl) {
  return esp32RuntimePackPlanForTarget(descriptor, descriptorUrl, RUNTIME_TARGETS.c3);
}

export function esp32C6RuntimePackPlan(descriptor, descriptorUrl) {
  return esp32RuntimePackPlanForTarget(descriptor, descriptorUrl, RUNTIME_TARGETS.c6);
}

export function esp32H2RuntimePackPlan(descriptor, descriptorUrl) {
  return esp32RuntimePackPlanForTarget(descriptor, descriptorUrl, RUNTIME_TARGETS.h2);
}

export function esp32C5RuntimePackPlan(descriptor, descriptorUrl) {
  return esp32RuntimePackPlanForTarget(descriptor, descriptorUrl, RUNTIME_TARGETS.c5);
}

export function esp32P4RuntimePackPlan(descriptor, descriptorUrl) {
  return esp32RuntimePackPlanForTarget(descriptor, descriptorUrl, RUNTIME_TARGETS.p4);
}

export function esp32RuntimePackPlan(descriptor, descriptorUrl) {
  return esp32RuntimePackPlanForTarget(descriptor, descriptorUrl, RUNTIME_TARGETS.esp32);
}

export function esp32S2RuntimePackPlan(descriptor, descriptorUrl) {
  return esp32RuntimePackPlanForTarget(descriptor, descriptorUrl, RUNTIME_TARGETS.s2);
}

export function esp32S3RuntimePackPlan(descriptor, descriptorUrl) {
  return esp32RuntimePackPlanForTarget(descriptor, descriptorUrl, RUNTIME_TARGETS.s3);
}

function esp32RuntimePackPlanForTarget(descriptor, descriptorUrl, target) {
  const normalizedDescriptor = validateEsp32RuntimeDescriptorForTarget(descriptor, target);
  const plan = normalizedDescriptor.packs.map((pack) => {
    const manifestUrl = resolveEsp32RuntimePackManifestUrl(pack, descriptorUrl, target.label);
    return Object.freeze({
      role: pack.role,
      id: pack.id,
      revision: pack.revision,
      manifestUrl: manifestUrl.href,
    });
  });
  return Object.freeze(plan);
}

/**
 * Resolve a runtime Pack without letting board descriptors choose arbitrary
 * parent paths. Compiler Packs may use the content-addressed toolchain root;
 * SDK and Board Packs may use the content-addressed runtime Pack root.
 */
export function resolveEsp32RuntimePackManifestUrl(pack, descriptorUrl, label = 'ESP32') {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    throw new TypeError(`${label} runtime pack is invalid`);
  }
  const url = normalizeDescriptorUrl(descriptorUrl);
  const base = new URL('./', url);
  const manifestUrl = new URL(pack.manifest, base);
  const isLocal = manifestUrl.origin === base.origin
    && manifestUrl.pathname.startsWith(base.pathname)
    && !manifestUrl.search
    && !manifestUrl.hash;
  const sharedPath = sharedPackManifestPath(pack);
  const sharedUrl = sharedPath ? new URL(sharedPath, base) : null;
  const isSharedPack = sharedUrl !== null
    && pack.manifest === sharedPath
    && manifestUrl.href === sharedUrl.href
    && manifestUrl.origin === base.origin
    && !manifestUrl.search
    && !manifestUrl.hash;
  if (!isLocal && !isSharedPack) {
    fail(`${label} ${String(pack.role ?? 'unknown')} pack manifest escapes the allowed Pack roots`);
  }
  return manifestUrl;
}

/** Create the first request for a persistent CK Build IR Action session. */
export function createEsp32C3WorkerActionInitRequest({
  id,
  descriptor,
  descriptorUrl,
} = {}) {
  return createEsp32WorkerActionInitRequestForTarget({ id, descriptor, descriptorUrl }, RUNTIME_TARGETS.c3);
}

export function createEsp32C6WorkerActionInitRequest(input = {}) {
  return createEsp32WorkerActionInitRequestForTarget(input, RUNTIME_TARGETS.c6);
}

export function createEsp32H2WorkerActionInitRequest(input = {}) {
  return createEsp32WorkerActionInitRequestForTarget(input, RUNTIME_TARGETS.h2);
}

export function createEsp32C5WorkerActionInitRequest(input = {}) {
  return createEsp32WorkerActionInitRequestForTarget(input, RUNTIME_TARGETS.c5);
}

export function createEsp32P4WorkerActionInitRequest(input = {}) {
  return createEsp32WorkerActionInitRequestForTarget(input, RUNTIME_TARGETS.p4);
}

export function createEsp32WorkerActionInitRequest(input = {}) {
  return createEsp32WorkerActionInitRequestForTarget(input, RUNTIME_TARGETS.esp32);
}

export function createEsp32S2WorkerActionInitRequest(input = {}) {
  return createEsp32WorkerActionInitRequestForTarget(input, RUNTIME_TARGETS.s2);
}

export function createEsp32S3WorkerActionInitRequest(input = {}) {
  return createEsp32WorkerActionInitRequestForTarget(input, RUNTIME_TARGETS.s3);
}

/** Validate the first request for a persistent ESP32-C3 Action session. */
export function validateEsp32C3WorkerActionInitRequest(value) {
  return validateEsp32WorkerActionInitRequestForTarget(value, RUNTIME_TARGETS.c3);
}

export function validateEsp32C6WorkerActionInitRequest(value) {
  return validateEsp32WorkerActionInitRequestForTarget(value, RUNTIME_TARGETS.c6);
}

export function validateEsp32H2WorkerActionInitRequest(value) {
  return validateEsp32WorkerActionInitRequestForTarget(value, RUNTIME_TARGETS.h2);
}

export function validateEsp32C5WorkerActionInitRequest(value) {
  return validateEsp32WorkerActionInitRequestForTarget(value, RUNTIME_TARGETS.c5);
}

export function validateEsp32P4WorkerActionInitRequest(value) {
  return validateEsp32WorkerActionInitRequestForTarget(value, RUNTIME_TARGETS.p4);
}

export function validateEsp32WorkerActionInitRequest(value) {
  return validateEsp32WorkerActionInitRequestForTarget(value, RUNTIME_TARGETS.esp32);
}

export function validateEsp32S2WorkerActionInitRequest(value) {
  return validateEsp32WorkerActionInitRequestForTarget(value, RUNTIME_TARGETS.s2);
}

export function validateEsp32S3WorkerActionInitRequest(value) {
  return validateEsp32WorkerActionInitRequestForTarget(value, RUNTIME_TARGETS.s3);
}

function createEsp32WorkerActionInitRequestForTarget({ id, descriptor, descriptorUrl }, target) {
  return validateEsp32WorkerActionInitRequestForTarget({
    abi: ESP32_C3_WORKER_ABI,
    type: 'init',
    id,
    runtime: { descriptor, descriptorUrl },
  }, target);
}

function validateEsp32WorkerActionInitRequestForTarget(value, target) {
  const message = exactRecord(value, `${target.label} Worker Action init request`, [
    'abi', 'type', 'id', 'runtime',
  ]);
  if (message.abi !== ESP32_C3_WORKER_ABI || message.type !== 'init') {
    fail(`unsupported ${target.label} Worker Action init request`);
  }
  normalizeWorkerRequestId(message.id, `${target.label} Worker Action init`);
  const runtime = exactRecord(message.runtime, `${target.label} Worker Action runtime`, [
    'descriptor', 'descriptorUrl',
  ]);
  return Object.freeze({
    abi: ESP32_C3_WORKER_ABI,
    type: 'init',
    id: message.id,
    runtime: Object.freeze({
      descriptor: validateEsp32RuntimeDescriptorForTarget(runtime.descriptor, target),
      descriptorUrl: normalizeDescriptorUrl(runtime.descriptorUrl).href,
    }),
  });
}

/** Create one strictly checked CK Build IR Action request. */
export function createEsp32WorkerActionRequest({ id, action, inputs } = {}) {
  return validateEsp32WorkerActionRequest({
    abi: ESP32_C3_WORKER_ABI,
    type: 'action',
    id,
    action,
    inputs,
  });
}

/** Validate and clone one CK Build IR Action request and all of its input bytes. */
export function validateEsp32WorkerActionRequest(value) {
  const message = exactRecord(value, 'ESP32 Worker Action request', [
    'abi', 'type', 'id', 'action', 'inputs',
  ]);
  if (message.abi !== ESP32_C3_WORKER_ABI || message.type !== 'action') {
    fail('unsupported ESP32 Worker Action request');
  }
  normalizeWorkerRequestId(message.id, 'ESP32 Worker Action');
  const action = normalizeBuildAction(message.action);
  return Object.freeze({
    abi: ESP32_C3_WORKER_ABI,
    type: 'action',
    id: message.id,
    action,
    inputs: Object.freeze(normalizeActionFiles(message.inputs, action.inputs, 'input', MAX_ACTION_TOTAL_INPUT_BYTES)),
  });
}

/** Validate a response from an ESP32-C3 persistent Action session. */
export function validateEsp32C3WorkerActionResponse(value, context = {}) {
  return validateEsp32WorkerActionResponseForTarget(value, context, RUNTIME_TARGETS.c3);
}

export function validateEsp32C6WorkerActionResponse(value, context = {}) {
  return validateEsp32WorkerActionResponseForTarget(value, context, RUNTIME_TARGETS.c6);
}

export function validateEsp32H2WorkerActionResponse(value, context = {}) {
  return validateEsp32WorkerActionResponseForTarget(value, context, RUNTIME_TARGETS.h2);
}

export function validateEsp32C5WorkerActionResponse(value, context = {}) {
  return validateEsp32WorkerActionResponseForTarget(value, context, RUNTIME_TARGETS.c5);
}

export function validateEsp32P4WorkerActionResponse(value, context = {}) {
  return validateEsp32WorkerActionResponseForTarget(value, context, RUNTIME_TARGETS.p4);
}

export function validateEsp32WorkerActionResponse(value, context = {}) {
  return validateEsp32WorkerActionResponseForTarget(value, context, RUNTIME_TARGETS.esp32);
}

export function validateEsp32S2WorkerActionResponse(value, context = {}) {
  return validateEsp32WorkerActionResponseForTarget(value, context, RUNTIME_TARGETS.s2);
}

export function validateEsp32S3WorkerActionResponse(value, context = {}) {
  return validateEsp32WorkerActionResponseForTarget(value, context, RUNTIME_TARGETS.s3);
}

function validateEsp32WorkerActionResponseForTarget(value, context, target) {
  const response = recordWithOptionalKeys(
    value,
    `${target.label} Worker Action response`,
    ['abi', 'type', 'id'],
    ['ok', 'result', 'error', 'progress'],
  );
  if (response.abi !== ESP32_C3_WORKER_ABI) {
    fail(`${target.label} Worker Action response ABI is invalid`);
  }
  normalizeWorkerRequestId(response.id, `${target.label} Worker Action response`);
  if (response.type === 'action-progress') {
    if (Object.hasOwn(response, 'ok') || Object.hasOwn(response, 'result') || Object.hasOwn(response, 'error')) {
      fail(`${target.label} Worker Action progress response has unexpected fields`);
    }
    return Object.freeze({
      abi: ESP32_C3_WORKER_ABI,
      type: 'action-progress',
      id: response.id,
      progress: normalizeProgress(response.progress),
    });
  }

  if (!['init-result', 'action-result', 'close-result'].includes(response.type) || typeof response.ok !== 'boolean') {
    fail(`${target.label} Worker Action response type is invalid`);
  }
  if (!response.ok) {
    if (!Object.hasOwn(response, 'error') || Object.hasOwn(response, 'result') || Object.hasOwn(response, 'progress')) {
      fail(`${target.label} Worker Action error response has unexpected fields`);
    }
    return Object.freeze({
      abi: ESP32_C3_WORKER_ABI,
      type: response.type,
      id: response.id,
      ok: false,
      error: normalizeActionWorkerError(
        response.error,
        response.type === 'action-result' ? context.action : undefined,
      ),
    });
  }
  if (Object.hasOwn(response, 'error') || Object.hasOwn(response, 'progress')) {
    fail(`${target.label} Worker Action success response has unexpected fields`);
  }
  if (response.type !== 'action-result') {
    if (Object.hasOwn(response, 'result')) {
      fail(`${target.label} Worker ${response.type} response has unexpected fields`);
    }
    return Object.freeze({
      abi: ESP32_C3_WORKER_ABI,
      type: response.type,
      id: response.id,
      ok: true,
    });
  }
  if (!Object.hasOwn(response, 'result')) {
    fail(`${target.label} Worker Action success response has no result`);
  }
  const action = normalizeBuildAction(context.action);
  return Object.freeze({
    abi: ESP32_C3_WORKER_ABI,
    type: 'action-result',
    id: response.id,
    ok: true,
    result: normalizeActionResult(response.result, action),
  });
}

/**
 * Build a local Worker launcher. It is deliberately disabled by default, so
 * adding a descriptor cannot accidentally make a browser compilation claim.
 */
export function createEsp32C3WorkerLauncher(options = {}) {
  return createEsp32WorkerLauncherForTarget(options, Object.freeze({
    target: RUNTIME_TARGETS.c3,
    workerPath: '../v2/c3-worker.js',
  }));
}

export function createEsp32C6WorkerLauncher(options = {}) {
  return createEsp32WorkerLauncherForTarget(options, Object.freeze({
    target: RUNTIME_TARGETS.c6,
    workerPath: '../v2/c6-worker.js',
  }));
}

export function createEsp32WorkerLauncher(options = {}) {
  return createEsp32WorkerLauncherForTarget(options, Object.freeze({
    target: RUNTIME_TARGETS.esp32,
    workerPath: '../v2/esp32-worker.js',
  }));
}

export function createEsp32S2WorkerLauncher(options = {}) {
  return createEsp32WorkerLauncherForTarget(options, Object.freeze({
    target: RUNTIME_TARGETS.s2,
    workerPath: '../v2/s2-worker.js',
  }));
}

export function createEsp32S3WorkerLauncher(options = {}) {
  return createEsp32WorkerLauncherForTarget(options, Object.freeze({
    target: RUNTIME_TARGETS.s3,
    workerPath: '../v2/s3-worker.js',
  }));
}

function createEsp32WorkerLauncherForTarget({
  enabled = false,
  WorkerClass = globalThis.Worker,
  timeoutMs = ESP32_C3_WORKER_TIMEOUT_MS,
  navigatorRef = globalThis.navigator,
  performanceRef = globalThis.performance,
} = {}, launcherTarget) {
  const { target, workerPath } = launcherTarget;
  if (typeof enabled !== 'boolean') throw new TypeError(`${target.label} Worker enabled flag must be boolean`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10 * 60_000) {
    throw new TypeError(`${target.label} Worker timeout is invalid`);
  }
  let sequence = 0;

  return Object.freeze({
    enabled,
    openActionSession(input = {}) {
      if (!enabled) return Promise.reject(workerError('runtime_disabled', `${target.label} browser runtime is disabled`));
      const memoryEligibility = getEsp32C3BrowserMemoryEligibility({ navigatorRef, performanceRef });
      if (!memoryEligibility.eligible) {
        return Promise.reject(workerError(
          'resource_limit',
          `${target.label} browser compilation needs ${memoryEligibility.minimumHeapHeadroomBytes / (1024 * 1024)} MiB of available browser heap`,
        ));
      }
      if (typeof WorkerClass !== 'function') {
        return Promise.reject(workerError('worker_unavailable', `${target.label} browser Worker is unavailable`));
      }
      if (!isPlainRecord(input)) {
        return Promise.reject(new TypeError(`${target.label} Worker Action session input must be an object`));
      }

      let request;
      try {
        request = createEsp32WorkerActionInitRequestForTarget({ ...input, id: ++sequence }, target);
      } catch (error) {
        return Promise.reject(error);
      }
      try {
        return openWorkerActionSession({
          request,
          WorkerClass,
          timeoutMs,
          onProgress: input.onProgress,
          signal: input.signal,
          target,
          workerPath,
          nextRequestId: () => ++sequence,
        });
      } catch (error) {
        return Promise.reject(workerError('worker_create', errorMessage(error)));
      }
    },
  });
}

function browserHeapHeadroomBytes(performanceRef) {
  const memory = performanceRef?.memory;
  const limit = memory?.jsHeapSizeLimit;
  const used = memory?.usedJSHeapSize;
  if (
    !Number.isSafeInteger(limit)
    || !Number.isSafeInteger(used)
    || limit < 0
    || used < 0
  ) return null;
  return Math.max(0, limit - used);
}

/**
 * Create the Worker side of the persistent CK Action protocol. The injected
 * opener owns toolchain state; this handler owns ordering and wire validation.
 */
export function createEsp32C3WorkerActionMessageHandler(options = {}) {
  return createEsp32WorkerActionMessageHandlerForTarget(options, RUNTIME_TARGETS.c3);
}

export function createEsp32C6WorkerActionMessageHandler(options = {}) {
  return createEsp32WorkerActionMessageHandlerForTarget(options, RUNTIME_TARGETS.c6);
}

export function createEsp32H2WorkerActionMessageHandler(options = {}) {
  return createEsp32WorkerActionMessageHandlerForTarget(options, RUNTIME_TARGETS.h2);
}

export function createEsp32C5WorkerActionMessageHandler(options = {}) {
  return createEsp32WorkerActionMessageHandlerForTarget(options, RUNTIME_TARGETS.c5);
}

export function createEsp32P4WorkerActionMessageHandler(options = {}) {
  return createEsp32WorkerActionMessageHandlerForTarget(options, RUNTIME_TARGETS.p4);
}

export function createEsp32WorkerActionMessageHandler(options = {}) {
  return createEsp32WorkerActionMessageHandlerForTarget(options, RUNTIME_TARGETS.esp32);
}

export function createEsp32S2WorkerActionMessageHandler(options = {}) {
  return createEsp32WorkerActionMessageHandlerForTarget(options, RUNTIME_TARGETS.s2);
}

export function createEsp32S3WorkerActionMessageHandler(options = {}) {
  return createEsp32WorkerActionMessageHandlerForTarget(options, RUNTIME_TARGETS.s3);
}

function createEsp32WorkerActionMessageHandlerForTarget({
  openSession = unavailableActionSession,
  postMessage,
} = {}, target) {
  if (typeof openSession !== 'function') throw new TypeError(`${target.label} Worker Action opener must be a function`);
  if (typeof postMessage !== 'function') throw new TypeError(`${target.label} Worker postMessage must be a function`);

  let state = 'new';
  let session;
  let lastRequestId = 0;
  let active;

  const postFailure = (type, id, code, error, action) => {
    postMessage(actionErrorResponse(type, id, code, error, action));
  };

  return async (event) => {
    const raw = event?.data;
    const id = safeRequestId(raw);
    const type = typeof raw?.type === 'string' ? raw.type : '';

    if (type === 'cancel') {
      let request;
      try {
        request = validateActionControlRequest(raw, 'cancel');
      } catch (error) {
        if (id !== null) postFailure('action-result', id, 'invalid_request', error);
        return;
      }
      if (request.id <= lastRequestId) {
        postFailure('action-result', request.id, 'invalid_request', new Error('ESP32 Worker request ids must increase'));
        return;
      }
      lastRequestId = request.id;
      if (active?.id === request.requestId) active.controller.abort();
      return;
    }

    if (type === 'close') {
      let request;
      try {
        request = validateActionControlRequest(raw, 'close');
      } catch (error) {
        if (id !== null) postFailure('close-result', id, 'invalid_request', error);
        return;
      }
      if (request.id <= lastRequestId || state === 'new' || state === 'closed' || state === 'closing') {
        postFailure('close-result', request.id, 'invalid_state', new Error(`${target.label} Worker Action session cannot close now`));
        return;
      }
      lastRequestId = request.id;
      state = 'closing';
      active?.controller.abort();
      try {
        if (active?.promise) await active.promise.catch(() => {});
        await session?.close?.();
        state = 'closed';
        postMessage(actionSuccessResponse('close-result', request.id));
      } catch (error) {
        state = 'closed';
        postFailure('close-result', request.id, error?.code ?? 'internal', error);
      }
      return;
    }

    if (type === 'init') {
      let request;
      try {
        request = validateEsp32WorkerActionInitRequestForTarget(raw, target);
      } catch (error) {
        if (id !== null) postFailure('init-result', id, 'invalid_request', error);
        return;
      }
      if (request.id <= lastRequestId || state !== 'new') {
        postFailure('init-result', request.id, 'invalid_state', new Error(`${target.label} Worker Action session is already initialized`));
        return;
      }
      lastRequestId = request.id;
      state = 'initializing';
      try {
        const opened = await openSession(request);
        if (!opened || typeof opened.runAction !== 'function') {
          throw new TypeError(`${target.label} Worker Action opener returned an invalid session`);
        }
        if (opened.close !== undefined && typeof opened.close !== 'function') {
          throw new TypeError(`${target.label} Worker Action session close must be a function`);
        }
        session = opened;
        state = 'ready';
        postMessage(actionSuccessResponse('init-result', request.id));
      } catch (error) {
        state = 'closed';
        postFailure('init-result', request.id, error?.code ?? 'internal', error);
      }
      return;
    }

    if (type === 'action') {
      let request;
      try {
        request = validateEsp32WorkerActionRequest(raw);
      } catch (error) {
        if (id !== null) postFailure('action-result', id, 'invalid_request', error);
        return;
      }
      if (request.id <= lastRequestId || state !== 'ready') {
        postFailure('action-result', request.id, 'invalid_state', new Error(`${target.label} Worker Action session is not ready`));
        return;
      }
      lastRequestId = request.id;
      state = 'running';
      const controller = new AbortController();
      const inputs = new Map(request.inputs.map((input) => [input.path, input.bytes]));
      const execution = Promise.resolve().then(() => session.runAction(request.action, Object.freeze({
        signal: controller.signal,
        inputs,
        readFile(path) {
          const bytes = inputs.get(path);
          return bytes === undefined ? undefined : cloneActionBytes(bytes, `Action input ${path}`);
        },
      })));
      active = { id: request.id, controller, promise: execution };
      try {
        const outcome = await execution;
        if (isActionFailureOutcome(outcome)) {
          const failure = actionFailureFromOutcome(outcome, request.action);
          if (state === 'running' && active?.id === request.id) {
            state = 'ready';
            active = undefined;
            postFailure('action-result', request.id, failure.code, failure, request.action);
          }
          return;
        }
        const result = normalizeActionResult(outcome, request.action);
        if (state === 'running' && active?.id === request.id) {
          state = 'ready';
          active = undefined;
          const response = {
            abi: ESP32_C3_WORKER_ABI,
            type: 'action-result',
            id: request.id,
            ok: true,
            result,
          };
          postMessage(response, transferListForActionResult(result));
        }
      } catch (error) {
        if (state === 'running' && active?.id === request.id) {
          state = 'ready';
          active = undefined;
          postFailure(
            'action-result',
            request.id,
            error?.code ?? (controller.signal.aborted ? 'aborted' : 'internal'),
            error,
            request.action,
          );
        }
      }
      return;
    }

    if (id !== null) postFailure('action-result', id, 'invalid_request', new Error('unsupported ESP32 Worker Action request'));
  };
}

function exactRecord(value, label, keys) {
  return recordWithOptionalKeys(value, label, keys, []);
}

function recordWithOptionalKeys(value, label, requiredKeys, optionalKeys) {
  if (!isPlainRecord(value)) fail(`${label} must be an object`);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actualKeys = Object.keys(value);
  if (actualKeys.some((key) => !allowed.has(key)) || requiredKeys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} has an invalid shape`);
  }
  return value;
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeWorkerRequestId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} request id is invalid`);
  return value;
}

function normalizeBuildAction(value) {
  if (!isPlainRecord(value) || !ACTION_KINDS.has(value.kind)) fail('ESP32 Worker Build Action is invalid');
  const taskKey = `${value.kind === 'compile' ? 'compileUnit' : value.kind}`;
  const action = recordWithOptionalKeys(value, 'ESP32 Worker Build Action', [
    'id', 'kind', 'tool', 'inputs', 'outputs', 'arguments', 'environment',
    'dependencies', 'packDependencies', 'cacheKey', taskKey,
  ], ['packInputs', 'resourceLimits']);
  const id = normalizeBoundedText(action.id, 'ESP32 Worker Build Action id', MAX_ACTION_ID_CHARS);
  const tool = normalizeBoundedText(action.tool, 'ESP32 Worker Build Action tool', MAX_ACTION_TOOL_CHARS);
  if (!SHA256.test(action.cacheKey)) fail(`ESP32 Worker Build Action ${id} cache key is invalid`);
  if (!Array.isArray(action.inputs) || action.inputs.length > MAX_ACTION_INPUTS) {
    fail(`ESP32 Worker Build Action ${id} inputs are invalid`);
  }
  if (!Array.isArray(action.outputs) || action.outputs.length > MAX_ACTION_OUTPUTS) {
    fail(`ESP32 Worker Build Action ${id} outputs are invalid`);
  }
  const inputPaths = new Set();
  const inputs = action.inputs.map((valueInput) => {
    const input = recordWithOptionalKeys(valueInput, `ESP32 Worker Build Action ${id} input`, ['path'], ['sha256', 'role']);
    const path = normalizeLogicalPath(input.path, `ESP32 Worker Build Action ${id} input path`);
    if (inputPaths.has(path)) fail(`ESP32 Worker Build Action ${id} input is duplicated: ${path}`);
    inputPaths.add(path);
    if (input.sha256 !== undefined && !SHA256.test(input.sha256)) {
      fail(`ESP32 Worker Build Action ${id} input hash is invalid`);
    }
    if (input.role !== undefined) normalizeBoundedText(input.role, `ESP32 Worker Build Action ${id} input role`, 128);
    return Object.freeze({
      path,
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      ...(input.role === undefined ? {} : { role: input.role }),
    });
  });
  const outputPaths = new Set();
  const outputs = action.outputs.map((valueOutput) => {
    const output = recordWithOptionalKeys(valueOutput, `ESP32 Worker Build Action ${id} output`, ['path'], ['kind', 'sha256']);
    const path = normalizeLogicalPath(output.path, `ESP32 Worker Build Action ${id} output path`);
    if (outputPaths.has(path)) fail(`ESP32 Worker Build Action ${id} output is duplicated: ${path}`);
    outputPaths.add(path);
    if (inputPaths.has(path)) fail(`ESP32 Worker Build Action ${id} output overwrites an input: ${path}`);
    if (output.kind !== undefined) normalizeBoundedText(output.kind, `ESP32 Worker Build Action ${id} output kind`, 128);
    if (output.sha256 !== undefined && !SHA256.test(output.sha256)) {
      fail(`ESP32 Worker Build Action ${id} output hash is invalid`);
    }
    return Object.freeze({
      path,
      ...(output.kind === undefined ? {} : { kind: output.kind }),
      ...(output.sha256 === undefined ? {} : { sha256: output.sha256 }),
    });
  });
  const args = normalizeBoundedStringArray(
    action.arguments,
    `ESP32 Worker Build Action ${id} arguments`,
    MAX_ACTION_ARGUMENTS,
    MAX_ACTION_ARGUMENT_CHARS,
  );
  const environment = normalizeActionEnvironment(action.environment, id);
  const dependencies = normalizeUniqueStringArray(
    action.dependencies,
    `ESP32 Worker Build Action ${id} dependencies`,
    MAX_ACTION_DEPENDENCIES,
    MAX_ACTION_ID_CHARS,
  );
  const packDependencies = normalizeUniqueStringArray(
    action.packDependencies,
    `ESP32 Worker Build Action ${id} Pack dependencies`,
    MAX_ACTION_DEPENDENCIES,
    MAX_ACTION_ID_CHARS,
  );
  const packInputs = action.packInputs === undefined
    ? undefined
    : normalizeActionPackInputs(action.packInputs, id);
  const resourceLimits = action.resourceLimits === undefined
    ? undefined
    : normalizeActionResourceLimits(action.resourceLimits, id);
  const task = normalizeActionTask(action.kind, action[taskKey], id, inputPaths, outputPaths);
  return Object.freeze({
    id,
    kind: action.kind,
    tool,
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
    arguments: Object.freeze(args),
    environment,
    dependencies: Object.freeze(dependencies),
    packDependencies: Object.freeze(packDependencies),
    ...(packInputs === undefined ? {} : { packInputs: Object.freeze(packInputs) }),
    cacheKey: action.cacheKey,
    [taskKey]: task,
    ...(resourceLimits === undefined ? {} : { resourceLimits }),
  });
}

function normalizeActionPackInputs(value, id) {
  if (!Array.isArray(value) || value.length > MAX_ACTION_DEPENDENCIES) {
    fail(`ESP32 Worker Build Action ${id} Pack inputs are invalid`);
  }
  const identities = new Set();
  return value.map((valueInput) => {
    const input = recordWithOptionalKeys(
      valueInput,
      `ESP32 Worker Build Action ${id} Pack input`,
      ['kind', 'packId', 'packRevision', 'packSchema', 'artifactId', 'sha256'],
      ['role'],
    );
    if (input.kind !== 'pack-artifact') {
      fail(`ESP32 Worker Build Action ${id} Pack input kind is invalid`);
    }
    const packId = normalizeBoundedText(input.packId, `ESP32 Worker Build Action ${id} Pack id`, MAX_ACTION_ID_CHARS);
    const artifactId = normalizeBoundedText(input.artifactId, `ESP32 Worker Build Action ${id} Pack artifact id`, MAX_ACTION_ID_CHARS);
    if (!SHA256.test(input.packRevision) || !SHA256.test(input.sha256)) {
      fail(`ESP32 Worker Build Action ${id} Pack input hash is invalid`);
    }
    if (!Number.isSafeInteger(input.packSchema) || input.packSchema < 1) {
      fail(`ESP32 Worker Build Action ${id} Pack input schema is invalid`);
    }
    const role = input.role === undefined
      ? undefined
      : normalizeBoundedText(input.role, `ESP32 Worker Build Action ${id} Pack input role`, 128);
    const identity = `${packId}\0${artifactId}\0${role ?? ''}`;
    if (identities.has(identity)) fail(`ESP32 Worker Build Action ${id} Pack input is duplicated`);
    identities.add(identity);
    return Object.freeze({
      kind: 'pack-artifact',
      packId,
      packRevision: input.packRevision,
      packSchema: input.packSchema,
      artifactId,
      sha256: input.sha256,
      ...(role === undefined ? {} : { role }),
    });
  });
}

function normalizeActionTask(kind, value, id, inputPaths, outputPaths) {
  if (kind === 'compile') {
    const unit = exactRecord(value, `ESP32 Worker Build Action ${id} compile unit`, [
      'language', 'source', 'output', 'macros', 'includePaths', 'flags',
    ]);
    if (!ACTION_LANGUAGES.has(unit.language)) fail(`ESP32 Worker Build Action ${id} language is invalid`);
    const source = normalizeLogicalPath(unit.source, `ESP32 Worker Build Action ${id} source`);
    const output = normalizeLogicalPath(unit.output, `ESP32 Worker Build Action ${id} output`);
    if (!inputPaths.has(source) || !outputPaths.has(output)) fail(`ESP32 Worker Build Action ${id} compile paths are invalid`);
    if (!isPlainRecord(unit.macros) || Object.keys(unit.macros).length > MAX_ACTION_ENVIRONMENT) {
      fail(`ESP32 Worker Build Action ${id} macros are invalid`);
    }
    const macros = {};
    for (const [key, macroValue] of Object.entries(unit.macros)) {
      normalizeBoundedText(key, `ESP32 Worker Build Action ${id} macro name`, 256);
      if (typeof macroValue !== 'boolean' && typeof macroValue !== 'string') {
        fail(`ESP32 Worker Build Action ${id} macro value is invalid`);
      }
      if (typeof macroValue === 'string') normalizeBoundedString(macroValue, `ESP32 Worker Build Action ${id} macro value`, MAX_ACTION_ARGUMENT_CHARS);
      macros[key] = macroValue;
    }
    const includePaths = normalizeBoundedStringArray(unit.includePaths, `ESP32 Worker Build Action ${id} include paths`, MAX_ACTION_ARGUMENTS, 1024)
      .map((path) => normalizeLogicalPath(path, `ESP32 Worker Build Action ${id} include path`));
    const flags = normalizeBoundedStringArray(unit.flags, `ESP32 Worker Build Action ${id} flags`, MAX_ACTION_ARGUMENTS, MAX_ACTION_ARGUMENT_CHARS);
    return Object.freeze({
      language: unit.language,
      source,
      output,
      macros: Object.freeze(macros),
      includePaths: Object.freeze(includePaths),
      flags: Object.freeze(flags),
    });
  }
  if (kind === 'archive') {
    const archive = exactRecord(value, `ESP32 Worker Build Action ${id} archive task`, ['objects', 'output', 'flags']);
    const objects = normalizeActionTaskPaths(archive.objects, inputPaths, id, 'archive object');
    const output = normalizeLogicalPath(archive.output, `ESP32 Worker Build Action ${id} archive output`);
    if (!outputPaths.has(output)) fail(`ESP32 Worker Build Action ${id} archive output is undeclared`);
    return Object.freeze({
      objects: Object.freeze(objects),
      output,
      flags: Object.freeze(normalizeBoundedStringArray(archive.flags, `ESP32 Worker Build Action ${id} archive flags`, MAX_ACTION_ARGUMENTS, MAX_ACTION_ARGUMENT_CHARS)),
    });
  }
  if (kind === 'link') {
    const link = recordWithOptionalKeys(value, `ESP32 Worker Build Action ${id} link task`, [
      'objects', 'archives', 'output', 'flags',
    ], ['linkerScript']);
    const objects = normalizeActionTaskPaths(link.objects, inputPaths, id, 'link object');
    const archives = normalizeActionTaskPaths(link.archives, inputPaths, id, 'link archive');
    const output = normalizeLogicalPath(link.output, `ESP32 Worker Build Action ${id} link output`);
    if (!outputPaths.has(output)) fail(`ESP32 Worker Build Action ${id} link output is undeclared`);
    let linkerScript;
    if (link.linkerScript !== undefined) {
      linkerScript = normalizeLogicalPath(link.linkerScript, `ESP32 Worker Build Action ${id} linker script`);
      if (!inputPaths.has(linkerScript)) fail(`ESP32 Worker Build Action ${id} linker script is undeclared`);
    }
    return Object.freeze({
      objects: Object.freeze(objects),
      archives: Object.freeze(archives),
      output,
      ...(linkerScript === undefined ? {} : { linkerScript }),
      flags: Object.freeze(normalizeBoundedStringArray(link.flags, `ESP32 Worker Build Action ${id} link flags`, MAX_ACTION_ARGUMENTS, MAX_ACTION_ARGUMENT_CHARS)),
    });
  }
  const transform = exactRecord(value, `ESP32 Worker Build Action ${id} transform task`, [
    'input', 'output', 'format', 'flags',
  ]);
  const input = normalizeLogicalPath(transform.input, `ESP32 Worker Build Action ${id} transform input`);
  const output = normalizeLogicalPath(transform.output, `ESP32 Worker Build Action ${id} transform output`);
  if (!inputPaths.has(input) || !outputPaths.has(output) || !ACTION_TRANSFORM_FORMATS.has(transform.format)) {
    fail(`ESP32 Worker Build Action ${id} transform task is invalid`);
  }
  return Object.freeze({
    input,
    output,
    format: transform.format,
    flags: Object.freeze(normalizeBoundedStringArray(transform.flags, `ESP32 Worker Build Action ${id} transform flags`, MAX_ACTION_ARGUMENTS, MAX_ACTION_ARGUMENT_CHARS)),
  });
}

function normalizeActionTaskPaths(value, inputPaths, id, label) {
  const paths = normalizeBoundedStringArray(value, `ESP32 Worker Build Action ${id} ${label}s`, MAX_ACTION_INPUTS, 1024)
    .map((path) => normalizeLogicalPath(path, `ESP32 Worker Build Action ${id} ${label}`));
  if (paths.some((path) => !inputPaths.has(path))) fail(`ESP32 Worker Build Action ${id} ${label} is undeclared`);
  return paths;
}

function normalizeActionResourceLimits(value, id) {
  const limits = recordWithOptionalKeys(value, `ESP32 Worker Build Action ${id} resource limits`, [], [
    'cpuMs', 'memoryBytes', 'outputBytes',
  ]);
  const normalized = {};
  for (const [key, amount] of Object.entries(limits)) {
    if (!Number.isSafeInteger(amount) || amount <= 0) fail(`ESP32 Worker Build Action ${id} ${key} limit is invalid`);
    normalized[key] = amount;
  }
  return Object.freeze(normalized);
}

function normalizeActionEnvironment(value, id) {
  if (!isPlainRecord(value) || Object.keys(value).length > MAX_ACTION_ENVIRONMENT) {
    fail(`ESP32 Worker Build Action ${id} environment is invalid`);
  }
  const environment = {};
  for (const [key, entry] of Object.entries(value)) {
    normalizeBoundedText(key, `ESP32 Worker Build Action ${id} environment name`, 256);
    normalizeBoundedString(entry, `ESP32 Worker Build Action ${id} environment value`, MAX_ACTION_ARGUMENT_CHARS);
    environment[key] = entry;
  }
  return Object.freeze(environment);
}

function normalizeUniqueStringArray(value, label, maxItems, maxChars) {
  const values = normalizeBoundedStringArray(value, label, maxItems, maxChars);
  if (new Set(values).size !== values.length) fail(`${label} contain duplicates`);
  return values;
}

function normalizeBoundedStringArray(value, label, maxItems, maxChars) {
  if (!Array.isArray(value) || value.length > maxItems) fail(`${label} are invalid`);
  return value.map((entry) => normalizeBoundedString(entry, label, maxChars));
}

function normalizeBoundedText(value, label, maxChars) {
  if (typeof value !== 'string' || !value || value.length > maxChars || value.includes('\0')) fail(`${label} is invalid`);
  return value;
}

function normalizeBoundedString(value, label, maxChars) {
  if (typeof value !== 'string' || value.length > maxChars || value.includes('\0')) fail(`${label} is invalid`);
  return value;
}

function normalizeLogicalPath(value, label) {
  if (
    typeof value !== 'string'
    || !value
    || value.length > 1024
    || value.includes('\\')
    || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)
    || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) fail(`${label} is invalid`);
  return value;
}

function normalizeActionFiles(value, declarations, direction, totalLimit) {
  if (!Array.isArray(value) || value.length !== declarations.length) {
    fail(`ESP32 Worker Action ${direction}s have an invalid count`);
  }
  let totalBytes = 0;
  return value.map((valueFile, index) => {
    const file = exactRecord(valueFile, `ESP32 Worker Action ${direction}`, ['path', 'bytes']);
    if (file.path !== declarations[index].path) {
      fail(`ESP32 Worker Action ${direction} ${index} has an unexpected path`);
    }
    const bytes = cloneActionBytes(file.bytes, `ESP32 Worker Action ${direction} ${file.path}`);
    if (bytes.byteLength > MAX_ACTION_FILE_BYTES) fail(`ESP32 Worker Action ${direction} ${file.path} exceeds its size limit`);
    totalBytes += bytes.byteLength;
    if (totalBytes > totalLimit) fail(`ESP32 Worker Action ${direction}s exceed the total size limit`);
    return Object.freeze({ path: file.path, bytes });
  });
}

function normalizeActionResult(value, action) {
  const result = recordWithOptionalKeys(value, `ESP32 Worker Action ${action.id} result`, [
    'outputs',
  ], ['diagnostics', 'cacheable']);
  if (result.cacheable !== undefined && typeof result.cacheable !== 'boolean') {
    fail(`ESP32 Worker Action ${action.id} cacheable flag is invalid`);
  }
  return Object.freeze({
    outputs: Object.freeze(normalizeActionFiles(result.outputs, action.outputs, 'output', MAX_ACTION_TOTAL_OUTPUT_BYTES)),
    diagnostics: Object.freeze(normalizeActionDiagnostics(result.diagnostics ?? [], action.id)),
    ...(result.cacheable === undefined ? {} : { cacheable: result.cacheable }),
  });
}

function isActionFailureOutcome(value) {
  return isPlainRecord(value) && (value.ok === false || value.status === 'error');
}

function actionFailureFromOutcome(value, action) {
  const failure = recordWithOptionalKeys(value, `ESP32 Worker Action ${action.id} failure`, ['message'], [
    'ok', 'status', 'code', 'reason', 'diagnostics',
  ]);
  if (
    (failure.ok !== undefined && failure.ok !== false)
    || (failure.status !== undefined && failure.status !== 'error')
    || (failure.ok === undefined && failure.status === undefined)
  ) fail(`ESP32 Worker Action ${action.id} failure status is invalid`);
  const code = failure.code ?? 'action_failed';
  const normalized = normalizeActionWorkerError({
    code,
    message: failure.message,
    ...(failure.reason === undefined ? {} : { reason: failure.reason }),
    diagnostics: failure.diagnostics ?? [],
  }, action);
  const error = workerError(normalized.code, normalized.message);
  error.reason = normalized.reason;
  error.diagnostics = normalized.diagnostics;
  return error;
}

function normalizeActionDiagnostics(value, actionId) {
  if (!Array.isArray(value) || value.length > MAX_ACTION_DIAGNOSTICS) {
    fail(`ESP32 Worker Action ${actionId} diagnostics are invalid`);
  }
  return value.map((valueDiagnostic) => {
    const diagnostic = recordWithOptionalKeys(valueDiagnostic, `ESP32 Worker Action ${actionId} diagnostic`, [
      'severity', 'file', 'line', 'message',
    ], ['column', 'raw', 'fromGenerated', 'unmapped']);
    if (!DIAGNOSTIC_SEVERITIES.has(diagnostic.severity)) fail(`ESP32 Worker Action ${actionId} diagnostic severity is invalid`);
    const file = normalizeLogicalPath(diagnostic.file, `ESP32 Worker Action ${actionId} diagnostic file`);
    if (!Number.isSafeInteger(diagnostic.line) || diagnostic.line < 1) fail(`ESP32 Worker Action ${actionId} diagnostic line is invalid`);
    if (diagnostic.column !== undefined && (!Number.isSafeInteger(diagnostic.column) || diagnostic.column < 1)) {
      fail(`ESP32 Worker Action ${actionId} diagnostic column is invalid`);
    }
    normalizeBoundedText(diagnostic.message, `ESP32 Worker Action ${actionId} diagnostic message`, MAX_DIAGNOSTIC_MESSAGE_CHARS);
    if (diagnostic.raw !== undefined) normalizeBoundedString(diagnostic.raw, `ESP32 Worker Action ${actionId} raw diagnostic`, MAX_DIAGNOSTIC_MESSAGE_CHARS);
    if (diagnostic.fromGenerated !== undefined && typeof diagnostic.fromGenerated !== 'boolean') {
      fail(`ESP32 Worker Action ${actionId} generated diagnostic flag is invalid`);
    }
    if (diagnostic.unmapped !== undefined && typeof diagnostic.unmapped !== 'boolean') {
      fail(`ESP32 Worker Action ${actionId} unmapped diagnostic flag is invalid`);
    }
    return Object.freeze({
      severity: diagnostic.severity,
      file,
      line: diagnostic.line,
      message: diagnostic.message,
      ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
      ...(diagnostic.raw === undefined ? {} : { raw: diagnostic.raw }),
      ...(diagnostic.fromGenerated === undefined ? {} : { fromGenerated: diagnostic.fromGenerated }),
      ...(diagnostic.unmapped === undefined ? {} : { unmapped: diagnostic.unmapped }),
    });
  });
}

function cloneActionBytes(value, label) {
  let source;
  if (value instanceof Uint8Array) source = value;
  else if (value instanceof ArrayBuffer) source = new Uint8Array(value);
  else fail(`${label} bytes are invalid`);
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return bytes;
}

function validateActionControlRequest(value, type) {
  const request = exactRecord(value, `ESP32 Worker Action ${type} request`, [
    'abi', 'type', 'id', ...(type === 'cancel' ? ['requestId'] : []),
  ]);
  if (request.abi !== ESP32_C3_WORKER_ABI || request.type !== type) {
    fail(`unsupported ESP32 Worker Action ${type} request`);
  }
  normalizeWorkerRequestId(request.id, `ESP32 Worker Action ${type}`);
  if (type === 'cancel') normalizeWorkerRequestId(request.requestId, 'ESP32 Worker Action cancel target');
  return Object.freeze({
    abi: ESP32_C3_WORKER_ABI,
    type,
    id: request.id,
    ...(type === 'cancel' ? { requestId: request.requestId } : {}),
  });
}

function isSafeManifestPath(value, pack) {
  if (typeof value !== 'string') return false;
  if (value === sharedPackManifestPath(pack)) return true;
  if (!SAFE_MANIFEST_PATH.test(value)) return false;
  return !value.split('/').some((segment) => segment === '.' || segment === '..' || !segment);
}

function sharedPackManifestPath(pack) {
  return pack?.role === 'compiler'
    ? sharedCompilerManifestPath(pack)
    : sharedRuntimePackManifestPath(pack);
}

function sharedCompilerManifestPath(pack) {
  if (
    pack?.role !== 'compiler'
    || typeof pack.id !== 'string'
    || !IDENTIFIER.test(pack.id)
    || typeof pack.revision !== 'string'
    || !SHA256.test(pack.revision)
  ) return null;
  return `../toolchains/${pack.id}/${pack.revision}/toolchain.json`;
}

function sharedRuntimePackManifestPath(pack) {
  if (
    !['sdk', 'board'].includes(pack?.role)
    || typeof pack.id !== 'string'
    || !IDENTIFIER.test(pack.id)
    || typeof pack.revision !== 'string'
    || !SHA256.test(pack.revision)
  ) return null;
  return `../packs/${pack.id}/${pack.revision}/toolchain.json`;
}

function normalizeDescriptorUrl(value) {
  if (typeof value !== 'string' && !(value instanceof URL)) {
    throw new TypeError('ESP32-C3 runtime descriptor URL is required');
  }
  const fallback = globalThis.location?.href ?? import.meta.url;
  const pageUrl = new URL(fallback);
  const url = new URL(value, fallback);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('ESP32-C3 runtime descriptor URL cannot contain credentials, query, or fragment');
  }
  if (!['https:', 'http:', 'file:'].includes(url.protocol)) {
    throw new Error('ESP32-C3 runtime descriptor URL has an unsupported protocol');
  }
  if (url.protocol === 'http:' && url.origin !== pageUrl.origin) {
    throw new Error('external ESP32-C3 runtime descriptor URL must use HTTPS');
  }
  if (url.protocol === 'file:' && pageUrl.protocol !== 'file:') {
    throw new Error('ESP32-C3 runtime descriptor URL must use HTTPS');
  }
  return url;
}

function normalizeProgress(value) {
  const progress = recordWithOptionalKeys(value, 'ESP32-C3 Worker progress', ['stage', 'percent'], ['detail']);
  if (!PROGRESS_STAGES.has(progress.stage)) fail('ESP32-C3 Worker progress stage is invalid');
  if (typeof progress.percent !== 'number' || !Number.isFinite(progress.percent) || progress.percent < 0 || progress.percent > 100) {
    fail('ESP32-C3 Worker progress percent is invalid');
  }
  if (progress.detail !== undefined && (typeof progress.detail !== 'string' || progress.detail.length > 512)) {
    fail('ESP32-C3 Worker progress detail is invalid');
  }
  return Object.freeze({
    stage: progress.stage,
    percent: progress.percent,
    ...(progress.detail === undefined ? {} : { detail: progress.detail }),
  });
}

function normalizeActionWorkerError(value, action) {
  const error = recordWithOptionalKeys(value, 'ESP32 Worker Action error', ['code', 'message'], ['reason', 'diagnostics']);
  if (typeof error.code !== 'string' || !SAFE_ERROR_CODE.test(error.code)) {
    fail('ESP32 Worker Action error code is invalid');
  }
  if (typeof error.message !== 'string' || !error.message || error.message.length > 1024) {
    fail('ESP32 Worker Action error message is invalid');
  }
  const reason = normalizeActionFailureReason(error.reason, error.code);
  const diagnostics = error.diagnostics === undefined
    ? []
    : normalizeActionDiagnostics(error.diagnostics, action?.id ?? 'session');
  return Object.freeze({
    code: error.code,
    message: error.message,
    reason,
    diagnostics: Object.freeze(diagnostics),
  });
}

function normalizeActionFailureReason(value, code = '') {
  const aliases = {
    compile_error: 'compile',
    preprocess_error: 'compile',
    runtime_not_installed: 'tool',
    worker_error: 'tool',
    worker_post: 'tool',
    worker_protocol: 'internal',
    invalid_request: 'integrity',
    invalid_state: 'internal',
  };
  if (value !== undefined) {
    if (typeof value === 'string' && ACTION_FAILURE_REASONS.has(value)) return value;
    if (typeof value === 'string' && Object.hasOwn(aliases, value)) return aliases[value];
    fail('ESP32 Worker Action error reason is invalid');
  }
  if (ACTION_FAILURE_REASONS.has(code)) return code;
  if (Object.hasOwn(aliases, code)) return aliases[code];
  return 'compile';
}

function safeRequestId(value) {
  return Number.isSafeInteger(value?.id) && value.id >= 1 ? value.id : null;
}

function actionSuccessResponse(type, id) {
  return { abi: ESP32_C3_WORKER_ABI, type, id, ok: true };
}

function actionErrorResponse(type, id, code, error, action) {
  const normalizedCode = typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : 'internal';
  let payload = { code: normalizedCode, message: errorMessage(error) };
  if (type === 'action-result') {
    try {
      payload = normalizeActionWorkerError({
        ...payload,
        ...(error?.reason === undefined ? {} : { reason: error.reason }),
        diagnostics: error?.diagnostics ?? [],
      }, action);
    } catch (normalizationError) {
      payload = Object.freeze({
        code: 'internal',
        message: errorMessage(normalizationError),
        reason: 'internal',
        diagnostics: Object.freeze([]),
      });
    }
  }
  return {
    abi: ESP32_C3_WORKER_ABI,
    type,
    id,
    ok: false,
    error: payload,
  };
}

function transferListForActionResult(result) {
  return result.outputs.map((output) => output.bytes.buffer);
}

async function unavailableActionSession() {
  throw workerError('runtime_not_installed', 'ESP32 browser Action runtime is not installed');
}

function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorMessage(error) {
  const value = String(error?.message ?? error ?? 'ESP32-C3 Worker failed').trim();
  return (value || 'ESP32-C3 Worker failed').slice(0, 1024);
}

async function openWorkerActionSession({
  request,
  WorkerClass,
  timeoutMs,
  onProgress,
  signal,
  target,
  workerPath,
  nextRequestId,
}) {
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new TypeError(`${target.label} Worker Action progress callback must be a function`);
  }
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TypeError(`${target.label} Worker Action signal is invalid`);
  }
  if (signal?.aborted) throw workerError('aborted', `${target.label} Worker Action session was aborted`);

  let worker;
  try {
    worker = new WorkerClass(new URL(workerPath, import.meta.url), { type: 'module' });
  } catch (error) {
    throw workerError('worker_create', errorMessage(error));
  }
  if (!worker || typeof worker.addEventListener !== 'function' || typeof worker.postMessage !== 'function') {
    try { worker?.terminate?.(); } catch { /* Best-effort cleanup. */ }
    throw workerError('worker_create', `${target.label} Worker does not implement the Action transport`);
  }
  let state = 'opening';
  let accepting = true;
  let pending;
  let queue = Promise.resolve();
  let closePromise;
  let queuedActions = 0;
  let sessionAbortListener;

  const terminate = () => {
    if (state === 'closed') return;
    state = 'closed';
    accepting = false;
    if (sessionAbortListener) signal?.removeEventListener?.('abort', sessionAbortListener);
    try { worker.terminate?.(); } catch { /* Best-effort cleanup. */ }
  };

  const clearPending = () => {
    if (!pending) return undefined;
    const operation = pending;
    pending = undefined;
    clearTimeout(operation.timeout);
    operation.signal?.removeEventListener?.('abort', operation.abortListener);
    return operation;
  };

  const failSession = (error) => {
    const operation = clearPending();
    terminate();
    operation?.reject(error);
  };

  const postCancel = (requestId) => {
    try {
      worker.postMessage({
        abi: ESP32_C3_WORKER_ABI,
        type: 'cancel',
        id: nextRequestId(),
        requestId,
      });
    } catch { /* Worker termination remains the cancellation boundary. */ }
  };

  const cancel = (message = `${target.label} Worker Action session was aborted`) => {
    if (state === 'closed') return;
    if (pending) postCancel(pending.id);
    failSession(workerError('aborted', message));
  };

  const send = (outgoing, expectedType, context, transfer = [], requestSignal, progressCallback) => {
    if (state === 'closed') return Promise.reject(workerError('session_closed', `${target.label} Worker Action session is closed`));
    if (pending) return Promise.reject(workerError('worker_protocol', `${target.label} Worker Action requests must be sequential`));
    if (requestSignal !== undefined && !isAbortSignal(requestSignal)) {
      return Promise.reject(new TypeError(`${target.label} Worker Action signal is invalid`));
    }
    if (requestSignal?.aborted) {
      cancel(`${target.label} Worker Action request was aborted`);
      return Promise.reject(workerError('aborted', `${target.label} Worker Action request was aborted`));
    }
    return new Promise((resolve, reject) => {
      const abortListener = () => {
        if (pending?.id !== outgoing.id) return;
        postCancel(outgoing.id);
        failSession(workerError('aborted', `${target.label} Worker Action request was aborted`));
      };
      const timeout = setTimeout(() => {
        if (pending?.id !== outgoing.id) return;
        postCancel(outgoing.id);
        failSession(workerError('timeout', `${target.label} Worker ${outgoing.type} request exceeded ${timeoutMs} ms`));
      }, timeoutMs);
      pending = {
        id: outgoing.id,
        expectedType,
        context,
        resolve,
        reject,
        timeout,
        signal: requestSignal,
        abortListener,
        onProgress: progressCallback,
      };
      requestSignal?.addEventListener?.('abort', abortListener, { once: true });
      try {
        worker.postMessage(outgoing, transfer);
      } catch (error) {
        failSession(workerError('worker_post', errorMessage(error)));
      }
    });
  };

  worker.addEventListener('message', (event) => {
    const operation = pending;
    if (!operation) {
      failSession(workerError('worker_protocol', `${target.label} Worker sent an unsolicited Action response`));
      return;
    }
    let response;
    try {
      response = validateEsp32WorkerActionResponseForTarget(event.data, operation.context, target);
    } catch (error) {
      failSession(workerError('worker_protocol', errorMessage(error)));
      return;
    }
    if (response.id !== operation.id) {
      failSession(workerError('worker_protocol', `${target.label} Worker Action response id is out of sequence`));
      return;
    }
    if (response.type === 'action-progress') {
      const callback = operation.onProgress ?? onProgress;
      if (typeof callback === 'function') {
        try { callback(response.progress); } catch { /* Progress cannot break execution. */ }
      }
      return;
    }
    if (response.type !== operation.expectedType) {
      failSession(workerError('worker_protocol', `${target.label} Worker Action response type is out of sequence`));
      return;
    }
    clearPending();
    if (!response.ok) {
      if (response.type === 'action-result' && response.error.reason) {
        const error = workerError(response.error.code, response.error.message);
        error.reason = response.error.reason;
        error.diagnostics = response.error.diagnostics;
        operation.resolve({
          ok: false,
          status: 'error',
          code: response.error.code,
          reason: response.error.reason,
          message: response.error.message,
          diagnostics: response.error.diagnostics,
          error,
        });
      } else {
        operation.reject(workerError(response.error.code, response.error.message));
      }
    } else operation.resolve(response.type === 'action-result' ? response.result : undefined);
  });
  worker.addEventListener('error', (event) => {
    failSession(workerError('worker_error', event?.message || `${target.label} Worker failed`));
  });

  try {
    await send(request, 'init-result', {}, [], signal, onProgress);
  } catch (error) {
    terminate();
    throw error;
  }
  if (signal?.aborted) {
    terminate();
    throw workerError('aborted', `${target.label} Worker Action session was aborted`);
  }
  state = 'open';
  if (signal) {
    sessionAbortListener = () => cancel(`${target.label} Worker Action session was aborted`);
    signal.addEventListener('abort', sessionAbortListener, { once: true });
  }

  const runAction = (actionValue, context = {}) => {
    if (!accepting || state === 'closed') {
      return Promise.reject(workerError('session_closed', `${target.label} Worker Action session is closed`));
    }
    let action;
    try {
      action = normalizeBuildAction(actionValue);
    } catch (error) {
      return Promise.reject(error);
    }
    if (context?.onProgress !== undefined && typeof context.onProgress !== 'function') {
      return Promise.reject(new TypeError(`${target.label} Worker Action progress callback must be a function`));
    }
    queuedActions += 1;
    const operation = queue.then(async () => {
      if (state !== 'open') throw workerError('session_closed', `${target.label} Worker Action session is closed`);
      const inputs = await actionInputsFromContext(action, context);
      const actionRequest = createEsp32WorkerActionRequest({ id: nextRequestId(), action, inputs });
      const transfer = actionRequest.inputs.map((input) => input.bytes.buffer);
      return send(
        actionRequest,
        'action-result',
        { action },
        transfer,
        context?.signal,
        context?.onProgress,
      );
    });
    const tracked = operation.finally(() => { queuedActions -= 1; });
    queue = tracked.catch(() => {});
    return tracked;
  };

  const close = () => {
    if (closePromise) return closePromise;
    if (state === 'closed') return Promise.resolve();
    accepting = false;
    if (queuedActions > 0 || pending?.expectedType === 'action-result') {
      if (pending) postCancel(pending.id);
      failSession(workerError('session_closed', `${target.label} Worker Action session was closed`));
      closePromise = Promise.resolve();
      return closePromise;
    }
    closePromise = queue.then(async () => {
      if (state === 'closed') return;
      state = 'closing';
      const closeRequest = {
        abi: ESP32_C3_WORKER_ABI,
        type: 'close',
        id: nextRequestId(),
      };
      try {
        await send(closeRequest, 'close-result', {}, [], signal, onProgress);
      } finally {
        terminate();
      }
    });
    queue = closePromise.catch(() => {});
    return closePromise;
  };

  return Object.freeze({
    runAction,
    executeAction: runAction,
    cancel,
    close,
    get closed() { return state === 'closed'; },
  });
}

async function actionInputsFromContext(action, context) {
  if (!context || typeof context !== 'object') throw new TypeError('ESP32 Worker Action context must be an object');
  if (Object.hasOwn(context, 'inputs')) {
    return normalizeActionFiles(context.inputs, action.inputs, 'input', MAX_ACTION_TOTAL_INPUT_BYTES);
  }
  if (typeof context.readFile !== 'function') {
    throw new TypeError(`ESP32 Worker Action ${action.id} requires an input reader`);
  }
  const inputs = [];
  for (const input of action.inputs) {
    const value = await context.readFile(input.path);
    if (value === undefined || value === null) throw new Error(`ESP32 Worker Action ${action.id} input is missing: ${input.path}`);
    inputs.push({ path: input.path, bytes: value });
  }
  return normalizeActionFiles(inputs, action.inputs, 'input', MAX_ACTION_TOTAL_INPUT_BYTES);
}

function isAbortSignal(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function',
  );
}

function parseUtf8Json(bytes, label) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
}

async function sha256Hex(bytes, cryptoRef) {
  if (typeof cryptoRef?.subtle?.digest !== 'function') {
    throw new Error('Web Crypto SHA-256 is required to verify the ESP32-C3 runtime descriptor');
  }
  const digest = new Uint8Array(await cryptoRef.subtle.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function fail(message) {
  throw new Error(message);
}
