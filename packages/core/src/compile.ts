/**
 * 编译编排 —— 把预处理、安全预检、缓存、工具链、诊断串成一条流水线。
 *
 * 流程：
 *   校验 → 安全预检 → L0 缓存 → 预处理 → 沙箱编译 → 诊断映射 → 产物 → 回填缓存
 *
 * 注意 `onEvent` 回调：诊断是**边编译边推**的独立事件，不是最后一次性返回。
 * 这样前端可以在编译还没结束时就把红波浪线画上去。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

import type {
  CompileRequest, CompileResult, CompileEvent, CompileStage, Diagnostic, Artifact, SourceFile,
} from './types.js';
import { composeArduinoSketchSource, preprocess } from './preprocess/index.js';
import { precheck } from './security/precheck.js';
import {
  BoardRegistry, resolveOptions, unsupportedOptionErrors,
  buildOptions as legacyBuildOptions, applyOptions,
  type BoardDefinition,
} from './toolchain/board.js';
import type { ToolchainConfig } from './toolchain/config.js';
import { resolveEsp32BuildProfile } from './toolchain/esp32.js';
import { LibraryRegistry, type Library } from './toolchain/library.js';
import type { SandboxExecutor } from './sandbox/types.js';
import type { FileL0Cache } from './cache/l0.js';
import {
  contentIdentityAsync,
  libraryIdentity,
  nativeToolchainPackIdentityAsync,
} from './cache/identity.js';
import { canonicalJson, sha256Hex } from './build-ir/canonical.js';
import {
  interruptionReason,
  isDeadlineExceededError,
  isOperationCancelledError,
  raceWithDeadline,
  throwIfInterrupted,
  type InterruptionReason,
} from './deadline.js';
import type {
  ActionInput,
  ActionPackInput,
  BoardPackRef,
  BuildAction,
  BuildIR,
  LibraryPackRef,
  PlatformPackRef,
  Sha256,
} from './build-ir/types.js';
import {
  planBuildIRWithRust,
  resolvePlatformManifestWithRust,
  validateBuildIRWithRust,
} from './build-ir/rust-planner.js';
import {
  lowerEsp32PostLinkTransforms,
  lowerPlatformBuildCommands,
} from './build-ir/platform-planning.js';
import type { CKPlatformManifest, ResolvedPlatformManifest } from './platform-pack/types.js';
import { tokenizeRecipe } from './platform-pack/builder.js';
import {
  deriveEsp32PostLinkContract,
  derivePlatformRecipeCommands,
} from './platform-pack/recipe-command-lowering.js';
import {
  discoverLocalLibraryExternalDependencies,
  resolveLocalLibraries,
} from './build-ir/local-libraries.js';
import {
  assertEsp32ApplicationFitsSlot,
  Esp32CustomPartitionsError,
  projectSnapshotSha256,
  resolveCustomEsp32Partitions,
  type Esp32ApplicationSlot,
  type Esp32CustomPartitionInput,
} from './esp32/custom-partitions.js';
import { FileActionCache } from './executor/file-cache.js';
import { CK_NATIVE_EXECUTOR_POLICY_IDENTITY, NativeExecutor } from './executor/native.js';
import type { ActionCache, BuildExecutionOptions, BuildExecutionResult } from './executor/types.js';
import {
  createNativeToolIntegrityManifest,
  DefaultNativeToolResolver,
  FileSystemNativePackProvider,
  type NativePackFile,
  type NativePackCasLimits,
  type NativePackSource,
  type NativeToolIntegrityManifest,
} from './executor/native-packs.js';

/** 源码大小上限。正常 sketch 远小于此，超过基本就是攻击或误操作 */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
/**
 * 入队前的请求大小上限。源码上限之外还要容纳少量库引用和构建选项，
 * 但不能让任意字段把同一份请求复制进 Redis/BullMQ 数百次。
 */
export const MAX_COMPILE_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_BOARD_BYTES = 128;
export const MAX_PROJECT_FILES = 128;
const MAX_PROJECT_PATH_BYTES = 160;
const MAX_LIBRARIES = 32;
const MAX_LIBRARY_NAME_BYTES = 128;
const MAX_LIBRARY_VERSION_BYTES = 64;
const MAX_OPTIONS = 32;
const MAX_OPTION_KEY_BYTES = 64;
const MAX_OPTION_VALUE_BYTES = 128;
/** 文件名白名单：严格限制后，#line 指令里就不可能出现需要转义的字符 */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const PROJECT_SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.s', '.asm']);
const PROJECT_HEADER_EXTENSIONS = new Set(['.h', '.hh', '.hpp', '.hxx', '.inc', '.ipp', '.tpp']);
const PROJECT_METADATA_NAMES = new Set(['library.properties', 'license', 'licence', 'copying', 'notice', 'authors', 'readme']);
const ESP32_CUSTOM_PARTITIONS_FILE = 'partitions.csv';

function projectFileKind(name: string): 'sketch' | 'source' | 'header' | 'metadata' | 'custom-partitions' | null {
  if (
    !name
    || name.includes('\\')
    || Buffer.byteLength(name, 'utf8') > MAX_PROJECT_PATH_BYTES
  ) return null;
  const segments = name.split('/');
  if (segments.length > 8 || segments.some((segment) => !SAFE_PATH_SEGMENT.test(segment))) return null;
  if (segments[0]?.toLowerCase() === 'libraries' && segments.length >= 3) {
    const basenameValue = basename(name).toLowerCase();
    if (PROJECT_METADATA_NAMES.has(basenameValue)) return 'metadata';
  }
  if (name === ESP32_CUSTOM_PARTITIONS_FILE) return 'custom-partitions';
  const extension = extname(name).toLowerCase();
  if (extension === '.ino' && segments.length === 1) return 'sketch';
  if (PROJECT_SOURCE_EXTENSIONS.has(extension)) return 'source';
  if (PROJECT_HEADER_EXTENSIONS.has(extension)) return 'header';
  return null;
}

export type CompileRequestValidationResult =
  | { ok: true; request: CompileRequest }
  | { ok: false; message: string };

/**
 * 只校验请求自身的结构和大小，不读取板卡、库或工具链等运行态。
 * HTTP 层用它在入队前挡掉畸形请求，worker 仍会再次调用并继续做运行态校验。
 */
export function validateCompileRequest(input: unknown): CompileRequestValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: '请求体必须是 JSON 对象' };
  }

  let serializedBytes: number;
  try {
    const serialized = JSON.stringify(input);
    if (typeof serialized !== 'string') return { ok: false, message: '请求体无法序列化' };
    serializedBytes = Buffer.byteLength(serialized, 'utf8');
  } catch {
    return { ok: false, message: '请求体无法序列化' };
  }
  if (serializedBytes > MAX_COMPILE_REQUEST_BYTES) {
    return { ok: false, message: `请求体超过 ${MAX_COMPILE_REQUEST_BYTES / 1024} KB 上限` };
  }

  const req = input as Record<string, unknown>;
  if (
    typeof req.board !== 'string' || !req.board
    || Buffer.byteLength(req.board, 'utf8') > MAX_BOARD_BYTES
  ) {
    return { ok: false, message: 'board 必须是非空字符串' };
  }
  if (!Array.isArray(req.files) || req.files.length === 0 || req.files.length > MAX_PROJECT_FILES) {
    return { ok: false, message: `files 必须包含 1 到 ${MAX_PROJECT_FILES} 个项目文件` };
  }

  const files: Array<{
    name: string;
    content: string;
    kind: 'sketch' | 'source' | 'header' | 'metadata' | 'custom-partitions';
  }> = [];
  const names = new Set<string>();
  const headerNames = new Set<string>();
  let totalSourceBytes = 0;
  let sketchCount = 0;
  for (const rawFile of req.files) {
    if (
      !rawFile || typeof rawFile !== 'object' || Array.isArray(rawFile)
      || typeof (rawFile as Record<string, unknown>).name !== 'string'
      || typeof (rawFile as Record<string, unknown>).content !== 'string'
    ) {
      return { ok: false, message: '每个项目文件必须包含字符串 name 和 content' };
    }
    const source = rawFile as { name: string; content: string };
    const kind = projectFileKind(source.name);
    if (!kind) {
      return {
        ok: false,
        message: `文件路径或扩展名不合法：${source.name}`,
      };
    }
    const canonicalName = source.name.toLowerCase();
    if (names.has(canonicalName)) {
      return { ok: false, message: `项目文件名重复：${source.name}` };
    }
    names.add(canonicalName);
    if (source.content.includes('\0')) {
      return { ok: false, message: `项目文件包含 NUL 字节：${source.name}` };
    }
    if (kind === 'sketch') sketchCount++;
    if (kind === 'header') {
      const headerName = basename(source.name).toLowerCase();
      if (headerNames.has(headerName)) {
        return { ok: false, message: `项目头文件基名重复：${basename(source.name)}` };
      }
      headerNames.add(headerName);
    }
    totalSourceBytes += Buffer.byteLength(source.content, 'utf8');
    if (totalSourceBytes > MAX_SOURCE_BYTES) {
      return { ok: false, message: `项目源码总量超过 ${MAX_SOURCE_BYTES / 1024} KB 上限` };
    }
    files.push({ name: source.name, content: source.content, kind });
  }
  if (sketchCount < 1) {
    return { ok: false, message: '项目必须包含至少一个根目录 .ino 文件' };
  }

  if (req.options !== undefined) {
    if (
      typeof req.options !== 'object' || req.options === null || Array.isArray(req.options)
    ) {
      return { ok: false, message: 'options 必须是字符串键值对象' };
    }
    const entries = Object.entries(req.options);
    if (entries.length > MAX_OPTIONS) {
      return { ok: false, message: `options 必须是不超过 ${MAX_OPTIONS} 项的字符串键值对象` };
    }
    if (entries.some(([key, value]) => (
      !key || typeof value !== 'string'
      || Buffer.byteLength(key, 'utf8') > MAX_OPTION_KEY_BYTES
      || Buffer.byteLength(value, 'utf8') > MAX_OPTION_VALUE_BYTES
    ))) {
      return { ok: false, message: 'options 的键或值超过长度上限' };
    }
  }

  if (
    req.libraries !== undefined
    && (
      !Array.isArray(req.libraries) || req.libraries.length > MAX_LIBRARIES
      || req.libraries.some((ref: unknown) => {
        if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return true;
        const library = ref as Record<string, unknown>;
        return typeof library.name !== 'string' || !library.name
          || Buffer.byteLength(library.name, 'utf8') > MAX_LIBRARY_NAME_BYTES
          || (library.version !== undefined
            && (
              typeof library.version !== 'string' || !library.version
              || Buffer.byteLength(library.version, 'utf8') > MAX_LIBRARY_VERSION_BYTES
            ));
      })
    )
  ) {
    return { ok: false, message: `libraries 必须是不超过 ${MAX_LIBRARIES} 项的库引用数组` };
  }

  if (
    req.sessionId !== undefined
    && (typeof req.sessionId !== 'string' || req.sessionId.length > 128)
  ) {
    return { ok: false, message: 'sessionId 必须是不超过 128 字符的字符串' };
  }

  const request: CompileRequest = {
    board: req.board as string,
    files: files
      .sort((left, right) => (
        Number(right.kind === 'sketch') - Number(left.kind === 'sketch')
        || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      ))
      .map(({ name, content }) => ({ name, content })),
    ...(req.options !== undefined
      ? { options: { ...(req.options as Record<string, string>) } }
      : {}),
    ...(req.libraries !== undefined
      ? {
          libraries: (req.libraries as Array<{ name: string; version?: string }>).map((library) => ({
            name: library.name,
            ...(library.version !== undefined ? { version: library.version } : {}),
          })),
        }
      : {}),
    ...(req.sessionId !== undefined ? { sessionId: req.sessionId as string } : {}),
  };
  return { ok: true, request };
}

export interface CompileServiceOptions {
  boards: BoardRegistry;
  toolchain: ToolchainConfig;
  executor: SandboxExecutor;
  /** @deprecated CompileService now uses the Action cache exclusively. */
  cache?: FileL0Cache;
  libraries?: LibraryRegistry;
  /** Immutable CI bundle version. Production uses this instead of scanning multi-GB SDK trees. */
  compilerBundleId?: string;
  /**
   * Stable marker for a locally installed, package-managed toolchain. Unlike
   * compilerBundleId it does not cover user libraries, which remain
   * content-addressed. Intended for development previews where a full ESP32
   * SDK content scan would otherwise delay the first request by minutes.
   */
  toolchainIdentityHint?: string;
  /** Optional cross-process Action cache supplied by the hosting adapter. */
  actionCache?: ActionCache;
  /** Retention limits for materialized Native Pack blobs. */
  packCasLimits?: NativePackCasLimits;
  /** Immutable standardized platform metadata shared with the browser planner. */
  platformManifests?: readonly CKPlatformManifest[];
}

type NativeToolIntegritySnapshot =
  | { ok: true; manifest: NativeToolIntegrityManifest }
  | { ok: false; message: string };

interface NativePlanContentSnapshot {
  irSha256: Sha256;
  platformRoots: ReadonlyMap<string, Sha256>;
  boardRoots: ReadonlyMap<string, Sha256>;
  libraryRoots: ReadonlyMap<string, Sha256>;
}

export class CompileService {
  private readonly boards: BoardRegistry;
  private readonly tc: ToolchainConfig;
  private readonly executor: SandboxExecutor;
  private readonly compilerBundleId?: string;
  private readonly toolchainIdentityHint?: string;
  private readonly actionCache: ActionCache;
  private readonly packCasLimits: NativePackCasLimits | undefined;
  private readonly platformManifests = new Map<string, CKPlatformManifest>();
  private readonly packContentIdentities = new Map<string, Promise<string>>();
  private platformToolchainBoards?: Promise<BoardRegistry>;
  private libs: LibraryRegistry;
  private readonly toolchainIds = new Map<'avr' | 'esp32', string>();
  private readonly pendingToolchainIds = new Map<'avr' | 'esp32', Promise<string>>();
  private readonly nativeToolIntegritySnapshots = new Map<string, NativeToolIntegritySnapshot>();
  private readonly nativePlanContent = new WeakMap<BuildIR, NativePlanContentSnapshot>();
  private readonly customPartitionsByIR = new WeakMap<BuildIR, Esp32CustomPartitionInput>();

  constructor(opts: CompileServiceOptions) {
    this.boards = opts.boards;
    this.tc = opts.toolchain;
    this.executor = opts.executor;
    this.libs = opts.libraries ?? LibraryRegistry.fromDirectories(opts.toolchain.librariesDirs);
    this.compilerBundleId = opts.compilerBundleId;
    this.toolchainIdentityHint = opts.toolchainIdentityHint;
    this.actionCache = opts.actionCache ?? new FileActionCache(join(this.tc.cacheDir, 'actions'));
    this.packCasLimits = opts.packCasLimits;
    for (const manifest of opts.platformManifests ?? []) {
      for (const platformBoard of manifest.boards) {
        if (this.platformManifests.has(platformBoard.fqbn)) {
          throw new TypeError(`duplicate Platform Manifest FQBN: ${platformBoard.fqbn}`);
        }
        this.platformManifests.set(platformBoard.fqbn, manifest);
      }
    }
  }

  private async resolveStandardPlatform(
    board: BoardDefinition,
    options: Record<string, string>,
    execution: BuildExecutionOptions = {},
  ): Promise<ResolvedPlatformManifest | undefined> {
    throwIfInterrupted(execution);
    const manifest = this.platformManifests.get(board.fqbn);
    if (!manifest) {
      if (board.arch === 'esp32') {
        throw new TypeError(`required Platform Manifest is missing for ${board.fqbn}`);
      }
      return undefined;
    }
    const resolved = await resolvePlatformManifestWithRust(
      { manifest, fqbn: board.fqbn, options },
      execution,
    );
    throwIfInterrupted(execution);
    if (resolved.architecture !== board.arch) {
      throw new TypeError(`Platform Manifest architecture mismatch for ${board.fqbn}`);
    }
    if (board.arch === 'esp32' && resolved.board.core !== 'esp32') {
      throw new TypeError(`Platform Manifest core mismatch for ${board.fqbn}: ${resolved.board.core}`);
    }
    return resolved;
  }

  private async resolveTargetBuild(
    board: BoardDefinition,
    requestedOptions: Record<string, string> | undefined,
    execution: BuildExecutionOptions = {},
  ): Promise<{
    buildOptions: Record<string, string>;
    effectiveBoard: BoardDefinition;
    standardPlatform: ResolvedPlatformManifest | undefined;
  }> {
    const unsupported = unsupportedOptionErrors(board, requestedOptions);
    if (unsupported.length > 0) throw new TypeError(unsupported.join(', '));

    if (board.arch === 'esp32') {
      if (!this.platformManifests.has(board.fqbn)) {
        throw new TypeError(`required Platform Manifest is missing for ${board.fqbn}`);
      }
      const standardPlatform = await this.resolveStandardPlatform(
        board,
        requestedOptions ?? {},
        execution,
      );
      const buildOptions = standardPlatformBuildOptions(standardPlatform!);
      return {
        buildOptions,
        effectiveBoard: this.applyStandardPlatformBuild(board, standardPlatform),
        standardPlatform,
      };
    }

    const { options, errors } = resolveOptions(board, requestedOptions);
    if (errors.length) throw new TypeError(errors.join(', '));
    const buildOptions = legacyBuildOptions(board, options);
    const compatibilityBoard = applyOptions(board, buildOptions);
    const standardPlatform = await this.resolveStandardPlatform(
      board,
      buildOptions,
      execution,
    );
    return {
      buildOptions,
      effectiveBoard: this.applyStandardPlatformBuild(
        standardPlatform ? board : compatibilityBoard,
        standardPlatform,
      ),
      standardPlatform,
    };
  }

  private async toolchainIdentityFor(
    arch: 'avr' | 'esp32',
    execution: BuildExecutionOptions = {},
  ): Promise<string> {
    throwIfInterrupted(execution);
    const cached = this.toolchainIds.get(arch);
    if (cached) return cached;
    const pending = this.pendingToolchainIds.get(arch);
    if (pending) return raceWithDeadline(pending, execution);

    const provenance = this.compilerBundleId
      ? { kind: 'bundle' as const, value: this.compilerBundleId }
      : this.toolchainIdentityHint
        ? { kind: 'hint' as const, value: this.toolchainIdentityHint }
        : undefined;
    const identityBoards = arch === 'esp32'
      ? await raceWithDeadline(this.platformToolchainBoardRegistry(), execution)
      : this.boards;
    const identity = nativeToolchainPackIdentityAsync(this.tc, identityBoards, arch, provenance);
    const pendingIdentity = identity.then(
      (value) => {
        this.toolchainIds.set(arch, value);
        return value;
      },
      (err: unknown) => {
        throw err;
      },
    );
    this.pendingToolchainIds.set(arch, pendingIdentity);
    void pendingIdentity.finally(() => {
      if (this.pendingToolchainIds.get(arch) === pendingIdentity) {
        this.pendingToolchainIds.delete(arch);
      }
    }).catch(() => {});
    return raceWithDeadline(pendingIdentity, execution);
  }

  private async platformToolchainBoardRegistry(): Promise<BoardRegistry> {
    if (this.platformToolchainBoards) return this.platformToolchainBoards;
    this.platformToolchainBoards = (async () => {
      const registry = new BoardRegistry();
      for (const [fqbn, manifest] of [...this.platformManifests].sort(([left], [right]) => (
        compareStrings(left, right)
      ))) {
        const compatibilityBoard = this.boards.get(fqbn);
        if (!compatibilityBoard || compatibilityBoard.arch !== 'esp32') continue;
        const resolved = await resolvePlatformManifestWithRust({ manifest, fqbn, options: {} });
        registry.add(this.applyStandardPlatformBuild(compatibilityBoard, resolved));
      }
      return registry;
    })();
    return this.platformToolchainBoards;
  }

  private async packContentIdentity(
    path: string,
    execution: BuildExecutionOptions = {},
  ): Promise<string> {
    throwIfInterrupted(execution);
    const key = path;
    const cached = this.packContentIdentities.get(key);
    if (cached) return raceWithDeadline(cached, execution);
    const pending = contentIdentityAsync(path);
    this.packContentIdentities.set(key, pending);
    void pending.finally(() => {
      if (this.packContentIdentities.get(key) === pending) this.packContentIdentities.delete(key);
    }).catch(() => {});
    return raceWithDeadline(pending, execution);
  }

  private nativeToolIntegrityKey(ir: BuildIR): string {
    return sha256Hex(canonicalJson({
      packs: ir.packs,
      tools: [...new Set(ir.graph.actions.map((action) => action.tool))]
        .filter((tool) => tool.startsWith('toolchain:') || tool.startsWith('platform:'))
        .sort(),
    }));
  }

  private rememberNativeToolIntegrity(ir: BuildIR): void {
    const key = this.nativeToolIntegrityKey(ir);
    if (this.nativeToolIntegritySnapshots.has(key)) return;
    try {
      const manifest = createNativeToolIntegrityManifest(
        { config: this.tc },
        ir.packs,
        ir.graph.actions.map((action) => action.tool),
      );
      this.nativeToolIntegritySnapshots.set(key, { ok: true, manifest });
    } catch (error) {
      this.nativeToolIntegritySnapshots.set(key, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private nativeToolIntegrityFor(ir: BuildIR): NativeToolIntegrityManifest {
    this.rememberNativeToolIntegrity(ir);
    const snapshot = this.nativeToolIntegritySnapshots.get(this.nativeToolIntegrityKey(ir))!;
    if (!snapshot.ok) throw new Error(`Native tool registry does not match the planned Packs: ${snapshot.message}`);
    return snapshot.manifest;
  }

  private async platformContentIdentity(
    board: BoardDefinition,
    archToolchain: NonNullable<ToolchainConfig['avr']> | NonNullable<ToolchainConfig['esp32']>,
    standardPlatform: ResolvedPlatformManifest | undefined,
    esp32Sdk: NativeEsp32SdkLayout | undefined,
    execution: BuildExecutionOptions = {},
  ): Promise<{ sha256: Sha256; roots: ReadonlyMap<string, Sha256> }> {
    const core = await this.packContentIdentity(archToolchain.coreDir, execution);
    const sdk = esp32Sdk ? await this.packContentIdentity(esp32Sdk.hostRoot, execution) : null;
    throwIfInterrupted(execution);
    return {
      sha256: sha256Hex(canonicalJson({
      schema: 1,
      architecture: board.arch,
      manifest: standardPlatform?.manifestSha256 ?? null,
      core,
      sdk,
      })),
      roots: new Map<string, Sha256>([
        [archToolchain.coreDir, core],
        ...(esp32Sdk && sdk ? [[esp32Sdk.hostRoot, sdk] as const] : []),
      ]),
    };
  }

  private createPlatformPack(
    board: BoardDefinition,
    standardPlatform: ResolvedPlatformManifest | undefined,
    contentHash: string,
  ): PlatformPackRef {
    return {
      kind: 'platform',
      id: standardPlatform ? `platform:${standardPlatform.id}` : `platform:${board.arch}`,
      version: standardPlatform?.version ?? this.compilerBundleId ?? 'local',
      sha256: sha256Hex(canonicalJson({
        schema: 1,
        architecture: board.arch,
        content: contentHash,
        platformManifest: standardPlatform?.manifestSha256 ?? null,
      })),
      platform: standardPlatform?.id ?? board.arch,
    };
  }

  private applyStandardPlatformBuild(
    board: BoardDefinition,
    standardPlatform: ResolvedPlatformManifest | undefined,
  ): BoardDefinition {
    if (!standardPlatform || board.arch !== 'esp32') return board;
    const buildFlags = resolvePlatformBuildFlags(standardPlatform.properties);
    const property = (name: string): string | undefined => (
      resolvePlatformProperty(standardPlatform.properties, name)
    );
    const requiredProperty = (name: string): string => {
      const value = property(name);
      if (value !== undefined) return value;
      throw new TypeError(`required Platform Manifest property is missing for ${board.fqbn}: ${name}`);
    };
    const manifestMcu = requiredProperty('build.mcu');
    const sdkTarget = property('build.sdk_target') ?? property('build.chip_variant') ?? manifestMcu;
    return {
      ...board,
      build: {
        mcu: manifestMcu,
        fCpu: requiredProperty('build.f_cpu'),
        variant: standardPlatform.board.variant,
        tarch: requiredProperty('build.tarch'),
        target: requiredProperty('build.target'),
        sdkTarget,
        boardDefine: requiredProperty('build.board'),
        bootloaderAddr: requiredProperty('build.bootloader_addr'),
        flashMode: requiredProperty('build.flash_mode'),
        boot: requiredProperty('build.boot'),
        bootFreq: requiredProperty('build.boot_freq'),
        psramType: property('build.psram_type'),
        flashFreq: requiredProperty('build.flash_freq'),
        imageFreq: requiredProperty('build.img_freq'),
        flashSize: requiredProperty('build.flash_size'),
        partitions: requiredProperty('build.partitions'),
        defines: buildFlags.defines,
        extraFlags: buildFlags.compilerFlags,
        optionEffects: {},
      },
    };
  }

  private createBoardPack(
    board: BoardDefinition,
    effectiveBoard: BoardDefinition,
    standardPlatform: ResolvedPlatformManifest | undefined,
    staticFiles: readonly { path: string; sha256: Sha256 }[] = [],
    variantContentSha256?: Sha256,
  ): BoardPackRef {
    const standardBoard = standardPlatform?.board;
    const content = standardBoard
      ? {
          schema: 1,
          platformManifest: standardPlatform.manifestSha256,
          board: standardBoard,
          ...(variantContentSha256 === undefined ? {} : { variantContentSha256 }),
          staticFiles: [...staticFiles].sort((left, right) => compareStrings(left.path, right.path)),
        }
      : {
          schema: 1,
          fqbn: board.fqbn,
          build: effectiveBoard.build,
          ...(variantContentSha256 === undefined ? {} : { variantContentSha256 }),
          staticFiles: [...staticFiles].sort((left, right) => compareStrings(left.path, right.path)),
        };
    return {
      kind: 'board',
      id: `board:${board.fqbn}`,
      version: standardPlatform?.version ?? this.compilerBundleId ?? 'local',
      sha256: sha256Hex(canonicalJson(content)),
      fqbn: board.fqbn,
      variant: standardBoard?.variant ?? effectiveBoard.build.variant,
    };
  }

  /**
   * 替换库索引。导入新库之后调用，让后续编译立刻能用上，
   * 不必重启服务。
   */
  setLibraries(registry: LibraryRegistry): void {
    this.libs = registry;
  }

  get libraries(): LibraryRegistry {
    return this.libs;
  }

  private resolveRequestLibraries(
    request: CompileRequest,
    architecture: 'avr' | 'esp32',
  ): {
    plannerProject: Array<{ path: string; content: string }>;
    resolved: ReturnType<LibraryRegistry['resolveForSketch']>;
  } {
    const projectHeaders = new Set(request.files
      .filter((file) => PROJECT_HEADER_EXTENSIONS.has(extname(file.name).toLowerCase()))
      .map((file) => basename(file.name)));
    const plannerProject = request.files.map((file) => ({ path: file.name, content: file.content }));
    const localExternalDependencies = discoverLocalLibraryExternalDependencies(plannerProject);
    const requestedLibraries = [...(request.libraries ?? [])];
    const requestedNames = new Set(requestedLibraries.map((library) => library.name.toLowerCase()));
    for (const dependency of localExternalDependencies) {
      if (requestedNames.has(dependency.name.toLowerCase())) continue;
      requestedNames.add(dependency.name.toLowerCase());
      requestedLibraries.push(dependency);
    }
    const resolved = this.libs.resolveForSketch(
      requestedLibraries,
      request.files.map((file) => file.content).join('\n'),
      architecture,
      projectHeaders,
    );
    if (resolved.errors.length) throw new TypeError(resolved.errors.join(', '));
    return { plannerProject, resolved };
  }

  /**
   * Resolve a request and plan its complete CK Action DAG.
   */
  async planActionGraph(
    req: CompileRequest,
    execution: BuildExecutionOptions = {},
  ): Promise<BuildIR> {
    throwIfInterrupted(execution);
    const validation = validateCompileRequest(req);
    if (!validation.ok) throw new TypeError(validation.message);
    const normalized = validation.request;
    const board = this.boards.get(normalized.board);
    if (!board || (board.arch !== 'avr' && board.arch !== 'esp32')) {
      throw new TypeError(`unsupported board: ${normalized.board}`);
    }
    const {
      buildOptions: buildOptionsForIR,
      effectiveBoard,
      standardPlatform,
    } = await this.resolveTargetBuild(board, normalized.options, execution);
    throwIfInterrupted(execution);
    const archToolchain = board.arch === 'esp32' ? this.tc.esp32 : this.tc.avr;
    if (!archToolchain) throw new TypeError(`${board.arch} toolchain is not configured`);
    const esp32Sdk = board.arch === 'esp32'
      ? resolveNativeEsp32SdkLayout(
          archToolchain as NonNullable<ToolchainConfig['esp32']>,
          effectiveBoard,
          standardPlatform ? {} : buildOptionsForIR,
        )
      : undefined;
    if (board.arch !== 'esp32' && normalized.files.some((file) => file.name === 'partitions.csv')) {
      throw new TypeError('partitions.csv is supported only for ESP32 targets');
    }
    const customPartitions: Esp32CustomPartitionInput | null = esp32Sdk
      ? resolveCustomEsp32Partitions(normalized.files, {
          flashSizeBytes: parseEsp32FlashSizeBytes(esp32Sdk.profile.flashSize),
        })
      : null;
    const esp32BoardFiles = esp32Sdk
      ? resolveNativeEsp32BoardFiles(
          archToolchain as NonNullable<ToolchainConfig['esp32']>,
          esp32Sdk,
        )
      : undefined;
    const esp32LinkerScripts = esp32Sdk
      ? resolveNativeEsp32LinkerScripts(esp32Sdk)
      : undefined;
    throwIfInterrupted(execution);
    const toolchainHash = await this.toolchainIdentityFor(board.arch, execution);
    const platformContent = await this.platformContentIdentity(
      board,
      archToolchain,
      standardPlatform,
      esp32Sdk,
      execution,
    );
    const platformContentHash = platformContent.sha256;
    const selectedVariantRoot = join(archToolchain.variantsDir, effectiveBoard.build.variant);
    const selectedVariantContentHash = await this.packContentIdentity(
      selectedVariantRoot,
      execution,
    );
    const standardVariantRoot = join(archToolchain.variantsDir, 'standard');
    const standardVariantContentHash = board.arch === 'avr' && effectiveBoard.build.variant !== 'standard'
      ? await this.packContentIdentity(standardVariantRoot, execution)
      : undefined;
    const variantContentHash = standardVariantContentHash
      ? sha256Hex(canonicalJson({
          schema: 1,
          selected: selectedVariantContentHash,
          standard: standardVariantContentHash,
        }))
      : selectedVariantContentHash;
    const boardContentRoots = new Map<string, Sha256>([
      [selectedVariantRoot, selectedVariantContentHash],
      ...(standardVariantContentHash
        ? [[standardVariantRoot, standardVariantContentHash] as const]
        : []),
    ]);
    if (esp32Sdk) {
      const sdkBinRoot = join(esp32Sdk.hostRoot, 'bin');
      const partitionRoot = join(
        (archToolchain as NonNullable<ToolchainConfig['esp32']>).platformDir,
        'tools',
        'partitions',
      );
      boardContentRoots.set(sdkBinRoot, await this.packContentIdentity(sdkBinRoot, execution));
      boardContentRoots.set(partitionRoot, await this.packContentIdentity(partitionRoot, execution));
      if (esp32BoardFiles?.model) {
        const modelRoot = join(esp32Sdk.hostRoot, 'esp_sr');
        boardContentRoots.set(modelRoot, await this.packContentIdentity(modelRoot, execution));
      }
    }
    throwIfInterrupted(execution);
    const platformPack = this.createPlatformPack(board, standardPlatform, platformContentHash);
    const baseBoardPack = this.createBoardPack(
      board,
      effectiveBoard,
      standardPlatform,
      esp32BoardFiles === undefined
        ? []
        : [
            esp32BoardFiles.bootloader,
            esp32BoardFiles.partition,
            esp32BoardFiles.bootApp0,
            ...(esp32BoardFiles.model ? [esp32BoardFiles.model] : []),
          ]
            .map((file) => ({ path: file.logicalPath, sha256: file.sha256 })),
      variantContentHash,
    );
    const boardPackRevisionInput = esp32BoardFiles?.model
      ? JSON.stringify({
          schema: 2,
          id: baseBoardPack.id,
          version: baseBoardPack.version,
          artifacts: [{
            id: ESP32_ESP_SR_MODEL_ARTIFACT_ID,
            kind: 'bin',
            size: esp32BoardFiles.model.size,
            sha256: esp32BoardFiles.model.sha256,
          }],
          metadataSha256: baseBoardPack.sha256,
        })
      : undefined;
    const boardPack = boardPackRevisionInput
      ? { ...baseBoardPack, sha256: sha256Hex(boardPackRevisionInput) }
      : baseBoardPack;
    const platformTreeInput: ActionPackInput = {
      kind: 'pack-artifact',
      packId: platformPack.id,
      packRevision: platformPack.sha256,
      packSchema: 1,
      artifactId: 'native-platform-tree',
      sha256: platformContentHash,
      role: 'platform-tree',
    };
    const boardTreeInput: ActionPackInput = {
      kind: 'pack-artifact',
      packId: boardPack.id,
      packRevision: boardPack.sha256,
      packSchema: 1,
      artifactId: 'native-board-variant-tree',
      sha256: variantContentHash,
      role: 'board-variant-tree',
    };

    const { plannerProject, resolved } = this.resolveRequestLibraries(normalized, board.arch);
    const externalLibraryPacks = createLibraryPackRefs(resolved.libraries);
    const localLibraries = resolveLocalLibraries(plannerProject, board.arch, externalLibraryPacks);
    throwIfInterrupted(execution);
    const libraryPacks = [
      ...externalLibraryPacks,
      ...localLibraries.libraries.map((library) => library.pack),
    ];
    const packByName = new Map(externalLibraryPacks.map((pack) => [pack.name.toLowerCase(), pack] as const));
    const toolchain = {
      kind: 'toolchain' as const,
      id: `toolchain:${board.arch}`,
      version: this.compilerBundleId ?? 'local',
      sha256: toolchainHash,
      abi: board.arch === 'esp32' ? (effectiveBoard.build.tarch ?? 'xtensa') : 'avr',
      instructionSet: effectiveBoard.build.mcu,
    };
    const packs = {
      toolchain,
      platform: platformPack,
      board: boardPack,
      libraries: { roots: libraryPacks.map((pack) => pack.id), packs: libraryPacks },
    };

    const coreRoot = archToolchain.coreDir;
    const variantRoot = join(archToolchain.variantsDir, effectiveBoard.build.variant);
    const platformVariant = board.arch === 'avr' && effectiveBoard.build.variant !== 'standard'
      ? {
          // AVR variants such as Nano's `eightanaloginputs` include
          // ../standard/pins_arduino.h. Preserve that sibling layout in the
          // logical Pack instead of flattening the selected variant alone.
          files: [
            ...prefixPlannerFiles('variant', readPlannerSourceFiles(variantRoot, undefined, execution)),
            ...prefixPlannerFiles(
              'standard',
              readPlannerSourceFiles(join(archToolchain.variantsDir, 'standard'), undefined, execution),
            ),
          ],
          rootPath: 'packs/board',
          includePaths: ['variant', 'standard'],
        }
      : {
          files: readPlannerSourceFiles(variantRoot, undefined, execution),
          rootPath: 'packs/board/variant',
        };
    const libraries = [
      ...resolved.libraries.map((library) => ({
      pack: packByName.get(library.manifest.name.toLowerCase())!,
      files: readPlannerSourceFiles(library.rootDir, library.allFiles, execution),
      includePaths: library.includeDirs
        .map((path) => relative(library.rootDir, path).replaceAll('\\', '/'))
        .filter((path) => path && path !== '.'),
      })),
      ...localLibraries.libraries,
    ];
    const libraryContentRoots = new Map<string, Sha256>();
    for (const library of resolved.libraries) {
      libraryContentRoots.set(
        library.rootDir,
        await this.packContentIdentity(library.rootDir, execution),
      );
    }
    throwIfInterrupted(execution);

    const boardDefineList = esp32Sdk
      ? [
          'ARDUINO=10607',
          `F_CPU=${esp32Sdk.profile.fCpu}`,
          'ARDUINO_ARCH_ESP32',
          ...(effectiveBoard.build.boardDefine ? [`ARDUINO_${effectiveBoard.build.boardDefine}`] : []),
          `ARDUINO_BOARD="${effectiveBoard.build.boardDefine ?? 'ESP32_DEV'}"`,
          `ARDUINO_VARIANT="${effectiveBoard.build.variant}"`,
          `ARDUINO_PARTITION_${esp32Sdk.profile.partitions}`,
          'ESP32=ESP32',
          ...esp32Sdk.profile.defines,
        ]
      : [
          'ARDUINO=10607',
          `F_CPU=${effectiveBoard.build.fCpu}`,
          'ARDUINO_ARCH_AVR',
          ...(effectiveBoard.build.boardDefine ? [`ARDUINO_${effectiveBoard.build.boardDefine}`] : []),
          `ARDUINO_VARIANT=${effectiveBoard.build.variant}`,
          ...effectiveBoard.build.defines,
        ];
    const boardDefines = Object.fromEntries(boardDefineList.map((define) => {
      const index = define.indexOf('=');
      return index < 0 ? [define, true] : [define.slice(0, index), define.slice(index + 1)];
    }));
    const compilerFlags = esp32Sdk
      ? {
          common: [
            '-MMD', '-Os', '-g', '-Werror=return-type',
            ...esp32Sdk.profile.compilerFlags,
            `@${esp32Sdk.logicalRoot}/flags/defines`,
            '-iprefix', `${esp32Sdk.logicalRoot}/include/`,
            `@${esp32Sdk.logicalRoot}/flags/includes`,
            `-I${esp32Sdk.logicalRoot}/${esp32Sdk.memoryType}/include`,
            ...(effectiveBoard.build.extraFlags ?? []),
          ],
          c: [`@${esp32Sdk.logicalRoot}/flags/c_flags`],
          cxx: [`@${esp32Sdk.logicalRoot}/flags/cpp_flags`],
          asm: ['-x', 'assembler-with-cpp', `@${esp32Sdk.logicalRoot}/flags/S_flags`],
        }
      : {
          common: [
            `-mmcu=${effectiveBoard.build.mcu}`, '-Os', '-g',
            '-ffunction-sections', '-fdata-sections', '-MMD',
            ...(effectiveBoard.build.lto ? ['-flto'] : []),
            ...(effectiveBoard.build.extraFlags ?? []),
          ],
        };
    const indexedCompilerInputs = esp32Sdk
      ? [
          nativePackFileInput(join(esp32Sdk.hostRoot, 'flags', 'defines'), `${esp32Sdk.logicalRoot}/flags/defines`, 'compiler-response-file', execution),
          nativePackFileInput(join(esp32Sdk.hostRoot, 'flags', 'includes'), `${esp32Sdk.logicalRoot}/flags/includes`, 'compiler-response-file', execution),
          nativePackFileInput(join(esp32Sdk.hostRoot, 'flags', 'c_flags'), `${esp32Sdk.logicalRoot}/flags/c_flags`, 'compiler-response-file', execution),
          nativePackFileInput(join(esp32Sdk.hostRoot, 'flags', 'cpp_flags'), `${esp32Sdk.logicalRoot}/flags/cpp_flags`, 'compiler-response-file', execution),
          nativePackFileInput(join(esp32Sdk.hostRoot, 'flags', 'S_flags'), `${esp32Sdk.logicalRoot}/flags/S_flags`, 'compiler-response-file', execution),
        ]
      : [];
    const indexedLinkerInputs = esp32Sdk
      ? [
          ...(esp32LinkerScripts?.inputs ?? []),
          nativePackFileInput(join(esp32Sdk.hostRoot, 'flags', 'ld_flags'), `${esp32Sdk.logicalRoot}/flags/ld_flags`, 'linker-response-file', execution),
          nativePackFileInput(join(esp32Sdk.hostRoot, 'flags', 'ld_libs'), `${esp32Sdk.logicalRoot}/flags/ld_libs`, 'linker-response-file', execution),
        ]
      : undefined;
    const nativeLinkerFlags = esp32Sdk
      ? [
          '-Wl,--Map=build/firmware.map',
          `-L${esp32Sdk.logicalRoot}/lib`,
          `-L${esp32Sdk.logicalRoot}/ld`,
          `-L${esp32Sdk.logicalRoot}/${esp32Sdk.memoryType}`,
          '-Wl,--wrap=esp_panic_handler',
          `@${esp32Sdk.logicalRoot}/flags/ld_flags`,
          ...esp32LinkerScripts!.arguments,
          '-Wl,--start-group',
        ]
      : undefined;
    const nativeLinkerTailFlags = esp32Sdk
      ? [
          `@${esp32Sdk.logicalRoot}/flags/ld_libs`,
          ...esp32Sdk.profile.linkerFlags,
          '-Wl,--end-group',
          '-Wl,-EL',
        ]
      : undefined;
    const platformManifest = standardPlatform
      ? this.platformManifests.get(board.fqbn)
      : undefined;
    if (standardPlatform && !platformManifest) {
      throw new TypeError(`resolved Platform Manifest is unavailable for ${board.fqbn}`);
    }
    const projectSha256 = projectSnapshotSha256(localLibraries.projectFiles);
    const derivedEsp32PostLinkTransforms = esp32Sdk && esp32BoardFiles
      && standardPlatform && platformManifest
      ? lowerEsp32PostLinkTransforms(
          deriveEsp32PostLinkContract({
            manifest: platformManifest,
            resolved: standardPlatform,
            boardPack: { id: boardPack.id, sha256: boardPack.sha256 },
            ...(boardPackRevisionInput === undefined ? {} : { boardPackRevisionInput }),
            bindings: {
              application: {
                kind: 'action-output',
                actionId: 'link-firmware',
                path: 'build/firmware.elf',
                role: 'linked-elf',
              },
              bootloader: {
                source: 'sdk-elf',
                input: {
                  kind: 'immutable',
                  path: esp32BoardFiles.bootloader.logicalPath,
                  role: 'bootloader-source',
                  sha256: esp32BoardFiles.bootloader.sha256,
                  provenance: {
                    kind: 'pack-file',
                    packId: boardPack.id,
                    packSha256: boardPack.sha256,
                    selector: `${board.fqbn}:bootloader:${esp32Sdk.profile.boot}:${esp32Sdk.profile.bootFreq}`,
                  },
                },
              },
              partitions: {
                source: 'csv',
                input: {
                  kind: 'immutable',
                  path: customPartitions?.path ?? esp32BoardFiles.partition.logicalPath,
                  role: 'partitions-source',
                  sha256: customPartitions?.sourceSha256 ?? esp32BoardFiles.partition.sha256,
                  provenance: customPartitions
                    ? {
                        kind: 'project-file' as const,
                        path: customPartitions.path,
                        projectSha256,
                        fileSha256: customPartitions.sourceSha256,
                      }
                    : {
                        kind: 'pack-file' as const,
                        packId: boardPack.id,
                        packSha256: boardPack.sha256,
                        selector: `${board.fqbn}:partitions:${esp32Sdk.profile.partitions}`,
                      },
                },
              },
              bootApp0: {
                kind: 'immutable',
                path: esp32BoardFiles.bootApp0.logicalPath,
                role: 'boot-app0-source',
                sha256: esp32BoardFiles.bootApp0.sha256,
                provenance: {
                  kind: 'pack-file',
                  packId: boardPack.id,
                  packSha256: boardPack.sha256,
                  selector: `${board.fqbn}:boot-app0`,
                },
              },
              ...(esp32BoardFiles.model === undefined
                ? {}
                : {
                    model: {
                      kind: 'immutable' as const,
                      path: esp32BoardFiles.model.logicalPath,
                      role: 'model-source',
                      sha256: esp32BoardFiles.model.sha256,
                      size: esp32BoardFiles.model.size,
                      provenance: {
                        kind: 'pack-artifact' as const,
                        packId: boardPack.id,
                        packSha256: boardPack.sha256,
                        packSchema: 2,
                        artifactId: ESP32_ESP_SR_MODEL_ARTIFACT_ID,
                      },
                    },
                  }),
            },
          }),
          {
            elf2image: 'toolchain:esptool',
            partitionBin: 'platform:gen-esp32part',
            materialize: 'ck:copy',
            mergeBin: 'toolchain:esptool',
          },
        )
      : undefined;
    const esp32PostLinkTransforms = customPartitions && derivedEsp32PostLinkTransforms
      ? derivedEsp32PostLinkTransforms.map((transform) => (
          transform.id === 'transform-partitions'
            ? { ...transform, outputSha256: customPartitions.tableSha256 }
            : transform
        ))
      : derivedEsp32PostLinkTransforms;
    const recipeCommands = esp32Sdk && standardPlatform && platformManifest
      ? derivePlatformRecipeCommands({
          recipes: platformManifest.recipes,
          recipeLowering: platformManifest.recipeLowering,
          properties: {
            ...standardPlatform.properties,
            'runtime.ide.version': '10607',
            // Browser profiles already use this stable value. Keeping it here
            // makes recipe-derived Build IR independent of the executor host.
            'runtime.os': 'wasm',
            'build.fqbn': standardPlatform.board.fqbn,
            'build.arch': standardPlatform.architecture.toUpperCase(),
            'build.path': 'build',
            'build.project_name': 'firmware',
            'build.source.path': 'core',
            'compiler.path': '',
            'compiler.prefix': '',
            'compiler.sdk.path': 'sdk',
            source_file: '__ck_source__',
            object_file: '__ck_object__',
            object_files: '__ck_objects__',
            archive_file_path: 'core.a',
            includes: '',
            'file_opts.path': '',
            'build.opt.path': '',
          },
        })
      : undefined;
    const recipeLinkArguments = recipeCommands
      ? recipeCommands.link.flatMap((argument, index) => {
          if (index === 0) return ['linker'];
          if (argument.value === '@sdk/flags/ld_scripts') {
            return esp32LinkerScripts!.arguments;
          }
          return [argument.value];
        })
      : undefined;
    const platformCommandPlan = esp32Sdk
      ? recipeCommands
        ? lowerPlatformBuildCommands({
            compile: {
              args: [
                'compiler', '-c',
                ...recipeCommands.compile.common.map((argument) => argument.value),
              ],
              source: '__ck_source__',
              object: '__ck_object__',
            },
            link: {
              args: recipeLinkArguments!,
              object: '__ck_objects__',
              elf: 'build/firmware.elf',
            },
            languageFlags: recipeCommands.compile.languageFlags,
            pathLayout: platformManifest!.recipeLowering.paths.logicalToAction,
            recipeLowering: platformManifest!.recipeLowering,
          })
        : lowerPlatformBuildCommands({
            compile: {
              args: [
                'compiler',
                ...boardDefineList.map((define) => `-D${define}`),
                '-c', '__ck_source__', '-o', '__ck_object__',
              ],
              source: '__ck_source__',
              object: '__ck_object__',
            },
            link: {
              args: [
                'linker',
                ...nativeLinkerFlags!,
                '__ck_objects__',
                'core.a',
                ...nativeLinkerTailFlags!,
                '-o', '__ck_elf__',
              ],
              object: '__ck_objects__',
              elf: '__ck_elf__',
            },
            languageFlags: compilerFlags,
          })
      : undefined;
    const compilerInputs = platformCommandPlan
      ? bindPlatformCommandInputs(
          platformCommandPlan.compilerInputs,
          indexedCompilerInputs,
          'native compiler',
        )
      : indexedCompilerInputs;
    const linkerInputs = platformCommandPlan
      ? [
          ...bindPlatformCommandInputs(
            platformCommandPlan.linkerInputs,
            indexedLinkerInputs ?? [],
            'native linker',
          ),
          ...(esp32LinkerScripts?.inputs ?? []),
        ]
      : indexedLinkerInputs;
    const ir = await planBuildIRWithRust({
      project: localLibraries.projectFiles,
      projectCompilePaths: localLibraries.projectCompilePaths,
      target: { fqbn: normalized.board, options: buildOptionsForIR, boardPack },
      packs,
      compilerInputs,
      compilerPackInputs: [platformTreeInput, boardTreeInput],
      macros: platformCommandPlan?.macros ?? boardDefines,
      flags: platformCommandPlan?.flags ?? compilerFlags,
      linkerFlags: board.arch === 'avr'
        ? [
            `-mmcu=${effectiveBoard.build.mcu}`,
            '-Wl,--gc-sections',
            ...(effectiveBoard.build.lto ? ['-flto'] : []),
          ]
        : platformCommandPlan!.linkerFlags,
      linkerInputs,
      linkerPackInputs: [platformTreeInput],
      linkerTailFlags: platformCommandPlan?.linkerTailFlags ?? [],
      ...(recipeCommands === undefined ? {} : {
        archiveOperation: recipeCommands.archive.operation,
        archiveFlags: recipeCommands.archive.flags,
      }),
      platform: {
        core: { files: readPlannerSourceFiles(coreRoot, undefined, execution), rootPath: 'packs/platform/core' },
        variant: platformVariant,
      },
      libraries,
      transforms: esp32Sdk
        ? esp32PostLinkTransforms ?? [
            {
              format: 'bin',
              output: 'build/firmware.bin',
              offset: '0x10000',
              tool: 'toolchain:esptool',
              flags: [
                '--chip', effectiveBoard.build.mcu, 'elf2image',
                '--flash-mode', esp32Sdk.profile.flashMode,
                '--flash-freq', esp32Sdk.profile.imageFreq,
                '--flash-size', esp32Sdk.profile.flashSize,
                '--elf-sha256-offset', '0xb0',
              ],
              arguments: [
                '--chip', effectiveBoard.build.mcu, 'elf2image',
                '--flash-mode', esp32Sdk.profile.flashMode,
                '--flash-freq', esp32Sdk.profile.imageFreq,
                '--flash-size', esp32Sdk.profile.flashSize,
                '--elf-sha256-offset', '0xb0',
                '-o', 'build/firmware.bin', 'build/firmware.elf',
              ],
            },
            {
              format: 'bootloader',
              input: esp32BoardFiles!.bootloader.logicalPath,
              inputSha256: esp32BoardFiles!.bootloader.sha256,
              output: 'build/bootloader.bin',
              offset: effectiveBoard.build.bootloaderAddr ?? '0x1000',
              tool: 'toolchain:esptool',
              flags: [
                '--chip', effectiveBoard.build.mcu, 'elf2image',
                '--flash-mode', esp32Sdk.profile.flashMode,
                '--flash-freq', esp32Sdk.profile.imageFreq,
                '--flash-size', esp32Sdk.profile.flashSize,
              ],
              arguments: [
                '--chip', effectiveBoard.build.mcu, 'elf2image',
                '--flash-mode', esp32Sdk.profile.flashMode,
                '--flash-freq', esp32Sdk.profile.imageFreq,
                '--flash-size', esp32Sdk.profile.flashSize,
                '-o', 'build/bootloader.bin',
                esp32BoardFiles!.bootloader.logicalPath,
              ],
            },
            {
              format: 'partition',
              input: customPartitions?.path ?? esp32BoardFiles!.partition.logicalPath,
              inputSha256: customPartitions?.sourceSha256 ?? esp32BoardFiles!.partition.sha256,
              output: 'build/partitions.bin',
              ...(customPartitions === null
                ? {}
                : { outputSha256: customPartitions.tableSha256 }),
              offset: '0x8000',
              tool: 'platform:gen-esp32part',
              arguments: [
                '-q', customPartitions?.path ?? esp32BoardFiles!.partition.logicalPath,
                'build/partitions.bin',
              ],
            },
            {
              format: 'boot-app0',
              input: esp32BoardFiles!.bootApp0.logicalPath,
              inputSha256: esp32BoardFiles!.bootApp0.sha256,
              output: 'build/boot_app0.bin',
              offset: '0xe000',
              tool: 'ck:copy',
              arguments: [
                esp32BoardFiles!.bootApp0.logicalPath,
                '-o', 'build/boot_app0.bin',
              ],
            },
          ]
        : ['hex'],
    }, execution);
    throwIfInterrupted(execution);
    this.nativePlanContent.set(ir, {
      irSha256: sha256Hex(canonicalJson(ir)),
      platformRoots: platformContent.roots,
      boardRoots: boardContentRoots,
      libraryRoots: libraryContentRoots,
    });
    if (customPartitions) this.customPartitionsByIR.set(ir, customPartitions);
    this.rememberNativeToolIntegrity(ir);
    throwIfInterrupted(execution);
    return ir;
  }

  /**
   * Execute the real Action DAG through the NativeExecutor boundary.
   *
   * The native graph path materializes the exact host source trees used
   * during planning and lets the executor resolve compiler tools by logical
   * IR ids.
   */
  async executeActionGraph(
    req: CompileRequest,
    execution: BuildExecutionOptions = {},
  ): Promise<BuildExecutionResult> {
    const started = Date.now();
    const interrupted = interruptionReason(execution);
    if (interrupted) {
      return buildInterruptionResult(interrupted, started);
    }
    const validation = validateCompileRequest(req);
    if (!validation.ok) {
      return {
        status: 'error', executor: 'native', reason: 'invalid_ir',
        message: validation.message, actions: [], diagnostics: [], durationMs: 0,
      };
    }
    const normalized = validation.request;
    let ir: BuildIR;
    try {
      ir = await this.planActionGraph(normalized, execution);
    } catch (error) {
      const reason = interruptionReason(execution);
      if (reason) return buildInterruptionResult(reason, started);
      return {
        status: 'error', executor: 'native', reason: 'invalid_ir',
        message: error instanceof Error ? error.message : String(error),
        actions: [], diagnostics: [], durationMs: 0,
      };
    }
    return this.executeNativeBuildIR(normalized, ir, execution);
  }

  private async executeNativeBuildIR(
    req: CompileRequest,
    ir: BuildIR,
    execution: BuildExecutionOptions = {},
  ): Promise<BuildExecutionResult> {
    throwIfInterrupted(execution);
    const provider = await this.nativePackProviderFor(req, ir, execution);
    throwIfInterrupted(execution);
    const toolOptions = { config: this.tc };
    const integrity = this.nativeToolIntegrityFor(ir);
    throwIfInterrupted(execution);
    const native = new NativeExecutor({
      sandbox: this.executor,
      tools: new DefaultNativeToolResolver({ ...toolOptions, integrity }),
      packs: provider,
      workspaceRoot: this.tc.workDir,
      cache: this.actionCache,
      policyIdentity: sha256Hex(canonicalJson({
        kind: 'ck-compile-service-native-policy',
        schemaVersion: 2,
        executor: CK_NATIVE_EXECUTOR_POLICY_IDENTITY,
        actions: 'ck-preprocess-copy-v1',
        diagnostics: 'gcc-diagnostics-v1',
        materializer: 'filesystem-native-pack-provider-v1',
        toolIntegrity: integrity,
      })),
      validateIR: (candidate) => validateBuildIRWithRust(candidate, execution),
      runAction: ({ action, readFile }) => {
        throwIfInterrupted(execution);
        if (action.tool === 'ck:copy') {
          const materializesModel = action.outputs.some((output) => output.kind === 'model');
          if (action.kind !== 'transform'
            || (action.transform.format !== 'boot-app0' && !materializesModel)) {
            return { ok: false, message: `invalid copy Action: ${action.id}` };
          }
          const bytes = readFile(action.transform.input);
          throwIfInterrupted(execution);
          return {
            outputs: [{ path: action.transform.output, bytes, sha256: sha256Hex(bytes) }],
          };
        }
        if (action.tool !== 'ck:preprocess') return undefined;
        if (action.kind !== 'transform' || action.transform.format !== 'other') {
          return { ok: false, message: `invalid preprocess Action: ${action.id}` };
        }
        const sketch = decodeNativeSketchAction(action, readFile);
        const source = composeArduinoSketchSource(sketch.files);
        const generated = preprocess(source, { sourceName: sketch.sourceName }).cpp;
        throwIfInterrupted(execution);
        const bytes = new TextEncoder().encode(generated);
        return {
          outputs: [{ path: action.transform.output, bytes, sha256: sha256Hex(bytes) }],
        };
      },
    });
    return native.execute(ir, execution);
  }

  private async nativePackProviderFor(
    req: CompileRequest,
    ir: BuildIR,
    execution: BuildExecutionOptions = {},
  ): Promise<FileSystemNativePackProvider> {
    throwIfInterrupted(execution);
    // A locally planned object carries the exact content snapshot captured by
    // this service. Serialized or mutated IR must resolve against the current
    // host registry again before any Pack is materialized.
    let contentSnapshot = this.nativePlanContent.get(ir);
    if (!contentSnapshot || contentSnapshot.irSha256 !== sha256Hex(canonicalJson(ir))) {
      const hostIR = await this.planActionGraph(req, execution);
      if (canonicalJson(hostIR.packs) !== canonicalJson(ir.packs)) {
        throw new TypeError('Native Pack registry has no exact content-hash match for this Build IR');
      }
      contentSnapshot = this.nativePlanContent.get(hostIR);
      if (!contentSnapshot) throw new TypeError('Native Pack content snapshot is unavailable');
      const hostCustomPartitions = this.customPartitionsByIR.get(hostIR);
      if (hostCustomPartitions) this.customPartitionsByIR.set(ir, hostCustomPartitions);
    }

    const board = this.boards.get(req.board);
    if (!board || (board.arch !== 'avr' && board.arch !== 'esp32')) {
      throw new TypeError(`unsupported board: ${req.board}`);
    }
    const {
      buildOptions: selectedOptions,
      effectiveBoard,
      standardPlatform,
    } = await this.resolveTargetBuild(
      board,
      board.arch === 'esp32' && this.platformManifests.has(board.fqbn)
        ? ir.target.options
        : req.options,
      execution,
    );
    throwIfInterrupted(execution);
    const archToolchain = board.arch === 'esp32' ? this.tc.esp32 : this.tc.avr;
    if (!archToolchain) throw new TypeError(`${board.arch} toolchain is not configured`);

    const platformSources: NativePackSource[] = [
      sourcePack(
        archToolchain.coreDir,
        'packs/platform/core',
        ir.packs.platform.sha256,
        undefined,
        requiredPackContentHash(contentSnapshot.platformRoots, archToolchain.coreDir, 'Platform/Core'),
        execution,
      ),
    ];
    const selectedVariantRoot = join(archToolchain.variantsDir, effectiveBoard.build.variant);
    const boardSources: NativePackSource[] = [
      sourcePack(
        selectedVariantRoot,
        'packs/board/variant',
        ir.packs.board.sha256,
        undefined,
        requiredPackContentHash(contentSnapshot.boardRoots, selectedVariantRoot, 'Board Variant'),
        execution,
      ),
    ];
    if (board.arch === 'avr' && effectiveBoard.build.variant !== 'standard') {
      boardSources.push(
        sourcePack(
          join(archToolchain.variantsDir, 'standard'),
          'packs/board/standard',
          ir.packs.board.sha256,
          undefined,
          requiredPackContentHash(
            contentSnapshot.boardRoots,
            join(archToolchain.variantsDir, 'standard'),
            'Board standard Variant',
          ),
          execution,
        ),
      );
    }
    if (board.arch === 'esp32') {
      const esp32Toolchain = archToolchain as NonNullable<ToolchainConfig['esp32']>;
      const sdk = resolveNativeEsp32SdkLayout(
        esp32Toolchain,
        effectiveBoard,
        standardPlatform ? {} : selectedOptions,
      );
      const sdkContent = {
        contentRoot: sdk.hostRoot,
        contentSha256: requiredPackContentHash(
          contentSnapshot.platformRoots,
          sdk.hostRoot,
          'Platform SDK',
        ),
      };
      platformSources.push(
        sourcePack(join(sdk.hostRoot, 'flags'), `${sdk.logicalRoot}/flags`, ir.packs.platform.sha256, undefined, sdkContent, execution),
        sourcePack(join(sdk.hostRoot, 'include'), `${sdk.logicalRoot}/include`, ir.packs.platform.sha256, undefined, sdkContent, execution),
        sourcePack(
          join(sdk.hostRoot, sdk.memoryType, 'include'),
          `${sdk.logicalRoot}/${sdk.memoryType}/include`,
          ir.packs.platform.sha256,
          undefined,
          sdkContent,
          execution,
        ),
        binaryPackSource(
          join(sdk.hostRoot, 'lib'), `${sdk.logicalRoot}/lib`, ir.packs.platform.sha256, new Set(['.a']), undefined, sdkContent, execution,
        ),
        binaryPackSource(
          join(sdk.hostRoot, 'ld'), `${sdk.logicalRoot}/ld`, ir.packs.platform.sha256, new Set(['.ld', '.a']), undefined, sdkContent, execution,
        ),
        binaryPackSource(
          join(sdk.hostRoot, sdk.memoryType),
          `${sdk.logicalRoot}/${sdk.memoryType}`,
          ir.packs.platform.sha256,
          new Set(['.a', '.ld']),
          undefined,
          sdkContent,
          execution,
        ),
      );
      const boardFiles = resolveNativeEsp32BoardFiles(esp32Toolchain, sdk);
      const sdkBinRoot = join(sdk.hostRoot, 'bin');
      const partitionRoot = join(esp32Toolchain.platformDir, 'tools', 'partitions');
      boardSources.push(
        binaryPackSource(
          sdkBinRoot,
          `${NATIVE_ESP32_BOARD_ROOT}/sdk-bin`,
          ir.packs.board.sha256,
          new Set(['.elf']),
          [boardFiles.bootloader.hostPath],
          {
            contentRoot: sdkBinRoot,
            contentSha256: requiredPackContentHash(contentSnapshot.boardRoots, sdkBinRoot, 'Board SDK binaries'),
          },
          execution,
        ),
        binaryPackSource(
          partitionRoot,
          `${NATIVE_ESP32_BOARD_ROOT}/partitions`,
          ir.packs.board.sha256,
          new Set(['.csv', '.bin']),
          [
            boardFiles.partition.hostPath,
            boardFiles.bootApp0.hostPath,
          ],
          {
            contentRoot: partitionRoot,
            contentSha256: requiredPackContentHash(contentSnapshot.boardRoots, partitionRoot, 'Board partitions'),
          },
          execution,
        ),
      );
      if (boardFiles.model) {
        const modelRoot = join(sdk.hostRoot, 'esp_sr');
        boardSources.push(binaryPackSource(
          modelRoot,
          NATIVE_ESP32_BOARD_ROOT,
          ir.packs.board.sha256,
          new Set(['.bin']),
          [boardFiles.model.hostPath],
          {
            contentRoot: modelRoot,
            contentSha256: requiredPackContentHash(
              contentSnapshot.boardRoots,
              modelRoot,
              'Board ESP-SR model',
            ),
          },
          execution,
        ));
      }
    }
    const { resolved } = this.resolveRequestLibraries(req, board.arch);
    throwIfInterrupted(execution);
    if (resolved.errors.length) throw new TypeError(resolved.errors.join(', '));
    const libraries = new Map<string, NativePackSource>();
    for (const library of resolved.libraries) {
      const destination = libraryDestination(ir, `library:${library.manifest.name}@${library.manifest.version}`);
      if (!destination) continue;
      const pack = ir.packs.libraries.packs.find((candidate) => (
        candidate.id === `library:${library.manifest.name}@${library.manifest.version}`
      ));
      if (!pack) throw new TypeError(`Native Library Pack is absent from Build IR: ${library.manifest.name}`);
      libraries.set(`library:${library.manifest.name}@${library.manifest.version}`, sourcePack(
        library.rootDir,
        destination,
        pack.sha256,
        library.allFiles,
        requiredPackContentHash(contentSnapshot.libraryRoots, library.rootDir, 'Library Pack'),
        execution,
      ));
    }
    throwIfInterrupted(execution);
    return new FileSystemNativePackProvider({
      platform: platformSources,
      ...(boardSources.length === 0 ? {} : { board: boardSources }),
      libraries,
      casRoot: join(this.tc.cacheDir, 'packs'),
      casLimits: this.packCasLimits,
    });
  }

  /** Execute a complete CK Action DAG through the NativeExecutor boundary. */
  async compileBuildIR(
    ir: BuildIR,
    onEvent: (e: CompileEvent) => void = () => {},
    options: BuildExecutionOptions = {},
  ): Promise<CompileResult> {
    return this.executeBuildIR(ir, onEvent, options, false);
  }

  /** Execute only the immutable ESP32 bootloader/partition Actions in a planned IR. */
  async compileStaticBuildIR(
    ir: BuildIR,
    onEvent: (e: CompileEvent) => void = () => {},
    options: BuildExecutionOptions = {},
  ): Promise<CompileResult> {
    const staticIR = selectBuildIRArtifactFormats(
      ir,
      new Set(['bootloader', 'partition', 'boot-app0', 'model']),
    );
    if (staticIR.artifacts.length === 0 || staticIR.graph.actions.length === 0) {
      const result: CompileResult = {
        status: 'error', reason: 'invalid_request',
        message: 'Build IR does not declare ESP32 static firmware Actions', diagnostics: [], timings: {},
      };
      onEvent({ event: 'done', result });
      return result;
    }
    return this.executeBuildIR(staticIR, onEvent, options, true);
  }

  private async executeBuildIR(
    ir: BuildIR,
    onEvent: (e: CompileEvent) => void,
    options: BuildExecutionOptions,
    allowStaticOnly: boolean,
  ): Promise<CompileResult> {
    const initialInterruption = interruptionReason(options);
    if (initialInterruption) {
      const result: CompileResult = {
        status: 'error', reason: initialInterruption,
        message: initialInterruption === 'timeout'
          ? 'compile job wall-clock deadline exceeded'
          : 'compile was cancelled',
        diagnostics: [], timings: {},
      };
      onEvent({ event: 'done', result });
      return result;
    }
    if (!allowStaticOnly && !isActionGraphIR(ir)) {
      const result: CompileResult = {
        status: 'error', reason: 'invalid_request',
        message: 'Build IR must contain compile, archive, or link Actions',
        diagnostics: [], timings: {},
      };
      onEvent({ event: 'done', result });
      return result;
    }
    const request = compileRequestFromActionGraph(ir);
    let execution: BuildExecutionResult;
    try {
      const callerProgress = options.onProgress;
      execution = await this.executeNativeBuildIR(request, ir, {
        ...options,
        onProgress: ({ completed, total, action, cached }) => {
          callerProgress?.({ completed, total, action, cached });
          onEvent({
            event: 'progress',
            stage: actionStage(action.kind),
            percent: total > 0 ? Math.min(99, Math.round((completed / total) * 100)) : 0,
            detail: `${action.id}${cached ? ' (cache)' : ''}`,
          });
        },
      });
    } catch (error) {
      const interrupted = errorInterruptionReason(error, options);
      const result: CompileResult = {
        status: 'error', reason: interrupted ?? 'internal',
        message: interrupted === 'timeout'
          ? 'compile job wall-clock deadline exceeded'
          : interrupted === 'cancelled'
            ? 'compile was cancelled'
            : error instanceof Error ? error.message : String(error),
        diagnostics: [], timings: {},
      };
      onEvent({ event: 'done', result });
      return result;
    }
    const customPartitions = this.customPartitionsByIR.get(ir);
    let result = compileResultFromNativeExecution(
      execution,
      ir,
      allowStaticOnly,
      options,
      allowStaticOnly ? undefined : customPartitions?.applicationSlot,
    );
    if (
      result.status === 'success'
      && !allowStaticOnly
      && buildIRUsesCustomPartitions(ir)
      && !customPartitions
    ) {
      result = {
        status: 'error', reason: 'internal',
        message: 'custom ESP32 partition application slot evidence is unavailable',
        diagnostics: result.diagnostics,
        timings: result.timings,
      };
    }
    for (const diagnostic of result.diagnostics) {
      onEvent({ event: 'diagnostic', diagnostic });
    }
    onEvent({ event: 'done', result });
    return result;
  }

  async compile(
    req: CompileRequest,
    onEvent: (e: CompileEvent) => void = () => {},
    execution: BuildExecutionOptions = {},
  ): Promise<CompileResult> {
    const started = Date.now();
    const fail = (
      reason: Extract<CompileResult, { status: 'error' }>['reason'],
      message: string,
      diagnostics: Diagnostic[] = [],
    ): CompileResult => {
      const result: CompileResult = {
        status: 'error', reason, message, diagnostics,
        timings: { total: Date.now() - started },
      };
      onEvent({ event: 'done', result });
      return result;
    };

    const initialInterruption = interruptionReason(execution);
    if (initialInterruption) {
      return fail(
        initialInterruption,
        initialInterruption === 'timeout'
          ? 'compile job wall-clock deadline exceeded'
          : 'compile was cancelled',
      );
    }
    const validation = validateCompileRequest(req);
    if (!validation.ok) return fail('invalid_request', validation.message);
    const normalized = validation.request;
    const board = this.boards.get(normalized.board);
    if (!board || (board.arch !== 'avr' && board.arch !== 'esp32')) {
      return fail('invalid_request', `unsupported board: ${normalized.board}`);
    }
    if (board.arch === 'avr' && !this.tc.avr) return fail('internal', 'AVR toolchain is not configured');
    if (board.arch === 'esp32' && !this.tc.esp32) return fail('internal', 'ESP32 toolchain is not configured');

    onEvent({ event: 'progress', stage: 'preprocess', percent: 5 });
    const rejected = normalized.files.flatMap((file) => precheck(file.content).findings.map((finding) => ({
      severity: 'error' as const,
      file: file.name,
      line: finding.line,
      message: finding.message,
    })));
    if (rejected.length > 0) {
      rejected.forEach((diagnostic) => onEvent({ event: 'diagnostic', diagnostic }));
      return fail('rejected', 'source contains a construct rejected by the platform precheck', rejected);
    }

    let ir: BuildIR;
    let libraryDiagnostics: Diagnostic[] = [];
    try {
      ir = await this.planActionGraph(normalized, execution);
      const plannedInterruption = interruptionReason(execution);
      if (plannedInterruption) {
        return fail(
          plannedInterruption,
          plannedInterruption === 'timeout'
            ? 'compile job wall-clock deadline exceeded'
            : 'compile was cancelled',
        );
      }
      const { resolved } = this.resolveRequestLibraries(normalized, board.arch);
      throwIfInterrupted(execution);
      const sketch = stableMainSketch(normalized.files);
      libraryDiagnostics = resolved.autoDetected.map((name) => ({
        severity: 'info' as const,
        file: sketch.name,
        line: 1,
        message: `Automatically imported library \`${name}\` from #include`,
      }));
    } catch (error) {
      const interrupted = errorInterruptionReason(error, execution);
      if (interrupted) {
        return fail(
          interrupted,
          interrupted === 'timeout'
            ? 'compile job wall-clock deadline exceeded'
            : 'compile was cancelled',
        );
      }
      return fail('invalid_request', error instanceof Error ? error.message : String(error));
    }
    libraryDiagnostics.forEach((diagnostic) => onEvent({ event: 'diagnostic', diagnostic }));
    const result = await this.compileBuildIR(ir, (event) => {
      if (event.event !== 'done') onEvent(event);
    }, execution);
    const completed: CompileResult = {
      ...result,
      diagnostics: [...libraryDiagnostics, ...result.diagnostics],
      timings: { ...result.timings, total: Date.now() - started },
    };
    onEvent({ event: 'progress', stage: 'done', percent: 100 });
    onEvent({ event: 'done', result: completed });
    return completed;
  }

}

function errorInterruptionReason(
  error: unknown,
  execution: BuildExecutionOptions,
): InterruptionReason | null {
  return interruptionReason(execution)
    ?? (isDeadlineExceededError(error)
      ? 'timeout'
      : isOperationCancelledError(error)
        ? 'cancelled'
        : null);
}

function buildInterruptionResult(
  reason: InterruptionReason,
  started: number,
): BuildExecutionResult {
  return {
    status: 'error', executor: 'native', reason,
    message: reason === 'timeout'
      ? 'compile job wall-clock deadline exceeded'
      : 'build execution was cancelled',
    actions: [], diagnostics: [], durationMs: Date.now() - started,
  };
}

function stableMainSketch(files: readonly SourceFile[]): SourceFile {
  const sketches = files
    .filter((file) => extname(file.name).toLowerCase() === '.ino' && !file.name.includes('/'))
    .slice()
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return sketches.find((file) => file.name.toLowerCase() === 'main.ino') ?? sketches[0]!;
}

export function decodeNativeSketchAction(
  action: Extract<BuildAction, { kind: 'transform' }>,
  readFile: (path: string) => Uint8Array,
): { sourceName: string; files: Array<{ path: string; content: string }> } {
  const current = action.inputs.some((input) => input.role === 'sketch-main' || input.role === 'sketch-tab');
  let paths: string[];
  if (current) {
    const main = action.inputs.filter((input) => input.role === 'sketch-main');
    const tabs = action.inputs.filter((input) => input.role === 'sketch-tab')
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    if (main.length !== 1 || main[0]!.path !== action.transform.input
      || main.length + tabs.length !== action.inputs.length
      || tabs.some((input) => input.path === action.transform.input || !isRootSketchPath(input.path))) {
      throw new TypeError(`preprocess Action ${action.id} sketch inputs are invalid`);
    }
    paths = [main[0]!.path, ...tabs.map((input) => input.path)];
  } else {
    if (action.inputs.length !== 1 || action.inputs[0]!.path !== action.transform.input) {
      throw new TypeError(`preprocess Action ${action.id} legacy input is invalid`);
    }
    paths = [action.transform.input];
  }
  if (!isRootSketchPath(action.transform.input)
    || new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
    throw new TypeError(`preprocess Action ${action.id} sketch paths are invalid`);
  }
  const expectedArguments = [...paths, '-o', action.transform.output, ...action.transform.flags];
  if (expectedArguments.length !== action.arguments.length
    || expectedArguments.some((value, index) => action.arguments[index] !== value)) {
    throw new TypeError(`preprocess Action ${action.id} arguments are invalid`);
  }
  const decoder = new TextDecoder();
  return {
    sourceName: action.transform.input,
    files: paths.map((path) => ({ path, content: decoder.decode(readFile(path)) })),
  };
}

function isRootSketchPath(path: string): boolean {
  return /^[^/\\]+\.ino$/i.test(path);
}

function isActionGraphIR(ir: BuildIR): boolean {
  return ir.graph.actions.some((action) => action.kind === 'compile' || action.kind === 'archive' || action.kind === 'link');
}

function selectBuildIRArtifactFormats(ir: BuildIR, formats: ReadonlySet<string>): BuildIR {
  const productPaths = new Set(ir.graph.actions.flatMap((action) => (
    action.outputs
      .filter((output) => output.kind !== undefined && formats.has(output.kind))
      .map((output) => output.path)
  )));
  const artifacts = ir.artifacts.filter((artifact) => (
    formats.has(artifact.format) || productPaths.has(artifact.path)
  ));
  const artifactPaths = new Set(artifacts.map((artifact) => artifact.path));
  const producers = ir.graph.actions.filter((action) => (
    action.outputs.some((output) => artifactPaths.has(output.path))
  ));
  const byId = new Map(ir.graph.actions.map((action) => [action.id, action] as const));
  const selected = new Set<string>();
  const visit = (action: BuildAction): void => {
    if (selected.has(action.id)) return;
    selected.add(action.id);
    for (const dependency of action.dependencies) {
      const candidate = byId.get(dependency);
      if (candidate) visit(candidate);
    }
  };
  for (const producer of producers) visit(producer);
  return {
    ...ir,
    graph: { actions: ir.graph.actions.filter((action) => selected.has(action.id)) },
    artifacts,
  };
}

function compileRequestFromActionGraph(ir: BuildIR): CompileRequest {
  const libraries = ir.packs.libraries.roots
    .map((id) => ir.packs.libraries.packs.find((candidate) => candidate.id === id))
    .filter((pack): pack is LibraryPackRef => pack !== undefined && !pack.id.startsWith('local-library-'))
    .map((pack) => ({ name: pack.name, version: pack.version }));
  return {
    board: ir.target.fqbn,
    files: ir.project.files.map((file) => ({ name: file.path, content: file.content })),
    options: { ...ir.target.options },
    ...(libraries.length ? { libraries } : {}),
  };
}

function actionStage(kind: BuildAction['kind']): CompileStage {
  switch (kind) {
    case 'compile': return 'compiling';
    case 'archive': return 'libraries';
    case 'link': return 'linking';
    case 'transform': return 'imaging';
  }
}

function resolvePlatformProperty(
  properties: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const raw = properties[name];
  if (!raw?.trim()) return undefined;
  const value = expandPlatformValue(properties, raw).trim();
  return value.includes('{') || !value ? undefined : value;
}

function expandPlatformValue(
  properties: Readonly<Record<string, string>>,
  raw: string,
): string {
  let value = raw;
  for (let pass = 0; pass < 32; pass += 1) {
    const expanded: string = value.replace(/\{([^{}]+)\}/g, (placeholder, key: string) => (
      Object.prototype.hasOwnProperty.call(properties, key)
        ? properties[key]!.trim()
        : placeholder
    ));
    if (expanded === value) break;
    value = expanded;
  }
  return value;
}

function resolvePlatformBuildFlags(
  properties: Readonly<Record<string, string>>,
): { defines: string[]; compilerFlags: string[] } {
  const raw = properties['build.extra_flags'];
  if (!raw?.trim()) return { defines: [], compilerFlags: [] };

  const defines: string[] = [];
  const compilerFlags: string[] = [];
  const seenDefines = new Set<string>();
  const seenCompilerFlags = new Set<string>();
  for (const token of tokenizeRecipe(expandPlatformValue(properties, raw))) {
    if (token.includes('{') || token.includes('}')) continue;
    if (token.startsWith('-D') && token.length > 2) {
      const define = token.slice(2);
      if (!seenDefines.has(define)) {
        seenDefines.add(define);
        defines.push(define);
      }
      continue;
    }
    if (!seenCompilerFlags.has(token)) {
      seenCompilerFlags.add(token);
      compilerFlags.push(token);
    }
  }
  return { defines, compilerFlags };
}

function standardPlatformBuildOptions(
  standardPlatform: ResolvedPlatformManifest,
): Record<string, string> {
  const buildMenus = new Set(standardPlatform.board.menus
    .filter((menu) => menu.options.some((option) => (
      Object.keys(option.properties).some((name) => name.startsWith('build.'))
    )))
    .map((menu) => menu.id));
  return Object.fromEntries(Object.entries(standardPlatform.options)
    .filter(([name]) => buildMenus.has(name))
    .sort(([left], [right]) => compareStrings(left, right)));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compileResultFromNativeExecution(
  execution: BuildExecutionResult,
  ir: BuildIR,
  allowStaticOnly = false,
  options: BuildExecutionOptions = {},
  customApplicationSlot?: Esp32ApplicationSlot,
): CompileResult {
  const initialInterruption = interruptionReason(options);
  if (initialInterruption) return compileInterruptionResult(initialInterruption, execution.durationMs);
  const diagnostics: Diagnostic[] = execution.diagnostics.map((diagnostic) => ({
    severity: diagnostic.severity,
    file: diagnostic.sourceFile,
    line: diagnostic.sourceLine,
    ...(diagnostic.sourceColumn === undefined ? {} : { column: diagnostic.sourceColumn }),
    message: diagnostic.message,
    ...(diagnostic.raw === undefined ? {} : { raw: diagnostic.raw }),
    ...(diagnostic.fromGenerated ? { fromGenerated: true } : {}),
  }));
  if (execution.status === 'error') {
    const reason: Extract<CompileResult, { status: 'error' }>['reason'] = execution.reason === 'timeout'
      ? 'timeout'
      : execution.reason === 'resource_limit'
        ? 'resource_limit'
        : execution.reason === 'cancelled'
          ? 'cancelled'
          : execution.reason === 'compile'
            ? 'compile_error'
            : 'internal';
    return {
      status: 'error', reason, message: execution.message, diagnostics,
      timings: { total: execution.durationMs },
    };
  }

  if (customApplicationSlot) {
    const applicationPath = esp32ApplicationArtifactPath(ir);
    const application = applicationPath === undefined
      ? undefined
      : execution.artifacts.find((artifact) => artifact.path === applicationPath);
    if (!application) {
      return {
        status: 'error', reason: 'internal',
        message: 'NativeExecutor completed without the custom-partition application artifact',
        diagnostics, timings: { total: execution.durationMs },
      };
    }
    try {
      assertEsp32ApplicationFitsSlot(application.bytes.byteLength, customApplicationSlot);
    } catch (error) {
      return {
        status: 'error',
        reason: error instanceof Esp32CustomPartitionsError && error.code === 'capacity'
          ? 'resource_limit'
          : 'internal',
        message: error instanceof Error ? error.message : String(error),
        diagnostics,
        timings: { total: execution.durationMs },
      };
    }
  }

  const descriptors = new Map(ir.artifacts.map((artifact) => [artifact.path, artifact] as const));
  const artifacts: Artifact[] = [];
  const staticArtifacts: Artifact[] = [];
  for (const artifact of execution.artifacts) {
    const interrupted = interruptionReason(options);
    if (interrupted) return compileInterruptionResult(interrupted, execution.durationMs);
    const descriptor = descriptors.get(artifact.path);
    if (!descriptor || descriptor.format === 'elf') continue;
    const value: Artifact = {
      name: basename(artifact.path),
      offset: descriptor.offset ?? null,
      sha256: artifact.sha256,
      size: artifact.size,
      base64: Buffer.from(artifact.bytes).toString('base64'),
    };
    if (descriptor.format === 'bootloader' || descriptor.format === 'partition' || descriptor.format === 'boot-app0') {
      staticArtifacts.push(value);
    } else {
      artifacts.push(value);
    }
    const afterArtifact = interruptionReason(options);
    if (afterArtifact) return compileInterruptionResult(afterArtifact, execution.durationMs);
  }
  // A planner may intentionally request only an ELF (for a debugging build).
  // Preserve it as the primary artifact instead of reporting a false success
  // with an empty product list.
  if (artifacts.length === 0 && !(allowStaticOnly && staticArtifacts.length > 0)) {
    const elf = execution.artifacts.find((artifact) => descriptors.get(artifact.path)?.format === 'elf');
    const descriptor = elf ? descriptors.get(elf.path) : undefined;
    if (elf && descriptor) {
      artifacts.push({
        name: basename(elf.path), offset: descriptor.offset ?? null,
        sha256: elf.sha256, size: elf.size, base64: Buffer.from(elf.bytes).toString('base64'),
      });
    }
  }
  if (artifacts.length === 0 && !(allowStaticOnly && staticArtifacts.length > 0)) {
    return {
      status: 'error', reason: 'internal',
      message: 'NativeExecutor completed without a declared build artifact',
      diagnostics, timings: { total: execution.durationMs },
    };
  }
  return {
    status: 'success', artifacts, staticArtifacts, diagnostics,
    timings: { total: execution.durationMs },
    cached: execution.actions.length > 0 && execution.actions.every((action) => action.cached),
  };
}

function buildIRUsesCustomPartitions(ir: BuildIR): boolean {
  return ir.project.files.some((file) => file.path === ESP32_CUSTOM_PARTITIONS_FILE)
    || ir.graph.actions.some((action) => (
      action.kind === 'transform'
      && action.transform.format === 'partition'
      && action.inputs.some((input) => input.path === ESP32_CUSTOM_PARTITIONS_FILE)
    ));
}

function esp32ApplicationArtifactPath(ir: BuildIR): string | undefined {
  const declared = ir.graph.actions.flatMap((action) => (
    action.outputs.filter((output) => output.kind === 'application').map((output) => output.path)
  ));
  if (declared.length === 1) return declared[0];
  const fallback = ir.artifacts.filter((artifact) => (
    artifact.format === 'bin' && artifact.offset?.toLowerCase() === '0x10000'
  ));
  return fallback.length === 1 ? fallback[0]!.path : undefined;
}

function compileInterruptionResult(
  reason: InterruptionReason,
  durationMs = 0,
): CompileResult {
  return {
    status: 'error', reason,
    message: reason === 'timeout'
      ? 'compile job wall-clock deadline exceeded'
      : 'compile was cancelled',
    diagnostics: [], timings: { total: durationMs },
  };
}

function createLibraryPackRefs(libraries: readonly Library[]): LibraryPackRef[] {
  const byName = new Map(libraries.map((library) => [library.manifest.name.toLowerCase(), library] as const));
  return libraries.map((library) => ({
    kind: 'library' as const,
    id: `library:${library.manifest.name}@${library.manifest.version}`,
    name: library.manifest.name,
    version: library.manifest.version,
    sha256: libraryIdentity(library),
    architectures: [...library.manifest.architectures],
    manifest: { name: library.manifest.name, version: library.manifest.version },
    dependencies: library.manifest.depends.map((dependency) => {
      const target = byName.get(dependency.toLowerCase());
      if (!target) throw new TypeError(`missing resolved library dependency: ${dependency}`);
      return {
        id: `library:${target.manifest.name}@${target.manifest.version}`,
        version: target.manifest.version,
        sha256: libraryIdentity(target),
      };
    }),
  }));
}

const PLANNER_SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.s', '.asm', '.h', '.hh', '.hpp', '.hxx', '.inc',
  // Arduino AVR's C++ compatibility header is intentionally extensionless
  // (`cores/arduino/new`) and is included by `new.h`.
  '',
]);

const NATIVE_ESP32_SDK_ROOT = 'packs/platform/sdk';
const NATIVE_ESP32_BOARD_ROOT = 'packs/board';
const ESP32_ESP_SR_PARTITION_SCHEME = 'esp_sr_16';
const ESP32_ESP_SR_MODEL_ARTIFACT_ID = 'srmodels';
const ESP32_ESP_SR_MODEL_SIZE = 2_468_362;
const ESP32_ESP_SR_MODEL_SHA256 = '0312f2dde9581cd604e752fbfa287d687a2acc0631e593a35a24c4a518d75879';

interface NativeEsp32SdkLayout {
  hostRoot: string;
  logicalRoot: typeof NATIVE_ESP32_SDK_ROOT;
  memoryType: string;
  profile: ReturnType<typeof resolveEsp32BuildProfile>;
}

interface NativeEsp32BoardFile {
  hostPath: string;
  logicalPath: string;
  sha256: Sha256;
  size: number;
}

interface NativeEsp32BoardFiles {
  bootloader: NativeEsp32BoardFile;
  partition: NativeEsp32BoardFile;
  bootApp0: NativeEsp32BoardFile;
  model?: NativeEsp32BoardFile;
}

interface NativeEsp32LinkerScripts {
  arguments: string[];
  inputs: ActionInput[];
}

function esp32BootloaderTemplate(
  profile: ReturnType<typeof resolveEsp32BuildProfile>,
): string {
  return `bootloader_${profile.boot}_${profile.bootFreq}.elf`;
}

function resolveNativeEsp32BoardFiles(
  config: NonNullable<ToolchainConfig['esp32']>,
  sdk: NativeEsp32SdkLayout,
): NativeEsp32BoardFiles {
  const partitionRoot = join(config.platformDir, 'tools', 'partitions');
  const resolveFile = (hostPath: string, logicalPath: string): NativeEsp32BoardFile => {
    let bytes: Uint8Array;
    let size: number;
    try {
      const stat = statSync(hostPath);
      if (!stat.isFile()) throw new Error('not a regular file');
      size = stat.size;
      bytes = new Uint8Array(readFileSync(hostPath));
    } catch (error) {
      throw new Error(`ESP32 Board Pack input is unavailable: ${hostPath}`, { cause: error });
    }
    return { hostPath, logicalPath, sha256: sha256Hex(bytes), size };
  };
  const resolveEspSrModel = (): NativeEsp32BoardFile | undefined => {
    if (sdk.profile.partitions !== ESP32_ESP_SR_PARTITION_SCHEME) return undefined;
    const model = resolveFile(
      join(sdk.hostRoot, 'esp_sr', 'srmodels.bin'),
      `${NATIVE_ESP32_BOARD_ROOT}/srmodels.bin`,
    );
    if (model.size !== ESP32_ESP_SR_MODEL_SIZE) {
      throw new Error(
        `ESP32 ESP-SR model size mismatch: expected ${ESP32_ESP_SR_MODEL_SIZE}, got ${model.size}`,
      );
    }
    if (model.sha256 !== ESP32_ESP_SR_MODEL_SHA256) {
      throw new Error('ESP32 ESP-SR model SHA-256 mismatch');
    }
    return model;
  };
  const bootloaderName = esp32BootloaderTemplate(sdk.profile);
  return {
    bootloader: resolveFile(
      join(sdk.hostRoot, 'bin', bootloaderName),
      `${NATIVE_ESP32_BOARD_ROOT}/sdk-bin/${bootloaderName}`,
    ),
    partition: resolveFile(
      join(partitionRoot, `${sdk.profile.partitions}.csv`),
      `${NATIVE_ESP32_BOARD_ROOT}/partitions/${sdk.profile.partitions}.csv`,
    ),
    bootApp0: resolveFile(
      join(partitionRoot, 'boot_app0.bin'),
      `${NATIVE_ESP32_BOARD_ROOT}/partitions/boot_app0.bin`,
    ),
    ...(sdk.profile.partitions === ESP32_ESP_SR_PARTITION_SCHEME
      ? { model: resolveEspSrModel()! }
      : {}),
  };
}

function resolveNativeEsp32LinkerScripts(
  sdk: NativeEsp32SdkLayout,
): NativeEsp32LinkerScripts {
  const responsePath = join(sdk.hostRoot, 'flags', 'ld_scripts');
  const tokens = readFileSync(responsePath, 'utf8').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new Error(`ESP32 SDK linker script list is empty: ${responsePath}`);

  const arguments_: string[] = [];
  const inputs: ActionInput[] = [];
  const seen = new Set<string>();
  const addScript = (value: string, compact: boolean): void => {
    if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
      throw new Error(`ESP32 SDK linker script path must be Pack-relative: ${value}`);
    }
    const candidateRoots = [
      { hostRoot: join(sdk.hostRoot, 'ld'), logicalRoot: `${sdk.logicalRoot}/ld` },
      { hostRoot: join(sdk.hostRoot, sdk.memoryType), logicalRoot: `${sdk.logicalRoot}/${sdk.memoryType}` },
    ];
    let hostPath = '';
    let logicalPath = '';
    for (const root of candidateRoots) {
      const candidate = join(root.hostRoot, value);
      const relativePath = relative(root.hostRoot, candidate).replaceAll('\\', '/');
      if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) {
        throw new Error(`ESP32 SDK linker script escapes its Pack: ${value}`);
      }
      let stat;
      try { stat = statSync(candidate); } catch { continue; }
      if (!stat.isFile()) continue;
      hostPath = candidate;
      logicalPath = `${root.logicalRoot}/${relativePath}`;
      break;
    }
    if (!hostPath) {
      throw new Error(`ESP32 SDK linker script is unavailable: ${value}`);
    }
    const bytes = new Uint8Array(readFileSync(hostPath));
    if (!seen.has(logicalPath)) {
      inputs.push({ path: logicalPath, sha256: sha256Hex(bytes), role: 'linker-script' });
      seen.add(logicalPath);
    }
    if (compact) arguments_.push(`-T${logicalPath}`);
    else arguments_.push('-T', logicalPath);
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '-T') {
      const script = tokens[++index];
      if (!script) throw new Error(`ESP32 SDK linker script list ends after -T: ${responsePath}`);
      addScript(script, false);
    } else if (token.startsWith('-T') && token.length > 2) {
      addScript(token.slice(2), true);
    } else {
      arguments_.push(token);
    }
  }
  return { arguments: arguments_, inputs };
}

function resolveNativeEsp32SdkLayout(
  config: NonNullable<ToolchainConfig['esp32']>,
  board: BoardDefinition,
  options: Record<string, string>,
): NativeEsp32SdkLayout {
  const profile = resolveEsp32BuildProfile(board, options);
  const hostRoot = config.sdkRootFor(profile.sdkTarget);
  if (!hostRoot) {
    throw new Error(`ESP32 SDK Pack is not configured for ${profile.sdkTarget}`);
  }
  return {
    hostRoot,
    logicalRoot: NATIVE_ESP32_SDK_ROOT,
    memoryType: `${profile.boot}_${profile.psramType}`,
    profile,
  };
}

function readPlannerSourceFiles(
  rootDir: string,
  allowlistedPaths?: readonly string[],
  execution: BuildExecutionOptions = {},
): Array<{ path: string; content: string }> {
  throwIfInterrupted(execution);
  const paths = allowlistedPaths ? [...allowlistedPaths] : listPlannerFiles(rootDir, execution);
  const files: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();
  for (const filePath of paths.sort()) {
    throwIfInterrupted(execution);
    let stat;
    try { stat = statSync(filePath); } catch { continue; }
    if (!stat.isFile() || !PLANNER_SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase())) continue;
    const path = relative(rootDir, filePath).replaceAll('\\', '/');
    if (!path || path.startsWith('../') || seen.has(path)) continue;
    try {
      files.push({ path, content: readFileSync(filePath, 'utf8') });
      throwIfInterrupted(execution);
      seen.add(path);
    } catch {
      // A stale optional source file is omitted; the executor will still
      // validate the immutable Pack before any Action is run.
    }
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function prefixPlannerFiles(
  prefix: string,
  files: Array<{ path: string; content: string }>,
): Array<{ path: string; content: string }> {
  return files.map((file) => ({ ...file, path: `${prefix}/${file.path}` }));
}

function sourcePack(
  root: string,
  destination: string,
  sha256: Sha256,
  allowlistedPaths: readonly string[] | undefined,
  content: Sha256 | { contentRoot: string; contentSha256: Sha256 },
  execution: BuildExecutionOptions = {},
): NativePackSource {
  const files: NativePackFile[] = readPlannerSourceFiles(root, allowlistedPaths, execution).map((file) => ({
    path: file.path,
    sha256: sha256Hex(file.content),
  }));
  return {
    root,
    destination,
    sha256,
    ...(typeof content === 'string'
      ? { contentSha256: content }
      : content ?? {}),
    files,
  };
}

function binaryPackSource(
  root: string,
  destination: string,
  sha256: Sha256,
  extensions: ReadonlySet<string>,
  allowlistedPaths: readonly string[] | undefined,
  content: { contentRoot: string; contentSha256: Sha256 },
  execution: BuildExecutionOptions = {},
): NativePackSource {
  throwIfInterrupted(execution);
  const files = (allowlistedPaths ? [...allowlistedPaths].sort() : listPlannerFiles(root, execution))
    .filter((path) => extensions.has(extname(path).toLowerCase()))
    .map((path) => {
      throwIfInterrupted(execution);
      const file = {
        path: relative(root, path).replaceAll('\\', '/'),
        sha256: sha256Hex(new Uint8Array(readFileSync(path))),
      };
      throwIfInterrupted(execution);
      return file;
    });
  return { root, destination, sha256, ...(content ?? {}), files };
}

function bindPlatformCommandInputs(
  required: readonly ActionInput[],
  indexed: readonly ActionInput[],
  label: string,
): ActionInput[] {
  const byPath = new Map<string, ActionInput>();
  for (const input of indexed) {
    if (byPath.has(input.path)) throw new TypeError(`${label} input is duplicated: ${input.path}`);
    byPath.set(input.path, input);
  }
  return required.map((input) => {
    const match = byPath.get(input.path);
    if (!match?.sha256) throw new TypeError(`${label} input is not indexed: ${input.path}`);
    return { ...match, role: input.role ?? match.role };
  });
}

function nativePackFileInput(
  hostPath: string,
  logicalPath: string,
  role: string,
  execution: BuildExecutionOptions = {},
): ActionInput {
  throwIfInterrupted(execution);
  let stat;
  try { stat = statSync(hostPath); } catch { throw new Error(`Native Pack input is missing: ${hostPath}`); }
  if (!stat.isFile()) throw new Error(`Native Pack input is not a regular file: ${hostPath}`);
  const input = {
    path: logicalPath,
    sha256: sha256Hex(new Uint8Array(readFileSync(hostPath))),
    role,
  };
  throwIfInterrupted(execution);
  return input;
}

function requiredPackContentHash(
  roots: ReadonlyMap<string, Sha256>,
  root: string,
  label: string,
): Sha256 {
  const value = roots.get(root);
  if (!value) throw new Error(`${label} content snapshot is missing: ${root}`);
  return value;
}

function libraryDestination(ir: BuildIR, packId: string): string | null {
  for (const action of ir.graph.actions) {
    if (!action.packDependencies.includes(packId)) continue;
    for (const input of action.inputs) {
      const segments = input.path.split('/');
      if (segments.length >= 4 && segments[0] === 'packs' && segments[1] === 'libraries') {
        return segments.slice(0, 3).join('/');
      }
    }
  }
  return null;
}

function parseEsp32FlashSizeBytes(value: string): number {
  const match = /^(\d+)(B|KB|K|MB|M)$/i.exec(value.trim());
  if (!match) throw new TypeError(`ESP32 flash size is invalid: ${value}`);
  const amount = BigInt(match[1]!);
  const unit = match[2]!.toUpperCase();
  const multiplier = unit === 'B' ? 1n
    : unit === 'K' || unit === 'KB' ? 1024n
      : 1024n * 1024n;
  const bytes = amount * multiplier;
  if (bytes <= 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`ESP32 flash size is out of range: ${value}`);
  }
  return Number(bytes);
}

function listPlannerFiles(rootDir: string, execution: BuildExecutionOptions = {}): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    throwIfInterrupted(execution);
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      throwIfInterrupted(execution);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(rootDir);
  return files.sort();
}
