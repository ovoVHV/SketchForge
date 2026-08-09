// Shared CK lowering policy used by the ESP32 runtime builder and profile
// migration. Keep this data-only so both tsx and plain Node consumers use the
// exact same contract bytes.
export function createEsp32RecipeLoweringInput() {
  return {
    schemaVersion: 2,
    bindings: {
      compile: {
        c: 'recipe.c.o',
        cxx: 'recipe.cpp.o',
        asm: 'recipe.S.o',
      },
      archive: 'recipe.ar',
      link: 'recipe.c.combine',
    },
    paths: {
      logicalToAction: {
        exact: {
          'core.a': 'packs/platform/core.a',
          core: 'packs/platform/core',
          variant: 'packs/board/variant',
        },
        prefixes: {
          'sdk/': 'packs/platform/sdk/',
          'core/': 'packs/platform/core/',
          'variant/': 'packs/board/variant/',
          'runtime/': 'packs/toolchain/runtime/',
        },
      },
    },
    responseFiles: {
      marker: '@',
      roles: {
        compiler: 'compiler-response-file',
        linker: 'linker-response-file',
      },
      languageFiles: { c: 'c_flags', cxx: 'cpp_flags', asm: 'S_flags' },
    },
    compatibility: {
      compiler: {
        disableBuiltinCxxIncludes: true,
        runtimeIncludes: [
          { role: 'cxx', flag: '-isystem' },
          { role: 'cxx-target', flag: '-isystem' },
          { role: 'cxx-backward', flag: '-isystem' },
          { role: 'gcc', flag: '-isystem' },
          { role: 'gcc-fixed', flag: '-isystem' },
          { role: 'sysroot', flag: '-isystem' },
        ],
      },
      linker: {
        searchPaths: ['sdk/lld-compat'],
        responseFiles: ['sdk/lld-compat/ld_flags'],
        runtimeLibraryDirectories: 'all',
        forceLldTargetPrefixes: ['xtensa-'],
      },
    },
    archive: {
      command: 'ar',
      operation: 'rcs',
      argumentOrder: ['operation', 'output', 'inputs', 'flags'],
    },
    publication: {
      sdkArchiveRewrites: ['strip-debug', 'deterministic-archives'],
    },
  };
}
