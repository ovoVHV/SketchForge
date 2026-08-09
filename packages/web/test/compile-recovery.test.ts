import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_COMPILE_RECORD_SCHEMA_VERSION,
  compactStoredCompileContext,
  compileRecoveryBoardDisposition,
  loadStoredCompileRecord,
  normalizeStoredCompile,
} from '../public/compile-recovery.js';

function record(startedAt = Date.now()) {
  return {
    jobId: 'job-1',
    stream: '/v1/compile/job-1/events',
    startedAt,
    context: {
      source: 'void setup() {}',
      board: 'esp32:esp32:esp32c3',
      options: {},
    },
  };
}

describe('accepted compile recovery', () => {
  it('omits duplicate source from a copied context when project files are present', () => {
    const files = [
      { name: 'main.ino', content: 'void setup() {}' },
      { name: 'helper.cpp', content: 'int helper = 1;' },
    ];
    const context = {
      source: 'void setup() {}',
      files,
      activeFile: 'main.ino',
      board: 'esp32:esp32:esp32c3',
      options: { FlashSize: '4M' },
      libraries: [{ name: 'ArduinoJson', version: '7.0.0' }],
      buildOptions: { optimize: 'size' },
    };

    const compact = compactStoredCompileContext(context);

    expect(compact).toEqual({
      files,
      activeFile: 'main.ino',
      board: 'esp32:esp32:esp32c3',
      options: { FlashSize: '4M' },
      libraries: [{ name: 'ArduinoJson', version: '7.0.0' }],
      buildOptions: { optimize: 'size' },
    });
    expect(compact).not.toBe(context);
    expect(context.source).toBe('void setup() {}');
    expect(context.files).toBe(files);
    expect(files).toHaveLength(2);
  });

  it('keeps source in a copied context when project files are absent or empty', () => {
    const sourceOnly = {
      source: 'void setup() {}',
      board: 'arduino:avr:uno',
      options: {},
    };
    const emptyFiles = { ...sourceOnly, files: [] };

    expect(compactStoredCompileContext(sourceOnly)).toEqual(sourceOnly);
    expect(compactStoredCompileContext(sourceOnly)).not.toBe(sourceOnly);
    expect(compactStoredCompileContext(emptyFiles)).toEqual(emptyFiles);
    expect(emptyFiles.source).toBe('void setup() {}');
    expect(emptyFiles.files).toEqual([]);
  });

  it('keeps old accepted jobs until the server reports that they expired', () => {
    const saved = record(Date.now() - 7 * 24 * 60 * 60_000);
    expect(normalizeStoredCompile(saved)).toEqual({
      schemaVersion: ACTIVE_COMPILE_RECORD_SCHEMA_VERSION,
      ...saved,
    });
  });

  it('accepts files-only and legacy source-only contexts but rejects contexts with neither', () => {
    const sourceOnly = record();
    const filesOnly = {
      ...record(),
      context: {
        files: [{ name: 'main.ino', content: 'void setup() {}' }],
        activeFile: 'main.ino',
        board: 'esp32:esp32:esp32c3',
        options: {},
        libraries: [],
        buildOptions: {},
      },
    };
    const neither = {
      ...record(),
      context: {
        board: 'esp32:esp32:esp32c3',
        options: {},
      },
    };

    expect(normalizeStoredCompile(sourceOnly)).toEqual({
      schemaVersion: ACTIVE_COMPILE_RECORD_SCHEMA_VERSION,
      ...sourceOnly,
    });
    expect(normalizeStoredCompile(filesOnly)).toEqual({
      schemaVersion: ACTIVE_COMPILE_RECORD_SCHEMA_VERSION,
      ...filesOnly,
    });
    expect(normalizeStoredCompile(neither)).toBeNull();
    expect(normalizeStoredCompile({ ...sourceOnly, schemaVersion: 99 })).toBeNull();
  });

  it('restores a defined board even when no worker currently advertises it', () => {
    expect(compileRecoveryBoardDisposition([
      { fqbn: 'esp32:esp32:esp32c3', available: false },
    ], 'esp32:esp32:esp32c3')).toBe('restore');
    expect(compileRecoveryBoardDisposition([], 'esp32:esp32:esp32c3')).toBe('defer');
  });

  it('removes malformed records but does not remove a valid old record', () => {
    const removeItem = vi.fn();
    const old = record(0);
    expect(loadStoredCompileRecord({
      getItem: () => JSON.stringify(old),
      removeItem,
    }, 'active')).toEqual({
      schemaVersion: ACTIVE_COMPILE_RECORD_SCHEMA_VERSION,
      ...old,
    });
    expect(removeItem).not.toHaveBeenCalled();

    expect(loadStoredCompileRecord({
      getItem: () => JSON.stringify({ ...old, context: null }),
      removeItem,
    }, 'active')).toBeNull();
    expect(removeItem).toHaveBeenCalledWith('active');
  });
});
