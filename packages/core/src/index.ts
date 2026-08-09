export * from './types.js';
export {
  DeadlineExceededError,
  OperationCancelledError,
  deadlineRemainingMs,
  interruptionError,
  interruptionReason,
  isDeadlineExceededError,
  isOperationCancelledError,
  raceWithDeadline,
  throwIfInterrupted,
  type DeadlineOptions,
  type InterruptionReason,
} from './deadline.js';
export { preprocess, normalizeSource, GENERATED_FILE } from './preprocess/index.js';
export { scanFunctions, type FunctionDef } from './preprocess/functions.js';
export { scan, type ScanResult } from './preprocess/scanner.js';
export { parseDiagnostics, type RemapContext } from './diagnostics/parse.js';
export { createSanitizer, identitySanitizer, type Sanitizer } from './diagnostics/sanitize.js';
export { precheck, type PrecheckResult, type PrecheckFinding } from './security/precheck.js';
export * from './sandbox/types.js';
export { LocalExecutor } from './sandbox/local.js';
export { NsjailExecutor, type NsjailOptions } from './sandbox/nsjail.js';
export { BubblewrapExecutor, type BubblewrapOptions } from './sandbox/bubblewrap.js';
export {
  selfTestSandbox, formatSelfTest,
  type SelfTestResult, type SelfTestCheck,
} from './sandbox/selftest.js';
export {
  BoardRegistry, resolveOptions, unsupportedOptionErrors, buildOptions,
  type BoardDefinition,
} from './toolchain/board.js';
export {
  detectLocalToolchain, describeToolchain, toolPath,
  type ToolchainConfig, type ArchToolchain,
} from './toolchain/config.js';
export { AvrToolchain, parseAvrSize, type AvrBuildResult } from './toolchain/avr.js';
export {
  Esp32Toolchain, esp32BoardSupported, esp32PartitionToolInvocation,
  parseEsp32Size, resolveEsp32BuildProfile, toolchainParallelismFromEnv,
  type Esp32BuildResult, type Esp32BuildProfile, type Esp32PartitionToolInvocation,
  type Esp32StageReporter, type Esp32ArchiveProgress,
} from './toolchain/esp32.js';
export {
  ESP32_PARTITION_ENTRY_SIZE,
  ESP32_PARTITION_TABLE_OFFSET,
  ESP32_PARTITION_TABLE_SECTOR_SIZE,
  ESP32_PARTITION_BINARY_DATA_SIZE,
  ESP32_PARTITION_BINARY_SIZE,
  ESP32_PARTITION_MD5_ENTRY_SIZE,
  ESP32_PARTITION_MAX_ENTRIES,
  ESP32_PARTITION_MAX_CSV_BYTES,
  ESP32_PARTITION_MAX_LINE_BYTES,
  ESP32_PARTITION_MAX_LINES,
  ESP32_PARTITION_MIN_FLASH_SIZE,
  ESP32_PARTITION_MAX_FLASH_SIZE,
  Esp32PartitionCsvError,
  parseEsp32PartitionCsv,
  encodeEsp32PartitionTable,
  encodeEsp32PartitionCsv,
  type Esp32PartitionCsvSource,
  type Esp32PartitionCsvOptions,
  type Esp32PartitionFlag,
  type Esp32PartitionEntry,
  type Esp32PartitionTable,
  type Esp32PartitionTableCompilation,
} from './esp32/partition-table.js';
export {
  ESP32_CUSTOM_PARTITIONS_FILE,
  ESP32_CUSTOM_PARTITIONS_SCHEMA_VERSION,
  ESP32_CUSTOM_PARTITIONS_MAX_BYTES,
  ESP32_APPLICATION_FLASH_OFFSET_BYTES,
  Esp32CustomPartitionsError,
  assertEsp32ApplicationFitsSlot,
  projectSnapshotSha256,
  resolveEsp32ApplicationSlot,
  resolveCustomEsp32Partitions,
  type Esp32ApplicationSlot,
  type Esp32CustomPartitionsOptions,
  type Esp32CustomPartitionsErrorCode,
  type Esp32CustomPartitionsErrorDetails,
  type Esp32CustomPartitionInput,
  type ProjectSnapshotHashFile,
} from './esp32/custom-partitions.js';
export {
  LibraryRegistry, loadLibrary, parseManifest,
  type Library, type LibraryManifest, type ResolveResult,
} from './toolchain/library.js';
export {
  FileL0Cache, computeCacheKey, normalizeForCache,
  type CacheKeyInput, type CachedEntry,
} from './cache/l0.js';
export {
  CompileService, validateCompileRequest,
  MAX_SOURCE_BYTES, MAX_COMPILE_REQUEST_BYTES, MAX_PROJECT_FILES,
  type CompileServiceOptions, type CompileRequestValidationResult,
} from './compile.js';
export {
  fingerprintCompileRequest,
  type CompileRequestFingerprint,
} from './request-fingerprint.js';
export {
  parseEsp32PrewarmBoardAllowlist,
  selectEsp32PrewarmBoards,
  resolveEsp32PrewarmCacheDir,
  isSafeEsp32PrewarmCacheDir,
  type Esp32PrewarmBoard,
  type Esp32PrewarmSelection,
} from './prewarm.js';
export {
  parsePrebuildShard, planPrebuildMatrix, selectPrebuildShard,
  type PrebuildShard,
  type PrebuildMatrixEntry,
  type PrebuildMatrixKind,
} from './prebuild.js';

// ---- 库导入流水线 ----
export {
  parseRepoUrl, resolveCommit, downloadArchive, fetchLibraryArchive,
  LibraryFetchError, MAX_ARCHIVE_BYTES, MAX_REPOSITORY_LENGTH, MAX_REF_LENGTH,
  type RepoRef, type FetchedArchive,
} from './library/fetch.js';
export {
  extractTarGz, safeEntryPath, ExtractError, DEFAULT_EXTRACT_LIMITS,
  type ExtractLimits, type ExtractResult,
} from './library/extract.js';
export {
  runHardGates, scanForReview, sanitizeTree,
  type GateRejection, type HardGateResult, type ReviewReport,
  type ReviewFinding, type ReviewSeverity,
} from './library/gates.js';
export {
  LibraryStore, DEFAULT_QUOTA,
  type StoredLibrary, type StoreQuota,
} from './library/store.js';
export {
  importLibrary,
  type ImportOptions, type ImportResult, type TrialCompiler, type TrialCompileResult,
} from './library/import.js';
export {
  CK_LIBRARY_CATALOG_SCHEMA, CK_LIBRARY_CATALOG_MAX_SELECTIONS,
  LibraryCatalog, catalogVersionFromIndex, createArduinoCommonLibraryCatalog,
  type LibraryCatalogSource, type LibraryCatalogDependency, type LibraryCatalogVersion,
  type LibraryCatalogEntry, type LibraryCatalogRef, type LibraryCatalogResolution,
  type LibraryCatalogQuery, type ArduinoLibraryIndexRecord,
} from './library/catalog.js';

// ---- Library blocks metadata and deterministic Blockly generation ----
export {
  CK_BLOCKS_KIND, CK_BLOCKS_SCHEMA,
  createBlocksMetadata, parseBlocksMetadata, publicBlocksMetadata, validateBlocksMetadata,
  type BlockCodeTemplate, type BlockCodeUnit, type BlockDropdownOption, type BlockEvidence,
  type BlockEvidenceKind, type BlockInputDefinition, type BlockInputKind,
  type BlocksMetadata, type BlocksMetadataBody, type BlocksReview, type BlocksReviewStatus,
  type BlocksValidationResult, type LibraryBlockDefinition,
} from './blocks/schema.js';
export {
  BLOCKS_METADATA_FILE, readBlocksMetadata, writeBlocksMetadata,
} from './blocks/storage.js';
export {
  collectLibraryBlocks, libraryBlocksSourceSha256, reviewBlocksMetadata,
  type CollectLibraryBlocksOptions,
} from './blocks/collector.js';
export {
  assembleBlockProgram, canonicalBlockVariableName, createBlocklyLibraryBundle,
  type AssembledBlockProgram, type BlocklyBlockLike, type BlocklyGenerationOptions,
  type BlocklyGeneratorLike, type BlocklyJsonDefinition, type BlocklyLibraryBundle,
  type BlocklyToolboxCategory, type GeneratedCodeFragment, type GeneratedSourceRange,
} from './blocks/generator.js';

// ---- Browser-safe cached firmware patching and device VM payloads ----
export * from './firmware/index.js';
export {
  CK_FEATURED_PREBUILD_KIND, CK_FEATURED_PREBUILD_SCHEMA,
  parseFeaturedPrebuildSpec, planFeaturedPrebuildMatrix,
  type FeaturedLibraryCombination, type FeaturedLibraryRef, type FeaturedPrebuildEntry,
  type FeaturedPrebuildSpec, type FeaturedPrebuildTarget,
} from './featured-prebuild.js';

// ---- CK Build IR ----
export * from './build-ir/types.js';
export { canonicalJson, hashJson, sha256Hex } from './build-ir/canonical.js';
/** Type-only compatibility surface. The production planner is ck-build-core Rust. */
export type {
  BuildPlannerInput, BuildActionPlan, PlannerSourceTree, PlannerPlatformInput,
  PlannerLibraryInput, PlannerToolNames, PlannerTransformSpec, PlannerCompilerFlags,
} from './build-ir/planner.js';
export {
  CK_ESP32_POST_LINK_CONTRACT_SCHEMA_VERSION,
  CK_BROWSER_PLATFORM_PATH_LAYOUT,
  deriveEsp32PostLinkContract,
  invertPlatformLogicalPathLayout,
  lowerEsp32PostLinkTransforms,
  lowerPlatformBuildCommands,
  resolvePlatformLogicalPath,
  type PlatformCompileCommand,
  type PlatformLinkCommand,
  type PlatformCommandPathLayout,
  type LowerPlatformBuildCommandsInput,
  type LoweredPlatformBuildCommands,
  type CKEsp32PostLinkToolBindings,
  type CKEsp32PostLinkBindings,
  type CKEsp32PostLinkContract,
  type CKEsp32PostLinkContractBody,
  type CKEsp32PostLinkContractSource,
  type CKEsp32PostLinkOperation,
  type CKEsp32PostLinkProduct,
  type CKEsp32PostLinkProductId,
  type CKHexOffset,
  type CKPostLinkActionOutputInput,
  type CKPostLinkImmutableInput,
  type CKPostLinkImmutableProvenance,
  type CKPostLinkInput,
  type CKPostLinkPackIdentity,
  type CKPostLinkPackArtifactManifest,
  type DeriveEsp32PostLinkContractInput,
} from './build-ir/platform-planning.js';

// ---- CK Executor Adapters ----
export * from './executor/types.js';
export { MemoryActionCache } from './executor/cache.js';
export { FileActionCache, type FileActionCacheOptions } from './executor/file-cache.js';
export {
  CK_NATIVE_EXECUTOR_POLICY_IDENTITY, NativeExecutor, parseGccDiagnostics,
  type NativeExecutorOptions, type NativePackProvider, type NativeToolResolver,
  type NativeActionRunnerContext, type NativeActionRunnerResult,
} from './executor/native.js';
export {
  FileSystemNativePackProvider, NativePackProviderImpl,
  DefaultNativeToolResolver, NativeToolResolverImpl,
  createNativePackProvider, createNativeToolResolver, createNativeToolIntegrityManifest,
  createNativeToolClosureManifest, nativeToolIntegrityIdentity,
  type NativePackSource, type NativePackFile, type NativePackProviderOptions,
  type NativePackCasLimits, type NativePackCasPruneResult,
  type NativeToolResolverOptions, type NativeToolIntegrity, type NativeToolIntegrityManifest,
  type NativeToolClosureFile, type NativeToolClosureIdentity, type NativeToolClosureManifest,
  type NativePythonInterpreter,
} from './executor/native-packs.js';

// ---- CK Platform Pack ----
export * from './platform-pack/types.js';
export { parseArduinoProperties } from './platform-pack/properties.js';
export {
  createPlatformManifest, createPlatformRecipeLowering, tokenizeRecipe,
  validatePlatformManifest, validateRecipeLowering,
} from './platform-pack/builder.js';
export {
  derivePlatformRecipeCommands,
  expandPlatformProperty,
  hasPlatformPropertyDependency,
  type DerivePlatformRecipeCommandsInput,
  type DerivedPlatformRecipeCommands,
  type ExpandedPlatformRecipeArgument,
  type PlatformCompileLanguage,
} from './platform-pack/recipe-command-lowering.js';
export {
  discoverLocalLibraryExternalDependencies,
  resolveLocalLibraries,
  type LocalLibraryDependencyRequest,
  type LocalLibraryResolution,
  type LocalLibrarySource,
} from './build-ir/local-libraries.js';
export {
  resolveProject,
  resolveTarget,
  resolvePlatform,
  resolvePlatformManifest,
  resolveLibraries,
  createActionGraph,
  createBuildIR,
  planBuildActions,
  planBuildIR,
  calculateActionKeys,
  normalizeBuildIR,
  migrateBuildIR,
  serializeBuildIR,
  mapDiagnostics,
  validateBuildIR,
  planBuildIRWithRust,
  resolvePlatformManifestWithRust,
  validateBuildIRWithRust,
} from './build-ir/rust-planner.js';
