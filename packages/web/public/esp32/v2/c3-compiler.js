import {
  createEsp32RuntimePackLoaders,
  createEsp32S2RuntimePackLoaders,
  createEsp32S3RuntimePackLoaders,
  createEsp32C3RuntimePackLoaders,
  createEsp32C5RuntimePackLoaders,
  createEsp32C6RuntimePackLoaders,
  createEsp32H2RuntimePackLoaders,
  createEsp32P4RuntimePackLoaders,
  ESP32_BOARD,
  ESP32_S2_BOARD,
  ESP32_S3_BOARD,
  ESP32_C3_BOARD,
  ESP32_C5_BOARD,
  ESP32_C6_BOARD,
  ESP32_H2_BOARD,
  ESP32_P4_BOARD,
} from '../v1/c3-runtime.js';
import { ESP32_BROWSER_LIBRARY_PACK_LIMITS } from '../v1/library-registry.js';
import { decodeArduinoSketchAction } from '../../arduino-sketch.js';
import {
  invertPlatformLogicalPathLayout,
  resolvePlatformLogicalPath,
} from '../../ck-platform-planning.js';
import { resolveCustomEsp32Partitions } from '../../ck-esp32-partitions.js';

export const ESP32_C3_SDK_PROFILE_SCHEMA = 2;
export const ESP32_C3_SDK_PROFILE_ARTIFACT = 'profile';
export const ESP32_PLATFORM_PROFILE_SCHEMA = 5;
export const ESP32_BOARD_PROFILE_SCHEMA = 4;
const ESP32_LEGACY_PLATFORM_PROFILE_SCHEMA = 4;
const ESP32_LEGACY_BOARD_PROFILE_SCHEMA = 3;
const ESP32_PLATFORM_PROFILE_ARTIFACT = 'profile-v5';
const ESP32_PLATFORM_MANIFEST_ARTIFACT = 'platform-manifest';
const ESP32_BOARD_PROFILE_CURRENT_ARTIFACT = 'profile-v4';
export const ESP32_BOARD_PROFILE_ARTIFACT = 'profile';

export const ESP32_C3_DEFAULT_OPTIONS = Object.freeze({
  partition_scheme: 'default',
  flash_mode: 'dio',
  flash_freq: '40m',
  flash_size: '4MB',
  cpu_freq: '160000000L',
  usb_cdc_on_boot: 'disabled',
  debug_level: 'none',
  upload_speed: '921600',
  erase_flash: 'disabled',
});
export const ESP32_C6_DEFAULT_OPTIONS = Object.freeze({
  flash_mode: 'qio',
  flash_freq: '80m',
  flash_size: '4MB',
  partition_scheme: 'default',
  cpu_freq: '160000000L',
  usb_cdc_on_boot: 'disabled',
  zigbee_mode: 'disabled',
  debug_level: 'none',
  upload_speed: '921600',
  erase_flash: 'disabled',
});
export const ESP32_C5_DEFAULT_OPTIONS = Object.freeze({
  psram: 'disabled',
  flash_mode: 'qio',
  flash_freq: '80m',
  flash_size: '4MB',
  partition_scheme: 'default',
  cpu_freq: '240000000L',
  usb_cdc_on_boot: 'disabled',
  zigbee_mode: 'disabled',
  debug_level: 'none',
  upload_speed: '921600',
  erase_flash: 'disabled',
});
export const ESP32_H2_DEFAULT_OPTIONS = Object.freeze({
  flash_mode: 'qio',
  flash_freq: '64m',
  flash_size: '4MB',
  partition_scheme: 'default',
  usb_cdc_on_boot: 'disabled',
  zigbee_mode: 'disabled',
  debug_level: 'none',
  upload_speed: '921600',
  erase_flash: 'disabled',
});
export const ESP32_P4_DEFAULT_OPTIONS = Object.freeze({
  chip_variant: 'prev3',
  psram: 'disabled',
  usb_mode: 'tinyusb',
  usb_cdc_on_boot: 'disabled',
  usb_msc_on_boot: 'disabled',
  usb_dfu_on_boot: 'disabled',
  flash_mode: 'qio',
  flash_freq: '80m',
  flash_size: '4MB',
  partition_scheme: 'default',
  debug_level: 'none',
  upload_speed: '921600',
  erase_flash: 'disabled',
});
export const ESP32_DEFAULT_OPTIONS = Object.freeze({
  psram: 'disabled',
  flash_mode: 'dio',
  flash_freq: '40m',
  flash_size: '4MB',
  partition_scheme: 'default',
  cpu_freq: '240000000L',
  loop_core: '1',
  event_core: '1',
  debug_level: 'none',
  upload_speed: '921600',
  erase_flash: 'disabled',
});
export const ESP32_S2_DEFAULT_OPTIONS = Object.freeze({
  psram: 'disabled',
  flash_mode: 'qio',
  flash_freq: '80m',
  flash_size: '4MB',
  partition_scheme: 'default',
  cpu_freq: '240000000L',
  usb_cdc_on_boot: 'disabled',
  usb_msc_on_boot: 'disabled',
  usb_dfu_on_boot: 'disabled',
  debug_level: 'none',
  upload_speed: '921600',
  erase_flash: 'disabled',
});
export const ESP32_S3_DEFAULT_OPTIONS = Object.freeze({
  psram: 'disabled',
  flash_mode: 'qio',
  flash_freq: '80m',
  flash_size: '4MB',
  partition_scheme: 'default',
  cpu_freq: '240000000L',
  loop_core: '1',
  event_core: '1',
  usb_mode: 'hwcdc',
  usb_cdc_on_boot: 'disabled',
  usb_msc_on_boot: 'disabled',
  usb_dfu_on_boot: 'disabled',
  debug_level: 'none',
  upload_speed: '921600',
  erase_flash: 'disabled',
});

const NON_BUILD_OPTIONS = new Set(['upload_speed', 'erase_flash']);
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_VFS_SEGMENT = /^[A-Za-z0-9._+-]+$/;
const RESERVED_VFS_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PROFILE_BYTES = 1024 * 1024;
const MAX_PLATFORM_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_VFS_GROUPS = 96;
const MAX_VFS_FILES = 10_000;
const MAX_VFS_FILE_BYTES = 64 * 1024 * 1024;
const MAX_VFS_GROUP_BYTES = 64 * 1024 * 1024;
const MAX_VFS_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_COMMAND_ARGUMENTS = 512;
const MAX_COMMAND_ARGUMENT_CHARS = 4 * 1024;
const MAX_COMMAND_CHARS = 64 * 1024;
const MAX_COMPILER_OUTPUT_BYTES = 64 * 1024;
const MAX_ELF_BYTES = 64 * 1024 * 1024;
const MAX_ESP32_MERGED_IMAGE_BYTES = 32 * 1024 * 1024;
const ESP32_MERGE_SEGMENT_COUNT = 4;
const ESP32_SR_PARTITION_SCHEME = 'esp_sr_16';
const ESP32_SR_MODEL_ARTIFACT = 'srmodels';
const ESP32_SR_MODEL_PATH = 'build/srmodels.bin';
const ESP32_SR_MODEL_OFFSET = '0xd10000';
const ESP32_SR_MODEL_SIZE_BYTES = 2468362;
const ESP32_SR_MODEL_CAPACITY_BYTES = 0x2f0000;
const ESP32_SR_FLASH_SIZE = '16MB';
const ESP32_SR_FLASH_SIZE_BYTES = 0x1000000;
const ESP32_SR_MERGE_SEGMENT_COUNT = 5;
const ESP32_ELF_SHA256_OFFSET = '0xb0';
const ESP32_STATIC_FLASH_OFFSETS = Object.freeze({ partitions: '0x8000', bootApp0: '0xe000' });
const BROWSER_LIBRARY_SOURCE_SCHEMA = 1;
const LEGACY_WIFI_PROVISIONING_LIBRARY = '-lwifi_provisioning';
const NETWORK_PROVISIONING_LIBRARY = '-lespressif__network_provisioning';
export const ESP32_BROWSER_LIBRARY_SOURCE_LIMITS = Object.freeze({
  maxPayloadBytes: 64 * 1024 * 1024,
  maxFileBytes: 48 * 1024 * 1024,
  maxTotalSourceBytes: 128 * 1024 * 1024,
  maxFiles: 8192,
  maxFilesPerPack: 4096,
  maxSourceFiles: 4096,
});

/** Remove the retired provisioning component when the replacement is present. */
export function normalizeEsp32ProvisioningLinkerLibraries(value, label = 'ESP32 browser') {
  if (typeof value !== 'string') throw new TypeError(`${label} ld_libs must be text`);
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  const legacyCount = tokens.filter((token) => token === LEGACY_WIFI_PROVISIONING_LIBRARY).length;
  const currentCount = tokens.filter((token) => token === NETWORK_PROVISIONING_LIBRARY).length;
  if (!legacyCount || !currentCount) return value;
  if (legacyCount !== 1 || currentCount !== 1) {
    throw new Error(`${label} provisioning libraries have an unexpected response-file shape`);
  }
  return `${tokens.filter((token) => token !== LEGACY_WIFI_PROVISIONING_LIBRARY).join(' ')}\n`;
}
const MAX_LIBRARY_PAYLOAD_BYTES = ESP32_BROWSER_LIBRARY_SOURCE_LIMITS.maxPayloadBytes;
const MAX_LIBRARY_FILE_BYTES = ESP32_BROWSER_LIBRARY_SOURCE_LIMITS.maxFileBytes;
const MAX_LIBRARY_TOTAL_SOURCE_BYTES = ESP32_BROWSER_LIBRARY_SOURCE_LIMITS.maxTotalSourceBytes;
const MAX_LIBRARY_FILES = ESP32_BROWSER_LIBRARY_SOURCE_LIMITS.maxFiles;
const MAX_LIBRARY_FILES_PER_PACK = ESP32_BROWSER_LIBRARY_SOURCE_LIMITS.maxFilesPerPack;
const MAX_LIBRARY_SOURCE_FILES = ESP32_BROWSER_LIBRARY_SOURCE_LIMITS.maxSourceFiles;
const MAX_LIBRARY_INCLUDE_DIRS = 64;
const MAX_LIBRARY_PATH_CHARS = 256;
const MAX_RELATIVE_INCLUDE_SEARCH_PATHS = 256;
// A single large library can legitimately need more than 4096 synthetic
// entries when a WASI `..` lookup is mirrored across a dense include graph.
// Keep the shim budget bounded by the per-pack source-file ceiling while
// leaving room for the original files and runtime inputs in the VFS.
const MAX_RELATIVE_INCLUDE_SHIMS = MAX_LIBRARY_FILES_PER_PACK * 2;
// Deep, generated library trees (for example LVGL) can contain hundreds of
// parent-relative includes. Mirroring every no-op lookup creates a cyclic
// synthetic graph; once the graph is dense, rewrite resolvable Pack-local
// includes to their canonical VFS path instead.
// Compact any resolvable parent include before generating synthetic paths.
// Action-local include graphs are often smaller than the old 64/128 heuristic
// even when a large Pack contains thousands of files overall.
const COMPACT_RELATIVE_INCLUDE_REACHABLE_THRESHOLD = 1;
const COMPACT_RELATIVE_INCLUDE_COUNT_THRESHOLD = 1;
const RELATIVE_INCLUDE_ALIAS_ROOT = '__ck_resolved_parent__';
const LIBRARY_VFS_ROOT_SEGMENTS = 2;
const SAFE_LIBRARY_ARCHITECTURE = /^(?:\*|[a-z][a-z0-9._-]{0,31})$/;
// Header implementation fragments are transported as include-only files.
// They pass path validation but are intentionally absent from
// LIBRARY_SOURCE_EXTENSION, so the executor never compiles them directly.
const SAFE_LIBRARY_EXTENSION = /\.(?:c|cc|cpp|cxx|S|h|hh|hpp|hxx|inc|ipp|tpp)$/;
const RELATIVE_INCLUDE = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;
const REACHABLE_INCLUDE = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/gm;
const MAX_VFS_PARENT_INCLUDE_ALIASES = 2048;
const VFS_PARENT_INCLUDE = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/gm;
const LIBRARY_SOURCE_EXTENSION = /\.(?:c|cc|cpp|cxx|S)$/;
const MAX_DIAGNOSTICS = 128;
const MAX_DIAGNOSTIC_CHARS = 8 * 1024;
const MAX_ELF_SECTION_COUNT = 4096;
const ELF_SECTION_HEADER_BYTES = 40;
const ELF_NOBITS_SECTION = 8;
const C3_FLASH_TOTAL_BYTES = 1_310_720;
const C3_RAM_TOTAL_BYTES = 327_680;
const FLASH_MEMORY_SECTIONS = Object.freeze([
  '.iram0.text', '.iram0.vectors', '.dram0.data', '.dram1.data',
  '.flash.text', '.flash.rodata', '.flash.appdesc', '.flash.init_array', '.eh_frame',
]);
const RAM_MEMORY_SECTIONS = Object.freeze([
  '.dram0.data', '.dram0.bss', '.dram1.data', '.dram1.bss', '.noinit',
]);
const COMPILE_SOURCE = 'sketch.cpp';
const COMPILE_OBJECT = 'sketch.o';
const LINK_ELF = 'firmware.elf';
const COMPILER_TARGETS = Object.freeze({
  c3: Object.freeze({
    label: 'ESP32-C3', board: ESP32_C3_BOARD, sdkTarget: 'esp32c3',
    createPackLoaders: createEsp32C3RuntimePackLoaders,
  }),
  c5: Object.freeze({
    label: 'ESP32-C5', board: ESP32_C5_BOARD, sdkTarget: 'esp32c5',
    createPackLoaders: createEsp32C5RuntimePackLoaders,
  }),
  c6: Object.freeze({
    label: 'ESP32-C6', board: ESP32_C6_BOARD, sdkTarget: 'esp32c6',
    createPackLoaders: createEsp32C6RuntimePackLoaders,
  }),
  h2: Object.freeze({
    label: 'ESP32-H2', board: ESP32_H2_BOARD, sdkTarget: 'esp32h2',
    createPackLoaders: createEsp32H2RuntimePackLoaders,
  }),
  p4: Object.freeze({
    label: 'ESP32-P4', board: ESP32_P4_BOARD, sdkTarget: 'esp32p4_es',
    createPackLoaders: createEsp32P4RuntimePackLoaders,
  }),
  esp32: Object.freeze({
    label: 'ESP32', board: ESP32_BOARD, sdkTarget: 'esp32',
    createPackLoaders: createEsp32RuntimePackLoaders,
  }),
  s2: Object.freeze({
    label: 'ESP32-S2', board: ESP32_S2_BOARD, sdkTarget: 'esp32s2',
    createPackLoaders: createEsp32S2RuntimePackLoaders,
  }),
  s3: Object.freeze({
    label: 'ESP32-S3', board: ESP32_S3_BOARD, sdkTarget: 'esp32s3',
    createPackLoaders: createEsp32S3RuntimePackLoaders,
  }),
});

/** Validate the small, release-pinned SDK profile before using its arguments. */
export function validateEsp32C3SdkProfile(value) {
  return validateEsp32SdkProfileForTarget(value, COMPILER_TARGETS.c3);
}

export function validateEsp32C6SdkProfile(value) {
  return validateEsp32SdkProfileForTarget(value, COMPILER_TARGETS.c6);
}

export function validateEsp32C5SdkProfile(value) {
  return validateEsp32SdkProfileForTarget(value, COMPILER_TARGETS.c5);
}

export function validateEsp32H2SdkProfile(value) {
  return validateEsp32SdkProfileForTarget(value, COMPILER_TARGETS.h2);
}

export function validateEsp32P4SdkProfile(value) {
  return validateEsp32SdkProfileForTarget(value, COMPILER_TARGETS.p4);
}

export function validateEsp32SdkProfile(value) {
  return validateEsp32SdkProfileForTarget(value, COMPILER_TARGETS.esp32);
}

export function validateEsp32C3LibrarySourcePayload(value, selection) {
  return validateBrowserLibrarySourcePayload(value, selection, COMPILER_TARGETS.c3.label);
}

export function validateEsp32S2SdkProfile(value) {
  return validateEsp32SdkProfileForTarget(value, COMPILER_TARGETS.s2);
}

export function validateEsp32S3SdkProfile(value) {
  return validateEsp32SdkProfileForTarget(value, COMPILER_TARGETS.s3);
}

/** Load the verified CK Pack metadata and source payloads needed by the shared planner. */
export async function loadEsp32BrowserBuildPlanning({
  descriptor,
  descriptorUrl,
  libraries = [],
  createPackLoader,
  publishedPlatformManifest,
} = {}) {
  if (typeof createPackLoader !== 'function') {
    throw new TypeError('ESP32 browser planning Pack loader factory is required');
  }
  const target = Object.values(COMPILER_TARGETS).find((candidate) => candidate.board === descriptor?.board);
  if (!target) throw new TypeError('ESP32 browser planning target is unsupported');
  const loaders = target.createPackLoaders({ descriptor, descriptorUrl, createPackLoader });
  try {
    const boardAssets = loaders.board;
    if (!boardAssets) throw new TypeError(`${target.label} Board Pack loader is unavailable`);
    const [compilerManifest, sdkManifest, boardAssetManifest, runtimeProfile, loadedLibraries] = await Promise.all([
      loaders.compiler.loadManifest(),
      loaders.sdk.loadManifest(),
      boardAssets.loadManifest(),
      loadRuntimeProfile(loaders, target),
      libraries.length ? loadBrowserLibraries(libraries, createPackLoader, target.label) : [],
    ]);
    const platformManifest = await bindPlatformCompilerRequirement(
      runtimeProfile,
      descriptor,
      compilerManifest,
      target,
      publishedPlatformManifest,
    );
    const selectionByName = new Map(libraries.map((selection) => [selection.name.toLowerCase(), selection]));
    const librarySources = loadedLibraries.map((library) => {
      const selection = selectionByName.get(library.name.toLowerCase());
      if (!selection || selection.version !== library.version) {
        throw new TypeError(`ESP32 browser planning Library Pack identity mismatch: ${library.name}`);
      }
      const prefix = `${library.root}/`;
      return Object.freeze({
        packId: selection.packId,
        name: library.name,
        version: library.version,
        includeDirs: Object.freeze(library.includePaths.map((path) => {
          if (path === library.root) return '.';
          if (!path.startsWith(prefix)) throw new TypeError(`ESP32 browser planning include path is invalid: ${path}`);
          return path.slice(prefix.length);
        })),
        files: Object.freeze(library.files.map(({ path, content }) => Object.freeze({ path, content }))),
      });
    });
    return Object.freeze({
      compilerManifest,
      sdkManifest,
      boardManifest: boardAssetManifest,
      flashManifest: boardAssetManifest,
      platformManifest,
      librarySources: Object.freeze(librarySources),
    });
  } finally {
    loaders.compiler.reset?.();
    loaders.sdk.reset?.();
    loaders.board?.reset?.();
  }
}

async function bindPlatformCompilerRequirement(
  profile,
  descriptor,
  compilerManifest,
  target,
  publishedPlatformManifest,
) {
  const compilerPacks = Array.isArray(descriptor?.packs)
    ? descriptor.packs.filter((pack) => pack?.role === 'compiler')
    : [];
  if (compilerPacks.length !== 1) fail(`${target.label} descriptor Compiler Pack is invalid`);
  const compilerPack = compilerPacks[0];
  if (!IDENTIFIER.test(compilerPack.id) || !SHA256.test(compilerPack.revision)) {
    fail(`${target.label} descriptor Compiler Pack identity is invalid`);
  }
  if (!isPlainRecord(compilerManifest)
    || compilerManifest.id !== compilerPack.id
    || compilerManifest.revision !== compilerPack.revision
    || typeof compilerManifest.version !== 'string'
    || !VERSION.test(compilerManifest.version)) {
    fail(`${target.label} Compiler Pack Manifest identity is invalid`);
  }
  if (!isPlainRecord(profile?.platformManifest)) {
    fail(`${target.label} standard Platform Manifest is missing`);
  }

  const requirement = {
    id: compilerPack.id,
    version: compilerManifest.version,
    sha256: compilerPack.revision,
  };
  const profileCompiler = profile.sdkVariant?.compilerPack;
  const sdkPack = descriptor.packs.find((pack) => pack?.role === 'sdk');
  if (!sdkPack || profile.sdkVariant?.id !== sdkPack.id
    || profileCompiler?.id !== requirement.id
    || profileCompiler?.version !== requirement.version
    || profileCompiler?.sha256 !== requirement.sha256) {
    fail(`${target.label} execution profile Pack binding is invalid`);
  }
  const embeddedPlatformManifest = await validatePlatformToolRequirement(
    profile.platformManifest,
    requirement,
    target.label,
  );
  let platformManifest = embeddedPlatformManifest;
  if (publishedPlatformManifest !== undefined) {
    platformManifest = await validatePlatformToolRequirement(
      publishedPlatformManifest,
      requirement,
      target.label,
    );
    if (platformManifest.sha256 !== embeddedPlatformManifest.sha256) {
      fail(`${target.label} published Platform Manifest does not match the SDK profile`);
    }
  }
  return Object.freeze({ ...profile, platformManifest });
}

async function validatePlatformToolRequirement(manifest, requirement, label) {
  if (manifest.kind !== 'ck-platform-pack'
    || manifest.schemaVersion !== 2
    || !IDENTIFIER.test(manifest.id)
    || typeof manifest.version !== 'string'
    || !VERSION.test(manifest.version)
    || !SHA256.test(manifest.sha256)
    || !Array.isArray(manifest.boards)
    || !Array.isArray(manifest.tools)) {
    fail(`${label} standard Platform Manifest is invalid`);
  }
  if (!(await validateRecipeLoweringContract(manifest.recipeLowering))) {
    fail(`${label} standard Platform Manifest recipe lowering contract is invalid`);
  }
  const { sha256: sourceSha256, ...sourceWithoutHash } = manifest;
  if (await sha256CanonicalJson(sourceWithoutHash) !== sourceSha256) {
    fail(`${label} standard Platform Manifest hash mismatch`);
  }

  const tools = manifest.tools.map((tool) => normalizePlatformToolRequirement(tool, label));
  if (new Set(tools.map((tool) => tool.id)).size !== tools.length) {
    fail(`${label} standard Platform Manifest tools are duplicated`);
  }
  if (tools.length) fail(`${label} standard Platform Manifest must be tool-neutral`);

  return Object.freeze({
    ...sourceWithoutHash,
    tools: Object.freeze(tools),
    sha256: sourceSha256,
  });
}

function normalizePlatformToolRequirement(value, label) {
  if (!isPlainRecord(value)
    || !IDENTIFIER.test(value.id)
    || typeof value.version !== 'string'
    || !VERSION.test(value.version)
    || !SHA256.test(value.sha256)) {
    fail(`${label} Platform tool requirement is invalid`);
  }
  return Object.freeze({ id: value.id, version: value.version, sha256: value.sha256 });
}

function canonicalPlatformJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalPlatformJson).join(',')}]`;
  if (!isPlainRecord(value)) throw new TypeError('Platform Manifest canonical JSON value is invalid');
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalPlatformJson(value[key])}`)
    .join(',')}}`;
}

async function sha256CanonicalJson(value) {
  return sha256Bytes(new TextEncoder().encode(canonicalPlatformJson(value)));
}

async function sha256Bytes(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function validateRecipeLoweringContract(value) {
  if (!isPlainRecord(value) || value.schemaVersion !== 2 || !SHA256.test(value.sha256)) {
    return false;
  }
  const { sha256, ...body } = value;
  if (await sha256CanonicalJson(body) !== sha256) return false;
  const bindings = value.bindings;
  const paths = value.paths?.logicalToAction;
  const response = value.responseFiles;
  const compatibility = value.compatibility;
  const archive = value.archive;
  const publication = value.publication;
  const compileBindings = bindings?.compile;
  return isPlainRecord(bindings)
    && Object.keys(bindings).length === 3
    && ['compile', 'archive', 'link'].every((key) => Object.hasOwn(bindings, key))
    && isPlainRecord(compileBindings)
    && Object.keys(compileBindings).length === 3
    && ['c', 'cxx', 'asm'].every((key) => (
      Object.hasOwn(compileBindings, key)
      && typeof compileBindings[key] === 'string'
      && compileBindings[key].trim()
    ))
    && ['archive', 'link'].every((key) => typeof bindings[key] === 'string' && bindings[key].trim())
    && isPlainRecord(paths) && isPlainRecord(paths.exact) && isPlainRecord(paths.prefixes)
    && response?.marker === '@' && isPlainRecord(response.roles) && isPlainRecord(response.languageFiles)
    && isPlainRecord(compatibility?.compiler) && isPlainRecord(compatibility?.linker)
    && typeof compatibility.compiler.disableBuiltinCxxIncludes === 'boolean'
    && Array.isArray(compatibility.compiler.runtimeIncludes)
    && Array.isArray(compatibility.linker.searchPaths)
    && Array.isArray(compatibility.linker.responseFiles)
    && ['all', 'none'].includes(compatibility.linker.runtimeLibraryDirectories)
    && Array.isArray(compatibility.linker.forceLldTargetPrefixes)
    && isPlainRecord(archive) && typeof archive.command === 'string' && archive.command
    && typeof archive.operation === 'string' && archive.operation
    && Array.isArray(archive.argumentOrder)
    && archive.argumentOrder.join('\0') === 'operation\0output\0inputs\0flags'
    && isPlainRecord(publication) && Array.isArray(publication.sdkArchiveRewrites);
}

/**
 * Create a stateful Adapter for one CK Build IR action session. The adapter is
 * intentionally data-only at its boundary; host paths and compiler VFS names
 * are translated here, below the BrowserWasmExecutor.
 */
export async function createEsp32BrowserActionExecutor({
  init,
  dependencies = {},
} = {}) {
  const descriptor = init?.descriptor ?? init?.runtime?.descriptor;
  const descriptorUrl = init?.descriptorUrl ?? init?.runtime?.descriptorUrl;
  const route = Object.values(COMPILER_TARGETS).find((candidate) => candidate.board === descriptor?.board);
  if (!route) throw new TypeError('ESP32 browser Action target is unsupported');
  const {
    createPackLoader,
    loadToolchain,
    preprocess,
    buildImage,
  } = dependencies;
  if (typeof createPackLoader !== 'function') throw new TypeError(`${route.label} Action Pack loader is required`);
  if (typeof loadToolchain !== 'function') throw new TypeError(`${route.label} Action toolchain loader is required`);
  if (typeof preprocess !== 'function') throw new TypeError(`${route.label} Action preprocessor is required`);
  if (typeof buildImage !== 'function') throw new TypeError(`${route.label} Action image builder is required`);
  const loaders = route.createPackLoaders({ descriptor, descriptorUrl, createPackLoader });
  const profile = await loadRuntimeProfile(loaders, route);
  const target = executorTarget(route, profile);
  const toolchain = await loadToolchain(loaders.compiler);
  if (typeof toolchain?.runClang !== 'function' || typeof toolchain?.runLLVM !== 'function') {
    throw new TypeError(`${target.label} Action toolchain runtime is invalid`);
  }

  const execute = async (action, inputs = [], onProgress = () => {}) => {
    if (!action || typeof action.kind !== 'string') throw new TypeError('ESP32 browser Action is invalid');
    const emit = (stage, percent, detail) => {
      try { onProgress({ stage, percent, ...(detail ? { detail } : {}) }); } catch { /* advisory */ }
    };
    if (action.kind === 'transform' && action.tool === 'ck:esp32-merge') {
      emit('merging', 92, `${target.label} merged flash image`);
      return mergeEsp32FlashAction(action, inputs, target);
    }
    const inputMap = new Map(inputs.map((input) => [input.path, ownBytes(input.bytes, `Action input ${input.path}`)]));
    if (action.kind === 'transform' && action.tool === 'ck:arduino-preprocess') {
      const sketch = decodeArduinoSketchAction(action, inputMap);
      const processed = preprocess(sketch.source, { sourceName: sketch.sourceName });
      return {
        outputs: [{ path: action.transform.output, bytes: new TextEncoder().encode(processed.cpp) }],
        diagnostics: [],
      };
    }
    if (action.kind === 'transform' && action.tool === 'ck:esp32-image') {
      const input = inputMap.get(action.transform.input);
      if (!input) throw new Error(`image input is missing: ${action.transform.input}`);
      emit('imaging', 85, `${target.label} flash image`);
      const built = await buildImage(input, parseImageFlags(action.transform.flags, target));
      if (!built?.image || !(built.image instanceof Uint8Array) || !built.image.byteLength) {
        throw new Error(`${target.label} image builder returned no firmware image`);
      }
      if (built.elfSha256Embedded !== true || built.elfSha256Offset !== 0xb0) {
        throw runtimeError('image_layout', `${target.label} image does not contain the required ELF SHA-256 descriptor`);
      }
      return {
        outputs: [{ path: action.transform.output, bytes: ownBytes(built.image, `${target.label} firmware`) }],
        diagnostics: [],
      };
    }
    if (action.kind === 'transform' && action.tool === 'platform:gen-esp32part') {
      emit('imaging', 88, `${target.label} partition table`);
      return buildEsp32PartitionAction(action, inputMap, target);
    }
    if (action.kind === 'transform' && action.tool === 'ck:pack-copy') {
      const input = inputMap.get(action.transform.input);
      if (!input) throw new Error(`Pack transform input is missing: ${action.transform.input}`);
      return { outputs: [{ path: action.transform.output, bytes: input }], diagnostics: [] };
    }
    if (action.kind === 'compile') {
      emit('compiling', 35, `${target.label} compile`);
      return compileAction(action, inputMap, profile, loaders, toolchain.runClang, target);
    }
    if (action.kind === 'archive') {
      return archiveAction(action, inputMap, profile, toolchain.runLLVM);
    }
    if (action.kind === 'link') {
      emit('linking', 65, `${target.label} link`);
      return linkAction(action, inputMap, profile, loaders.sdk, toolchain.runClang, target);
    }
    if (action.kind === 'transform') {
      return llvmTransformAction(action, inputMap, toolchain.runLLVM);
    }
    throw new TypeError(`unsupported ESP32 browser Action kind: ${action.kind}`);
  };

  return Object.freeze({
    execute,
    close() {
      loaders.compiler.reset?.();
      loaders.sdk.reset?.();
      loaders.board?.reset?.();
    },
  });
}

async function buildEsp32PartitionAction(action, inputMap, target) {
  const label = `${target.label} partition Action`;
  const transform = action.transform;
  if (!isPlainRecord(transform)
    || transform.input !== 'partitions.csv'
    || transform.output !== 'build/partitions.bin'
    || transform.format !== 'partition'
    || !Array.isArray(transform.flags)
    || transform.flags.length !== 2
    || transform.flags[0] !== '--quiet=true'
    || !isPostLinkContractFlag(transform.flags[1])) {
    throw runtimeError('image_layout', `${label} transform is invalid`);
  }
  if (!Array.isArray(action.arguments)
    || action.arguments.length !== 3
    || action.arguments[0] !== '-q'
    || action.arguments[1] !== transform.input
    || action.arguments[2] !== transform.output) {
    throw runtimeError('image_layout', `${label} arguments are invalid`);
  }
  if (!Array.isArray(action.inputs) || action.inputs.length !== 1
    || !isPlainRecord(action.inputs[0])
    || action.inputs[0].path !== transform.input
    || action.inputs[0].role !== 'partitions-source'
    || typeof action.inputs[0].sha256 !== 'string'
    || !SHA256.test(action.inputs[0].sha256)
    || !Array.isArray(action.outputs) || action.outputs.length !== 1
    || !isPlainRecord(action.outputs[0])
    || action.outputs[0].path !== transform.output
    || typeof action.outputs[0].sha256 !== 'string'
    || !SHA256.test(action.outputs[0].sha256)) {
    throw runtimeError('image_layout', `${label} input/output declaration is invalid`);
  }
  if (!(inputMap instanceof Map) || inputMap.size !== 1) {
    throw runtimeError('image_layout', `${label} runtime input set is invalid`);
  }
  const input = inputMap.get(transform.input);
  if (!(input instanceof Uint8Array) || !input.byteLength) {
    throw runtimeError('image_layout', `${label} input is missing or empty`);
  }
  let actualSha256;
  try {
    actualSha256 = await sha256Bytes(input);
  } catch (error) {
    throw runtimeError('image_layout', `${label} input checksum could not be verified`, error);
  }
  if (actualSha256 !== action.inputs[0].sha256) {
    throw runtimeError('image_layout', `${label} input does not match its immutable SHA-256`);
  }
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch (error) {
    throw runtimeError('image_layout', `${label} input is not valid UTF-8`, error);
  }
  let resolved;
  try {
    resolved = resolveCustomEsp32Partitions(
      [{ name: transform.input, content }],
      { flashSizeBytes: target.flashSizeBytes },
    );
  } catch (error) {
    throw runtimeError('image_layout', `${label} CSV is invalid: ${errorMessage(error)}`, error);
  }
  if (!resolved || resolved.path !== transform.input || !(resolved.bytes instanceof Uint8Array)
    || !resolved.bytes.byteLength) {
    throw runtimeError('image_layout', `${label} codec returned no partition table`);
  }
  if (resolved.tableSha256 !== action.outputs[0].sha256) {
    throw runtimeError('image_layout', `${label} output does not match its planned SHA-256`);
  }
  return {
    outputs: [{
      path: transform.output,
      bytes: ownBytes(resolved.bytes, `${target.label} partition table`),
    }],
    diagnostics: [],
  };
}

function mergeEsp32FlashAction(action, inputs, target) {
  const label = `${target.label} merge Action`;
  const args = action.arguments;
  const espSr16 = Array.isArray(args)
    && args.length === 13 + ESP32_SR_MERGE_SEGMENT_COUNT * 2;
  const segmentCount = espSr16 ? ESP32_SR_MERGE_SEGMENT_COUNT : ESP32_MERGE_SEGMENT_COUNT;
  if (
    !Array.isArray(args)
    || args.length !== 13 + segmentCount * 2
    || args.some((argument) => (
      typeof argument !== 'string'
      || !argument.length
      || argument.length > MAX_COMMAND_ARGUMENT_CHARS
    ))
    || args.reduce((total, argument) => total + argument.length, 0) > MAX_COMMAND_CHARS
  ) throw runtimeError('image_layout', `${label} arguments are invalid`);

  const chip = args[1];
  const outputPath = normalizeEsp32MergePath(args[4], `${label} output`);
  const padSizeText = args[6];
  if (
    args[0] !== '--chip'
    || !/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(chip)
    || args[2] !== 'merge-bin'
    || args[3] !== '-o'
    || args[5] !== '--pad-to-size'
    || args[7] !== '--flash-mode'
    || args[8] !== 'keep'
    || args[9] !== '--flash-freq'
    || args[10] !== 'keep'
    || args[11] !== '--flash-size'
    || args[12] !== 'keep'
  ) throw runtimeError('image_layout', `${label} arguments are invalid`);

  const padSize = parseEsp32MergeSize(padSizeText, label);
  if (espSr16 && (!target.modelArtifact || padSize !== ESP32_SR_FLASH_SIZE_BYTES)) {
    throw runtimeError('image_layout', `${label} esp_sr_16 output must use a 16MB flash image`);
  }
  const resourceLimits = action.resourceLimits;
  if (resourceLimits !== undefined && !isPlainRecord(resourceLimits)) {
    throw runtimeError('image_layout', `${label} resource limits are invalid`);
  }
  let outputLimit = MAX_ESP32_MERGED_IMAGE_BYTES;
  for (const name of ['outputBytes', 'memoryBytes']) {
    const value = resourceLimits?.[name];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw runtimeError('image_layout', `${label} resource limits are invalid`);
    }
    outputLimit = Math.min(outputLimit, value);
  }
  if (padSize > outputLimit) {
    throw runtimeError('image_layout', `${label} output exceeds its byte limit`);
  }

  if (!Array.isArray(action.outputs) || action.outputs.length !== 1
    || action.outputs[0]?.path !== outputPath) {
    throw runtimeError('image_layout', `${label} output path is inconsistent`);
  }
  const transform = action.transform;
  if (!isPlainRecord(transform)
    || transform.output !== outputPath
    || transform.format !== 'bin') {
    throw runtimeError('image_layout', `${label} transform output is inconsistent`);
  }
  const expectedFlags = [
    `--chip=${chip}`,
    `--pad-to-size=${padSizeText}`,
    '--flash-mode=keep',
    '--flash-freq=keep',
    '--flash-size=keep',
  ];
  if (!Array.isArray(transform.flags)
    || transform.flags.length !== expectedFlags.length + 1
    || expectedFlags.some((flag, index) => transform.flags[index] !== flag)
    || !isPostLinkContractFlag(transform.flags[expectedFlags.length])) {
    throw runtimeError('image_layout', `${label} transform flags are inconsistent`);
  }

  if (!Array.isArray(action.inputs) || action.inputs.length !== segmentCount) {
    throw runtimeError('image_layout', `${label} input declaration is invalid`);
  }
  const declaredPaths = [];
  const offsets = new Set();
  const segmentSpecs = [];
  const espSrRoles = [
    'bootloader-image',
    'partitions-image',
    'boot-app0-image',
    'application-image',
    'model-image',
  ];
  for (let index = 0; index < segmentCount; index++) {
    const offsetText = args[13 + index * 2];
    const path = normalizeEsp32MergePath(args[14 + index * 2], `${label} input`);
    if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(offsetText)) {
      throw runtimeError('image_layout', `${label} offset is invalid: ${offsetText}`);
    }
    const offset = Number(BigInt(offsetText));
    if (offset >= padSize) {
      throw runtimeError('image_layout', `${label} offset is outside the flash image: ${offsetText}`);
    }
    if (offsets.has(offset)) {
      throw runtimeError('image_layout', `${label} contains a duplicate offset: ${offsetText}`);
    }
    if (declaredPaths.includes(path) || path === outputPath) {
      throw runtimeError('image_layout', `${label} contains a duplicate or reserved input path: ${path}`);
    }
    offsets.add(offset);
    declaredPaths.push(path);
    segmentSpecs.push({
      offset,
      offsetText,
      path,
      ...(espSr16 ? { role: espSrRoles[index] } : {}),
    });
  }
  const expectedInputByPath = new Map(segmentSpecs.map((segment) => [segment.path, segment]));
  const declaredInputPaths = new Set();
  for (const input of action.inputs) {
    if (!isPlainRecord(input)) {
      throw runtimeError('image_layout', `${label} input declaration is invalid`);
    }
    const path = normalizeEsp32MergePath(input.path, `${label} declared input`);
    const expected = expectedInputByPath.get(path);
    if (!expected || declaredInputPaths.has(path)
      || (espSr16 && (input.role !== expected.role || input.sha256 !== undefined))) {
      throw runtimeError('image_layout', `${label} input declaration is invalid`);
    }
    declaredInputPaths.add(path);
  }
  if (declaredInputPaths.size !== expectedInputByPath.size) {
    throw runtimeError('image_layout', `${label} argument inputs do not match its declared inputs`);
  }
  if (espSr16) {
    const model = segmentSpecs[segmentSpecs.length - 1];
    if (model?.offsetText !== target.modelOffset || model.path !== ESP32_SR_MODEL_PATH) {
      throw runtimeError('image_layout', `${label} esp_sr_16 model segment is invalid`);
    }
  }
  if (transform.input !== declaredPaths[0]) {
    throw runtimeError('image_layout', `${label} primary input is inconsistent`);
  }

  if (!Array.isArray(inputs) || inputs.length !== segmentCount) {
    throw runtimeError('image_layout', `${label} runtime input set is invalid`);
  }
  const declaredPathSet = new Set(declaredPaths);
  const runtimeInputs = new Map();
  for (const input of inputs) {
    const path = normalizeEsp32MergePath(input?.path, `${label} runtime input`);
    if (!declaredPathSet.has(path) || runtimeInputs.has(path)
      || !(input.bytes instanceof Uint8Array) || !input.bytes.byteLength) {
      throw runtimeError('image_layout', `${label} runtime input set is invalid`);
    }
    runtimeInputs.set(path, input.bytes);
  }

  const segments = segmentSpecs.map((segment) => {
    const bytes = runtimeInputs.get(segment.path);
    const end = segment.offset + bytes.byteLength;
    if (espSr16 && segment.path === ESP32_SR_MODEL_PATH
      && bytes.byteLength > target.modelCapacityBytes) {
      throw runtimeError('image_layout', `${label} model exceeds the esp_sr_16 allocation`);
    }
    if (bytes.byteLength > MAX_ESP32_MERGED_IMAGE_BYTES || end > padSize) {
      throw runtimeError(
        'image_layout',
        `${label} segment exceeds the flash image: ${segment.offsetText} ${segment.path}`,
      );
    }
    return { ...segment, bytes, end };
  }).sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < segments.length; index++) {
    if (segments[index].offset < segments[index - 1].end) {
      throw runtimeError('image_layout', `${label} segments overlap`);
    }
  }
  if (espSr16) {
    const modelEnd = target.modelOffsetBytes + target.modelCapacityBytes;
    if (modelEnd > padSize || segments.some((segment) => (
      segment.path !== ESP32_SR_MODEL_PATH
      && segment.offset < modelEnd
      && segment.end > target.modelOffsetBytes
    ))) {
      throw runtimeError('image_layout', `${label} segments overlap the esp_sr_16 model allocation`);
    }
  }

  const merged = new Uint8Array(padSize);
  merged.fill(0xff);
  for (const segment of segments) merged.set(segment.bytes, segment.offset);
  return { outputs: [{ path: outputPath, bytes: merged }], diagnostics: [] };
}

function parseEsp32MergeSize(value, label) {
  const match = typeof value === 'string' && /^(\d+)(B|KB|K|MB|M)$/i.exec(value);
  if (!match) throw runtimeError('image_layout', `${label} pad size is invalid`);
  const amount = BigInt(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = unit === 'B' ? 1n : unit === 'K' || unit === 'KB' ? 1024n : 1024n * 1024n;
  const bytes = amount * multiplier;
  if (bytes <= 0n || bytes > BigInt(MAX_ESP32_MERGED_IMAGE_BYTES)) {
    throw runtimeError('image_layout', `${label} pad size exceeds its byte limit`);
  }
  return Number(bytes);
}

function normalizeEsp32MergePath(value, label) {
  if (typeof value !== 'string' || !value.length || value.length > 256
    || value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) {
    throw runtimeError('image_layout', `${label} path is invalid`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => (
    !SAFE_VFS_SEGMENT.test(segment)
    || segment === '.'
    || segment === '..'
    || RESERVED_VFS_SEGMENTS.has(segment)
  ))) throw runtimeError('image_layout', `${label} path is invalid`);
  return value;
}

function executorTarget(route, profile) {
  const execution = profile?.execution;
  const offsets = profile?.flash?.offsets;
  if (!execution || !offsets) fail(`${route.label} execution profile is incomplete`);
  const flashSizeBytes = parseEsp32MergeSize(profile.image?.flashSize, `${route.label} flash size`);
  const model = validateEspSrModelProfile(profile.flash.model, route.label, false);
  if (model && route.board !== ESP32_S3_BOARD) fail(`${route.label} model profile is not supported`);
  return Object.freeze({
    label: route.label,
    board: route.board,
    sdkTarget: route.sdkTarget,
    elfMachine: execution.elf.machine,
    elfFloatAbi: execution.elf.floatAbi,
    flashOffsets: offsets,
    flashSizeBytes,
    ...(model ? {
      modelArtifact: model.artifactId,
      modelOffset: model.offset,
      modelOffsetBytes: Number(BigInt(model.offset)),
      modelCapacityBytes: model.capacity,
    } : {}),
  });
}

function validateEsp32SdkProfileForTarget(value, target) {
  const profileKeys = ['schema', 'id', 'board', 'sdkVersion', 'options', 'compile', 'link', 'image', 'flash'];
  if (isPlainRecord(value) && Object.hasOwn(value, 'platformManifest')) profileKeys.push('platformManifest');
  if (isPlainRecord(value) && Object.hasOwn(value, 'boardPack')) profileKeys.push('boardPack');
  if (isPlainRecord(value) && Object.hasOwn(value, 'execution')) profileKeys.push('execution');
  const profile = exactRecord(value, `${target.label} SDK profile`, profileKeys);
  if (profile.schema !== ESP32_C3_SDK_PROFILE_SCHEMA) {
    fail(`unsupported ${target.label} SDK profile schema`);
  }
  if (typeof profile.id !== 'string' || !IDENTIFIER.test(profile.id)) {
    fail(`${target.label} SDK profile id is invalid`);
  }
  if (profile.board !== target.board) fail(`${target.label} SDK profile targets an unexpected board`);
  if (typeof profile.sdkVersion !== 'string' || !VERSION.test(profile.sdkVersion)) {
    fail(`${target.label} SDK version is invalid`);
  }

  const options = validateProfileOptions(profile.options, target.label);
  const espSr16 = options.partition_scheme === ESP32_SR_PARTITION_SCHEME;
  const compile = validateCommandProfile(profile.compile, 'compile', {
    source: COMPILE_SOURCE,
    object: COMPILE_OBJECT,
  }, target.label);
  const link = validateCommandProfile(profile.link, 'link', {
    object: COMPILE_OBJECT,
    elf: LINK_ELF,
  }, target.label);
  const execution = validateCompilerExecution(
    profile.execution ?? inferCompilerExecution(compile.args, link.args, target.label),
    target.label,
  );
  assertRequiredArguments(compile.args, [...execution.targetArguments, '-c', compile.source], 'compile', target.label);
  assertOutputArgument(compile.args, compile.object, 'compile', target.label);
  assertRequiredArguments(link.args, [...execution.targetArguments, '-nostdlib', link.object], 'link', target.label);
  assertOutputArgument(link.args, link.elf, 'link', target.label);
  const boardPack = profile.boardPack === undefined
    ? undefined
    : validateBoardPackProfile(profile.boardPack, target.label);

  const image = exactRecord(profile.image, `${target.label} image profile`, [
    'flashMode', 'flashFrequency', 'flashSize',
  ]);
  if (Object.values(image).some((entry) => typeof entry !== 'string' || !entry || entry.length > 64)) {
    fail(`${target.label} image profile is invalid`);
  }
  if (espSr16 && (options.flash_size !== ESP32_SR_FLASH_SIZE
    || image.flashSize !== ESP32_SR_FLASH_SIZE)) {
    fail(`${target.label} esp_sr_16 requires a 16MB flash profile`);
  }

  const flashKeys = ['bootloader', 'partitions', 'bootApp0'];
  if (isPlainRecord(profile.flash) && Object.hasOwn(profile.flash, 'model')) flashKeys.push('model');
  if (espSr16 || (isPlainRecord(profile.flash) && Object.hasOwn(profile.flash, 'offsets'))) {
    flashKeys.push('offsets');
  }
  const flash = exactRecord(profile.flash, `${target.label} flash profile`, flashKeys);
  const model = validateEspSrModelProfile(flash.model, target.label, espSr16);
  if (model && target.board !== ESP32_S3_BOARD) fail(`${target.label} model profile is not supported`);
  const flashIds = [
    flash.bootloader,
    flash.partitions,
    flash.bootApp0,
    ...(model ? [model.artifactId] : []),
  ];
  if (flashIds.some((id) => typeof id !== 'string' || !IDENTIFIER.test(id))) {
    fail(`${target.label} flash artifact id is invalid`);
  }
  if (new Set(flashIds).size !== flashIds.length) fail(`${target.label} flash artifact ids are duplicated`);
  const flashOffsets = flash.offsets === undefined
    ? undefined
    : validateFlashOffsets(flash.offsets, target.label);

  return Object.freeze({
    schema: ESP32_C3_SDK_PROFILE_SCHEMA,
    id: profile.id,
    board: target.board,
    sdkVersion: profile.sdkVersion,
    options,
    compile,
    link,
    image: Object.freeze({
      flashMode: image.flashMode,
      flashFrequency: image.flashFrequency,
      flashSize: image.flashSize,
    }),
    flash: Object.freeze({
      bootloader: flash.bootloader,
      partitions: flash.partitions,
      bootApp0: flash.bootApp0,
      ...(model ? { model } : {}),
      ...(flashOffsets === undefined ? {} : { offsets: flashOffsets }),
    }),
    execution,
    ...(boardPack === undefined ? {} : { boardPack }),
    ...(profile.platformManifest === undefined ? {} : { platformManifest: profile.platformManifest }),
  });
}

function validateBoardPackProfile(value, label) {
  const board = exactRecord(value, `${label} Board Pack profile`, ['artifactIds']);
  return Object.freeze({ artifactIds: validateArtifactIds(board.artifactIds, 'board', label) });
}


async function compileAction(action, inputMap, profile, loaders, runClang, target) {
  const files = await materializeCompileVfs(profile, loaders, target.label);
  addActionInputs(files, action, inputMap, profile, 'compile');
  const diagnosticFiles = compileActionDiagnosticFiles(action, inputMap, profile);
  const diagnosticDefaultName = compileActionDiagnosticDefault(action, diagnosticFiles);
  const arguments_ = action.arguments.map((argument) => translateActionArgument(argument, action, profile, 'compile'));
  const relativeIncludes = relativeIncludeSearchPaths(files, action, inputMap);
  let executionMutated = relativeIncludes.mutated;
  for (const path of relativeIncludes.paths) {
    // These roots only compensate for quoted relative-include behavior in
    // the WASI filesystem. Keep them out of angle-bracket lookup so private
    // library headers cannot shadow SDK or C/C++ standard headers.
    const argument = `-iquote${path}`;
    if (!arguments_.includes(argument)) {
      arguments_.push(argument);
      executionMutated = true;
    }
  }
  const args = [compilerCommand(action.tool), ...arguments_];
  const sourceName = action.compileUnit.source;
  let invocation = await invokeRunClang({
    runClang,
    args,
    files,
    environment: action.environment,
    phase: 'compile',
    label: target.label,
    sourceName,
    diagnosticFiles,
    diagnosticDefaultName,
  });
  // Some Xtensa LLVM builds can fail instruction selection while optimizing
  // otherwise valid C/C++ input. Retry that backend-only failure at -O0, but
  // never cache output produced by arguments absent from the keyed Action.
  // Ordinary compiler diagnostics are never retried.
  if (target.elfMachine === 94 && isXtensaInstructionSelectionFailure(invocation.failure)) {
    executionMutated = true;
    invocation = await invokeRunClang({
      runClang,
      args: withXtensaBackendFallback(args),
      files,
      environment: action.environment,
      phase: 'compile retry',
      label: target.label,
      sourceName,
      diagnosticFiles,
      diagnosticDefaultName,
    });
  }
  if (invocation.failure) throw actionCompileError(invocation.failure, invocation.diagnostics);
  const outputPath = action.outputs[0]?.path;
  if (!outputPath) throw new Error(`compile Action ${action.id} has no output`);
  const bytes = treeBinaryFile(
    invocation.output,
    translateActionPath(outputPath, action, profile, 'compile'),
    `${target.label} compiler object`,
  );
  assertEsp32Elf(bytes, 1, target, `${target.label} compiler object`);
  return {
    outputs: [{ path: outputPath, bytes }],
    diagnostics: invocation.diagnostics,
    ...(executionMutated ? { cacheable: false } : {}),
  };
}

function compileActionDiagnosticFiles(action, inputMap, profile) {
  const decoder = new TextDecoder();
  const files = [];
  for (const input of action.inputs ?? []) {
    const projectSource = input.role === 'project-file'
      || input.role === 'project-header'
      || input.role === 'sketch-main'
      || input.role === 'sketch-tab'
      || (input.role === 'source' && !input.path.startsWith('packs/'));
    const bytes = projectSource ? inputMap.get(input.path) : undefined;
    if (!(bytes instanceof Uint8Array)) continue;
    const source = decoder.decode(bytes).replace(/\r\n?/g, '\n');
    const translated = translateInputPath(input.path, action, profile, 'compile');
    files.push({
      name: input.path,
      sourceLineCount: source.split('\n').length,
      regularPaths: [...new Set([input.path, translated])],
      unmappedPaths: [],
    });
  }
  return files;
}

function compileActionDiagnosticDefault(action, diagnosticFiles) {
  const source = action.compileUnit?.source;
  const generatedStem = typeof source === 'string' && source.includes('/generated/')
    ? basename(source).replace(/\.cpp$/i, '')
    : null;
  const sketch = generatedStem === null ? undefined : diagnosticFiles.find((file) => (
    /\.ino$/i.test(file.name)
    && basename(file.name).replace(/\.ino$/i, '') === generatedStem
  ));
  return sketch?.name ?? source;
}

function isXtensaInstructionSelectionFailure(message) {
  return typeof message === 'string'
    && /(?:error in backend:\s*)?(?:Cannot select:|.*Cannot scavenge register without an emergency spill slot!)/i.test(message);
}

function withCompileOptimization(args, optimization) {
  const result = args.filter((argument) => !/^-O(?:[0-3sz]|fast|g)$/.test(argument));
  const compile = result.indexOf('-c');
  result.splice(compile < 0 ? result.length : compile, 0, optimization);
  return result;
}

function withXtensaBackendFallback(args) {
  const result = withCompileOptimization(args, '-O0');
  const compile = result.indexOf('-c');
  result.splice(
    compile < 0 ? result.length : compile,
    0,
    '-mtext-section-literals',
  );
  return result;
}

async function materializeCompileVfs(profile, loaders, label) {
  const files = await materializeEsp32PackArtifactTrees(profile.compile.artifactIds, loaders.sdk, label);
  if (!profile.boardPack) return files;
  if (!loaders.board) throw new Error(`${label} Board Pack loader is unavailable`);
  const boardFiles = await materializeEsp32PackArtifactTrees(profile.boardPack.artifactIds, loaders.board, label);
  mergeVfsTree(files, boardFiles, label);
  return files;
}

function mergeVfsTree(target, source, label, prefix = '') {
  for (const [name, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (value instanceof Uint8Array || typeof value === 'string') {
      const existing = treeFile(target, path);
      if (existing !== undefined) throw new Error(`${label} Board Pack VFS path conflicts with SDK: ${path}`);
      putTreeFile(target, path, value);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label} Board Pack VFS tree is invalid: ${path}`);
    }
    mergeVfsTree(target, value, label, path);
  }
}

async function archiveAction(action, inputMap, profile, runLLVM) {
  const files = {};
  addActionInputs(files, action, inputMap, profile, 'archive');
  const capture = compilerOutputCapture();
  const contract = profile?.platformManifest?.recipeLowering;
  if (!contract) throw new TypeError(`archive Action ${action.id} is missing its Manifest lowering contract`);
  const arguments_ = lowerArchiveArguments(action, contract, profile);
  const output = await runLLVM([contract.archive.command, ...arguments_], files, {
    stdout: (bytes) => capture.push(bytes), stderr: (bytes) => capture.push(bytes),
    environment: action.environment ?? {},
  });
  const outputPath = action.outputs[0]?.path;
  if (!outputPath) throw new Error(`archive Action ${action.id} has no output`);
  const bytes = treeBinaryFile(output, outputPath, `archive ${action.id}`);
  return { outputs: [{ path: outputPath, bytes }], diagnostics: parseEsp32C3CompilerDiagnostics(capture.text(), undefined, outputPath) };
}

function lowerArchiveArguments(action, contract, profile) {
  if (!action.archive || !Array.isArray(action.archive.objects)
    || typeof action.archive.output !== 'string' || !Array.isArray(action.archive.flags)) {
    throw new TypeError(`archive Action ${action.id} does not contain its declared archive spec`);
  }
  const values = {
    operation: [contract.archive.operation],
    output: [translateActionPath(action.archive.output, action, profile, 'archive')],
    inputs: action.archive.objects.map((path) => translateActionPath(path, action, profile, 'archive')),
    flags: action.archive.flags.map((flag) => translateActionPath(flag, action, profile, 'archive')),
  };
  const arguments_ = contract.archive.argumentOrder.flatMap((part) => values[part] ?? []);
  const declared = action.arguments.map((argument) => translateActionPath(argument, action, profile, 'archive'));
  if (declared.length !== arguments_.length || declared.some((value, index) => value !== arguments_[index])) {
    throw new TypeError(`archive Action ${action.id} arguments do not match the Manifest archive contract`);
  }
  return arguments_;
}

async function linkAction(action, inputMap, profile, sdkLoader, runClang, target) {
  const files = await materializeEsp32PackArtifactTrees(profile.link.artifactIds, sdkLoader, target.label);
  addActionInputs(files, action, inputMap, profile, 'link');
  applyEsp32ProvisioningLinkerCompatibility(files, target.label);
  const args = [compilerCommand(action.tool), ...action.arguments.map((argument) => translateActionArgument(argument, action, profile, 'link'))];
  const invocation = await invokeRunClang({
    runClang,
    args,
    files,
    environment: action.environment,
    phase: 'link',
    label: target.label,
    sourceName: 'main.ino',
    diagnosticDefaultName: 'main.ino',
  });
  if (invocation.failure) throw actionCompileError(invocation.failure, invocation.diagnostics);
  const outputPath = action.outputs[0]?.path;
  if (!outputPath) throw new Error(`link Action ${action.id} has no output`);
  const bytes = treeBinaryFile(invocation.output, translateActionPath(outputPath, action, profile, 'link'), `${target.label} linked ELF`);
  assertEsp32Elf(bytes, 2, target, `${target.label} linked ELF`);
  return { outputs: [{ path: outputPath, bytes }], diagnostics: invocation.diagnostics };
}

function applyEsp32ProvisioningLinkerCompatibility(files, label) {
  const path = 'sdk/flags/ld_libs';
  const bytes = treeFile(files, path);
  if (bytes === undefined) return;
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`${label} linker response file is invalid: ${path}`);
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw runtimeError('compiler_runtime', `${label} linker response file is not valid UTF-8`, error);
  }
  const compatible = normalizeEsp32ProvisioningLinkerLibraries(source, label);
  if (compatible === source) return;
  deleteTreeFile(files, path);
  putTreeFile(files, path, new TextEncoder().encode(compatible));
}

async function llvmTransformAction(action, inputMap, runLLVM) {
  const inputPath = action.transform.input;
  const outputPath = action.transform.output;
  const files = {};
  addActionInputs(files, action, inputMap, null, 'transform');
  const args = ['objcopy', ...action.arguments.map((argument) => translateActionPath(argument, action, null, 'transform'))];
  const output = await runLLVM(args, files, { environment: action.environment ?? {} });
  return {
    outputs: [{ path: outputPath, bytes: treeBinaryFile(output, outputPath, `transform ${inputPath}`) }],
    diagnostics: [],
  };
}

function addActionInputs(files, action, inputMap, profile, phase) {
  for (const input of action.inputs ?? []) {
    const bytes = inputMap.get(input.path);
    if (!bytes) continue;
    const path = translateInputPath(input.path, action, profile, phase);
    const existing = treeFile(files, path);
    if (existing !== undefined) {
      if (existing instanceof Uint8Array && equalByteArrays(existing, bytes)) continue;
      throw new Error(`ESP32-C3 VFS input conflicts with an existing file: ${path}`);
    }
    putTreeFile(files, path, bytes);
  }
}

function equalByteArrays(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function compilerCommand(tool) {
  return typeof tool === 'string' && tool.endsWith(':clang') ? 'clang' : 'clang++';
}

function translateActionArgument(argument, action, profile, phase) {
  if (typeof argument !== 'string') return argument;
  if (argument.startsWith('@')) return `@${translateActionPath(argument.slice(1), action, profile, phase)}`;
  const joined = argument.match(/^(-[IL])(.+)$/);
  if (joined) return `${joined[1]}${translateActionPath(joined[2], action, profile, phase)}`;
  // Compiler options are opaque argv values, not filesystem paths. In
  // particular, a macro such as -DLV_CONF_PATH="lv_conf.h" must not be
  // rewritten to project/-D... merely because its value ends in .h.
  if (argument.startsWith('-')) return argument;
  return translateActionPath(argument, action, profile, phase);
}

function translateActionPath(path, action, profile, phase) {
  if (typeof path !== 'string') return path;
  if (path.startsWith('packs/libraries/')) return libraryVfsPath(path);
  if (path === 'libraries' || path.startsWith('libraries/')) return 'project/' + path;
  if (profile?.executorPathLayout) {
    path = resolvePlatformLogicalPath(path, profile.executorPathLayout);
  }
  if (phase === 'compile' && action?.compileUnit?.source === path && profile) {
    return path.includes('/generated/') ? profile.compile.source : `project/${path}`;
  }
  if (phase === 'compile' && !path.includes('/') && /\.(?:c|cc|cpp|cxx|S|h|hh|hpp|hxx)$/.test(path)) {
    return `project/${path}`;
  }
  return path;
}

function translateInputPath(path, action, profile, phase) {
  if (phase === 'compile' && action?.compileUnit?.source === path && profile && !path.startsWith('packs/')) {
    return path.includes('/generated/') ? profile.compile.source : `project/${path}`;
  }
  if (phase === 'compile' && !path.startsWith('packs/')) {
    const role = action?.inputs?.find((input) => input?.path === path)?.role;
    if (role === 'project-header' || role === 'project-file') return `project/${path}`;
  }
  return translateActionPath(path, action, profile, phase);
}

function libraryVfsPath(path) {
  const match = path.match(/^packs\/libraries\/([^/]+)(?:\/(.*))?$/);
  if (!match) return path;
  return match[2] === undefined ? `libraries/${match[1]}` : `libraries/${match[1]}/${match[2]}`;
}

// YoWASP's in-memory WASI filesystem treats `..` as a no-op. Add the exact
// include roots needed to preserve normal compiler lookup semantics for
// verified library inputs that contain parent-relative includes.
function relativeIncludeSearchPaths(files, action, inputMap) {
  const runtimeInputs = new Map();
  const projectInputs = new Map();
  for (const input of action.inputs ?? []) {
    const bytes = inputMap.get(input.path);
    if (!bytes) continue;
    if (input.path.startsWith('packs/libraries/')) {
      runtimeInputs.set(libraryVfsPath(input.path), bytes);
    } else if (input.role === 'project-header') {
      projectInputs.set(input.path.replaceAll('\\', '/'), bytes);
    }
  }
  const paths = new Set();
  const aliasTargets = new Set();
  const reachablePaths = reachableRuntimeInputPaths(runtimeInputs, action, inputMap);
  let shims = mirrorQuotedProjectHeaders(files, runtimeInputs, reachablePaths, projectInputs);
  let mutated = shims > 0;
  // YoWASP does not always anchor a quoted include at the including file's
  // directory. Canonicalise Pack-local quoted includes through the isolated
  // `libraries` namespace instead of adding every private source directory as
  // a global -iquote root. A private `esp_assert.h`, `stdint.h`, etc. can then
  // never shadow an SDK or toolchain header included by basename.
  if (canonicalizePackLocalQuotedIncludes(files, runtimeInputs, reachablePaths)) {
    paths.add('libraries');
    mutated = true;
  }
  // Resolve same-name wrappers before general compaction. Otherwise a file
  // such as src/lvgl.h including ../lvgl.h is shortened to "lvgl.h" and the
  // WASI no-op parent lookup reopens the wrapper itself.
  normalizeConflictingParentIncludes(files, runtimeInputs, reachablePaths, aliasTargets);
  if (aliasTargets.size) mutated = true;
  if (compactResolvableParentIncludes(files, runtimeInputs, reachablePaths, paths)) mutated = true;
  if (paths.size > MAX_RELATIVE_INCLUDE_SEARCH_PATHS) {
    throw new Error('ESP32 browser library relative include path limit exceeded');
  }
  if (aliasTargets.size) {
    paths.add(RELATIVE_INCLUDE_ALIAS_ROOT);
    if (reachablePaths.size > MAX_RELATIVE_INCLUDE_SHIMS) {
      throw new Error('ESP32 browser library relative include alias limit exceeded');
    }
    // Preserve normal quoted-include lookup after entering an alias. Mirroring
    // only the collision target would strand its sibling headers under the
    // synthetic prefix, so copy the bounded include graph reachable from this
    // compile unit with its original directory structure.
    for (const path of reachablePaths) {
      const bytes = runtimeInputs.get(path);
      if (!bytes) continue;
      if (putRelativeIncludeShim(files, `${RELATIVE_INCLUDE_ALIAS_ROOT}/${path}`, bytes)) mutated = true;
    }
  }
  for (const path of reachablePaths) {
    const bytes = runtimeInputs.get(path);
    if (!bytes) continue;
    if (!SAFE_LIBRARY_EXTENSION.test(path)) continue;
    const source = new TextDecoder().decode(bytes);
    RELATIVE_INCLUDE.lastIndex = 0;
    for (let match = RELATIVE_INCLUDE.exec(source); match; match = RELATIVE_INCLUDE.exec(source)) {
      const include = match[1].trim().replaceAll('\\', '/');
      const includeSegments = include.split('/');
      if (!includeSegments.includes('..')) continue;
      if (
        !include
        || include.startsWith('/')
        || include.includes('\0')
        || includeSegments.some((segment) => !segment)
      ) continue;
      const base = path.split('/').slice(0, -1);
      const target = [...base];
      for (const segment of includeSegments) {
        if (segment === '.') continue;
        if (segment === '..') {
          if (target.length <= LIBRARY_VFS_ROOT_SEGMENTS) {
            target.length = 0;
            break;
          }
          target.pop();
        } else target.push(segment);
      }
      const suffix = includeSegments.filter((segment) => segment !== '.' && segment !== '..');
      if (!suffix.length) continue;
      const parentDepth = includeSegments.filter((segment) => segment === '..').length;
      if (!target.length) {
        const targetBytes = uniqueProjectRelativeInput(projectInputs, suffix.join('/'));
        if (!targetBytes || !parentDepth) continue;
        const shimBase = '__ck_project_relative__';
        const shimRoot = `${shimBase}/${Array(parentDepth).fill('__ck_parent__').join('/')}`;
        if (putRelativeIncludeShim(files, `${shimBase}/${suffix.join('/')}`, targetBytes)) mutated = true;
        if (putRelativeIncludeShim(files, `${shimRoot}/${suffix.join('/')}`, targetBytes)) mutated = true;
        paths.add(shimRoot);
        if (paths.size > MAX_RELATIVE_INCLUDE_SEARCH_PATHS) {
          throw new Error('ESP32 browser library relative include path limit exceeded');
        }
        continue;
      }
      const targetPath = target.join('/');
      const targetBytes = runtimeInputs.get(targetPath);
      if (!targetBytes) continue;
      // normalizeConflictingParentIncludes already rewrites collisions where
      // the no-op path names a different real file.  Do not mirror that same
      // target again at every synthetic parent depth; the VFS now contains
      // the canonical include spelling and the original Pack bytes remain
      // untouched.
      const normalizedParentInclude = aliasTargets.has(targetPath);
      // When the WASI filesystem treats `..` as a no-op, a quoted include can
      // be looked up relative to the source directory before the compiler
      // considers its -I roots. Mirror the canonical target at that no-op
      // path when the Pack does not already contain a file there. Existing
      // files are handled by normalizeConflictingParentIncludes above.
      const noOpPath = [...base, ...suffix].join('/');
      if (!normalizedParentInclude && parentDepth > 1 && noOpPath !== targetPath && !runtimeInputs.has(noOpPath)) {
        const inserted = putRelativeIncludeShim(files, noOpPath, targetBytes);
        const nextIncludeOffset = RELATIVE_INCLUDE.lastIndex;
        const mirrored = mirrorNoOpIncludeGraph(files, runtimeInputs, targetPath, noOpPath);
        shims += mirrored;
        RELATIVE_INCLUDE.lastIndex = nextIncludeOffset;
        if (inserted) shims++;
        if (inserted || mirrored) mutated = true;
        if (shims > MAX_RELATIVE_INCLUDE_SHIMS) {
          throw new Error(`ESP32 browser library relative include shim limit exceeded (${shims})`);
        }
      }
      const searchPath = target.slice(0, -suffix.length).join('/');
      if (searchPath) paths.add(searchPath);

      // The preprocessor and the WASI filesystem disagree about whether the
      // parent segments are normalized. A synthetic include root works in
      // both cases: lexical normalization reaches the real file, while the
      // no-op interpretation reaches the byte-identical shim below it.
      if (!normalizedParentInclude && searchPath && parentDepth) {
        // YoWASP may ignore each `..` segment. Mirror the target at every
        // intermediate no-op depth so chained wrapper headers keep resolving
        // relative to their own directory instead of recursing into a shim.
        for (let depth = 1; depth <= parentDepth; depth++) {
          const shimRoot = `${searchPath}/${Array(depth).fill('__ck_parent__').join('/')}`;
          const shimPath = `${shimRoot}/${suffix.join('/')}`;
          const inserted = putRelativeIncludeShim(files, shimPath, targetBytes);
          paths.add(shimRoot);
          if (inserted) {
            shims++;
            mutated = true;
          }
          if (shims > MAX_RELATIVE_INCLUDE_SHIMS) {
            throw new Error(`ESP32 browser library relative include shim limit exceeded (${shims})`);
          }
        }
      }
      if (paths.size > MAX_RELATIVE_INCLUDE_SEARCH_PATHS) {
        throw new Error('ESP32 browser library relative include path limit exceeded');
      }
    }
  }
  return { paths: [...paths].sort(), mutated };
}

/**
 * Rewrite verified Pack-local quoted includes to an unambiguous VFS name.
 *
 * `libraries/<pack-id>` is a namespace, not an Arduino include directory, so
 * searching it cannot expose a library's private basenames to SDK headers.
 * The bytes are changed only in the action-local executor VFS; Build IR and
 * immutable Library Pack contents retain their original source identity.
 */
function canonicalizePackLocalQuotedIncludes(files, runtimeInputs, reachablePaths) {
  let changed = false;
  for (const path of reachablePaths) {
    const originalBytes = runtimeInputs.get(path);
    if (!originalBytes || !SAFE_LIBRARY_EXTENSION.test(path)) continue;
    const source = new TextDecoder().decode(originalBytes);
    REACHABLE_INCLUDE.lastIndex = 0;
    let match;
    let rewritten = source;
    let offset = 0;
    while ((match = REACHABLE_INCLUDE.exec(source))) {
      if (match[1] !== '"') continue;
      const include = match[2].trim().replaceAll('\\', '/');
      if (!safeReachableInclude(include)) continue;
      const target = normalizedIncludePath(path, include);
      if (!target || !runtimeInputs.has(target) || !target.startsWith('libraries/')) continue;
      const specifier = target.slice('libraries/'.length);
      if (!specifier || specifier === include) continue;
      const full = match[0];
      const specOffset = full.lastIndexOf(match[2]);
      if (specOffset < 0) continue;
      const start = match.index + specOffset;
      const end = start + match[2].length;
      rewritten = `${rewritten.slice(0, start + offset)}${specifier}${rewritten.slice(end + offset)}`;
      offset += specifier.length - match[2].length;
    }
    if (rewritten !== source) {
      const bytes = new TextEncoder().encode(rewritten);
      runtimeInputs.set(path, bytes);
      replaceTreeFile(files, path, bytes);
      changed = true;
    }
  }
  return changed;
}

/**
 * Make explicitly supplied project headers visible to library-local
 * `__has_include("...")` probes. Some WASI preprocessors do not apply a
 * separate project include root consistently to those probes, while a
 * same-directory quoted include is reliable. Only unique project-header
 * matches are mirrored, and a real Pack file always wins.
 */
function mirrorQuotedProjectHeaders(files, runtimeInputs, reachablePaths, projectInputs) {
  let shims = 0;
  for (const path of reachablePaths) {
    const bytes = runtimeInputs.get(path);
    if (!bytes || !SAFE_LIBRARY_EXTENSION.test(path)) continue;
    const source = new TextDecoder().decode(bytes);
    REACHABLE_INCLUDE.lastIndex = 0;
    for (let match = REACHABLE_INCLUDE.exec(source); match; match = REACHABLE_INCLUDE.exec(source)) {
      if (match[1] !== '"') continue;
      const include = match[2].trim().replaceAll('\\', '/');
      const segments = include.split('/');
      if (!safeReachableInclude(include) || segments.includes('..')) continue;
      const localPath = normalizedIncludePath(path, include);
      if (!localPath || runtimeInputs.has(localPath)) continue;
      const suffix = segments.filter((segment) => segment !== '.').join('/');
      const projectBytes = uniqueProjectRelativeInput(projectInputs, suffix);
      if (!projectBytes) continue;
      if (putRelativeIncludeShim(files, localPath, projectBytes)) shims++;
      if (shims > MAX_RELATIVE_INCLUDE_SHIMS) {
        throw new Error(`ESP32 browser project header shim limit exceeded (${shims})`);
      }
    }
  }
  return shims;
}

/**
 * Avoid a potentially unbounded synthetic include graph for large Packs.
 *
 * YoWASP does not normalize `..` segments in its virtual filesystem. For a
 * large library, however, mirroring every possible no-op path is both costly
 * and prone to cycles. A parent-relative include whose target is present in
 * the same verified Pack can be rewritten to that target's canonical VFS
 * path. Includes that leave the Pack (project configuration headers, for
 * example) are intentionally left untouched for the bounded shim logic above.
 */
function compactResolvableParentIncludes(files, runtimeInputs, reachablePaths, paths) {
  if (reachablePaths.size < COMPACT_RELATIVE_INCLUDE_REACHABLE_THRESHOLD) return false;
  let parentIncludeCount = 0;
  for (const path of reachablePaths) {
    const bytes = runtimeInputs.get(path);
    if (!bytes || !SAFE_LIBRARY_EXTENSION.test(path)) continue;
    const source = new TextDecoder().decode(bytes);
    RELATIVE_INCLUDE.lastIndex = 0;
    for (let match = RELATIVE_INCLUDE.exec(source); match; match = RELATIVE_INCLUDE.exec(source)) {
      if (match[0].match(/#\s*include\s*</)) continue;
      const include = match[1].trim().replaceAll('\\', '/');
      if (!include.split('/').includes('..')) continue;
      const target = normalizedIncludePath(path, include);
      if (target && runtimeInputs.has(target)) parentIncludeCount += 1;
    }
  }
  if (parentIncludeCount < COMPACT_RELATIVE_INCLUDE_COUNT_THRESHOLD) return false;

  let changed = false;
  for (const path of reachablePaths) {
    const originalBytes = runtimeInputs.get(path);
    if (!originalBytes || !SAFE_LIBRARY_EXTENSION.test(path)) continue;
    const source = new TextDecoder().decode(originalBytes);
    RELATIVE_INCLUDE.lastIndex = 0;
    let match;
    let rewritten = source;
    let offset = 0;
    while ((match = RELATIVE_INCLUDE.exec(source))) {
      if (match[0].match(/#\s*include\s*</)) continue;
      const include = match[1].trim().replaceAll('\\', '/');
      if (!include.split('/').includes('..')) continue;
      const target = normalizedIncludePath(path, include);
      if (!target || !runtimeInputs.has(target)) continue;
      const full = match[0];
      const specOffset = full.lastIndexOf(match[1]);
      if (specOffset < 0) continue;
      const start = match.index + specOffset;
      const end = start + match[1].length;
      const targetSegments = target.split('/');
      const isLibraryTarget = targetSegments[0] === 'libraries' && targetSegments.length > 2;
      const specifier = isLibraryTarget ? targetSegments.slice(2).join('/') : target;
      if (isLibraryTarget) paths.add(targetSegments.slice(0, 2).join('/'));
      rewritten = `${rewritten.slice(0, start + offset)}${specifier}${rewritten.slice(end + offset)}`;
      offset += specifier.length - match[1].length;
    }
    if (rewritten !== source) {
      const bytes = new TextEncoder().encode(rewritten);
      runtimeInputs.set(path, bytes);
      replaceTreeFile(files, path, bytes);
      changed = true;
    }
  }
  return changed;
}

/**
 * Mirror the bounded include graph below a no-op shim. YoWASP may ignore
 * parent segments while resolving a quoted include, so a wrapper copied to a
 * synthetic directory also needs the sibling files its own includes name.
 * The canonical Pack paths remain the source of truth; only the executor VFS
 * receives these byte-identical mirrors.
 */
function mirrorNoOpIncludeGraph(files, runtimeInputs, canonicalPath, noOpPath) {
  const seen = new Set();
  let shims = 0;
  const visit = (canonical, synthetic) => {
    const key = `${canonical}\0${synthetic}`;
    if (seen.has(key)) return;
    seen.add(key);
    const bytes = runtimeInputs.get(canonical);
    if (!bytes || !SAFE_LIBRARY_EXTENSION.test(canonical)) return;
    const source = new TextDecoder().decode(bytes);
    const syntheticSlash = synthetic.lastIndexOf('/');
    if (syntheticSlash < 1) return;
    const syntheticBase = synthetic.slice(0, syntheticSlash);
    RELATIVE_INCLUDE.lastIndex = 0;
    for (let match = RELATIVE_INCLUDE.exec(source); match; match = RELATIVE_INCLUDE.exec(source)) {
      const full = match[0];
      const delimiter = full.match(/#\s*include\s*([<"])/)?.[1];
      if (delimiter !== '"') continue;
      const include = match[1].trim().replaceAll('\\', '/');
      if (!safeReachableInclude(include)) continue;
      const canonicalTarget = normalizedIncludePath(canonical, include);
      if (!canonicalTarget) continue;
      const targetBytes = runtimeInputs.get(canonicalTarget);
      if (!targetBytes) continue;
      const suffix = include.split('/').filter((segment) => segment && segment !== '.' && segment !== '..');
      if (!suffix.length) continue;
      const syntheticTarget = `${syntheticBase}/${suffix.join('/')}`;
      const existed = treeFile(files, syntheticTarget) !== undefined;
      putRelativeIncludeShim(files, syntheticTarget, targetBytes);
      if (!existed) {
        shims++;
        if (shims > MAX_RELATIVE_INCLUDE_SHIMS) {
          throw new Error(`ESP32 browser library relative include shim limit exceeded (${shims})`);
        }
      }
      visit(canonicalTarget, syntheticTarget);
    }
  };
  visit(canonicalPath, noOpPath);
  return shims;
}

/**
 * A normal filesystem resolves `dir/../header.h` before opening the file.
 * YoWASP's virtual filesystem treats `..` as a no-op, so a parent-relative
 * include can accidentally reopen a same-name wrapper in `dir`. Rewrite
 * multi-level parent includes to an isolated alias as well: a no-op lookup
 * would otherwise make the target's own sibling includes resolve from the
 * wrong directory. The verified Pack bytes remain untouched outside this
 * executor VFS.
 */
function normalizeConflictingParentIncludes(files, runtimeInputs, reachablePaths, aliasTargets) {
  for (const path of reachablePaths) {
    const originalBytes = runtimeInputs.get(path);
    if (!originalBytes) continue;
    if (!SAFE_LIBRARY_EXTENSION.test(path)) continue;
    const source = new TextDecoder().decode(originalBytes);
    RELATIVE_INCLUDE.lastIndex = 0;
    let match;
    let rewritten = source;
    let offset = 0;
    while ((match = RELATIVE_INCLUDE.exec(source))) {
      const include = match[1].trim().replaceAll('\\', '/');
      const segments = include.split('/');
      if (!segments.includes('..') || !include || include.startsWith('/') || include.includes('\0')
        || segments.some((segment) => !segment)) continue;
      const base = path.split('/').slice(0, -1);
      const target = [...base];
      const noOp = [...base];
      for (const segment of segments) {
        if (segment === '.') continue;
        if (segment === '..') {
          if (target.length <= LIBRARY_VFS_ROOT_SEGMENTS) {
            target.length = 0;
            break;
          }
          target.pop();
        } else {
          target.push(segment);
          noOp.push(segment);
        }
      }
      const suffix = segments.filter((segment) => segment !== '.' && segment !== '..');
      if (!suffix.length || !target.length) continue;
      const targetPath = target.join('/');
      const noOpPath = noOp.join('/');
      if (targetPath === noOpPath || !runtimeInputs.has(targetPath) || !runtimeInputs.has(noOpPath)) continue;

      const full = match[0];
      const specOffset = full.lastIndexOf(match[1]);
      if (specOffset < 0) continue;
      const start = match.index + specOffset;
      const end = start + match[1].length;
      const alias = targetPath;
      rewritten = `${rewritten.slice(0, start + offset)}${alias}${rewritten.slice(end + offset)}`;
      offset += alias.length - match[1].length;
      aliasTargets.add(targetPath);
    }
    if (rewritten !== source) {
      const bytes = new TextEncoder().encode(rewritten);
      runtimeInputs.set(path, bytes);
      replaceTreeFile(files, path, bytes);
    }
  }
}

function reachableRuntimeInputPaths(runtimeInputs, action, inputMap) {
  const includeRoots = [...new Set((action?.compileUnit?.includePaths ?? [])
    .filter((path) => typeof path === 'string' && path.startsWith('packs/libraries/'))
    .map(libraryVfsPath))];
  const reachable = new Set();
  const queue = [];
  const enqueue = (path) => {
    if (!runtimeInputs.has(path) || reachable.has(path)) return;
    reachable.add(path);
    queue.push(path);
    if (reachable.size > MAX_LIBRARY_FILES) {
      throw new Error('ESP32 browser reachable library input limit exceeded');
    }
  };
  const resolveIncludes = (source, path) => {
    REACHABLE_INCLUDE.lastIndex = 0;
    for (let match = REACHABLE_INCLUDE.exec(source); match; match = REACHABLE_INCLUDE.exec(source)) {
      const delimiter = match[1];
      const include = match[2].trim().replaceAll('\\', '/');
      if (!safeReachableInclude(include)) continue;
      if (delimiter === '"' && path) {
        const local = normalizedIncludePath(path, include);
        if (local && runtimeInputs.has(local)) {
          enqueue(local);
          continue;
        }
      }
      for (const root of includeRoots) {
        const candidate = normalizedIncludePath(`${root}/__include__.h`, include);
        if (candidate && runtimeInputs.has(candidate)) enqueue(candidate);
      }
    }
  };

  const sourcePath = typeof action?.compileUnit?.source === 'string'
    ? libraryVfsPath(action.compileUnit.source)
    : '';
  if (runtimeInputs.has(sourcePath)) enqueue(sourcePath);
  else if (typeof action?.compileUnit?.source === 'string') {
    const sourceBytes = inputMap.get(action.compileUnit.source);
    if (sourceBytes) resolveIncludes(new TextDecoder().decode(sourceBytes), '');
  }
  while (queue.length) {
    const path = queue.shift();
    const bytes = runtimeInputs.get(path);
    if (bytes && SAFE_LIBRARY_EXTENSION.test(path)) {
      resolveIncludes(new TextDecoder().decode(bytes), path);
    }
  }
  return reachable;
}

function normalizedIncludePath(sourcePath, include) {
  const parts = sourcePath.split('/').slice(0, -1);
  for (const segment of include.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.length ? parts.join('/') : null;
}

function safeReachableInclude(include) {
  return Boolean(
    include
    && !include.startsWith('/')
    && !include.includes('\0')
    && include.split('/').every((segment) => segment && segment !== '__proto__'
      && segment !== 'prototype' && segment !== 'constructor'),
  );
}

function uniqueProjectRelativeInput(projectInputs, suffix) {
  const matches = [...projectInputs].filter(([path]) => path === suffix || path.endsWith(`/${suffix}`));
  return matches.length === 1 ? matches[0][1] : undefined;
}

function putRelativeIncludeShim(files, path, bytes) {
  const existing = treeFile(files, path);
  if (existing === undefined) {
    putTreeFile(files, path, bytes);
    return true;
  }
  if (!(existing instanceof Uint8Array) || !equalByteArrays(existing, bytes)) {
    throw new Error(`ESP32 browser library relative include shim conflicts: ${path}`);
  }
  return false;
}

function replaceTreeFile(tree, path, value) {
  deleteTreeFile(tree, path);
  putTreeFile(tree, path, value);
}

function parseImageFlags(flags, target) {
  if (!Array.isArray(flags)) {
    throw runtimeError('image_layout', `${target.label} image flags are invalid`);
  }
  const values = new Map();
  for (const flag of flags) {
    const match = typeof flag === 'string' && flag.match(/^--([a-z][a-z0-9-]*)=(.+)$/);
    if (!match || values.has(match[1])) {
      throw runtimeError('image_layout', `${target.label} image flags are invalid`);
    }
    values.set(match[1], match[2]);
  }
  const expectedKeys = [
    'chip', 'flash-mode', 'flash-freq', 'flash-size',
    'elf-sha256-offset', 'ck-post-link-contract',
  ];
  if (values.size !== expectedKeys.length || expectedKeys.some((key) => !values.has(key))
    || values.get('chip') !== target.sdkTarget.replace(/_es$/, '')
    || values.get('elf-sha256-offset') !== ESP32_ELF_SHA256_OFFSET
    || !SHA256.test(values.get('ck-post-link-contract'))) {
    throw runtimeError('image_layout', `${target.label} image flags are invalid`);
  }
  return Object.freeze({
    flashMode: values.get('flash-mode'),
    flashFrequency: values.get('flash-freq'),
    flashSize: values.get('flash-size'),
  });
}

function isPostLinkContractFlag(value) {
  const prefix = '--ck-post-link-contract=';
  return typeof value === 'string' && value.startsWith(prefix) && SHA256.test(value.slice(prefix.length));
}

function actionCompileError(message, diagnostics) {
  const error = new Error(message);
  error.code = 'compile_error';
  error.diagnostics = diagnostics;
  return error;
}

/** Match Arduino's ESP32 size accounting without another compiler process. */
export function measureEsp32C3Memory(value, label = 'ESP32-C3') {
  const bytes = value instanceof Uint8Array ? value : null;
  if (!bytes || bytes.byteLength < 52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectionOffset = view.getUint32(32, true);
  const sectionEntryBytes = view.getUint16(46, true);
  const sectionCount = view.getUint16(48, true);
  const stringTableIndex = view.getUint16(50, true);
  if (sectionCount === 0) return null;
  if (
    sectionEntryBytes < ELF_SECTION_HEADER_BYTES
    || sectionCount > MAX_ELF_SECTION_COUNT
    || stringTableIndex >= sectionCount
    || !boundedRange(bytes.byteLength, sectionOffset, sectionEntryBytes * sectionCount)
  ) throw runtimeError('image_layout', `${label} ELF section table is invalid`);

  const stringHeader = sectionOffset + stringTableIndex * sectionEntryBytes;
  const stringOffset = view.getUint32(stringHeader + 16, true);
  const stringBytes = view.getUint32(stringHeader + 20, true);
  if (!boundedRange(bytes.byteLength, stringOffset, stringBytes)) {
    throw runtimeError('image_layout', `${label} ELF section names are invalid`);
  }
  const names = bytes.subarray(stringOffset, stringOffset + stringBytes);
  const sizes = new Map();
  for (let index = 0; index < sectionCount; index++) {
    const header = sectionOffset + index * sectionEntryBytes;
    const nameOffset = view.getUint32(header, true);
    const type = view.getUint32(header + 4, true);
    const dataOffset = view.getUint32(header + 16, true);
    const size = view.getUint32(header + 20, true);
    if (size === 0) continue;
    if (type !== ELF_NOBITS_SECTION && !boundedRange(bytes.byteLength, dataOffset, size)) {
      throw runtimeError('image_layout', `${label} ELF section data is invalid`);
    }
    const name = elfSectionName(names, nameOffset);
    sizes.set(name, (sizes.get(name) ?? 0) + size);
  }
  const sum = (sectionNames) => sectionNames.reduce((total, name) => total + (sizes.get(name) ?? 0), 0);
  return Object.freeze({
    flashUsed: sum(FLASH_MEMORY_SECTIONS),
    flashTotal: C3_FLASH_TOTAL_BYTES,
    ramUsed: sum(RAM_MEMORY_SECTIONS),
    ramTotal: C3_RAM_TOTAL_BYTES,
  });
}

/** Materialize file trees whose indexes are integrity-bound by Pack Manifest v2. */
export async function materializeEsp32PackArtifactTrees(valueIds, loader, label = 'ESP32-C3') {
  if (typeof loader?.loadManifest !== 'function' || typeof loader?.loadArtifact !== 'function') {
    throw new TypeError(`${label} Pack loader is required`);
  }
  const manifest = await loader.loadManifest();
  const artifacts = resolvePackTreeArtifacts(manifest, valueIds, 'runtime', label);
  const tree = {};
  for (const artifact of artifacts) {
    const loaded = await loadArtifact(
      loader,
      artifact.id,
      artifact.size,
      `${label} Pack tree`,
      artifact.sha256,
    );
    const verifiedFiles = await Promise.all(artifact.files.map(async (file) => {
      const bytes = loaded.bytes.subarray(file.offset, file.offset + file.length);
      if (await sha256Bytes(bytes) !== file.sha256) {
        throw new Error(`${label} Pack tree file checksum mismatch: ${file.path}`);
      }
      return [file.path, new Uint8Array(bytes)];
    }));
    for (const [path, bytes] of verifiedFiles) {
      putTreeFile(tree, path, bytes);
    }
  }
  materializeVfsParentIncludeAliases(tree, label);
  return tree;
}

/**
 * WASI toolchains used by the browser verifier do not consistently normalize
 * `..` segments in an in-memory filesystem. SDK headers commonly rely on
 * parent-relative includes, so mirror only resolvable targets at the no-op
 * lookup path. Pack bytes remain unchanged and aliases are bounded.
 */
function materializeVfsParentIncludeAliases(tree, label) {
  const files = new Map();
  const collect = (node, prefix = '') => {
    for (const [name, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (value instanceof Uint8Array) files.set(path, value);
      else if (isPlainRecord(value)) collect(value, path);
    }
  };
  collect(tree);
  const pending = [...files.entries()];
  let aliases = 0;
  for (let index = 0; index < pending.length; index += 1) {
    const [path, bytes] = pending[index];
    if (!SAFE_LIBRARY_EXTENSION.test(path)) continue;
    const source = new TextDecoder().decode(bytes);
    VFS_PARENT_INCLUDE.lastIndex = 0;
    for (let match = VFS_PARENT_INCLUDE.exec(source); match; match = VFS_PARENT_INCLUDE.exec(source)) {
      const include = match[2].trim().replaceAll('\\', '/');
      const segments = include.split('/');
      if (!segments.includes('..') || !safeVfsParentInclude(include)) continue;
      const directory = path.split('/').slice(0, -1);
      const canonical = normalizeVfsParentPath(directory, segments, true);
      const noOp = normalizeVfsParentPath(directory, segments, false);
      if (!canonical || !noOp || canonical === noOp || !files.has(canonical) || files.has(noOp)) continue;
      const target = files.get(canonical);
      putTreeFile(tree, noOp, target);
      files.set(noOp, target);
      pending.push([noOp, target]);
      aliases += 1;
      if (aliases > MAX_VFS_PARENT_INCLUDE_ALIASES) {
        throw new Error(`${label} VFS parent include alias limit exceeded`);
      }
    }
  }
}

function safeVfsParentInclude(include) {
  return Boolean(include && !include.startsWith('/') && !include.includes('\0')
    && include.split('/').every((segment) => segment && !RESERVED_VFS_SEGMENTS.has(segment)));
}

function normalizeVfsParentPath(directory, segments, normalizeParents) {
  const result = [...directory];
  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (normalizeParents) {
        if (!result.length) return null;
        result.pop();
      }
      continue;
    }
    result.push(segment);
  }
  return result.length ? result.join('/') : null;
}

/** Parse Clang/LLD text into the strict existing Worker diagnostic shape. */
export function parseEsp32C3CompilerDiagnostics(
  value,
  processed,
  sourceName,
  diagnosticFiles,
  diagnosticDefaultName = sourceName,
) {
  const text = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  const sourceLineCount = Number.isSafeInteger(processed?.sourceLineCount) && processed.sourceLineCount > 0
    ? processed.sourceLineCount
    : 1;
  const generated = processed?.generatedLineToFunction instanceof Map
    ? processed.generatedLineToFunction
    : new Map();
  const diagnosticLookup = createDiagnosticFileLookup(diagnosticFiles);
  const defaultDiagnosticFile = diagnosticLookup?.byName.get(diagnosticDefaultName);
  const defaultFileName = defaultDiagnosticFile?.name ?? diagnosticDefaultName;
  const diagnostics = [];
  for (const raw of text.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const located = line.match(/^(.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.+)$/);
    if (located) {
      let [, file, rowText, columnText, severityText, message] = located;
      let row = Number(rowText);
      let fromGenerated = false;
      let unmapped = false;
      const fileBase = basename(file);
      let diagnosticFileName = sourceName;
      if (fileBase === '<generated>') {
        const fn = generated.get(row);
        if (fn) {
          row = Number.isSafeInteger(fn.line) && fn.line > 0 ? fn.line : 1;
          columnText = '1';
          fromGenerated = true;
        } else {
          // Preserve the Planner's synthetic coordinate. BrowserWasmExecutor
          // owns the Build IR diagnostic map and will translate it to the
          // original sketch location after this Adapter returns.
          diagnosticFileName = '<generated>';
        }
      } else if (diagnosticLookup) {
        const mapped = diagnosticLookup.byPath.get(normalizeDiagnosticPath(file));
        if (mapped) {
          diagnosticFileName = mapped.name;
          if (mapped.forceUnmapped) {
            message = `${fileBase}:${rowText}: ${message}`;
            row = 1;
            unmapped = true;
          } else if (row < 1 || row > mapped.sourceLineCount) {
            row = Math.min(Math.max(1, row), mapped.sourceLineCount);
            unmapped = true;
          }
        } else {
          diagnosticFileName = defaultFileName;
          message = `${fileBase}:${rowText}: ${message}`;
          row = 1;
          unmapped = true;
        }
      } else if (fileBase === sourceName) {
        if (row < 1 || row > sourceLineCount) {
          row = Math.min(Math.max(1, row), sourceLineCount);
          unmapped = true;
        }
      } else {
        message = `${fileBase}:${rowText}: ${message}`;
        row = 1;
        unmapped = true;
      }
      pushDiagnostic(diagnostics, {
        severity: diagnosticSeverity(severityText),
        file: diagnosticFileName,
        line: row,
        ...(columnText ? { column: Math.max(1, Number(columnText)) } : {}),
        message,
        ...(fromGenerated ? { fromGenerated: true } : {}),
        ...(unmapped ? { unmapped: true } : {}),
      });
      continue;
    }

    const general = line.match(/^(?:(?:clang(?:\+\+)?|ld\.lld|wasm-ld):\s*)?(fatal error|error|warning|note):\s*(.+)$/);
    if (general) {
      pushDiagnostic(diagnostics, {
        severity: diagnosticSeverity(general[1]),
        file: defaultFileName,
        line: 1,
        message: general[2],
        unmapped: true,
      });
    }
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
  }
  return diagnostics;
}

function createDiagnosticFileLookup(value) {
  if (!Array.isArray(value)) return null;
  const byPath = new Map();
  const byName = new Map();
  const put = (path, file, forceUnmapped) => {
    const normalized = normalizeDiagnosticPath(path);
    if (!normalized) return;
    byPath.set(normalized, { ...file, forceUnmapped });
  };
  for (const file of value) {
    byName.set(file.name, file);
    for (const path of file.regularPaths) put(path, file, false);
  }
  for (const file of value) {
    for (const path of file.unmappedPaths) put(path, file, true);
  }
  return { byPath, byName };
}

function normalizeDiagnosticPath(value) {
  return String(value).replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
}

function validateProfileOptions(value, label) {
  if (!isPlainRecord(value)) fail(`${label} SDK profile options are invalid`);
  const entries = Object.entries(value);
  if (entries.length > 64) fail(`${label} SDK profile option limit exceeded`);
  const options = {};
  for (const [key, entry] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)
      || typeof entry !== 'string' || !entry || entry.length > 128 || /[\0\r\n]/.test(entry)) {
      fail(`${label} SDK profile option is invalid: ${key}`);
    }
    options[key] = entry;
  }
  return Object.freeze(options);
}

function validateCompilerExecution(value, label) {
  const execution = exactRecord(value, `${label} compiler execution`, ['targetTriple', 'targetArguments', 'elf']);
  if (typeof execution.targetTriple !== 'string'
    || !/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(execution.targetTriple)
    || !Array.isArray(execution.targetArguments)
    || execution.targetArguments.length < 1
    || execution.targetArguments.length > 8
    || execution.targetArguments[0] !== `--target=${execution.targetTriple}`
    || execution.targetArguments.some((argument) => (
      typeof argument !== 'string' || !/^-(?:-target=|mcpu=|march=|mabi=)[A-Za-z0-9._+-]+$/.test(argument)
    ))) {
    fail(`${label} compiler execution target is invalid`);
  }
  const elf = exactRecord(execution.elf, `${label} compiler ELF execution`, ['machine', 'floatAbi']);
  const expectedMachine = execution.targetTriple.startsWith('riscv32-')
    ? 243
    : execution.targetTriple.startsWith('xtensa-') ? 94 : 0;
  const targetFlags = execution.targetArguments.slice(1);
  const riscvTarget = expectedMachine === 243
    && targetFlags.filter((argument) => argument.startsWith('-march=')).length === 1
    && targetFlags.filter((argument) => argument.startsWith('-mabi=')).length === 1
    && !targetFlags.some((argument) => argument.startsWith('-mcpu='));
  const xtensaTarget = expectedMachine === 94
    && targetFlags.filter((argument) => argument.startsWith('-mcpu=')).length === 1
    && !targetFlags.some((argument) => argument.startsWith('-march=') || argument.startsWith('-mabi='));
  const mabi = execution.targetArguments
    .find((argument) => argument.startsWith('-mabi='))
    ?.slice('-mabi='.length) ?? '';
  const expectedFloatAbi = mabi.endsWith('d') ? 0x4 : mabi.endsWith('f') ? 0x2 : 0;
  if (!expectedMachine
    || (!riscvTarget && !xtensaTarget)
    || elf.machine !== expectedMachine
    || elf.floatAbi !== expectedFloatAbi
    || new Set(execution.targetArguments).size !== execution.targetArguments.length) {
    fail(`${label} compiler ELF execution is invalid`);
  }
  return Object.freeze({
    targetTriple: execution.targetTriple,
    targetArguments: Object.freeze([...execution.targetArguments]),
    elf: Object.freeze({ machine: elf.machine, floatAbi: elf.floatAbi }),
  });
}

function inferCompilerExecution(compileArgs, linkArgs, label) {
  const target = compileArgs.find((argument) => argument.startsWith('--target='));
  if (!target || !linkArgs.includes(target)) fail(`${label} compiler target triple is missing`);
  const targetTriple = target.slice('--target='.length);
  const targetArguments = [
    target,
    ...compileArgs.filter((argument) => /^-(?:mcpu|march|mabi)=/.test(argument)),
  ];
  if (targetArguments.slice(1).some((argument) => !linkArgs.includes(argument))) {
    fail(`${label} compile and link target arguments do not match`);
  }
  const mabi = targetArguments.find((argument) => argument.startsWith('-mabi='))?.slice(6) ?? '';
  const machine = targetTriple.startsWith('riscv32-')
    ? 243
    : targetTriple.startsWith('xtensa-') ? 94 : 0;
  return {
    targetTriple,
    targetArguments,
    elf: { machine, floatAbi: mabi.endsWith('d') ? 0x4 : mabi.endsWith('f') ? 0x2 : 0 },
  };
}

function validateEspSrModelProfile(value, label, required) {
  if (value === undefined) {
    if (required) fail(`${label} esp_sr_16 model artifact profile is missing`);
    return undefined;
  }
  const model = exactRecord(value, `${label} model flash profile`, [
    'artifactId', 'offset', 'size', 'capacity',
  ]);
  if (model.artifactId !== ESP32_SR_MODEL_ARTIFACT
    || model.offset !== ESP32_SR_MODEL_OFFSET
    || model.size !== ESP32_SR_MODEL_SIZE_BYTES
    || model.capacity !== ESP32_SR_MODEL_CAPACITY_BYTES
    || model.size > model.capacity
    || Number(BigInt(model.offset)) + model.capacity > ESP32_SR_FLASH_SIZE_BYTES) {
    fail(`${label} esp_sr_16 model artifact profile is invalid`);
  }
  return Object.freeze({
    artifactId: model.artifactId,
    offset: model.offset,
    size: model.size,
    capacity: model.capacity,
  });
}

function validateFlashOffsets(value, label) {
  const keys = ['bootloader', 'partitions', 'bootApp0'];
  const offsets = exactRecord(value, `${label} flash offsets`, keys);
  for (const [name, offset] of Object.entries(offsets)) {
    if (typeof offset !== 'string' || !/^0x[0-9a-f]+$/i.test(offset)) {
      fail(`${label} flash offset is invalid: ${name}`);
    }
  }
  return Object.freeze({ ...offsets });
}

function validateCommandProfile(value, phase, names, label) {
  const hasLanguageFlags = phase === 'compile'
    && isPlainRecord(value)
    && Object.hasOwn(value, 'languageFlags');
  const keys = phase === 'compile'
    ? ['args', 'source', 'object', 'artifactIds', ...(hasLanguageFlags ? ['languageFlags'] : [])]
    : ['args', 'object', 'elf', 'artifactIds'];
  const command = exactRecord(value, `${label} ${phase} profile`, keys);
  for (const [key, expected] of Object.entries(names)) {
    if (command[key] !== expected) fail(`${label} ${phase} ${key} is invalid`);
  }
  if (!Array.isArray(command.args) || !command.args.length || command.args.length > MAX_COMMAND_ARGUMENTS) {
    fail(`${label} ${phase} arguments are invalid`);
  }
  let argumentChars = 0;
  const args = command.args.map((argument) => {
    if (
      typeof argument !== 'string'
      || !argument.length
      || argument.length > MAX_COMMAND_ARGUMENT_CHARS
      || /[\0\r\n]/.test(argument)
    ) fail(`${label} ${phase} argument is invalid`);
    argumentChars += argument.length;
    return argument;
  });
  if (argumentChars > MAX_COMMAND_CHARS || args[0] !== 'clang++') {
    fail(`${label} ${phase} command is invalid`);
  }
  const artifactIds = validateArtifactIds(command.artifactIds, phase, label);
  const languageFlags = hasLanguageFlags
    ? validateCompileLanguageFlags(command.languageFlags, label)
    : undefined;
  return Object.freeze({
    args: Object.freeze(args),
    ...(phase === 'compile'
      ? { source: command.source, object: command.object }
      : { object: command.object, elf: command.elf }),
    ...(languageFlags === undefined ? {} : { languageFlags }),
    artifactIds,
  });
}

function validateCompileLanguageFlags(value, label) {
  const flags = exactRecord(value, `${label} compile language flags`, ['c', 'cxx', 'asm']);
  const normalized = {};
  let argumentCount = 0;
  let argumentChars = 0;
  for (const language of ['c', 'cxx', 'asm']) {
    const entries = flags[language];
    if (!Array.isArray(entries) || entries.length > MAX_COMMAND_ARGUMENTS) {
      fail(`${label} compile ${language} language flags are invalid`);
    }
    normalized[language] = Object.freeze(entries.map((argument) => {
      if (typeof argument !== 'string'
        || !argument.length
        || argument.length > MAX_COMMAND_ARGUMENT_CHARS
        || /[\0\r\n]/.test(argument)) {
        fail(`${label} compile ${language} language flag is invalid`);
      }
      argumentCount++;
      argumentChars += argument.length;
      return argument;
    }));
  }
  if (argumentCount > MAX_COMMAND_ARGUMENTS || argumentChars > MAX_COMMAND_CHARS) {
    fail(`${label} compile language flags exceed their argument limit`);
  }
  return Object.freeze(normalized);
}

function validateArtifactIds(value, phase, label = 'ESP32-C3') {
  if (!Array.isArray(value) || !value.length || value.length > MAX_VFS_GROUPS) {
    fail(`${label} ${phase} Pack artifact ids are invalid`);
  }
  let previous = '';
  const ids = value.map((id) => {
    if (typeof id !== 'string' || !IDENTIFIER.test(id) || id <= previous) {
      fail(`${label} ${phase} Pack artifact ids must be sorted and unique`);
    }
    previous = id;
    return id;
  });
  return Object.freeze(ids);
}

function resolvePackTreeArtifacts(manifest, valueIds, phase, label = 'ESP32-C3') {
  const artifactIds = validateArtifactIds(valueIds, phase, label);
  if (!isPlainRecord(manifest) || manifest.schema !== 2 || !Array.isArray(manifest.artifacts)) {
    fail(`${label} ${phase} Pack Manifest must use schema 2`);
  }
  const byId = new Map(manifest.artifacts.map((artifact) => [artifact?.id, artifact]));
  const paths = new Set();
  let totalFiles = 0;
  let totalBytes = 0;
  const artifacts = artifactIds.map((artifactId) => {
    const artifact = byId.get(artifactId);
    if (!isPlainRecord(artifact) || artifact.id !== artifactId || artifact.kind !== 'tree'
      || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > MAX_VFS_GROUP_BYTES
      || typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)
      || !Array.isArray(artifact.files) || !artifact.files.length) {
      fail(`${label} ${phase} Pack tree artifact is invalid: ${artifactId}`);
    }
    totalBytes += artifact.size;
    if (totalBytes > MAX_VFS_TOTAL_BYTES) fail(`${label} ${phase} Pack trees exceed their byte limit`);

    let expectedOffset = 0;
    let previousPath = '';
    const files = artifact.files.map((valueFile) => {
      const file = exactRecord(valueFile, `${label} ${phase} Pack tree file`, ['path', 'offset', 'length', 'sha256']);
      const path = validatePackTreeFilePath(file.path, label);
      if (path <= previousPath || paths.has(path)) fail(`${label} ${phase} Pack tree paths must be sorted and unique`);
      if (
        !Number.isSafeInteger(file.offset)
        || file.offset !== expectedOffset
        || !Number.isSafeInteger(file.length)
        || file.length < 0
        || file.length > MAX_VFS_FILE_BYTES
        || file.length > artifact.size - file.offset
        || typeof file.sha256 !== 'string'
        || !SHA256.test(file.sha256)
      ) fail(`${label} ${phase} Pack tree file is invalid`);
      expectedOffset += file.length;
      previousPath = path;
      paths.add(path);
      totalFiles++;
      if (totalFiles > MAX_VFS_FILES) fail(`${label} ${phase} Pack trees exceed their file limit`);
      return Object.freeze({ path, offset: file.offset, length: file.length, sha256: file.sha256 });
    });
    if (expectedOffset !== artifact.size) fail(`${label} ${phase} Pack tree has non-contiguous bytes`);
    return Object.freeze({
      id: artifact.id,
      size: artifact.size,
      sha256: artifact.sha256,
      files: Object.freeze(files),
    });
  });
  return Object.freeze(artifacts);
}

function validatePackTreeFilePath(value, label = 'ESP32-C3') {
  if (typeof value !== 'string' || !value.length || value.length > 256 || value.startsWith('/')) {
    fail(`${label} Pack tree path is invalid`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => (
    !SAFE_VFS_SEGMENT.test(segment)
    || segment === '.'
    || segment === '..'
    || RESERVED_VFS_SEGMENTS.has(segment)
  ))) fail(`${label} Pack tree path is invalid`);
  return value;
}

function assertRequiredArguments(args, required, phase, label) {
  for (const argument of required) {
    if (!args.includes(argument)) fail(`${label} ${phase} arguments omit ${argument}`);
  }
}

function assertOutputArgument(args, output, phase, label) {
  const indexes = [];
  for (let index = 0; index < args.length; index++) if (args[index] === '-o') indexes.push(index);
  if (indexes.length !== 1 || args[indexes[0] + 1] !== output) {
    fail(`${label} ${phase} output argument is invalid`);
  }
}

function assertNoReservedPackTreePaths(artifacts, reserved, phase, label) {
  for (const artifact of artifacts) {
    for (const file of artifact.files) {
      if (reserved.has(file.path)) fail(`${label} ${phase} Pack tree contains a reserved output path`);
    }
  }
}

async function loadBrowserLibraries(selections, createPackLoader, label) {
  const libraries = [];
  let totalFiles = 0;
  let totalSourceFiles = 0;
  let totalIncludeDirs = 0;
  let totalSourceBytes = 0;
  for (const selection of selections) {
    const loader = createPackLoader({
      manifestUrl: selection.manifestUrl,
      expectedId: selection.packId,
      expectedRevision: selection.revision,
      limits: ESP32_BROWSER_LIBRARY_PACK_LIMITS,
    });
    try {
      const loaded = await loadArtifact(
        loader,
        selection.artifact,
        undefined,
        `${label} browser library ${selection.name}@${selection.version}`,
      );
      if (loaded.artifact.kind !== 'library-source-json') {
        fail(`${label} browser library artifact kind is invalid: ${selection.name}`);
      }
      if (loaded.bytes.byteLength > MAX_LIBRARY_PAYLOAD_BYTES) {
        fail(`${label} browser library payload exceeds its byte limit: ${selection.name}`);
      }
      let value;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes));
      } catch {
        fail(`${label} browser library is not valid UTF-8 JSON: ${selection.name}`);
      }
      const library = validateBrowserLibrarySourcePayload(value, selection, label);
      totalFiles += library.files.length;
      totalSourceFiles += library.files.filter(({ source }) => source).length;
      totalIncludeDirs += library.includePaths.length;
      totalSourceBytes += library.sourceBytes;
      if (
        totalFiles > MAX_LIBRARY_FILES
        || totalSourceFiles > MAX_LIBRARY_SOURCE_FILES
        || totalIncludeDirs > MAX_LIBRARY_INCLUDE_DIRS
        || totalSourceBytes > MAX_LIBRARY_TOTAL_SOURCE_BYTES
      ) fail(`${label} browser libraries exceed their aggregate limits`);
      libraries.push(library);
    } finally {
      loader?.reset?.();
    }
  }
  return Object.freeze(libraries);
}

function validateBrowserLibrarySourcePayload(value, selection, label) {
  const payload = exactRecord(value, `${label} browser library payload`, [
    'schema', 'name', 'version', 'architectures', 'includeDirs', 'files',
  ]);
  if (
    payload.schema !== BROWSER_LIBRARY_SOURCE_SCHEMA
    || payload.name !== selection.name
    || payload.version !== selection.version
  ) fail(`${label} browser library identity is invalid: ${selection.name}`);
  if (
    !Array.isArray(payload.architectures)
    || !payload.architectures.length
    || payload.architectures.length > 16
    || payload.architectures.some((architecture) => (
      typeof architecture !== 'string' || !SAFE_LIBRARY_ARCHITECTURE.test(architecture)
    ))
    || !payload.architectures.some((architecture) => architecture === '*' || architecture === 'esp32')
    || new Set(payload.architectures).size !== payload.architectures.length
  ) fail(`${label} browser library architectures are invalid: ${selection.name}`);
  if (!Array.isArray(payload.includeDirs) || !payload.includeDirs.length || payload.includeDirs.length > 16) {
    fail(`${label} browser library include directories are invalid: ${selection.name}`);
  }
  const includeDirs = [];
  let previousInclude = '';
  for (const path of payload.includeDirs) {
    if (path !== '.') validateLibraryRelativePath(path, false, `${label} browser library include directory`);
    if (path <= previousInclude) fail(`${label} browser library include directories must be sorted and unique`);
    includeDirs.push(path);
    previousInclude = path;
  }
  if (!Array.isArray(payload.files) || !payload.files.length || payload.files.length > MAX_LIBRARY_FILES_PER_PACK) {
    fail(`${label} browser library files are invalid: ${selection.name}`);
  }

  const root = `libraries/${selection.packId}`;
  const files = [];
  let previousPath = '';
  let sourceBytes = 0;
  for (const rawFile of payload.files) {
    const file = exactRecord(rawFile, `${label} browser library file`, ['path', 'content']);
    validateLibraryRelativePath(file.path, true, `${label} browser library file`);
    if (file.path <= previousPath) fail(`${label} browser library files must be sorted and unique`);
    if (typeof file.content !== 'string' || file.content.includes('\0')) {
      fail(`${label} browser library file content is invalid: ${file.path}`);
    }
    const bytes = new TextEncoder().encode(file.content).byteLength;
    if (bytes > MAX_LIBRARY_FILE_BYTES) fail(`${label} browser library file exceeds its byte limit: ${file.path}`);
    sourceBytes += bytes;
    files.push(Object.freeze({
      path: file.path,
      vfsPath: `${root}/${file.path}`,
      content: file.content,
      source: LIBRARY_SOURCE_EXTENSION.test(file.path),
    }));
    previousPath = file.path;
  }
  if (sourceBytes > MAX_LIBRARY_PAYLOAD_BYTES) {
    fail(`${label} browser library source exceeds its byte limit: ${selection.name}`);
  }
  for (const includeDir of includeDirs) {
    if (includeDir !== '.' && !files.some(({ path }) => path === includeDir || path.startsWith(`${includeDir}/`))) {
      fail(`${label} browser library include directory is empty: ${includeDir}`);
    }
  }
  return Object.freeze({
    name: selection.name,
    version: selection.version,
    root,
    includePaths: Object.freeze(includeDirs.map((path) => path === '.' ? root : `${root}/${path}`)),
    files: Object.freeze(files),
    sourceBytes,
  });
}

function validateLibraryRelativePath(value, requireExtension, label) {
  if (
    typeof value !== 'string'
    || !value.length
    || value.length > MAX_LIBRARY_PATH_CHARS
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes('\0')
    || (requireExtension && !SAFE_LIBRARY_EXTENSION.test(value))
  ) fail(`${label} path is invalid`);
  const segments = value.split('/');
  if (
    segments.length > 12
    || segments.some((segment) => (
      !SAFE_VFS_SEGMENT.test(segment)
      || segment === '.'
      || segment === '..'
      || RESERVED_VFS_SEGMENTS.has(segment.toLowerCase())
    ))
  ) fail(`${label} path is invalid`);
}

async function loadRuntimeProfile(loaders, target) {
  if (!loaders.board) fail(`${target.label} Board Pack is required`);
  const [compilerManifest, sdkManifest, boardManifest] = await Promise.all([
    loaders.compiler.loadManifest(),
    loaders.sdk.loadManifest(),
    loaders.board.loadManifest(),
  ]);
  assertEsp32CurrentOnlyProfileArtifacts(sdkManifest, boardManifest, target.label);
  const [platformValue, boardValue] = await Promise.all([
    loadJsonProfile(
      loaders.sdk,
      sdkManifest,
      ESP32_PLATFORM_PROFILE_ARTIFACT,
      `${target.label} Platform profile`,
    ),
    loadJsonProfile(
      loaders.board,
      boardManifest,
      ESP32_BOARD_PROFILE_CURRENT_ARTIFACT,
      `${target.label} Board profile`,
    ),
  ]);
  const platformManifest = await loadCurrentPlatformManifest(
    loaders.sdk,
    sdkManifest,
    platformValue,
    target.label,
  );
  const profile = validateSplitRuntimeProfile(platformValue, boardValue, target, platformManifest);
  validateRuntimeExecutionPackBinding(profile, compilerManifest, sdkManifest, boardManifest, target.label);
  validateRuntimeProfilePackTrees(profile, sdkManifest, boardManifest, target);
  return profile;
}

function validateRuntimeExecutionPackBinding(profile, compilerManifest, sdkManifest, boardManifest, label) {
  if (sdkManifest?.version !== profile.sdkVersion || boardManifest?.version !== profile.sdkVersion) {
    fail(`${label} runtime Pack versions do not match the execution profile`);
  }
  const compilerPack = profile.sdkVariant.compilerPack;
  if (profile.sdkVariant.id !== sdkManifest.id
    || compilerPack.id !== compilerManifest?.id
    || compilerPack.version !== compilerManifest?.version
    || compilerPack.sha256 !== compilerManifest?.revision) {
    fail(`${label} execution profile Pack binding is invalid`);
  }
}

async function loadJsonProfile(loader, manifest, artifactId, label) {
  const matches = Array.isArray(manifest?.artifacts)
    ? manifest.artifacts.filter((artifact) => artifact?.id === artifactId)
    : [];
  const artifact = matches.length === 1 ? matches[0] : undefined;
  if (!isPlainRecord(artifact)
    || artifact.kind !== 'json'
    || !Number.isSafeInteger(artifact.size)
    || artifact.size < 1
    || artifact.size > MAX_PROFILE_BYTES
    || !SHA256.test(artifact.sha256)) {
    fail(`${label} current artifact is missing or invalid: ${artifactId}`);
  }
  const loaded = await loadArtifact(
    loader,
    artifactId,
    artifact.size,
    label,
    artifact.sha256,
  );
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes));
  } catch {
    fail(`${label} is not valid UTF-8 JSON`);
  }
  return value;
}

async function loadCurrentPlatformManifest(loader, sdkManifest, platformProfile, label) {
  const reference = validatePlatformManifestArtifactReference(
    platformProfile?.platformManifestArtifact,
    label,
  );
  const matches = Array.isArray(sdkManifest?.artifacts)
    ? sdkManifest.artifacts.filter((artifact) => artifact?.id === reference.id)
    : [];
  const artifact = matches.length === 1 ? matches[0] : undefined;
  if (!isPlainRecord(artifact)
    || artifact.kind !== 'json'
    || !Number.isSafeInteger(artifact.size)
    || artifact.size < 1
    || artifact.sha256 !== reference.sha256) {
    fail(`${label} Platform Manifest artifact binding is invalid`);
  }
  if (artifact.size > MAX_PLATFORM_MANIFEST_BYTES) {
    fail(`${label} Platform Manifest artifact exceeds its size limit`);
  }
  const loaded = await loadArtifact(
    loader,
    reference.id,
    artifact.size,
    `${label} Platform Manifest artifact`,
    reference.sha256,
  );
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes));
  } catch {
    fail(`${label} Platform Manifest artifact is not valid UTF-8 JSON`);
  }
  if (!isPlainRecord(manifest) || manifest.kind !== 'ck-platform-pack'
    || manifest.schemaVersion !== 2 || !SHA256.test(manifest.sha256)
    || !Array.isArray(manifest.tools)) {
    fail(`${label} Platform Manifest artifact has an unsupported schema`);
  }
  if (manifest.tools.length !== 0) fail(`${label} Platform Manifest must be tool-neutral`);
  const { sha256: manifestSha256, ...manifestBody } = manifest;
  if (await sha256CanonicalJson(manifestBody) !== manifestSha256) {
    fail(`${label} Platform Manifest hash mismatch`);
  }
  if (!(await validateRecipeLoweringContract(manifest.recipeLowering))) {
    fail(`${label} Platform Manifest recipe lowering contract is invalid`);
  }
  return manifest;
}

function validatePlatformManifestArtifactReference(value, label) {
  const reference = exactRecord(value, `${label} Platform Manifest artifact reference`, ['id', 'sha256']);
  if (reference.id !== ESP32_PLATFORM_MANIFEST_ARTIFACT || !SHA256.test(reference.sha256)) {
    fail(`${label} Platform Manifest artifact reference is invalid`);
  }
  return reference;
}

function validateSplitRuntimeProfile(platformValue, boardValue, target, currentPlatformManifest) {
  if (platformValue?.schema !== ESP32_PLATFORM_PROFILE_SCHEMA) {
    fail(`unsupported ${target.label} Platform profile schema`);
  }
  if (boardValue?.schema !== ESP32_BOARD_PROFILE_SCHEMA) {
    fail(`unsupported ${target.label} Board profile schema`);
  }
  return validateCurrentSplitRuntimeProfile(
    platformValue,
    boardValue,
    target,
    currentPlatformManifest,
  );
}

function validateRuntimeProfilePackTrees(profile, sdkManifest, boardManifest, target) {
  const compileTrees = resolvePackTreeArtifacts(
    sdkManifest,
    profile.compile.artifactIds,
    'compile',
    target.label,
  );
  const linkTrees = resolvePackTreeArtifacts(
    sdkManifest,
    profile.link.artifactIds,
    'link',
    target.label,
  );
  const boardTrees = resolvePackTreeArtifacts(
    boardManifest,
    profile.boardPack.artifactIds,
    'board',
    target.label,
  );
  const reserved = new Set([
    profile.compile.source,
    profile.compile.object,
    profile.link.object,
    profile.link.elf,
  ]);
  assertNoReservedPackTreePaths(compileTrees, reserved, 'compile', target.label);
  assertNoReservedPackTreePaths(linkTrees, reserved, 'link', target.label);
  assertNoReservedPackTreePaths(boardTrees, reserved, 'board', target.label);

  const compilePaths = new Set(compileTrees.flatMap((artifact) => artifact.files.map((file) => file.path)));
  for (const artifact of boardTrees) {
    for (const file of artifact.files) {
      if (!file.path.startsWith('variant/')) {
        fail(`${target.label} Board Pack contains a non-variant path`);
      }
      if (compilePaths.has(file.path)) {
        fail(`${target.label} Board Pack path conflicts with Platform Pack: ${file.path}`);
      }
    }
  }
}

export function assertEsp32CurrentOnlyProfileArtifacts(sdkManifest, boardManifest, label = 'ESP32') {
  const sdkIds = Array.isArray(sdkManifest?.artifacts)
    ? sdkManifest.artifacts.map((artifact) => artifact?.id)
    : [];
  const boardIds = Array.isArray(boardManifest?.artifacts)
    ? boardManifest.artifacts.map((artifact) => artifact?.id)
    : [];
  const hasLegacy = sdkIds.includes('profile') || boardIds.includes('profile');
  const hasCurrent = sdkIds.includes(ESP32_PLATFORM_PROFILE_ARTIFACT)
    || sdkIds.includes(ESP32_PLATFORM_MANIFEST_ARTIFACT)
    || boardIds.includes(ESP32_BOARD_PROFILE_CURRENT_ARTIFACT);
  if (hasLegacy && hasCurrent) {
    fail(`${label} mixed legacy/current Profile artifacts are not allowed`);
  }
}

export function validateEsp32CurrentProfileShape(platformValue, boardValue, label = 'ESP32') {
  const platform = exactRecord(platformValue, `${label} Platform profile`, [
    'schema', 'id', 'sdkVersion', 'platformManifestArtifact', 'compile', 'link',
    'platformRef', 'sdkVariant', 'recipeOrigins', 'recipeLowering', 'migration',
  ]);
  if (platform.schema !== ESP32_PLATFORM_PROFILE_SCHEMA
    || typeof platform.id !== 'string' || !IDENTIFIER.test(platform.id)
    || typeof platform.sdkVersion !== 'string' || !VERSION.test(platform.sdkVersion)) {
    fail(`${label} Platform profile identity is invalid`);
  }
  const manifestArtifact = exactRecord(
    platform.platformManifestArtifact,
    `${label} Platform Manifest artifact reference`,
    ['id', 'sha256'],
  );
  if (manifestArtifact.id !== ESP32_PLATFORM_MANIFEST_ARTIFACT || !SHA256.test(manifestArtifact.sha256)) {
    fail(`${label} Platform Manifest artifact reference is invalid`);
  }
  validateCurrentCommandShape(platform.compile, 'compile', label);
  validateCurrentCommandShape(platform.link, 'link', label);
  validateCurrentPlatformRefShape(platform.platformRef, false, label);
  const sdkVariant = exactRecord(platform.sdkVariant, `${label} SDK variant`, [
    'id', 'sdkTarget', 'memoryType', 'compilerPack',
  ]);
  exactRecord(sdkVariant.compilerPack, `${label} SDK Compiler Pack`, ['id', 'version', 'sha256']);
  exactRecord(platform.recipeOrigins, `${label} recipe origins`, ['compile', 'link']);
  exactRecord(platform.recipeLowering, `${label} recipe lowering`, ['status', 'schemaVersion', 'sha256']);
  validateProfileMigration(
    platform.migration,
    ESP32_LEGACY_PLATFORM_PROFILE_SCHEMA,
    `${label} Platform migration`,
  );

  const board = exactRecord(boardValue, `${label} Board profile`, [
    'schema', 'id', 'board', 'sdkVersion', 'variant', 'options', 'artifactIds', 'overlay', 'image', 'flash',
    'platformRef', 'execution', 'migration',
  ]);
  if (board.schema !== ESP32_BOARD_PROFILE_SCHEMA
    || typeof board.id !== 'string' || !IDENTIFIER.test(board.id)
    || typeof board.board !== 'string' || !/^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(board.board)
    || typeof board.sdkVersion !== 'string' || !VERSION.test(board.sdkVersion)
    || typeof board.variant !== 'string' || !IDENTIFIER.test(board.variant)
    || !isPlainRecord(board.options)
    || !Array.isArray(board.artifactIds)) {
    fail(`${label} Board profile identity is invalid`);
  }
  validateCurrentPlatformRefShape(board.platformRef, true, label);
  const overlay = exactRecord(board.overlay, `${label} Board command overlay`, ['compile', 'link']);
  const compileOverlay = exactRecord(overlay.compile, `${label} compile Board overlay`, [
    'target', 'defines', 'memory', 'variant',
  ]);
  const linkOverlay = exactRecord(overlay.link, `${label} link Board overlay`, ['target', 'memory', 'flags']);
  for (const [name, values] of Object.entries({ ...compileOverlay, ...linkOverlay })) {
    if (!Array.isArray(values)) fail(`${label} Board overlay field is invalid: ${name}`);
  }
  const image = exactRecord(board.image, `${label} image profile`, ['flashMode', 'flashFrequency', 'flashSize']);
  const espSr16 = board.options.partition_scheme === ESP32_SR_PARTITION_SCHEME;
  const flashKeys = ['bootloader', 'partitions', 'bootApp0', 'offsets'];
  if (isPlainRecord(board.flash) && Object.hasOwn(board.flash, 'model')) flashKeys.push('model');
  const flash = exactRecord(board.flash, `${label} flash profile`, flashKeys);
  validateFlashOffsets(flash.offsets, label);
  const model = validateEspSrModelProfile(flash.model, label, espSr16);
  if (espSr16 && (board.options.flash_size !== ESP32_SR_FLASH_SIZE
    || image.flashSize !== ESP32_SR_FLASH_SIZE)) {
    fail(`${label} esp_sr_16 Board profile is invalid`);
  }
  if (model && board.board !== ESP32_S3_BOARD) fail(`${label} model profile is not supported`);
  const execution = exactRecord(board.execution, `${label} compiler execution`, [
    'targetTriple', 'targetArguments', 'elf',
  ]);
  exactRecord(execution.elf, `${label} compiler ELF execution`, ['machine', 'floatAbi']);
  validateProfileMigration(
    board.migration,
    ESP32_LEGACY_BOARD_PROFILE_SCHEMA,
    `${label} Board migration`,
  );
  return Object.freeze({ platform, board });
}

function validateCurrentCommandShape(value, phase, label) {
  const command = exactRecord(value, `${label} ${phase} Platform profile`, phase === 'compile'
    ? ['args', 'overlaySlots', 'source', 'object', 'artifactIds', 'languageFlags']
    : ['args', 'overlaySlots', 'object', 'elf', 'artifactIds']);
  if (!Array.isArray(command.args) || !Array.isArray(command.overlaySlots)
    || !Array.isArray(command.artifactIds)) {
    fail(`${label} ${phase} Platform profile fields are invalid`);
  }
  for (const slot of command.overlaySlots) {
    exactRecord(slot, `${label} ${phase} Platform overlay slot`, ['id', 'index']);
  }
  if (phase === 'compile') {
    const flags = exactRecord(command.languageFlags, `${label} compile language flags`, ['c', 'cxx', 'asm']);
    if (Object.values(flags).some((entries) => !Array.isArray(entries))) {
      fail(`${label} compile language flags are invalid`);
    }
  }
}

function validateCurrentPlatformRefShape(value, board, label) {
  const reference = exactRecord(
    value,
    `${label} ${board ? 'Board ' : ''}Platform reference`,
    board ? ['id', 'version', 'sha256', 'fqbn'] : ['id', 'version', 'sha256'],
  );
  if (typeof reference.id !== 'string' || !IDENTIFIER.test(reference.id)
    || typeof reference.version !== 'string' || !VERSION.test(reference.version)
    || !SHA256.test(reference.sha256)
    || (board && (typeof reference.fqbn !== 'string'
      || !/^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(reference.fqbn)))) {
    fail(`${label} Platform reference is invalid`);
  }
}

export function validateEsp32CurrentFlashLayout(boardProfile, manifest, label = 'ESP32') {
  const espSr16 = boardProfile?.options?.partition_scheme === ESP32_SR_PARTITION_SCHEME;
  const offsets = validateFlashOffsets(boardProfile?.flash?.offsets, label);
  const model = validateEspSrModelProfile(boardProfile?.flash?.model, label, espSr16);
  const boards = Array.isArray(manifest?.boards)
    ? manifest.boards.filter((board) => board?.fqbn === boardProfile?.board)
    : [];
  const manifestBoard = boards.length === 1 ? boards[0] : undefined;
  const bootloader = manifestBoard?.properties?.['build.bootloader_addr'];
  const mergeArguments = manifest?.platformProperties?.['recipe.hooks.objcopy.postobjcopy.3.pattern_args'];
  const partitionMenu = Array.isArray(manifestBoard?.menus)
    ? manifestBoard.menus.find((menu) => (
        typeof menu?.id === 'string'
        && menu.id.replace(/[^A-Za-z0-9]/g, '').toLowerCase() === 'partitionscheme'
      ))
    : undefined;
  const selectedPartition = Array.isArray(partitionMenu?.options)
    ? partitionMenu.options.find((option) => option?.id === boardProfile?.options?.partition_scheme)
    : undefined;
  const uploadExtraFlags = [
    manifestBoard?.properties?.['upload.extra_flags'],
    selectedPartition?.properties?.['upload.extra_flags'],
  ];
  const hasUploadExtraFlags = uploadExtraFlags.some((value) => (
    value !== undefined && (typeof value !== 'string' || value.trim().length > 0)
  ));
  const hasSrModelLayout = !espSr16 || (
    typeof mergeArguments === 'string'
    && mergeArguments.toLowerCase().includes(` ${ESP32_SR_MODEL_OFFSET} `)
    && mergeArguments.includes('srmodels.bin')
  );
  if (typeof bootloader !== 'string' || !/^0x[0-9a-f]+$/.test(bootloader)
    || typeof mergeArguments !== 'string'
    || !mergeArguments.includes('{build.bootloader_addr}')
    || !mergeArguments.includes(` ${ESP32_STATIC_FLASH_OFFSETS.partitions} `)
    || !mergeArguments.includes(` ${ESP32_STATIC_FLASH_OFFSETS.bootApp0} `)
    || hasUploadExtraFlags
    || !hasSrModelLayout) {
    fail(`${label} Platform Manifest flash layout is invalid`);
  }
  const expectedOffsets = {
    bootloader,
    ...ESP32_STATIC_FLASH_OFFSETS,
  };
  if (Object.keys(expectedOffsets).some((key) => offsets[key] !== expectedOffsets[key])) {
    fail(`${label} flash offsets do not match Platform Manifest`);
  }
  return Object.freeze({
    ...expectedOffsets,
    ...(model ? { model: model.offset } : {}),
  });
}

function validateCurrentSplitRuntimeProfile(
  platformValue,
  boardValue,
  target,
  currentPlatformManifest,
) {
  validateEsp32CurrentProfileShape(platformValue, boardValue, target.label);
  const platformKeys = [
    'schema', 'id', 'sdkVersion', 'platformManifestArtifact', 'compile', 'link',
    'platformRef', 'sdkVariant', 'recipeOrigins', 'recipeLowering', 'migration',
  ];
  const platform = exactRecord(platformValue, `${target.label} Platform profile`, platformKeys);
  if (typeof platform.id !== 'string' || !IDENTIFIER.test(platform.id)) fail(`${target.label} Platform profile id is invalid`);
  if (typeof platform.sdkVersion !== 'string' || !VERSION.test(platform.sdkVersion)) fail(`${target.label} Platform version is invalid`);

  const compileBase = validatePlatformCommandProfile(platform.compile, 'compile', {
    source: COMPILE_SOURCE,
    object: COMPILE_OBJECT,
  }, ['target', 'defines', 'memory', 'variant'], target.label);
  const linkBase = validatePlatformCommandProfile(platform.link, 'link', {
    object: COMPILE_OBJECT,
    elf: LINK_ELF,
  }, ['target', 'memory', 'flags'], target.label);
  assertBoardNeutralPlatformCommand(compileBase.args, 'compile', target);
  assertBoardNeutralPlatformCommand(linkBase.args, 'link', target);

  const boardKeys = [
    'schema', 'id', 'board', 'sdkVersion', 'variant', 'options', 'artifactIds', 'overlay', 'image', 'flash',
    'platformRef', 'execution', 'migration',
  ];
  const board = exactRecord(boardValue, `${target.label} Board profile`, boardKeys);
  if (typeof board.id !== 'string' || !IDENTIFIER.test(board.id)) fail(`${target.label} Board profile id is invalid`);
  if (board.board !== target.board) fail(`${target.label} Board profile targets an unexpected board`);
  if (board.sdkVersion !== platform.sdkVersion) fail(`${target.label} Board and Platform versions do not match`);
  if (typeof board.variant !== 'string' || !IDENTIFIER.test(board.variant)) fail(`${target.label} Board variant is invalid`);
  validateEsp32CurrentFlashLayout(board, currentPlatformManifest, target.label);

  const overlay = exactRecord(board.overlay, `${target.label} Board command overlay`, ['compile', 'link']);
  const compileOverlay = validateCommandOverlay(overlay.compile, compileBase.overlaySlots, 'compile', target.label);
  const linkOverlay = validateCommandOverlay(overlay.link, linkBase.overlaySlots, 'link', target.label);
  assertMatchingTargetOverlays(compileOverlay.target, linkOverlay.target, target.label);
  assertBoardDefinesOverlay(compileOverlay.defines, board, target);
  const compileMemory = singleOverlayMatch(
    compileOverlay.memory,
    /^-Isdk\/([A-Za-z0-9._+-]+)\/include$/,
    `${target.label} compile memory overlay`,
  );
  const linkMemory = singleOverlayMatch(
    linkOverlay.memory,
    /^-Lsdk\/([A-Za-z0-9._+-]+)$/,
    `${target.label} link memory overlay`,
  );
  if (compileMemory !== linkMemory) fail(`${target.label} Board memory overlays do not match`);
  if (compileOverlay.variant.length !== 1 || compileOverlay.variant[0] !== '-Ivariant') {
    fail(`${target.label} Board Variant overlay is invalid`);
  }

  const compile = applyValidatedCommandOverlay(compileBase, compileOverlay);
  const link = applyValidatedCommandOverlay(linkBase, linkOverlay);
  const platformManifest = currentPlatformManifest;
  const currentBinding = validateCurrentProfileBinding(
    platform,
    board,
    platformManifest,
    compileMemory,
    target,
  );
  const execution = validateCompilerExecution(
    board.execution,
    target.label,
  );
  assertRequiredArguments(compile.args, execution.targetArguments, 'compile', target.label);
  assertRequiredArguments(link.args, execution.targetArguments, 'link', target.label);
  const normalized = validateEsp32SdkProfileForTarget({
    schema: ESP32_C3_SDK_PROFILE_SCHEMA,
    id: platform.id,
    board: board.board,
    sdkVersion: platform.sdkVersion,
    platformManifest,
    options: board.options,
    compile,
    link,
    image: board.image,
    flash: board.flash,
    execution,
    boardPack: { artifactIds: board.artifactIds },
  }, target);
  return Object.freeze({
    ...normalized,
    variant: board.variant,
    ...currentBinding,
  });
}

function validatePlatformCommandProfile(value, phase, names, slotIds, label) {
  const keys = phase === 'compile'
    ? ['args', 'overlaySlots', 'source', 'object', 'artifactIds', 'languageFlags']
    : ['args', 'overlaySlots', 'object', 'elf', 'artifactIds'];
  const command = exactRecord(value, `${label} ${phase} Platform profile`, keys);
  const normalized = validateCommandProfile({
    args: command.args,
    ...(phase === 'compile'
      ? {
          source: command.source,
          object: command.object,
          languageFlags: command.languageFlags,
        }
      : { object: command.object, elf: command.elf }),
    artifactIds: command.artifactIds,
  }, phase, names, label);
  if (!Array.isArray(command.overlaySlots) || command.overlaySlots.length !== slotIds.length) {
    fail(`${label} ${phase} Platform overlay slots are invalid`);
  }
  let previousIndex = 0;
  const overlaySlots = command.overlaySlots.map((valueSlot, index) => {
    const slot = exactRecord(valueSlot, `${label} ${phase} Platform overlay slot`, ['id', 'index']);
    if (slot.id !== slotIds[index]
      || !Number.isSafeInteger(slot.index)
      || slot.index < 1
      || slot.index > normalized.args.length
      || slot.index <= previousIndex) {
      fail(`${label} ${phase} Platform overlay slot is invalid: ${String(slot.id)}`);
    }
    previousIndex = slot.index;
    return Object.freeze({ id: slot.id, index: slot.index });
  });
  return Object.freeze({ ...normalized, overlaySlots: Object.freeze(overlaySlots) });
}

function validateCommandOverlay(value, slots, phase, label) {
  const ids = slots.map(({ id }) => id);
  const overlay = exactRecord(value, `${label} ${phase} Board overlay`, ids);
  const normalized = {};
  let totalArguments = 0;
  let totalChars = 0;
  for (const id of ids) {
    const args = overlay[id];
    if (!Array.isArray(args) || args.length > MAX_COMMAND_ARGUMENTS) {
      fail(`${label} ${phase} Board overlay is invalid: ${id}`);
    }
    normalized[id] = Object.freeze(args.map((argument) => {
      if (typeof argument !== 'string'
        || !argument.startsWith('-')
        || argument.length > MAX_COMMAND_ARGUMENT_CHARS
        || /[\0\r\n]/.test(argument)) {
        fail(`${label} ${phase} Board overlay argument is invalid: ${id}`);
      }
      totalArguments++;
      totalChars += argument.length;
      return argument;
    }));
  }
  if (totalArguments > MAX_COMMAND_ARGUMENTS || totalChars > MAX_COMMAND_CHARS) {
    fail(`${label} ${phase} Board overlay exceeds its argument limit`);
  }
  return Object.freeze(normalized);
}

function applyValidatedCommandOverlay(command, overlay) {
  const slots = new Map(command.overlaySlots.map((slot) => [slot.index, slot]));
  const args = [];
  for (let index = 0; index <= command.args.length; index++) {
    const slot = slots.get(index);
    if (slot) args.push(...overlay[slot.id]);
    if (index < command.args.length) args.push(command.args[index]);
  }
  return Object.freeze({
    args: Object.freeze(args),
    ...(Object.hasOwn(command, 'source')
      ? { source: command.source, object: command.object }
      : { object: command.object, elf: command.elf }),
    ...(Object.hasOwn(command, 'languageFlags') ? { languageFlags: command.languageFlags } : {}),
    artifactIds: command.artifactIds,
  });
}

function assertBoardNeutralPlatformCommand(args, phase, target) {
  if (args.some((argument) => /^-(?:mcpu|march|mabi)=/.test(argument))) {
    fail(`${target.label} ${phase} Platform profile contains a board target argument`);
  }
  const boardArgument = phase === 'compile'
    ? (argument) => (
        /^-DF_CPU=/.test(argument)
        || (/^-DARDUINO_/.test(argument) && argument !== '-DARDUINO_ARCH_ESP32')
        || argument === '-Ivariant'
        || /^-Isdk\/[^/]+\/include$/.test(argument)
      )
    : (argument) => /^-Lsdk\/(?!lib$|lld-compat$|ld$)[^/]+$/.test(argument);
  if (args.some(boardArgument)) fail(`${target.label} ${phase} Platform profile contains a Board overlay argument`);
}

function assertMatchingTargetOverlays(compile, link, label) {
  if (!Array.isArray(compile) || !Array.isArray(link)
    || compile.length !== link.length
    || compile.some((argument, index) => argument !== link[index])
    || compile.some((argument) => !/^-(?:mcpu|march|mabi)=[A-Za-z0-9._+-]+$/.test(argument))) {
    fail(`${label} Board target overlays are invalid`);
  }
}

function validateCurrentProfileBinding(platform, board, manifest, memoryType, target) {
  const label = target.label;
  const manifestArtifact = validatePlatformManifestArtifactReference(platform.platformManifestArtifact, label);
  const platformRef = exactRecord(platform.platformRef, `${label} Platform reference`, ['id', 'version', 'sha256']);
  if (!isPlainRecord(manifest)
    || platformRef.id !== manifest.id || platformRef.version !== manifest.version
    || platformRef.sha256 !== manifest.sha256 || !SHA256.test(platformRef.sha256)) {
    fail(`${label} Platform reference does not match its Manifest`);
  }
  if (platform.sdkVersion !== platformRef.version) {
    fail(`${label} Platform profile version does not match its Manifest`);
  }
  const boardRef = exactRecord(board.platformRef, `${label} Board Platform reference`, [
    'id', 'version', 'sha256', 'fqbn',
  ]);
  if (boardRef.id !== platformRef.id || boardRef.version !== platformRef.version
    || boardRef.sha256 !== platformRef.sha256 || boardRef.fqbn !== board.board) {
    fail(`${label} Board Platform reference does not match its Manifest`);
  }
  const sdkVariant = exactRecord(platform.sdkVariant, `${label} SDK variant`, [
    'id', 'sdkTarget', 'memoryType', 'compilerPack',
  ]);
  const compilerPack = exactRecord(sdkVariant.compilerPack, `${label} SDK Compiler Pack`, [
    'id', 'version', 'sha256',
  ]);
  if (!IDENTIFIER.test(sdkVariant.id) || sdkVariant.sdkTarget !== target.sdkTarget
    || sdkVariant.memoryType !== memoryType || !IDENTIFIER.test(compilerPack.id)
    || !VERSION.test(compilerPack.version) || !SHA256.test(compilerPack.sha256)) {
    fail(`${label} SDK variant is invalid`);
  }
  const recipes = exactRecord(platform.recipeOrigins, `${label} recipe origins`, ['compile', 'link']);
  const contract = manifest.recipeLowering;
  if (!isPlainRecord(contract)
    || recipes.compile !== contract.bindings?.compile?.cxx
    || recipes.link !== contract.bindings?.link) {
    fail(`${label} recipe origins are invalid`);
  }
  const lowering = exactRecord(
    platform.recipeLowering,
    `${label} recipe lowering`,
    ['status', 'schemaVersion', 'sha256'],
  );
  if (lowering.status !== 'manifest-defined'
    || lowering.schemaVersion !== contract.schemaVersion
    || lowering.sha256 !== contract.sha256
    || !SHA256.test(lowering.sha256)) {
    fail(`${label} recipe lowering is invalid`);
  }
  const executorPathLayout = invertPlatformLogicalPathLayout(contract.paths.logicalToAction);
  validateProfileMigration(
    platform.migration,
    ESP32_LEGACY_PLATFORM_PROFILE_SCHEMA,
    `${label} Platform migration`,
  );
  validateProfileMigration(
    board.migration,
    ESP32_LEGACY_BOARD_PROFILE_SCHEMA,
    `${label} Board migration`,
  );
  return Object.freeze({
    platformRef: Object.freeze({ ...platformRef }),
    platformManifestArtifact: Object.freeze({ ...manifestArtifact }),
    sdkVariant: Object.freeze({
      id: sdkVariant.id,
      sdkTarget: sdkVariant.sdkTarget,
      memoryType: sdkVariant.memoryType,
      compilerPack: Object.freeze({ ...compilerPack }),
    }),
    recipeOrigins: Object.freeze({ ...recipes }),
    recipeLowering: Object.freeze({
      status: lowering.status,
      schemaVersion: lowering.schemaVersion,
      sha256: lowering.sha256,
    }),
    executorPathLayout: Object.freeze(executorPathLayout),
  });
}

function validateProfileMigration(value, legacySchema, label) {
  const migration = exactRecord(value, label, ['legacySchema', 'legacyArtifact']);
  if (migration.legacySchema !== legacySchema || migration.legacyArtifact !== 'profile') {
    fail(`${label} is invalid`);
  }
}

function assertBoardDefinesOverlay(args, board, target) {
  if (args.length < 5
    || !/^-DF_CPU=[A-Za-z0-9_]+$/.test(args[0])
    || !/^-DARDUINO_[A-Z0-9_]+$/.test(args[1])) {
    fail(`${target.label} Board defines overlay is invalid`);
  }
  const boardDefine = args[1].slice('-DARDUINO_'.length);
  if (args[2] !== `-DARDUINO_BOARD="${boardDefine}"`
    || args[3] !== `-DARDUINO_VARIANT="${board.variant}"`
    || args[4] !== `-DARDUINO_PARTITION_${board.options.partition_scheme}`
    || args.some((argument) => /^-DARDUINO=/.test(argument))
    || args.includes('-DARDUINO_ARCH_ESP32')
    || args.some((argument) => argument === '-DESP32' || argument.startsWith('-DESP32='))) {
    fail(`${target.label} Board defines overlay is invalid`);
  }
  if (board.options.cpu_freq !== undefined && args[0] !== `-DF_CPU=${board.options.cpu_freq}`) {
    fail(`${target.label} Board CPU overlay is invalid`);
  }
}

function singleOverlayMatch(args, pattern, label) {
  const match = args.length === 1 ? pattern.exec(args[0]) : null;
  if (!match) fail(`${label} is invalid`);
  return match[1];
}

async function loadArtifact(loader, id, expectedSize, label, expectedSha256) {
  if (typeof loader?.loadArtifact !== 'function') throw new TypeError(`${label} loader is invalid`);
  const loaded = await loader.loadArtifact(id);
  if (!isPlainRecord(loaded) || !isPlainRecord(loaded.artifact) || !(loaded.bytes instanceof Uint8Array)) {
    throw new Error(`${label} payload is invalid: ${id}`);
  }
  if (loaded.artifact.id !== id || !loaded.bytes.byteLength || loaded.artifact.size !== loaded.bytes.byteLength) {
    throw new Error(`${label} metadata does not match its verified bytes: ${id}`);
  }
  if (expectedSize !== undefined && loaded.bytes.byteLength !== expectedSize) {
    throw new Error(`${label} size does not match the SDK profile: ${id}`);
  }
  if (expectedSha256 !== undefined && await sha256Bytes(loaded.bytes) !== expectedSha256) {
    throw new Error(`${label} checksum does not match its Manifest: ${id}`);
  }
  return loaded;
}

async function loadStaticArtifacts(loader, flash, target) {
  const label = target.label;
  const offsets = validateFlashOffsets(flash.offsets, label);
  const model = validateEspSrModelProfile(flash.model, label, false);
  const definitions = [
    { id: flash.bootloader, name: 'bootloader.bin', offset: offsets.bootloader },
    { id: flash.partitions, name: 'partitions.bin', offset: offsets.partitions },
    { id: flash.bootApp0, name: 'boot_app0.bin', offset: offsets.bootApp0 },
    ...(model ? [{
      id: model.artifactId,
      name: 'srmodels.bin',
      offset: model.offset,
      expectedSize: model.size,
      maxSize: model.capacity,
    }] : []),
  ];
  const artifacts = [];
  for (const definition of definitions) {
    const loaded = await loadArtifact(
      loader,
      definition.id,
      definition.expectedSize,
      `${label} flash artifact`,
    );
    if (definition.maxSize !== undefined && loaded.bytes.byteLength > definition.maxSize) {
      throw new Error(`${label} model artifact exceeds the esp_sr_16 allocation: ${definition.id}`);
    }
    artifacts.push({
      name: definition.name,
      offset: definition.offset,
      bytes: ownBytes(loaded.bytes, `${label} ${definition.name}`),
    });
  }
  return artifacts;
}

async function invokeRunClang({
  runClang,
  args,
  files,
  environment,
  phase,
  label,
  processed,
  sourceName,
  diagnosticFiles,
  diagnosticDefaultName,
}) {
  const capture = compilerOutputCapture();
  let output;
  let caught;
  try {
    output = await runClang(args, files, {
      stdout: (bytes) => capture.push(bytes),
      stderr: (bytes) => capture.push(bytes),
      environment: environment ?? {},
    });
  } catch (error) {
    caught = error;
    capture.pushError(error);
  }
  const diagnostics = parseEsp32C3CompilerDiagnostics(
    capture.text(),
    processed,
    sourceName,
    diagnosticFiles,
    diagnosticDefaultName,
  );
  const errorDiagnostic = diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  if (caught) {
    if (errorDiagnostic) return { output: null, diagnostics, failure: errorDiagnostic.message };
    const capturedOutput = capture.text();
    const capturedTail = capturedOutput.length > 768
      ? `[compiler output tail]\n${capturedOutput.slice(-768)}`
      : capturedOutput;
    throw runtimeError(
      'compiler_runtime',
      `${label} ${phase} runtime failed without a compiler diagnostic: ${errorMessage(caught)}`
        + (capturedTail ? `\n${capturedTail}` : ''),
      caught,
    );
  }
  if (errorDiagnostic) return { output: null, diagnostics, failure: errorDiagnostic.message };
  if (!isPlainRecord(output)) {
    throw runtimeError('compiler_runtime', `${label} ${phase} returned no virtual file tree`);
  }
  return { output, diagnostics, failure: null };
}

function compilerOutputCapture() {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  const pushText = (value) => {
    if (!value || bytes >= MAX_COMPILER_OUTPUT_BYTES) { if (value) truncated = true; return; }
    const encoded = new TextEncoder().encode(String(value));
    const length = Math.min(encoded.byteLength, MAX_COMPILER_OUTPUT_BYTES - bytes);
    chunks.push(new TextDecoder('utf-8', { fatal: false }).decode(encoded.subarray(0, length)));
    bytes += length;
    if (length < encoded.byteLength) truncated = true;
  };
  return {
    push(value) {
      if (value == null) return;
      if (value instanceof Uint8Array) {
        const length = Math.min(value.byteLength, Math.max(0, MAX_COMPILER_OUTPUT_BYTES - bytes));
        if (length) chunks.push(new TextDecoder('utf-8', { fatal: false }).decode(value.subarray(0, length)));
        bytes += length;
        if (length < value.byteLength) truncated = true;
      } else {
        pushText(value);
      }
    },
    pushError(error) {
      if (Array.isArray(error?.stderr)) pushText(error.stderr.join('\n'));
      pushText(error?.message);
    },
    text() { return `${chunks.join('')} ${truncated ? '\n[compiler output truncated]' : ''}`.trim(); },
  };
}

function validatePreprocessedSketch(value, sourceName, label) {
  if (
    !isPlainRecord(value)
    || typeof value.cpp !== 'string'
    || !value.cpp.length
    || value.sourceName !== sourceName
    || !Number.isSafeInteger(value.sourceLineCount)
    || value.sourceLineCount < 1
  ) throw runtimeError('preprocess_runtime', `${label} sketch preprocessor returned an invalid result`);
  return value;
}

function treeBinaryFile(tree, path, label) {
  const value = treeFile(tree, path);
  if (!(value instanceof Uint8Array) || !value.byteLength || value.byteLength > MAX_ELF_BYTES) {
    throw runtimeError('compiler_runtime', `${label} is missing or invalid: ${path}`);
  }
  return ownBytes(value, label);
}

function treeFile(tree, path) {
  let value = tree;
  for (const segment of path.split('/')) {
    if (!isPlainRecord(value) || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function deleteTreeFile(tree, path) {
  const segments = path.split('/');
  const leaf = segments.pop();
  let directory = tree;
  for (const segment of segments) {
    if (!isPlainRecord(directory) || !Object.hasOwn(directory, segment)) return;
    directory = directory[segment];
  }
  if (isPlainRecord(directory) && leaf) delete directory[leaf];
}

function putTreeFile(tree, path, value) {
  const segments = path.split('/');
  const leaf = segments.pop();
  let directory = tree;
  for (const segment of segments) {
    const current = directory[segment];
    if (current === undefined) {
      const created = {};
      directory[segment] = created;
      directory = created;
    } else if (isPlainRecord(current)) {
      directory = current;
    } else {
      throw new Error(`ESP32-C3 VFS path conflicts with a file: ${path}`);
    }
  }
  if (!leaf || Object.hasOwn(directory, leaf)) throw new Error(`ESP32-C3 VFS path is duplicated: ${path}`);
  directory[leaf] = value;
}

function assertEsp32Elf(bytes, expectedType, target, label) {
  if (bytes.byteLength < 52 || bytes.byteLength > MAX_ELF_BYTES) fail(`${label} has an invalid ELF size`);
  if (
    bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46
    || bytes[4] !== 1 || bytes[5] !== 1 || bytes[6] !== 1
  ) fail(`${label} is not ELF32 little-endian version 1`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(16, true) !== expectedType || view.getUint16(18, true) !== target.elfMachine) {
    const machine = target.elfMachine === 243 ? 'EM_RISCV' : 'EM_XTENSA';
    fail(`${label} is not the expected ELF32 ${machine} type`);
  }
  if (target.elfMachine === 243) {
    const flags = view.getUint32(36, true);
    if ((flags & 0x1) === 0 || (flags & 0x6) !== target.elfFloatAbi || (flags & 0x8) !== 0) {
      fail(`${label} has an unexpected RISC-V ABI`);
    }
  }
  if (expectedType === 2 && view.getUint32(24, true) === 0) fail(`${label} has a null entry point`);
}

function pushDiagnostic(target, value) {
  if (target.length >= MAX_DIAGNOSTICS) return;
  const message = String(value.message || '').trim().slice(0, MAX_DIAGNOSTIC_CHARS);
  if (!message) return;
  target.push({ ...value, message });
}

function diagnosticSeverity(value) {
  if (value === 'warning') return 'warning';
  if (value === 'note') return 'info';
  return 'error';
}

function ownBytes(value, label) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be Uint8Array bytes`);
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytes;
}

function exactRecord(value, label, keys) {
  if (!isPlainRecord(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  if (actual.length !== keys.length || actual.some((key) => !allowed.has(key))) {
    fail(`${label} has an invalid shape`);
  }
  return value;
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function basename(value) {
  const path = String(value);
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index === -1 ? path : path.slice(index + 1);
}

function boundedRange(total, offset, length) {
  return Number.isSafeInteger(offset)
    && Number.isSafeInteger(length)
    && offset >= 0
    && length >= 0
    && offset <= total
    && length <= total - offset;
}

function elfSectionName(table, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= table.byteLength) {
    throw runtimeError('image_layout', 'ESP32-C3 ELF section name offset is invalid');
  }
  let end = offset;
  while (end < table.byteLength && table[end] !== 0) end++;
  if (end === table.byteLength) {
    throw runtimeError('image_layout', 'ESP32-C3 ELF section name is not terminated');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(table.subarray(offset, end));
  } catch {
    throw runtimeError('image_layout', 'ESP32-C3 ELF section name is invalid UTF-8');
  }
}

function runtimeError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function errorMessage(error) {
  return String(error?.message ?? error ?? 'ESP32-C3 compiler failed').trim().slice(0, MAX_DIAGNOSTIC_CHARS);
}

function fail(message) {
  throw new Error(message);
}
