import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  sha256Hex,
  type BoardPackRef,
  type BuildAction,
  type BuildPacks,
  type CompileAction,
  type LibraryPackRef,
} from '../src/index.js';
import {
  calculateActionKeys,
  createBuildIR,
  migrateBuildIR,
  mapDiagnostics,
  resolveLibraries,
  resolveProject,
  serializeBuildIR,
} from '../src/build-ir/builder.js';
import { planBuildIR } from '../src/build-ir/planner.js';
import { validateBuildIR } from '../src/build-ir/validate.js';

const board: BoardPackRef = {
  kind: 'board', id: 'esp32-c3-devkit', version: '1.0.0', sha256: 'b'.repeat(64),
  fqbn: 'esp32:esp32:esp32c3', variant: 'esp32c3',
};

const library: LibraryPackRef = {
  kind: 'library', id: 'arduino:Wire', name: 'Wire', version: '1.0.0', sha256: 'd'.repeat(64),
  architectures: ['*'], manifest: { name: 'Wire', version: '1.0.0' }, dependencies: [],
};

const packs: BuildPacks = {
  toolchain: {
    kind: 'toolchain', id: 'esp-riscv-gcc', version: '13.2.0', sha256: 'a'.repeat(64),
    abi: 'riscv32-esp-elf', instructionSet: 'rv32imc',
  },
  platform: {
    kind: 'platform', id: 'espressif-arduino', version: '3.3.7', sha256: 'c'.repeat(64),
    platform: 'espressif-arduino',
  },
  board,
  libraries: { roots: [library.id], packs: [library] },
};

function action(id: string, dependencies: string[] = []): CompileAction {
  return {
    id, kind: 'compile', tool: 'toolchain:g++', inputs: [{ path: 'src/main.cpp', sha256: '1'.repeat(64), role: 'source' }],
    outputs: [{ path: `build/${id}.o`, kind: 'object' }], arguments: ['-c'], environment: { LANG: 'C' },
    dependencies, packDependencies: [library.id], resourceLimits: { memoryBytes: 1024 }, cacheKey: '',
    compileUnit: {
      language: 'c++', source: 'src/main.cpp', output: `build/${id}.o`, macros: { ARDUINO: true },
      includePaths: ['include'], flags: ['-Os'],
    },
  };
}

function makeIR(
  actionOrder: BuildAction[] = [action('compile-main'), action('compile-util', ['compile-main'])],
  buildPacks: BuildPacks = packs,
) {
  return createBuildIR({
    project: [{ path: 'src/main.cpp', content: 'int main() { return 0; }\n' }],
    target: { fqbn: board.fqbn, options: { cpu: 'default' }, boardPack: board },
    packs: buildPacks, actions: actionOrder,
    artifacts: [{ path: 'build/firmware.elf', format: 'elf' }],
    diagnosticMap: [{ generatedFile: 'src/main.cpp', generatedLine: 1, sourceFile: 'src/main.cpp', sourceLine: 1 }],
  });
}

describe('CK Build IR v1', () => {
  it('rejects case-folded project path duplicates and sorts paths by UTF-16 code units', () => {
    expect(() => resolveProject([
      { path: 'main.ino', content: 'void setup() {}\n' },
      { path: 'MAIN.ino', content: 'void loop() {}\n' },
    ])).toThrow(/duplicate project file/i);

    const project = resolveProject([
      { path: '\ue000.cpp', content: 'int bmp;\n' },
      { path: '\ud83d\ude00.cpp', content: 'int non_bmp;\n' },
    ]);
    expect(project.files.map((file) => file.path)).toEqual(['\ud83d\ude00.cpp', '\ue000.cpp']);
  });

  it('uses a platform-independent canonical JSON representation', () => {
    expect(canonicalJson({ b: 2, a: { z: true, y: null }, list: [3, 1] }))
      .toBe('{"a":{"y":null,"z":true},"b":2,"list":[3,1]}');
    expect(serializeBuildIR(makeIR())).toBe(serializeBuildIR(makeIR(makeIR().graph.actions.slice().reverse())));
  });

  it('calculates standard SHA-256 vectors without Node crypto', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('A\u{1f47f}B')).toBe('696bbb8157fa27109cf8a3d3ad843afd016a68a2f8b9e94470b15bfac8ed46f0');
    expect(sha256Hex('\ud800')).toBe('83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097');
  });

  it('creates deterministic action keys and propagates dependency changes', () => {
    const first = makeIR();
    const reordered = makeIR(first.graph.actions.slice().reverse());
    expect(first.graph.actions.map((item) => item.cacheKey)).toEqual(reordered.graph.actions.map((item) => item.cacheKey));
    const changed = makeIR(first.graph.actions.map((item) => item.id === 'compile-main'
      ? { ...item, arguments: ['-c', '-g'] } : item));
    expect(changed.graph.actions.find((item) => item.id === 'compile-main')!.cacheKey)
      .not.toBe(first.graph.actions.find((item) => item.id === 'compile-main')!.cacheKey);
    expect(changed.graph.actions.find((item) => item.id === 'compile-util')!.cacheKey)
      .not.toBe(first.graph.actions.find((item) => item.id === 'compile-util')!.cacheKey);
  });

  it('requires target and build Board Pack identities to match all immutable fields', () => {
    const mismatches: BoardPackRef[] = [
      { ...board, id: 'esp32-c3-devkit-other' },
      { ...board, version: '2.0.0' },
      { ...board, sha256: 'e'.repeat(64) },
      { ...board, fqbn: 'esp32:esp32:esp32c3-other' },
      { ...board, variant: 'esp32c3-other' },
    ];

    for (const targetBoard of mismatches) {
      expect(() => createBuildIR({
        project: [{ path: 'src/main.cpp', content: 'int main() { return 0; }\n' }],
        target: { fqbn: targetBoard.fqbn, options: {}, boardPack: targetBoard },
        packs,
        actions: [action('compile-main')],
      })).toThrow('target and build pack board references do not match');
    }
  });

  it('makes compile action keys sensitive to every compiler input identity', () => {
    const baseline = makeIR();
    const baselineKey = baseline.graph.actions.find((item) => item.id === 'compile-main')!.cacheKey;
    const variant = (mutate: (source: CompileAction) => CompileAction, buildPacks = packs) => {
      const main = mutate(action('compile-main'));
      return makeIR([main, action('compile-util', ['compile-main'])], buildPacks)
        .graph.actions.find((item) => item.id === 'compile-main')!.cacheKey;
    };

    const variants = [
      variant((source) => ({
        ...source,
        inputs: [{ ...source.inputs[0]!, sha256: '2'.repeat(64) }],
      })),
      variant((source) => ({
        ...source,
        compileUnit: {
          ...source.compileUnit,
          macros: { ...source.compileUnit.macros, DEBUG: true },
        },
      })),
      variant((source) => ({
        ...source,
        compileUnit: {
          ...source.compileUnit,
          includePaths: [...source.compileUnit.includePaths, 'generated/include'],
        },
      })),
      variant((source) => ({
        ...source,
        compileUnit: {
          ...source.compileUnit,
          flags: [...source.compileUnit.flags, '-fno-exceptions'],
        },
      })),
      variant((source) => source, {
        ...packs,
        toolchain: { ...packs.toolchain, sha256: 'f'.repeat(64) },
      }),
    ];

    for (const key of variants) expect(key).not.toBe(baselineKey);
  });

  it('resolves fixed Pack dependencies and rejects unknown or ambiguous Pack ids', () => {
    const build = (buildPacks: BuildPacks, packDependencies: string[]) => createBuildIR({
      project: [{ path: 'src/main.cpp', content: 'int main() { return 0; }\n' }],
      target: {
        fqbn: buildPacks.board.fqbn,
        options: { cpu: 'default' },
        boardPack: buildPacks.board,
      },
      packs: buildPacks,
      actions: [{ ...action('compile-main'), packDependencies }],
    });
    const fixedDependencies = [packs.board.id, packs.platform.id, packs.toolchain.id];
    const baseline = build(packs, fixedDependencies);
    const changedBoard = build({
      ...packs,
      board: { ...packs.board, sha256: 'e'.repeat(64) },
    }, fixedDependencies);

    expect(baseline.graph.actions[0]?.packDependencies).toEqual(fixedDependencies.slice().sort());
    expect(changedBoard.graph.actions[0]?.cacheKey).not.toBe(baseline.graph.actions[0]?.cacheKey);
    expect(() => build(packs, ['pack:missing']))
      .toThrow('references missing pack dependency pack:missing');
    expect(() => build({
      ...packs,
      platform: { ...packs.platform, id: packs.board.id },
    }, [packs.board.id])).toThrow(`ambiguous Pack id ${packs.board.id}: used by platform and board`);
    expect(() => build({
      ...packs,
      libraries: {
        roots: [packs.board.id],
        packs: [{ ...library, id: packs.board.id }],
      },
    }, [packs.board.id])).toThrow(`ambiguous Pack id ${packs.board.id}: used by board and library`);
  });

  it('keeps transitive Library Pack identities in Action keys', () => {
    const leaf: LibraryPackRef = {
      ...library,
      id: 'lib:leaf',
      name: 'Leaf',
      sha256: '1'.repeat(64),
    };
    const root: LibraryPackRef = {
      ...library,
      id: 'lib:root',
      name: 'Root',
      sha256: '2'.repeat(64),
      dependencies: [{ id: leaf.id, version: leaf.version, sha256: leaf.sha256 }],
    };
    const keyFor = (rootPack: LibraryPackRef, leafPack: LibraryPackRef) => createBuildIR({
      project: [{ path: 'src/main.cpp', content: 'int main() { return 0; }\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs: {
        ...packs,
        libraries: { roots: [rootPack.id], packs: [rootPack, leafPack] },
      },
      actions: [{ ...action('compile-main'), packDependencies: [rootPack.id] }],
    }).graph.actions[0]!.cacheKey;
    const changedLeaf = { ...leaf, sha256: '3'.repeat(64) };
    const changedRoot = {
      ...root,
      dependencies: [{ id: changedLeaf.id, version: changedLeaf.version, sha256: changedLeaf.sha256 }],
    };

    expect(keyFor(changedRoot, changedLeaf)).not.toBe(keyFor(root, leaf));
  });

  it('binds compact Pack artifact inputs to Action keys without workspace files', () => {
    const baseline = makeIR();
    const main = action('compile-main');
    main.packInputs = [{
      kind: 'pack-artifact',
      packId: packs.platform.id,
      packRevision: packs.platform.sha256,
      packSchema: 1,
      artifactId: 'compile-000',
      sha256: 'e'.repeat(64),
      role: 'compiler-vfs',
    }];
    const withPackInput = makeIR([main, action('compile-util', ['compile-main'])]);
    const baselineMain = baseline.graph.actions.find((item) => item.id === 'compile-main')!;
    const packedMain = withPackInput.graph.actions.find((item) => item.id === 'compile-main')!;

    expect(packedMain.inputs).toEqual(baselineMain.inputs);
    expect(packedMain.packInputs).toEqual(main.packInputs);
    expect(packedMain.cacheKey).not.toBe(baselineMain.cacheKey);
    expect(() => makeIR([{
      ...main,
      packInputs: [{ ...main.packInputs[0]!, packRevision: 'f'.repeat(64) }],
    }])).toThrow(/Pack input identity does not match/);
  });

  it('omits empty Pack inputs and limits Pack schemas to Rust u32', () => {
    const empty = makeIR([{ ...action('compile-main'), packInputs: [] }]);
    expect(empty.graph.actions[0]).not.toHaveProperty('packInputs');
    expect(calculateActionKeys(empty).graph.actions[0]).not.toHaveProperty('packInputs');

    const withSchema = (packSchema: number) => makeIR([{
      ...action('compile-main'),
      packInputs: [{
        kind: 'pack-artifact',
        packId: packs.platform.id,
        packRevision: packs.platform.sha256,
        packSchema,
        artifactId: 'compile-000',
        sha256: 'e'.repeat(64),
      }],
    }]);
    expect(withSchema(0xffff_ffff).graph.actions[0]?.packInputs?.[0]?.packSchema)
      .toBe(0xffff_ffff);
    expect(() => withSchema(0x1_0000_0000)).toThrow(/positive 32-bit unsigned integer/);
  });

  it('rejects unknown Action fields instead of hashing an implementation-specific shape', () => {
    const base = action('compile-main');
    const unknownAction = { ...base, futureFlag: true } as CompileAction;
    expect(() => makeIR([unknownAction])).toThrow(/action compile-main contains unknown field futureFlag/);

    const unknownCompileUnit = {
      ...base,
      compileUnit: { ...base.compileUnit, futureFlag: true },
    } as CompileAction;
    expect(() => makeIR([unknownCompileUnit]))
      .toThrow(/action compile-main compile unit contains unknown field futureFlag/);
  });

  it('uses structured Pack input identities when checking duplicates', () => {
    const main = action('compile-main');
    main.packInputs = [{
      kind: 'pack-artifact',
      packId: packs.platform.id,
      packRevision: packs.platform.sha256,
      packSchema: 1,
      artifactId: 'b',
      sha256: 'e'.repeat(64),
      role: 'c\0d',
    }, {
      kind: 'pack-artifact',
      packId: packs.platform.id,
      packRevision: packs.platform.sha256,
      packSchema: 1,
      artifactId: 'b\0c',
      sha256: 'f'.repeat(64),
      role: 'd',
    }];

    expect(makeIR([main]).graph.actions[0]?.packInputs).toHaveLength(2);
  });

  it('retains recursively resolved library dependencies and rejects missing transitive packs', () => {
    const leaf: LibraryPackRef = {
      kind: 'library', id: 'lib:leaf', name: 'Leaf', version: '1.0.0', sha256: '1'.repeat(64),
      architectures: ['*'], manifest: { name: 'Leaf' }, dependencies: [],
    };
    const middle: LibraryPackRef = {
      kind: 'library', id: 'lib:middle', name: 'Middle', version: '1.0.0', sha256: '2'.repeat(64),
      architectures: ['*'], manifest: { name: 'Middle' },
      dependencies: [{ id: leaf.id, version: leaf.version, sha256: leaf.sha256 }],
    };
    const root: LibraryPackRef = {
      kind: 'library', id: 'lib:root', name: 'Root', version: '1.0.0', sha256: '3'.repeat(64),
      architectures: ['*'], manifest: { name: 'Root' },
      dependencies: [{ id: middle.id, version: middle.version, sha256: middle.sha256 }],
    };

    const resolved = resolveLibraries({ roots: [root.id], packs: [root, middle, leaf] });
    expect(resolved.roots).toEqual([root.id]);
    expect(resolved.packs.map((pack) => pack.id)).toEqual([leaf.id, middle.id, root.id]);
    expect(resolved.packs.find((pack) => pack.id === root.id)?.dependencies).toEqual([
      { id: middle.id, version: middle.version, sha256: middle.sha256 },
    ]);
    expect(() => resolveLibraries({ roots: [root.id], packs: [root, middle] }))
      .toThrow(/missing dependency lib:leaf/);
  });

  it('rejects different Library Pack revisions with the same logical name and version', () => {
    const first: LibraryPackRef = {
      ...library,
      id: 'lib:demo-first',
      name: 'Demo',
      version: '1.0.0',
      sha256: '1'.repeat(64),
    };
    const second: LibraryPackRef = {
      ...first,
      id: 'lib:demo-second',
      sha256: '2'.repeat(64),
    };

    expect(() => resolveLibraries({ roots: [first.id], packs: [first, second] }))
      .toThrow(/ambiguous library pack Demo@1\.0\.0: multiple revisions/i);
  });

  it('rejects missing dependencies and cyclic action graphs', () => {
    expect(() => makeIR([action('a', ['missing'])])).toThrow(/missing dependency/);
    expect(() => makeIR([action('a', ['b']), action('b', ['a'])])).toThrow(/cycle/);
  });

  it('validates JSON and maps generated diagnostics back to source', () => {
    const ir = makeIR();
    expect(validateBuildIR(JSON.parse(serializeBuildIR(ir)))).toMatchObject({ valid: true });
    expect(validateBuildIR({ ...ir, schemaVersion: 99 })).toMatchObject({ valid: false });
    expect(validateBuildIR({ ...ir, kind: 'not-ck-build-ir' })).toMatchObject({ valid: false });
    expect(validateBuildIR({ ...ir, graph: undefined })).toMatchObject({ valid: false });
    expect(mapDiagnostics([
      { severity: 'error', file: 'generated.cpp', line: 4, column: 2, message: 'bad' },
    ], [{ generatedFile: 'generated.cpp', generatedLine: 4, sourceFile: 'main.ino', sourceLine: 2 }]))
      .toMatchObject([{
        file: 'main.ino', line: 2, sourceFile: 'main.ino', sourceLine: 2,
        generatedFile: 'generated.cpp', generatedLine: 4, generatedColumn: 2,
        fromGenerated: true,
      }]);
  });

  it('migrates v1 IR deterministically and recalculates action keys', () => {
    const baseline = makeIR();
    const input = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
    input.project.files.reverse();
    input.graph.actions.reverse();
    input.graph.actions[0]!.cacheKey = '0'.repeat(64);
    input.graph.actions[0]!.dependencies = input.graph.actions[0]!.dependencies.slice().reverse();

    const migrated = migrateBuildIR(input);

    expect(migrated).toEqual(baseline);
    expect(serializeBuildIR(migrated)).toBe(serializeBuildIR(baseline));
    expect(migrated.graph.actions.every((action) => action.cacheKey !== '0'.repeat(64))).toBe(true);
  });

  it('migrates the explicit v0 envelope and legacy field names to canonical v1', () => {
    const baseline = makeIR();
    const legacy = {
      kind: 'ck-build-ir',
      schemaVersion: 0,
      project: baseline.project.files.map((file) => ({
        name: file.path,
        content: file.content,
        language: file.language,
        generated: file.generated,
      })).reverse(),
      target: {
        board: baseline.target.fqbn,
        options: baseline.target.options,
      },
      packs: baseline.packs,
      actions: baseline.graph.actions.map((item) => ({ ...item, cacheKey: '0'.repeat(64) })).reverse(),
      artifacts: baseline.artifacts,
      diagnostics: baseline.diagnosticMap.entries,
    };

    const migrated = migrateBuildIR(legacy);

    expect(migrated).toEqual(baseline);
    expect(serializeBuildIR(migrated)).toBe(serializeBuildIR(baseline));
  });

  it('rejects unsupported Build IR schema versions and kinds during migration', () => {
    const ir = makeIR();

    expect(() => migrateBuildIR({ ...ir, schemaVersion: 99 }))
      .toThrow('unsupported schema version 99');
    expect(() => migrateBuildIR({ kind: 'ck-build-ir', schemaVersion: 0 }))
      .toThrow('Build IR v0 project must be an array');
    expect(() => migrateBuildIR({ ...ir, kind: 'not-ck-build-ir' }))
      .toThrow('expected ck-build-ir');
    expect(() => migrateBuildIR(null)).toThrow('Build IR must be an object');
    expect(() => migrateBuildIR([])).toThrow('Build IR must be an object');
  });

  it('plans independent project, core, library, link, and image actions', () => {
    const ir = planBuildIR({
      project: [
        { path: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' },
        { path: 'src/helper.cpp', content: 'int helper() { return 1; }\n' },
      ],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      platform: {
        core: { files: [{ path: 'Hardware.cpp', content: 'int hardware() { return 1; }\n' }] },
        variant: { files: [{ path: 'pins.c', content: 'int pins() { return 1; }\n' }] },
      },
      libraries: [{
        pack: library,
        files: [{ path: 'Wire.cpp', content: 'int wire() { return 1; }\n' }],
      }],
    });

    const kinds = ir.graph.actions.map((action) => action.kind);
    expect(kinds).toContain('compile');
    expect(kinds).toContain('archive');
    expect(kinds).toContain('link');
    expect(kinds).toContain('transform');
    expect(ir.graph.actions.some((action) => action.kind === 'transform'
      && action.transform.format === 'other')).toBe(true);
    expect(ir.graph.actions.find((action) => action.id === 'archive-core')?.dependencies.length).toBe(2);
    const libraryArchive = ir.graph.actions.find((action) => action.id.startsWith('archive-library-'))!;
    expect(libraryArchive.packDependencies).toEqual([library.id]);
    expect(ir.graph.actions.find((action) => action.id === 'link-firmware')?.dependencies)
      .toEqual(expect.arrayContaining(['archive-core', libraryArchive.id]));
    expect(ir.artifacts.some((artifact) => artifact.format === 'bin')).toBe(true);
  });

  it('keeps core actions independent from library content changes', () => {
    const input = {
      project: [{ path: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      platform: { core: { files: [{ path: 'Hardware.cpp', content: 'int hardware() { return 1; }\n' }] } },
      libraries: [{ pack: library, files: [{ path: 'Wire.cpp', content: 'int wire() { return 1; }\n' }] }],
    } as const;
    const first = planBuildIR(input);
    const changedLibrary = planBuildIR({
      ...input,
      libraries: [{ pack: { ...library, sha256: 'e'.repeat(64) }, files: [{ path: 'Wire.cpp', content: 'int wire() { return 2; }\n' }] }],
      packs: { ...packs, libraries: { roots: [library.id], packs: [{ ...library, sha256: 'e'.repeat(64) }] } },
    });
    const firstCore = first.graph.actions.find((action) => action.id.startsWith('compile-core-'))!;
    const changedCore = changedLibrary.graph.actions.find((action) => action.id.startsWith('compile-core-'))!;
    expect(changedCore.cacheKey).toBe(firstCore.cacheKey);
    expect(firstCore.packDependencies).toEqual([]);
  });
});
