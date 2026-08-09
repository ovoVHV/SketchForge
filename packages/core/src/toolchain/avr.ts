/**
 * AVR 编译驱动。
 *
 * 刻意**绕开 arduino-cli**，直接组装 avr-gcc 命令行。原因有三：
 *   1. arduino-cli 的构建缓存是 per-build-path 的，而且 sketch 目录一变动
 *      就会清掉整个缓存（arduino/arduino-cli#2780），多用户服务端根本用不了。
 *   2. 我们需要完全控制命令行，才能把每一步都塞进沙箱执行。
 *   3. core.a 预编译一次全局复用后，单次编译只剩「编 1 个 TU + 链接」，
 *      从 2~4 秒压到几百毫秒。这是延迟的关键。
 *
 * 警告等级刻意做了区分：
 *   · core 用 `-w`（Arduino core 自身的告警是纯噪音，用户既看不懂也改不了）
 *   · 用户 sketch 用 `-Wall`（开发平台就该把用户自己代码的问题说清楚）
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import type { Library } from './library.js';
import type { SandboxExecutor, ResourceLimits } from '../sandbox/types.js';
import { DEFAULT_LIMITS } from '../sandbox/types.js';
import type { ArchToolchain } from './config.js';
import { toolPath } from './config.js';
import type { BoardDefinition } from './board.js';
import type { MemoryUsage } from '../types.js';
import { contentIdentity } from '../cache/identity.js';
import {
  discardDerivedCacheEntry,
  getDerivedCacheManager,
  isDerivedCacheEntryReady,
  markDerivedCacheEntryReady,
  type DerivedCacheManager,
} from '../cache/derived.js';
import { singleFlight } from '../cache/singleflight.js';

/** Arduino IDE 版本号宏，部分库会用它做条件编译 */
const ARDUINO_VERSION_DEFINE = '10607';
const AVR_DERIVED_CACHE_FORMAT = 'arduinofast-avr-derived-v2';

export interface AvrBuildResult {
  ok: boolean;
  /** 编译器合并输出（stdout + stderr），供诊断解析 */
  output: string;
  hexPath?: string;
  elfPath?: string;
  memory?: MemoryUsage;
  timings: Record<string, number>;
  failedStage?: string;
  timedOut?: boolean;
}

export class AvrToolchain {
  // A driver instance represents one immutable build-input snapshot.
  private readonly inputIdentities = new Map<string, string>();
  private readonly cacheManager: DerivedCacheManager;

  constructor(
    private readonly tc: ArchToolchain,
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
    // A CompileService-provided toolchainIdentity covers compiler/core/variant
    // roots even for an unpacked local SDK. Keep user libraries content-hashed:
    // they are not part of that snapshot and may change between requests.
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

  private compilerIdentity(): string {
    return this.toolchainIdentity
      ?? this.inputIdentity(this.tc.rootDir ?? dirname(this.tc.binDir));
  }

  private derivedCacheKey(
    kind: 'core' | 'library',
    board: BoardDefinition,
    includeDirs: string[],
    inputs: Record<string, unknown>,
  ): string {
    const payload = {
      format: AVR_DERIVED_CACHE_FORMAT,
      kind,
      toolchain: this.compilerIdentity(),
      board: board.fqbn,
      flags: {
        cpp: this.cppFlags(board, '-w', includeDirs),
        c: this.cFlags(board, '-w', includeDirs),
        asm: this.asmFlags(board, includeDirs),
      },
      core: this.inputIdentity(this.tc.coreDir, true),
      variant: this.inputIdentity(join(this.tc.variantsDir, board.build.variant), true),
      includes: includeDirs.map((dir) => ({ dir, identity: this.inputIdentity(dir) })),
      inputs,
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  // ---------------------------------------------------------------------
  // 编译参数组装
  // ---------------------------------------------------------------------

  private commonFlags(board: BoardDefinition, extraIncludes: string[] = []): string[] {
    const variantDir = join(this.tc.variantsDir, board.build.variant);
    return [
      `-mmcu=${board.build.mcu}`,
      `-DF_CPU=${board.build.fCpu}`,
      `-DARDUINO=${ARDUINO_VERSION_DEFINE}`,
      ...(board.build.boardDefine ? [`-DARDUINO_${board.build.boardDefine}`] : []),
      ...board.build.defines.map((d) => `-D${d}`),
      `-I${this.tc.coreDir}`,
      `-I${variantDir}`,
      ...extraIncludes.map((d) => `-I${d}`),
      ...(board.build.extraFlags ?? []),
    ];
  }

  /** LTO 默认开启，与 Arduino IDE 保持一致 */
  private lto(board: BoardDefinition): boolean {
    return board.build.lto !== false;
  }

  private cppFlags(board: BoardDefinition, warnings: string, inc: string[] = []): string[] {
    return [
      '-c', '-g', '-Os', warnings,
      '-std=gnu++11', '-fpermissive', '-fno-exceptions',
      '-ffunction-sections', '-fdata-sections', '-fno-threadsafe-statics',
      '-Wno-error=narrowing', '-MMD',
      ...(this.lto(board) ? ['-flto'] : []),
      ...this.commonFlags(board, inc),
    ];
  }

  private cFlags(board: BoardDefinition, warnings: string, inc: string[] = []): string[] {
    return [
      '-c', '-g', '-Os', warnings,
      '-std=gnu11', '-ffunction-sections', '-fdata-sections', '-MMD',
      ...(this.lto(board) ? ['-flto', '-fno-fat-lto-objects'] : []),
      ...this.commonFlags(board, inc),
    ];
  }

  private asmFlags(board: BoardDefinition, inc: string[] = []): string[] {
    return [
      '-c', '-g', '-x', 'assembler-with-cpp', '-MMD',
      ...(this.lto(board) ? ['-flto'] : []),
      ...this.commonFlags(board, inc),
    ];
  }

  // ---------------------------------------------------------------------
  // core.a —— 全局共享，一次编译永久复用
  // ---------------------------------------------------------------------

  /**
   * core.a 的缓存键绑定完整工具链、实际 flags、core 与 variant 的内容摘要。
   * 文件内容变化即失效，不依赖可伪造或低精度的 size/mtime 元数据。
   */
  private coreCacheKey(board: BoardDefinition): string {
    return this.derivedCacheKey('core', board, [], {
      sourceTree: this.inputIdentity(this.tc.coreDir, true),
    });
  }

  /**
   * 编译进程在沙箱里能看见的全部文件系统。
   *
   * 这个清单就是 `.incbin` 攻击面的边界 —— 不在这里的路径，
   * 编译进程根本看不见，也就读不走。清单越短越安全。
   */
  private mounts(writableDirs: string[]): { readOnlyPaths: string[]; readWritePaths: string[] } {
    return {
      readOnlyPaths: [this.tc.rootDir ?? dirname(this.tc.binDir), this.tc.coreDir, this.tc.variantsDir, ...this.libraryRoots],
      readWritePaths: writableDirs,
    };
  }

  /** 库源码目录也要只读挂进沙箱，否则库编译会看不到自己的源文件 */
  private libraryRoots: string[] = [];
  setLibraryRoots(dirs: string[]): void {
    this.libraryRoots = dirs;
  }

  private async run(
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    writableDirs: string[] = [cwd],
  ): Promise<{ ok: boolean; output: string; timedOut: boolean }> {
    const r = await this.executor.exec({
      command: cmd,
      args,
      cwd,
      timeoutMs,
      limits: this.limits,
      ...this.mounts(writableDirs),
    });
    return {
      ok: r.code === 0 && !r.timedOut,
      output: [r.stdout, r.stderr].filter(Boolean).join('\n'),
      timedOut: r.timedOut,
    };
  }

  /** 确保 core.a 存在，返回其路径。已存在则直接复用（这是热路径的核心） */
  async ensureCore(
    board: BoardDefinition,
    consume?: (path: string) => void | Promise<void>,
  ): Promise<{ path: string; built: boolean; output: string }> {
    const key = this.coreCacheKey(board);
    const dir = join(this.cacheDir, 'cores', `${board.build.mcu}-${key}`);
    const archive = join(dir, 'core.a');

    return this.cacheManager.withLease(dir, async () => {
      this.cacheManager.maybePrune();
      const result = await singleFlight(`avr-core:${archive}`, async () => {
        if (isDerivedCacheEntryReady(dir, [archive])) {
          this.cacheManager.touch(dir);
          return { path: archive, built: false, output: '' };
        }

        discardDerivedCacheEntry(dir);
        mkdirSync(dir, { recursive: true });
        const gcc = toolPath(this.tc, 'avr-gcc');
        const gpp = toolPath(this.tc, 'avr-g++');
        const ar = toolPath(this.tc, 'avr-gcc-ar');

        const objects: string[] = [];
        let output = '';

        const sources = readdirSync(this.tc.coreDir).filter(
          (f) => f.endsWith('.c') || f.endsWith('.cpp') || f.endsWith('.S'),
        ).sort();

        for (const src of sources) {
          const srcPath = join(this.tc.coreDir, src);
          const objPath = join(dir, `${src}.o`);
          // core 用 -w：Arduino core 自身的告警对用户毫无意义，纯噪音
          const [cmd, flags] = src.endsWith('.cpp')
            ? [gpp, this.cppFlags(board, '-w')]
            : src.endsWith('.S')
              ? [gcc, this.asmFlags(board)]
              : [gcc, this.cFlags(board, '-w')];

          const r = await this.run(cmd!, [...flags!, srcPath, '-o', objPath], dir, 60_000);
          output += r.output;
          if (!r.ok) {
            discardDerivedCacheEntry(dir);
            return { path: '', built: false, output: `core 编译失败于 ${src}:\n${r.output}` };
          }
          objects.push(objPath);
        }

        const r = await this.run(ar, ['rcs', archive, ...objects], dir, 60_000);
        output += r.output;
        if (!r.ok) {
          discardDerivedCacheEntry(dir);
          return { path: '', built: false, output: `core 打包失败:\n${r.output}` };
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

  // ---------------------------------------------------------------------
  // L1 库对象缓存 —— 全局共享，跨用户复用
  // ---------------------------------------------------------------------

  /**
   * 缓存键刻意**不含用户信息**：`(库名@版本, mcu, 编译参数)`。
   *
   * 这是整个成本模型的关键：第一个用到 `Adafruit GFX@1.12.5 + atmega328p + -Os`
   * 的人付出编译代价，之后全平台所有用户白嫖同一份 .a。
   * ESP32 接入后这条机制的收益会放大 20~50 倍（那边库更重）。
   */
  private libraryCacheKey(board: BoardDefinition, lib: Library, incDirs: string[]): string {
    return this.derivedCacheKey('library', board, incDirs, {
      manifest: lib.manifest,
      libraryTree: this.inputIdentity(lib.rootDir),
      sources: [...lib.sources].sort(),
    });
  }

  /** 确保某个库的 .a 存在。已存在直接复用 —— 这是热路径 */
  async ensureLibrary(
    board: BoardDefinition,
    lib: Library,
    incDirs: string[],
    consume?: (path: string) => void | Promise<void>,
  ): Promise<{ path: string; built: boolean; output: string }> {
    if (lib.sources.length === 0) {
      // 纯头文件库（如 ArduinoJson）没有可编译源文件，只需要 -I，不产出 .a
      return { path: '', built: false, output: '' };
    }

    const key = this.libraryCacheKey(board, lib, incDirs);
    const safeName = lib.manifest.name.replace(/[^A-Za-z0-9_.-]+/g, '_');
    const dir = join(this.cacheDir, 'libs', `${safeName}-${board.build.mcu}-${key}`);
    const archive = join(dir, 'lib.a');

    return this.cacheManager.withLease(dir, async () => {
      this.cacheManager.maybePrune();
      const result = await singleFlight(`avr-lib:${archive}`, async () => {
        if (isDerivedCacheEntryReady(dir, [archive])) {
          this.cacheManager.touch(dir);
          return { path: archive, built: false, output: '' };
        }

        discardDerivedCacheEntry(dir);
        mkdirSync(dir, { recursive: true });
        const gcc = toolPath(this.tc, 'avr-gcc');
        const gpp = toolPath(this.tc, 'avr-g++');
        const ar = toolPath(this.tc, 'avr-gcc-ar');

        const objects: string[] = [];
        let output = '';

        for (const [i, src] of [...lib.sources].sort().entries()) {
          // 不同子目录可能有同名文件，加序号避免 .o 互相覆盖
          const objPath = join(dir, `${i}_${basename(src)}.o`);
          const ext = extname(src);
          // 第三方库用 -w：它们的告警对用户既看不懂也改不了，是纯噪音
          const [cmd, flags] =
            ext === '.cpp' || ext === '.cc' || ext === '.cxx'
              ? [gpp, this.cppFlags(board, '-w', incDirs)]
              : ext === '.S'
                ? [gcc, this.asmFlags(board, incDirs)]
                : [gcc, this.cFlags(board, '-w', incDirs)];

          const r = await this.run(cmd!, [...flags!, src, '-o', objPath], dir, 120_000, [dir]);
          output += r.output;
          if (!r.ok) {
            discardDerivedCacheEntry(dir);
            return { path: '', built: false, output: `库 ${lib.manifest.name} 编译失败于 ${basename(src)}:\n${r.output}` };
          }
          objects.push(objPath);
        }

        const r = await this.run(ar, ['rcs', archive, ...objects], dir, 60_000, [dir]);
        output += r.output;
        if (!r.ok) {
          discardDerivedCacheEntry(dir);
          return { path: '', built: false, output: `库 ${lib.manifest.name} 打包失败:\n${r.output}` };
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

  // ---------------------------------------------------------------------
  // 单次 sketch 编译
  // ---------------------------------------------------------------------

  /**
   * @param cppPath   预处理产出的 .cpp 绝对路径
   * @param buildDir  本次编译的独立工作目录
   * @param libraries 已解析的库（含传递依赖，被依赖的在前）
   */
  async build(
    board: BoardDefinition,
    cppPath: string,
    buildDir: string,
    libraries: Library[] = [],
  ): Promise<AvrBuildResult> {
    const timings: Record<string, number> = {};
    let output = '';
    const t = (name: string, start: number) => { timings[name] = Date.now() - start; };

    // 所有库的 include 路径对每个库、以及对 sketch 都要可见。
    // 少了这一步，SSD1306 找不到 Adafruit_GFX.h 这类跨库引用就会断。
    const allIncludeDirs = libraries.flatMap((l) => l.includeDirs);

    // ---- 1. core.a（几乎总是缓存命中） ----
    let s = Date.now();
    const localCore = join(buildDir, 'core.a');
    const core = await this.ensureCore(board, (path) => {
      copyFileSync(path, localCore);
    });
    t('core', s);
    if (!core.path) {
      return { ok: false, output: core.output, timings, failedStage: 'core' };
    }
    // ---- 1b. 各库的 .a（L1 缓存，跨用户共享，几乎总是命中） ----
    s = Date.now();
    const localLibs: string[] = [];
    for (const lib of libraries) {
      const dest = join(buildDir, `lib${localLibs.length}.a`);
      const built = await this.ensureLibrary(board, lib, allIncludeDirs, (path) => {
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

    const gcc = toolPath(this.tc, 'avr-gcc');
    const gpp = toolPath(this.tc, 'avr-g++');
    const objcopy = toolPath(this.tc, 'avr-objcopy');
    const sizeTool = toolPath(this.tc, 'avr-size');

    const objPath = join(buildDir, 'sketch.cpp.o');
    const elfPath = join(buildDir, 'sketch.elf');
    const hexPath = join(buildDir, 'sketch.hex');

    // ---- 2. 编译用户 sketch（-Wall：用户自己的代码要把问题说清楚） ----
    s = Date.now();
    const c = await this.run(
      gpp,
      [...this.cppFlags(board, '-Wall', allIncludeDirs), cppPath, '-o', objPath],
      buildDir,
      Math.min(this.limits.cpuSeconds * 1000, 30_000),
    );
    t('compile', s);
    output += c.output;
    if (!c.ok) {
      return { ok: false, output, timings, failedStage: 'compile', timedOut: c.timedOut };
    }

    // ---- 3. 链接 ----
    s = Date.now();
    const l = await this.run(
      gcc,
      [
        '-w', '-Os', '-g',
        ...(this.lto(board) ? ['-flto', '-fuse-linker-plugin'] : []),
        '-Wl,--gc-sections',
        `-mmcu=${board.build.mcu}`,
        '-o', elfPath, objPath,
        // 链接顺序：**依赖方在前，被依赖方在后**，与解析顺序正好相反。
        //
        // ld 从左向右扫描，静态库只会拉取"当前尚未满足的符号"所对应的成员。
        // 解析结果是 Wire → SPI → BusIO → GFX → SSD1306（被依赖的在前，
        // 便于逐层展开依赖）；直接照这个顺序链接的话，ld 处理 Wire 时
        // 还不知道 SSD1306 要用它的符号，等扫到 SSD1306 才发现缺，
        // 但 Wire 已经翻过去了 —— 结果就是 undefined reference。
        // 所以这里必须反过来。core.a 依然放最后，因为所有库都依赖它。
        ...[...localLibs].reverse(),
        localCore,
        `-L${buildDir}`, '-lm',
      ],
      buildDir,
      30_000,
    );
    t('link', s);
    output += l.output;
    if (!l.ok) {
      return { ok: false, output, timings, failedStage: 'link', timedOut: l.timedOut };
    }

    // ---- 4. 生成 hex ----
    s = Date.now();
    const o = await this.run(objcopy, ['-O', 'ihex', '-R', '.eeprom', elfPath, hexPath], buildDir, 15_000);
    t('objcopy', s);
    output += o.output;
    if (!o.ok) {
      return { ok: false, output, timings, failedStage: 'objcopy' };
    }

    // ---- 5. 体积统计（图形化平台会直观显示"用了多少 Flash/RAM"） ----
    s = Date.now();
    const sz = await this.run(sizeTool, ['-A', elfPath], buildDir, 15_000);
    t('size', s);
    const memory = parseAvrSize(sz.output, board);

    return { ok: true, output, hexPath, elfPath, memory, timings };
  }
}

/**
 * 解析 `avr-size -A` 输出。
 *   Flash = .text + .data   （.data 的初值也要烧进 Flash）
 *   RAM   = .data + .bss
 */
export function parseAvrSize(out: string, board: BoardDefinition): MemoryUsage | undefined {
  const sections: Record<string, number> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\.\w[\w.]*)\s+(\d+)/.exec(line.trim());
    if (m) sections[m[1]!] = Number(m[2]);
  }
  const text = sections['.text'] ?? 0;
  const data = sections['.data'] ?? 0;
  const bss = sections['.bss'] ?? 0;
  if (text === 0 && data === 0 && bss === 0) return undefined;

  return {
    flashUsed: text + data,
    flashTotal: board.flashTotal,
    ramUsed: data + bss,
    ramTotal: board.ramTotal,
  };
}

export { basename };
