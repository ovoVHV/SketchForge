import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  mergeLegacyPlatformManifests,
  migrateCkPlatformProfiles,
} from '../../../scripts/migrate-ck-platform-profiles.mjs';
import { decodePackArtifact } from '../../../scripts/publish-ck-platform-manifests.mjs';

const temporary: string[] = [];
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: any): string => value === null || typeof value !== 'object'
  ? JSON.stringify(value)
  : Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const FQBNS = [
  'esp32:esp32:esp32',
  'esp32:esp32:esp32s2',
  'esp32:esp32:esp32s3',
  'esp32:esp32:esp32c3',
  'esp32:esp32:esp32c6',
];
const XTENSA_COMPILER = {
  id: 'xtensa-esp-elf-wasm',
  version: '23.0.0-espressif.570c44b6.12',
  sha256: 'a'.repeat(64),
};
const RISCV_COMPILER = {
  id: 'riscv32-esp-elf-wasm',
  version: '22.0.0-git20542-5',
  sha256: 'b'.repeat(64),
};
const RISCV_C_FLAGS = '-march=rv32imc_zicsr_zifencei -ffunction-sections -fdata-sections '
  + '-Wno-error=unused-function -Wno-error=unused-variable -Wno-error=unused-but-set-variable '
  + '-Wno-error=deprecated-declarations -Wno-error=extra -Wno-unused-parameter -Wno-sign-compare '
  + '-Wno-enum-conversion -gdwarf-4 -ggdb -nostartfiles -Wwrite-strings -fstack-protector '
  + '-fno-jump-tables -std=gnu17 -Wno-old-style-declaration -DCHIP_HAVE_CONFIG_H '
  + '-Wno-strict-prototypes\n';
const COMPILER_PROPERTIES = {
  'compiler.path': '',
  'compiler.c.cmd': 'gcc',
  'compiler.c.extra_flags': '',
  'compiler.c.flags': '-MMD -c "@sdk/flags/c_flags" {compiler.warning_flags} {compiler.optimization_flags} {compiler.common_werror_flags}',
  'compiler.cpp.cmd': 'g++',
  'compiler.cpp.extra_flags': '',
  'compiler.cpp.flags': '-MMD -c "@sdk/flags/cpp_flags" {compiler.warning_flags} {compiler.optimization_flags} {compiler.common_werror_flags}',
  'compiler.S.extra_flags': '',
  'compiler.S.flags': '-MMD -c -x assembler-with-cpp "@sdk/flags/S_flags" {compiler.warning_flags} {compiler.optimization_flags}',
  'compiler.warning_flags': '-w',
  'compiler.optimization_flags': '-Os',
  'compiler.common_werror_flags': '-Werror=return-type',
  'compiler.adapter.flags': '-DADAPTER=1',
};

function signManifest(value: any) {
  const { sha256: _sha256, ...body } = JSON.parse(JSON.stringify(value));
  return { ...body, sha256: hash(canonical(body)) };
}

function recipeFixtures() {
  const compile = (
    id: string,
    command: string,
    extraFlags: string,
    flags: string,
  ) => ({
    id,
    argv: [
      `{compiler.path}{${command}}`,
      `{${extraFlags}}`,
      `{${flags}}`,
      '{compiler.adapter.flags}',
      '{source_file}',
      '-o',
      '{object_file}',
    ],
    placeholders: [
      command,
      'compiler.adapter.flags',
      extraFlags,
      flags,
      'compiler.path',
      'object_file',
      'source_file',
    ].sort(),
  });
  return [
    compile('recipe.c.o', 'compiler.c.cmd', 'compiler.c.extra_flags', 'compiler.c.flags'),
    compile('recipe.cpp.o', 'compiler.cpp.cmd', 'compiler.cpp.extra_flags', 'compiler.cpp.flags'),
    compile('recipe.S.o', 'compiler.c.cmd', 'compiler.S.extra_flags', 'compiler.S.flags'),
    {
      id: 'recipe.ar',
      argv: ['ar', 'rcs', '{archive_file_path}', '{object_file}'],
      placeholders: ['archive_file_path', 'object_file'],
    },
    {
      id: 'recipe.c.combine',
      argv: ['clang++', '{object_files}', '{archive_file_path}', '-o', '{build.path}/{build.project_name}.elf'],
      placeholders: ['archive_file_path', 'build.path', 'build.project_name', 'object_files'],
    },
  ];
}

function legacyManifest(fqbn: string, compilerPack = compilerFor(fqbn)) {
  return signManifest({
    kind: 'ck-platform-pack', schemaVersion: 1, id: 'espressif-arduino', version: '3.3.7',
    vendor: 'esp32', architecture: 'esp32',
    platformProperties: {
      ...COMPILER_PROPERTIES,
      'build.bootloader_addr': '0x0',
      'tools.esptool_py.upload.pattern_args': '--chip unit write-flash 0x8000 firmware.partitions.bin 0xe000 boot_app0.bin',
    },
    recipes: recipeFixtures(),
    boards: [{
      id: fqbn.slice(fqbn.lastIndexOf(':') + 1),
      fqbn,
      name: fqbn,
      core: 'esp32',
      variant: fqbn.slice(fqbn.lastIndexOf(':') + 1),
      properties: { 'build.mcu': 'unit' },
      menus: [],
    }],
    programmers: [{ id: 'esptool', name: 'esptool', properties: {} }],
    tools: [{ ...compilerPack }],
    files: [{ path: 'platform.txt', role: 'config', size: 8, sha256: 'c'.repeat(64) }],
  });
}

function compilerFor(fqbn: string) {
  return fqbn.endsWith('c3') || fqbn.endsWith('c6') ? RISCV_COMPILER : XTENSA_COMPILER;
}

function mergeInputs(fqbns = FQBNS) {
  return fqbns.map((fqbn) => {
    const compilerPack = compilerFor(fqbn);
    return {
      fqbn,
      sdkVersion: '3.3.7',
      compilerPack,
      manifest: legacyManifest(fqbn, compilerPack),
    };
  });
}

afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ck-profile-migration-'));
  temporary.push(root);
  const board = 'esp32:esp32:unit';
  const compilerPin = pack(root, 'compiler', 'compiler', '1', [['compiler-data', Buffer.from('compiler')]]);
  const compilerPack = { id: compilerPin.id, version: '1', sha256: compilerPin.revision };
  const platform: any = {
    kind: 'ck-platform-pack', schemaVersion: 1, id: 'espressif-arduino', version: '3.3.7',
    vendor: 'esp32', architecture: 'esp32', tools: [], recipes: recipeFixtures(), programmers: [], files: [],
    platformProperties: {
      ...COMPILER_PROPERTIES,
      'build.bootloader_addr': '0x0',
      'tools.esptool_py.upload.pattern_args': '--chip unit write-flash 0x8000 firmware.partitions.bin 0xe000 boot_app0.bin',
    },
    boards: [{
      id: 'unit', fqbn: board, name: 'Unit', core: 'esp32', variant: 'unit',
      properties: { 'build.mcu': 'unit' }, menus: [],
    }],
  };
  platform.sha256 = hash(canonical(platform));
  const legacyPlatform = { ...platform, tools: [compilerPack] };
  const { sha256: _old, ...legacyBody } = legacyPlatform;
  legacyPlatform.sha256 = hash(canonical(legacyBody));
  const sdkProfile = {
    schema: 4, id: 'sdk-profile', sdkVersion: '3.3.7', platformManifest: platform,
    compile: {
      args: [
        'clang++', '--target=riscv32-esp-elf', '-MMD', '-c', '@sdk/flags/cpp_flags',
        '-Wall', '-Os', '-Werror=return-type', '-DADAPTER=1', 'sketch.cpp', '-o', 'sketch.o',
      ],
      overlaySlots: [], source: 'sketch.cpp', object: 'sketch.o', artifactIds: ['sdk-data'],
    },
    link: { args: ['clang++', '--target=riscv32-esp-elf'], overlaySlots: [], object: 'sketch.o', elf: 'firmware.elf', artifactIds: ['sdk-data'] },
  };
  const boardProfile = {
    schema: 3, id: 'board-profile', board, sdkVersion: '3.3.7', variant: 'unit', options: {}, artifactIds: ['board-data'],
    overlay: {
      compile: { target: ['-march=rv32imc', '-mabi=ilp32'], defines: [], memory: ['-Isdk/dio_qspi/include'], variant: ['-Ivariant'] },
      link: { target: ['-march=rv32imc', '-mabi=ilp32'], memory: ['-Lsdk/dio_qspi'], flags: [] },
    }, image: { flashMode: 'dio', flashFrequency: '80m', flashSize: '4MB' },
    flash: { bootloader: 'bootloader', partitions: 'partitions', bootApp0: 'boot-app0' },
  };
  const sdkFlags = Buffer.from(RISCV_C_FLAGS);
  const sdkPin = pack(root, 'sdk', 'sdk', '3.3.7', [
    ['profile', Buffer.from(JSON.stringify(sdkProfile))],
    ['sdk-data', sdkFlags, [{
      path: 'sdk/flags/c_flags', offset: 0, length: sdkFlags.length, sha256: hash(sdkFlags),
    }]],
  ]);
  const boardPin = pack(root, 'board', 'board', '3.3.7', [['profile', Buffer.from(JSON.stringify(boardProfile))], ['board-data', Buffer.from('board')]]);
  const pins = [
    compilerPin,
    sdkPin,
    boardPin,
  ];
  writeFileSync(join(root, 'runtime.json'), JSON.stringify({ schema: 2, id: 'unit', abi: 1, board, packs: pins }));
  writeFileSync(join(root, 'platform.json'), canonical(platform));
  const registryRoot = join(root, 'packages', 'web', 'public', 'esp32', 'v1', 'platform-manifests');
  const manifestRelative = `espressif-arduino/${legacyPlatform.sha256}/manifest.json`;
  const manifestPath = join(registryRoot, ...manifestRelative.split('/'));
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, canonical(legacyPlatform));
  writeFileSync(join(registryRoot, 'registry.json'), JSON.stringify({
    kind: 'ck-platform-manifest-registry',
    schemaVersion: 1,
    entries: [{
      fqbn: board,
      id: legacyPlatform.id,
      version: legacyPlatform.version,
      sha256: legacyPlatform.sha256,
      path: manifestRelative,
      sdkPack: { id: sdkPin.id, revision: sdkPin.revision },
    }],
  }));
  return root;
}

function pack(
  root: string,
  role: string,
  id: string,
  version: string,
  values: Array<[string, Buffer, Array<{ path: string; offset: number; length: number; sha256: string }>?]>,
) {
  const base = join(root, 'source', id);
  const artifacts = values.map(([artifactId, body, files]) => {
    const digest = hash(body);
    mkdirSync(join(base, 'chunks'), { recursive: true });
    writeFileSync(join(base, 'chunks', digest), body);
    return {
      id: artifactId,
      kind: artifactId === 'profile' ? 'json' : files ? 'tree' : 'binary',
      size: body.length,
      sha256: digest,
      chunks: [{ path: `chunks/${digest}`, size: body.length, sha256: digest }],
      ...(files ? { files } : {}),
    };
  });
  const manifest: any = { schema: 1, id, version, artifacts };
  manifest.revision = hash(JSON.stringify(manifest));
  const path = join(base, 'toolchain.json');
  writeFileSync(path, JSON.stringify(manifest));
  return { role, id, revision: manifest.revision, manifest: path.slice(root.length + 1).replaceAll('\\', '/') };
}

describe('strict shared CK Platform Manifest merger', () => {
  it('merges the exact target set, strips proved tools, and recomputes the canonical hash', () => {
    const inputs = mergeInputs();
    const merged = mergeLegacyPlatformManifests(inputs);
    expect(merged.tools).toEqual([]);
    expect(merged.boards.map((board: any) => board.fqbn)).toEqual([
      'esp32:esp32:esp32',
      'esp32:esp32:esp32c3',
      'esp32:esp32:esp32c6',
      'esp32:esp32:esp32s2',
      'esp32:esp32:esp32s3',
    ]);
    const { sha256, ...body } = merged;
    expect(sha256).toBe(hash(canonical(body)));
    expect(inputs.every((input) => input.manifest.tools.length === 1)).toBe(true);
  });

  it('is deterministic for shuffled inputs and uses UTF-16 code-unit board ordering', () => {
    const inputs = mergeInputs();
    const forward = mergeLegacyPlatformManifests(inputs);
    const shuffled = mergeLegacyPlatformManifests([
      inputs[4], inputs[1], inputs[3], inputs[0], inputs[2],
    ]);
    expect(canonical(shuffled)).toBe(canonical(forward));

    const utf16 = mergeLegacyPlatformManifests(mergeInputs([
      'vendor:arch:\uE000',
      'vendor:arch:\u{10000}',
    ]));
    expect(utf16.boards.map((board: any) => board.fqbn)).toEqual([
      'vendor:arch:\u{10000}',
      'vendor:arch:\uE000',
    ]);
  });

  it('rejects every conflicting shared field', () => {
    const cases: Array<[string, (manifest: any) => void]> = [
      ['id', (manifest) => { manifest.id = 'other-platform'; }],
      ['vendor', (manifest) => { manifest.vendor = 'other-vendor'; }],
      ['architecture', (manifest) => { manifest.architecture = 'other-architecture'; }],
      ['platformProperties', (manifest) => { manifest.platformProperties.extra = 'conflict'; }],
      ['recipes', (manifest) => { manifest.recipes[0].argv.push('-DOTHER'); }],
      ['programmers', (manifest) => { manifest.programmers[0].name = 'other'; }],
      ['files', (manifest) => { manifest.files[0].size += 1; }],
    ];
    for (const [field, mutate] of cases) {
      const inputs = mergeInputs();
      mutate(inputs[1].manifest);
      inputs[1].manifest = signManifest(inputs[1].manifest);
      expect(
        () => mergeLegacyPlatformManifests(inputs),
        `field ${field}`,
      ).toThrow(new RegExp(`Manifest ${field} conflicts`));
    }
  });

  it('rejects duplicate targets and missing or extra boards', () => {
    const duplicate = mergeInputs();
    duplicate[1] = { ...duplicate[1], fqbn: duplicate[0].fqbn };
    expect(() => mergeLegacyPlatformManifests(duplicate)).toThrow(/target is duplicated/);

    const missing = mergeInputs();
    missing[1].manifest.boards = [];
    missing[1].manifest = signManifest(missing[1].manifest);
    expect(() => mergeLegacyPlatformManifests(missing)).toThrow(/exactly its one target board/);

    const extra = mergeInputs();
    extra[1].manifest.boards.push(legacyManifest('esp32:esp32:extra').boards[0]);
    extra[1].manifest = signManifest(extra[1].manifest);
    expect(() => mergeLegacyPlatformManifests(extra)).toThrow(/exactly its one target board/);
  });

  it('rejects SDK and shared Manifest version conflicts', () => {
    const profileConflict = mergeInputs();
    profileConflict[1].manifest.version = '3.3.8';
    profileConflict[1].manifest = signManifest(profileConflict[1].manifest);
    expect(() => mergeLegacyPlatformManifests(profileConflict)).toThrow(/version does not match its SDK profile/);

    const sharedConflict = mergeInputs();
    sharedConflict[1].sdkVersion = '3.3.8';
    sharedConflict[1].manifest.version = '3.3.8';
    sharedConflict[1].manifest = signManifest(sharedConflict[1].manifest);
    expect(() => mergeLegacyPlatformManifests(sharedConflict)).toThrow(/Manifest version conflicts/);
  });

  it('rejects tool removal when the exact Compiler Pack binding cannot be proved', () => {
    const absent = mergeInputs();
    absent[1].manifest.tools = [];
    absent[1].manifest = signManifest(absent[1].manifest);
    expect(() => mergeLegacyPlatformManifests(absent)).toThrow(/cannot be proved/);

    const mismatched = mergeInputs();
    mismatched[1].manifest.tools[0].sha256 = 'f'.repeat(64);
    mismatched[1].manifest = signManifest(mismatched[1].manifest);
    expect(() => mergeLegacyPlatformManifests(mismatched)).toThrow(/does not exactly match/);
  });

  it('rejects unsupported top-level fields instead of silently dropping them', () => {
    const inputs = mergeInputs();
    inputs[1].manifest.futureBinding = { accepted: true };
    inputs[1].manifest = signManifest(inputs[1].manifest);
    expect(() => mergeLegacyPlatformManifests(inputs)).toThrow(/fields are invalid or unsupported/);
  });
});

describe('checked-in CK profile metadata migrator', () => {
  it('synthesizes a proved shared Platform Manifest without an external input', () => {
    const root = fixture();
    const report = migrateCkPlatformProfiles({ root, targets: ['runtime.json'] });
    expect(report).toMatchObject({ dryRun: true, migratable: true, counts: { migratable: 1, blocked: 0 } });
    expect(report.targets[0].evidence).toContainEqual(expect.objectContaining({ field: 'platformRef' }));
  });

  it('blocks when a re-signed registry tool cannot be bound to the Compiler Pack', () => {
    const root = fixture();
    const registryPath = join(root, 'packages', 'web', 'public', 'esp32', 'v1', 'platform-manifests', 'registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const originalPath = join(dirname(registryPath), ...registry.entries[0].path.split('/'));
    const manifest = JSON.parse(readFileSync(originalPath, 'utf8'));
    manifest.tools[0].sha256 = 'f'.repeat(64);
    const resigned = signManifest(manifest);
    const relativePath = `espressif-arduino/${resigned.sha256}/manifest.json`;
    const resignedPath = join(dirname(registryPath), ...relativePath.split('/'));
    mkdirSync(dirname(resignedPath), { recursive: true });
    writeFileSync(resignedPath, canonical(resigned));
    registry.entries[0].path = relativePath;
    registry.entries[0].sha256 = resigned.sha256;
    writeFileSync(registryPath, JSON.stringify(registry));

    const report = migrateCkPlatformProfiles({ root, targets: ['runtime.json'] });
    expect(report).toMatchObject({ migratable: false, counts: { blocked: 1 } });
    expect(report.targets[0].blockers).toContainEqual(expect.objectContaining({
      field: 'sdkVariant.compilerPack',
      reason: expect.stringMatching(/does not exactly match/),
    }));
  });

  it('writes new content-addressed Packs only to an explicit output directory', () => {
    const root = fixture();
    const dryRun = migrateCkPlatformProfiles({ root, targets: ['runtime.json'], platformManifest: 'platform.json' });
    expect(dryRun).toMatchObject({ dryRun: true, migratable: true, counts: { migratable: 1 } });
    expect(dryRun.targets[0].evidence.map((item: any) => item.field)).toContain('execution.elf.machine');
    expect(() => readFileSync(join(root, 'out', 'esp32-esp32-unit.json'))).toThrow();

    const written = migrateCkPlatformProfiles({ root, targets: ['runtime.json'], platformManifest: 'platform.json', output: 'out' });
    expect(written).toMatchObject({ dryRun: false, migratable: true });
    const descriptor = JSON.parse(readFileSync(join(root, 'out', 'esp32-esp32-unit.json'), 'utf8'));
    const sourceDescriptor = JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8'));
    for (const pin of descriptor.packs) {
      const manifestPath = join(root, 'out', pin.manifest);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(manifest.revision).toBe(pin.revision);
      const revision = hash(JSON.stringify({
        schema: manifest.schema, id: manifest.id, version: manifest.version, artifacts: manifest.artifacts,
      }));
      expect(revision).toBe(pin.revision);
      if (pin.role === 'compiler') continue;
      for (const artifact of manifest.artifacts) {
        expect(artifact.chunks.every((chunk: any) => !chunk.path.includes('..'))).toBe(true);
        expect(() => decodePackArtifact(manifest, artifact.id, manifestPath)).not.toThrow();
      }
    }
    const compilerPin = descriptor.packs.find((pin: any) => pin.role === 'compiler');
    expect(compilerPin.id).toBe(sourceDescriptor.packs[0].id);
    expect(compilerPin.revision).toBe(sourceDescriptor.packs[0].revision);
    const sdkPin = descriptor.packs.find((pin: any) => pin.role === 'sdk');
    const sdkPath = join(root, 'out', sdkPin.manifest);
    const sdk = JSON.parse(readFileSync(sdkPath, 'utf8'));
    expect(sdk.artifacts.map((artifact: any) => artifact.id)).toEqual(expect.arrayContaining([
      'profile-v5', 'platform-manifest', 'compile-asm-flags',
    ]));
    expect(sdk.artifacts.map((artifact: any) => artifact.id)).not.toContain('profile');
    const profileV5 = JSON.parse(decodePackArtifact(sdk, 'profile-v5', sdkPath).toString('utf8'));
    const platformBytes = decodePackArtifact(sdk, 'platform-manifest', sdkPath);
    const platformManifest = JSON.parse(platformBytes.toString('utf8'));
    const platformArtifact = sdk.artifacts.find((artifact: any) => artifact.id === 'platform-manifest');
    expect(platformArtifact.sha256).toBe(hash(platformBytes));
    expect(profileV5).toMatchObject({
      schema: 5,
      compile: {
        languageFlags: {
          c: ['-MMD', '@sdk/flags/c_flags', '-w', '-Os', '-Werror=return-type'],
          cxx: ['-MMD', '@sdk/flags/cpp_flags', '-w', '-Os', '-Werror=return-type'],
          asm: ['-MMD', '-x', 'assembler-with-cpp', '@sdk/flags/S_flags', '-w', '-Os'],
        },
      },
      platformRef: {
        id: platformManifest.id,
        version: platformManifest.version,
        sha256: platformManifest.sha256,
      },
      platformManifestArtifact: { id: 'platform-manifest', sha256: platformArtifact.sha256 },
      recipeOrigins: {
        compile: platformManifest.recipeLowering.bindings.compile.cxx,
        link: platformManifest.recipeLowering.bindings.link,
      },
      recipeLowering: {
        status: 'manifest-defined',
        schemaVersion: 2,
        sha256: platformManifest.recipeLowering.sha256,
      },
    });
    expect(profileV5.compile.args).toEqual([
      'clang++', '--target=riscv32-esp-elf', '-c', '-DADAPTER=1',
      'sketch.cpp', '-o', 'sketch.o',
    ]);
    const effectiveFlags = (language: 'c' | 'cxx' | 'asm') => [
      ...profileV5.compile.args,
      ...profileV5.compile.languageFlags[language],
    ];
    expect(effectiveFlags('c')).toEqual(expect.arrayContaining([
      '@sdk/flags/c_flags', '-w', '-Os', '-Werror=return-type',
    ]));
    for (const argument of [
      '@sdk/flags/cpp_flags', '@sdk/flags/S_flags', '-x', 'assembler-with-cpp', '-Wall',
    ]) expect(effectiveFlags('c')).not.toContain(argument);
    expect(effectiveFlags('cxx')).toEqual(expect.arrayContaining([
      '@sdk/flags/cpp_flags', '-w', '-Os', '-Werror=return-type',
    ]));
    for (const argument of [
      '@sdk/flags/c_flags', '@sdk/flags/S_flags', '-x', 'assembler-with-cpp', '-Wall',
    ]) expect(effectiveFlags('cxx')).not.toContain(argument);
    expect(effectiveFlags('asm')).toEqual(expect.arrayContaining([
      '-MMD', '-x', 'assembler-with-cpp', '@sdk/flags/S_flags', '-w', '-Os',
    ]));
    for (const argument of [
      '@sdk/flags/c_flags', '@sdk/flags/cpp_flags', '-Werror=return-type', '-Wall',
    ]) expect(effectiveFlags('asm')).not.toContain(argument);
    expect(profileV5.compile.artifactIds).toContain('compile-asm-flags');
    expect(platformManifest.recipeLowering.schemaVersion).toBe(2);
    const asmArtifact = sdk.artifacts.find((artifact: any) => artifact.id === 'compile-asm-flags');
    const asmBytes = decodePackArtifact(sdk, 'compile-asm-flags', sdkPath);
    expect(asmArtifact).toMatchObject({
      kind: 'tree',
      files: [{
        path: 'sdk/flags/S_flags', offset: 0, length: asmBytes.length, sha256: hash(asmBytes),
      }],
    });
    expect(hash(asmBytes)).toBe('c4751c67c68e46d6ded3dd95cbcaf01f900a018266c5ab69947cf090597e675d');
    expect(profileV5).not.toHaveProperty('platformManifest');

    const boardPin = descriptor.packs.find((pin: any) => pin.role === 'board');
    const boardPath = join(root, 'out', boardPin.manifest);
    const board = JSON.parse(readFileSync(boardPath, 'utf8'));
    const boardArtifactIds = board.artifacts.map((artifact: any) => artifact.id);
    expect(boardArtifactIds).toEqual([...boardArtifactIds].sort());
    expect(boardArtifactIds).toContain('profile-v4');
    expect(boardArtifactIds).not.toContain('profile');
    const profileV4 = JSON.parse(decodePackArtifact(board, 'profile-v4', boardPath).toString('utf8'));
    expect(profileV4).toMatchObject({
      schema: 4,
      platformRef: { ...profileV5.platformRef, fqbn: descriptor.board },
      execution: {
        targetTriple: 'riscv32-esp-elf',
        targetArguments: ['--target=riscv32-esp-elf', '-march=rv32imc', '-mabi=ilp32'],
        elf: { machine: 243, floatAbi: 0 },
      },
      flash: { offsets: { bootloader: '0x0', partitions: '0x8000', bootApp0: '0xe000' } },
    });
  });

  it('keeps the safe repack byte ceiling for explicit output', () => {
    const root = fixture();
    const output = join(root, 'too-large');
    expect(() => migrateCkPlatformProfiles({
      root,
      targets: ['runtime.json'],
      output: 'too-large',
      maxRepackBytes: 1,
    })).toThrow(/exceeds safe repack limit 1/);
    expect(existsSync(output)).toBe(false);
  });

  it('installs immutable profile Packs in place and is idempotent', () => {
    const root = fixture();
    const first = migrateCkPlatformProfiles({ root, targets: ['runtime.json'], install: true });
    expect(first).toMatchObject({ dryRun: false, migratable: true });
    expect(first.installation.descriptors).toEqual(['runtime.json']);

    const descriptorText = readFileSync(join(root, 'runtime.json'), 'utf8');
    const descriptor = JSON.parse(descriptorText);
    for (const role of ['sdk', 'board']) {
      const pin = descriptor.packs.find((candidate: any) => candidate.role === role);
      const manifestPath = join(root, pin.manifest);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(manifest.revision).toBe(pin.revision);
      const artifactIds = manifest.artifacts.map((artifact: any) => artifact.id);
      expect(artifactIds).toEqual([...artifactIds].sort());
      expect(artifactIds).toEqual(expect.arrayContaining(
        role === 'sdk' ? ['profile-v5', 'platform-manifest'] : ['profile-v4'],
      ));
      expect(artifactIds).not.toContain('profile');
    }

    const second = migrateCkPlatformProfiles({ root, targets: ['runtime.json'], install: true });
    expect(readFileSync(join(root, 'runtime.json'), 'utf8')).toBe(descriptorText);
    expect(second.installation.packs.every((pack: any) => pack.reused)).toBe(true);
  });
});
