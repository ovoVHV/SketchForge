/**
 * 板子定义：可移植数据，进版本库，同时喂给编译器和前端。
 *
 * `pins` 字段是图形化平台渲染引脚下拉框的数据源 ——
 * 同一个"读取数字引脚"积木在 Uno 和 ESP32 上选项不同，就靠这里驱动。
 * 加一块新板子，所有积木的引脚选项自动跟着变，不需要改积木定义。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardInfo, BoardOptionDef, PinDef } from '../types.js';

/**
 * A trusted board definition can map a public option value to the exact
 * parameters consumed by the ESP32 compiler. User requests only choose a
 * whitelisted value; they never supply paths, flags, or arbitrary defines.
 */
export interface BoardBuildOptionEffect {
  /** AVR/ESP compiler target selected by a trusted board menu value. */
  mcu?: string;
  /**
   * Trusted Arduino-ESP32 SDK family. Most boards use their MCU name, while
   * ESP32-P4 selects a different SDK for pre-v3 silicon.
   */
  sdkTarget?: string;
  fCpu?: string;
  partitions?: string;
  flashMode?: string;
  flashFreq?: string;
  /**
   * Frequency encoded into the generated ESP image. Most chips use the same
   * value as flashFreq; ESP32-H2 intentionally uses a divided image clock.
   */
  imageFreq?: string;
  flashSize?: string;
  boot?: string;
  bootFreq?: string;
  psramType?: string;
  maxFlash?: number;
  /** Board-level memory limits after reserving the bootloader/partition. */
  flashTotal?: number;
  ramTotal?: number;
  /** Value used by Arduino's `ARDUINO_{build.board}` define. */
  boardDefine?: string;
  defines?: string[];
  /** Trusted compiler arguments which are not preprocessor defines. */
  compilerFlags?: string[];
  /** Trusted libraries/arguments appended inside the ESP32 linker group. */
  linkerFlags?: string[];
}

/** 内部完整定义 = 对外的 BoardInfo + 构建所需的私有字段 */
export interface BoardDefinition extends BoardInfo {
  build: {
    /** -mmcu= */
    mcu: string;
    /** -DF_CPU= */
    fCpu: string;
    /** variants 下的子目录名 */
    variant: string;
    /** 额外的 -D 宏 */
    defines: string[];
    /** 架构相关的额外编译参数 */
    extraFlags?: string[];
    /**
     * 是否启用 LTO。默认 true（与 Arduino IDE 一致，产物最小）。
     * 关掉能显著缩短链接耗时，代价是 Flash 占用略增 ——
     * 开发平台按"迭代速度 vs 产物体积"权衡，实测数据见 scripts/bench-lto.ts。
     */
    lto?: boolean;

    // ---- 以下仅 ESP32 使用 ----
    /** 芯片族，决定用哪个编译器前缀：xtensa / riscv32 */
    tarch?: string;
    /** IDF target，决定用哪套预编译 SDK：esp32 / esp32s3 / esp32c3 … */
    target?: string;
    /**
     * SDK family used for compiler inputs. Defaults to `mcu`; kept separate
     * because upstream ESP32-P4 maps its ChipVariant menu to two SDK trees.
     */
    sdkTarget?: string;
    /** -DARDUINO_{board} 里的 board 名，如 ESP32_DEV */
    boardDefine?: string;
    /** 烧录时 bootloader 的偏移（ESP32 是 0x1000，S3/C3 是 0x0） */
    bootloaderAddr?: string;
    /** 默认 flash 模式 / bootloader 模式 / 频率 / 容量 / 分区方案 */
    flashMode?: string;
    boot?: string;
    bootFreq?: string;
    psramType?: string;
    flashFreq?: string;
    /** Frequency written into ESP image headers; defaults to flashFreq. */
    imageFreq?: string;
    flashSize?: string;
    partitions?: string;
    /** Per-value ESP32 build settings. Kept internal by `toPublic`. */
    optionEffects?: Record<string, Record<string, BoardBuildOptionEffect>>;
  };
}

export class BoardRegistry {
  private readonly boards = new Map<string, BoardDefinition>();

  static fromDirectory(dir: string): BoardRegistry {
    const reg = new BoardRegistry();
    if (!existsSync(dir)) return reg;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const def = JSON.parse(readFileSync(join(dir, f), 'utf8')) as BoardDefinition;
      reg.add(def);
    }
    return reg;
  }

  add(def: BoardDefinition): void {
    this.boards.set(def.fqbn, def);
  }

  get(fqbn: string): BoardDefinition | undefined {
    return this.boards.get(fqbn);
  }

  list(): BoardDefinition[] {
    return [...this.boards.values()];
  }

  /** 去掉内部构建字段，得到可以直接返回给前端的形态 */
  toPublic(def: BoardDefinition): BoardInfo {
    const { build: _build, ...pub } = def;
    return pub;
  }

  listPublic(): BoardInfo[] {
    return this.list().map((d) => this.toPublic(d));
  }
}

/**
 * 校验并补全用户传来的 options，缺省项用板子定义里的 default 补上。
 * 非法值直接报错 —— 静默回退到默认值会让用户困惑于"我明明选了却没生效"。
 */
export function resolveOptions(
  def: BoardDefinition,
  requested: Record<string, string> | undefined,
): { options: Record<string, string>; errors: string[] } {
  const errors: string[] = [];
  const resolved: Record<string, string> = {};
  const rejectedUnsupported = new Set<string>();

  const byId = new Map<string, BoardOptionDef>(def.options.map((o) => [o.id, o]));

  for (const opt of def.options) {
    resolved[opt.id] = opt.default;
  }

  for (const [k, v] of Object.entries(requested ?? {})) {
    const opt = byId.get(k);
    if (!opt) {
      errors.push(`板子 ${def.fqbn} 不支持选项 \`${k}\``);
      continue;
    }
    const value = opt.values.find((x) => x.value === v);
    if (!value) {
      const allowed = opt.values.map((x) => x.value).join(', ');
      errors.push(`选项 \`${k}\` 的值 \`${v}\` 不合法，可选：${allowed}`);
      continue;
    }
    if (value.unsupported) {
      errors.push(unsupportedOptionMessage(def, k, v, value.unsupported.reason));
      rejectedUnsupported.add(opt.id);
      continue;
    }
    resolved[k] = v;
  }

  // Some ESP32 menu entries are only meaningful with a companion hardware
  // setting. Validate against the fully resolved set so omitted options still
  // use their declared defaults.
  for (const opt of def.options) {
    const selected = opt.values.find((value) => value.value === resolved[opt.id]);
    if (selected?.unsupported && !rejectedUnsupported.has(opt.id)) {
      errors.push(unsupportedOptionMessage(def, opt.id, selected.value, selected.unsupported.reason));
      rejectedUnsupported.add(opt.id);
    }
    for (const [requiredOption, allowedValues] of Object.entries(selected?.requires ?? {})) {
      if (!allowedValues.includes(resolved[requiredOption] ?? '')) {
        errors.push(
          `选项 \`${opt.id}\` 的值 \`${resolved[opt.id]}\` 需要 \`${requiredOption}\` 为 ${allowedValues.join(', ')}`,
        );
      }
    }
  }

  return { options: resolved, errors };
}

/** Return unsupported menu selections before a standard Platform Manifest is resolved. */
export function unsupportedOptionErrors(
  def: BoardDefinition,
  requested: Record<string, string> | undefined,
): string[] {
  const byId = new Map(def.options.map((option) => [option.id, option]));
  const byNormalizedId = new Map<string, BoardOptionDef>();
  for (const option of def.options) {
    const normalized = normalizeOptionId(option.id);
    if (!byNormalizedId.has(normalized)) byNormalizedId.set(normalized, option);
  }

  const errors: string[] = [];
  for (const [requestedId, requestedValue] of Object.entries(requested ?? {})) {
    const option = byId.get(requestedId) ?? byNormalizedId.get(normalizeOptionId(requestedId));
    const value = option?.values.find((candidate) => candidate.value === requestedValue);
    if (option && value?.unsupported) {
      errors.push(unsupportedOptionMessage(def, requestedId, requestedValue, value.unsupported.reason));
    }
  }
  return errors;
}

function unsupportedOptionMessage(
  def: BoardDefinition,
  optionId: string,
  value: string,
  reason: string,
): string {
  const detail = reason.trim();
  return `板子 ${def.fqbn} 的选项 \`${optionId}=${value}\` 暂不支持${detail ? `：${detail}` : ''}`;
}

function normalizeOptionId(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/**
 * Removes validated preferences that only affect browser-side flashing. They
 * must not create a new compiler/cache identity because the firmware is
 * identical for every value of such an option.
 */
export function buildOptions(
  def: BoardDefinition,
  options: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const option of def.options) {
    if (option.affectsBuild === false) continue;
    const value = options[option.id];
    if (value !== undefined) result[option.id] = value;
  }
  return result;
}

/**
 * 把已解析的 options 落到板子定义的构建参数上。
 *
 * 这条通路是 ESP32 接入的前置件 —— 分区方案 / flash 大小 / flash 模式
 * 走的都是同一套机制。P1 先用 AVR 的 `optimize` 选项把它跑通。
 *
 * 未知的选项 id 在 resolveOptions 阶段就已经被拒绝了，这里只处理认识的。
 */
export function applyOptions(
  def: BoardDefinition,
  options: Record<string, string>,
): BoardDefinition {
  const build = { ...def.build };
  let flashTotal = def.flashTotal;
  let ramTotal = def.ramTotal;

  for (const [optionId, value] of Object.entries(options)) {
    const effect = def.build.optionEffects?.[optionId]?.[value];
    if (!effect) continue;
    if (effect.mcu) build.mcu = effect.mcu;
    if (effect.fCpu) build.fCpu = effect.fCpu;
    if (effect.boardDefine) build.boardDefine = effect.boardDefine;
    if (Number.isSafeInteger(effect.flashTotal) && effect.flashTotal! > 0) {
      flashTotal = effect.flashTotal!;
    }
    if (Number.isSafeInteger(effect.ramTotal) && effect.ramTotal! > 0) {
      ramTotal = effect.ramTotal!;
    }
  }

  // optimize=fast → 关 LTO，链接快 40%，Flash 多约 3%
  // optimize=size → 开 LTO，与 Arduino IDE 产物一致
  if (options.optimize) {
    build.lto = options.optimize === 'size';
  }

  return { ...def, flashTotal, ramTotal, build };
}

/**
 * Lists every SDK family reachable through a board's trusted options. Startup
 * capability checks and toolchain identities must cover all of them so an
 * exposed option can never select an unmounted or untracked SDK tree.
 */
export function esp32SdkTargets(def: BoardDefinition): string[] {
  const targets = new Set<string>();
  const base = def.build.sdkTarget ?? def.build.mcu;
  if (base) targets.add(base);
  for (const byValue of Object.values(def.build.optionEffects ?? {})) {
    for (const effect of Object.values(byValue)) {
      if (effect.sdkTarget) targets.add(effect.sdkTarget);
    }
  }
  return [...targets].sort();
}

export type { PinDef, BoardOptionDef };
