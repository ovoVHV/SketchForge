import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createPlatformManifest } from '../../core/src/platform-pack/builder.js';
import { browserToolchainPackRevisionInput } from '../public/avr/v3/toolchain-pack.js';

import {
  decodeCurrentPlatformManifest,
  decodePackArtifact,
  publishCkPlatformManifests,
  updateEsp32ReleasePins,
  updatePlatformRegistryPin,
  validateExecutionProfileBinding,
} from '../../../scripts/publish-ck-platform-manifests.mjs';

const PLATFORM_TEXT = [
  'name=Arduino ESP32',
  'recipe.c.o.pattern="gcc" -c "{source_file}" -o "{object_file}"',
  'recipe.cpp.o.pattern="g++" -c "{source_file}" -o "{object_file}"',
  'recipe.S.o.pattern="gcc" -c "{source_file}" -o "{object_file}"',
  'recipe.ar.pattern="ar" rcs "{archive_file_path}" "{object_file}"',
  'recipe.c.combine.pattern="g++" "{object_files}" "{archive_file_path}" -o "{build.path}/{build.project_name}.elf"',
  'recipe.hooks.objcopy.postobjcopy.3.pattern_args=--chip {build.mcu} merge-bin -o "{build.path}/{build.project_name}.merged.bin" {build.bootloader_addr} "{build.path}/{build.project_name}.bootloader.bin" 0x8000 "{build.path}/{build.project_name}.partitions.bin" 0xe000 "{runtime.platform.path}/tools/partitions/boot_app0.bin" 0x10000 "{build.path}/{build.project_name}.bin"',
].join('\n');

describe('CK Platform Manifest publisher', () => {
  it('decodes and verifies a chunked compressed Pack artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-platform-artifact-'));
    try {
      const body = Buffer.from('{"platformManifest":{}}');
      const transport = gzipSync(body, { level: 9, mtime: 0 });
      const chunkPath = 'chunks/profile.bin.gz';
      mkdirSync(join(root, 'chunks'), { recursive: true });
      writeFileSync(join(root, ...chunkPath.split('/')), transport);
      const manifest = {
        artifacts: [{
          id: 'profile', kind: 'json', size: body.length, sha256: sha256(body),
          chunks: [{
            path: chunkPath, size: body.length, sha256: sha256(body), compression: 'gzip',
            compressedSize: transport.length, compressedSha256: sha256(transport),
          }],
        }],
      };
      expect(decodePackArtifact(manifest, 'profile', join(root, 'toolchain.json'))).toEqual(body);
      manifest.artifacts[0]!.chunks[0]!.compressedSha256 = '0'.repeat(64);
      expect(() => decodePackArtifact(manifest, 'profile', join(root, 'toolchain.json')))
        .toThrow(/transport integrity/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads the complete shared Manifest through the profile-v5 artifact binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-platform-v5-artifact-'));
    try {
      const platform = createPlatformManifest({
        id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
        runtimeToolPolicy: 'deferred-ck-binding', platformText: PLATFORM_TEXT,
        boardsText: [
          'esp32c3.name=ESP32-C3', 'esp32c3.build.core=esp32', 'esp32c3.build.variant=esp32c3',
          'esp32c6.name=ESP32-C6', 'esp32c6.build.core=esp32', 'esp32c6.build.variant=esp32c6',
        ].join('\n'),
      });
      const body = Buffer.from(JSON.stringify(platform));
      const transport = gzipSync(body, { level: 9, mtime: 0 });
      mkdirSync(join(root, 'chunks'), { recursive: true });
      writeFileSync(join(root, 'chunks', 'platform.bin.gz'), transport);
      const artifactSha256 = sha256(body);
      const sdkManifest = {
        artifacts: [{
          id: 'platform-manifest', kind: 'json', size: body.length, sha256: artifactSha256,
          chunks: [{
            path: 'chunks/platform.bin.gz', size: body.length, sha256: artifactSha256,
            compression: 'gzip', compressedSize: transport.length,
            compressedSha256: sha256(transport),
          }],
        }],
      };
      const profile = {
        schema: 5,
        platformManifestArtifact: { id: 'platform-manifest', sha256: artifactSha256 },
      };
      expect(decodeCurrentPlatformManifest(
        profile, sdkManifest, join(root, 'toolchain.json'), 'C3',
      )).toEqual(platform);
      expect(() => decodeCurrentPlatformManifest({
        ...profile,
        platformManifestArtifact: { ...profile.platformManifestArtifact, sha256: '0'.repeat(64) },
      }, sdkManifest, join(root, 'toolchain.json'), 'C3')).toThrow(/artifact binding/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('updates exactly one same-origin registry pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-platform-pin-'));
    try {
      const release = join(root, 'release.js');
      writeFileSync(release, `export const release = {
  platforms: Object.freeze({ path: 'platform-manifests/registry.json', sha256: '${'0'.repeat(64)}' }),
};\n`);
      updatePlatformRegistryPin({ release, registrySha256: 'a'.repeat(64) });
      expect(readFileSync(release, 'utf8')).toContain('a'.repeat(64));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('updates every runtime descriptor pin together with the Platform registry pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-release-pins-'));
    try {
      const release = join(root, 'release.js');
      writeFileSync(release, `export const release = {
  platforms: Object.freeze({ path: 'platform-manifests/registry.json', sha256: '${'0'.repeat(64)}' }),
  runtimes: Object.freeze({
    unit: Object.freeze({ descriptors: Object.freeze({
      'vendor:arch:board': Object.freeze({ path: './esp32/unit.json', sha256: '${'1'.repeat(64)}' }),
    }) }),
  }),
};\n`);
      updateEsp32ReleasePins({
        release,
        registrySha256: 'a'.repeat(64),
        descriptorPins: [{
          fqbn: 'vendor:arch:board',
          path: './esp32/unit.json',
          sha256: 'b'.repeat(64),
        }],
      });
      const source = readFileSync(release, 'utf8');
      expect(source).toContain('a'.repeat(64));
      expect(source).toContain('b'.repeat(64));
      expect(() => updateEsp32ReleasePins({
        release,
        registrySha256: 'c'.repeat(64),
        descriptorPins: [{
          fqbn: 'vendor:arch:board',
          path: './esp32/other.json',
          sha256: 'd'.repeat(64),
        }],
      })).toThrow(/descriptor path changed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes one tool-neutral shared Manifest with Compiler Packs bound by profile-v5', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-platform-publish-'));
    try {
      const result = publishCkPlatformManifests({ output: root, updateReleasePin: false });
      const checkedRoot = join(
        process.cwd(), 'packages', 'web', 'public', 'esp32', 'v1', 'platform-manifests',
      );
      expect(result.entries).toHaveLength(5);
      expect(new Set(result.entries.map((entry) => entry.sha256))).toHaveLength(1);
      expect(readFileSync(result.registry)).toEqual(readFileSync(join(checkedRoot, 'registry.json')));
      expect(readFileSync(join(checkedRoot, '..', 'release.js'), 'utf8')).toContain(result.registrySha256);
      for (const entry of result.entries) {
        const generatedPath = join(root, ...entry.path.split('/'));
        const checkedPath = join(checkedRoot, ...entry.path.split('/'));
        expect(readFileSync(generatedPath)).toEqual(readFileSync(checkedPath));
        const manifest = JSON.parse(readFileSync(generatedPath, 'utf8'));
        expect(manifest.tools).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing SDK current profile', { sdkProfileArtifact: null }, /profile-v5/],
    ['legacy-only SDK profile', { sdkProfileArtifact: 'profile', sdkProfileSchema: 4 }, /mixed legacy\/current/],
    ['schema-4 data under profile-v5', { sdkProfileSchema: 4 }, /schema must be 5/],
    ['legacy-only Board profile', { boardProfileArtifact: 'profile', boardProfileSchema: 3 }, /mixed legacy\/current/],
    ['schema-1 Board Pack', { boardPackSchema: 1 }, /Browser v3 contract/],
    ['missing schema-5 id', { omitPlatformProfileId: true }, /Platform profile has an invalid shape/],
    ['mixed current and legacy profiles', { includeLegacyProfiles: true }, /mixed legacy\/current/],
    ['wrong Board PlatformRef', { boardPlatformSha256: '0'.repeat(64) }, /identity is invalid/],
    ['wrong Board FQBN', { boardFqbn: 'esp32:esp32:other' }, /identity is invalid/],
    ['wrong Board SDK version', { boardSdkVersion: '3.3.6' }, /identity is invalid/],
    ['wrong Board flash offset', { partitionsOffset: '0x9000' }, /do not match Platform Manifest/],
    ['non-neutral Platform tools', { platformTools: true }, /must be tool-neutral/],
    ['raw-only SDK revision', { sdkRawRevision: true }, /normalized revision mismatch/],
  ] as const)('fails closed for %s', (_label, options, expected) => {
    const fixture = createPublisherFixture(options);
    try {
      expect(() => publishCkPlatformManifests({
        targets: [fixture.target],
        output: join(fixture.root, 'published'),
        updateReleasePin: false,
      })).toThrow(expected);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('binds Platform version and each declared SDK target to its execution profile', () => {
    const manifest = createPlatformManifest({
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      platformText: PLATFORM_TEXT,
      boardsText: [
        'esp32c3.name=ESP32-C3 Dev Module',
        'esp32c3.build.core=esp32',
        'esp32c3.build.variant=esp32c3',
      ].join('\n'),
      runtimeToolPolicy: 'deferred-ck-binding',
    });
    const requirement = {
      id: 'riscv32-esp-elf-wasm', version: '22.0.0', sha256: 'a'.repeat(64),
    };
    const sdkPin = { id: 'arduino-esp32c3-sdk', revision: 'b'.repeat(64) };
    const profile = {
      schema: 5,
      sdkVersion: '3.3.7',
      platformRef: { id: manifest.id, version: manifest.version, sha256: manifest.sha256 },
      platformManifestArtifact: { id: 'platform-manifest', sha256: 'c'.repeat(64) },
      compile: {
        args: ['clang++', '-c', 'sketch.cpp', '-o', 'sketch.o'],
        languageFlags: {
          c: ['@sdk/flags/c_flags'],
          cxx: ['@sdk/flags/cpp_flags'],
          asm: ['-x', 'assembler-with-cpp', '@sdk/flags/S_flags'],
        },
      },
      sdkVariant: {
        id: sdkPin.id, sdkTarget: 'esp32c3', memoryType: 'dio_qspi', compilerPack: { ...requirement },
      },
      recipeOrigins: {
        compile: manifest.recipeLowering.bindings.compile.cxx,
        link: manifest.recipeLowering.bindings.link,
      },
      recipeLowering: {
        status: 'manifest-defined',
        schemaVersion: manifest.recipeLowering.schemaVersion,
        sha256: manifest.recipeLowering.sha256,
      },
    };
    expect(validateExecutionProfileBinding(
      profile, manifest, requirement, sdkPin, 'esp32c3', 'C3',
    )).toBe(profile);
    expect(() => validateExecutionProfileBinding({
      ...profile,
      sdkVariant: { ...profile.sdkVariant, id: 'wrong-sdk' },
    }, manifest, requirement, sdkPin, 'esp32c3', 'C3')).toThrow(/Pack binding/);
    expect(() => validateExecutionProfileBinding({
      ...profile,
      sdkVariant: { ...profile.sdkVariant, sdkTarget: 'esp32c6' },
    }, manifest, requirement, sdkPin, 'esp32c3', 'C3')).toThrow(/Pack binding/);

    const resignedManifest = createPlatformManifest({
      id: 'espressif-arduino', version: '3.3.8', vendor: 'esp32', architecture: 'esp32',
      platformText: PLATFORM_TEXT,
      boardsText: [
        'esp32c3.name=ESP32-C3 Dev Module',
        'esp32c3.build.core=esp32',
        'esp32c3.build.variant=esp32c3',
      ].join('\n'),
      runtimeToolPolicy: 'deferred-ck-binding',
    });
    const resignedProfile = {
      ...profile,
      platformRef: {
        id: resignedManifest.id,
        version: resignedManifest.version,
        sha256: resignedManifest.sha256,
      },
    };
    expect(() => validateExecutionProfileBinding(
      resignedProfile, resignedManifest, requirement, sdkPin, 'esp32c3', 'C3',
    )).toThrow(/profile version is invalid/);

    const xtensaManifest = createPlatformManifest({
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      platformText: PLATFORM_TEXT,
      boardsText: [
        'esp32.name=ESP32 Dev Module',
        'esp32.build.core=esp32',
        'esp32.build.variant=esp32',
      ].join('\n'),
      runtimeToolPolicy: 'deferred-ck-binding',
    });
    const xtensaRequirement = {
      id: 'xtensa-esp-elf-wasm', version: '22.0.0', sha256: 'd'.repeat(64),
    };
    const xtensaSdkPin = { id: 'arduino-esp32-sdk', revision: 'e'.repeat(64) };
    const xtensaProfile = {
      ...profile,
      platformRef: {
        id: xtensaManifest.id,
        version: xtensaManifest.version,
        sha256: xtensaManifest.sha256,
      },
      sdkVariant: {
        id: xtensaSdkPin.id,
        sdkTarget: 'esp32',
        memoryType: 'dio_qspi',
        compilerPack: { ...xtensaRequirement },
      },
    };
    expect(validateExecutionProfileBinding(
      xtensaProfile, xtensaManifest, xtensaRequirement, xtensaSdkPin, 'esp32', 'ESP32',
    )).toBe(xtensaProfile);
    expect(() => validateExecutionProfileBinding({
      ...xtensaProfile,
      sdkVariant: { ...xtensaProfile.sdkVariant, sdkTarget: 'esp32s3' },
    }, xtensaManifest, xtensaRequirement, xtensaSdkPin, 'esp32', 'ESP32')).toThrow(/Pack binding/);
  });
});

type PublisherFixtureOptions = Readonly<{
  sdkProfileArtifact?: 'profile-v5' | 'profile' | null;
  sdkProfileSchema?: number;
  boardProfileArtifact?: 'profile-v4' | 'profile';
  boardProfileSchema?: number;
  boardPackSchema?: number;
  boardPlatformSha256?: string;
  boardFqbn?: string;
  boardSdkVersion?: string;
  partitionsOffset?: string;
  platformTools?: boolean;
  omitPlatformProfileId?: boolean;
  includeLegacyProfiles?: boolean;
  sdkRawRevision?: boolean;
}>;

function createPublisherFixture(options: PublisherFixtureOptions = {}) {
  const publicEsp32 = join(process.cwd(), 'packages', 'web', 'public', 'esp32');
  const root = mkdtempSync(join(publicEsp32, 'publisher-fixture-'));
  const board = 'esp32:esp32:unit';
  const version = '3.3.7';
  const compilerRoot = join(root, 'packs', 'compiler');
  const sdkRoot = join(root, 'packs', 'sdk');
  const boardRoot = join(root, 'packs', 'board');
  mkdirSync(compilerRoot, { recursive: true });
  mkdirSync(sdkRoot, { recursive: true });
  mkdirSync(boardRoot, { recursive: true });

  const compilerManifest = makePackManifest({
    schema: 1,
    id: 'riscv32-esp-elf-wasm',
    version: '22.0.0',
    artifacts: [],
  });
  const requirement = {
    id: compilerManifest.id,
    version: compilerManifest.version,
    sha256: compilerManifest.revision,
  };
  writeFileSync(join(compilerRoot, 'toolchain.json'), JSON.stringify(compilerManifest));

  const platform = createPlatformManifest({
    id: 'espressif-arduino',
    version,
    vendor: 'esp32',
    architecture: 'esp32',
    platformText: PLATFORM_TEXT,
    boardsText: [
      'unit.name=Unit Board',
      'unit.build.core=esp32',
      'unit.build.variant=unit',
      'unit.build.bootloader_addr=0x0',
    ].join('\n'),
    ...(options.platformTools
      ? { tools: [requirement] }
      : { runtimeToolPolicy: 'deferred-ck-binding' as const }),
  });
  const platformBytes = Buffer.from(JSON.stringify(platform));
  const platformArtifact = writePackArtifact(
    sdkRoot,
    'platform-manifest',
    'json',
    platformBytes,
  );
  const responseBytes = Buffer.from('cCa');
  const normalizedResponseArtifact = writePackArtifact(sdkRoot, 'compile', 'tree', responseBytes, [
    responseFile('sdk/flags/S_flags', responseBytes, 0),
    responseFile('sdk/flags/c_flags', responseBytes, 1),
    responseFile('sdk/flags/cpp_flags', responseBytes, 2),
  ]);
  const responseArtifact = options.sdkRawRevision
    ? {
        id: normalizedResponseArtifact.id,
        kind: normalizedResponseArtifact.kind,
        size: normalizedResponseArtifact.size,
        sha256: normalizedResponseArtifact.sha256,
        chunks: normalizedResponseArtifact.chunks,
        files: normalizedResponseArtifact.files,
      }
    : normalizedResponseArtifact;
  const platformProfile = {
    schema: options.sdkProfileSchema ?? 5,
    ...(options.omitPlatformProfileId ? {} : { id: 'unit-platform' }),
    sdkVersion: version,
    platformRef: { id: platform.id, version: platform.version, sha256: platform.sha256 },
    platformManifestArtifact: { id: 'platform-manifest', sha256: platformArtifact.sha256 },
    compile: {
      args: ['clang++', '--target=riscv32-esp-elf', '-c', 'sketch.cpp', '-o', 'sketch.o'],
      overlaySlots: [
        { id: 'target', index: 2 },
        { id: 'defines', index: 3 },
        { id: 'memory', index: 4 },
        { id: 'variant', index: 5 },
      ],
      source: 'sketch.cpp',
      object: 'sketch.o',
      languageFlags: {
        c: ['@sdk/flags/c_flags'],
        cxx: ['@sdk/flags/cpp_flags'],
        asm: ['-x', 'assembler-with-cpp', '@sdk/flags/S_flags'],
      },
      artifactIds: ['compile'],
    },
    link: {
      args: ['clang++', '--target=riscv32-esp-elf', 'sketch.o', '-o', 'firmware.elf'],
      overlaySlots: [
        { id: 'target', index: 2 },
        { id: 'memory', index: 3 },
        { id: 'flags', index: 4 },
      ],
      object: 'sketch.o',
      elf: 'firmware.elf',
      artifactIds: ['compile'],
    },
    sdkVariant: {
      id: 'unit-sdk',
      sdkTarget: 'unit',
      memoryType: 'dio_qspi',
      compilerPack: requirement,
    },
    recipeOrigins: {
      compile: platform.recipeLowering.bindings.compile.cxx,
      link: platform.recipeLowering.bindings.link,
    },
    recipeLowering: {
      status: 'manifest-defined',
      schemaVersion: platform.recipeLowering.schemaVersion,
      sha256: platform.recipeLowering.sha256,
    },
    migration: { legacySchema: 4, legacyArtifact: 'profile' },
  };
  const sdkArtifacts = [responseArtifact, platformArtifact];
  const sdkProfileArtifact = options.sdkProfileArtifact === undefined
    ? 'profile-v5'
    : options.sdkProfileArtifact;
  if (sdkProfileArtifact) {
    sdkArtifacts.push(writePackArtifact(
      sdkRoot,
      sdkProfileArtifact,
      'json',
      Buffer.from(JSON.stringify(platformProfile)),
    ));
  }
  if (options.includeLegacyProfiles) {
    sdkArtifacts.push(writePackArtifact(
      sdkRoot,
      'profile',
      'json',
      Buffer.from(JSON.stringify({ schema: 4 })),
    ));
  }
  const sdkManifest = makePackManifest({
    schema: 2,
    id: 'unit-sdk',
    version,
    artifacts: sdkArtifacts,
  }, options.sdkRawRevision ? 'raw' : 'normalized');
  writeFileSync(join(sdkRoot, 'toolchain.json'), JSON.stringify(sdkManifest));

  const boardArtifacts = [
    writePackArtifact(boardRoot, 'variant', 'tree', Buffer.from('v'), [{
      path: 'variant/pins_arduino.h', offset: 0, length: 1, sha256: sha256(Buffer.from('v')),
    }]),
    writePackArtifact(boardRoot, 'bootloader', 'bin', Buffer.from('b')),
    writePackArtifact(boardRoot, 'partitions', 'bin', Buffer.from('p')),
    writePackArtifact(boardRoot, 'boot-app0', 'bin', Buffer.from('a')),
  ];
  const boardProfile = {
    schema: options.boardProfileSchema ?? 4,
    id: 'unit-default',
    board: options.boardFqbn ?? board,
    sdkVersion: options.boardSdkVersion ?? version,
    variant: 'unit',
    options: {},
    artifactIds: ['variant'],
    overlay: {
      compile: {
        target: ['-march=rv32imc_zicsr_zifencei', '-mabi=ilp32'],
        defines: [],
        memory: ['-Isdk/dio_qspi/include'],
        variant: ['-Ivariant'],
      },
      link: {
        target: ['-march=rv32imc_zicsr_zifencei', '-mabi=ilp32'],
        memory: ['-Lsdk/dio_qspi'],
        flags: [],
      },
    },
    image: { flashMode: 'dio', flashFrequency: '40m', flashSize: '4MB' },
    flash: {
      bootloader: 'bootloader',
      partitions: 'partitions',
      bootApp0: 'boot-app0',
      offsets: {
        bootloader: '0x0',
        partitions: options.partitionsOffset ?? '0x8000',
        bootApp0: '0xe000',
      },
    },
    platformRef: {
      id: platform.id,
      version: platform.version,
      sha256: options.boardPlatformSha256 ?? platform.sha256,
      fqbn: board,
    },
    execution: {
      targetTriple: 'riscv32-esp-elf',
      targetArguments: [
        '--target=riscv32-esp-elf',
        '-march=rv32imc_zicsr_zifencei',
        '-mabi=ilp32',
      ],
      elf: { machine: 243, floatAbi: 0 },
    },
    migration: { legacySchema: 3, legacyArtifact: 'profile' },
  };
  boardArtifacts.push(writePackArtifact(
    boardRoot,
    options.boardProfileArtifact ?? 'profile-v4',
    'json',
    Buffer.from(JSON.stringify(boardProfile)),
  ));
  if (options.includeLegacyProfiles) {
    boardArtifacts.push(writePackArtifact(
      boardRoot,
      'profile',
      'json',
      Buffer.from(JSON.stringify({ schema: 3 })),
    ));
  }
  const boardManifest = makePackManifest({
    schema: options.boardPackSchema ?? 2,
    id: 'unit-board',
    version,
    artifacts: boardArtifacts,
  });
  writeFileSync(join(boardRoot, 'toolchain.json'), JSON.stringify(boardManifest));

  const descriptor = {
    schema: 2,
    id: 'unit-runtime',
    abi: 1,
    board,
    packs: [
      {
        role: 'compiler', id: compilerManifest.id, revision: compilerManifest.revision,
        manifest: 'packs/compiler/toolchain.json',
      },
      {
        role: 'sdk', id: sdkManifest.id, revision: sdkManifest.revision,
        manifest: 'packs/sdk/toolchain.json',
      },
      {
        role: 'board', id: boardManifest.id, revision: boardManifest.revision,
        manifest: 'packs/board/toolchain.json',
      },
    ],
  };
  const descriptorPath = join(root, 'runtime.json');
  writeFileSync(descriptorPath, JSON.stringify(descriptor));
  return {
    root,
    target: { descriptor: descriptorPath, board, sdkTarget: 'unit' },
  };
}

function writePackArtifact(
  root: string,
  id: string,
  kind: string,
  body: Buffer,
  files?: ReadonlyArray<Readonly<Record<string, string | number>>>,
) {
  const chunkPath = `chunks/${id}.bin`;
  mkdirSync(join(root, 'chunks'), { recursive: true });
  writeFileSync(join(root, ...chunkPath.split('/')), body);
  return {
    id,
    kind,
    size: body.length,
    sha256: sha256(body),
    ...(files ? { files } : {}),
    chunks: [{ path: chunkPath, size: body.length, sha256: sha256(body) }],
  };
}

function responseFile(path: string, body: Buffer, offset: number) {
  return { path, offset, length: 1, sha256: sha256(body.subarray(offset, offset + 1)) };
}

function makePackManifest(input: Readonly<{
  schema: number;
  id: string;
  version: string;
  artifacts: ReadonlyArray<unknown>;
}>, revisionMode: 'normalized' | 'raw' = 'normalized') {
  const artifacts = [...input.artifacts].sort((left: any, right: any) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ));
  const manifest = { ...input, artifacts, revision: '0'.repeat(64) };
  const rawRevisionInput = JSON.stringify({
    schema: input.schema,
    id: input.id,
    version: input.version,
    artifacts,
  });
  const revisionInput = revisionMode === 'normalized' && input.schema === 2 && artifacts.length
    ? browserToolchainPackRevisionInput(manifest)
    : rawRevisionInput;
  return { ...input, artifacts, revision: sha256(Buffer.from(revisionInput)) };
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}
