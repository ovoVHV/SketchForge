import { describe, expect, it } from 'vitest';
import {
  createPlatformManifest,
  createPlatformRecipeLowering,
  resolvePlatformManifest,
  tokenizeRecipe,
} from '../src/platform-pack/builder.js';
import { canonicalJson, sha256Hex } from '../src/build-ir/canonical.js';
import { lowerEsp32PostLinkTransforms } from '../src/build-ir/platform-planning.js';
import {
  deriveEsp32PostLinkContract,
  derivePlatformRecipeCommands,
} from '../src/platform-pack/recipe-command-lowering.js';
import type {
  CKEsp32PostLinkBindings,
  DeriveEsp32PostLinkContractInput,
} from '../src/platform-pack/recipe-command-lowering.js';
import type { CKPlatformManifest, PlatformRecipe } from '../src/platform-pack/types.js';

const LOWERING = createPlatformRecipeLowering();
const BOARD_PACK_REVISION_INPUT = JSON.stringify({
  schema: 2,
  id: 'board:unit',
  version: '1.0.0',
  artifacts: [
    { id: 'bootloader-default', kind: 'bin', size: 1, sha256: 'a'.repeat(64) },
    { id: 'partitions-default', kind: 'bin', size: 1, sha256: 'b'.repeat(64) },
    { id: 'boot-app0', kind: 'bin', size: 1, sha256: 'c'.repeat(64) },
  ],
});
const BOARD_PACK_SHA256 = sha256Hex(BOARD_PACK_REVISION_INPUT);
const ESP_SR_MODEL_SIZE = 2_468_362;
const ESP_SR_MODEL_CAPACITY = 0x2f0000;
const ESP_SR_MODEL_SHA256 = '0312f2dde9581cd604e752fbfa287d687a2acc0631e593a35a24c4a518d75879';
const ESP_SR_BOARD_PACK_REVISION_INPUT = JSON.stringify({
  schema: 2,
  id: 'board:unit',
  version: '1.0.0',
  artifacts: [
    { id: 'bootloader-default', kind: 'bin', size: 1, sha256: 'a'.repeat(64) },
    { id: 'partitions-default', kind: 'bin', size: 1, sha256: 'b'.repeat(64) },
    { id: 'boot-app0', kind: 'bin', size: 1, sha256: 'c'.repeat(64) },
    { id: 'srmodels', kind: 'bin', size: ESP_SR_MODEL_SIZE, sha256: ESP_SR_MODEL_SHA256 },
  ],
});
const ESP_SR_BOARD_PACK_SHA256 = sha256Hex(ESP_SR_BOARD_PACK_REVISION_INPUT);

const BOUND_RECIPES = [
  ['compile.c', LOWERING.bindings.compile.c],
  ['compile.cxx', LOWERING.bindings.compile.cxx],
  ['compile.asm', LOWERING.bindings.compile.asm],
  ['archive', LOWERING.bindings.archive],
  ['link', LOWERING.bindings.link],
] as const;

function recipe(id: string, pattern: string): PlatformRecipe {
  const argv = tokenizeRecipe(pattern);
  const placeholders = new Set<string>();
  for (const argument of argv) {
    const matcher = /\{([^{}]+)\}/g;
    for (let match = matcher.exec(argument); match; match = matcher.exec(argument)) {
      placeholders.add(match[1]!);
    }
  }
  return { id, argv, placeholders: [...placeholders].sort() };
}

function compilePattern(
  commandProperty: string,
  flagsProperty: string,
  extraFlagsProperty: string,
  commonFlags = '{compiler.common.flags}',
): string {
  return [
    `"{compiler.path}{${commandProperty}}"`,
    commonFlags,
    `{${flagsProperty}}`,
    `{${extraFlagsProperty}}`,
    '-c',
    '"{source_file}"',
    '-o',
    '"{object_file}"',
  ].join(' ');
}

function fixtureRecipes(commonFlags: Readonly<{
  c?: string;
  cxx?: string;
  asm?: string;
}> = {}): PlatformRecipe[] {
  return [
    recipe('recipe.c.o', compilePattern(
      'compiler.c.cmd', 'compiler.c.flags', 'compiler.c.extra_flags', commonFlags.c,
    )),
    recipe('recipe.cpp.o', compilePattern(
      'compiler.cpp.cmd', 'compiler.cpp.flags', 'compiler.cpp.extra_flags', commonFlags.cxx,
    )),
    recipe('recipe.S.o', compilePattern(
      'compiler.c.cmd', 'compiler.S.flags', 'compiler.S.extra_flags', commonFlags.asm,
    )),
    recipe(
      'recipe.ar',
      '"{compiler.path}{compiler.ar.cmd}" {compiler.ar.flags} {compiler.ar.extra_flags} '
        + '"{archive_file_path}" "{object_file}"',
    ),
    recipe(
      'recipe.c.combine',
      '"{compiler.path}{compiler.cpp.cmd}" {compiler.c.elf.flags} -o '
        + '"{build.path}/{build.project_name}.elf" "{object_files}" "{archive_file_path}"',
    ),
  ];
}

function fixtureProperties(
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    'compiler.path': 'toolchain/bin/',
    'compiler.c.cmd': 'clang',
    'compiler.cpp.cmd': 'clang++',
    'compiler.ar.cmd': 'ar',
    'compiler.common.flags': '-Os -ffunction-sections',
    'compiler.c.flags': '-std=gnu17 @sdk/flags/c_flags',
    'compiler.cpp.flags': '-std=gnu++17 @sdk/flags/cpp_flags',
    'compiler.S.flags': '-x assembler-with-cpp @sdk/flags/S_flags',
    'compiler.c.extra_flags': '',
    'compiler.cpp.extra_flags': '',
    'compiler.S.extra_flags': '',
    'compiler.ar.flags': 'rcs',
    'compiler.ar.extra_flags': 'D --plugin sdk/ar/plugin.so',
    'compiler.c.elf.flags': '-Wl,--gc-sections',
    'source_file': 'src/sketch.cpp',
    'object_file': 'build/sketch.o',
    'object_files': 'build/sketch.o',
    'archive_file_path': 'build/core.a',
    'build.path': 'build',
    'build.project_name': 'firmware',
    ...overrides,
  };
}

function snapshotArguments(argumentsList: readonly Readonly<{
  value: string;
  dependencies: ReadonlySet<string>;
}>[]): Array<{ value: string; dependencies: string[] }> {
  return argumentsList.map((argument) => ({
    value: argument.value,
    dependencies: [...argument.dependencies].sort(),
  }));
}

function derive(
  recipes = fixtureRecipes(),
  properties = fixtureProperties(),
) {
  return derivePlatformRecipeCommands({ recipes, recipeLowering: LOWERING, properties });
}

function postLinkManifest(
  overrides: Readonly<Record<string, string>> = {},
  boardMcu = 'esp32c3',
): CKPlatformManifest {
  const properties: Record<string, string> = {
    name: 'ESP32 post-link fixture',
    'compiler.ar.cmd': 'ar',
    'compiler.ar.flags': 'rcs',
    'compiler.ar.extra_flags': '',
    'recipe.c.o.pattern': 'gcc -c "{source_file}" -o "{object_file}"',
    'recipe.cpp.o.pattern': 'g++ -c "{source_file}" -o "{object_file}"',
    'recipe.S.o.pattern': 'gcc -c "{source_file}" -o "{object_file}"',
    'recipe.ar.pattern': '{compiler.ar.cmd} {compiler.ar.flags} '
      + '{compiler.ar.extra_flags} "{archive_file_path}" "{object_file}"',
    'recipe.c.combine.pattern': 'g++ "{object_files}" "{archive_file_path}" '
      + '-o "{build.path}/{build.project_name}.elf"',
    'build.flash_freq': '80m',
    'build.img_freq': '{build.flash_freq}',
    'build.flash_mode': 'dio',
    'build.flash_size': '4MB',
    'build.partitions': 'default',
    'upload.extra_flags': '',
    'tools.esptool_py.path': '{runtime.tools.esptool_py.path}',
    'tools.esptool_py.cmd': 'esptool',
    'tools.gen_esp32part.cmd': 'python3 "{runtime.platform.path}/tools/gen_esp32part.py"',
    'recipe.objcopy.bin.pattern': '"{tools.esptool_py.path}/{tools.esptool_py.cmd}" '
      + '"{recipe.objcopy.bin.pattern_args}"',
    'recipe.objcopy.bin.pattern_args': [
      '--chip {build.mcu} elf2image',
      '--flash-mode "{build.flash_mode}"',
      '--flash-freq "{build.img_freq}"',
      '--flash-size "{build.flash_size}"',
      '--elf-sha256-offset 0xb0',
      '-o "{build.path}/{build.project_name}.bin"',
      '"{build.path}/{build.project_name}.elf"',
    ].join(' '),
    'recipe.objcopy.partitions.bin.pattern': '"{tools.gen_esp32part.cmd}" -q '
      + '"{build.path}/partitions.csv" "{build.path}/{build.project_name}.partitions.bin"',
    'recipe.hooks.prebuild.4.pattern': '/usr/bin/env bash -c '
      + '"opaque shell {recipe.hooks.prebuild.4.pattern_args}"',
    'recipe.hooks.prebuild.4.pattern_args': [
      '--chip {build.mcu} elf2image',
      '--flash-mode {build.flash_mode}',
      '--flash-freq {build.img_freq}',
      '--flash-size {build.flash_size}',
      '-o',
    ].join(' '),
    'recipe.hooks.objcopy.postobjcopy.3.pattern':
      '"{tools.esptool_py.path}/{tools.esptool_py.cmd}" '
      + '"{recipe.hooks.objcopy.postobjcopy.3.pattern_args}"',
    'recipe.hooks.objcopy.postobjcopy.3.pattern_args': [
      '--chip {build.mcu} merge-bin',
      '-o "{build.path}/{build.project_name}.merged.bin"',
      '--pad-to-size {build.flash_size}',
      '--flash-mode keep --flash-freq keep --flash-size keep',
      '{build.bootloader_addr} "{build.path}/{build.project_name}.bootloader.bin"',
      '0x8000 "{build.path}/{build.project_name}.partitions.bin"',
      '0xe000 "{runtime.platform.path}/tools/partitions/boot_app0.bin"',
      '0x10000 "{build.path}/{build.project_name}.bin"',
    ].join(' '),
    ...overrides,
  };
  return createPlatformManifest({
    id: 'espressif-arduino',
    version: '3.3.7',
    vendor: 'esp32',
    architecture: 'esp32',
    runtimeToolPolicy: 'deferred-ck-binding',
    platformText: Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n'),
    boardsText: [
      'unit.name=ESP32 Contract Unit',
      'unit.build.core=esp32',
      'unit.build.variant=unit',
      `unit.build.mcu=${boardMcu}`,
      'unit.build.bootloader_addr=0x0',
    ].join('\n'),
  });
}

function browserPostLinkBindings(
  boardPackSha256 = BOARD_PACK_SHA256,
): CKEsp32PostLinkBindings {
  return {
    application: {
      kind: 'action-output',
      actionId: 'link-elf',
      path: 'build/firmware.elf',
      role: 'linked-elf',
    },
    bootloader: {
      source: 'immutable-bin',
      input: {
        kind: 'immutable', path: 'packs/board/bootloader.bin',
        role: 'bootloader-source', sha256: 'a'.repeat(64),
        provenance: {
          kind: 'pack-artifact', packId: 'board:unit',
          packSha256: boardPackSha256, packSchema: 2,
          artifactId: 'bootloader-default',
        },
      },
    },
    partitions: {
      source: 'immutable-bin',
      input: {
        kind: 'immutable', path: 'packs/board/partitions.bin',
        role: 'partitions-source', sha256: 'b'.repeat(64),
        provenance: {
          kind: 'pack-artifact', packId: 'board:unit',
          packSha256: boardPackSha256, packSchema: 2,
          artifactId: 'partitions-default',
        },
      },
    },
    bootApp0: {
      kind: 'immutable', path: 'packs/board/boot_app0.bin',
      role: 'boot-app0-source', sha256: 'c'.repeat(64),
      provenance: {
        kind: 'pack-artifact', packId: 'board:unit',
        packSha256: boardPackSha256, packSchema: 2, artifactId: 'boot-app0',
      },
    },
  };
}

function espSrPostLinkBindings(): CKEsp32PostLinkBindings {
  return {
    ...browserPostLinkBindings(ESP_SR_BOARD_PACK_SHA256),
    model: {
      kind: 'immutable',
      path: 'packs/board/srmodels.bin',
      role: 'model-source',
      sha256: ESP_SR_MODEL_SHA256,
      size: ESP_SR_MODEL_SIZE,
      provenance: {
        kind: 'pack-artifact',
        packId: 'board:unit',
        packSha256: ESP_SR_BOARD_PACK_SHA256,
        packSchema: 2,
        artifactId: 'srmodels',
      },
    },
  };
}

function espSrPostLinkManifest(
  overrides: Readonly<Record<string, string>> = {},
): CKPlatformManifest {
  return postLinkManifest({
    'build.flash_size': '16MB',
    'build.partitions': 'esp_sr_16',
    'recipe.hooks.objcopy.postobjcopy.3.pattern_args': [
      '--chip {build.mcu} merge-bin',
      '-o "{build.path}/{build.project_name}.merged.bin"',
      '--pad-to-size {build.flash_size}',
      '--flash-mode keep --flash-freq keep --flash-size keep',
      '{build.bootloader_addr} "{build.path}/{build.project_name}.bootloader.bin"',
      '0x8000 "{build.path}/{build.project_name}.partitions.bin"',
      '0xe000 "{runtime.platform.path}/tools/partitions/boot_app0.bin"',
      '0x10000 "{build.path}/{build.project_name}.bin"',
    ].join(' '),
    ...overrides,
  }, 'esp32s3');
}

function projectPartitionsBindings(): CKEsp32PostLinkBindings {
  const bindings = browserPostLinkBindings();
  const fileSha256 = 'd'.repeat(64);
  bindings.partitions = {
    source: 'csv',
    input: {
      kind: 'immutable', path: 'partitions.csv',
      role: 'partitions-source', sha256: fileSha256,
      provenance: {
        kind: 'project-file', path: 'partitions.csv',
        projectSha256: 'e'.repeat(64), fileSha256,
      },
    },
  };
  return bindings;
}

function derivePostLink(
  overrides: Partial<DeriveEsp32PostLinkContractInput> = {},
) {
  const manifest = overrides.manifest ?? postLinkManifest();
  const resolved = overrides.resolved ?? resolvePlatformManifest({
    manifest,
    fqbn: 'esp32:esp32:unit',
  });
  return deriveEsp32PostLinkContract({
    manifest,
    resolved,
    boardPack: { id: 'board:unit', sha256: BOARD_PACK_SHA256 },
    boardPackRevisionInput: BOARD_PACK_REVISION_INPUT,
    bindings: browserPostLinkBindings(),
    ...overrides,
  });
}

function deriveEspSrPostLink(
  overrides: Partial<DeriveEsp32PostLinkContractInput> = {},
) {
  const manifest = overrides.manifest ?? espSrPostLinkManifest();
  const resolved = overrides.resolved ?? resolvePlatformManifest({
    manifest,
    fqbn: 'esp32:esp32:unit',
  });
  return deriveEsp32PostLinkContract({
    manifest,
    resolved,
    boardPack: { id: 'board:unit', sha256: ESP_SR_BOARD_PACK_SHA256 },
    boardPackRevisionInput: ESP_SR_BOARD_PACK_REVISION_INPUT,
    bindings: espSrPostLinkBindings(),
    ...overrides,
  });
}

function withManifestRecipes(
  manifest: CKPlatformManifest,
  recipes: PlatformRecipe[],
): CKPlatformManifest {
  const { sha256: _sha256, ...existing } = manifest;
  const body = { ...existing, recipes };
  return { ...body, sha256: sha256Hex(canonicalJson(body)) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('derivePlatformRecipeCommands', () => {
  it('separates c, cxx, and asm response arguments while preserving one common argv', () => {
    const commands = derive();

    expect(commands.compile.languageFlags).toEqual({
      c: ['-std=gnu17', '@sdk/flags/c_flags'],
      cxx: ['-std=gnu++17', '@sdk/flags/cpp_flags'],
      asm: ['-x', 'assembler-with-cpp', '@sdk/flags/S_flags'],
    });
    expect(snapshotArguments(commands.compile.common)).toEqual([
      { value: '-Os', dependencies: ['compiler.common.flags'] },
      { value: '-ffunction-sections', dependencies: ['compiler.common.flags'] },
      { value: 'src/sketch.cpp', dependencies: ['source_file'] },
      { value: '-o', dependencies: [] },
      { value: 'build/sketch.o', dependencies: ['object_file'] },
    ]);
    expect(commands.compile.common.map((argument) => argument.value)).not.toEqual(
      expect.arrayContaining(['-x', '@sdk/flags/c_flags', '@sdk/flags/cpp_flags', '@sdk/flags/S_flags']),
    );
  });

  it.each([
    [
      'value',
      '{compiler.common.flags} -funsigned-char',
      {},
    ],
    [
      'dependency identity',
      '{compiler.c.common.flags}',
      { 'compiler.c.common.flags': '-Os -ffunction-sections' },
    ],
  ] as const)('fails closed when common argv %s drifts', (_kind, cCommon, properties) => {
    expect(() => derive(
      fixtureRecipes({ c: cCommon }),
      fixtureProperties(properties),
    )).toThrow(/Platform c and cxx compile recipes contain unmodeled common argv differences/);
  });

  it('recursively expands dynamic placeholders and records every dependency', () => {
    const commands = derive(fixtureRecipes(), fixtureProperties({
      'compiler.common.flags': '{build.compile.flags}',
      'build.compile.flags': '{optimization.flags} {board.define}',
      'optimization.flags': '-O2',
      'board.define': '-DBOARD={board.id}',
      'board.id': 'recursive',
      'source_file': '{paths.source}',
      'paths.source': 'src/recursive.cpp',
      'object_file': '{paths.object}',
      'paths.object': 'build/recursive.o',
      'object_files': '{paths.objects}',
      'paths.objects': 'build/recursive.o build/support.o',
      'archive_file_path': '{paths.archive}',
      'paths.archive': 'build/core.a',
      'build.path': '{paths.build}',
      'paths.build': 'out',
      'build.project_name': '{project.name}',
      'project.name': 'firmware',
    }));

    const recursiveFlagDependencies = [
      'board.define',
      'board.id',
      'build.compile.flags',
      'compiler.common.flags',
      'optimization.flags',
    ];
    expect(snapshotArguments(commands.compile.common)).toEqual([
      { value: '-O2', dependencies: recursiveFlagDependencies },
      { value: '-DBOARD=recursive', dependencies: recursiveFlagDependencies },
      { value: 'src/recursive.cpp', dependencies: ['paths.source', 'source_file'] },
      { value: '-o', dependencies: [] },
      { value: 'build/recursive.o', dependencies: ['object_file', 'paths.object'] },
    ]);
    expect(snapshotArguments(commands.link)).toEqual([
      {
        value: 'toolchain/bin/clang++',
        dependencies: ['compiler.cpp.cmd', 'compiler.path'],
      },
      { value: '-Wl,--gc-sections', dependencies: ['compiler.c.elf.flags'] },
      { value: '-o', dependencies: [] },
      {
        value: 'out/firmware.elf',
        dependencies: ['build.path', 'build.project_name', 'paths.build', 'project.name'],
      },
      {
        value: 'build/recursive.o',
        dependencies: ['object_files', 'paths.objects'],
      },
      {
        value: 'build/support.o',
        dependencies: ['object_files', 'paths.objects'],
      },
      {
        value: 'build/core.a',
        dependencies: ['archive_file_path', 'paths.archive'],
      },
    ]);
  });

  it.each(BOUND_RECIPES)(
    '%s binding fails closed when its recipe is missing or duplicated',
    (_binding, recipeId) => {
      const recipes = fixtureRecipes();
      const expected = new RegExp(`exactly one ${escapeRegExp(recipeId)} recipe`);

      expect(() => derive(
        recipes.filter((candidate) => candidate.id !== recipeId),
      )).toThrow(expected);

      const boundRecipe = recipes.find((candidate) => candidate.id === recipeId)!;
      expect(() => derive([...recipes, boundRecipe])).toThrow(expected);
    },
  );

  it('returns the strict ar rcs operation-output-inputs-flags archive contract', () => {
    expect(derive().archive).toStrictEqual({
      recipeId: 'recipe.ar',
      command: 'ar',
      operation: 'rcs',
      argumentOrder: ['operation', 'output', 'inputs', 'flags'],
      flags: ['D', '--plugin', 'sdk/ar/plugin.so'],
    });
  });

  it('normalizes the Arduino cr source operation to the CK rcs contract', () => {
    expect(derive(fixtureRecipes(), fixtureProperties({
      'compiler.ar.flags': 'cr',
    })).archive.operation).toBe('rcs');
  });

  it.each([
    [
      'operation drift',
      '"{compiler.path}{compiler.ar.cmd}" crs {compiler.ar.extra_flags} '
        + '"{archive_file_path}" "{object_file}"',
      /exactly one cr or rcs operation/,
    ],
    [
      'structural input drift',
      '"{compiler.path}{compiler.ar.cmd}" {compiler.ar.flags} {compiler.ar.extra_flags} '
        + '"{archive_file_path}"',
      /exactly one output and object input/,
    ],
    [
      'unmodeled argv drift',
      '"{compiler.path}{compiler.ar.cmd}" {compiler.ar.flags} --mystery '
        + '"{archive_file_path}" "{object_file}"',
      /unmodeled argument: --mystery/,
    ],
  ] as const)('fails closed on archive %s', (_label, pattern, expected) => {
    const recipes = fixtureRecipes().map((candidate) => (
      candidate.id === 'recipe.ar' ? recipe('recipe.ar', pattern) : candidate
    ));
    expect(() => derive(recipes)).toThrow(expected);
  });
});

describe('deriveEsp32PostLinkContract', () => {
  it('derives a deterministic, content-addressed five-product contract', () => {
    const contract = derivePostLink();
    const { sha256, ...body } = contract;

    expect(contract.kind).toBe('ck-esp32-post-link-contract');
    expect(contract.schemaVersion).toBe(1);
    expect(sha256).toBe(sha256Hex(canonicalJson(body)));
    expect(contract.target).toEqual({
      chip: 'esp32c3',
      flashMode: 'dio',
      flashFrequency: '80m',
      flashSize: '4MB',
    });
    expect(contract.products.map((product) => ({
      id: product.id,
      productId: product.productId,
      lifecycle: product.lifecycle,
      format: product.format,
      output: product.output,
      offset: product.offset,
      operation: product.operation.kind,
    }))).toEqual([
      {
        id: 'transform-application', productId: 'application', lifecycle: 'project',
        format: 'bin', output: 'build/firmware.bin', offset: '0x10000',
        operation: 'esp32.elf2image',
      },
      {
        id: 'transform-bootloader', productId: 'bootloader', lifecycle: 'configuration',
        format: 'bootloader', output: 'build/bootloader.bin', offset: '0x0',
        operation: 'materialize',
      },
      {
        id: 'transform-partitions', productId: 'partitions', lifecycle: 'configuration',
        format: 'partition', output: 'build/partitions.bin', offset: '0x8000',
        operation: 'materialize',
      },
      {
        id: 'transform-boot-app0', productId: 'boot-app0', lifecycle: 'configuration',
        format: 'boot-app0', output: 'build/boot_app0.bin',
        offset: '0xe000', operation: 'materialize',
      },
      {
        id: 'transform-merged', productId: 'merged', lifecycle: 'project',
        format: 'bin', output: 'build/firmware.merged.bin', offset: undefined,
        operation: 'esp32.merge-bin',
      },
    ]);
    const merge = contract.products.at(-1)!.operation;
    expect(merge.kind).toBe('esp32.merge-bin');
    if (merge.kind !== 'esp32.merge-bin') throw new Error('expected merge operation');
    expect(merge.segments.map(({ productId, offset, input }) => ({
      productId, offset, actionId: input.actionId, path: input.path,
    }))).toEqual([
      {
        productId: 'bootloader', offset: '0x0',
        actionId: 'transform-bootloader', path: 'build/bootloader.bin',
      },
      {
        productId: 'partitions', offset: '0x8000',
        actionId: 'transform-partitions', path: 'build/partitions.bin',
      },
      {
        productId: 'boot-app0', offset: '0xe000',
        actionId: 'transform-boot-app0', path: 'build/boot_app0.bin',
      },
      {
        productId: 'application', offset: '0x10000',
        actionId: 'transform-application', path: 'build/firmware.bin',
      },
    ]);
    expect(Object.isFrozen(contract)).toBe(true);

    expect(derivePostLink()).toEqual(contract);
  });

  it('derives an independent ESP32-S3 esp_sr_16 six-product contract with five merge segments', () => {
    const contract = deriveEspSrPostLink();

    expect(contract.target).toEqual({
      chip: 'esp32s3',
      flashMode: 'dio',
      flashFrequency: '80m',
      flashSize: '16MB',
    });
    expect(contract.products.map((product) => ({
      productId: product.productId,
      output: product.output,
      offset: product.offset,
      operation: product.operation.kind,
    }))).toEqual([
      {
        productId: 'application', output: 'build/firmware.bin',
        offset: '0x10000', operation: 'esp32.elf2image',
      },
      {
        productId: 'bootloader', output: 'build/bootloader.bin',
        offset: '0x0', operation: 'materialize',
      },
      {
        productId: 'partitions', output: 'build/partitions.bin',
        offset: '0x8000', operation: 'materialize',
      },
      {
        productId: 'boot-app0', output: 'build/boot_app0.bin',
        offset: '0xe000', operation: 'materialize',
      },
      {
        productId: 'model', output: 'build/srmodels.bin',
        offset: '0xd10000', operation: 'materialize',
      },
      {
        productId: 'merged', output: 'build/firmware.merged.bin',
        offset: undefined, operation: 'esp32.merge-bin',
      },
    ]);
    const model = contract.products.find((product) => product.productId === 'model')!;
    expect(model.operation).toEqual({
      kind: 'materialize',
      input: {
        kind: 'immutable',
        path: 'packs/board/srmodels.bin',
        role: 'model-source',
        sha256: ESP_SR_MODEL_SHA256,
        size: ESP_SR_MODEL_SIZE,
        provenance: {
          kind: 'pack-artifact',
          packId: 'board:unit',
          packSha256: ESP_SR_BOARD_PACK_SHA256,
          packSchema: 2,
          artifactId: 'srmodels',
        },
      },
    });
    const merge = contract.products.at(-1)!.operation;
    expect(merge.kind).toBe('esp32.merge-bin');
    if (merge.kind !== 'esp32.merge-bin') throw new Error('expected merge operation');
    expect(merge.segments.map(({ productId, offset, input }) => ({
      productId, offset, path: input.path, role: input.role,
    }))).toEqual([
      {
        productId: 'bootloader', offset: '0x0',
        path: 'build/bootloader.bin', role: 'bootloader-image',
      },
      {
        productId: 'partitions', offset: '0x8000',
        path: 'build/partitions.bin', role: 'partitions-image',
      },
      {
        productId: 'boot-app0', offset: '0xe000',
        path: 'build/boot_app0.bin', role: 'boot-app0-image',
      },
      {
        productId: 'application', offset: '0x10000',
        path: 'build/firmware.bin', role: 'application-image',
      },
      {
        productId: 'model', offset: '0xd10000',
        path: 'build/srmodels.bin', role: 'model-image',
      },
    ]);
  });

  it('lowers the esp_sr_16 model artifact and all five merge inputs into planner transforms', () => {
    const transforms = lowerEsp32PostLinkTransforms(deriveEspSrPostLink(), {
      elf2image: 'ck:esp32-image',
      partitionBin: 'ck:esp32-partition',
      materialize: 'ck:pack-copy',
      mergeBin: 'ck:esp32-merge',
    });

    expect(transforms.map(({ productId }) => productId)).toEqual([
      'application', 'bootloader', 'partitions', 'boot-app0', 'model', 'merged',
    ]);
    const model = transforms.find((transform) => transform.productId === 'model')!;
    expect(model).toMatchObject({
      id: 'transform-model',
      lifecycle: 'configuration',
      tool: 'ck:pack-copy',
      input: 'packs/board/srmodels.bin',
      output: 'build/srmodels.bin',
      offset: '0xd10000',
      inputs: [{
        path: 'packs/board/srmodels.bin', role: 'model-source', sha256: ESP_SR_MODEL_SHA256,
      }],
      packDependencies: ['board:unit'],
      packInputs: [{
        kind: 'pack-artifact',
        packId: 'board:unit',
        packRevision: ESP_SR_BOARD_PACK_SHA256,
        packSchema: 2,
        artifactId: 'srmodels',
        sha256: ESP_SR_MODEL_SHA256,
        role: 'model-source',
      }],
    });
    const merged = transforms.at(-1)!;
    expect(merged.inputs?.map((input) => input.path)).toEqual([
      'build/bootloader.bin',
      'build/partitions.bin',
      'build/boot_app0.bin',
      'build/firmware.bin',
      'build/srmodels.bin',
    ]);
    expect(merged.dependencies).toEqual([
      'transform-application',
      'transform-boot-app0',
      'transform-bootloader',
      'transform-model',
      'transform-partitions',
    ]);
    expect(merged.arguments.slice(-2)).toEqual(['0xd10000', 'build/srmodels.bin']);
  });

  it('rejects esp_sr_16 model size, capacity, and provenance drift independently', () => {
    const sizeMismatch = espSrPostLinkBindings();
    sizeMismatch.model = { ...sizeMismatch.model!, size: ESP_SR_MODEL_SIZE + 1 };
    expect(() => deriveEspSrPostLink({ bindings: sizeMismatch }))
      .toThrow(/Board Pack artifact is invalid: model-source/);

    const overCapacity = espSrPostLinkBindings();
    overCapacity.model = { ...overCapacity.model!, size: ESP_SR_MODEL_CAPACITY + 1 };
    expect(() => deriveEspSrPostLink({ bindings: overCapacity }))
      .toThrow(/model binding exceeds the esp_sr_16 model capacity/);

    const badProvenance = espSrPostLinkBindings();
    badProvenance.model = {
      ...badProvenance.model!,
      provenance: { ...badProvenance.model!.provenance, artifactId: 'boot-app0' },
    };
    expect(() => deriveEspSrPostLink({ bindings: badProvenance }))
      .toThrow(/model binding must use the srmodels Board Pack artifact/);
  });

  it('selects SDK ELF and CSV operations only through immutable Pack bindings', () => {
    const browserContract = derivePostLink();
    const bindings = browserPostLinkBindings();
    bindings.bootloader = {
      source: 'sdk-elf',
      input: {
        kind: 'immutable', path: 'packs/board/sdk/bootloader.elf',
        role: 'bootloader-source', sha256: '1'.repeat(64),
        provenance: {
          kind: 'pack-file', packId: 'board:unit',
          packSha256: BOARD_PACK_SHA256, selector: 'bootloader-qio-80m',
        },
      },
    };
    bindings.partitions = {
      source: 'csv',
      input: {
        kind: 'immutable', path: 'packs/board/partitions.csv',
        role: 'partitions-source', sha256: '2'.repeat(64),
        provenance: {
          kind: 'pack-file', packId: 'board:unit',
          packSha256: BOARD_PACK_SHA256, selector: 'partitions-default',
        },
      },
    };
    const nativeContract = derivePostLink({ bindings });

    expect(nativeContract.products[1]!.operation.kind).toBe('esp32.elf2image');
    expect(nativeContract.products[2]!.operation.kind).toBe('esp32.partition-bin');
    expect(nativeContract.sha256).not.toBe(browserContract.sha256);
  });

  it('derives partition-bin from root project-file partitions.csv provenance', () => {
    const contract = derivePostLink({ bindings: projectPartitionsBindings() });
    const partitions = contract.products.find(({ productId }) => productId === 'partitions');

    expect(partitions?.operation).toEqual({
      kind: 'esp32.partition-bin',
      input: {
        kind: 'immutable', path: 'partitions.csv',
        role: 'partitions-source', sha256: 'd'.repeat(64),
        provenance: {
          kind: 'project-file', path: 'partitions.csv',
          projectSha256: 'e'.repeat(64), fileSha256: 'd'.repeat(64),
        },
      },
      quiet: true,
    });
  });

  it('fails closed for invalid or misbound project-file provenance', () => {
    const pathMismatch = projectPartitionsBindings();
    pathMismatch.partitions = {
      ...pathMismatch.partitions,
      input: {
        ...pathMismatch.partitions.input,
        provenance: {
          ...pathMismatch.partitions.input.provenance,
          path: 'config/partitions.csv',
        },
      },
    };
    expect(() => derivePostLink({ bindings: pathMismatch }))
      .toThrow(/partitions binding project-file provenance is invalid/);

    const fileShaMismatch = projectPartitionsBindings();
    fileShaMismatch.partitions = {
      ...fileShaMismatch.partitions,
      input: {
        ...fileShaMismatch.partitions.input,
        provenance: {
          ...fileShaMismatch.partitions.input.provenance,
          fileSha256: 'f'.repeat(64),
        },
      },
    };
    expect(() => derivePostLink({ bindings: fileShaMismatch }))
      .toThrow(/partitions binding project-file provenance is invalid/);

    const bootloader = projectPartitionsBindings();
    bootloader.bootloader = {
      ...bootloader.bootloader,
      input: {
        ...bootloader.bootloader.input,
        provenance: {
          kind: 'project-file', path: bootloader.bootloader.input.path,
          projectSha256: 'e'.repeat(64), fileSha256: bootloader.bootloader.input.sha256,
        },
      },
    };
    expect(() => derivePostLink({ bindings: bootloader }))
      .toThrow(/bootloader binding project-file provenance is invalid/);

    const bootApp0 = projectPartitionsBindings();
    bootApp0.bootApp0 = {
      ...bootApp0.bootApp0,
      provenance: {
        kind: 'project-file', path: bootApp0.bootApp0.path,
        projectSha256: 'e'.repeat(64), fileSha256: bootApp0.bootApp0.sha256,
      },
    };
    expect(() => derivePostLink({ bindings: bootApp0 }))
      .toThrow(/boot_app0 binding project-file provenance is invalid/);
  });

  it('lowers all products to stable multi-input planner transforms', () => {
    const transforms = lowerEsp32PostLinkTransforms(derivePostLink(), {
      elf2image: 'ck:esp32-image',
      partitionBin: 'ck:esp32-partition',
      materialize: 'ck:pack-copy',
      mergeBin: 'ck:esp32-merge',
    });

    expect(transforms.map((transform) => ({
      id: transform.id,
      productId: transform.productId,
      lifecycle: transform.lifecycle,
      tool: transform.tool,
      input: transform.input,
      output: transform.output,
      inputs: transform.inputs?.map(({ path, sha256 }) => ({ path, sha256 })),
      dependencies: transform.dependencies,
      packDependencies: transform.packDependencies,
      packInputs: transform.packInputs,
    }))).toEqual([
      {
        id: 'transform-application', productId: 'application', lifecycle: 'project',
        tool: 'ck:esp32-image', input: 'build/firmware.elf', output: 'build/firmware.bin',
        inputs: [{ path: 'build/firmware.elf', sha256: undefined }],
        dependencies: ['link-elf'],
        packDependencies: undefined,
        packInputs: undefined,
      },
      {
        id: 'transform-bootloader', productId: 'bootloader', lifecycle: 'configuration',
        tool: 'ck:pack-copy', input: 'packs/board/bootloader.bin',
        output: 'build/bootloader.bin',
        inputs: [{ path: 'packs/board/bootloader.bin', sha256: 'a'.repeat(64) }],
        dependencies: [],
        packDependencies: ['board:unit'],
        packInputs: [{
          kind: 'pack-artifact', packId: 'board:unit', packRevision: BOARD_PACK_SHA256,
          packSchema: 2, artifactId: 'bootloader-default', sha256: 'a'.repeat(64),
          role: 'bootloader-source',
        }],
      },
      {
        id: 'transform-partitions', productId: 'partitions', lifecycle: 'configuration',
        tool: 'ck:pack-copy', input: 'packs/board/partitions.bin',
        output: 'build/partitions.bin',
        inputs: [{ path: 'packs/board/partitions.bin', sha256: 'b'.repeat(64) }],
        dependencies: [],
        packDependencies: ['board:unit'],
        packInputs: [{
          kind: 'pack-artifact', packId: 'board:unit', packRevision: BOARD_PACK_SHA256,
          packSchema: 2, artifactId: 'partitions-default', sha256: 'b'.repeat(64),
          role: 'partitions-source',
        }],
      },
      {
        id: 'transform-boot-app0', productId: 'boot-app0', lifecycle: 'configuration',
        tool: 'ck:pack-copy', input: 'packs/board/boot_app0.bin',
        output: 'build/boot_app0.bin',
        inputs: [{ path: 'packs/board/boot_app0.bin', sha256: 'c'.repeat(64) }],
        dependencies: [],
        packDependencies: ['board:unit'],
        packInputs: [{
          kind: 'pack-artifact', packId: 'board:unit', packRevision: BOARD_PACK_SHA256,
          packSchema: 2, artifactId: 'boot-app0', sha256: 'c'.repeat(64),
          role: 'boot-app0-source',
        }],
      },
      {
        id: 'transform-merged', productId: 'merged', lifecycle: 'project',
        tool: 'ck:esp32-merge', input: 'build/bootloader.bin',
        output: 'build/firmware.merged.bin',
        inputs: [
          { path: 'build/bootloader.bin', sha256: undefined },
          { path: 'build/partitions.bin', sha256: undefined },
          { path: 'build/boot_app0.bin', sha256: undefined },
          { path: 'build/firmware.bin', sha256: undefined },
        ],
        dependencies: [
          'transform-application', 'transform-boot-app0',
          'transform-bootloader', 'transform-partitions',
        ],
        packDependencies: undefined,
        packInputs: undefined,
      },
    ]);
    const contractSha256 = derivePostLink().sha256;
    expect(transforms.every((transform) => (
      transform.flags?.includes(`--ck-post-link-contract=${contractSha256}`)
    ))).toBe(true);
  });

  it('does not parse the opaque prebuild shell hook body as an operation', () => {
    const baselineManifest = postLinkManifest();
    const recipes = baselineManifest.recipes.map((candidate) => (
      candidate.id === 'recipe.hooks.prebuild.4'
        ? recipe(
          candidate.id,
          '/usr/bin/env bash -c "exit 99; rm -rf ignored; {recipe.hooks.prebuild.4.pattern_args}"',
        )
        : candidate
    ));
    const changedManifest = withManifestRecipes(baselineManifest, recipes);
    const baseline = derivePostLink({ manifest: baselineManifest });
    const changed = derivePostLink({ manifest: changedManifest });

    expect(changed.target).toEqual(baseline.target);
    expect(changed.products).toEqual(baseline.products);
    expect(changed.sha256).not.toBe(baseline.sha256);
  });

  it.each([
    'recipe.objcopy.bin',
    'recipe.objcopy.partitions.bin',
    'recipe.hooks.objcopy.postobjcopy.3',
  ])('%s must occur exactly once', (recipeId) => {
    const manifest = postLinkManifest();
    const recipes = manifest.recipes;
    const selected = recipes.find((candidate) => candidate.id === recipeId)!;
    expect(() => derivePostLink({
      manifest: withManifestRecipes(
        manifest,
        recipes.filter((candidate) => candidate.id !== recipeId),
      ),
    })).toThrow(new RegExp(`exactly one ${escapeRegExp(recipeId)} recipe`));
    expect(() => derivePostLink({
      manifest: withManifestRecipes(manifest, [...recipes, selected]),
    })).toThrow(/duplicate|unique|strictly sorted|exactly one/);
  });

  it('rejects shell wrappers and structural partition recipe drift', () => {
    expect(() => derivePostLink({
      manifest: postLinkManifest({
        'recipe.objcopy.bin.pattern':
          '/usr/bin/env bash -c "{recipe.objcopy.bin.pattern_args}"',
      }),
    })).toThrow(/direct modeled tool invocation/);

    expect(() => derivePostLink({
      manifest: postLinkManifest({
        'recipe.objcopy.partitions.bin.pattern':
          '"{tools.gen_esp32part.cmd}" --mystery input.csv output.bin',
      }),
    })).toThrow(/exactly -q CSV BIN/);
  });

  it('fails closed on unmodeled, duplicate, and unresolved image arguments', () => {
    const baseline = postLinkManifest().platformProperties;
    expect(() => derivePostLink({
      manifest: postLinkManifest({
        'recipe.objcopy.bin.pattern_args': `${baseline['recipe.objcopy.bin.pattern_args']} --mystery`,
      }),
    })).toThrow(/unmodeled argument: --mystery/);
    expect(() => derivePostLink({
      manifest: postLinkManifest({
        'recipe.objcopy.bin.pattern_args': `${baseline['recipe.objcopy.bin.pattern_args']} --chip esp32c3`,
      }),
    })).toThrow(/duplicate --chip/);
    expect(() => derivePostLink({
      manifest: postLinkManifest({ 'build.flash_mode': '{missing.flash.mode}' }),
    })).toThrow(/unknown|unresolved|invalid/);
  });

  it('rejects executable-property injection and nonstandard CK paths', () => {
    expect(() => derivePostLink({
      manifest: postLinkManifest({ 'tools.esptool_py.cmd': 'bash' }),
    })).toThrow(/image recipe tool binding is invalid/);
    expect(() => derivePostLink({
      manifest: postLinkManifest({
        'tools.gen_esp32part.cmd': 'bash -c dangerous',
      }),
    })).toThrow(/partition recipe tool binding is invalid/);

    const baseline = postLinkManifest().platformProperties;
    expect(() => derivePostLink({
      manifest: postLinkManifest({
        'recipe.objcopy.bin.pattern_args': baseline[
          'recipe.objcopy.bin.pattern_args'
        ]!.replace(
          '-o "{build.path}/{build.project_name}.bin"',
          '-o "build/nonstandard.bin"',
        ),
      }),
    })).toThrow(/unknown product path|paths do not match the CK logical layout/);
  });

  it('fails closed on merge layout drift and target mismatches', () => {
    const baseline = postLinkManifest().platformProperties;
    expect(() => derivePostLink({
      manifest: postLinkManifest({
        'recipe.hooks.objcopy.postobjcopy.3.pattern_args': baseline[
          'recipe.hooks.objcopy.postobjcopy.3.pattern_args'
        ]!.replace(
          '{build.bootloader_addr} "{build.path}/{build.project_name}.bootloader.bin"',
          '0x8000 "{build.path}/{build.project_name}.bootloader.bin"',
        ),
      }),
    })).toThrow(/duplicate offset: 0x8000/);

    expect(() => derivePostLink({
      manifest: postLinkManifest({
        'recipe.hooks.objcopy.postobjcopy.3.pattern_args': baseline[
          'recipe.hooks.objcopy.postobjcopy.3.pattern_args'
        ]!.replace('tools/partitions/boot_app0.bin', 'tools/partitions/unknown.bin'),
      }),
    })).toThrow(/unknown product path/);

    expect(() => derivePostLink({
      manifest: postLinkManifest({
        'recipe.hooks.prebuild.4.pattern_args': baseline[
          'recipe.hooks.prebuild.4.pattern_args'
        ]!.replace('--flash-size {build.flash_size}', '--flash-size 2MB'),
      }),
    })).toThrow(/do not match the application image/);

    const exchanged = baseline['recipe.hooks.objcopy.postobjcopy.3.pattern_args']!
      .replace(
        '0x8000 "{build.path}/{build.project_name}.partitions.bin"',
        '__PARTITIONS_SEGMENT__',
      )
      .replace(
        '0x10000 "{build.path}/{build.project_name}.bin"',
        '0x8000 "{build.path}/{build.project_name}.bin"',
      )
      .replace(
        '__PARTITIONS_SEGMENT__',
        '0x10000 "{build.path}/{build.project_name}.partitions.bin"',
      );
    expect(() => derivePostLink({
      manifest: postLinkManifest({
        'recipe.hooks.objcopy.postobjcopy.3.pattern_args': exchanged,
      }),
    })).toThrow(/flash offset does not match the modeled layout/);
  });

  it('rejects unmodeled custom partitions and extra flash segments', () => {
    expect(() => derivePostLink({
      manifest: postLinkManifest({ 'build.partitions': '' }),
    })).toThrow(/custom partition selection requires an explicit project binding/);
    expect(() => derivePostLink({
      manifest: postLinkManifest({
        'upload.extra_flags': '0xd10000 build/srmodels.bin',
      }),
    })).toThrow(/extra flash segments are not modeled/);
  });

  it('requires complete immutable provenance and canonical source identity', () => {
    expect(() => derivePostLink({ boardPackRevisionInput: undefined }))
      .toThrow(/Board Pack revision input is invalid/);
    const bindings = browserPostLinkBindings();
    bindings.bootApp0 = { ...bindings.bootApp0, sha256: '' };
    expect(() => derivePostLink({ bindings })).toThrow(/boot_app0 binding is invalid/);
    const invalidProvenance = browserPostLinkBindings();
    invalidProvenance.bootApp0 = {
      ...invalidProvenance.bootApp0,
      provenance: { ...invalidProvenance.bootApp0.provenance, artifactId: '' },
    } as typeof invalidProvenance.bootApp0;
    expect(() => derivePostLink({ bindings: invalidProvenance }))
      .toThrow(/artifact provenance is invalid/);
    const unknownArtifact = browserPostLinkBindings();
    unknownArtifact.bootApp0 = {
      ...unknownArtifact.bootApp0,
      provenance: { ...unknownArtifact.bootApp0.provenance, artifactId: 'not-in-pack' },
    } as typeof unknownArtifact.bootApp0;
    expect(() => derivePostLink({ bindings: unknownArtifact }))
      .toThrow(/Board Pack artifact is invalid/);
    expect(() => derivePostLink({
      boardPack: { id: 'board:other', sha256: '4'.repeat(64) },
    })).toThrow(/provenance does not match the selected Board Pack/);
    const forgedRevision = JSON.parse(BOARD_PACK_REVISION_INPUT) as {
      artifacts: Array<{ id: string; sha256: string }>;
    };
    forgedRevision.artifacts.find(({ id }) => id === 'boot-app0')!.sha256 = 'd'.repeat(64);
    const forgedBindings = browserPostLinkBindings();
    forgedBindings.bootApp0 = { ...forgedBindings.bootApp0, sha256: 'd'.repeat(64) };
    expect(() => derivePostLink({
      boardPackRevisionInput: JSON.stringify(forgedRevision),
      bindings: forgedBindings,
    })).toThrow(/Board Pack revision input is invalid/);
    const manifest = postLinkManifest();
    const resolved = resolvePlatformManifest({ manifest, fqbn: 'esp32:esp32:unit' });
    expect(() => derivePostLink({
      manifest,
      resolved: { ...resolved, manifestSha256: 'f'.repeat(64) },
    })).toThrow(/does not match its Manifest/);
  });
});
