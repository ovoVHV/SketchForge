/**
 * 沙箱执行器抽象。
 *
 * 之所以做成可插拔接口，是因为开发机（Windows/macOS）跑不了 nsjail，
 * 而生产环境（Linux）必须跑。把隔离层抽出来，编译逻辑就和隔离实现解耦了，
 * 换成 gVisor / Firecracker 也只是多一个实现。
 *
 * `isolationLevel` 不是装饰 —— 服务启动时会检查它，
 * 非 'namespace' 级别在生产模式下直接拒绝启动。
 */

export interface ResourceLimits {
  /** 地址空间上限（字节）。挡模板递归 / constexpr 炸弹 */
  memoryBytes: number;
  /** CPU 时间上限（秒）。注意与墙钟超时是两回事 */
  cpuSeconds: number;
  /** 单文件写入上限（字节）。挡把磁盘写满 */
  fileSizeBytes: number;
  /** 进程/线程数上限。挡 fork 炸弹 */
  processes: number;
}

export interface ExecRequest {
  command: string;
  args: string[];
  cwd: string;
  /** Cancels the command and its complete process tree. */
  signal?: AbortSignal;
  /** 墙钟超时（毫秒），超时即杀 */
  timeoutMs: number;
  limits: ResourceLimits;
  env?: Record<string, string>;
  /** 只读挂载的目录（namespace 级隔离才生效） */
  readOnlyPaths?: string[];
  /** 可读写目录（namespace 级隔离才生效） */
  readWritePaths?: string[];
}

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** 输出被截断（编译器输出炸弹） */
  truncated: boolean;
}

export type IsolationLevel = 'none' | 'process' | 'namespace';

export interface SandboxExecutor {
  readonly name: string;
  readonly isolationLevel: IsolationLevel;
  exec(req: ExecRequest): Promise<ExecResult>;
}

/** 默认资源限额。宁可紧一点，正常编译远远用不到这个量级 */
export const DEFAULT_LIMITS: ResourceLimits = {
  memoryBytes: 1024 * 1024 * 1024, // 1 GB
  cpuSeconds: 30,
  fileSizeBytes: 32 * 1024 * 1024, // 32 MB
  processes: 64,
};

/** 编译器输出上限。模板炸弹能吐出 GB 级错误信息，必须截断 */
export const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB
