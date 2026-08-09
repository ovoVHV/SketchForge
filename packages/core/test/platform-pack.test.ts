import { describe, expect, it } from 'vitest';

import {
  createPlatformManifest,
  createPlatformRecipeLowering,
  parseArduinoProperties,
  tokenizeRecipe,
  validatePlatformManifest,
  validateRecipeLowering,
} from '../src/index.js';
import { canonicalJson, sha256Hex } from '../src/build-ir/canonical.js';
import { resolvePlatformManifest } from '../src/platform-pack/builder.js';
import type { CKPlatformProfileV5 } from '../src/platform-pack/types.js';

const PLATFORM = [
  'name=Arduino ESP32',
  'compiler.path={runtime.tools.esp-riscv.path}/bin/',
  'compiler.c.cmd=riscv32-esp-elf-gcc',
  'compiler.cpp.cmd=riscv32-esp-elf-g++',
  'compiler.S.cmd=riscv32-esp-elf-gcc',
  'compiler.ar.cmd=riscv32-esp-elf-ar',
  'compiler.ar.flags=rcs',
  'compiler.warning_flags=-Wall',
  'compiler.c.flags=-Os {compiler.warning_flags}',
  'compiler.cpp.flags=-Os {compiler.warning_flags}',
  'compiler.S.flags=-Os',
  'recipe.c.o.pattern="{compiler.path}{compiler.c.cmd}" -c "{source_file}" -o "{object_file}"',
  'recipe.cpp.o.pattern="{compiler.path}{compiler.cpp.cmd}" -c "{source_file}" -o "{object_file}"',
  'recipe.S.o.pattern="{compiler.path}{compiler.S.cmd}" -c "{source_file}" -o "{object_file}"',
  'recipe.ar.pattern="{compiler.path}{compiler.ar.cmd}" rcs "{archive_file_path}" "{object_file}"',
  'recipe.c.combine.pattern="{compiler.path}{compiler.cpp.cmd}" "{object_files}" "{archive_file_path}" -o firmware.elf',
].join('\n');

const BOARDS = [
  'menu.PartitionScheme=Partition Scheme',
  'menu.EventsCore=Events Core',
  'menu.DFUOnBoot=USB DFU On Boot',
  'esp32c3.name=ESP32-C3 Dev Module',
  'esp32c3.build.core=esp32',
  'esp32c3.build.variant=esp32c3',
  'esp32c3.build.mcu=esp32c3',
  'esp32c3.build.flash_freq=80m',
  'esp32c3.menu.PartitionScheme.default=Default 4MB',
  'esp32c3.menu.PartitionScheme.default.build.partitions=default',
  'esp32c3.menu.PartitionScheme.minimal=Minimal SPIFFS',
  'esp32c3.menu.PartitionScheme.minimal.build.partitions=min_spiffs',
  'esp32c3.menu.EventsCore.core0=Core 0',
  'esp32c3.menu.EventsCore.core0.build.event_core=0',
  'esp32c3.menu.EventsCore.core1=Core 1',
  'esp32c3.menu.EventsCore.core1.build.event_core=1',
  'esp32c3.menu.DFUOnBoot.default=Disabled',
  'esp32c3.menu.DFUOnBoot.default.build.dfu_on_boot=0',
  'esp32c3.menu.DFUOnBoot.dfu=Enabled',
  'esp32c3.menu.DFUOnBoot.dfu.build.dfu_on_boot=1',
].join('\n');

function withCanonicalHash(value: object): Record<string, unknown> {
  const { sha256: _sha256, ...body } = value as Record<string, unknown>;
  return { ...body, sha256: sha256Hex(canonicalJson(body)) };
}

describe('CK Platform Pack Builder', () => {
  it('parses Arduino properties with continuations and escapes', () => {
    const parsed = parseArduinoProperties([
      '# comment',
      'compiler.flags=-Os \\',
      '  -ffunction-sections',
      'label=ESP32\\u0020Board',
      'escaped\\:key:value',
    ].join('\n'));

    expect(parsed.properties).toMatchObject({
      'compiler.flags': '-Os -ffunction-sections',
      label: 'ESP32 Board',
      'escaped:key': 'value',
    });
  });

  it('tokenizes recipe patterns without retaining host shell quoting', () => {
    expect(tokenizeRecipe('"{compiler.path}g++" -I"{build.core.path}" "{source_file}"'))
      .toEqual(['{compiler.path}g++', '-I{build.core.path}', '{source_file}']);
    expect(() => tokenizeRecipe('"unterminated')).toThrow(/unterminated quote/);
  });

  it('creates a deterministic content-addressed manifest', () => {
    const base = {
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      platformText: PLATFORM, boardsText: BOARDS,
      programmersText: 'esptool.name=Esptool\nesptool.protocol=esptool',
      tools: [{ id: 'esp-riscv', version: 'esp-13.2.0_20240530', sha256: 'a'.repeat(64) }],
    };
    expect(() => createPlatformManifest({
      ...base,
      tools: [{ id: 'esp-riscv', version: 'esp-13.2.0_20240530' } as never],
    })).toThrow(/sha256 is required/);
    const first = createPlatformManifest({
      ...base,
      files: [
        { path: 'variants/esp32c3/pins_arduino.h', content: '#define LED_BUILTIN 8\n' },
        { path: 'cores/esp32/Arduino.h', content: '#pragma once\n' },
      ],
    });
    const reordered = createPlatformManifest({
      ...base,
      files: [
        { path: 'cores/esp32/Arduino.h', content: '#pragma once\n' },
        { path: 'variants/esp32c3/pins_arduino.h', content: '#define LED_BUILTIN 8\n' },
      ],
    });

    expect(first.sha256).toBe(reordered.sha256);
    expect(first.recipes.find((recipe) => recipe.id === 'recipe.cpp.o')).toMatchObject({
      argv: ['{compiler.path}{compiler.cpp.cmd}', '-c', '{source_file}', '-o', '{object_file}'],
      placeholders: ['compiler.cpp.cmd', 'compiler.path', 'object_file', 'source_file'],
    });
    expect(first.boards[0]).toMatchObject({
      fqbn: 'esp32:esp32:esp32c3', core: 'esp32', variant: 'esp32c3',
      menus: expect.arrayContaining([
        expect.objectContaining({ id: 'PartitionScheme', label: 'Partition Scheme', default: 'default' }),
      ]),
    });
    expect(first.files.map((file) => file.role)).toEqual(['core', 'variant']);
    expect(first.recipeLowering.schemaVersion).toBe(2);
    expect(first.recipeLowering.bindings).toEqual({
      compile: {
        c: 'recipe.c.o',
        cxx: 'recipe.cpp.o',
        asm: 'recipe.S.o',
      },
      archive: 'recipe.ar',
      link: 'recipe.c.combine',
    });
    expect(first.recipeLowering.archive).toEqual({
      command: 'ar',
      operation: 'rcs',
      argumentOrder: ['operation', 'output', 'inputs', 'flags'],
    });
    expect(validatePlatformManifest(first)).toBe(first);
    expect(() => validatePlatformManifest({ ...first, version: '3.3.8' })).toThrow(/sha256 mismatch/);

    expect(() => createPlatformManifest({
      ...base,
      files: [{ path: 'platform.txt', content: `${PLATFORM}\n# drift` }],
    })).toThrow(/config source does not match parsed input: platform\.txt/);

    expect(resolvePlatformManifest({
      manifest: first,
      fqbn: 'esp32:esp32:esp32c3',
      options: {
        partition_scheme: 'min_spiffs', event_core: '1', usb_dfu_on_boot: 'disabled', flash_freq: '80m',
      },
    })).toMatchObject({
      manifestSha256: first.sha256,
      id: 'espressif-arduino',
      version: '3.3.7',
      board: { id: 'esp32c3', core: 'esp32', variant: 'esp32c3' },
      options: { PartitionScheme: 'minimal', EventsCore: 'core1', DFUOnBoot: 'default' },
      properties: { 'build.partitions': 'min_spiffs' },
      resolvedRecipes: expect.arrayContaining([
        {
          id: 'recipe.cpp.o',
          argv: [
            '{runtime.tools.esp-riscv.path}/bin/riscv32-esp-elf-g++',
            '-c',
            '{source_file}',
            '-o',
            '{object_file}',
          ],
          placeholders: ['object_file', 'runtime.tools.esp-riscv.path', 'source_file'],
        },
      ]),
    });
    expect(() => resolvePlatformManifest({
      manifest: first,
      fqbn: 'esp32:esp32:esp32c3',
      options: { PartitionScheme: 'missing' },
    })).toThrow(/unknown platform menu option/);
    expect(() => resolvePlatformManifest({
      manifest: first,
      fqbn: 'esp32:esp32:esp32c3',
      options: { made_up_option: 'enabled' },
    })).toThrow(/unknown platform target option/);
    expect(() => resolvePlatformManifest({
      manifest: first,
      fqbn: 'esp32:esp32:esp32c3',
      options: { flash_freq: '40m' },
    })).toThrow(/unknown platform target option value/);
  });

  it('uses language-specific compile bindings in default non-ESP32 lowering contracts', () => {
    const manifest = createPlatformManifest({
      id: 'arduino-avr', version: '1.8.6', vendor: 'arduino', architecture: 'avr',
      platformText: [
        'name=Arduino AVR Boards',
        'recipe.c.o.pattern=avr-gcc -c "{source_file}" -o "{object_file}"',
        'recipe.cpp.o.pattern=avr-g++ -c "{source_file}" -o "{object_file}"',
        'recipe.S.o.pattern=avr-gcc -x assembler-with-cpp -c "{source_file}" -o "{object_file}"',
        'recipe.ar.pattern=avr-ar rcs "{archive_file_path}" "{object_file}"',
        'recipe.c.combine.pattern=avr-g++ "{object_files}" -o firmware.elf',
      ].join('\n'),
      boardsText: [
        'uno.name=Arduino Uno',
        'uno.build.core=arduino',
        'uno.build.variant=standard',
      ].join('\n'),
      runtimeToolPolicy: 'deferred-ck-binding',
    });

    expect(manifest.recipeLowering.schemaVersion).toBe(2);
    expect(manifest.recipeLowering.bindings.compile).toEqual({
      c: 'recipe.c.o',
      cxx: 'recipe.cpp.o',
      asm: 'recipe.S.o',
    });
    expect(manifest.recipeLowering.archive).toEqual({
      command: 'ar',
      operation: 'rcs',
      argumentOrder: ['operation', 'output', 'inputs', 'flags'],
    });
  });

  it('requires every schema-v2 lowering binding to resolve exactly one recipe', () => {
    const input = {
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      boardsText: BOARDS,
      runtimeToolPolicy: 'deferred-ck-binding' as const,
    };
    expect(() => createPlatformManifest({
      ...input,
      platformText: PLATFORM.split('\n')
        .filter((line) => !line.startsWith('recipe.S.o.pattern='))
        .join('\n'),
    })).toThrow(/compile\.asm binding must resolve exactly one recipe: recipe\.S\.o \(found 0\)/);

    const manifest = createPlatformManifest({ ...input, platformText: PLATFORM });
    const bindings = [
      ['compile.c', manifest.recipeLowering.bindings.compile.c],
      ['compile.cxx', manifest.recipeLowering.bindings.compile.cxx],
      ['compile.asm', manifest.recipeLowering.bindings.compile.asm],
      ['archive', manifest.recipeLowering.bindings.archive],
      ['link', manifest.recipeLowering.bindings.link],
    ] as const;

    for (const [name, recipeId] of bindings) {
      const recipe = manifest.recipes.find((candidate) => candidate.id === recipeId)!;
      expect(() => validatePlatformManifest(withCanonicalHash({
        ...manifest,
        recipes: manifest.recipes.filter((candidate) => candidate.id !== recipeId),
      })), name).toThrow(/binding must resolve exactly one recipe: .* \(found 0\)/);
      expect(() => validatePlatformManifest(withCanonicalHash({
        ...manifest,
        recipes: [...manifest.recipes, recipe],
      })), name).toThrow(/binding must resolve exactly one recipe: .* \(found 2\)/);
    }
  });

  it('rejects schema-v1 manifests and requires schema-v2 recipe lowering', () => {
    const current = createPlatformManifest({
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      platformText: PLATFORM,
      boardsText: BOARDS,
      runtimeToolPolicy: 'deferred-ck-binding',
    });
    const { recipeLowering: _recipeLowering, ...withoutLowering } = current;
    const legacy = withCanonicalHash({
      ...withoutLowering,
      schemaVersion: 1,
      recipes: [],
    });

    expect(() => validatePlatformManifest(legacy))
      .toThrow(/unsupported platform manifest schema 1/);
    expect(() => resolvePlatformManifest({
      manifest: legacy as never,
      fqbn: 'esp32:esp32:esp32c3',
    })).toThrow(/unsupported platform manifest schema 1/);

    expect(() => validatePlatformManifest(withCanonicalHash(withoutLowering)))
      .toThrow(/platform recipe lowering contract must be an object/);
    expect(resolvePlatformManifest({
      manifest: current,
      fqbn: 'esp32:esp32:esp32c3',
    }).recipeLowering).toBe(current.recipeLowering);
  });

  it('rejects lowering hash tampering and models the V5 profile binding', () => {
    const manifest = createPlatformManifest({
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      platformText: PLATFORM,
      boardsText: BOARDS,
      runtimeToolPolicy: 'deferred-ck-binding',
    });
    const tamperedLowering = {
      ...manifest.recipeLowering,
      bindings: { ...manifest.recipeLowering.bindings, link: 'recipe.c.combine.tampered' },
    };

    expect(manifest.schemaVersion).toBe(2);
    expect(validateRecipeLowering(manifest.recipeLowering)).toBe(manifest.recipeLowering);
    expect(() => validateRecipeLowering(tamperedLowering))
      .toThrow(/platform recipe lowering sha256 mismatch/);
    expect(() => validatePlatformManifest({ ...manifest, recipeLowering: tamperedLowering }))
      .toThrow(/platform recipe lowering sha256 mismatch/);

    const requirement = {
      id: 'riscv32-esp-elf-wasm', version: '22.0.0', sha256: 'a'.repeat(64),
    };
    const profile: CKPlatformProfileV5 = {
      schema: 5,
      id: 'espressif-arduino-3.3.7',
      sdkVersion: manifest.version,
      compile: {
        args: ['clang++', 'sketch.cpp', '-o', 'sketch.o'],
        overlaySlots: [],
        artifactIds: ['compile-000'],
        source: 'sketch.cpp',
        object: 'sketch.o',
        languageFlags: {
          c: ['@sdk/flags/c_flags'],
          cxx: ['@sdk/flags/cpp_flags'],
          asm: ['@sdk/flags/S_flags'],
        },
      },
      link: {
        args: ['clang++', 'sketch.o', '-o', 'firmware.elf'],
        overlaySlots: [],
        artifactIds: ['link-000'],
        object: 'sketch.o',
        elf: 'firmware.elf',
      },
      platformRef: { id: manifest.id, version: manifest.version, sha256: manifest.sha256 },
      platformManifestArtifact: { id: 'platform-manifest', sha256: 'c'.repeat(64) },
      sdkVariant: {
        id: 'arduino-esp32c3-sdk',
        sdkTarget: 'esp32c3',
        memoryType: 'dio_qspi',
        compilerPack: requirement,
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
      migration: { legacySchema: 4, legacyArtifact: 'profile' },
    };

    expect(profile.compile.languageFlags).toEqual({
      c: ['@sdk/flags/c_flags'],
      cxx: ['@sdk/flags/cpp_flags'],
      asm: ['@sdk/flags/S_flags'],
    });
    expect(profile.recipeOrigins.compile).toBe(manifest.recipeLowering.bindings.compile.cxx);
    expect(profile.recipeLowering.sha256).toBe(manifest.recipeLowering.sha256);
  });

  it('fails closed on invalid schema-v2 compile and archive contracts', () => {
    const lowering = createPlatformRecipeLowering();
    const rehashedBindings = (compile: unknown) => withCanonicalHash({
      ...lowering,
      bindings: { ...lowering.bindings, compile },
    });

    expect(() => validateRecipeLowering(rehashedBindings('recipe.cpp.o')))
      .toThrow(/compile bindings must be an object/);
    expect(() => validateRecipeLowering(rehashedBindings({
      c: 'recipe.c.o', cxx: 'recipe.cpp.o',
    }))).toThrow(/compile bindings has unexpected fields/);
    expect(() => validateRecipeLowering(rehashedBindings({
      c: 'recipe.c.o', cxx: 'recipe.cpp.o', asm: 'recipe.S.o', objc: 'recipe.m.o',
    }))).toThrow(/compile bindings has unexpected fields/);
    expect(() => validateRecipeLowering(rehashedBindings({
      c: 'recipe.c.o', cxx: '', asm: 'recipe.S.o',
    }))).toThrow(/compile cxx binding is invalid/);

    expect(() => validateRecipeLowering(withCanonicalHash({
      ...lowering,
      schemaVersion: 1,
    }))).toThrow(/unsupported recipe lowering schema 1/);
    expect(() => validateRecipeLowering(withCanonicalHash({
      ...lowering,
      archive: { ...lowering.archive, command: 'llvm-ar' },
    }))).toThrow(/archive contract is invalid/);
    expect(() => validateRecipeLowering(withCanonicalHash({
      ...lowering,
      archive: { ...lowering.archive, operation: 'crs' },
    }))).toThrow(/archive contract is invalid/);
    expect(() => validateRecipeLowering(withCanonicalHash({
      ...lowering,
      archive: {
        ...lowering.archive,
        argumentOrder: ['operation', 'flags', 'output', 'inputs'],
      },
    }))).toThrow(/archive contract is invalid/);
  });

  it('hashes custom lowering contracts independently from their enclosing manifests', () => {
    const first = createPlatformRecipeLowering();
    const second = createPlatformRecipeLowering({
      responseFiles: {
        marker: '@',
        roles: { compiler: 'custom-compiler-response', linker: 'custom-linker-response' },
        languageFiles: { c: 'compile-c.rsp', cxx: 'compile-cxx.rsp', asm: 'compile-asm.rsp' },
      },
    });
    const changedCRecipe = createPlatformRecipeLowering({
      bindings: {
        ...first.bindings,
        compile: { ...first.bindings.compile, c: 'recipe.custom.c.o' },
      },
    });

    expect(first.sha256).not.toBe(second.sha256);
    expect(first.sha256).not.toBe(changedCRecipe.sha256);
    expect(validateRecipeLowering(second)).toBe(second);
    expect(validateRecipeLowering(changedCRecipe)).toBe(changedCRecipe);
  });

  it('recursively resolves recipe properties and rejects unknown or cyclic placeholders', () => {
    const create = (platformText: string) => createPlatformManifest({
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      platformText: [
        'recipe.c.o.pattern=cc -c "{source_file}" -o "{object_file}"',
        'recipe.S.o.pattern=cc -c "{source_file}" -o "{object_file}"',
        'recipe.ar.pattern=ar rcs "{archive_file_path}" "{object_file}"',
        'recipe.c.combine.pattern=c++ "{object_files}" "{archive_file_path}" -o firmware.elf',
        platformText,
      ].join('\n'),
      boardsText: BOARDS,
      runtimeToolPolicy: 'deferred-ck-binding',
    });
    const manifest = create([
      'compiler.path=toolchain/bin/',
      'compiler.cpp.cmd=g++',
      'compiler.warning_flags=-Wall',
      'compiler.common.flags=-Os {compiler.warning_flags}',
      'recipe.cpp.o.pattern="{compiler.path}{compiler.cpp.cmd}" {compiler.common.flags} -DMCU={build.mcu} -DPART={build.partitions} "{source_file}" -o "{object_file}"',
    ].join('\n'));
    const resolved = resolvePlatformManifest({
      manifest,
      fqbn: 'esp32:esp32:esp32c3',
      options: { partition_scheme: 'minimal' },
    });
    expect(resolved.resolvedRecipes.find((recipe) => recipe.id === 'recipe.cpp.o')).toEqual({
      id: 'recipe.cpp.o',
      argv: [
        'toolchain/bin/g++', '-Os', '-Wall', '-DMCU=esp32c3', '-DPART=min_spiffs',
        '{source_file}', '-o', '{object_file}',
      ],
      placeholders: ['object_file', 'source_file'],
    });

    const withProperties = (properties: Record<string, string>, argv: string[]) => {
      const candidate = {
        ...manifest,
        platformProperties: properties,
        recipes: manifest.recipes.map((recipe) => recipe.id === 'recipe.cpp.o'
          ? { id: 'recipe.cpp.o', argv, placeholders: [] }
          : recipe),
      };
      const { sha256: _sha256, ...withoutHash } = candidate;
      return { ...withoutHash, sha256: sha256Hex(canonicalJson(withoutHash)) };
    };
    expect(() => resolvePlatformManifest({
      manifest: withProperties({}, ['g++', '{missing.value}']),
      fqbn: 'esp32:esp32:esp32c3',
    })).toThrow(/unknown platform recipe placeholder missing\.value in recipe\.cpp\.o/);
    expect(() => resolvePlatformManifest({
      manifest: withProperties({ alpha: '{beta}', beta: '{alpha}' }, ['g++', '{alpha}']),
      fqbn: 'esp32:esp32:esp32c3',
    })).toThrow(/cyclic platform property placeholder: alpha -> beta -> alpha/);
  });

  it('discovers content-addressed runtime tools from Pack metadata', () => {
    const manifest = createPlatformManifest({
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      platformText: PLATFORM,
      boardsText: BOARDS,
      files: [{
        path: 'tools/metadata.json',
        content: JSON.stringify({
          schemaVersion: 1,
          tools: [{ id: 'esp-riscv', version: 'esp-14.2.0', sha256: 'b'.repeat(64) }],
        }),
      }],
    });
    expect(manifest.tools).toEqual([{
      id: 'esp-riscv', version: 'esp-14.2.0', sha256: 'b'.repeat(64),
    }]);
    expect(() => createPlatformManifest({
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      platformText: PLATFORM,
      boardsText: BOARDS,
    })).toThrow(/has no version and sha256 metadata/);
    expect(() => createPlatformManifest({
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      platformText: PLATFORM,
      boardsText: BOARDS,
      files: [{
        path: 'tools/metadata.json',
        content: JSON.stringify({
          tools: [{ id: 'esp-riscv', version: 'esp-14.2.0', sha256: 'b'.repeat(64) }],
        }),
      }],
      tools: [{ id: 'esp-riscv', version: 'esp-14.2.0', sha256: 'c'.repeat(64) }],
    })).toThrow(/conflicting platform tool metadata for esp-riscv/);
  });

  it('makes transformed CK tool binding an explicit fail-closed policy', () => {
    const input = {
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      platformText: PLATFORM,
      boardsText: BOARDS,
      runtimeToolPolicy: 'ck-transformed' as const,
    };
    expect(() => createPlatformManifest(input)).toThrow(/bind at least one immutable CK tool Pack/);

    const manifest = createPlatformManifest({
      ...input,
      tools: [{ id: 'riscv32-esp-elf-wasm', version: '22.0.0', sha256: 'c'.repeat(64) }],
    });
    expect(manifest.tools).toEqual([{
      id: 'riscv32-esp-elf-wasm', version: '22.0.0', sha256: 'c'.repeat(64),
    }]);

    const duplicated = { ...manifest, tools: [...manifest.tools, ...manifest.tools] };
    const { sha256: _sha256, ...withoutHash } = duplicated;
    expect(() => validatePlatformManifest({
      ...withoutHash,
      sha256: sha256Hex(canonicalJson(withoutHash)),
    })).toThrow(/platform tool .* is duplicated/);
  });

  it('keeps source Platform identity independent from target-specific Compiler Packs', () => {
    const input = {
      id: 'espressif-arduino', version: '3.3.7', vendor: 'esp32', architecture: 'esp32',
      platformText: PLATFORM,
      boardsText: BOARDS,
      runtimeToolPolicy: 'deferred-ck-binding' as const,
    };
    const manifest = createPlatformManifest(input);
    expect(manifest.tools).toEqual([]);
    expect(manifest.boards).toHaveLength(1);
    expect(() => createPlatformManifest({
      ...input,
      tools: [{ id: 'riscv32-esp-elf-wasm', version: '22.0.0', sha256: 'a'.repeat(64) }],
    })).toThrow(/cannot bind a target-specific CK tool Pack/);
  });
});
