import { resolveBrowserToolchainBase } from './toolchain-origin.js';
import {
  BrowserActionCache,
  BrowserCacheStorageActionCache,
  BrowserWasmExecutor,
} from './ck-browser-executor.js';
import { validateBuildIR as validateBuildIRWithRust } from './ck-rust-build-core.js';
import {
  createAvrBrowserBuildIR,
  createAvrBrowserPackProvider,
  loadAvrBrowserBuildPlanning,
} from './avr/v4/build-ir.js';

const RUNTIME_BOARD = 'arduino:avr:uno';
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_PROJECT_FILES = 128;
const SAFE_SOURCE_NAME = /^[A-Za-z0-9_-]{1,64}\.ino$/;
const AVR_RUNTIME_BASE = new URL('./avr/v4/', import.meta.url);
const AVR_BOARD_PROFILES = Object.freeze({
  'arduino:avr:uno': avrBoardProfile({
    board: 'arduino:avr:uno',
    label: 'Arduino Uno',
    appFlashBytes: 32_256,
  }),
  'arduino:avr:diecimila': avrBoardProfile({
    board: 'arduino:avr:diecimila',
    label: 'Arduino Duemilanove or Diecimila',
    cpuValues: ['atmega328'],
    boardMacro: 'ARDUINO_AVR_DUEMILANOVE',
    appFlashBytes: 30_720,
  }),
  'arduino:avr:nano': avrBoardProfile({
    board: 'arduino:avr:nano',
    label: 'Arduino Nano',
    cpuValues: ['atmega328', 'atmega328old'],
    boardMacro: 'ARDUINO_AVR_NANO',
    analogInputs: 8,
    appFlashBytes: 30_720,
  }),
});
const AVR_BROWSER_ACTION_ADAPTER_POLICY = 'ck-avr-browser-action-adapter-v1';
const AVR_WORKER_TIMEOUT_MS = 120_000;
const AVR_TRANSPORT_CACHE_NAMES = Object.freeze([
  'sketchforge-avr-toolchain-v2',
  'sketchforge-avr-toolchain-v3',
]);
const browserBuildCache = typeof globalThis.caches === 'undefined'
  ? new BrowserActionCache()
  : new BrowserCacheStorageActionCache('ck-avr-build-actions-v1');
let capabilityPromise;

// Keep the static route list available to the editor without duplicating the
// compiler's board matrix in UI code.
export const AVR_BROWSER_BOARD_PROFILES = AVR_BOARD_PROFILES;

export function isAvrBrowserBoard(board) {
  return typeof board === 'string' && Object.hasOwn(AVR_BOARD_PROFILES, board);
}

function avrToolchainDataBase() {
  return resolveBrowserToolchainBase({
    id: 'arduino-avr-uno',
    fallback: AVR_RUNTIME_BASE,
  });
}

function avrBoardProfile({
  board,
  label,
  cpuValues = [],
  boardMacro = 'ARDUINO_AVR_UNO',
  analogInputs = 6,
  appFlashBytes,
}) {
  const sourcePreamble = [];
  if (board !== RUNTIME_BOARD) {
    sourcePreamble.push('#undef ARDUINO_AVR_UNO', `#define ${boardMacro} 1`);
  }
  // Arduino AVR's Nano variant is the standard variant with this one macro
  // changed. The bundled core does not consume NUM_ANALOG_INPUTS itself.
  if (analogInputs !== 6) {
    sourcePreamble.push('#undef NUM_ANALOG_INPUTS', `#define NUM_ANALOG_INPUTS ${analogInputs}`);
  }
  return Object.freeze({
    board,
    cpuValues: Object.freeze([...cpuValues]),
    sourcePreamble: Object.freeze(sourcePreamble),
    target: Object.freeze({ label, appFlashBytes, ramBytes: 2_048 }),
  });
}

export async function browserAvrCapability(request = {}) {
  const { board } = request;
  const profile = typeof board === 'string' && Object.hasOwn(AVR_BOARD_PROFILES, board)
    ? AVR_BOARD_PROFILES[board]
    : null;
  if (!profile) return { supported: false, reason: 'board' };

  const files = request.files;
  if (!Array.isArray(files)
    || files.length < 1
    || files.length > MAX_PROJECT_FILES
    || files.some((file) => (
      typeof file?.name !== 'string'
      || !SAFE_SOURCE_NAME.test(file.name)
      || typeof file?.content !== 'string'
    ))
    || new Set(files.map((file) => file.name.toLowerCase())).size !== files.length) {
    return { supported: false, reason: 'request' };
  }

  const options = request.options ?? {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return { supported: false, reason: 'request' };
  }
  const optionKeys = profile.cpuValues.length ? ['cpu', 'optimize'] : ['optimize'];
  const cpu = options.cpu ?? profile.cpuValues[0];
  if (Object.keys(options).some((key) => !optionKeys.includes(key))
    || (options.optimize ?? 'fast') !== 'fast'
    || (profile.cpuValues.length > 0 && !profile.cpuValues.includes(cpu))) {
    return { supported: false, reason: 'options' };
  }

  const libraries = request.libraries ?? [];
  if (!Array.isArray(libraries)) return { supported: false, reason: 'request' };
  if (libraries.length) return { supported: false, reason: 'libraries' };

  if (typeof globalThis.Worker === 'undefined'
    || typeof globalThis.WebAssembly === 'undefined'
    || typeof globalThis.TextEncoder === 'undefined'
    || typeof globalThis.crypto?.subtle?.digest !== 'function') {
    return { supported: false, reason: 'browser' };
  }

  const source = files.map((file) => file.content).join('\n');
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    return { supported: false, reason: 'source_size' };
  }

  const manifest = await loadCapabilityManifest();
  const available = new Set(manifest.browserHeaders);
  const unsupported = sourceIncludes(source).filter((header) => !available.has(header));
  if (unsupported.length) return { supported: false, reason: 'headers', unsupported };
  return { supported: true, manifest, profile };
}

function runtimeBuildRequest(request, profile) {
  const mainSketch = stableMainSketch(request.files);
  const files = profile.sourcePreamble.length === 0
    ? request.files
    : request.files.map((file) => (
      file === mainSketch
        ? { ...file, content: prependProfilePreamble(file, profile.sourcePreamble) }
        : file
    ));
  return {
    board: RUNTIME_BOARD,
    files,
    options: { optimize: 'fast' },
  };
}

function prependProfilePreamble(file, preamble) {
  const hasBom = file.content.charCodeAt(0) === 0xfeff;
  const bom = hasBom ? '\ufeff' : '';
  const source = hasBom ? file.content.slice(1) : file.content;
  return `${bom}${preamble.join('\n')}\n#line 1 "${file.name}"\n${source}`;
}

/** Compile a supported ATmega328P board profile in an Action-only browser Worker. */
export async function compileAvrInBrowser(request, onProgress = () => {}, { signal } = {}) {
  const first = await compileAvrInBrowserOnce(request, onProgress, { signal });
  if (!shouldRetryAvrBrowserBuild(first, signal)) return first;

  try {
    onProgress({ stage: 'assets', percent: 0, detail: 'Retrying AVR compiler assets' });
  } catch { /* Progress is advisory. */ }
  await clearAvrTransportCaches();
  return compileAvrInBrowserOnce(request, onProgress, { signal });
}

async function compileAvrInBrowserOnce(request, onProgress = () => {}, { signal } = {}) {
  if (signal?.aborted) return cancelledBrowserBuild();
  let capability;
  try {
    capability = await browserAvrCapability(request);
  } catch (error) {
    if (signal?.aborted) return cancelledBrowserBuild();
    return { handled: false, reason: 'assets', error };
  }
  if (signal?.aborted) return cancelledBrowserBuild();
  if (!capability.supported) return { handled: false, ...capability };

  const started = now();
  const progress = (event) => {
    try { onProgress(event); } catch { /* Progress is advisory. */ }
  };
  let stage = 'assets';
  let session;
  try {
    progress({ stage: 'assets', percent: 0, detail: 'Resolving AVR Packs' });
    const assetsBase = avrToolchainDataBase();
    const planning = await loadAvrBrowserBuildPlanning({
      manifest: capability.manifest,
      assetsBase: assetsBase.href,
    });
    if (signal?.aborted) return cancelledBrowserBuild(started);
    const ir = await createAvrBrowserBuildIR(runtimeBuildRequest(request, capability.profile), planning);
    if (signal?.aborted) return cancelledBrowserBuild(started);
    const packs = createAvrBrowserPackProvider({ planning, ir });

    stage = 'runtime';
    const { createAvrBrowserWorkerLauncher } = await import('./avr/v4/index.js?recovery=20260809');
    session = await createAvrBrowserWorkerLauncher({ timeoutMs: AVR_WORKER_TIMEOUT_MS })
      .openActionSession({ assetsBase: assetsBase.href, signal });
    const executor = new BrowserWasmExecutor({
      cache: browserBuildCache,
      packs,
      adapterPolicyVersion: AVR_BROWSER_ACTION_ADAPTER_POLICY,
      validateIR: async (candidate) => { await validateBuildIRWithRust(candidate); },
      runAction(action, context) {
        return session.runAction(action, {
          inputs: action.inputs.map((input) => ({
            path: input.path,
            bytes: context.readFile(input.path),
          })),
          signal: context.signal,
        });
      },
    });
    const execution = await executor.execute(ir, {
      signal,
      onProgress: ({ completed, total, action, cached }) => {
        progress(actionProgress(action, completed, total, cached));
      },
    });
    return adaptAvrBuildExecution(
      execution,
      stableMainSketch(request.files),
      started,
      capability.profile.target,
    );
  } catch (error) {
    if (signal?.aborted || error?.code === 'aborted') return cancelledBrowserBuild(started);
    return { handled: false, reason: stage, error };
  } finally {
    if (session) {
      try { await session.close(); } catch { /* The disposable Worker is already isolated. */ }
    }
  }
}

function shouldRetryAvrBrowserBuild(result, signal) {
  return !signal?.aborted
    && result?.handled === false
    && (result.reason === 'assets' || result.reason === 'runtime')
    && result.error?.code !== 'timeout';
}

async function clearAvrTransportCaches() {
  if (typeof globalThis.caches?.delete !== 'function') return;
  await Promise.all(AVR_TRANSPORT_CACHE_NAMES.map(async (name) => {
    try { await globalThis.caches.delete(name); } catch { /* Cache Storage is optional. */ }
  }));
}

function cancelledBrowserBuild(started = now()) {
  return {
    handled: true,
    result: {
      status: 'error',
      reason: 'cancelled',
      message: 'compile was cancelled',
      diagnostics: [],
      timings: { total: Math.max(0, now() - started) },
    },
  };
}

export function adaptAvrBuildExecution(
  execution,
  sourceFile,
  started = now(),
  target = AVR_BOARD_PROFILES[RUNTIME_BOARD].target,
) {
  if (!execution || typeof execution !== 'object') throw new Error('CK AVR browser executor returned no execution');
  if (execution.status === 'error') {
    const diagnostics = adaptExecutionDiagnostics(execution.diagnostics, sourceFile.name);
    if (execution.reason === 'compile') {
      return {
        handled: true,
        result: {
          status: 'error',
          reason: 'compile_error',
          message: diagnostics.length ? 'Code compilation failed' : execution.message,
          diagnostics,
          timings: { total: execution.durationMs ?? now() - started },
        },
      };
    }
    if (
      execution.reason === 'timeout'
      || execution.reason === 'resource_limit'
      || execution.reason === 'cancelled'
    ) {
      return {
        handled: true,
        result: {
          status: 'error',
          reason: execution.reason,
          message: execution.message,
          diagnostics,
          timings: { total: execution.durationMs ?? now() - started },
        },
      };
    }
    throw executionError(execution);
  }
  if (execution.status !== 'success' || !Array.isArray(execution.artifacts)) {
    throw new Error('CK AVR browser executor returned an invalid execution');
  }

  const hexArtifact = execution.artifacts.find((artifact) => artifact.path === 'build/firmware.hex');
  const elfArtifact = execution.artifacts.find((artifact) => artifact.path === 'build/firmware.elf');
  if (!hexArtifact?.bytes || !elfArtifact?.bytes) throw new Error('CK AVR browser executor returned incomplete artifacts');
  const hex = new TextDecoder().decode(hexArtifact.bytes);
  const flashBytes = intelHexDataBytes(hex);
  const ramBytes = elfRamBytes(elfArtifact.bytes);
  const diagnostics = adaptExecutionDiagnostics(execution.diagnostics, sourceFile.name);
  const timings = Object.fromEntries((execution.actions ?? []).map((action) => [action.actionId, action.durationMs]));
  timings.total = execution.durationMs ?? now() - started;

  if (flashBytes > target.appFlashBytes) {
    const message = `Program uses ${flashBytes} bytes, exceeding ${target.label}'s ${target.appFlashBytes} byte limit`;
    return {
      handled: true,
      result: {
        status: 'error',
        reason: 'resource_limit',
        message,
        diagnostics: [{ severity: 'error', file: sourceFile.name, line: 1, message }],
        timings,
      },
    };
  }

  return {
    handled: true,
    result: {
      status: 'success',
      artifacts: [{
        offset: null,
        name: 'firmware.hex',
        sha256: hexArtifact.sha256,
        size: hexArtifact.bytes.byteLength,
        base64: bytesToBase64(hexArtifact.bytes),
      }],
      staticArtifacts: [],
      memory: {
        flashUsed: flashBytes,
        flashTotal: target.appFlashBytes,
        ramUsed: ramBytes ?? 0,
        ramTotal: target.ramBytes,
      },
      diagnostics,
      timings,
      cached: Array.isArray(execution.actions)
        && execution.actions.length > 0
        && execution.actions.every((action) => action.cached),
      execution: 'browser',
    },
  };
}

async function loadCapabilityManifest() {
  if (!capabilityPromise) {
    const url = new URL('assets/manifest.json', AVR_RUNTIME_BASE);
    capabilityPromise = fetch(url, { cache: 'no-cache' }).then(async (response) => {
      if (!response.ok) throw new Error(`AVR browser capability manifest returned HTTP ${response.status}`);
      const manifest = await response.json();
      if (manifest.schema !== 3
        || manifest.board !== RUNTIME_BOARD
        || !Array.isArray(manifest.browserHeaders)
        || !Array.isArray(manifest.headerFiles)
        || !Array.isArray(manifest.objectFiles)
        || !Array.isArray(manifest.libs)) {
        throw new Error('AVR browser capability manifest is invalid');
      }
      return manifest;
    }).catch((error) => {
      capabilityPromise = undefined;
      throw error;
    });
  }
  return capabilityPromise;
}

function actionProgress(action, completed, total, cached) {
  const stage = action?.kind === 'compile'
    ? 'compiling'
    : action?.kind === 'link'
      ? 'linking'
      : action?.tool === 'ck:arduino-preprocess'
        ? 'preprocess'
        : 'imaging';
  return {
    stage,
    percent: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 100,
    detail: `${action?.id ?? 'CK Build IR Action'}${cached ? ' (cached)' : ''}`,
  };
}

function adaptExecutionDiagnostics(value, sourceName) {
  if (!Array.isArray(value)) return [];
  return value.map((diagnostic) => ({
    severity: diagnostic.severity,
    file: diagnostic.sourceFile ?? diagnostic.file ?? sourceName,
    line: diagnostic.sourceLine ?? diagnostic.line ?? 1,
    ...(diagnostic.sourceColumn !== undefined
      ? { column: diagnostic.sourceColumn }
      : diagnostic.column !== undefined ? { column: diagnostic.column } : {}),
    message: diagnostic.message,
    ...(diagnostic.fromGenerated ? { fromGenerated: true } : {}),
  }));
}

function sourceIncludes(source) {
  const found = [];
  const pattern = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;
  for (let match; (match = pattern.exec(source));) found.push(match[1]);
  return found;
}

function stableMainSketch(files) {
  const sketches = [...files].sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ));
  return sketches.find((file) => file.name.toLowerCase() === 'main.ino') ?? sketches[0];
}

export function parseCompilerDiagnostics(lines, processed, sourceName) {
  const diagnostics = [];
  const seen = new Set();
  for (const rawLine of lines) {
    const line = String(rawLine)
      .replace(/^\[[^\]]+\]\s*/, '')
      .replace(/\x1b\[[0-9;]*m/g, '');
    const match = line.match(/^(.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/);
    if (!match) continue;
    let [, file, row, column, severity, message] = match;
    let lineNumber = Number(row);
    let fromGenerated = false;
    let unmapped = false;
    if (basename(file) === '<generated>') {
      const fn = processed.generatedLineToFunction.get(lineNumber);
      if (fn) {
        lineNumber = fn.line;
        column = '1';
      } else {
        lineNumber = 1;
        unmapped = true;
      }
      file = sourceName;
      fromGenerated = true;
    } else if (basename(file) === sourceName) {
      file = sourceName;
      if (lineNumber < 1 || lineNumber > processed.sourceLineCount) {
        lineNumber = Math.min(Math.max(1, lineNumber), processed.sourceLineCount);
        unmapped = true;
      }
    } else {
      message = `${basename(file)}:${row}: ${message}`;
      file = sourceName;
      lineNumber = 1;
      unmapped = true;
    }
    const diagnostic = {
      severity: severity === 'warning' ? 'warning' : severity === 'note' ? 'info' : 'error',
      file,
      line: lineNumber,
      ...(column ? { column: Number(column) } : {}),
      message,
      ...(fromGenerated ? { fromGenerated: true } : {}),
      ...(unmapped ? { unmapped: true } : {}),
    };
    const key = JSON.stringify(diagnostic);
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}

function intelHexDataBytes(hex) {
  let bytes = 0;
  for (const record of hex.split(/\r?\n/)) {
    if (!record) continue;
    if (!/^:[0-9A-Fa-f]{10,}$/.test(record)) throw new Error('objcopy produced invalid Intel HEX');
    if (Number.parseInt(record.slice(7, 9), 16) === 0) bytes += Number.parseInt(record.slice(1, 3), 16);
  }
  return bytes;
}

function elfRamBytes(bytes) {
  if (bytes.byteLength < 52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x7f454c46 || view.getUint8(4) !== 1 || view.getUint8(5) !== 1) return null;
  const sectionOffset = view.getUint32(32, true);
  const sectionEntrySize = view.getUint16(46, true);
  const sectionCount = view.getUint16(48, true);
  const namesIndex = view.getUint16(50, true);
  if (!sectionEntrySize || namesIndex >= sectionCount) return null;
  const namesHeader = sectionOffset + namesIndex * sectionEntrySize;
  if (namesHeader + 24 > bytes.byteLength) return null;
  const namesOffset = view.getUint32(namesHeader + 16, true);

  const nameAt = (offset) => {
    let end = namesOffset + offset;
    while (end < bytes.byteLength && bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(namesOffset + offset, end));
  };
  let total = 0;
  for (let index = 0; index < sectionCount; index++) {
    const header = sectionOffset + index * sectionEntrySize;
    if (header + 24 > bytes.byteLength) return null;
    const name = nameAt(view.getUint32(header, true));
    if (name === '.data' || name === '.bss' || name === '.noinit') total += view.getUint32(header + 20, true);
  }
  return total;
}

function executionError(execution) {
  const error = new Error(String(execution.message ?? 'CK AVR browser build failed'));
  error.code = execution.reason;
  error.reason = execution.reason;
  error.diagnostics = execution.diagnostics ?? [];
  return error;
}

function basename(path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index === -1 ? path : path.slice(index + 1);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function now() {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}
