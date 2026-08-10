import { describe, expect, it, vi } from 'vitest';

import {
  ACTIVE_COMPILE_DB_NAME,
  ACTIVE_COMPILE_DB_VERSION,
  ACTIVE_COMPILE_RECORD_KEY,
  ACTIVE_COMPILE_STORAGE_KEY,
  ACTIVE_COMPILE_STORE_NAME,
  LEGACY_ACTIVE_COMPILE_DB_NAME,
  LEGACY_ACTIVE_COMPILE_TAB_ID_KEY,
  LEGACY_ACTIVE_COMPILE_STORAGE_KEY,
  activeCompileRecordKey,
  activeCompileTabId,
  createActiveCompilePersistence,
  createIndexedDbActiveCompileStore,
} from '../public/active-compile-storage.js';

type CompileRecord = ReturnType<typeof compileRecord> & {
  schemaVersion?: number;
  savedAt?: number;
};

function compileRecord(jobId = 'job-1', startedAt = 1, content = 'void setup() {}') {
  return {
    jobId,
    stream: `/v1/compile/${jobId}/events`,
    startedAt,
    context: {
      source: content,
      files: [{ name: 'main.ino', content }],
      activeFile: 'main.ino',
      board: 'esp32:esp32:esp32c3',
      options: {},
      libraries: [],
      buildOptions: {},
    },
  };
}

function memoryStorage(seed: Record<string, string> = {}, failWrites = false) {
  const values = new Map(Object.entries(seed));
  const writes: Array<{ key: string; value: string }> = [];
  const removes: string[] = [];
  return {
    values,
    writes,
    removes,
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (failWrites) throw new Error('quota exceeded');
      writes.push({ key, value });
      values.set(key, value);
    },
    removeItem(key: string) {
      removes.push(key);
      values.delete(key);
    },
  };
}

function memoryDurable(initial: CompileRecord | null = null) {
  let current = initial;
  return {
    get current() { return current; },
    async get() { return current; },
    async put(record: CompileRecord) {
      current = structuredClone(record);
      return { written: true, record: current };
    },
    async deleteIfJobId(jobId: string, acceptanceId?: string) {
      if (current?.jobId !== jobId) return false;
      if (acceptanceId !== undefined && current.acceptanceId !== acceptanceId) return false;
      current = null;
      return true;
    },
    async delete() { current = null; },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakeIndexedDb() {
  const rows = new Map<string, unknown>();
  const metadata = { name: '', version: 0, storeName: '', keyPath: '' };
  let hasStore = false;

  function createTransaction() {
    let pending = 0;
    let completionScheduled = false;
    let finished = false;
    const transaction: any = {
      oncomplete: null,
      onabort: null,
      onerror: null,
    };

    const maybeComplete = () => {
      if (pending !== 0 || completionScheduled || finished) return;
      completionScheduled = true;
      setTimeout(() => {
        completionScheduled = false;
        if (pending !== 0 || finished) return;
        finished = true;
        transaction.oncomplete?.();
      }, 0);
    };

    const request = (operation: () => unknown) => {
      pending += 1;
      const value: any = { result: undefined, error: null, onsuccess: null, onerror: null };
      setTimeout(() => {
        if (finished) return;
        try {
          value.result = operation();
          value.onsuccess?.();
          pending -= 1;
          maybeComplete();
        } catch (error) {
          value.error = error;
          value.onerror?.();
          transaction.abort();
        }
      }, 0);
      return value;
    };

    const store = {
      get(key: string) {
        return request(() => structuredClone(rows.get(key)));
      },
      put(row: { key: string }) {
        return request(() => {
          rows.set(row.key, structuredClone(row));
          return row.key;
        });
      },
      delete(key: string) {
        return request(() => rows.delete(key));
      },
    };
    transaction.objectStore = (name: string) => {
      if (name !== ACTIVE_COMPILE_STORE_NAME || !hasStore) throw new Error('missing store');
      return store;
    };
    transaction.abort = () => {
      if (finished) return;
      finished = true;
      transaction.onabort?.();
    };
    maybeComplete();
    return transaction;
  }

  const database: any = {
    objectStoreNames: { contains: (name: string) => hasStore && name === ACTIVE_COMPILE_STORE_NAME },
    createObjectStore(name: string, options: { keyPath: string }) {
      hasStore = true;
      metadata.storeName = name;
      metadata.keyPath = options.keyPath;
      return {};
    },
    transaction: () => createTransaction(),
    close: vi.fn(),
    onversionchange: null,
  };

  const factory = {
    open(name: string, version: number) {
      metadata.name = name;
      metadata.version = version;
      const request: any = {
        result: database,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      setTimeout(() => {
        if (!hasStore) request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  return { factory, metadata, rows };
}

describe('IndexedDB active compile persistence', () => {
  it('uses a stable per-tab ID to isolate IndexedDB records', () => {
    const storage = memoryStorage();
    let created = 0;
    const first = activeCompileTabId(storage, () => `tab-${++created}`);

    expect(activeCompileTabId(storage, () => `tab-${++created}`)).toBe(first);
    expect(activeCompileRecordKey(first)).toBe(`tab:${first}`);
    expect(activeCompileRecordKey('other-tab')).not.toBe(activeCompileRecordKey(first));
    expect(created).toBe(1);
  });

  it('migrates a legacy tab ID into the current tab key', () => {
    const storage = memoryStorage({
      [LEGACY_ACTIVE_COMPILE_TAB_ID_KEY]: 'legacy-tab',
    });

    expect(activeCompileTabId(storage)).toBe('legacy-tab');
    expect(storage.values.get('sketchforge.active-compile.tab.v1')).toBe('legacy-tab');
    expect(storage.values.has(LEGACY_ACTIVE_COMPILE_TAB_ID_KEY)).toBe(false);
  });

  it('uses the declared IndexedDB schema and atomic replace/delete policy', async () => {
    const fake = fakeIndexedDb();
    const store = createIndexedDbActiveCompileStore(fake.factory as any);
    const old = {
      ...compileRecord('job-a', 1),
      schemaVersion: 2,
      acceptedAt: 10,
      savedAt: 10,
    };
    const current = {
      ...compileRecord('job-b', 2),
      schemaVersion: 2,
      acceptedAt: 20,
      savedAt: 20,
    };

    await expect(store.put(old)).resolves.toMatchObject({ written: true });
    await expect(store.put(current)).resolves.toMatchObject({ written: true });
    await expect(store.put({ ...old, savedAt: 30 })).resolves.toMatchObject({
      written: false,
      record: { jobId: 'job-b' },
    });
    await expect(store.get()).resolves.toMatchObject({ jobId: 'job-b' });
    await expect(store.deleteIfJobId('job-a')).resolves.toBe(false);
    await expect(store.deleteIfJobId('job-b')).resolves.toBe(true);
    await expect(store.get()).resolves.toBeNull();

    expect(fake.metadata).toEqual({
      name: ACTIVE_COMPILE_DB_NAME,
      version: ACTIVE_COMPILE_DB_VERSION,
      storeName: ACTIVE_COMPILE_STORE_NAME,
      keyPath: 'key',
    });
    expect(fake.rows.has(ACTIVE_COMPILE_RECORD_KEY)).toBe(false);
  });

  it('opens the renamed and legacy IndexedDB namespaces separately', async () => {
    const fake = fakeIndexedDb();
    const current = createIndexedDbActiveCompileStore(fake.factory as any);
    const legacy = createIndexedDbActiveCompileStore(
      fake.factory as any,
      ACTIVE_COMPILE_RECORD_KEY,
      LEGACY_ACTIVE_COMPILE_DB_NAME,
    );

    await legacy.put(compileRecord('legacy-db-job', 3));
    await expect(legacy.get()).resolves.toMatchObject({ jobId: 'legacy-db-job' });
    await expect(current.get()).resolves.toBeNull();
    expect(fake.metadata.name).toBe(LEGACY_ACTIVE_COMPILE_DB_NAME);
  });

  it('stores a record larger than 2 MiB without writing the payload to Web Storage', async () => {
    const content = `void setup() {}\n/*${'x'.repeat(2 * 1024 * 1024)}*/`;
    const record = compileRecord('large-job', 10, content);
    expect(JSON.stringify(record).length).toBeGreaterThan(2 * 1024 * 1024);

    const durable = memoryDurable();
    const session = memoryStorage({}, true);
    const persistence = createActiveCompilePersistence({
      durable,
      fallbackStorage: session,
      now: () => 100,
    });

    await expect(persistence.put(record)).resolves.toMatchObject({
      persistence: 'indexeddb',
      durable: true,
    });
    expect(durable.current?.context.files[0].content).toBe(content);
    expect(session.writes).toHaveLength(0);
  });

  it('migrates a legacy localStorage record once and removes the old large-value key', async () => {
    const legacy = compileRecord('legacy-job', 20);
    const local = memoryStorage({
      [LEGACY_ACTIVE_COMPILE_STORAGE_KEY]: JSON.stringify(legacy),
    });
    const session = memoryStorage();
    const durable = memoryDurable();
    const statuses: Array<Record<string, unknown>> = [];
    const persistence = createActiveCompilePersistence({
      durable,
      fallbackStorage: session,
      legacyStorages: [local, session],
      onStatus: (status) => statuses.push(status),
      now: () => 200,
    });

    await expect(persistence.load()).resolves.toMatchObject({
      schemaVersion: 2,
      jobId: 'legacy-job',
    });
    expect(durable.current).toMatchObject({ jobId: 'legacy-job', savedAt: 200 });
    expect(local.values.has(LEGACY_ACTIVE_COMPILE_STORAGE_KEY)).toBe(false);
    expect(local.removes).toEqual([LEGACY_ACTIVE_COMPILE_STORAGE_KEY]);
    expect(statuses.some((status) => status.operation === 'migrate')).toBe(true);

    const restarted = createActiveCompilePersistence({ durable, legacyStorages: [local] });
    await expect(restarted.load()).resolves.toMatchObject({ jobId: 'legacy-job' });
    expect(local.removes).toHaveLength(1);
  });

  it('reads an old fallback key and writes only the current fallback key when durable storage fails', async () => {
    const legacy = compileRecord('legacy-fallback-job', 21);
    const session = memoryStorage({
      [LEGACY_ACTIVE_COMPILE_STORAGE_KEY]: JSON.stringify(legacy),
    });
    const durableError = new Error('IndexedDB blocked');
    const durable = {
      async get() { throw durableError; },
      async put() { throw durableError; },
      async deleteIfJobId() { throw durableError; },
    };
    const persistence = createActiveCompilePersistence({
      durable,
      fallbackStorage: session,
      legacyStorages: [session],
      now: () => 220,
    });

    await expect(persistence.load()).resolves.toMatchObject({ jobId: 'legacy-fallback-job' });
    expect(session.writes.map(({ key }) => key)).toContain(ACTIVE_COMPILE_STORAGE_KEY);
    expect(session.values.has(LEGACY_ACTIVE_COMPILE_STORAGE_KEY)).toBe(false);
    expect(session.values.has(ACTIVE_COMPILE_STORAGE_KEY)).toBe(true);
  });

  it('falls back to sessionStorage when IndexedDB fails and reports the loss of durability', async () => {
    const error = new Error('IndexedDB blocked');
    const durable = {
      async get() { throw error; },
      async put() { throw error; },
      async deleteIfJobId() { throw error; },
    };
    const session = memoryStorage();
    const logger = { warn: vi.fn() };
    const statuses: Array<Record<string, unknown>> = [];
    const persistence = createActiveCompilePersistence({
      durable,
      fallbackStorage: session,
      logger,
      onStatus: (status) => statuses.push(status),
      now: () => 300,
    });

    await expect(persistence.put(compileRecord('session-job', 30))).resolves.toMatchObject({
      persistence: 'session',
      durable: false,
      error,
    });
    expect(session.values.has(ACTIVE_COMPILE_STORAGE_KEY)).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
    expect(statuses.at(-1)).toMatchObject({ operation: 'put', persistence: 'session' });

    const restarted = createActiveCompilePersistence({
      durable,
      fallbackStorage: session,
      logger,
    });
    await expect(restarted.load()).resolves.toMatchObject({ jobId: 'session-job' });
  });

  it('does not let a stale async put overwrite a newer accepted job', async () => {
    let current: CompileRecord | null = null;
    const pending: Array<{ record: CompileRecord; gate: ReturnType<typeof deferred> }> = [];
    const durable = {
      async get() { return current; },
      put(record: CompileRecord) {
        const gate = deferred();
        pending.push({ record, gate });
        return gate.promise.then(() => {
          current = record;
          return { written: true, record };
        });
      },
      async deleteIfJobId(jobId: string) {
        if (current?.jobId !== jobId) return false;
        current = null;
        return true;
      },
    };
    let clock = 400;
    const persistence = createActiveCompilePersistence({ durable, now: () => clock++ });

    const oldWrite = persistence.put(compileRecord('job-a', 40));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const newWrite = persistence.put(compileRecord('job-b', 41));
    pending[0].gate.resolve();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].gate.resolve();

    await expect(oldWrite).resolves.toMatchObject({ stale: true });
    await expect(newWrite).resolves.toMatchObject({ persistence: 'indexeddb' });
    expect(current?.jobId).toBe('job-b');
  });

  it('does not let a stale delete remove a newer accepted job', async () => {
    let current: CompileRecord | null = null;
    const deleteStarted = deferred();
    const deleteGate = deferred();
    const durable = {
      async get() { return current; },
      async put(record: CompileRecord) {
        current = record;
        return { written: true, record };
      },
      async deleteIfJobId(jobId: string) {
        deleteStarted.resolve();
        await deleteGate.promise;
        if (current?.jobId !== jobId) return false;
        current = null;
        return true;
      },
    };
    let clock = 500;
    const persistence = createActiveCompilePersistence({ durable, now: () => clock++ });
    await persistence.put(compileRecord('job-a', 50));

    const oldDelete = persistence.delete('job-a');
    await deleteStarted.promise;
    const newWrite = persistence.put(compileRecord('job-b', 51));
    deleteGate.resolve();

    await expect(oldDelete).resolves.toMatchObject({ stale: true });
    await newWrite;
    expect(current?.jobId).toBe('job-b');
  });

  it('prefers a newer session fallback over an older durable record on restart', async () => {
    const oldDurable = { ...compileRecord('job-a', 90), schemaVersion: 2, savedAt: 900 };
    const newerSession = { ...compileRecord('job-b', 91), schemaVersion: 2, savedAt: 901 };
    const durable = memoryDurable(oldDurable);
    const session = memoryStorage({
      [LEGACY_ACTIVE_COMPILE_STORAGE_KEY]: JSON.stringify(newerSession),
    });
    const persistence = createActiveCompilePersistence({
      durable,
      fallbackStorage: session,
      now: () => 902,
    });

    await expect(persistence.load()).resolves.toMatchObject({ jobId: 'job-b' });
    expect(durable.current?.jobId).toBe('job-b');
    expect(session.values.has(ACTIVE_COMPILE_STORAGE_KEY)).toBe(false);
  });

  it('discards a stale async load when a newer accepted job arrives', async () => {
    const readGate = deferred<CompileRecord | null>();
    let current: CompileRecord | null = compileRecord('job-a', 60);
    let firstRead = true;
    const durable = {
      get() {
        if (firstRead) {
          firstRead = false;
          return readGate.promise;
        }
        return Promise.resolve(current);
      },
      async put(record: CompileRecord) {
        current = record;
        return { written: true, record };
      },
      async deleteIfJobId(jobId: string) {
        if (current?.jobId !== jobId) return false;
        current = null;
        return true;
      },
    };
    const persistence = createActiveCompilePersistence({ durable, now: () => 600 });
    const loading = persistence.load();
    await Promise.resolve();
    const writing = persistence.put(compileRecord('job-b', 61));
    readGate.resolve(compileRecord('job-a', 60));

    await expect(loading).resolves.toMatchObject({ jobId: 'job-b' });
    await writing;
    expect(current?.jobId).toBe('job-b');
  });

  it('restores an IndexedDB record after a page-style persistence restart', async () => {
    const durable = memoryDurable();
    const firstPage = createActiveCompilePersistence({ durable, now: () => 700 });
    await firstPage.put(compileRecord('restart-job', 70));

    const secondPage = createActiveCompilePersistence({ durable, now: () => 800 });
    await expect(secondPage.load()).resolves.toMatchObject({
      schemaVersion: 2,
      jobId: 'restart-job',
      context: { board: 'esp32:esp32:esp32c3' },
    });
  });

  it('uses compare-and-delete semantics for an old job id', async () => {
    const durable = memoryDurable(compileRecord('job-b', 80));
    const persistence = createActiveCompilePersistence({ durable });

    await expect(persistence.delete('job-a')).resolves.toBe(false);
    expect(durable.current?.jobId).toBe('job-b');
  });

  it('does not let an old acceptance delete a newer record with the same job id', async () => {
    const durable = memoryDurable({
      ...compileRecord('same-job', 81),
      acceptanceId: 'acceptance-new',
    });
    const persistence = createActiveCompilePersistence({ durable });

    await expect(persistence.delete('same-job', 'acceptance-old')).resolves.toBe(false);
    expect(durable.current?.acceptanceId).toBe('acceptance-new');
    await expect(persistence.delete('same-job', 'acceptance-new')).resolves.toBe(true);
  });
});
