import { describe, expect, it } from 'vitest';
import {
  LEGACY_LIBRARY_STORAGE_KEY,
  LEGACY_PROJECT_STORAGE_KEY,
  LEGACY_PROJECT_STATE_STORAGE_KEY,
  PROJECT_STATE_SCHEMA_VERSION,
  PROJECT_STATE_STORAGE_KEY,
  loadProjectState,
  normalizeProjectState,
  saveProjectState,
} from '../public/project-state.js';

function memoryStorage(seed: Record<string, string> = {}, { failWrites = false } = {}) {
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

const completeState = {
  files: [
    { name: 'src/helper.cpp', content: 'int helper() { return 1; }\n' },
    { name: 'main.ino', content: 'void setup() {}\n' },
  ],
  activeFile: 'src/helper.cpp',
  board: 'esp32:esp32:esp32c3',
  options: { FlashMode: 'dio', PartitionScheme: 'huge_app' },
  libraries: [
    { name: 'Wire', version: '1.0.0' },
    { name: 'ArduinoJson', version: '7.2.1' },
  ],
};

describe('browser project state v2', () => {
  it('atomically saves and restores the complete project state', () => {
    const storage = memoryStorage();

    expect(saveProjectState(storage, completeState)).toBe(true);
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0].key).toBe(PROJECT_STATE_STORAGE_KEY);
    expect([...storage.values.keys()]).toEqual([PROJECT_STATE_STORAGE_KEY]);

    const saved = JSON.parse(storage.writes[0].value);
    expect(saved).toMatchObject({
      schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
      activeFile: 'src/helper.cpp',
      board: 'esp32:esp32:esp32c3',
      options: { FlashMode: 'dio', PartitionScheme: 'huge_app' },
    });
    expect(saved.files.map((file: { name: string }) => file.name)).toEqual(['main.ino', 'src/helper.cpp']);
    expect(saved.libraries.map((library: { name: string }) => library.name)).toEqual(['ArduinoJson', 'Wire']);
    expect(loadProjectState(storage)).toEqual(saved);
  });

  it('migrates the pre-rename v2 project key to the current key', () => {
    const storage = memoryStorage({
      [LEGACY_PROJECT_STATE_STORAGE_KEY]: JSON.stringify({
        schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
        ...completeState,
      }),
    });

    expect(loadProjectState(storage)).toMatchObject({
      schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
      activeFile: 'src/helper.cpp',
      board: 'esp32:esp32:esp32c3',
    });
    expect(storage.writes.map(({ key }) => key)).toEqual([PROJECT_STATE_STORAGE_KEY]);
    expect(storage.removes).toEqual([LEGACY_PROJECT_STATE_STORAGE_KEY]);
    expect(storage.values.has(LEGACY_PROJECT_STATE_STORAGE_KEY)).toBe(false);
    expect(storage.values.has(PROJECT_STATE_STORAGE_KEY)).toBe(true);
  });

  it('migrates the legacy split project and library keys', () => {
    const storage = memoryStorage({
      [LEGACY_PROJECT_STORAGE_KEY]: JSON.stringify({
        files: [{ name: 'main.ino', content: 'void loop() {}\n' }],
        activeFile: 'main.ino',
      }),
      [LEGACY_LIBRARY_STORAGE_KEY]: JSON.stringify([
        { name: 'Servo', version: '1.2.2' },
        { name: 'Wire' },
      ]),
    });

    expect(loadProjectState(storage)).toEqual({
      schemaVersion: 2,
      files: [{ name: 'main.ino', content: 'void loop() {}\n' }],
      activeFile: 'main.ino',
      board: '',
      options: {},
      libraries: [{ name: 'Servo', version: '1.2.2' }, { name: 'Wire' }],
    });
    expect(storage.writes.map(({ key }) => key)).toEqual([PROJECT_STATE_STORAGE_KEY]);
    expect(storage.removes).toEqual([LEGACY_PROJECT_STORAGE_KEY, LEGACY_LIBRARY_STORAGE_KEY]);
    expect([...storage.values.keys()]).toEqual([PROJECT_STATE_STORAGE_KEY]);
  });

  it('falls back to the sketch when the saved active file no longer exists', () => {
    const normalized = normalizeProjectState({
      schemaVersion: 2,
      ...completeState,
      activeFile: 'removed.cpp',
    });

    expect(normalized?.activeFile).toBe('main.ino');
  });

  it('uses valid legacy state when the v2 payload is corrupt', () => {
    const storage = memoryStorage({
      [PROJECT_STATE_STORAGE_KEY]: '{not json',
      [LEGACY_PROJECT_STORAGE_KEY]: JSON.stringify({
        files: [{ name: 'main.ino', content: 'int legacy = 1;\n' }],
        activeFile: 'main.ino',
      }),
    });

    expect(loadProjectState(storage)?.files[0].content).toBe('int legacy = 1;\n');
  });

  it('fails safely for malformed, unsafe, and unsupported v2 payloads', () => {
    const base = { schemaVersion: 2, ...completeState };
    expect(normalizeProjectState({ ...base, schemaVersion: 3 })).toBeNull();
    expect(normalizeProjectState({ ...base, files: [{ name: '../main.ino', content: '' }] })).toBeNull();
    expect(normalizeProjectState({ ...base, options: [] })).toBeNull();
    expect(normalizeProjectState({ ...base, options: { constructor: 'bad' } })).toBeNull();
    expect(normalizeProjectState({ ...base, libraries: [{ name: 'Wire', version: 1 }] })).toBeNull();
  });

  it('does not throw or partially write when storage is unavailable', () => {
    const blockedStorage = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
    };
    const quotaStorage = memoryStorage({}, { failWrites: true });

    expect(loadProjectState(blockedStorage)).toBeNull();
    expect(saveProjectState(blockedStorage, completeState)).toBe(false);
    expect(saveProjectState(quotaStorage, completeState)).toBe(false);
    expect(quotaStorage.values.size).toBe(0);
    expect(quotaStorage.writes).toHaveLength(0);
  });

  it('restores legacy state without deleting it when migration cannot be written', () => {
    const storage = memoryStorage({
      [LEGACY_PROJECT_STATE_STORAGE_KEY]: JSON.stringify({
        schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
        ...completeState,
      }),
    }, { failWrites: true });

    expect(loadProjectState(storage)?.activeFile).toBe('src/helper.cpp');
    expect(storage.values.has(LEGACY_PROJECT_STATE_STORAGE_KEY)).toBe(true);
    expect(storage.removes).toHaveLength(0);
  });

  it('rejects invalid state before touching storage', () => {
    const storage = memoryStorage();
    expect(saveProjectState(storage, { ...completeState, options: { bad: 42 } })).toBe(false);
    expect(storage.writes).toHaveLength(0);
  });
});
