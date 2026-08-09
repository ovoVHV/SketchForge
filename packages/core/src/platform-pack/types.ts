import type { Sha256 } from '../build-ir/types.js';

export const CK_PLATFORM_PACK_KIND = 'ck-platform-pack' as const;
export const CK_PLATFORM_PACK_SCHEMA_VERSION = 2 as const;
export const CK_RECIPE_LOWERING_SCHEMA_VERSION = 2 as const;
export const CK_PLATFORM_PROFILE_SCHEMA_VERSION = 5 as const;
export const CK_BOARD_PROFILE_SCHEMA_VERSION = 4 as const;
export const CK_LEGACY_PLATFORM_PROFILE_SCHEMA_VERSION = 4 as const;
export const CK_LEGACY_BOARD_PROFILE_SCHEMA_VERSION = 3 as const;
export const CK_PLATFORM_PROFILE_ARTIFACT_ID = 'profile-v5' as const;
export const CK_BOARD_PROFILE_ARTIFACT_ID = 'profile-v4' as const;
export const CK_LEGACY_PROFILE_ARTIFACT_ID = 'profile' as const;
export const CK_PLATFORM_MANIFEST_ARTIFACT_ID = 'platform-manifest' as const;

export interface ArduinoPropertyEntry {
  key: string;
  value: string;
  line: number;
}

export interface ArduinoPropertyFile {
  entries: ArduinoPropertyEntry[];
  properties: Record<string, string>;
}

export interface PlatformRecipe {
  id: string;
  argv: string[];
  /** Placeholders referenced by argv, without surrounding braces. */
  placeholders: string[];
}

export interface PlatformMenuOption {
  id: string;
  label: string;
  properties: Record<string, string>;
}

export interface PlatformMenu {
  id: string;
  label: string;
  default: string;
  options: PlatformMenuOption[];
}

export interface PlatformBoard {
  id: string;
  fqbn: string;
  name: string;
  core: string;
  variant: string;
  properties: Record<string, string>;
  menus: PlatformMenu[];
}

export interface PlatformProgrammer {
  id: string;
  name: string;
  properties: Record<string, string>;
}

export type PlatformFileRole = 'core' | 'variant' | 'config' | 'other';

export interface PlatformFileEntry {
  path: string;
  role: PlatformFileRole;
  size: number;
  sha256: Sha256;
}

export interface PlatformToolRequirement {
  id: string;
  version: string;
  sha256: Sha256;
}

/**
 * Source builders verify every concrete Arduino `runtime.tools.*` reference.
 * A publisher may opt into `ck-transformed` only when those recipes are
 * lowered to CK Actions and `tools` contains the immutable CK Pack bindings
 * that the emitted plan will actually execute.
 */
export type PlatformRuntimeToolPolicy =
  | 'require-source-metadata'
  | 'ck-transformed'
  | 'deferred-ck-binding';

export interface CKPlatformLogicalPathLayout {
  exact: Readonly<Record<string, string>>;
  prefixes: Readonly<Record<string, string>>;
}

export type CKPlatformCompilerRuntimeIncludeRole =
  | 'cxx'
  | 'cxx-target'
  | 'cxx-backward'
  | 'gcc'
  | 'gcc-fixed'
  | 'sysroot';

export type CKPlatformArchiveArgumentPart = 'operation' | 'output' | 'inputs' | 'flags';
export type CKPlatformSdkArchiveRewrite = 'strip-debug' | 'deterministic-archives';

export interface CKPlatformRecipeLoweringBody {
  schemaVersion: typeof CK_RECIPE_LOWERING_SCHEMA_VERSION;
  bindings: Readonly<{
    compile: Readonly<{
      c: string;
      cxx: string;
      asm: string;
    }>;
    archive: string;
    link: string;
  }>;
  paths: Readonly<{
    logicalToAction: CKPlatformLogicalPathLayout;
  }>;
  responseFiles: Readonly<{
    marker: '@';
    roles: Readonly<{
      compiler: string;
      linker: string;
    }>;
    languageFiles: Readonly<{
      c: string;
      cxx: string;
      asm: string;
    }>;
  }>;
  compatibility: Readonly<{
    compiler: Readonly<{
      disableBuiltinCxxIncludes: boolean;
      runtimeIncludes: readonly Readonly<{
        role: CKPlatformCompilerRuntimeIncludeRole;
        flag: '-isystem';
      }>[];
    }>;
    linker: Readonly<{
      searchPaths: readonly string[];
      responseFiles: readonly string[];
      runtimeLibraryDirectories: 'all' | 'none';
      forceLldTargetPrefixes: readonly string[];
    }>;
  }>;
  archive: Readonly<{
    command: 'ar';
    operation: 'rcs';
    argumentOrder: readonly ['operation', 'output', 'inputs', 'flags'];
  }>;
  publication: Readonly<{
    sdkArchiveRewrites: readonly CKPlatformSdkArchiveRewrite[];
  }>;
}

export interface CKPlatformRecipeLowering extends CKPlatformRecipeLoweringBody {
  sha256: Sha256;
}

interface CKPlatformManifestBase {
  kind: typeof CK_PLATFORM_PACK_KIND;
  id: string;
  version: string;
  vendor: string;
  architecture: string;
  sha256: Sha256;
  platformProperties: Record<string, string>;
  recipes: PlatformRecipe[];
  boards: PlatformBoard[];
  programmers: PlatformProgrammer[];
  tools: PlatformToolRequirement[];
  files: PlatformFileEntry[];
}

export interface CKPlatformManifest extends CKPlatformManifestBase {
  schemaVersion: typeof CK_PLATFORM_PACK_SCHEMA_VERSION;
  recipeLowering: CKPlatformRecipeLowering;
}

export interface CKPlatformManifestReference {
  id: string;
  version: string;
  sha256: Sha256;
}

export interface CKPlatformBoardReference extends CKPlatformManifestReference {
  fqbn: string;
}

export interface CKCompilerExecutionMetadata {
  targetTriple: string;
  targetArguments: readonly string[];
  elf: Readonly<{
    machine: number;
    floatAbi: number;
  }>;
}

export interface CKPlatformCommandProfile {
  args: readonly string[];
  overlaySlots: readonly Readonly<{ id: string; index: number }>[];
  artifactIds: readonly string[];
}

export interface CKPlatformProfileV5 {
  readonly schema: typeof CK_PLATFORM_PROFILE_SCHEMA_VERSION;
  readonly id: string;
  readonly sdkVersion: string;
  readonly compile: CKPlatformCommandProfile & Readonly<{
    source: string;
    object: string;
    languageFlags: Readonly<{
      c: readonly string[];
      cxx: readonly string[];
      asm: readonly string[];
    }>;
  }>;
  readonly link: CKPlatformCommandProfile & Readonly<{
    object: string;
    elf: string;
  }>;
  readonly platformRef: CKPlatformManifestReference;
  readonly platformManifestArtifact: Readonly<{
    id: typeof CK_PLATFORM_MANIFEST_ARTIFACT_ID;
    sha256: Sha256;
  }>;
  readonly sdkVariant: Readonly<{
    id: string;
    sdkTarget: string;
    memoryType: string;
    compilerPack: PlatformToolRequirement;
  }>;
  readonly recipeOrigins: Readonly<{
    /** The shared compile command originates from recipeLowering.bindings.compile.cxx. */
    compile: string;
    link: string;
  }>;
  readonly recipeLowering: Readonly<{
    status: 'manifest-defined';
    schemaVersion: typeof CK_RECIPE_LOWERING_SCHEMA_VERSION;
    sha256: Sha256;
  }>;
  readonly migration: Readonly<{
    legacySchema: typeof CK_LEGACY_PLATFORM_PROFILE_SCHEMA_VERSION;
    legacyArtifact: typeof CK_LEGACY_PROFILE_ARTIFACT_ID;
  }>;
}

export interface CKLegacyBoardProfileV3 {
  schema: typeof CK_LEGACY_BOARD_PROFILE_SCHEMA_VERSION;
  id: string;
  board: string;
  sdkVersion: string;
  variant: string;
  options: Readonly<Record<string, string>>;
  artifactIds: readonly string[];
  overlay: Readonly<{
    compile: Readonly<Record<string, readonly string[]>>;
    link: Readonly<Record<string, readonly string[]>>;
  }>;
  image: Readonly<{
    flashMode: string;
    flashFrequency: string;
    flashSize: string;
  }>;
  flash: Readonly<{
    bootloader: string;
    partitions: string;
    bootApp0: string;
  }>;
}

export interface CKBoardProfileV4 {
  readonly schema: typeof CK_BOARD_PROFILE_SCHEMA_VERSION;
  readonly id: string;
  readonly board: string;
  readonly sdkVersion: string;
  readonly variant: string;
  readonly platformRef: CKPlatformBoardReference;
  readonly options: Readonly<Record<string, string>>;
  readonly artifactIds: readonly string[];
  readonly overlay: Readonly<{
    compile: Readonly<Record<string, readonly string[]>>;
    link: Readonly<Record<string, readonly string[]>>;
  }>;
  readonly execution: CKCompilerExecutionMetadata;
  readonly image: Readonly<{
    flashMode: string;
    flashFrequency: string;
    flashSize: string;
  }>;
  readonly flash: Readonly<{
    bootloader: string;
    partitions: string;
    bootApp0: string;
    /** Optional immutable model artifact and its reserved Flash region. */
    model?: Readonly<{
      artifactId: string;
      offset: string;
      size: number;
      capacity: number;
    }>;
    offsets: Readonly<{
      bootloader: string;
      partitions: string;
      bootApp0: string;
    }>;
  }>;
  readonly migration: Readonly<{
    legacySchema: typeof CK_LEGACY_BOARD_PROFILE_SCHEMA_VERSION;
    legacyArtifact: typeof CK_LEGACY_PROFILE_ARTIFACT_ID;
  }>;
}

export interface PlatformSourceFile {
  path: string;
  content: string | Uint8Array;
  role?: PlatformFileRole;
}

export interface CreatePlatformManifestInput {
  id: string;
  version: string;
  vendor: string;
  architecture: string;
  platformText: string;
  boardsText: string;
  programmersText?: string;
  files?: PlatformSourceFile[];
  tools?: PlatformToolRequirement[];
  runtimeToolPolicy?: PlatformRuntimeToolPolicy;
  recipeLowering?: Omit<CKPlatformRecipeLoweringBody, 'schemaVersion'> & Readonly<{
    schemaVersion?: typeof CK_RECIPE_LOWERING_SCHEMA_VERSION;
  }>;
}

export interface ResolvePlatformManifestInput {
  manifest: CKPlatformManifest;
  fqbn: string;
  options?: Record<string, string>;
}

export interface ResolvedPlatformManifest {
  manifestSha256: Sha256;
  id: string;
  version: string;
  vendor: string;
  architecture: string;
  board: PlatformBoard;
  options: Record<string, string>;
  properties: Record<string, string>;
  /** Recipes with manifest, board, and selected menu properties recursively expanded. */
  resolvedRecipes: PlatformRecipe[];
  recipeLowering: CKPlatformRecipeLowering;
}
