/**
 * 底座对外契约类型。
 *
 * 设计纪律（不要破坏）：
 *  1. 这里不允许出现任何图形化 / 积木 (block) 相关的概念。
 *     底座的承诺只有一句：给我 .ino，还你精确到 行/列 的结构化诊断。
 *     积木 ID ←→ 行号 的 source map 由上层前端自己维护。
 *  2. `files` 始终是数组。项目必须至少有一个根目录 `.ino`，多个 `.ino` 按 Arduino 标签规则合并，并可附带受限的
 *     `.h/.hpp/.c/.cpp/.S` 项目库文件；路径和总大小由入口统一校验。
 */

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

export interface SourceFile {
  /** 项目内相对路径；支持多个根目录 `.ino` 标签与受限的源码/头文件。 */
  name: string;
  content: string;
}

export interface LibraryRef {
  /** 白名单库名（与 GET /v1/libraries 返回的一致） */
  name: string;
  /** 精确版本；省略则用白名单里的默认版本 */
  version?: string;
}

/**
 * 板级可调编译选项。全部可选，缺省走板子定义里的 default。
 * 键名与值域由 GET /v1/boards 返回的 `options` 枚举描述，
 * 前端决定要不要把它们暴露给最终用户
 * （图形化平台通常锁死默认值，代码 IDE 则开放）。
 */
export type BuildOptions = Record<string, string>;

export interface CompileRequest {
  /** FQBN，例如 "arduino:avr:uno" / "esp32:esp32:esp32" */
  board: string;
  files: SourceFile[];
  libraries?: LibraryRef[];
  options?: BuildOptions;
  /** 可选：用于 session-warm 增量编译的会话标识（P2 才会真正生效） */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** 用户源文件名。始终是用户提交的名字（如 "main.ino"），绝不是内部 .cpp 路径 */
  file: string;
  /** 1-based 行号，已映射回用户源文件 */
  line: number;
  /** 1-based 列号 */
  column?: number;
  message: string;
  /** 编译器原始输出行，便于排障；已做路径清洗 */
  raw?: string;
  /**
   * 诊断落在了预处理器生成的代码上（如自动生成的函数原型），
   * 已尽力回溯到用户代码的相关位置。前端可据此调整提示措辞。
   */
  fromGenerated?: boolean;
  /** 当诊断无法可靠映射回用户代码时为 true，此时 line 仅供参考 */
  unmapped?: boolean;
}

// ---------------------------------------------------------------------------
// 产物
// ---------------------------------------------------------------------------

export interface Artifact {
  /** 烧录偏移，十六进制字符串，如 "0x10000"。AVR 走 bootloader 协议时为 null */
  offset: string | null;
  /** 产物文件名 */
  name: string;
  /** 内容 sha256，前端可据此判断是否需要重新下载 */
  sha256: string;
  size: number;
  /** 下载地址（P1 直接内联 base64，P2 换成 CDN URL） */
  url?: string;
  /** P1 过渡用：小产物直接内联，省掉一次往返 */
  base64?: string;
}

export interface MemoryUsage {
  flashUsed: number;
  flashTotal: number;
  ramUsed: number;
  ramTotal: number;
}

export interface CompileSuccess {
  status: 'success';
  /** 每次编译都可能变化的产物（AVR: firmware.hex；ESP32: firmware.bin @0x10000） */
  artifacts: Artifact[];
  /**
   * 按 (board, options) 静态确定的产物，浏览器可永久缓存。
   * ESP32 的 bootloader/partitions/boot_app0 走这里，
   * 让"后续烧录只写 0x10000"成为可能。
   */
  staticArtifacts: Artifact[];
  memory?: MemoryUsage;
  diagnostics: Diagnostic[];
  /** 各阶段耗时(ms)，用于性能观测 */
  timings: Record<string, number>;
  /** 命中 L0 结果缓存 */
  cached: boolean;
}

export interface CompileFailure {
  status: 'error';
  /** 失败归类，便于前端区分"用户代码错" vs "平台故障" */
  reason:
    | 'compile_error'    // 用户代码编译失败 —— 正常业务结果，不是故障
    | 'preprocess_error' // .ino 预处理失败
    | 'invalid_request'  // 参数不合法
    | 'rejected'         // 安全预检拒绝（如 .incbin）
    | 'timeout'
    | 'resource_limit'
    | 'cancelled'
    | 'internal';
  message: string;
  diagnostics: Diagnostic[];
  timings: Record<string, number>;
}

export type CompileResult = CompileSuccess | CompileFailure;

// ---------------------------------------------------------------------------
// SSE 事件流
// ---------------------------------------------------------------------------

export type CompileStage =
  | 'queued'
  | 'preprocess'
  | 'core'
  | 'libraries'
  | 'static'
  | 'pch'
  | 'compiling'
  | 'linking'
  | 'imaging'
  | 'done';

export type CompileEvent =
  | { event: 'progress'; stage: CompileStage; percent: number; detail?: string }
  | { event: 'diagnostic'; diagnostic: Diagnostic }
  | { event: 'done'; result: CompileResult };

// ---------------------------------------------------------------------------
// 板子描述（GET /v1/boards）
// ---------------------------------------------------------------------------

export type PinCapability = 'digital' | 'analog_in' | 'pwm' | 'i2c_sda' | 'i2c_scl' | 'spi' | 'uart' | 'dac' | 'touch';

export interface PinDef {
  /** 代码里使用的写法，如 "2" / "A0" / "LED_BUILTIN" */
  id: string;
  /** 显示名 */
  label: string;
  caps: PinCapability[];
}

export interface BoardOptionValue {
  value: string;
  label: string;
  /**
   * This value is part of the upstream board menu but is not yet supported by
   * the structured build contract. Clients must render it as unavailable and
   * request validation must reject it.
   */
  unsupported?: {
    reason: string;
  };
  /**
   * 仅当其他选项取给定值时，这个值才可用。
   * 用于表达 ESP32-S3 的 OPI Flash/PSRAM、USB MSC/DFU 等硬件组合约束。
   */
  requires?: Record<string, string[]>;
}

export interface BoardOptionDef {
  id: string;
  label: string;
  default: string;
  values: BoardOptionValue[];
  /**
   * Defaults to true. Set false for a browser-only upload preference such as
   * serial speed or full-chip erase, so it does not invalidate a firmware.
   */
  affectsBuild?: boolean;
}

/**
 * 板子对外描述。图形化平台用它来渲染引脚下拉框 ——
 * 同一个积木在 Uno 和 ESP32 上引脚选项不同，正是靠这里驱动。
 */
export interface BoardInfo {
  fqbn: string;
  name: string;
  /** 架构族，前端可据此做粗粒度分组 */
  arch: 'avr' | 'esp32' | 'esp8266' | 'stm32';
  pins: PinDef[];
  options: BoardOptionDef[];
  flashTotal: number;
  ramTotal: number;
  /** 浏览器烧录方式，前端据此选择 avrbro / esptool-js / UF2 */
  upload: {
    protocol: 'stk500v1' | 'stk500v2' | 'esp32' | 'esp8266';
    speed?: number;
    /**
     * 烧录波特率随板级选项变化时的覆盖表：`{ 选项id: { 选项值: 波特率 } }`。
     *
     * 真实场景：Arduino Nano 的老 bootloader 跑 57600，新 optiboot 跑 115200。
     * 选错的表现是「一直同步不上」，且没有任何提示 —— 是新手最常踩的坑之一。
     * 做成数据驱动后，前端不需要为任何特定板子写 if。
     */
    speedByOption?: Record<string, Record<string, number>>;
    /**
     * Some ESP32 menu labels describe a boot profile rather than esptool's
     * literal flash-mode argument. This gives the browser flasher the same
     * normalized values used by the compiler.
     */
    flashByOption?: Record<string, Record<string, { mode: string; frequency: string }>>;
    /** Whether a browser upload should erase the complete flash chip first. */
    eraseAllByOption?: Record<string, Record<string, boolean>>;
  };
}
