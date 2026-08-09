import { describe, expect, it } from 'vitest';

import {
  planBuildActions,
  planBuildIR,
} from '../src/build-ir/planner.js';
import { mapDiagnostics } from '../src/build-ir/builder.js';
import { sha256Hex } from '../src/build-ir/canonical.js';
import type { BoardPackRef, BuildPacks, LibraryPackRef } from '../src/build-ir/types.js';

const board: BoardPackRef = {
  kind: 'board', id: 'board:test', version: '1.0.0', sha256: 'b'.repeat(64),
  fqbn: 'esp32:esp32:test', variant: 'test',
};
const library: LibraryPackRef = {
  kind: 'library', id: 'library:demo@1.0.0', name: 'Demo', version: '1.0.0', sha256: 'd'.repeat(64),
  architectures: ['*'], manifest: { name: 'Demo', version: '1.0.0' }, dependencies: [],
};
const packs: BuildPacks = {
  toolchain: {
    kind: 'toolchain', id: 'toolchain:test', version: '1.0.0', sha256: 'a'.repeat(64),
    abi: 'test-elf', instructionSet: 'test',
  },
  platform: {
    kind: 'platform', id: 'platform:test', version: '1.0.0', sha256: 'c'.repeat(64), platform: 'test',
  },
  board,
  libraries: { roots: [library.id], packs: [library] },
};

const privateHeaderDecoyLibrary: LibraryPackRef = {
  kind: 'library', id: 'library:private-header-decoy@1.0.0', name: 'Private Header Decoy',
  version: '1.0.0', sha256: 'e'.repeat(64), architectures: ['*'],
  manifest: { name: 'Private Header Decoy', version: '1.0.0' }, dependencies: [],
};

function planPathQualifiedPrivateInclude(decoyHeaderPath: string) {
  return planBuildActions({
    project: [{ path: 'main.cpp', content: 'int main() { return 0; }\n' }],
    target: { fqbn: board.fqbn, options: {}, boardPack: board },
    packs: {
      ...packs,
      libraries: {
        roots: [library.id, privateHeaderDecoyLibrary.id],
        packs: [library, privateHeaderDecoyLibrary],
      },
    },
    libraries: [
      {
        pack: library,
        rootPath: 'packs/libraries/demo',
        includePaths: ['src'],
        files: [
          { path: 'src/Demo.cpp', content: '#include <drivers/Foo.h>\n' },
          { path: 'src/private/drivers/Foo.h', content: '#pragma once\n' },
        ],
      },
      {
        pack: privateHeaderDecoyLibrary,
        rootPath: 'packs/libraries/decoy',
        includePaths: ['src'],
        files: [
          { path: 'src/Decoy.cpp', content: 'int decoy = 0;\n' },
          { path: decoyHeaderPath, content: '#pragma once\n' },
        ],
      },
    ],
  });
}

function demoPrivateIncludeRoots(plan: ReturnType<typeof planBuildActions>): string[] {
  const compile = plan.actions.find((action) => (
    action.kind === 'compile' && action.compileUnit.source === 'packs/libraries/demo/src/Demo.cpp'
  ));
  if (!compile || compile.kind !== 'compile') throw new Error('Demo library compile Action is missing');
  const roots: string[] = [];
  for (let index = 0; index < compile.compileUnit.flags.length - 1; index += 1) {
    if (compile.compileUnit.flags[index] === '-idirafter') roots.push(compile.compileUnit.flags[index + 1]!);
  }
  return roots;
}

describe('CK Build IR action planner', () => {
  it('plans sketch preprocessing, compilation, linking, and a target image', () => {
    const plan = planBuildActions({
      project: [{ path: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
    });

    expect(plan.actions.map((action) => action.kind)).toEqual([
      'compile', 'link', 'transform', 'transform',
    ]);
    const preprocess = plan.actions.find((action) => action.tool === 'ck:preprocess');
    const compile = plan.actions.find((action) => action.kind === 'compile');
    const link = plan.actions.find((action) => action.kind === 'link');
    const image = plan.actions.find((action) => action.kind === 'transform' && action.tool !== 'ck:preprocess');
    expect(preprocess).toBeDefined();
    expect(compile?.dependencies).toEqual([preprocess!.id]);
    expect(compile?.compileUnit.language).toBe('c++');
    expect(link?.dependencies).toContain(compile!.id);
    expect(image?.dependencies).toEqual([link!.id]);
    expect(plan.artifacts.map((artifact) => artifact.format)).toEqual(['bin', 'elf']);
    expect(image?.arguments.slice(0, 4)).toEqual([
      '-O', 'binary', image!.transform.input, image!.transform.output,
    ]);
    expect(plan.diagnosticMap).toEqual([
      {
        generatedFile: '<generated>', generatedLine: 1, generatedColumn: 1,
        sourceFile: 'main.ino', sourceLine: 1, sourceColumn: 1,
      },
      {
        generatedFile: '<generated>', generatedLine: 2, generatedColumn: 1,
        sourceFile: 'main.ino', sourceLine: 2, sourceColumn: 1,
      },
    ]);

    const ir = planBuildIR({
      project: [{ path: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
    });
    expect(ir.diagnosticMap.entries).toEqual(plan.diagnosticMap);
  });

  it('plans root Arduino tabs as one stable sketch translation unit', () => {
    const project = [
      { path: 'Zeta.ino', content: 'void loop() {}\n' },
      { path: 'main.ino', content: 'void setup() {}\n' },
      { path: 'Alpha.ino', content: 'int alpha() { return 1; }\n' },
      { path: 'helper.cpp', content: 'int helper() { return 2; }\n' },
    ];
    const plan = planBuildActions({
      project,
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
    });
    const preprocessActions = plan.actions.filter((action) => action.tool === 'ck:preprocess');
    const projectCompiles = plan.actions.filter((action) => (
      action.kind === 'compile' && action.id.startsWith('compile-project-')
    ));

    expect(preprocessActions).toHaveLength(1);
    expect(projectCompiles).toHaveLength(2);
    expect(preprocessActions[0]).toMatchObject({
      inputs: [
        { path: 'main.ino', role: 'sketch-main' },
        { path: 'Alpha.ino', role: 'sketch-tab' },
        { path: 'Zeta.ino', role: 'sketch-tab' },
      ],
      arguments: [
        'main.ino', 'Alpha.ino', 'Zeta.ino',
        '-o', 'build/generated/main.cpp',
      ],
      transform: { input: 'main.ino', output: 'build/generated/main.cpp' },
    });
    expect(projectCompiles.filter((action) => action.kind === 'compile'
      && action.compileUnit.source === 'build/generated/main.cpp')).toHaveLength(1);
    expect(plan.diagnosticMap).toEqual([
      expect.objectContaining({ generatedLine: 1, sourceFile: 'main.ino', sourceLine: 1 }),
      expect.objectContaining({ generatedLine: 2, sourceFile: 'Alpha.ino', sourceLine: 1 }),
      expect.objectContaining({ generatedLine: 3, sourceFile: 'Zeta.ino', sourceLine: 1 }),
    ]);
    expect(mapDiagnostics([{
      severity: 'error', file: '<generated>', line: 2, message: 'bad generated prototype',
    }], plan.diagnosticMap)).toEqual([
      expect.objectContaining({ sourceFile: 'Alpha.ino', sourceLine: 1, fromGenerated: true }),
    ]);
  });

  it('maps the actual complex preprocess prototype sequence across tabs', () => {
    const plan = planBuildActions({
      project: [
        {
          path: 'main.ino',
          content: [
            'template <typename T>',
            'T ignored_template(T value) { return value; }',
            '',
            'void setup(',
            ')',
            '{',
            '}',
            '',
          ].join('\n'),
        },
        {
          path: 'Auxiliary.ino',
          content: [
            'int',
            'helper(',
            '  int value',
            ')',
            '{',
            '  return value;',
            '}',
            'void loop() {}',
            '',
          ].join('\n'),
        },
      ],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
    });

    expect(plan.diagnosticMap.map((entry) => ({
      generatedLine: entry.generatedLine,
      sourceFile: entry.sourceFile,
      sourceLine: entry.sourceLine,
    }))).toEqual([
      { generatedLine: 1, sourceFile: 'main.ino', sourceLine: 4 },
      { generatedLine: 2, sourceFile: 'Auxiliary.ino', sourceLine: 1 },
      { generatedLine: 3, sourceFile: 'Auxiliary.ino', sourceLine: 8 },
    ]);
  });

  it('binds every Arduino tab content to preprocess and downstream Action keys', () => {
    const create = (tabContent: string) => planBuildIR({
      project: [
        { path: 'main.ino', content: 'void setup() {}\n' },
        { path: 'other.ino', content: tabContent },
      ],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
    });
    const baseline = create('void loop() {}\n');
    const changed = create('void loop() { delay(1); }\n');
    const key = (ir: ReturnType<typeof create>, predicate: (action: (typeof ir.graph.actions)[number]) => boolean) => (
      ir.graph.actions.find(predicate)!.cacheKey
    );
    const preprocess = (action: (typeof baseline.graph.actions)[number]) => action.tool === 'ck:preprocess';
    const compile = (action: (typeof baseline.graph.actions)[number]) => action.kind === 'compile';
    const link = (action: (typeof baseline.graph.actions)[number]) => action.kind === 'link';

    expect(key(changed, preprocess)).not.toBe(key(baseline, preprocess));
    expect(key(changed, compile)).not.toBe(key(baseline, compile));
    expect(key(changed, link)).not.toBe(key(baseline, link));
  });

  it('uses the first lexical tab as the stable main sketch when main.ino is absent', () => {
    const plan = planBuildActions({
      project: [
        { path: 'Zulu.ino', content: 'void loop() {}\n' },
        { path: 'Alpha.ino', content: 'void setup() {}\n' },
      ],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
    });
    const preprocess = plan.actions.find((action) => action.tool === 'ck:preprocess')!;
    expect(preprocess.transform.input).toBe('Alpha.ino');
    expect(preprocess.arguments.slice(0, 2)).toEqual(['Alpha.ino', 'Zulu.ino']);
  });

  it('uses UTF-16 code-unit order for non-BMP sketch names', () => {
    const plan = planBuildActions({
      project: [
        { path: '\ue000.ino', content: 'void loop() {}\n' },
        { path: '\ud83d\ude00.ino', content: 'void setup() {}\n' },
      ],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
    });
    const preprocess = plan.actions.find((action) => action.tool === 'ck:preprocess')!;
    expect(preprocess.transform.input).toBe('\ud83d\ude00.ino');
    expect(preprocess.arguments.slice(0, 2)).toEqual(['\ud83d\ude00.ino', '\ue000.ino']);
  });

  it('compiles platform and library sources into independent archives', () => {
    const plan = planBuildActions({
      project: [{ path: 'main.cpp', content: 'int main() { return demo(); }\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      platform: {
        core: { files: [{ path: 'Core.cpp', content: 'void core() {}\n' }] },
        variant: { files: [{ path: 'pins.c', content: 'int pin = 1;\n' }] },
      },
      archiveOperation: 'crs',
      archiveFlags: ['D'],
      libraries: [{
        pack: library,
        flags: { common: ['-fdata-sections'] },
        files: [
          { path: 'src/Demo.cpp', content: '#include "Demo.h"\nint demo() { return 1; }\n' },
          { path: 'src/Demo.h', content: '#pragma once\n#include "generated.tpp"\nint demo();\n' },
          { path: 'src/generated.inc', content: '#define GENERATED_VALUE 1\n' },
          { path: 'src/generated.tpp', content: 'template <typename T> T generated(T value) { return value; }\n' },
        ],
      }],
    });

    const archives = plan.actions.filter((action) => action.kind === 'archive');
    expect(archives).toHaveLength(2);
    expect(archives.map((action) => action.packDependencies)).toContainEqual([library.id]);
    expect(archives.every((action) => action.arguments[0] === 'crs')).toBe(true);
    expect(archives.every((action) => action.archive.flags.join(' ') === 'D')).toBe(true);
    expect(archives.every((action) => !action.arguments.includes('-fdata-sections'))).toBe(true);
    const link = plan.actions.find((action) => action.kind === 'link');
    expect(link && link.link.archives).toHaveLength(2);
    expect(plan.actions.filter((action) => action.kind === 'compile')).toHaveLength(4);
    const headerInputs = plan.actions
      .filter((action) => action.kind === 'compile' && (
        action.id.startsWith('compile-project-') || action.id.startsWith('compile-library-')
      ))
      .map((action) => action.inputs.filter((input) => input.role === 'library-header'));
    expect(headerInputs).toHaveLength(2);
    expect(headerInputs.every((inputs) => inputs.some((input) => input.path.endsWith('/src/Demo.h')))).toBe(true);
    const libraryCompile = plan.actions.find((action) => action.id.startsWith('compile-library-'))!;
    expect(libraryCompile.inputs).toContainEqual(expect.objectContaining({
      path: expect.stringMatching(/^packs\/libraries\/.+\/src\/generated\.inc$/),
      sha256: sha256Hex('#define GENERATED_VALUE 1\n'),
      role: 'library-include-fragment',
    }));
    const projectCompile = plan.actions.find((action) => action.id.startsWith('compile-project-'))!;
    expect(projectCompile.inputs).toContainEqual(expect.objectContaining({
      path: expect.stringMatching(/^packs\/libraries\/.+\/src\/generated\.tpp$/),
      sha256: sha256Hex('template <typename T> T generated(T value) { return value; }\n'),
      role: 'library-include-fragment',
    }));
    expect(plan.actions.some((action) => (
      action.kind === 'compile' && action.compileUnit.source.endsWith('/src/generated.tpp')
    ))).toBe(false);
    expect(libraryCompile.inputs.filter((input) => input.path.endsWith('/src/Demo.cpp'))).toHaveLength(1);
  });

  it('keeps text-included C++ fragments out of the library archive object list', () => {
    const fragment = 'int included_implementation() { return 7; }\n';
    const plan = planBuildActions({
      project: [{ path: 'main.cpp', content: 'int main() { return 0; }\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      libraries: [{
        pack: library,
        includePaths: ['src'],
        files: [
          { path: 'src/Demo.cpp', content: '/*\n#include "Independent.cpp"\n*/\n#include <detail/Implementation.cpp>\n' },
          { path: 'src/detail/Implementation.cpp', content: fragment },
          { path: 'src/Independent.cpp', content: 'int independent() { return 1; }\n' },
        ],
      }],
    });

    const libraryCompiles = plan.actions.filter((action) => action.id.startsWith('compile-library-'));
    expect(libraryCompiles).toHaveLength(2);
    expect(libraryCompiles.map((action) => action.kind === 'compile' && action.compileUnit.source))
      .not.toContain(expect.stringContaining('Implementation.cpp'));
    expect(libraryCompiles.every((action) => action.inputs.some((input) => (
      input.path.endsWith('/src/detail/Implementation.cpp')
      && input.sha256 === sha256Hex(fragment)
    )))).toBe(true);
    const archive = plan.actions.find((action) => action.kind === 'archive' && action.packDependencies.includes(library.id));
    expect(archive?.kind === 'archive' && archive.archive.objects).toHaveLength(2);
  });

  it('carries text-included C files into project Actions without compiling them independently', () => {
    const font = 'const unsigned char fixture_font[] = { 0 };\n';
    const plan = planBuildActions({
      project: [{ path: 'main.cpp', content: '#include <Display.h>\nint main() { return fixture_font[0]; }\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      libraries: [{
        pack: library,
        includePaths: ['src'],
        files: [
          { path: 'src/Display.h', content: '#pragma once\n#include <Fonts/glcdfont.c>\n' },
          { path: 'src/Fonts/glcdfont.c', content: font },
          { path: 'src/Display.cpp', content: '#include "Display.h"\nint display_driver = 1;\n' },
          { path: 'src/Independent.c', content: 'int independent_driver = 1;\n' },
        ],
      }],
    });

    const projectCompile = plan.actions.find((action) => action.id.startsWith('compile-project-'))!;
    expect(projectCompile.inputs).toContainEqual(expect.objectContaining({
      path: expect.stringMatching(/\/src\/Fonts\/glcdfont\.c$/),
      sha256: sha256Hex(font),
      role: 'library-include-fragment',
    }));
    expect(projectCompile.inputs.some((input) => input.path.endsWith('/src/Independent.c'))).toBe(false);

    const libraryCompiles = plan.actions.filter((action) => action.id.startsWith('compile-library-'));
    expect(libraryCompiles.map((action) => action.kind === 'compile' && action.compileUnit.source))
      .not.toContain(expect.stringContaining('glcdfont.c'));
    expect(libraryCompiles.map((action) => action.kind === 'compile' && action.compileUnit.source))
      .toEqual(expect.arrayContaining([
        expect.stringContaining('/src/Display.cpp'),
        expect.stringContaining('/src/Independent.c'),
      ]));
  });

  it('does not expose nested library source directories as global include roots', () => {
    const plan = planBuildActions({
      project: [{ path: 'main.cpp', content: 'int main() { return 0; }\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      libraries: [{
        pack: library,
        includePaths: ['src'],
        files: [
          { path: 'src/private/Codec.cpp', content: '#include "assert.h"\n' },
          { path: 'src/private/assert.h', content: '#pragma once\n' },
        ],
      }],
    });

    const compile = plan.actions.find((action) => action.id.startsWith('compile-library-'))!;
    expect(compile.kind).toBe('compile');
    if (compile.kind !== 'compile') throw new Error('library compile Action is missing');
    expect(compile.compileUnit.includePaths.some((path) => path.endsWith('/src/private'))).toBe(false);
    expect(compile.compileUnit.flags.some((flag) => flag.endsWith('/src/private'))).toBe(false);
  });

  it('adds only uniquely referenced nested library headers as low-priority include roots', () => {
    const plan = planBuildActions({
      project: [{ path: 'main.cpp', content: 'int main() { return 0; }\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      libraries: [{
        pack: library,
        includePaths: ['src'],
        files: [
          { path: 'src/Demo.cpp', content: '#include <PrivateDriver.h>\n' },
          { path: 'src/utility/PrivateDriver.cpp', content: '#include <PrivateDriver.h>\n' },
          { path: 'src/utility/PrivateDriver.h', content: '#pragma once\n' },
        ],
      }],
    });

    const compiles = plan.actions.filter((action) => action.id.startsWith('compile-library-'));
    expect(compiles).toHaveLength(2);
    for (const compile of compiles) {
      expect(compile.kind).toBe('compile');
      if (compile.kind !== 'compile') throw new Error('library compile Action is missing');
      expect(compile.compileUnit.includePaths.some((path) => path.endsWith('/src/utility'))).toBe(false);
      expect(compile.compileUnit.flags).toEqual(expect.arrayContaining([
        '-idirafter',
        expect.stringMatching(/\/src\/utility$/),
      ]));
    }
  });

  it('resolves a path-qualified private include despite an unrelated same-basename header', () => {
    const plan = planPathQualifiedPrivateInclude('src/unrelated/Foo.h');

    expect(demoPrivateIncludeRoots(plan)).toEqual([
      'packs/libraries/demo/src/private',
    ]);
  });

  it('keeps a path-qualified private include unresolved when its full suffix is ambiguous', () => {
    const plan = planPathQualifiedPrivateInclude('src/alternate/drivers/Foo.h');

    expect(demoPrivateIncludeRoots(plan)).toEqual([]);
  });

  it('produces key-calculated IR and is deterministic under source ordering', () => {
    const input = {
      project: [
        { path: 'z.cpp', content: 'int z;\n' },
        { path: 'a.c', content: 'int a;\n' },
      ],
      target: { fqbn: board.fqbn, options: { mode: 'debug' }, boardPack: board },
      packs,
    } as const;
    const first = planBuildIR(input);
    const second = planBuildIR({ ...input, project: [...input.project].reverse() });
    expect(first.graph.actions.map((action) => action.id)).toEqual(second.graph.actions.map((action) => action.id));
    expect(first.graph.actions.map((action) => action.cacheKey)).toEqual(second.graph.actions.map((action) => action.cacheKey));
    expect(first.graph.actions.find((action) => action.kind === 'compile')?.inputs[0]?.sha256)
      .toBe(sha256Hex('int a;\n'));
  });

  it('propagates compact compiler and linker Pack inputs to their consuming Actions', () => {
    const compilerPackInput = {
      kind: 'pack-artifact' as const,
      packId: packs.platform.id,
      packRevision: packs.platform.sha256,
      packSchema: 1,
      artifactId: 'compile-000',
      sha256: 'e'.repeat(64),
      role: 'compiler-vfs',
    };
    const linkerPackInput = {
      ...compilerPackInput,
      artifactId: 'link-000',
      sha256: 'f'.repeat(64),
      role: 'linker-vfs',
    };
    const ir = planBuildIR({
      project: [{ path: 'main.cpp', content: 'int main() { return 0; }\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      compilerPackInputs: [compilerPackInput],
      linkerPackInputs: [linkerPackInput],
    });
    const compile = ir.graph.actions.find((action) => action.kind === 'compile')!;
    const link = ir.graph.actions.find((action) => action.kind === 'link')!;

    expect(compile.packInputs).toEqual([compilerPackInput]);
    expect(link.packInputs).toEqual([linkerPackInput]);
    expect(compile.inputs.some((input) => input.path.includes('compile-000'))).toBe(false);
    expect(link.inputs.some((input) => input.path.includes('link-000'))).toBe(false);
  });

  it('hashes project headers without invalidating unchanged core and library actions', () => {
    const input = {
      project: [
        { path: 'main.cpp', content: '#include "config.h"\nint main() { return VALUE; }\n' },
        { path: 'config.h', content: '#define VALUE 1\n' },
      ],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      platform: { core: { files: [{ path: 'Core.cpp', content: 'void core() {}\n' }] } },
      libraries: [{ pack: library, files: [{ path: 'Demo.cpp', content: 'int demo() { return 1; }\n' }] }],
    } as const;
    const baseline = planBuildIR(input);
    const changedHeader = planBuildIR({
      ...input,
      project: [input.project[0], { path: 'config.h', content: '#define VALUE 2\n' }],
    });
    const changedMain = planBuildIR({
      ...input,
      project: [{ path: 'main.cpp', content: '#include "config.h"\nint main() { return VALUE + 1; }\n' }, input.project[1]],
    });
    const key = (ir: ReturnType<typeof planBuildIR>, prefix: string) => (
      ir.graph.actions.find((action) => action.id.startsWith(prefix))!.cacheKey
    );

    const project = baseline.graph.actions.find((action) => action.id.startsWith('compile-project-'))!;
    expect(project.inputs).toContainEqual({
      path: 'config.h', sha256: sha256Hex('#define VALUE 1\n'), role: 'project-header',
    });
    expect(key(changedHeader, 'compile-project-')).not.toBe(key(baseline, 'compile-project-'));
    expect(key(changedHeader, 'compile-core-')).toBe(key(baseline, 'compile-core-'));
    expect(key(changedHeader, 'compile-library-')).toBe(key(baseline, 'compile-library-'));
    expect(key(changedMain, 'compile-core-')).toBe(key(baseline, 'compile-core-'));
    expect(key(changedMain, 'compile-library-')).toBe(key(baseline, 'compile-library-'));
  });

  it('adds only project configuration headers referenced by library sources', () => {
    const input = {
      project: [
        { path: 'main.cpp', content: 'int main() { return demo(); }\n' },
        { path: 'lv_conf.h', content: '#define LV_COLOR_DEPTH 16\n' },
        { path: 'unrelated.h', content: '#define OTHER_VALUE 1\n' },
      ],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      includePaths: ['project'],
      libraries: [{
        pack: library,
        files: [
          { path: 'src/Demo.cpp', content: '#include "Demo.h"\nint demo() { return LV_COLOR_DEPTH; }\n' },
          { path: 'src/Demo.h', content: '#if __has_include("lv_conf.h")\n#include "lv_conf.h"\n#endif\n' },
        ],
      }],
    } as const;
    const baseline = planBuildIR(input);
    const changedConfig = planBuildIR({
      ...input,
      project: [input.project[0], { path: 'lv_conf.h', content: '#define LV_COLOR_DEPTH 32\n' }, input.project[2]],
    });
    const changedUnrelated = planBuildIR({
      ...input,
      project: [input.project[0], input.project[1], { path: 'unrelated.h', content: '#define OTHER_VALUE 2\n' }],
    });
    const libraryCompile = (ir: ReturnType<typeof planBuildIR>) => (
      ir.graph.actions.find((action) => action.id.startsWith('compile-library-'))!
    );

    expect(libraryCompile(baseline).inputs).toContainEqual({
      path: 'lv_conf.h', sha256: sha256Hex('#define LV_COLOR_DEPTH 16\n'), role: 'project-header',
    });
    expect(libraryCompile(baseline).inputs).not.toContainEqual(expect.objectContaining({ path: 'unrelated.h' }));
    expect(libraryCompile(changedConfig).cacheKey).not.toBe(libraryCompile(baseline).cacheKey);
    expect(libraryCompile(changedUnrelated).cacheKey).toBe(libraryCompile(baseline).cacheKey);
  });

  it('records project headers referenced by parent-relative includes outside a library Pack root', () => {
    const input = {
      project: [
        { path: 'main.cpp', content: 'int main() { return demo(); }\n' },
        { path: 'lv_conf.h', content: '#define LV_COLOR_DEPTH 16\n' },
        { path: 'unrelated.h', content: '#define OTHER_VALUE 1\n' },
      ],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      includePaths: ['project'],
      libraries: [{
        pack: library,
        files: [
          { path: 'src/Demo.cpp', content: '#include "lv_conf_internal.h"\nint demo() { return LV_COLOR_DEPTH; }\n' },
          { path: 'src/lv_conf_internal.h', content: '#include "../../lv_conf.h"\n' },
        ],
      }],
    } as const;
    const plan = planBuildIR(input);
    const action = plan.graph.actions.find((candidate) => candidate.id.startsWith('compile-library-'))!;

    expect(action.inputs).toContainEqual({
      path: 'lv_conf.h', sha256: sha256Hex('#define LV_COLOR_DEPTH 16\n'), role: 'project-header',
    });
    expect(action.inputs).not.toContainEqual(expect.objectContaining({ path: 'unrelated.h' }));
  });

  it('defaults AVR targets to HEX while allowing explicit transforms', () => {
    const avrBoard: BoardPackRef = { ...board, fqbn: 'arduino:avr:uno', id: 'board:uno' };
    const avrPacks: BuildPacks = { ...packs, board: avrBoard };
    const defaultPlan = planBuildActions({
      project: [{ path: 'main.c', content: 'int main(void) { return 0; }\n' }],
      target: { fqbn: avrBoard.fqbn, options: {}, boardPack: avrBoard },
      packs: avrPacks,
    });
    expect(defaultPlan.artifacts.some((artifact) => artifact.format === 'hex')).toBe(true);

    const explicit = planBuildActions({
      project: [{ path: 'main.c', content: 'int main(void) { return 0; }\n' }],
      target: { fqbn: avrBoard.fqbn, options: {}, boardPack: avrBoard },
      packs: avrPacks,
      transforms: [{ format: 'bin', output: 'out/image.bin', offset: '0x10000' }],
    });
    expect(explicit.artifacts).toContainEqual({ path: 'out/image.bin', format: 'bin', offset: '0x10000' });
    const explicitTransform = planBuildActions({
      project: [{ path: 'main.c', content: 'int main(void) { return 0; }\n' }],
      target: { fqbn: avrBoard.fqbn, options: {}, boardPack: avrBoard },
      packs: avrPacks,
      transforms: ['hex'],
    }).actions.find((action) => action.kind === 'transform');
    expect(explicitTransform?.arguments.slice(0, 4)).toEqual([
      '-O', 'ihex', explicitTransform!.transform.input, explicitTransform!.transform.output,
    ]);
  });

  it('uses stable product ids and binds every multi-input transform dependency', () => {
    const createIr = (bootloaderSha256: string) => planBuildIR({
      project: [{ path: 'main.c', content: 'int main(void) { return 0; }\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      transforms: [
        {
          id: 'transform-merged',
          productId: 'merged',
          format: 'bin',
          input: 'build/application.bin',
          inputs: [
            { path: 'build/application.bin', role: 'application-image' },
            {
              path: 'packs/board/bootloader.bin',
              sha256: bootloaderSha256,
              role: 'bootloader-image',
            },
          ],
          output: 'build/merged.bin',
          tool: 'toolchain:esptool',
          arguments: [
            'merge-bin',
            'build/application.bin',
            'packs/board/bootloader.bin',
            '-o', 'build/merged.bin',
          ],
        },
        {
          id: 'transform-application',
          productId: 'application',
          format: 'bin',
          output: 'build/application.bin',
        },
      ],
    });

    const first = createIr('8'.repeat(64));
    const application = first.graph.actions.find((action) => action.id === 'transform-application');
    const merged = first.graph.actions.find((action) => action.id === 'transform-merged');
    expect(application?.dependencies).toEqual(['link-firmware']);
    expect(merged?.dependencies).toEqual(['transform-application']);
    expect(merged?.inputs).toEqual([
      { path: 'build/application.bin', role: 'application-image' },
      { path: 'packs/board/bootloader.bin', sha256: '8'.repeat(64), role: 'bootloader-image' },
    ]);

    const second = createIr('9'.repeat(64));
    expect(second.graph.actions.find((action) => action.id === 'transform-merged')?.cacheKey)
      .not.toBe(merged?.cacheKey);
  });

  it('keeps configuration transforms independent of project Library Packs', () => {
    const plan = planBuildActions({
      project: [{ path: 'main.c', content: 'int main(void) { return 0; }\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      transforms: [{
        id: 'transform-bootloader',
        productId: 'bootloader',
        lifecycle: 'configuration',
        format: 'bootloader',
        input: 'packs/board/bootloader.bin',
        inputSha256: '8'.repeat(64),
        output: 'build/bootloader.bin',
      }],
    });
    const transform = plan.actions.find((action) => action.id === 'transform-bootloader');

    expect(transform?.packDependencies).toEqual([]);
    expect(plan.actions.find((action) => action.id === 'link-firmware')?.packDependencies)
      .toContain(library.id);
  });

  it('rejects ambiguous transform products and unbound inputs', () => {
    const base = {
      project: [{ path: 'main.c', content: 'int main(void) { return 0; }\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
    };
    expect(() => planBuildActions({
      ...base,
      transforms: [
        { format: 'bin', output: 'build/first.bin' },
        { format: 'bin', output: 'build/second.bin' },
      ],
    })).toThrow('duplicate transform action id: transform-bin');
    expect(() => planBuildActions({
      ...base,
      transforms: [{
        id: 'transform-merged',
        productId: 'merged',
        format: 'bin',
        input: 'build/missing.bin',
        inputs: [{ path: 'build/missing.bin' }],
      }],
    })).toThrow('input has neither an immutable sha256 nor a producing Action');
  });

  it('keeps linker prefix and tail flags around objects and archives', () => {
    const plan = planBuildActions({
      project: [{ path: 'main.cpp', content: 'int main() { return 0; }\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      platform: { core: { files: [{ path: 'Core.cpp', content: 'void core() {}\n' }] } },
      linkerFlags: ['-Lpacks/platform/sdk/lib', '-Wl,--start-group'],
      linkerTailFlags: ['@packs/platform/sdk/flags/ld_libs', '-Wl,--end-group'],
    });
    const link = plan.actions.find((action) => action.kind === 'link')!;
    const firstObject = link.arguments.findIndex((argument) => argument.endsWith('.o'));
    const firstArchive = link.arguments.findIndex((argument) => argument.endsWith('.a'));
    expect(link.arguments.indexOf('-Wl,--start-group')).toBeLessThan(firstObject);
    expect(firstObject).toBeLessThan(firstArchive);
    expect(firstArchive).toBeLessThan(link.arguments.indexOf('@packs/platform/sdk/flags/ld_libs'));
    expect(link.arguments.indexOf('@packs/platform/sdk/flags/ld_libs'))
      .toBeLessThan(link.arguments.indexOf('-Wl,--end-group'));
    expect(link.arguments.indexOf('-Wl,--end-group')).toBeLessThan(link.arguments.indexOf('-o'));
  });

  it('models immutable Platform archives as ordered linker inputs', () => {
    const coreHash = 'e'.repeat(64);
    const plan = planBuildActions({
      project: [{ path: 'main.cpp', content: 'int main() { return 0; }\n' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      platform: {
        prebuiltArchives: [{ path: 'packs/platform/core.a', sha256: coreHash }],
      },
      linkerFlags: ['-Wl,--start-group'],
      linkerTailFlags: ['-Wl,--end-group'],
    });
    const link = plan.actions.find((action) => action.kind === 'link')!;
    expect(link.inputs).toContainEqual({
      path: 'packs/platform/core.a', sha256: coreHash, role: 'static-library',
    });
    expect(link.kind === 'link' && link.link.archives).toContain('packs/platform/core.a');
    expect(link.arguments.indexOf('packs/platform/core.a'))
      .toBeLessThan(link.arguments.indexOf('-Wl,--end-group'));
  });

  it('keeps sibling C and C++ objects distinct and orders dependency archives first', () => {
    const leaf: LibraryPackRef = {
      ...library, id: 'library:leaf@1.0.0', name: 'Leaf', sha256: '1'.repeat(64),
    };
    const middle: LibraryPackRef = {
      ...library, id: 'library:middle@1.0.0', name: 'Middle', sha256: '2'.repeat(64),
      dependencies: [{ id: leaf.id, version: leaf.version, sha256: leaf.sha256 }],
    };
    const dependencyPacks: BuildPacks = {
      ...packs,
      libraries: { roots: [middle.id], packs: [middle, leaf] },
    };
    const plan = planBuildActions({
      project: [
        { path: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' },
        { path: 'foo.c', content: 'int c(void) { return 1; }\n' },
        { path: 'foo.cpp', content: 'int cpp() { return 1; }\n' },
      ],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs: dependencyPacks,
      libraries: [
        { pack: leaf, files: [{ path: 'leaf.cpp', content: 'int leaf() { return 1; }\n' }] },
        { pack: middle, files: [{ path: 'middle.cpp', content: 'int middle() { return 1; }\n' }] },
      ],
      compilerInputs: [{ path: 'packs/platform/flags/cpp_flags', sha256: 'f'.repeat(64) }],
    });
    const projectObjects = plan.actions
      .filter((action) => action.kind === 'compile' && action.id.startsWith('compile-project-'))
      .map((action) => action.outputs[0]!.path);
    expect(new Set(projectObjects).size).toBe(projectObjects.length);
    const link = plan.actions.find((action) => action.id === 'link-firmware')!;
    const archives = link.kind === 'link' ? link.link.archives : [];
    expect(archives.findIndex((path) => path.includes('library_leaf')))
      .toBeLessThan(archives.findIndex((path) => path.includes('library_middle')));
    const middleCompile = plan.actions.find((action) => (
      action.kind === 'compile' && action.compileUnit.source.includes('middle.cpp')
    ))!;
    expect(middleCompile.packDependencies).toEqual([leaf.id, middle.id].sort());
    expect(middleCompile.inputs).toContainEqual({
      path: 'packs/platform/flags/cpp_flags', sha256: 'f'.repeat(64),
    });
  });
});
