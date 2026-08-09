import { describe, expect, it } from 'vitest';
import {
  CK_BROWSER_PLATFORM_PATH_LAYOUT,
  invertPlatformLogicalPathLayout,
  lowerPlatformBuildCommands,
  resolvePlatformLogicalPath,
} from '../../core/src/build-ir/platform-planning.js';
import { createPlatformRecipeLowering } from '../../core/src/platform-pack/builder.js';
import {
  CK_BROWSER_PLATFORM_PATH_LAYOUT as browserLayout,
  lowerPlatformBuildCommands as lowerBrowserCommands,
  resolvePlatformLogicalPath as resolveBrowserPath,
} from '../public/ck-platform-planning.js';

const compile = {
  args: [
    'clang++',
    '--target=riscv32-esp-elf',
    '-DARDUINO_ARCH_ESP32',
    '-DCPU_FREQ=160000000L',
    '-Isdk/include',
    '-Icore',
    '@sdk/flags/c_flags',
    '@sdk/flags/cpp_flags',
    '@sdk/flags/S_flags',
    '-Wall',
    '-c',
    'sketch.cpp',
    '-o',
    'sketch.o',
  ],
  source: 'sketch.cpp',
  object: 'sketch.o',
};

const link = {
  args: [
    'clang++',
    '-Lsdk/lib',
    '@sdk/flags/ld_flags',
    '-Wl,--start-group',
    'sketch.o',
    'core.a',
    '@sdk/flags/ld_libs',
    '-Wl,--end-group',
    '-o',
    'firmware.elf',
  ],
  object: 'sketch.o',
  elf: 'firmware.elf',
};

describe('CK platform planning adapter', () => {
  it('maps Browser Pack paths and lowers compile/link placeholders', () => {
    const result = lowerPlatformBuildCommands({
      compile,
      link,
      pathLayout: CK_BROWSER_PLATFORM_PATH_LAYOUT,
      languageFlags: {
        cxx: ['-Wno-error=narrowing'],
        asm: ['-D__ASSEMBLY__', '-x', 'assembler-with-cpp'],
      },
    });

    expect(result.macros).toEqual({
      ARDUINO_ARCH_ESP32: true,
      CPU_FREQ: '160000000L',
    });
    expect(result.includePaths).toEqual([
      'packs/platform/sdk/include',
      'packs/platform/core',
    ]);
    expect(result.flags).toEqual({
      common: ['--target=riscv32-esp-elf', '-Wall'],
      c: ['@packs/platform/sdk/flags/c_flags'],
      cxx: ['@packs/platform/sdk/flags/cpp_flags', '-Wno-error=narrowing'],
      asm: ['@packs/platform/sdk/flags/S_flags', '-D__ASSEMBLY__', '-x', 'assembler-with-cpp'],
    });
    expect(result.compilerInputs).toEqual([
      { path: 'packs/platform/sdk/flags/S_flags', role: 'compiler-response-file' },
      { path: 'packs/platform/sdk/flags/c_flags', role: 'compiler-response-file' },
      { path: 'packs/platform/sdk/flags/cpp_flags', role: 'compiler-response-file' },
    ]);
    expect(result.linkerFlags).toEqual([
      '-Lpacks/platform/sdk/lib',
      '@packs/platform/sdk/flags/ld_flags',
      '-Wl,--start-group',
    ]);
    expect(result.linkerTailFlags).toEqual([
      '@packs/platform/sdk/flags/ld_libs',
      '-Wl,--end-group',
    ]);
    expect(result.linkerInputs).toEqual([
      { path: 'packs/platform/sdk/flags/ld_flags', role: 'linker-response-file' },
      { path: 'packs/platform/sdk/flags/ld_libs', role: 'linker-response-file' },
    ]);
  });

  it('keeps Native logical paths unchanged when no Browser layout is supplied', () => {
    expect(lowerPlatformBuildCommands({ compile, link }).includePaths).toEqual([
      'sdk/include',
      'core',
    ]);
    expect(lowerPlatformBuildCommands({ compile, link }).linkerFlags).toContain('-Lsdk/lib');
    expect(resolvePlatformLogicalPath('variant/pins_arduino.h', undefined))
      .toBe('variant/pins_arduino.h');
  });

  it('resolves exact paths before the longest matching prefix', () => {
    expect(resolvePlatformLogicalPath('core.a', CK_BROWSER_PLATFORM_PATH_LAYOUT))
      .toBe('packs/platform/core.a');
    expect(resolvePlatformLogicalPath('core/widgets.h', CK_BROWSER_PLATFORM_PATH_LAYOUT))
      .toBe('packs/platform/core/widgets.h');
    expect(resolvePlatformLogicalPath('variant/pins_arduino.h', CK_BROWSER_PLATFORM_PATH_LAYOUT))
      .toBe('packs/board/variant/pins_arduino.h');
    expect(resolvePlatformLogicalPath('runtime/gcc/include', CK_BROWSER_PLATFORM_PATH_LAYOUT))
      .toBe('packs/toolchain/runtime/gcc/include');
  });

  it('inverts Manifest path mappings back to their logical paths', () => {
    const recipeLowering = createPlatformRecipeLowering({
      paths: {
        logicalToAction: {
          exact: {
            'core.a': 'actions/platform/core.a',
            variant: 'actions/board/variant',
          },
          prefixes: {
            'sdk/': 'actions/platform/sdk/',
            'sdk/tools/': 'actions/toolchain/',
            'variant/': 'actions/board/variant/',
          },
        },
      },
    });
    const layout = recipeLowering.paths.logicalToAction;
    const inverse = invertPlatformLogicalPathLayout(layout);

    for (const logicalPath of [
      'core.a',
      'sdk/include/Arduino.h',
      'sdk/tools/bin/objcopy',
      'variant/pins_arduino.h',
      'unmapped/file.txt',
    ]) {
      const actionPath = resolvePlatformLogicalPath(logicalPath, layout);
      expect(resolvePlatformLogicalPath(actionPath, inverse)).toBe(logicalPath);
    }
    expect(() => invertPlatformLogicalPathLayout({
      exact: { first: 'actions/shared', second: 'actions/shared' },
    })).toThrow(/destinations are duplicated/);
  });

  it('consumes Manifest-defined response roles and language filenames', () => {
    const recipeLowering = createPlatformRecipeLowering({
      responseFiles: {
        marker: '@',
        roles: {
          compiler: 'custom-compiler-response',
          linker: 'custom-linker-response',
        },
        languageFiles: {
          c: 'compile-c.rsp',
          cxx: 'compile-cxx.rsp',
          asm: 'compile-asm.rsp',
        },
      },
    });
    const result = lowerPlatformBuildCommands({
      compile: {
        ...compile,
        args: [
          'clang++',
          '--target=riscv32-esp-elf',
          '@sdk/flags/common.rsp',
          '@sdk/flags/compile-c.rsp',
          '@sdk/flags/compile-cxx.rsp',
          '@sdk/flags/compile-asm.rsp',
          '-c',
          'sketch.cpp',
          '-o',
          'sketch.o',
        ],
      },
      link: {
        ...link,
        args: [
          'clang++',
          '@sdk/flags/link-prefix.rsp',
          'sketch.o',
          'core.a',
          '@sdk/flags/link-tail.rsp',
          '-o',
          'firmware.elf',
        ],
      },
      recipeLowering,
    });

    expect(result.flags).toEqual({
      common: ['--target=riscv32-esp-elf', '@sdk/flags/common.rsp'],
      c: ['@sdk/flags/compile-c.rsp'],
      cxx: ['@sdk/flags/compile-cxx.rsp'],
      asm: ['@sdk/flags/compile-asm.rsp'],
    });
    expect(result.compilerInputs).toEqual([
      { path: 'sdk/flags/common.rsp', role: 'custom-compiler-response' },
      { path: 'sdk/flags/compile-asm.rsp', role: 'custom-compiler-response' },
      { path: 'sdk/flags/compile-c.rsp', role: 'custom-compiler-response' },
      { path: 'sdk/flags/compile-cxx.rsp', role: 'custom-compiler-response' },
    ]);
    expect(result.linkerInputs).toEqual([
      { path: 'sdk/flags/link-prefix.rsp', role: 'custom-linker-response' },
      { path: 'sdk/flags/link-tail.rsp', role: 'custom-linker-response' },
    ]);
  });

  it('fails closed when command placeholders are missing or duplicated', () => {
    expect(() => lowerPlatformBuildCommands({
      compile: { ...compile, args: compile.args.filter((argument) => argument !== '-c') },
      link,
    })).toThrow(/compile placeholders are invalid/);

    expect(() => lowerPlatformBuildCommands({
      compile,
      link: { ...link, args: [...link.args, '-o', 'firmware.elf'] },
    })).toThrow(/link placeholders are invalid/);
  });

  it('keeps the checked-in Browser module behavior identical to the core adapter', () => {
    const input = {
      compile,
      link,
      pathLayout: CK_BROWSER_PLATFORM_PATH_LAYOUT,
      languageFlags: { common: ['-fno-exceptions'], c: ['-std=gnu17'] },
    };
    expect(browserLayout).toEqual(CK_BROWSER_PLATFORM_PATH_LAYOUT);
    expect(resolveBrowserPath('sdk/lib', browserLayout))
      .toBe(resolvePlatformLogicalPath('sdk/lib', CK_BROWSER_PLATFORM_PATH_LAYOUT));
    expect(lowerBrowserCommands(input)).toEqual(lowerPlatformBuildCommands(input));
  });
});
