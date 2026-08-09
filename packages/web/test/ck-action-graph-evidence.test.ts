import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createActionGraphEvidence,
  executeActionGraphWithEvidence,
  writeActionGraphEvidence,
} from '../../../scripts/ck-action-graph-evidence.mjs';
import { auditActionGraphEvidence } from '../../../scripts/audit-ck-action-graph-evidence.mjs';

const roots: string[] = [];
const revision = 'a'.repeat(40);
const digest = (character: string) => character.repeat(64);

function action(id: string, kind: string, cacheKey: string, variant: string) {
  const common = {
    id,
    kind,
    cacheKey,
    tool: `${variant}-${kind}`,
    arguments: [`--executor=${variant}`],
    environment: { EXECUTOR: variant },
    packDependencies: [],
    inputs: [],
    outputs: [],
    dependencies: [],
  };
  if (kind === 'compile') {
    const source = id.startsWith('compile-core-')
      ? 'core/Core.cpp'
      : id.startsWith('compile-library-') ? 'libraries/Demo/Demo.cpp' : 'main.ino';
    const output = `build/${id}.o`;
    return {
      ...common,
      inputs: [{ path: source, role: id.startsWith('compile-project-') ? 'project-file' : 'pack-file' }],
      outputs: [{ path: output, kind: 'object' }],
      compileUnit: { language: 'c++', source, output, macros: {}, includePaths: [], flags: [] },
    };
  }
  if (kind === 'archive') {
    const compileId = id === 'archive-core' ? 'compile-core-main' : 'compile-library-demo';
    const object = `build/${compileId}.o`;
    const output = `build/${id}.a`;
    return {
      ...common,
      dependencies: [compileId],
      inputs: [{ path: object }],
      outputs: [{ path: output, kind: 'archive' }],
      archive: { objects: [object], output, flags: [] },
    };
  }
  if (kind === 'link') {
    return {
      ...common,
      dependencies: ['archive-core', 'archive-library-demo', 'compile-project-main'],
      inputs: [
        { path: 'build/archive-core.a' },
        { path: 'build/archive-library-demo.a' },
        { path: 'build/compile-project-main.o' },
      ],
      outputs: [{ path: 'build/firmware.elf', kind: 'elf' }],
      link: {
        objects: ['build/compile-project-main.o'],
        archives: ['build/archive-core.a', 'build/archive-library-demo.a'],
        output: 'build/firmware.elf',
        flags: [],
      },
    };
  }
  return {
    ...common,
    dependencies: ['link-firmware'],
    inputs: [{ path: 'build/firmware.elf' }],
    outputs: [{ path: 'build/firmware.bin', kind: 'bin' }],
    transform: { input: 'build/firmware.elf', output: 'build/firmware.bin', format: 'bin', flags: [] },
  };
}

function ir(fqbn: string, {
  incremental = false,
  variant = 'browser',
  targetOptions = {},
} = {}) {
  const baseKeys = variant === 'browser'
    ? ['1', '2', '3', '4', '5', '6', '7']
    : ['8', '9', 'a', 'b', 'c', 'd', 'e'];
  const nextKeys = [...baseKeys];
  if (incremental) {
    nextKeys[4] = variant === 'browser' ? '8' : '1';
    nextKeys[5] = variant === 'browser' ? '9' : '2';
    nextKeys[6] = variant === 'browser' ? 'a' : '3';
  }
  const specs = [
    ['compile-core-main', 'compile'],
    ['archive-core', 'archive'],
    ['compile-library-demo', 'compile'],
    ['archive-library-demo', 'archive'],
    ['compile-project-main', 'compile'],
    ['link-firmware', 'link'],
    ['transform-firmware-bin', 'transform'],
  ] as const;
  const source = incremental ? 'void setup() { int changed = 1; }\n' : 'void setup() {}\n';
  return {
    kind: 'ck-build-ir',
    schemaVersion: 1,
    project: {
      files: [{
        path: 'main.ino', language: 'ino', generated: false,
        content: source, sha256: digest(incremental ? 'f' : '0'), size: source.length,
      }],
    },
    target: { fqbn, options: targetOptions },
    packs: {
      toolchain: { kind: 'toolchain', id: 'tc', version: '1', sha256: digest(variant === 'browser' ? 'a' : 'd') },
      platform: { kind: 'platform', id: 'platform', version: '1', sha256: digest('b') },
      board: { kind: 'board', id: `board:${fqbn}`, version: '1', sha256: digest('c') },
      libraries: {
        roots: ['library:Demo@1'],
        packs: [{ kind: 'library', id: 'library:Demo@1', version: '1', sha256: digest('e') }],
      },
    },
    graph: {
      actions: specs.map(([id, kind], index) => action(id, kind, digest(nextKeys[index]!), variant)),
    },
    artifacts: [{ path: 'build/firmware.bin', format: 'bin', offset: '0x10000' }],
    diagnosticMap: { entries: [] },
  };
}

function success(buildIr: ReturnType<typeof ir>, mode: 'first' | 'replay' | 'incremental') {
  const incremental = mode === 'incremental';
  return {
    status: 'success',
    durationMs: mode === 'replay' ? 1 : 9,
    actions: buildIr.graph.actions.map((item) => ({
      actionId: item.id,
      actionKey: item.cacheKey,
      cached: mode === 'replay' || (incremental && /^(?:compile|archive)-(?:core|library)/.test(item.id)),
    })),
    artifacts: [{
      path: 'build/firmware.bin', size: 4,
      sha256: digest(incremental ? 'f' : 'e'),
    }],
  };
}

function report(executor: 'browser-wasm' | 'native', variant: string, targetOptions = {}) {
  const fqbn = 'esp32:esp32:esp32c3';
  const baseline = ir(fqbn, { variant, targetOptions });
  const incremental = ir(fqbn, { variant, incremental: true, targetOptions });
  return createActionGraphEvidence({
    executor,
    target: 'esp32c3',
    fqbn,
    ir: baseline,
    incrementalIr: incremental,
    firstResult: success(baseline, 'first'),
    replayResult: success(baseline, 'replay'),
    incrementalResult: success(incremental, 'incremental'),
    sourceRevision: revision,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CK Action Graph runtime evidence', () => {
  it('executes replay and a real main-only incremental IR', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-action-evidence-'));
    roots.push(root);
    const fqbn = 'esp32:esp32:esp32c3';
    const baseline = ir(fqbn);
    const incremental = ir(fqbn, { incremental: true });
    let calls = 0;
    const result = await executeActionGraphWithEvidence({
      executor: 'browser-wasm',
      target: 'esp32c3',
      fqbn,
      ir: baseline,
      incrementalIr: incremental,
      evidenceDirectory: root,
      buildExecutor: {
        async execute(buildIr: ReturnType<typeof ir>) {
          calls += 1;
          return calls === 1
            ? success(buildIr, 'first')
            : calls === 2 ? success(buildIr, 'replay') : success(buildIr, 'incremental');
        },
      },
      sourceRevision: revision,
    });

    expect(calls).toBe(3);
    expect(result.evidence.status).toBe('pass');
    expect(result.evidence.cacheReplay).toMatchObject({ fullyCached: true, artifactIdentityMatch: true });
    expect(result.evidence.incrementalMain).toMatchObject({
      status: 'pass',
      mainSourcePath: 'main.ino',
      artifactIdentityChanged: true,
    });
    expect(result.evidence.incrementalMain.cachedActionIds).toEqual([
      'archive-core', 'archive-library-demo', 'compile-core-main', 'compile-library-demo',
    ]);
    expect(result.evidencePath).toBe(join(root, 'browser-wasm-esp32c3.json'));
    expect(JSON.parse(readFileSync(result.evidencePath!, 'utf8')).reportSha256)
      .toBe(result.evidence.reportSha256);
  });

  it('requires an immutable source revision and rejects missing incremental proof', () => {
    const fqbn = 'esp32:esp32:esp32c3';
    const baseline = ir(fqbn);
    expect(() => createActionGraphEvidence({
      executor: 'browser-wasm', target: 'esp32c3', fqbn, ir: baseline,
      firstResult: success(baseline, 'first'), replayResult: success(baseline, 'replay'),
      sourceRevision: '',
    })).toThrow(/sourceRevision/);

    const incomplete = createActionGraphEvidence({
      executor: 'browser-wasm', target: 'esp32c3', fqbn, ir: baseline,
      firstResult: success(baseline, 'first'), replayResult: success(baseline, 'replay'),
      sourceRevision: revision,
    });
    expect(incomplete).toMatchObject({
      status: 'fail',
      incrementalMain: { status: 'fail', reason: 'incremental Build IR was not provided' },
    });
  });

  it.each([
    ['a Core Action reruns', 'compile-core-main', false, /did not hit the cache/],
    ['a changed project Action is cached', 'compile-project-main', true, /did not rerun/],
  ])('rejects incremental evidence when %s', (_label, actionId, cached, reason) => {
    const fqbn = 'esp32:esp32:esp32c3';
    const baseline = ir(fqbn);
    const incremental = ir(fqbn, { incremental: true });
    const incrementalResult = success(incremental, 'incremental');
    incrementalResult.actions.find((item) => item.actionId === actionId)!.cached = cached;

    const evidence = createActionGraphEvidence({
      executor: 'browser-wasm', target: 'esp32c3', fqbn,
      ir: baseline, incrementalIr: incremental,
      firstResult: success(baseline, 'first'), replayResult: success(baseline, 'replay'),
      incrementalResult,
      sourceRevision: revision,
    });
    expect(evidence.status).toBe('fail');
    expect(evidence.incrementalMain).toMatchObject({ status: 'fail' });
    expect(evidence.incrementalMain.reason).toMatch(reason);
  });

  it('accepts executor-specific IR hashes only when normalized plans are equal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-action-matrix-'));
    roots.push(root);
    const fqbn = 'esp32:esp32:esp32c3';
    const required = [
      ['browser-wasm', fqbn],
      ['native', fqbn],
    ];
    const browser = report('browser-wasm', 'browser');
    const native = report('native', 'native');
    expect(browser.buildIr.sha256).not.toBe(native.buildIr.sha256);
    expect(browser.buildIr.keysSha256).not.toBe(native.buildIr.keysSha256);
    expect(browser.planning.sha256).toBe(native.planning.sha256);

    await writeActionGraphEvidence(browser, { directory: root });
    await expect(auditActionGraphEvidence({
      root, required, expectedSourceRevision: revision,
    })).rejects.toThrow(/missing runtime evidence/);
    await writeActionGraphEvidence(native, { directory: root });
    await expect(auditActionGraphEvidence({
      root, required, expectedSourceRevision: revision,
    })).resolves.toMatchObject({
      status: 'pass',
      sourceRevision: revision,
      reports: [
        { executor: 'browser-wasm', normalizedPlanningSha256: browser.planning.sha256 },
        { executor: 'native', normalizedPlanningSha256: native.planning.sha256 },
      ],
      pairs: [{ fqbn, planningSha256: browser.planning.sha256 }],
    });
  });

  it('binds the matrix to the requested revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-action-revision-'));
    roots.push(root);
    const fqbn = 'esp32:esp32:esp32c3';
    const required = [['browser-wasm', fqbn]];
    await writeActionGraphEvidence(report('browser-wasm', 'browser'), { directory: root });
    await expect(auditActionGraphEvidence({
      root,
      required,
      expectedSourceRevision: 'b'.repeat(40),
    })).rejects.toThrow(/does not match current revision/);
  });

  it('rejects Browser and Native plans that differ after normalization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-action-plan-'));
    roots.push(root);
    const fqbn = 'esp32:esp32:esp32c3';
    const required = [['browser-wasm', fqbn], ['native', fqbn]];
    await writeActionGraphEvidence(report('browser-wasm', 'browser'), { directory: root });
    await writeActionGraphEvidence(report('native', 'native', { FlashMode: 'qio' }), { directory: root });
    await expect(auditActionGraphEvidence({
      root, required, expectedSourceRevision: revision,
    })).rejects.toThrow(/normalized planning mismatch/);
  });
});
