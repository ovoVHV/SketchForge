import {
  loadStoredCompileRecord,
  normalizeStoredCompile,
} from './compile-recovery.js';

export const ACTIVE_COMPILE_DB_NAME = 'arduinofast-recovery';
export const ACTIVE_COMPILE_DB_VERSION = 1;
export const ACTIVE_COMPILE_STORE_NAME = 'active-compiles';
export const ACTIVE_COMPILE_RECORD_KEY = 'current';
export const ACTIVE_COMPILE_TAB_ID_KEY = 'arduinofast.active-compile.tab.v1';
export const LEGACY_ACTIVE_COMPILE_STORAGE_KEY = 'arduinofast.active-compile.v1';

function validRecordKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
}

export function activeCompileRecordKey(tabId) {
  if (!validRecordKey(tabId)) throw new TypeError('Invalid active compile tab ID');
  return `tab:${tabId}`;
}

export function activeCompileTabId(storage, createId = () => (
  globalThis.crypto?.randomUUID?.()
    ?? `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
)) {
  try {
    const existing = storage?.getItem?.(ACTIVE_COMPILE_TAB_ID_KEY);
    if (validRecordKey(existing)) return existing;
    const created = String(createId?.() ?? '');
    if (!validRecordKey(created)) throw new Error('Unable to create active compile tab ID');
    storage?.setItem?.(ACTIVE_COMPILE_TAB_ID_KEY, created);
    return created;
  } catch {
    const created = String(createId?.() ?? '');
    if (!validRecordKey(created)) throw new Error('Unable to create active compile tab ID');
    return created;
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

function safeStorageRecord(storage, key) {
  return loadStoredCompileRecord(storage, key);
}

function recordTimestamp(record) {
  return record?.savedAt ?? record?.startedAt ?? 0;
}

function recordAcceptanceEpoch(record) {
  return Number.isSafeInteger(record?.acceptanceEpoch) && record.acceptanceEpoch >= 0
    ? record.acceptanceEpoch
    : null;
}

function compareRecordFreshness(left, right) {
  const leftEpoch = recordAcceptanceEpoch(left);
  const rightEpoch = recordAcceptanceEpoch(right);
  if (leftEpoch !== null && rightEpoch !== null && leftEpoch !== rightEpoch) {
    return leftEpoch - rightEpoch;
  }
  if (leftEpoch !== rightEpoch) {
    // Any newly accepted record carries a logical epoch; it must not lose to
    // a legacy record merely because the wall clock moved backwards.
    return leftEpoch === null ? -1 : 1;
  }
  if (left?.jobId !== right?.jobId) {
    const acceptanceDifference = (left?.acceptedAt ?? left?.startedAt ?? 0)
      - (right?.acceptedAt ?? right?.startedAt ?? 0);
    if (acceptanceDifference !== 0) return acceptanceDifference;
  }
  const timestampDifference = recordTimestamp(left) - recordTimestamp(right);
  if (timestampDifference !== 0) return timestampDifference;
  if (left?.acceptanceId !== right?.acceptanceId) {
    return String(left?.acceptanceId ?? '').localeCompare(String(right?.acceptanceId ?? ''));
  }
  return String(left?.jobId ?? '').localeCompare(String(right?.jobId ?? ''));
}

function newestRecord(records) {
  return records.filter(Boolean).reduce((latest, candidate) => (
    !latest || compareRecordFreshness(candidate, latest) > 0 ? candidate : latest
  ), null);
}

function removeStorageRecord(storage, key, predicate) {
  const saved = safeStorageRecord(storage, key);
  if (!saved || !predicate(saved)) return false;
  try {
    storage?.removeItem?.(key);
    return true;
  } catch {
    return false;
  }
}

function writeStorageRecord(storage, key, record) {
  try {
    storage?.setItem?.(key, JSON.stringify(record));
    return typeof storage?.setItem === 'function';
  } catch {
    return false;
  }
}

/**
 * Small IndexedDB adapter. Each operation owns one transaction; deletion is a
 * compare-and-delete so an old job cannot remove a newer accepted job.
 */
export function createIndexedDbActiveCompileStore(
  indexedDb = globalThis.indexedDB,
  recordKey = ACTIVE_COMPILE_RECORD_KEY,
) {
  if (!validRecordKey(recordKey)) throw new TypeError('Invalid active compile record key');
  let opening = null;
  let openedDatabase = null;

  function forgetDatabase(database) {
    if (openedDatabase === database) openedDatabase = null;
    opening = null;
  }

  function openDatabase() {
    if (!indexedDb || typeof indexedDb.open !== 'function') {
      return Promise.reject(new Error('IndexedDB is unavailable'));
    }
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let request;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      try {
        request = indexedDb.open(ACTIVE_COMPILE_DB_NAME, ACTIVE_COMPILE_DB_VERSION);
      } catch (error) {
        fail(error);
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(ACTIVE_COMPILE_STORE_NAME)) {
          database.createObjectStore(ACTIVE_COMPILE_STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        settled = true;
        openedDatabase = database;
        database.onversionchange = () => {
          database.close();
          forgetDatabase(database);
        };
        // IDBDatabase exposes `close` in current browsers when the user agent
        // closes a connection unexpectedly (storage eviction, profile reset,
        // etc.).  Forget the cached promise so the next operation reopens it.
        if ('onclose' in database) database.onclose = () => forgetDatabase(database);
        resolve(database);
      };
      request.onerror = () => fail(request.error ?? new Error('Unable to open IndexedDB'));
      request.onblocked = () => fail(new Error('IndexedDB upgrade is blocked'));
    }).catch((error) => {
      opening = null;
      throw error;
    });
    return opening;
  }

  async function transaction(mode) {
    const database = await openDatabase();
    try {
      const value = database.transaction(ACTIVE_COMPILE_STORE_NAME, mode);
      return {
        database,
        store: value.objectStore(ACTIVE_COMPILE_STORE_NAME),
        done: transactionDone(value),
      };
    } catch (error) {
      forgetDatabase(database);
      throw error;
    }
  }

  return Object.freeze({
    async get() {
      const { database, store, done } = await transaction('readonly');
      try {
        const [row] = await Promise.all([
          requestResult(store.get(recordKey)),
          done,
        ]);
        return row?.record ?? null;
      } catch (error) {
        forgetDatabase(database);
        throw error;
      }
    },

    async put(record) {
      const database = await openDatabase();
      try {
        const value = database.transaction(ACTIVE_COMPILE_STORE_NAME, 'readwrite');
        const store = value.objectStore(ACTIVE_COMPILE_STORE_NAME);
        let outcome = { written: false, record: null };
        const current = store.get(recordKey);
        current.onsuccess = () => {
          const saved = normalizeStoredCompile(current.result?.record);
          if (saved && compareRecordFreshness(saved, record) > 0) {
            outcome = { written: false, record: saved };
            return;
          }
          outcome = { written: true, record };
          try {
            store.put({ key: recordKey, record });
          } catch {
            try { value.abort(); } catch { /* transaction already failed */ }
          }
        };
        current.onerror = () => {
          try { value.abort(); } catch { /* transaction already failed */ }
        };
        await transactionDone(value);
        return outcome;
      } catch (error) {
        forgetDatabase(database);
        throw error;
      }
    },

    async deleteIfJobId(jobId, acceptanceId = undefined) {
      const database = await openDatabase();
      try {
        const value = database.transaction(ACTIVE_COMPILE_STORE_NAME, 'readwrite');
        const store = value.objectStore(ACTIVE_COMPILE_STORE_NAME);
        let deleted = false;
        const current = store.get(recordKey);
        current.onsuccess = () => {
          const record = normalizeStoredCompile(current.result?.record);
          if (record?.jobId !== jobId) return;
          if (acceptanceId !== undefined && record.acceptanceId !== acceptanceId) return;
          deleted = true;
          try {
            store.delete(recordKey);
          } catch {
            try { value.abort(); } catch { /* transaction already failed */ }
          }
        };
        current.onerror = () => {
          try { value.abort(); } catch { /* transaction already failed */ }
        };
        await transactionDone(value);
        return deleted;
      } catch (error) {
        forgetDatabase(database);
        throw error;
      }
    },

    async delete() {
      const { database, store, done } = await transaction('readwrite');
      try {
        store.delete(recordKey);
        await done;
      } catch (error) {
        forgetDatabase(database);
        throw error;
      }
    },
  });
}

/**
 * Coordinates durable IndexedDB storage with legacy migration and a
 * tab-scoped fallback. Mutations are serialized and generation guarded.
 */
export function createActiveCompilePersistence({
  durable = createIndexedDbActiveCompileStore(),
  fallbackStorage = null,
  legacyStorages = [],
  legacyKey = LEGACY_ACTIVE_COMPILE_STORAGE_KEY,
  legacyKeys = [],
  legacyDurables = [],
  logger = console,
  onStatus = () => {},
  now = () => Date.now(),
} = {}) {
  const storages = [...new Set([...legacyStorages, fallbackStorage].filter(Boolean))];
  const allLegacyKeys = [...new Set([legacyKey, ...legacyKeys].filter((key) => validRecordKey(key)))];
  const oldDurables = [...legacyDurables].filter(Boolean);
  let generation = 0;
  let lastSavedAt = 0;
  let lastAcceptanceEpoch = 0;
  let memoryRecord = null;
  let mutationTail = Promise.resolve();

  function emit(event) {
    try { onStatus(Object.freeze(event)); } catch { /* observers are optional */ }
    if (event.error) {
      try {
        logger?.warn?.(
          `[ArduinoFast] Active compile ${event.operation} is not durable; using ${event.persistence}.`,
          event.error,
        );
      } catch { /* logging must not affect recovery */ }
    }
    return event;
  }

  function removeLegacyAtOrBefore(record) {
    for (const key of allLegacyKeys) {
      for (const storage of storages) {
        removeStorageRecord(storage, key, (saved) => compareRecordFreshness(saved, record) <= 0);
      }
    }
  }

  function removeLegacyJob(jobId, acceptanceId) {
    for (const key of allLegacyKeys) {
      for (const storage of storages) {
        removeStorageRecord(storage, key, (saved) => saved.jobId === jobId
          && (acceptanceId === undefined
            || saved.acceptanceId === acceptanceId
            || saved.acceptanceId === undefined));
      }
    }
  }

  function newAcceptanceId() {
    try {
      const id = globalThis.crypto?.randomUUID?.();
      if (validRecordKey(id)) return id;
    } catch { /* fall through */ }
    return `acceptance-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function legacyRecords() {
    return storages.flatMap((storage) => allLegacyKeys
      .map((key) => safeStorageRecord(storage, key))
      .filter(Boolean));
  }

  function queueMutation(operation) {
    const token = ++generation;
    const queued = mutationTail.then(
      () => operation(token),
      () => operation(token),
    );
    mutationTail = queued.catch(() => {});
    return queued;
  }

  function stale(operation) {
    return emit({ operation, persistence: 'memory', durable: false, stale: true });
  }

  async function persist(record, operation = 'put') {
    const normalized = normalizeStoredCompile(record);
    if (!normalized) throw new TypeError('Invalid active compile recovery record');
    const suppliedEpoch = recordAcceptanceEpoch(normalized);
    const acceptanceEpoch = suppliedEpoch ?? Math.max(
      lastAcceptanceEpoch + 1,
      Number.isFinite(now()) ? Math.max(0, Math.floor(now())) : 0,
    );
    lastAcceptanceEpoch = Math.max(lastAcceptanceEpoch, acceptanceEpoch);
    const acceptanceId = normalized.acceptanceId ?? newAcceptanceId();
    const savedAt = Math.max(now(), normalized.savedAt ?? 0, lastSavedAt + 1);
    lastSavedAt = savedAt;
    const next = Object.freeze({ ...normalized, acceptanceId, acceptanceEpoch, savedAt });
    memoryRecord = next;

    return queueMutation(async (token) => {
      if (token !== generation) return stale(operation);
      try {
        const outcome = await durable.put(next);
        if (token !== generation) return stale(operation);
        if (outcome?.written === false) {
          const winner = normalizeStoredCompile(outcome.record) ?? next;
          memoryRecord = winner;
          removeLegacyAtOrBefore(winner);
          return emit({
            operation,
            persistence: 'indexeddb',
            durable: true,
            stale: true,
            superseded: true,
            record: winner,
          });
        }
        removeLegacyAtOrBefore(next);
        return emit({ operation, persistence: 'indexeddb', durable: true, record: next });
      } catch (error) {
        if (token !== generation) return stale(operation);
        const persistedForSession = writeStorageRecord(fallbackStorage, legacyKey, next);
        return emit({
          operation,
          persistence: persistedForSession ? 'session' : 'memory',
          durable: false,
          record: next,
          error,
        });
      }
    });
  }

  async function load() {
    await mutationTail;
    const readGeneration = generation;
    let durableRecord = null;
    let durableError = null;
    let oldDurableRecords = [];
    try {
      durableRecord = normalizeStoredCompile(await durable.get());
    } catch (error) {
      durableError = error;
    }
    for (const oldDurable of oldDurables) {
      try {
        const candidate = normalizeStoredCompile(await oldDurable.get());
        if (candidate) oldDurableRecords.push(candidate);
      } catch (error) {
        durableError ??= error;
      }
    }
    if (readGeneration !== generation) {
      emit({ operation: 'load', persistence: 'memory', durable: false, stale: true });
      return memoryRecord;
    }

    const oldRecords = legacyRecords();
    const selected = newestRecord([memoryRecord, durableRecord, ...oldDurableRecords, ...oldRecords]);
    if (!selected) {
      if (durableError) {
        emit({ operation: 'load', persistence: 'memory', durable: false, error: durableError });
      } else {
        emit({ operation: 'load', persistence: 'none', durable: true });
      }
      return null;
    }

    lastSavedAt = Math.max(lastSavedAt, recordTimestamp(selected));
    lastAcceptanceEpoch = Math.max(lastAcceptanceEpoch, recordAcceptanceEpoch(selected) ?? 0);
    memoryRecord = selected;
    if (durableRecord && compareRecordFreshness(durableRecord, selected) === 0) {
      removeLegacyAtOrBefore(selected);
      emit({ operation: 'load', persistence: 'indexeddb', durable: true, record: selected });
      return selected;
    }

    if (durableError) {
      emit({
        operation: 'load',
        persistence: oldRecords.includes(selected) ? 'legacy' : 'memory',
        durable: false,
        record: selected,
        error: durableError,
      });
      return selected;
    }

    const migration = await persist(selected, 'migrate');
    if (!migration.stale && migration.durable) {
      for (const oldDurable of oldDurables) {
        try {
          await oldDurable.deleteIfJobId(selected.jobId, selected.acceptanceId);
        } catch { /* old store cleanup is best effort */ }
      }
    }
    return migration.stale ? memoryRecord : migration.record ?? selected;
  }

  async function deleteJob(jobId, acceptanceId = undefined) {
    if (typeof jobId !== 'string' || !jobId) return false;
    if (memoryRecord?.jobId === jobId
      && (acceptanceId === undefined || memoryRecord.acceptanceId === acceptanceId)) memoryRecord = null;
    return queueMutation(async (token) => {
      if (token !== generation) return stale('delete');
      let durableError = null;
      let deleted = false;
      try {
        deleted = await durable.deleteIfJobId(jobId, acceptanceId);
      } catch (error) {
        durableError = error;
      }
      if (token !== generation) return stale('delete');
      removeLegacyJob(jobId, acceptanceId);
      emit({
        operation: 'delete',
        persistence: durableError ? 'memory' : 'indexeddb',
        durable: !durableError,
        deleted,
        ...(durableError ? { error: durableError } : {}),
      });
      return deleted;
    });
  }

  return Object.freeze({
    load,
    put: persist,
    delete: deleteJob,
  });
}
