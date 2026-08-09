/**
 * ESP32 编译驱动。
 *
 * ## 与 AVR 的三个本质差异
 *
 * **① 重活已经预编译。** ESP-IDF 部分是 espressif/esp32-arduino-libs 提供的
 * 141 个 `.a`，共 111 MB。我们只编 Arduino core（57 个文件）+ 用户 sketch，
 * 然后把这一大堆 `.a` 链进去。所以 ESP32 的耗时大头**不是编译，是链接**，
 * 这也是延迟的硬地板 —— 链接无法按 TU 缓存。
 *
 * **② 编译参数从文件读，不硬编码。** SDK 自带 `flags/{c_flags,cpp_flags,
 * S_flags,defines,includes,ld_flags,ld_libs,ld_scripts}`，gcc 的 `@file`
 * 语法可以直接消费。跟着 SDK 版本走，我们不需要维护一份会过期的副本。
 *
 * **③ 链接用 `--start-group/--end-group`。** IDF 各库之间存在循环符号依赖，
 * 靠分组让链接器反复扫描解决 —— 顺带意味着组内顺序无关紧要，
 * 不像 AVR 那样要仔细排。
 *
 * ## 产物分片
 * 烧录需要四片，但只有最后一片每次都变：
 *   {bootloaderAddr} bootloader.bin  ← 按 (boot, freq) 静态
 *   0x8000           partitions.bin  ← 按分区方案静态
 *   0xe000           boot_app0.bin   ← 完全静态
 *   0x10000          firmware.bin    ← 每次编译产出
 * 前三片作为 staticArtifacts 返回，浏览器可永久缓存，
 * 后续烧录只写 0x10000。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, existsSync, statSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { platform } from 'node:os';
import type { SandboxExecutor, ResourceLimits } from '../sandbox/types.js';
import { DEFAULT_LIMITS } from '../sandbox/types.js';
import type { Esp32Toolchain as Esp32Config } from './config.js';
import { esp32SdkTargets, type BoardDefinition } from './board.js';
import type { Library } from './library.js';
import type { CompileStage, MemoryUsage } from '../types.js';
import { contentIdentity } from '../cache/identity.js';
import {
  discardDerivedCacheEntry,
  getDerivedCacheManager,
  isDerivedCacheEntryReady,
  markDerivedCacheEntryReady,
  type DerivedCacheManager,
} from '../cache/derived.js';
import { singleFlight } from '../cache/singleflight.js';

const EXE = platform() === 'win32' ? '.exe' : '';
const ARDUINO_VERSION_DEFINE = '10607';
const ESP32_PLATFORM_DEFINE = '-DESP32=ESP32';
// v3: target-specific Xtensa launchers select the required little-endian
// dynconfig; v2 archives built through the generic launcher are incompatible.
const ESP32_DERIVED_CACHE_FORMAT = 'arduinofast-esp32-derived-v4';
/** 预编译头的文件名。GCC 在准备打开 `X` 时会先找同目录的 `X.gch` */
const PCH_HEADER = 'af_pch.h';
const PCH_SOURCE = '#include <Arduino.h>\n';
const PCH_FILE_SIZE_BYTES = 128 * 1024 * 1024;

/**
 * Fully resolved ESP32 build parameters. It is derived only from the trusted
 * board definition plus already validated option values, and is used by every
 * compiler/cache/static-artifact path so a menu selection cannot be cosmetic.
 */
export interface Esp32BuildProfile {
  /** Trusted SDK family; normally the MCU, but P4 varies by silicon revision. */
  sdkTarget: string;
  fCpu: string;
  partitions: string;
  flashMode: string;
  flashFreq: string;
  imageFreq: string;
  flashSize: string;
  boot: string;
  bootFreq: string;
  psramType: string;
  maxFlash?: number;
  defines: string[];
  compilerFlags: string[];
  linkerFlags: string[];
}

export function resolveEsp32BuildProfile(
  board: BoardDefinition,
  opts: Record<string, string>,
): Esp32BuildProfile {
  const profile: Esp32BuildProfile = {
    sdkTarget: board.build.sdkTarget ?? board.build.mcu,
    fCpu: opts.cpu_freq ?? board.build.fCpu,
    partitions: opts.partition_scheme ?? board.build.partitions ?? 'default',
    flashMode: opts.flash_mode ?? board.build.flashMode ?? 'dio',
    flashFreq: opts.flash_freq ?? board.build.flashFreq ?? '40m',
    imageFreq: board.build.imageFreq ?? opts.flash_freq ?? board.build.flashFreq ?? '40m',
    flashSize: opts.flash_size ?? board.build.flashSize ?? '4MB',
    // Keep the original shorthand for existing ESP32 definitions. New boards
    // use optionEffects to model upstream FlashMode values exactly.
    boot: opts.flash_mode === 'qio' ? 'qio' : (board.build.boot ?? 'dio'),
    bootFreq: board.build.bootFreq ?? board.build.flashFreq ?? '40m',
    psramType: board.build.psramType ?? 'qspi',
    defines: [...board.build.defines],
    compilerFlags: [...(board.build.extraFlags ?? [])],
    linkerFlags: [],
  };

  for (const [optionId, value] of Object.entries(opts)) {
    const effect = board.build.optionEffects?.[optionId]?.[value];
    if (!effect) continue;
    if (effect.sdkTarget) profile.sdkTarget = effect.sdkTarget;
    if (effect.fCpu) profile.fCpu = effect.fCpu;
    if (effect.partitions) profile.partitions = effect.partitions;
    if (effect.flashMode) profile.flashMode = effect.flashMode;
    if (effect.flashFreq) profile.flashFreq = effect.flashFreq;
    if (effect.imageFreq) profile.imageFreq = effect.imageFreq;
    if (effect.flashSize) profile.flashSize = effect.flashSize;
    if (effect.boot) profile.boot = effect.boot;
    if (effect.bootFreq) profile.bootFreq = effect.bootFreq;
    if (effect.psramType) profile.psramType = effect.psramType;
    if (Number.isSafeInteger(effect.maxFlash) && effect.maxFlash! > 0) {
      profile.maxFlash = effect.maxFlash;
    }
    if (effect.defines) profile.defines.push(...effect.defines);
    if (effect.compilerFlags) profile.compilerFlags.push(...effect.compilerFlags);
    if (effect.linkerFlags) profile.linkerFlags.push(...effect.linkerFlags);
  }

  return profile;
}

export interface Esp32PartitionToolInvocation {
  command: string;
  argsPrefix: string[];
  identityPath: string;
}

/** 官方 core 在 POSIX 平台只提供 Python 脚本；`.exe` 仅供 Windows 使用。 */
export function esp32PartitionToolInvocation(
  platformDir: string,
  hostPlatform: NodeJS.Platform = platform(),
): Esp32PartitionToolInvocation {
  const toolsDir = join(platformDir, 'tools');
  if (hostPlatform === 'win32') {
    const executable = join(toolsDir, 'gen_esp32part.exe');
    return { command: executable, argsPrefix: [], identityPath: executable };
  }
  const script = join(toolsDir, 'gen_esp32part.py');
  return { command: 'python3', argsPrefix: [script], identityPath: script };
}

export function toolchainParallelismFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AF_TOOLCHAIN_PARALLELISM;
  if (!raw || !/^\d+$/.test(raw)) return 1;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(8, parsed)) : 1;
}

/** `recipe.size.regex`：计入 Flash 占用的 section */
const FLASH_SECTIONS = [
  '.iram0.text', '.iram0.vectors', '.dram0.data', '.dram1.data',
  '.flash.text', '.flash.rodata', '.flash.appdesc', '.flash.init_array', '.eh_frame',
];
/** `recipe.size.regex.data`：计入 RAM 占用的 section */
const RAM_SECTIONS = ['.dram0.data', '.dram0.bss', '.dram1.data', '.dram1.bss', '.noinit'];

export interface Esp32BuildResult {
  ok: boolean;
  output: string;
  binPath?: string;
  elfPath?: string;
  /** 静态分片（bootloader / partitions / boot_app0），可被浏览器永久缓存 */
  staticParts?: Array<{ offset: string; name: string; path: string }>;
  memory?: MemoryUsage;
  timings: Record<string, number>;
  failedStage?: string;
  timedOut?: boolean;
}

export type Esp32StageReporter = (stage: CompileStage, percent: number, detail?: string) => void;

export interface Esp32ArchiveProgress {
  completed: number;
  total: number;
  cached: boolean;
  archiving?: boolean;
}

function compilerPrefix(cfg: Esp32Config, board: BoardDefinition): string | null {
  const tarch = board.build.tarch ?? 'xtensa';
  const target = board.build.target ?? 'esp32';
  const binDir = tarch === 'riscv32' ? cfg.riscvBinDir : cfg.xtensaBinDir;
  if (!binDir) return null;
  const prefixes = tarch === 'riscv32'
    ? ['riscv32-esp-elf-']
    : [`${tarch}-${target}-elf-`, 'xtensa-esp-elf-'];
  return prefixes.find((prefix) => existsSync(join(binDir, `${prefix}g++${EXE}`))) ?? null;
}

/** 启动时按板卡核对编译器、SDK、variant 与 esptool，避免公布实际不能编译的板子。 */
export function esp32BoardSupported(cfg: Esp32Config, board: BoardDefinition): boolean {
  if (board.arch !== 'esp32') return false;
  const prefix = compilerPrefix(cfg, board);
  const binDir = (board.build.tarch ?? 'xtensa') === 'riscv32'
    ? cfg.riscvBinDir
    : cfg.xtensaBinDir;
  if (!prefix || !binDir) return false;
  const sdks = esp32SdkTargets(board).map((target) => {
    try { return cfg.sdkRootFor(target); } catch { return null; }
  });
  return Boolean(
    sdks.length > 0
    && ['gcc', 'g++', 'gcc-ar', 'size'].every((name) =>
      existsSync(join(binDir, `${prefix}${name}${EXE}`)))
    && sdks.every((sdk) => sdk && existsSync(join(sdk, 'flags', 'cpp_flags')))
    && existsSync(join(cfg.variantsDir, board.build.variant))
    && existsSync(cfg.coreDir)
    && existsSync(cfg.platformDir)
    && existsSync(cfg.esptool)
  );
}

export class Esp32Toolchain {
  private libraryRoots: string[] = [];
  // A driver instance represents one immutable build-input snapshot.
  private readonly inputIdentities = new Map<string, string>();
  private readonly cacheManager: DerivedCacheManager;

  constructor(
    private readonly cfg: Esp32Config,
    private readonly executor: SandboxExecutor,
    private readonly cacheDir: string,
    private readonly limits: ResourceLimits = DEFAULT_LIMITS,
    private readonly toolchainIdentity?: string,
    private readonly immutableBundle = false,
    /** Set only when toolchainIdentity is a full content snapshot of toolchain-owned paths. */
    private readonly toolchainIdentityCoversInputs = false,
  ) {
    this.cacheManager = getDerivedCacheManager(cacheDir);
  }

  private inputIdentity(path: string, coveredByToolchainSnapshot = false): string {
    const cacheKey = `${coveredByToolchainSnapshot ? 'toolchain' : 'content'}\0${path}`;
    const cached = this.inputIdentities.get(cacheKey);
    if (cached) return cached;
    // The CompileService snapshot covers SDK/core/platform inputs. Third-party
    // libraries remain content-addressed because they are mutable independently
    // of an unpacked local toolchain.
    const identity = (this.immutableBundle
      || (coveredByToolchainSnapshot && this.toolchainIdentityCoversInputs))
      && this.toolchainIdentity
      ? createHash('sha256')
          .update('arduinofast-immutable-input-v1\0')
          .update(this.toolchainIdentity)
          .update('\0')
          .update(path)
          .digest('hex')
      : contentIdentity(path);
    this.inputIdentities.set(cacheKey, identity);
    return identity;
  }

  private compilerIdentity(board: BoardDefinition, opts: Record<string, string>): string {
    const profile = resolveEsp32BuildProfile(board, opts);
    if (this.toolchainIdentity) {
      return createHash('sha256')
        .update('arduinofast-esp32-sdk-profile-v1\0')
        .update(this.toolchainIdentity)
        .update('\0')
        .update(profile.sdkTarget)
        .digest('hex');
    }
    const paths = [
      dirname(this.binDir(board)),
      this.sdk(board, opts),
      this.cfg.coreDir,
      this.cfg.variantsDir,
      this.cfg.platformDir,
      this.cfg.esptool,
    ];
    return createHash('sha256')
      .update(JSON.stringify(paths.map((path) => ({ path, identity: this.inputIdentity(path) }))))
      .digest('hex');
  }

  setLibraryRoots(dirs: string[]): void { this.libraryRoots = dirs; }

  // ---------------------------------------------------------------------
  // 路径解析
  // ---------------------------------------------------------------------

  /**
   * 预编译 SDK 的位置按受信任的 SDK family 找，不是按 target。
   *
   * 这两者在 ESP32-C3 上会分叉：boards.txt 里 `esp32c3.build.target=esp`
   * （用于拼编译器前缀 `riscv32-esp-elf-`），而 mcu 才是 `esp32c3`。
   * 用 target 去找会指向不存在的 `esp-libs/`。
   */
  private sdk(board: BoardDefinition, opts: Record<string, string>): string {
    const sdkTarget = resolveEsp32BuildProfile(board, opts).sdkTarget;
    const root = this.cfg.sdkRootFor(sdkTarget);
    if (!root) throw new Error(`未找到 ${sdkTarget} 的预编译 SDK（应在 tools/${sdkTarget}-libs/ 下）`);
    return root;
  }

  private binDir(board: BoardDefinition): string {
    const tarch = board.build.tarch ?? 'xtensa';
    const dir = tarch === 'riscv32' ? this.cfg.riscvBinDir : this.cfg.xtensaBinDir;
    if (!dir) throw new Error(`未找到 ${tarch} 编译器`);
    return dir;
  }

  private compilerRoot(board: BoardDefinition): string {
    const tarch = board.build.tarch ?? 'xtensa';
    return tarch === 'riscv32'
      ? (this.cfg.riscvRootDir ?? dirname(this.binDir(board)))
      : (this.cfg.xtensaRootDir ?? dirname(this.binDir(board)));
  }

  /**
   * 新版 esp-x32 的 target-specific 启动器会选择正确的 Xtensa dynconfig
   * 和 multilib。直接调用统一的 xtensa-esp-elf-* 会落到默认大端运行库，
   * ESP32 的小端对象在最终链接时就会整批报 endian mismatch。
   */
  private tool(board: BoardDefinition, name: string): string {
    const tarch = board.build.tarch ?? 'xtensa';
    const target = board.build.target ?? 'esp32';
    const binDir = this.binDir(board);
    const prefixes = tarch === 'riscv32'
      ? ['riscv32-esp-elf-']
      : [`${tarch}-${target}-elf-`, 'xtensa-esp-elf-'];
    const detected = compilerPrefix(this.cfg, board);
    if (detected) return join(binDir, `${detected}${name}${EXE}`);
    for (const prefix of prefixes) {
      const candidate = join(binDir, `${prefix}${name}${EXE}`);
      if (existsSync(candidate)) return candidate;
    }
    return join(binDir, `${prefixes[prefixes.length - 1]}${name}${EXE}`);
  }

  /** `build.memory_type = {boot}_{psram}`，决定用哪份 spi_flash 库和头文件 */
  private memoryType(board: BoardDefinition, opts: Record<string, string>): string {
    const profile = resolveEsp32BuildProfile(board, opts);
    return `${profile.boot}_${profile.psramType}`;
  }

  // ---------------------------------------------------------------------
  // 编译参数
  // ---------------------------------------------------------------------

  private preprocessorFlags(
    board: BoardDefinition,
    opts: Record<string, string>,
    extraIncludes: string[],
  ): string[] {
    const sdk = this.sdk(board, opts);
    const mem = this.memoryType(board, opts);
    return [
      // @file：gcc 从文件读参数，跟着 SDK 版本走，不用我们维护副本
      `@${join(sdk, 'flags', 'defines')}`,
      // -iprefix 必须在 includes 之前 —— includes 文件里全是 -iwithprefixbefore
      '-iprefix', join(sdk, 'include') + '/',
      `@${join(sdk, 'flags', 'includes')}`,
      `-I${join(sdk, mem, 'include')}`,
      `-I${this.cfg.coreDir}`,
      `-I${join(this.cfg.variantsDir, board.build.variant)}`,
      ...extraIncludes.map((d) => `-I${d}`),
    ];
  }

  /**
   * @param forCore 编译 Arduino core 时为 true —— 此时**不传** `ARDUINO_PARTITION_*`。
   *
   * 为什么要区分：分区方案会进 `-DARDUINO_PARTITION_xxx`，如果编译 core 时也带上它，
   * 每换一种分区方案就得重编一次 core.a（实测约 100 秒 × 5 种方案），
   * 而 **grep 过整个 ESP32 core，没有任何文件引用这个宏** —— 纯浪费。
   *
   * 做法不是"照传但不计入缓存键"（那会让键与实际输入不符，日后 core 真用上了
   * 就会静默串味），而是干脆不传：core.a 就真的与分区方案无关，键也诚实。
   * sketch 和第三方库照常拿得到这个宏。
   *
   * 反例对照：flash 模式**必须**保留在 core 的输入里 ——
   * `dio_qspi/include/sdkconfig.h` 和 `qio_qspi/` 的那份实测不同，core 会受影响。
   */
  private boardDefines(
    board: BoardDefinition,
    opts: Record<string, string>,
    forCore = false,
  ): string[] {
    const profile = resolveEsp32BuildProfile(board, opts);
    const args = [
      `-DF_CPU=${profile.fCpu}`,
      `-DARDUINO=${ARDUINO_VERSION_DEFINE}`,
      `-DARDUINO_${board.build.boardDefine ?? 'ESP32_DEV'}`,
      '-DARDUINO_ARCH_ESP32',
      ESP32_PLATFORM_DEFINE,
      `-DARDUINO_BOARD="${board.build.boardDefine ?? 'ESP32_DEV'}"`,
      `-DARDUINO_VARIANT="${board.build.variant}"`,
      ...(forCore ? [] : [`-DARDUINO_PARTITION_${profile.partitions}`]),
      ...profile.defines.map((d) => `-D${d}`),
      ...profile.compilerFlags,
    ];

    const esp32Directives: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const argument = args[index]!;
      const inline = /^-[DU]([^=]+)(?:=.*)?$/.exec(argument);
      if (inline?.[1] === 'ESP32') esp32Directives.push(argument);
      if ((argument === '-D' || argument === '-U') && args[index + 1]?.split('=', 1)[0] === 'ESP32') {
        esp32Directives.push(`${argument} ${args[index + 1]}`);
      }
    }
    if (esp32Directives.length !== 1 || esp32Directives[0] !== ESP32_PLATFORM_DEFINE) {
      throw new Error(`ESP32 compiler arguments must contain exactly one ${ESP32_PLATFORM_DEFINE}`);
    }
    return args;
  }

  private cppFlags(board: BoardDefinition, opts: Record<string, string>, warnings: string, inc: string[], forCore = false): string[] {
    return [
      '-MMD', '-c', `@${join(this.sdk(board, opts), 'flags', 'cpp_flags')}`,
      warnings, '-Os', '-Werror=return-type',
      ...this.boardDefines(board, opts, forCore),
      ...this.preprocessorFlags(board, opts, inc),
    ];
  }

  private cFlags(board: BoardDefinition, opts: Record<string, string>, warnings: string, inc: string[], forCore = false): string[] {
    return [
      '-MMD', '-c', `@${join(this.sdk(board, opts), 'flags', 'c_flags')}`,
      warnings, '-Os', '-Werror=return-type',
      ...this.boardDefines(board, opts, forCore),
      ...this.preprocessorFlags(board, opts, inc),
    ];
  }

  private asmFlags(board: BoardDefinition, opts: Record<string, string>, inc: string[], forCore = false): string[] {
    return [
      '-MMD', '-c', '-x', 'assembler-with-cpp', `@${join(this.sdk(board, opts), 'flags', 'S_flags')}`,
      '-w', '-Os',
      ...this.boardDefines(board, opts, forCore),
      ...this.preprocessorFlags(board, opts, inc),
    ];
  }

  // ---------------------------------------------------------------------
  // 执行
  // ---------------------------------------------------------------------

  private mounts(
    board: BoardDefinition,
    opts: Record<string, string>,
    writable: string[],
    extraReadOnly: string[] = [],
  ) {
    return {
      readOnlyPaths: [
        this.compilerRoot(board),
        this.sdk(board, opts),
        this.cfg.coreDir,
        this.cfg.variantsDir,
        this.cfg.platformDir,
        this.cfg.esptool,
        ...this.libraryRoots,
        ...extraReadOnly,
      ],
      readWritePaths: writable,
    };
  }

  private async run(
    board: BoardDefinition,
    opts: Record<string, string>,
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    writable: string[] = [cwd],
    extraReadOnly: string[] = [],
    limits: ResourceLimits = this.limits,
  ) {
    const r = await this.executor.exec({
      command: cmd, args, cwd, timeoutMs, limits,
      ...this.mounts(board, opts, writable, extraReadOnly),
    });
    return {
      ok: r.code === 0 && !r.timedOut,
      output: [r.stdout, r.stderr].filter(Boolean).join('\n'),
      timedOut: r.timedOut,
    };
  }

  // ---------------------------------------------------------------------
  // core.a / 库 .a —— 与 AVR 同样的 L1 机制，缓存键不含用户信息
  // ---------------------------------------------------------------------

  private cacheKey(
    kind: 'core' | 'library' | 'pch',
    board: BoardDefinition,
    opts: Record<string, string>,
    includeDirs: string[],
    inputPaths: string[],
    extra: Record<string, unknown>,
    forCore = false,
    toolchainInputPaths: readonly string[] = [],
  ): string {
    const cppFlags = this.cppFlags(board, opts, '-w', includeDirs, forCore);
    const toolchainInputs = new Set(toolchainInputPaths);
    const payload = {
      format: ESP32_DERIVED_CACHE_FORMAT,
      kind,
      toolchain: this.compilerIdentity(board, opts),
      board: board.fqbn,
      memoryType: this.memoryType(board, opts),
      flags: kind === 'pch'
        ? { cpp: [...cppFlags, '-x', 'c++-header'] }
        : {
            cpp: cppFlags,
            c: this.cFlags(board, opts, '-w', includeDirs, forCore),
            asm: this.asmFlags(board, opts, includeDirs, forCore),
          },
      inputs: inputPaths.map((path) => ({
        path,
        identity: this.inputIdentity(path, toolchainInputs.has(path)),
      })),
      includes: includeDirs.map((path) => ({
        path,
        identity: this.inputIdentity(path, toolchainInputs.has(path)),
      })),
      extra,
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private staticPartsCacheKey(
    board: BoardDefinition,
    opts: Record<string, string>,
    configuration: Record<string, string>,
    inputs: Record<string, string>,
  ): string {
    const payload = {
      format: ESP32_DERIVED_CACHE_FORMAT,
      kind: 'static-parts',
      toolchain: this.compilerIdentity(board, opts),
      board: board.fqbn,
      configuration,
      inputs: Object.entries(inputs)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, path]) => ({ name, path, identity: this.inputIdentity(path, true) })),
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private sourcesIn(dir: string, recursive = true): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      let entries: string[];
      try { entries = readdirSync(d); } catch { return; }
      for (const e of entries) {
        const p = join(d, e);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) { if (recursive) walk(p); }
        else if (['.c', '.cpp', '.cc', '.cxx', '.S'].includes(extname(p))) out.push(p);
      }
    };
    walk(dir);
    return out.sort();
  }

  /** 把一组源文件编成一个 .a，带缓存 */
  private async buildArchive(
    board: BoardDefinition,
    opts: Record<string, string>,
    label: string,
    sources: string[],
    includeDirs: string[],
    key: string,
    forCore = false,
    consume?: (path: string) => void | Promise<void>,
    onProgress?: (progress: Esp32ArchiveProgress) => void,
  ): Promise<{ path: string; built: boolean; output: string }> {
    if (sources.length === 0) return { path: '', built: false, output: '' };

    const safe = label.replace(/[^A-Za-z0-9_.-]+/g, '_');
    const dir = join(this.cacheDir, 'esp32', `${safe}-${board.build.mcu}-${key}`);
    const archive = join(dir, `${safe}.a`);

    return this.cacheManager.withLease(dir, async () => {
      this.cacheManager.maybePrune();
      // A second same-process request may join the existing singleflight
      // below. Give it an immediate, truthful "checking/building" frame even
      // though only the leader can report each individual source file.
      onProgress?.({ completed: 0, total: sources.length, cached: false });
      const result = await singleFlight(`esp32-archive:${archive}`, async () => {
        if (isDerivedCacheEntryReady(dir, [archive])) {
          this.cacheManager.touch(dir);
          onProgress?.({ completed: sources.length, total: sources.length, cached: true });
          return { path: archive, built: false, output: '' };
        }

        discardDerivedCacheEntry(dir);
        mkdirSync(dir, { recursive: true });
        const gcc = this.tool(board, 'gcc');
        const gpp = this.tool(board, 'g++');
        const ar = this.tool(board, 'gcc-ar');

        const objects: string[] = new Array(sources.length);
        let output = '';
        let firstError: string | null = null;
        let completed = 0;
        // Eight progress frames are enough to make a cold core visibly move,
        // while staying well inside the bounded Redis/SSE event replay budget.
        const reportEvery = Math.max(1, Math.ceil(sources.length / 8));

        /**
         * 并行编译。
         *
         * ESP32 的 core 有 57 个文件，且每个都要处理巨大的 include 集合
         * （SDK 的 includes 文件就有 14 KB），串行实测约 198 秒。
         * 这是**一次性**成本（之后走 L1 缓存），但生产环境必须在 CI 里预构建，
         * 不能让第一个用户承担；并行化让预构建本身也快得多。
         */
        // 容器里的 os.cpus() 通常看到宿主核数，而不是 --cpus 配额。
        // 必须显式配置，默认 1，避免共享宿主冷构建时瞬间拉满所有核心。
        const concurrency = toolchainParallelismFromEnv();
        let cursor = 0;

        const worker = async (): Promise<void> => {
          for (;;) {
            const i = cursor++;
            if (i >= sources.length || firstError) return;
            const src = sources[i]!;
            const obj = join(dir, `${i}_${basename(src)}.o`);
            const ext = extname(src);
            // core 和第三方库都用 -w：它们的告警对用户既看不懂也改不了
            const [cmd, flags] =
              ext === '.S' ? [gcc, this.asmFlags(board, opts, includeDirs, forCore)]
              : ext === '.c' ? [gcc, this.cFlags(board, opts, '-w', includeDirs, forCore)]
              : [gpp, this.cppFlags(board, opts, '-w', includeDirs, forCore)];

            const r = await this.run(board, opts, cmd!, [...flags!, src, '-o', obj], dir, 180_000, [dir]);
            output += r.output;
            if (!r.ok) {
              firstError ??= `${label} 编译失败于 ${basename(src)}:\n${r.output}`;
              return;
            }
            objects[i] = obj;
            completed++;
            if (completed === sources.length || completed % reportEvery === 0) {
              onProgress?.({ completed, total: sources.length, cached: false });
            }
          }
        };

        await Promise.all(Array.from({ length: concurrency }, worker));
        if (firstError) {
          discardDerivedCacheEntry(dir);
          return { path: '', built: false, output: firstError };
        }

        onProgress?.({
          completed: sources.length,
          total: sources.length,
          cached: false,
          archiving: true,
        });
        const r = await this.run(board, opts, ar, ['rcs', archive, ...objects.filter(Boolean)], dir, 120_000, [dir]);
        output += r.output;
        if (!r.ok) {
          discardDerivedCacheEntry(dir);
          return { path: '', built: false, output: `${label} 打包失败:\n${r.output}` };
        }
        markDerivedCacheEntryReady(dir);
        this.cacheManager.touch(dir);
        this.cacheManager.prune();
        return { path: archive, built: true, output };
      });
      if (result.path && consume) await consume(result.path);
      return result;
    });
  }

  async ensureCore(
    board: BoardDefinition,
    opts: Record<string, string>,
    consume?: (path: string) => void | Promise<void>,
    onProgress?: (progress: Esp32ArchiveProgress) => void,
  ) {
    const sources = this.sourcesIn(this.cfg.coreDir);
    const key = this.cacheKey(
      'core',
      board,
      opts,
      [],
      [this.cfg.coreDir, join(this.cfg.variantsDir, board.build.variant)],
      { sources },
      true,
      [this.cfg.coreDir, join(this.cfg.variantsDir, board.build.variant)],
    );
    return this.buildArchive(board, opts, 'core', sources, [], key, true, consume, onProgress);
  }

  // ---------------------------------------------------------------------
  // 预编译头（PCH）—— sketch 编译提速 18.6×（实测 8028ms → 431ms）
  // ---------------------------------------------------------------------

  /**
   * 把 `Arduino.h` 整棵头文件树预解析一次存成 `.gch`。
   *
   * ESP32 编译单个二十行的 sketch 要 8 秒，时间几乎全花在
   * `#include <Arduino.h>` 展开出的整个 ESP-IDF 头文件树上
   * （SDK 的 includes 参数文件本身就有 14 KB 的搜索路径）。
   * PCH 正是为这个场景存在的。
   *
   * ⚠️ 两个必须遵守的约束：
   *   1. **编译参数必须与消费方完全一致**，差一个字符 GCC 就会静默忽略 PCH，
   *      悄悄退回全量解析 —— 表现是"没报错但也没变快"。所以下面统一用
   *      `pchConsumerFlags()` 生成两边的参数，并加 `-Winvalid-pch` 让失配可见。
   *   2. PCH 只用于 **sketch**，不用于 core 和第三方库：
   *      那些源文件各自 include 自己的头，不以 Arduino.h 打头，套不上；
   *      而且它们本来就有 L1 缓存，不是热路径。
   */
  private async ensurePch(
    board: BoardDefinition,
    opts: Record<string, string>,
    inc: string[],
    consume?: (result: { dir: string; built: boolean; output: string }) => void | Promise<void>,
  ) {
    const key = this.cacheKey(
      'pch',
      board,
      opts,
      inc,
      [this.cfg.coreDir, join(this.cfg.variantsDir, board.build.variant)],
      { source: PCH_SOURCE },
      false,
      [this.cfg.coreDir, join(this.cfg.variantsDir, board.build.variant)],
    );
    const dir = join(this.cacheDir, 'esp32-pch', `${board.build.mcu}-${key}`);
    const header = join(dir, PCH_HEADER);
    const gch = `${header}.gch`;

    return this.cacheManager.withLease(dir, async () => {
      this.cacheManager.maybePrune();
      const result = await singleFlight(`esp32-pch:${gch}`, async () => {
        if (isDerivedCacheEntryReady(dir, [gch])) {
          this.cacheManager.touch(dir);
          return { dir, built: false, output: '' };
        }

        discardDerivedCacheEntry(dir);
        mkdirSync(dir, { recursive: true });
        writeFileSync(header, PCH_SOURCE, 'utf8');

        const r = await this.run(
          board,
          opts,
          this.tool(board, 'g++'),
          // -x c++-header 让 gcc 把它当头文件编译，产出 <name>.gch
          [...this.cppFlags(board, opts, '-w', inc), '-x', 'c++-header', header, '-o', gch],
          dir, 180_000, [dir], [],
          {
            ...this.limits,
            fileSizeBytes: Math.max(this.limits.fileSizeBytes, PCH_FILE_SIZE_BYTES),
          },
        );
        if (!r.ok) {
          // PCH 失败不该让整次编译失败 —— 它只是加速手段，退回不用即可
          discardDerivedCacheEntry(dir);
          return { dir: '', built: false, output: r.output };
        }
        markDerivedCacheEntryReady(dir);
        this.cacheManager.touch(dir);
        this.cacheManager.prune();
        return { dir, built: true, output: r.output };
      });
      if (consume) await consume(result);
      return result;
    });
  }

  async ensureLibrary(
    board: BoardDefinition,
    opts: Record<string, string>,
    lib: Library,
    inc: string[],
    consume?: (path: string) => void | Promise<void>,
  ) {
    const key = this.cacheKey(
      'library',
      board,
      opts,
      inc,
      [lib.rootDir, this.cfg.coreDir, join(this.cfg.variantsDir, board.build.variant)],
      { manifest: lib.manifest, sources: [...lib.sources].sort() },
      false,
      [this.cfg.coreDir, join(this.cfg.variantsDir, board.build.variant)],
    );
    return this.buildArchive(
      board,
      opts,
      lib.manifest.name,
      [...lib.sources].sort(),
      inc,
      key,
      false,
      consume,
    );
  }

  // ---------------------------------------------------------------------
  // 静态分片：bootloader / partitions / boot_app0
  // ---------------------------------------------------------------------

  /**
   * 生成按 (board, 选项) 静态确定的三片，带缓存。
   * 它们不随用户代码变化，因此浏览器可以永久缓存，
   * 后续烧录只需要写 0x10000 那一片。
   */
  async ensureStaticParts(
    board: BoardDefinition,
    opts: Record<string, string>,
    consume?: (
      parts: Array<{ offset: string; name: string; path: string }>,
    ) => void | Promise<void>,
  ): Promise<{
    parts: Array<{ offset: string; name: string; path: string }>;
    output: string;
    built?: boolean;
  }> {
    const sdk = this.sdk(board, opts);
    const profile = resolveEsp32BuildProfile(board, opts);
    const { boot, flashMode, flashFreq, imageFreq, flashSize, partitions: scheme } = profile;
    const bootAddr = board.build.bootloaderAddr ?? '0x1000';
    const bootElf = join(sdk, 'bin', `bootloader_${boot}_${profile.bootFreq}.elf`);
    const csv = join(this.cfg.platformDir, 'tools', 'partitions', `${scheme}.csv`);
    const genPart = esp32PartitionToolInvocation(this.cfg.platformDir);
    const bootApp0 = join(this.cfg.platformDir, 'tools', 'partitions', 'boot_app0.bin');
    const key = this.staticPartsCacheKey(
      board,
      opts,
      { boot, bootFreq: profile.bootFreq, flashMode, flashFreq, imageFreq, flashSize, scheme, bootAddr },
      {
        bootElf,
        bootApp0,
        partitionCsv: csv,
        partitionTool: genPart.identityPath,
        esptool: this.cfg.esptool,
      },
    );
    const dir = join(this.cacheDir, 'esp32-static', key);
    const bootloaderBin = join(dir, 'bootloader.bin');
    const partitionsBin = join(dir, 'partitions.bin');

    const parts = [
      { offset: bootAddr, name: 'bootloader.bin', path: bootloaderBin },
      { offset: '0x8000', name: 'partitions.bin', path: partitionsBin },
      { offset: '0xe000', name: 'boot_app0.bin', path: bootApp0 },
    ];

    if (!existsSync(bootApp0)) {
      return { parts: [], output: `找不到静态引导分片：${basename(bootApp0)}` };
    }

    return this.cacheManager.withLease(dir, async () => {
      this.cacheManager.maybePrune();
      const result = await singleFlight(`esp32-static:${dir}`, async () => {
        if (isDerivedCacheEntryReady(dir, [bootloaderBin, partitionsBin])) {
          this.cacheManager.touch(dir);
          return { parts, output: '', built: false };
        }

        discardDerivedCacheEntry(dir);
        if (!existsSync(bootElf)) {
          return { parts: [], output: `找不到 bootloader 模板：${basename(bootElf)}` };
        }
        if (!existsSync(csv)) {
          return { parts: [], output: `找不到分区方案 \`${scheme}\`（${basename(csv)}）` };
        }

        mkdirSync(dir, { recursive: true });
        let output = '';

        // ---- bootloader：从 SDK 自带的 elf 生成镜像 ----
        const r1 = await this.run(board, opts, this.cfg.esptool, [
          '--chip', board.build.mcu, 'elf2image',
          '--flash-mode', flashMode, '--flash-freq', imageFreq, '--flash-size', flashSize,
          '-o', bootloaderBin, bootElf,
        ], dir, 60_000, [dir]);
        output += r1.output;
        if (!r1.ok) {
          discardDerivedCacheEntry(dir);
          return { parts: [], output: `bootloader 生成失败:\n${r1.output}` };
        }

        // ---- 分区表：csv → bin ----
        const r2 = await this.run(
          board,
          opts,
          genPart.command,
          [...genPart.argsPrefix, '-q', csv, partitionsBin],
          dir,
          60_000,
          [dir],
        );
        output += r2.output;
        if (!r2.ok) {
          discardDerivedCacheEntry(dir);
          return { parts: [], output: `分区表生成失败:\n${r2.output}` };
        }

        markDerivedCacheEntryReady(dir);
        this.cacheManager.touch(dir);
        this.cacheManager.prune();
        return { parts, output, built: true };
      });
      if (result.parts.length > 0 && consume) await consume(result.parts);
      return result;
    });
  }

  // ---------------------------------------------------------------------
  // 主编译
  // ---------------------------------------------------------------------

  async build(
    board: BoardDefinition,
    opts: Record<string, string>,
    cppPath: string,
    buildDir: string,
    libraries: Library[] = [],
    report?: Esp32StageReporter,
  ): Promise<Esp32BuildResult> {
    const timings: Record<string, number> = {};
    let output = '';
    const t = (n: string, s: number) => { timings[n] = Date.now() - s; };
    const allInc = libraries.flatMap((l) => l.includeDirs);

    // ---- 1. core.a ----
    let s = Date.now();
    report?.('core', 35, '正在检查共享开发板核心缓存');
    const localCore = join(buildDir, 'core.a');
    const core = await this.ensureCore(board, opts, (path) => {
      copyFileSync(path, localCore);
    }, (progress) => {
      const percent = 35 + Math.round((progress.completed / Math.max(1, progress.total)) * 11);
      const detail = progress.cached
        ? '命中共享开发板核心缓存'
        : progress.archiving
          ? '正在归档共享开发板核心缓存'
          : `首次初始化共享开发板核心缓存 (${progress.completed}/${progress.total})`;
      report?.('core', percent, detail);
    });
    t('core', s);
    if (!core.path) return { ok: false, output: core.output, timings, failedStage: 'core' };

    // ---- 2. 各库 .a（L1，跨用户共享）----
    s = Date.now();
    report?.('libraries', 48);
    const localLibs: string[] = [];
    for (const lib of libraries) {
      const dest = join(buildDir, `lib${localLibs.length}.a`);
      const built = await this.ensureLibrary(board, opts, lib, allInc, (path) => {
        copyFileSync(path, dest);
      });
      if (!built.path && built.output) {
        return { ok: false, output: built.output, timings, failedStage: 'library' };
      }
      if (built.path) {
        localLibs.push(dest);
      }
    }
    t('libraries', s);

    // ---- 3. 静态分片（bootloader / partitions / boot_app0）----
    s = Date.now();
    report?.('static', 58, '正在检查启动与分区固件缓存');
    let localStaticParts: NonNullable<Esp32BuildResult['staticParts']> = [];
    const staticRes = await this.ensureStaticParts(board, opts, (parts) => {
      localStaticParts = parts.map((part, index) => {
        const dest = join(buildDir, `static-${index}-${part.name}`);
        copyFileSync(part.path, dest);
        return { ...part, path: dest };
      });
    });
    t('static', s);
    if (staticRes.parts.length === 0) {
      report?.('static', 58, '启动与分区固件准备失败');
      return { ok: false, output: staticRes.output, timings, failedStage: 'static' };
    }
    report?.(
      'static',
      61,
      staticRes.built ? '首次生成启动与分区固件缓存' : '命中启动与分区固件缓存',
    );
    // ---- 4. 编译 sketch（用户自己的代码开 -Wall）----
    const gpp = this.tool(board, 'g++');
    const objPath = join(buildDir, 'sketch.cpp.o');
    const elfPath = join(buildDir, 'firmware.elf');
    const binPath = join(buildDir, 'firmware.bin');

    // ---- 3b. 预编译头（只服务 sketch 这一步，实测 18.6×）----
    // 消费动作在 ensurePch 的同一个 lease 内执行，避免清理器在交接时删掉 .gch。
    const pchStartedAt = Date.now();
    report?.('pch', 63, '正在检查用户代码预编译头缓存');
    let c: { ok: boolean; output: string; timedOut: boolean } | undefined;
    await this.ensurePch(board, opts, allInc, async (pch) => {
      t('pch', pchStartedAt);
      report?.(
        'pch',
        66,
        !pch.dir
          ? '预编译头缓存不可用，将直接编译用户代码'
          : pch.built
            ? '首次生成用户代码预编译头缓存'
            : '命中用户代码预编译头缓存',
      );
      // PCH 相关参数必须排在最前：-include 要在其它 include 之前注入。
      // -Winvalid-pch 让参数失配从静默降级变成可见告警。
      const pchArgs = pch.dir ? [`-I${pch.dir}`, '-include', PCH_HEADER, '-Winvalid-pch'] : [];
      const compileStartedAt = Date.now();
      report?.('compiling', 68);
      c = await this.run(
        board,
        opts,
        gpp,
        [...pchArgs, ...this.cppFlags(board, opts, '-Wall', allInc), cppPath, '-o', objPath],
        buildDir,
        120_000,
        [buildDir],
        // .gch 有 51 MB，只读挂进沙箱，不要每次拷贝到构建目录
        pch.dir ? [pch.dir] : [],
      );
      t('compile', compileStartedAt);
    });
    if (!c) {
      return { ok: false, output: 'PCH 消费流程未执行', timings, failedStage: 'compile' };
    }
    output += c.output;
    if (!c.ok) return { ok: false, output, timings, failedStage: 'compile', timedOut: c.timedOut };

    // ---- 5. 链接 ----
    const profile = resolveEsp32BuildProfile(board, opts);
    const sdk = this.sdk(board, opts);
    const mem = this.memoryType(board, opts);

    s = Date.now();
    report?.('linking', 80);
    const l = await this.run(board, opts, gpp, [
      `-Wl,--Map=${join(buildDir, 'firmware.map')}`,
      `-L${join(sdk, 'lib')}`, `-L${join(sdk, 'ld')}`, `-L${join(sdk, mem)}`,
      '-Wl,--wrap=esp_panic_handler',
      `@${join(sdk, 'flags', 'ld_flags')}`,
      `@${join(sdk, 'flags', 'ld_scripts')}`,
      // IDF 各库之间有循环符号依赖，靠 --start-group 让链接器反复扫描解决；
      // 也正因为分组，组内顺序不重要（和 AVR 需要仔细排序不同）
      '-Wl,--start-group',
      objPath, ...localLibs, localCore,
      `@${join(sdk, 'flags', 'ld_libs')}`,
      ...profile.linkerFlags,
      '-Wl,--end-group',
      '-Wl,-EL', '-o', elfPath,
    ], buildDir, 180_000);
    t('link', s);
    output += l.output;
    if (!l.ok) return { ok: false, output, timings, failedStage: 'link', timedOut: l.timedOut };

    // ---- 6. elf → 可烧录镜像 ----
    s = Date.now();
    report?.('imaging', 88);
    const img = await this.run(board, opts, this.cfg.esptool, [
      '--chip', board.build.mcu, 'elf2image',
      '--flash-mode', profile.flashMode,
      '--flash-freq', profile.imageFreq,
      '--flash-size', profile.flashSize,
      '--elf-sha256-offset', '0xb0',
      '-o', binPath, elfPath,
    ], buildDir, 60_000);
    t('imaging', s);
    output += img.output;
    if (!img.ok) return { ok: false, output, timings, failedStage: 'imaging' };

    // ---- 7. 体积统计 ----
    s = Date.now();
    const sz = await this.run(board, opts, this.tool(board, 'size'), ['-A', elfPath], buildDir, 30_000);
    t('size', s);
    const memory = parseEsp32Size(sz.output, board, opts, profile.maxFlash);

    return {
      ok: true, output, binPath, elfPath,
      staticParts: localStaticParts,
      ...(memory ? { memory } : {}),
      timings,
    };
  }
}

/**
 * 解析 `xtensa-esp32-elf-size -A`。
 * section 分组来自 platform.txt 的 recipe.size.regex / regex.data —— 照抄，
 * 不自己发明，否则和 Arduino IDE 显示的数字对不上，用户会以为哪边错了。
 */
export function parseEsp32Size(
  out: string,
  board: BoardDefinition,
  opts: Record<string, string> = {},
  maxFlash?: number,
): MemoryUsage | undefined {
  const sections: Record<string, number> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\.\w[\w.]*)\s+(\d+)/.exec(line.trim());
    if (m) sections[m[1]!] = Number(m[2]);
  }
  if (Object.keys(sections).length === 0) return undefined;

  const sum = (keys: string[]) => keys.reduce((a, k) => a + (sections[k] ?? 0), 0);
  const flashUsed = sum(FLASH_SECTIONS);
  const ramUsed = sum(RAM_SECTIONS);

  // 分区方案会改变可用的 app 空间，优先用选项里带的上限
  const flashTotal = maxFlash ?? (Number(opts.__maxFlash ?? 0) || board.flashTotal);

  return { flashUsed, flashTotal, ramUsed, ramTotal: board.ramTotal };
}

export { readFileSync };
