/**
 * CK's browser execution boundary. The injected action runner owns the
 * release-pinned WASM Worker; this module owns IR validation, action caching,
 * logical files, and normalized results. No compiler command or VFS path is
 * exposed to callers.
 */

const SHA256 = /^[a-f0-9]{64}$/;
const FAILURE_REASONS = new Set([
  'invalid_ir',
  'integrity',
  'tool',
  'compile',
  'timeout',
  'resource_limit',
  'cancelled',
  'internal',
]);
const SOURCE_LANGUAGES = new Set(['ino', 'c', 'c++', 'asm', 'header', 'other']);
const TRANSFORM_FORMATS = new Set(['elf', 'bin', 'hex', 'bootloader', 'partition', 'boot-app0', 'other']);
const ACTION_CACHE_INDEX_URL = 'https://ck.invalid/__ck_action_cache_index_v1__';
export const CK_BROWSER_WASM_EXECUTOR_CACHE_POLICY = 'ck-browser-wasm-executor-cache-v2';
const DEFAULT_ACTION_ADAPTER_POLICY = 'generic-action-adapter-v1';
const DEFAULT_ACTION_CACHE_LIMITS = Object.freeze({
  maxEntries: 256,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024,
});

export class BrowserActionCache {
  #entries = new Map();
  #totalBytes = 0;

  constructor(options = {}) {
    this.limits = actionCacheLimits(options);
  }

  async get(key) {
    const record = this.#entries.get(key);
    if (!record) return null;
    this.#entries.delete(key);
    this.#entries.set(key, record);
    return cloneEntry(record.entry);
  }

  async put(entry) {
    const stored = cloneEntry(entry);
    const size = actionCacheEntryBytes(stored);
    if (size > this.limits.maxEntryBytes || size > this.limits.maxTotalBytes) return;
    const previous = this.#entries.get(stored.actionKey);
    if (previous) {
      this.#entries.delete(stored.actionKey);
      this.#totalBytes -= previous.size;
    }
    this.#entries.set(stored.actionKey, { entry: stored, size });
    this.#totalBytes += size;
    while (
      this.#entries.size > this.limits.maxEntries
      || this.#totalBytes > this.limits.maxTotalBytes
    ) {
      const oldest = this.#entries.entries().next().value;
      if (!oldest) break;
      this.#entries.delete(oldest[0]);
      this.#totalBytes -= oldest[1].size;
    }
  }

  clear() {
    this.#entries.clear();
    this.#totalBytes = 0;
  }
}

/** Persistent browser cache; falls back to a miss when Cache Storage is unavailable. */
export class BrowserCacheStorageActionCache {
  constructor(name = 'ck-build-actions-v1', options = {}) {
    if (name && typeof name === 'object') {
      options = name;
      name = 'ck-build-actions-v1';
    }
    if (typeof name !== 'string' || !name) throw new TypeError('Action cache name must not be empty');
    this.name = name;
    this.limits = actionCacheLimits(options);
    this.memory = new BrowserActionCache(this.limits);
    this.index = null;
    this.lastAccess = 0;
    this.pending = Promise.resolve();
  }

  async get(key) {
    const memory = await this.memory.get(key);
    if (typeof globalThis.caches === 'undefined') return memory;
    return this.#run(async () => {
      try {
        const cache = await globalThis.caches.open(this.name);
        await this.#loadIndex(cache);
        if (memory) {
          if (this.index.has(key)) {
            this.index.get(key).lastAccess = this.#nextAccess();
            await this.#persistIndex(cache);
          }
          return memory;
        }
        const response = await cache.match(actionCacheUrl(key));
        if (!response) {
          if (this.index.delete(key)) await this.#persistIndex(cache);
          return null;
        }
        const body = await response.text();
        const entry = decodeCacheEntry(JSON.parse(body));
        if (!entry) {
          await cache.delete(actionCacheUrl(key));
          this.index.delete(key);
          await this.#persistIndex(cache);
          return null;
        }
        const size = utf8ByteLength(body);
        this.index.set(key, { size, lastAccess: this.#nextAccess() });
        await this.#prune(cache);
        await this.#persistIndex(cache);
        await this.memory.put(entry);
        return entry;
      } catch {
        return memory;
      }
    });
  }

  async put(entry) {
    await this.memory.put(entry);
    if (typeof globalThis.caches === 'undefined') return;
    if (actionCacheEntryBytes(entry) > this.limits.maxEntryBytes) return;
    await this.#run(async () => {
      try {
        const body = JSON.stringify(encodeCacheEntry(entry));
        const size = utf8ByteLength(body);
        if (size > this.limits.maxEntryBytes || size > this.limits.maxTotalBytes) return;
        const cache = await globalThis.caches.open(this.name);
        await this.#loadIndex(cache);
        this.index.set(entry.actionKey, { size, lastAccess: this.#nextAccess() });
        await this.#prune(cache, entry.actionKey);
        await cache.put(
          actionCacheUrl(entry.actionKey),
          new Response(body, { headers: { 'content-type': 'application/json' } }),
        );
        await this.#persistIndex(cache);
      } catch {
        // Persistent storage is an optimization; the in-memory entry remains valid.
      }
    });
  }

  #run(task) {
    const execute = async () => {
      const locks = globalThis.navigator?.locks;
      if (!locks || typeof locks.request !== 'function') return task();
      return locks.request(
        `ck-browser-action-cache:${this.name}`,
        { mode: 'exclusive' },
        async () => {
          this.index = null;
          return task();
        },
      );
    };
    const result = this.pending.then(execute, execute);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  #nextAccess() {
    this.lastAccess = Math.max(Date.now(), this.lastAccess + 1);
    return this.lastAccess;
  }

  async #loadIndex(cache) {
    if (this.index) return;
    const index = new Map();
    try {
      const response = await cache.match(ACTION_CACHE_INDEX_URL);
      const value = response ? await response.json() : null;
      if (value?.schema !== 1 || !Array.isArray(value.entries)) throw new Error('missing cache index');
      for (const item of value.entries) {
        if (
          !item || typeof item.key !== 'string' || !item.key
          || !Number.isSafeInteger(item.size) || item.size < 0
          || !Number.isSafeInteger(item.lastAccess) || item.lastAccess < 0
          || index.has(item.key)
        ) throw new Error('invalid cache index');
        index.set(item.key, { size: item.size, lastAccess: item.lastAccess });
        this.lastAccess = Math.max(this.lastAccess, item.lastAccess);
      }
    } catch {
      for (const request of await cache.keys()) {
        if (request.url === ACTION_CACHE_INDEX_URL || !request.url.startsWith('https://ck.invalid/')) continue;
        const response = await cache.match(request);
        if (!response) continue;
        const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
        index.set(key, { size: utf8ByteLength(await response.text()), lastAccess: this.#nextAccess() });
      }
    }
    this.index = index;
    await this.#prune(cache);
    await this.#persistIndex(cache);
  }

  async #prune(cache, protectedKey) {
    let total = [...this.index.values()].reduce((sum, entry) => sum + entry.size, 0);
    while (this.index.size > this.limits.maxEntries || total > this.limits.maxTotalBytes) {
      const candidates = [...this.index.entries()]
        .filter(([key]) => key !== protectedKey)
        .sort((left, right) => left[1].lastAccess - right[1].lastAccess || compareText(left[0], right[0]));
      const oldest = candidates[0];
      if (!oldest) break;
      this.index.delete(oldest[0]);
      total -= oldest[1].size;
      await cache.delete(actionCacheUrl(oldest[0]));
    }
  }

  async #persistIndex(cache) {
    const entries = [...this.index.entries()]
      .sort((left, right) => compareText(left[0], right[0]))
      .map(([key, value]) => ({ key, ...value }));
    await cache.put(
      ACTION_CACHE_INDEX_URL,
      new Response(JSON.stringify({ schema: 1, entries }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
}

export class BrowserWasmExecutor {
  kind = 'browser-wasm';

  constructor({
    runAction,
    cache = new BrowserActionCache(),
    packs,
    validateIR,
    calculateActionKeys = calculateActionKeysWithRust,
    requireMemoryEvidence = false,
    adapterPolicyVersion = DEFAULT_ACTION_ADAPTER_POLICY,
  } = {}) {
    if (typeof runAction !== 'function') throw new TypeError('BrowserWasmExecutor requires an action runner');
    if (!cache || typeof cache.get !== 'function' || typeof cache.put !== 'function') {
      throw new TypeError('BrowserWasmExecutor Action cache must implement get() and put()');
    }
    if (packs !== undefined && typeof packs?.materialize !== 'function') {
      throw new TypeError('BrowserWasmExecutor Pack provider must implement materialize()');
    }
    if (typeof calculateActionKeys !== 'function') {
      throw new TypeError('BrowserWasmExecutor Action key calculator must be a function');
    }
    if (typeof requireMemoryEvidence !== 'boolean') {
      throw new TypeError('BrowserWasmExecutor requireMemoryEvidence must be a boolean');
    }
    if (typeof adapterPolicyVersion !== 'string' || !adapterPolicyVersion.trim()
      || adapterPolicyVersion.length > 128) {
      throw new TypeError('BrowserWasmExecutor adapterPolicyVersion must be a non-empty string');
    }
    this.runAction = runAction;
    this.cache = cache;
    this.packs = packs;
    this.validateIR = typeof validateIR === 'function' ? validateIR : null;
    this.calculateActionKeys = calculateActionKeys;
    this.requireMemoryEvidence = requireMemoryEvidence;
    this.adapterPolicyVersion = adapterPolicyVersion;
  }

  async execute(ir, { signal, onProgress = () => {} } = {}) {
    const started = now();
    if (signal?.aborted) {
      return failure('cancelled', 'build execution was cancelled', [], started);
    }
    let invalid = null;
    if (this.validateIR) {
      try {
        const result = await this.validateIR(ir);
        if (typeof result === 'string' && result) invalid = result;
        else if (result?.valid === false) {
          invalid = Array.isArray(result.errors)
            ? result.errors.map((error) => error?.message ?? String(error)).join('; ')
            : 'CK Build IR validation failed';
        }
      } catch (error) {
        invalid = errorMessage(error);
      }
    }
    if (signal?.aborted) {
      return failure('cancelled', 'build execution was cancelled', [], started);
    }
    if (!invalid) invalid = validateEnvelope(ir);
    if (invalid) return failure('invalid_ir', invalid, [], started);

    let actions;
    try {
      actions = topologicalActions(ir.graph.actions);
      validateGeneratedInputs(actions);
    } catch (error) {
      return failure('invalid_ir', errorMessage(error), [], started);
    }
    try {
      const keyedIr = await this.calculateActionKeys(ir);
      const keyError = validateActionKeys(ir, keyedIr);
      if (keyError) return failure('invalid_ir', keyError, [], started);
    } catch (error) {
      return failure('invalid_ir', `CK Build IR Action key validation failed: ${errorMessage(error)}`, [], started);
    }
    if (signal?.aborted) {
      return failure('cancelled', 'build execution was cancelled', [], started);
    }

    const files = new Map();
    for (const file of ir.project.files) {
      const bytes = utf8(file.content);
      if (bytes.byteLength !== file.size || await sha256(bytes) !== file.sha256) {
        return failure('integrity', `project file hash mismatch: ${file.path}`, [], started);
      }
      files.set(file.path, bytes);
    }

    if (this.packs) {
      try {
        await this.packs.materialize(ir.packs, {
          signal,
          hasFile: (path) => files.has(path),
          readFile: (path) => cloneBytes(files.get(path)),
          writeFile: async (path, value, expectedSha256) => {
            if (!isLogicalPath(path)) throw new TypeError(`Pack file path is invalid: ${path}`);
            if (files.has(path)) throw new TypeError(`Pack file collides with an existing file: ${path}`);
            const bytes = cloneBytes(value);
            if (!bytes) throw new TypeError(`Pack file bytes are invalid: ${path}`);
            if (expectedSha256 !== undefined) {
              if (!SHA256.test(expectedSha256) || await sha256(bytes) !== expectedSha256) {
                throw new TypeError(`Pack file hash mismatch: ${path}`);
              }
            }
            files.set(path, bytes);
          },
        });
      } catch (error) {
        if (signal?.aborted) {
          return failure('cancelled', 'build execution was cancelled', [], started);
        }
        return failure('integrity', errorMessage(error), [], started);
      }
    }
    if (signal?.aborted) {
      return failure('cancelled', 'build execution was cancelled', [], started);
    }

    const results = [];
    const diagnostics = [];
    const nonCacheableActions = new Set();
    for (const action of actions) {
      if (signal?.aborted) {
        return failure(
          'cancelled',
          'build execution was cancelled',
          results,
          started,
          action.id,
          mapDiagnostics(diagnostics, ir.diagnosticMap),
        );
      }
      const actionStarted = now();
      const dependencyIsNonCacheable = action.dependencies.some((id) => nonCacheableActions.has(id));
      let actionIsCacheable = !dependencyIsNonCacheable;
      const inputError = await verifyInputs(files, action);
      if (inputError) {
        return failure(
          'integrity',
          inputError,
          results,
          started,
          action.id,
          mapDiagnostics(diagnostics, ir.diagnosticMap),
        );
      }
      const cacheKey = await browserActionCacheKey(action.cacheKey, this.adapterPolicyVersion);
      const cacheEntry = dependencyIsNonCacheable
        ? null
        : await this.#readCache(action, cacheKey);
      let outputs = cacheEntry?.outputs ?? null;
      let peakMemoryBytes = cacheEntry?.peakMemoryBytes;
      let actionDiagnostics = cacheEntry?.diagnostics ?? [];
      let cached = Boolean(outputs);
      let memoryLimit;
      const inputBytes = action.inputs.reduce(
        (total, input) => total + (files.get(input.path)?.byteLength ?? 0),
        0,
      );
      const inputMemoryError = verifyMemoryLimit(action, inputBytes, 0);
      if (inputMemoryError) {
        return failure(
          'resource_limit', inputMemoryError, results, started, action.id,
          mapDiagnostics(diagnostics, ir.diagnosticMap),
        );
      }
      if (!outputs) {
        const stagedOutputs = new Map();
        const declaredOutputs = new Set(action.outputs.map((output) => output.path));
        let stagedOutputBytes = 0;
        let outcome;
        try {
          outcome = await runActionWithLimits(
            this.runAction,
            action,
            {
              files,
              ir,
              readFile: (path) => cloneBytes(stagedOutputs.get(path) ?? files.get(path)),
              writeFile: (path, value) => {
                if (!isLogicalPath(path) || !declaredOutputs.has(path)) {
                  throw new TypeError(`action ${action.id} attempted to write undeclared output: ${path}`);
                }
                if (stagedOutputs.has(path)) {
                  throw new TypeError(`action ${action.id} wrote output more than once: ${path}`);
                }
                const bytes = cloneBytes(value);
                if (!bytes) throw new TypeError(`action ${action.id} wrote invalid bytes for ${path}`);
                const memoryError = verifyMemoryLimit(
                  action,
                  inputBytes,
                  stagedOutputBytes + bytes.byteLength,
                );
                if (memoryError) throw resourceLimitError(memoryError);
                stagedOutputs.set(path, bytes);
                stagedOutputBytes += bytes.byteLength;
              },
              memoryLimitBytes: action.resourceLimits?.memoryBytes,
            },
            signal,
          );
        } catch (error) {
          return failure(
            signal?.aborted ? 'cancelled' : normalizeFailureReason(error?.reason),
            signal?.aborted ? 'build execution was cancelled' : errorMessage(error),
            results,
            started,
            action.id,
            mapDiagnostics(diagnostics, ir.diagnosticMap),
          );
        }
        if (outcome.aborted) {
          return failure(
            outcome.timedOut ? 'timeout' : 'cancelled',
            outcome.timedOut
              ? `action ${action.id} exceeded its ${action.resourceLimits.cpuMs}ms CPU limit`
              : 'build execution was cancelled',
            results,
            started,
            action.id,
            mapDiagnostics(diagnostics, ir.diagnosticMap),
          );
        }
        const response = outcome.response;
        if (!response || typeof response !== 'object') {
          return failure(
            'internal',
            `action ${action.id} returned an invalid response`,
            results,
            started,
            action.id,
            mapDiagnostics(diagnostics, ir.diagnosticMap),
          );
        }
        try {
          actionDiagnostics = normalizeDiagnostics(response.diagnostics, action);
          diagnostics.push(...actionDiagnostics);
        } catch (error) {
          return failure(
            'internal',
            errorMessage(error),
            results,
            started,
            action.id,
            mapDiagnostics(diagnostics, ir.diagnosticMap),
          );
        }
        if (response.ok === false || response.status === 'error') {
          return failure(
            normalizeFailureReason(response.reason),
            typeof response.message === 'string' && response.message
              ? response.message
              : `action ${action.id} failed`,
            results,
            started,
            action.id,
            mapDiagnostics(diagnostics, ir.diagnosticMap),
          );
        }
        try {
          outputs = await normalizeOutputs(action, response.outputs, stagedOutputs);
        } catch (error) {
          return failure(
            'integrity',
            errorMessage(error),
            results,
            started,
            action.id,
            mapDiagnostics(diagnostics, ir.diagnosticMap),
          );
        }
        const outputLimitError = verifyOutputLimit(action, outputs);
        if (outputLimitError) {
          return failure(
            'resource_limit',
            outputLimitError,
            results,
            started,
            action.id,
            mapDiagnostics(diagnostics, ir.diagnosticMap),
          );
        }
        const memoryLimitError = verifyMemoryLimit(
          action,
          inputBytes,
          outputs.reduce((total, output) => total + output.bytes.byteLength, 0),
          response.peakMemoryBytes,
        );
        if (memoryLimitError) {
          return failure(
            'resource_limit', memoryLimitError, results, started, action.id,
            mapDiagnostics(diagnostics, ir.diagnosticMap),
          );
        }
        peakMemoryBytes = response.peakMemoryBytes;
        memoryLimit = memoryLimitEvidence(action, inputBytes, outputs, peakMemoryBytes);
        if (this.requireMemoryEvidence && memoryLimit?.status === 'unverified') {
          return failure(
            'resource_limit',
            `action ${action.id} did not provide peak memory evidence for its ${memoryLimit.limitBytes} byte memory limit`,
            results,
            started,
            action.id,
            mapDiagnostics(diagnostics, ir.diagnosticMap),
          );
        }
        if (response.cacheable === false) actionIsCacheable = false;
        if (actionIsCacheable) {
          try {
            await this.cache.put({
              actionKey: cacheKey,
              outputs,
              diagnostics: actionDiagnostics,
              ...(peakMemoryBytes === undefined ? {} : { peakMemoryBytes }),
            });
          } catch {
            // Action caching is an optimization; valid compiler output still wins.
          }
        }
      } else {
        diagnostics.push(...actionDiagnostics);
        const memoryLimitError = verifyMemoryLimit(
          action,
          inputBytes,
          outputs.reduce((total, output) => total + output.bytes.byteLength, 0),
        );
        if (memoryLimitError) {
          return failure(
            'resource_limit', memoryLimitError, results, started, action.id,
            mapDiagnostics(diagnostics, ir.diagnosticMap),
          );
        }
        memoryLimit = memoryLimitEvidence(action, inputBytes, outputs, peakMemoryBytes, true);
      }
      if (!actionIsCacheable) nonCacheableActions.add(action.id);
      for (const output of outputs) files.set(output.path, cloneBytes(output.bytes));
      results.push({
        actionId: action.id,
        actionKey: action.cacheKey,
        cached,
        durationMs: Math.max(0, now() - actionStarted),
        outputs: outputs.map(({ path, sha256: digest, bytes }) => ({ path, sha256: digest, size: bytes.byteLength })),
        ...(memoryLimit === undefined ? {} : { memoryLimit }),
      });
      try {
        onProgress({ completed: results.length, total: actions.length, action, cached });
      } catch { /* progress is advisory */ }
    }

    const artifacts = [];
    try {
      for (const artifact of ir.artifacts) {
        const bytes = files.get(artifact.path);
        if (!bytes) throw new Error(`build artifact is missing: ${artifact.path}`);
        artifacts.push({
          ...artifact,
          bytes: cloneBytes(bytes),
          size: bytes.byteLength,
          sha256: await sha256(bytes),
        });
      }
    } catch (error) {
      return failure('integrity', errorMessage(error), results, started, undefined, mapDiagnostics(diagnostics, ir.diagnosticMap));
    }
    return {
      status: 'success', executor: this.kind, actions: results, artifacts,
      diagnostics: mapDiagnostics(diagnostics, ir.diagnosticMap), durationMs: Math.max(0, now() - started),
    };
  }

  async #readCache(action, cacheKey) {
    try {
      const entry = await this.cache.get(cacheKey);
      if (!entry || entry.actionKey !== cacheKey || !Array.isArray(entry.outputs)) return null;
      const expectedOutputs = new Map(action.outputs.map((output) => [output.path, output]));
      const expected = [...expectedOutputs.keys()].sort();
      const actual = entry.outputs.map((output) => output?.path).sort();
      if (expected.length !== actual.length || expected.some((path, index) => path !== actual[index])) return null;
      const outputs = [];
      for (const output of entry.outputs) {
        const bytes = cloneBytes(output?.bytes);
        if (!bytes || !SHA256.test(output.sha256) || await sha256(bytes) !== output.sha256) return null;
        const declaredSha256 = expectedOutputs.get(output.path)?.sha256;
        if (declaredSha256 !== undefined && output.sha256 !== declaredSha256) return null;
        outputs.push({ ...output, bytes });
      }
      if (verifyOutputLimit(action, outputs)) return null;
      const peakMemoryBytes = entry.peakMemoryBytes;
      if (peakMemoryBytes !== undefined && (!Number.isSafeInteger(peakMemoryBytes) || peakMemoryBytes < 0)) return null;
      if (
        this.requireMemoryEvidence
        && action.resourceLimits?.memoryBytes !== undefined
        && peakMemoryBytes === undefined
      ) return null;
      const diagnostics = normalizeDiagnostics(entry.diagnostics, action);
      return { outputs, peakMemoryBytes, diagnostics };
    } catch {
      return null;
    }
  }
}

async function calculateActionKeysWithRust(ir) {
  const { calculateActionKeys } = await import('./ck-rust-build-core.js');
  return calculateActionKeys(ir);
}

function validateActionKeys(ir, keyedIr) {
  const expectedActions = keyedIr?.graph?.actions;
  if (!Array.isArray(expectedActions) || expectedActions.length !== ir.graph.actions.length) {
    return 'CK Build IR Action key calculator returned an invalid graph';
  }
  const expectedById = new Map();
  for (const action of expectedActions) {
    if (!action || typeof action.id !== 'string' || expectedById.has(action.id) || !SHA256.test(action.cacheKey)) {
      return 'CK Build IR Action key calculator returned invalid Actions';
    }
    expectedById.set(action.id, action.cacheKey);
  }
  for (const action of ir.graph.actions) {
    const expected = expectedById.get(action.id);
    if (expected === undefined) return `CK Build IR Action key calculator omitted ${action.id}`;
    if (action.cacheKey !== expected) {
      return `CK Build IR Action cache key mismatch for ${action.id}: expected ${expected}, received ${action.cacheKey}`;
    }
  }
  return null;
}

async function normalizeOutputs(action, value, stagedOutputs) {
  const returned = value === undefined || (Array.isArray(value) && value.length === 0 && stagedOutputs.size > 0)
    ? action.outputs.map((output) => ({ path: output.path, bytes: stagedOutputs.get(output.path) }))
    : value;
  if (!Array.isArray(returned)) throw new TypeError(`action ${action.id} did not return outputs`);
  const expected = new Map(action.outputs.map((output) => [output.path, output]));
  const outputs = [];
  const seen = new Set();
  for (const item of returned) {
    if (!item || typeof item.path !== 'string' || !expected.has(item.path)) {
      throw new TypeError(`action ${action.id} returned an unexpected output`);
    }
    if (seen.has(item.path)) throw new TypeError(`action ${action.id} returned a duplicate output: ${item.path}`);
    seen.add(item.path);
    const returnedBytes = item.bytes === undefined ? null : cloneBytes(item.bytes);
    const stagedBytes = stagedOutputs.get(item.path);
    if (returnedBytes && stagedBytes && !equalBytes(returnedBytes, stagedBytes)) {
      throw new TypeError(`action ${action.id} returned conflicting bytes for ${item.path}`);
    }
    const bytes = returnedBytes ?? cloneBytes(stagedBytes);
    if (!bytes) throw new TypeError(`action ${action.id} returned invalid bytes for ${item.path}`);
    const digest = await sha256(bytes);
    if (item.sha256 !== undefined && item.sha256 !== digest) throw new TypeError(`output hash mismatch: ${item.path}`);
    const declaredSha256 = expected.get(item.path)?.sha256;
    if (declaredSha256 !== undefined && declaredSha256 !== digest) {
      throw new TypeError(`action ${action.id} output contract mismatch: ${item.path}`);
    }
    outputs.push({ path: item.path, sha256: digest, bytes });
  }
  if (seen.size !== expected.size) throw new TypeError(`action ${action.id} returned an incomplete output set`);
  outputs.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return outputs;
}

function validateEnvelope(ir) {
  if (!ir || typeof ir !== 'object' || ir.kind !== 'ck-build-ir' || ir.schemaVersion !== 1) {
    return 'unsupported CK Build IR';
  }
  if (
    !ir.project || !Array.isArray(ir.project.files)
    || !ir.graph || !Array.isArray(ir.graph.actions)
    || !Array.isArray(ir.artifacts)
  ) {
    return 'CK Build IR is missing project, action graph, or artifacts';
  }
  const packRefs = ir.packs && typeof ir.packs === 'object' ? [
    ir.packs.toolchain,
    ir.packs.platform,
    ir.packs.board,
    ...(Array.isArray(ir.packs.libraries?.packs) ? ir.packs.libraries.packs : []),
  ].filter(Boolean) : [];
  const packRevisions = new Map(packRefs.map((pack) => [pack.id, pack.sha256]));
  const projectPaths = new Set();
  for (const file of ir.project.files) {
    if (
      !file || typeof file.path !== 'string' || typeof file.content !== 'string'
      || !isLogicalPath(file.path) || projectPaths.has(file.path)
      || !SOURCE_LANGUAGES.has(file.language) || typeof file.generated !== 'boolean'
      || !SHA256.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0
    ) {
      return 'CK Build IR contains an invalid project file';
    }
    projectPaths.add(file.path);
  }
  const actionIds = new Set();
  const producedPaths = new Set();
  for (const action of ir.graph.actions) {
    if (
      !action || typeof action.id !== 'string' || !action.id
      || typeof action.tool !== 'string' || !action.tool
      || !SHA256.test(action.cacheKey)
      || !Array.isArray(action.dependencies)
      || !Array.isArray(action.inputs)
      || !Array.isArray(action.outputs)
      || !Array.isArray(action.arguments)
      || !action.environment || typeof action.environment !== 'object'
      || !Array.isArray(action.packDependencies)
      || (action.packInputs !== undefined && !Array.isArray(action.packInputs))
      || !['compile', 'archive', 'link', 'transform'].includes(action.kind)
    ) {
      return 'CK Build IR contains an invalid action';
    }
    if (actionIds.has(action.id)) return `CK Build IR contains duplicate action id: ${action.id}`;
    actionIds.add(action.id);
    if (
      action.arguments.some((argument) => typeof argument !== 'string')
      || Object.entries(action.environment).some(([key, value]) => !key || typeof value !== 'string')
      || action.packDependencies.some((id) => typeof id !== 'string' || !id)
    ) {
      return `CK Build IR action ${action.id} contains invalid execution metadata`;
    }
    const packInputIds = new Set();
    for (const input of action.packInputs ?? []) {
      const identity = `${input?.packId ?? ''}\0${input?.artifactId ?? ''}\0${input?.role ?? ''}`;
      if (
        !input || input.kind !== 'pack-artifact'
        || typeof input.packId !== 'string' || !input.packId
        || typeof input.artifactId !== 'string' || !input.artifactId
        || !SHA256.test(input.packRevision) || !SHA256.test(input.sha256)
        || !Number.isSafeInteger(input.packSchema) || input.packSchema < 1
        || (input.role !== undefined && (typeof input.role !== 'string' || !input.role))
        || packRevisions.get(input.packId) !== input.packRevision
        || packInputIds.has(identity)
      ) return `CK Build IR action ${action.id} contains invalid Pack inputs`;
      packInputIds.add(identity);
    }
    if (action.resourceLimits !== undefined && (
      !action.resourceLimits || typeof action.resourceLimits !== 'object' || Array.isArray(action.resourceLimits)
      || ['cpuMs', 'memoryBytes', 'outputBytes'].some((name) => (
        action.resourceLimits[name] !== undefined
        && (!Number.isSafeInteger(action.resourceLimits[name]) || action.resourceLimits[name] <= 0)
      ))
    )) return `CK Build IR action ${action.id} contains invalid resource limits`;
    const dependencyIds = new Set();
    for (const dependency of action.dependencies) {
      if (typeof dependency !== 'string' || !dependency || dependencyIds.has(dependency)) {
        return `CK Build IR action ${action.id} contains invalid dependencies`;
      }
      dependencyIds.add(dependency);
    }
    const inputPaths = new Set();
    for (const input of action.inputs) {
      if (!input || typeof input.path !== 'string' || !isLogicalPath(input.path) || inputPaths.has(input.path)) {
        return `CK Build IR action ${action.id} contains invalid inputs`;
      }
      inputPaths.add(input.path);
      if (input.sha256 !== undefined && !SHA256.test(input.sha256)) return `CK Build IR action ${action.id} input hash is invalid`;
    }
    const outputPaths = new Set();
    for (const output of action.outputs) {
      if (!output || typeof output.path !== 'string' || !isLogicalPath(output.path) || outputPaths.has(output.path)) {
        return `CK Build IR action ${action.id} contains invalid outputs`;
      }
      if (output.sha256 !== undefined && !SHA256.test(output.sha256)) {
        return `CK Build IR action ${action.id} output hash is invalid`;
      }
      outputPaths.add(output.path);
      if (projectPaths.has(output.path) || producedPaths.has(output.path)) {
        return `CK Build IR output has multiple owners: ${output.path}`;
      }
      producedPaths.add(output.path);
    }
    const shapeError = validateActionShape(action, inputPaths, outputPaths);
    if (shapeError) return shapeError;
  }
  const artifactPaths = new Set();
  for (const artifact of ir.artifacts) {
    if (
      !artifact || typeof artifact.path !== 'string' || !isLogicalPath(artifact.path)
      || !TRANSFORM_FORMATS.has(artifact.format)
      || (artifact.offset !== undefined && artifact.offset !== null && typeof artifact.offset !== 'string')
      || artifactPaths.has(artifact.path)
    ) {
      return 'CK Build IR contains an invalid artifact';
    }
    artifactPaths.add(artifact.path);
  }
  const diagnosticEntries = Array.isArray(ir.diagnosticMap)
    ? ir.diagnosticMap
    : ir.diagnosticMap?.entries;
  if (!Array.isArray(diagnosticEntries) || diagnosticEntries.some((entry) => (
    !entry || typeof entry.generatedFile !== 'string' || typeof entry.sourceFile !== 'string'
    || !Number.isSafeInteger(entry.generatedLine) || entry.generatedLine < 1
    || !Number.isSafeInteger(entry.sourceLine) || entry.sourceLine < 1
    || (entry.generatedColumn !== undefined && (!Number.isSafeInteger(entry.generatedColumn) || entry.generatedColumn < 1))
    || (entry.sourceColumn !== undefined && (!Number.isSafeInteger(entry.sourceColumn) || entry.sourceColumn < 1))
  ))) {
    return 'CK Build IR contains an invalid diagnostic map';
  }
  return null;
}

function validateActionShape(action, inputPaths, outputPaths) {
  if (action.kind === 'compile') {
    const unit = action.compileUnit;
    if (
      !unit || typeof unit !== 'object' || !['c', 'c++', 'asm'].includes(unit.language)
      || !isLogicalPath(unit.source) || !isLogicalPath(unit.output)
      || !inputPaths.has(unit.source) || !outputPaths.has(unit.output)
      || !isStringArray(unit.includePaths) || unit.includePaths.some((path) => !isLogicalPath(path))
      || !isStringArray(unit.flags) || !isRecord(unit.macros)
      || Object.values(unit.macros).some((value) => typeof value !== 'string' && typeof value !== 'boolean')
    ) return `CK Build IR action ${action.id} contains an invalid compile unit`;
    return null;
  }
  if (action.kind === 'archive') {
    const archive = action.archive;
    if (
      !archive || typeof archive !== 'object' || !isStringArray(archive.objects)
      || archive.objects.some((path) => !isLogicalPath(path) || !inputPaths.has(path))
      || !isLogicalPath(archive.output) || !outputPaths.has(archive.output)
      || !isStringArray(archive.flags)
    ) return `CK Build IR action ${action.id} contains an invalid archive task`;
    return null;
  }
  if (action.kind === 'link') {
    const link = action.link;
    if (
      !link || typeof link !== 'object' || !isStringArray(link.objects) || !isStringArray(link.archives)
      || [...link.objects, ...link.archives].some((path) => !isLogicalPath(path) || !inputPaths.has(path))
      || !isLogicalPath(link.output) || !outputPaths.has(link.output) || !isStringArray(link.flags)
      || (link.linkerScript !== undefined && (
        !isLogicalPath(link.linkerScript) || !inputPaths.has(link.linkerScript)
      ))
    ) return `CK Build IR action ${action.id} contains an invalid link task`;
    return null;
  }
  const transform = action.transform;
  if (
    !transform || typeof transform !== 'object'
    || !isLogicalPath(transform.input) || !isLogicalPath(transform.output)
    || !outputPaths.has(transform.output) || !TRANSFORM_FORMATS.has(transform.format)
    || !isStringArray(transform.flags)
  ) return `CK Build IR action ${action.id} contains an invalid transform task`;
  if (action.tool === 'ck:preprocess' || action.tool === 'ck:arduino-preprocess') {
    return validateArduinoPreprocessShape(action, transform, inputPaths);
  }
  return null;
}

function validateArduinoPreprocessShape(action, transform, inputPaths) {
  const current = action.inputs.some((input) => input.role === 'sketch-main' || input.role === 'sketch-tab');
  let paths;
  if (current) {
    const main = action.inputs.filter((input) => input.role === 'sketch-main');
    const tabs = action.inputs.filter((input) => input.role === 'sketch-tab')
      .slice()
      .sort((left, right) => compareText(left.path, right.path));
    if (main.length !== 1 || main[0].path !== transform.input
      || main.length + tabs.length !== action.inputs.length
      || tabs.some((input) => input.path === transform.input || !isRootSketchPath(input.path))) {
      return `CK Build IR action ${action.id} contains invalid Arduino sketch inputs`;
    }
    paths = [main[0].path, ...tabs.map((input) => input.path)];
  } else {
    if (action.inputs.length !== 1 || action.inputs[0].path !== transform.input) {
      return `CK Build IR action ${action.id} contains an invalid legacy sketch input`;
    }
    paths = [transform.input];
  }
  if (!inputPaths.has(transform.input) || !isRootSketchPath(transform.input)
    || new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
    return `CK Build IR action ${action.id} contains invalid Arduino sketch paths`;
  }
  const expected = [...paths, '-o', transform.output, ...transform.flags];
  if (expected.length !== action.arguments.length
    || expected.some((value, index) => action.arguments[index] !== value)) {
    return `CK Build IR action ${action.id} contains invalid Arduino preprocess arguments`;
  }
  return null;
}

function isRootSketchPath(path) {
  return typeof path === 'string' && /^[^/\\]+\.ino$/i.test(path);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLogicalPath(path) {
  if (!path || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function topologicalActions(actions) {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const degree = new Map(actions.map((action) => [action.id, action.dependencies.length]));
  const downstream = new Map(actions.map((action) => [action.id, []]));
  for (const action of actions) {
    for (const dependency of action.dependencies) {
      if (!byId.has(dependency)) throw new TypeError(`action ${action.id} references missing dependency ${dependency}`);
      downstream.get(dependency).push(action.id);
    }
  }
  for (const dependents of downstream.values()) dependents.sort(compareText);
  const ready = actions.filter((action) => degree.get(action.id) === 0).map((action) => action.id).sort(compareText);
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    for (const dependent of downstream.get(id)) {
      const next = degree.get(dependent) - 1;
      degree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort(compareText);
      }
    }
  }
  if (ordered.length !== actions.length) {
    const cycle = actions.map((action) => action.id).filter((id) => degree.get(id) > 0).sort(compareText);
    throw new TypeError(`action graph cycle contains ${cycle.join(', ')}`);
  }
  return ordered;
}

function validateGeneratedInputs(actions) {
  const producerByPath = new Map(actions.flatMap((action) => (
    action.outputs.map((output) => [output.path, action.id])
  )));
  const dependencyClosure = new Map();
  for (const action of actions) {
    const dependencies = new Set();
    for (const dependency of action.dependencies) {
      dependencies.add(dependency);
      for (const transitive of dependencyClosure.get(dependency) ?? []) dependencies.add(transitive);
    }
    dependencyClosure.set(action.id, dependencies);
  }
  for (const action of actions) {
    const dependencies = dependencyClosure.get(action.id);
    for (const input of action.inputs) {
      const producer = producerByPath.get(input.path);
      if (producer !== undefined && !dependencies.has(producer)) {
        throw new TypeError(`action ${action.id} reads ${input.path} without depending on ${producer}`);
      }
    }
  }
}

async function runActionWithLimits(runAction, action, context, externalSignal) {
  const controller = new AbortController();
  const cpuMs = action.resourceLimits?.cpuMs;
  let timeoutId;
  let externalAbort;
  const aborted = new Promise((resolve) => {
    if (externalSignal) {
      externalAbort = () => {
        controller.abort();
        resolve({ aborted: true, timedOut: false });
      };
      if (externalSignal.aborted) externalAbort();
      else externalSignal.addEventListener('abort', externalAbort, { once: true });
    }
    if (cpuMs !== undefined) {
      timeoutId = setTimeout(() => {
        controller.abort();
        resolve({ aborted: true, timedOut: true });
      }, cpuMs);
    }
  });
  const running = Promise.resolve()
    .then(() => runAction(action, { ...context, signal: controller.signal }))
    .then((response) => ({ aborted: false, response }));
  try {
    return externalSignal || cpuMs !== undefined
      ? await Promise.race([running, aborted])
      : await running;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (externalSignal && externalAbort) externalSignal.removeEventListener('abort', externalAbort);
  }
}

function verifyOutputLimit(action, outputs) {
  const limit = action.resourceLimits?.outputBytes;
  if (limit === undefined) return null;
  const size = outputs.reduce((total, output) => total + output.bytes.byteLength, 0);
  return size > limit
    ? `action ${action.id} produced ${size} bytes, exceeding its ${limit} byte output limit`
    : null;
}

function verifyMemoryLimit(action, inputBytes, outputBytes, reportedPeakBytes) {
  const limit = action.resourceLimits?.memoryBytes;
  if (limit === undefined) return null;
  if (reportedPeakBytes !== undefined && (
    !Number.isSafeInteger(reportedPeakBytes) || reportedPeakBytes < 0
  )) return `action ${action.id} reported an invalid peak memory value`;
  const controlledBytes = inputBytes + outputBytes;
  const used = Math.max(controlledBytes, reportedPeakBytes ?? 0);
  return used > limit
    ? `action ${action.id} used at least ${used} bytes, exceeding its ${limit} byte memory limit`
    : null;
}

function memoryLimitEvidence(action, inputBytes, outputs, reportedPeakBytes, cached = false) {
  const limitBytes = action.resourceLimits?.memoryBytes;
  if (limitBytes === undefined) return undefined;
  const outputBytes = outputs.reduce((total, output) => total + output.bytes.byteLength, 0);
  const controlledBytes = inputBytes + outputBytes;
  if (reportedPeakBytes === undefined) {
    return {
      status: 'unverified',
      limitBytes,
      controlledBytes,
      reason: cached
        ? 'cache_entry_has_no_peak_memory_evidence'
        : 'runner_did_not_report_peak_memory',
    };
  }
  return {
    status: 'verified',
    limitBytes,
    controlledBytes,
    peakMemoryBytes: reportedPeakBytes,
  };
}

function resourceLimitError(message) {
  const error = new Error(message);
  error.reason = 'resource_limit';
  return error;
}

async function verifyInputs(files, action) {
  for (const input of action.inputs ?? []) {
    const bytes = files.get(input.path);
    if (!bytes) return `action ${action.id} input is missing: ${input.path}`;
    if (input.sha256 !== undefined && (!SHA256.test(input.sha256) || await sha256(bytes) !== input.sha256)) {
      return `action ${action.id} input hash mismatch: ${input.path}`;
    }
  }
  return null;
}

function mapDiagnostics(diagnostics, map) {
  const entries = Array.isArray(map) ? map : (map?.entries ?? []);
  return diagnostics.map((diagnostic) => {
    const match = [...entries]
      .filter((entry) => (
        entry.generatedFile === diagnostic.file
        && entry.generatedLine === diagnostic.line
        && (
          entry.generatedColumn === undefined
          || diagnostic.column === undefined
          || entry.generatedColumn <= diagnostic.column
        )
      ))
      .sort((left, right) => (left.generatedColumn ?? -1) - (right.generatedColumn ?? -1))
      .at(-1);
    if (!match) {
      return {
        ...diagnostic,
        sourceFile: diagnostic.file,
        sourceLine: diagnostic.line,
        ...(diagnostic.column === undefined ? {} : { sourceColumn: diagnostic.column }),
        fromGenerated: false,
      };
    }
    const { column: generatedColumn, ...generatedDiagnostic } = diagnostic;
    return {
      ...generatedDiagnostic,
      file: match.sourceFile,
      line: match.sourceLine,
      ...(match.sourceColumn === undefined ? {} : { column: match.sourceColumn }),
      generatedFile: diagnostic.file,
      generatedLine: diagnostic.line,
      ...(generatedColumn === undefined ? {} : { generatedColumn }),
      sourceFile: match.sourceFile,
      sourceLine: match.sourceLine,
      ...(match.sourceColumn === undefined ? {} : { sourceColumn: match.sourceColumn }),
      fromGenerated: true,
    };
  });
}

function normalizeDiagnostics(value, action) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`action ${action.id} returned invalid diagnostics`);
  return value.map((diagnostic) => {
    if (!diagnostic || typeof diagnostic !== 'object') {
      throw new TypeError(`action ${action.id} returned an invalid diagnostic`);
    }
    const severity = diagnostic.severity === 'note'
      ? 'info'
      : diagnostic.severity === 'fatal error'
        ? 'error'
        : diagnostic.severity;
    if (!['error', 'warning', 'info'].includes(severity)) {
      throw new TypeError(`action ${action.id} returned an invalid diagnostic severity`);
    }
    if (
      typeof diagnostic.file !== 'string'
      || !Number.isSafeInteger(diagnostic.line) || diagnostic.line < 1
      || (diagnostic.column !== undefined && (!Number.isSafeInteger(diagnostic.column) || diagnostic.column < 1))
      || typeof diagnostic.message !== 'string' || !diagnostic.message
      || (diagnostic.raw !== undefined && typeof diagnostic.raw !== 'string')
    ) {
      throw new TypeError(`action ${action.id} returned an invalid diagnostic`);
    }
    return {
      severity,
      file: normalizeDiagnosticPath(diagnostic.file),
      line: diagnostic.line,
      ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
      message: diagnostic.message,
      ...(diagnostic.raw === undefined ? {} : { raw: diagnostic.raw }),
    };
  });
}

function utf8(value) {
  return typeof value === 'string' ? new TextEncoder().encode(value) : cloneBytes(value);
}

function cloneBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  return null;
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function browserActionCacheKey(actionKey, adapterPolicyVersion) {
  return sha256(utf8([
    CK_BROWSER_WASM_EXECUTOR_CACHE_POLICY,
    adapterPolicyVersion,
    actionKey,
  ].join('\0')));
}

function failure(reason, message, actions, started, actionId, diagnostics = []) {
  return {
    status: 'error', executor: 'browser-wasm',
    ...(actionId === undefined ? {} : { actionId }), reason, message, actions,
    diagnostics, durationMs: Math.max(0, now() - started),
  };
}

function normalizeFailureReason(value) {
  return FAILURE_REASONS.has(value) ? value : 'compile';
}

function cloneEntry(entry) {
  return {
    actionKey: entry.actionKey,
    outputs: entry.outputs.map((output) => ({ ...output, bytes: cloneBytes(output.bytes) })),
    ...(entry.diagnostics === undefined
      ? {}
      : { diagnostics: entry.diagnostics.map((diagnostic) => ({ ...diagnostic })) }),
    ...(entry.peakMemoryBytes === undefined ? {} : { peakMemoryBytes: entry.peakMemoryBytes }),
  };
}

function actionCacheLimits(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Action cache limits must be an object');
  }
  const limits = {};
  for (const [name, fallback] of Object.entries(DEFAULT_ACTION_CACHE_LIMITS)) {
    const value = options[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Action cache ${name} must be a positive safe integer`);
    }
    limits[name] = value;
  }
  return Object.freeze(limits);
}

function actionCacheEntryBytes(entry) {
  let bytes = utf8ByteLength(entry.actionKey ?? '');
  for (const output of entry.outputs ?? []) {
    bytes += utf8ByteLength(output?.path ?? '') + utf8ByteLength(output?.sha256 ?? '');
    bytes += cloneBytes(output?.bytes)?.byteLength ?? 0;
  }
  if (entry.diagnostics !== undefined) bytes += utf8ByteLength(JSON.stringify(entry.diagnostics));
  if (entry.peakMemoryBytes !== undefined) bytes += 16;
  return bytes;
}

function actionCacheUrl(key) {
  return `https://ck.invalid/${encodeURIComponent(key)}`;
}

function utf8ByteLength(value) {
  return utf8(String(value)).byteLength;
}

function encodeCacheEntry(entry) {
  return {
    actionKey: entry.actionKey,
    outputs: entry.outputs.map((output) => ({
      path: output.path,
      sha256: output.sha256,
      bytes: bytesToBase64(output.bytes),
    })),
    ...(entry.diagnostics === undefined
      ? {}
      : { diagnostics: entry.diagnostics.map((diagnostic) => ({ ...diagnostic })) }),
    ...(entry.peakMemoryBytes === undefined ? {} : { peakMemoryBytes: entry.peakMemoryBytes }),
  };
}

function decodeCacheEntry(value) {
  if (!value || typeof value !== 'object' || typeof value.actionKey !== 'string' || !Array.isArray(value.outputs)) return null;
  return {
    actionKey: value.actionKey,
    outputs: value.outputs.map((output) => ({
      path: output.path,
      sha256: output.sha256,
      bytes: base64ToBytes(output.bytes),
    })),
    ...(value.diagnostics === undefined
      ? {}
      : { diagnostics: value.diagnostics.map((diagnostic) => ({ ...diagnostic })) }),
    ...(value.peakMemoryBytes === undefined ? {} : { peakMemoryBytes: value.peakMemoryBytes }),
  };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== 'string') throw new TypeError('cached Action bytes are invalid');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDiagnosticPath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function now() {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}
