/**
 * nsjail 执行器 —— 生产环境（Linux）用。
 *
 * 提供的隔离：
 *   · mount namespace：编译进程眼里只有工具链（只读）+ 本次构建目录（读写）。
 *     **这是防 `.incbin` 任意文件读的唯一可靠防线** —— 看不见的文件读不走。
 *   · network namespace：全新空 netns，无任何网卡。顺带屏蔽了云元数据端点
 *     169.254.169.254。
 *   · rlimit：地址空间 / CPU 时间 / 文件大小 / 进程数，挡各类编译炸弹。
 *   · 降权到 nobody。
 *   · 不挂载 /proc，堵掉 /proc/self/environ 这类信息泄漏。
 *
 * ⚠️ 状态说明：本文件在 Windows 开发机上**无法执行验证**。
 *    上线前必须在目标 Linux 镜像里跑一遍 `docker/verify-sandbox.sh`，
 *    确认逃逸用例（读 /etc/passwd、出网、fork 炸弹）全部被拦截。
 *    不要因为代码写完了就假定它生效。
 */

import { spawn } from 'node:child_process';
import type { ExecRequest, ExecResult, SandboxExecutor } from './types.js';
import { MAX_OUTPUT_BYTES } from './types.js';

export interface NsjailOptions {
  /** nsjail 可执行文件路径 */
  nsjailPath?: string;
  /** 降权到的用户/组 */
  user?: string;
  group?: string;
}

export class NsjailExecutor implements SandboxExecutor {
  readonly name = 'nsjail';
  readonly isolationLevel = 'namespace' as const;

  private readonly nsjailPath: string;
  private readonly user: string;
  private readonly group: string;

  constructor(opts: NsjailOptions = {}) {
    this.nsjailPath = opts.nsjailPath ?? 'nsjail';
    this.user = opts.user ?? 'nobody';
    this.group = opts.group ?? 'nogroup';
  }

  private buildArgs(req: ExecRequest): string[] {
    const mb = (bytes: number) => Math.max(1, Math.floor(bytes / (1024 * 1024)));
    const args: string[] = [
      '-Mo',                                    // 模式：执行一次即退出
      '--really_quiet',                         // 不要 nsjail 自己的日志混进编译输出
      '-t', String(Math.ceil(req.timeoutMs / 1000)),
      '--user', this.user,
      '--group', this.group,
      '--cwd', req.cwd,

      // ---- 资源限额 ----
      '--rlimit_as', String(mb(req.limits.memoryBytes)),
      '--rlimit_cpu', String(req.limits.cpuSeconds),
      '--rlimit_fsize', String(mb(req.limits.fileSizeBytes)),
      '--rlimit_nproc', String(req.limits.processes),
      '--rlimit_nofile', '256',
      '--rlimit_core', '0',

      // ---- 不挂 /proc：堵住 /proc/self/environ 等信息泄漏 ----
      '--disable_proc',

      // 网络：不加 -N，nsjail 默认创建全新空 netns（无网卡），即完全断网
    ];

    // 最小可用的只读系统目录
    for (const p of ['/lib', '/lib64', '/usr/lib', '/usr/lib64', '/bin', '/usr/bin']) {
      args.push('-R', p);
    }
    for (const p of req.readOnlyPaths ?? []) args.push('-R', p);
    for (const p of req.readWritePaths ?? [req.cwd]) args.push('-B', p);

    // 临时目录用内存文件系统，随进程消亡
    args.push('-m', 'none:/tmp:tmpfs:size=67108864');

    for (const [k, v] of Object.entries(req.env ?? {})) args.push('-E', `${k}=${v}`);

    args.push('--', req.command, ...req.args);
    return args;
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const started = Date.now();
    if (req.signal?.aborted) {
      return {
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        truncated: false,
      };
    }
    const args = this.buildArgs(req);

    return new Promise<ExecResult>((resolve) => {
      const child = spawn(this.nsjailPath, args, { detached: true });

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const append = (buf: Buffer, which: 'out' | 'err') => {
        if (truncated) return;
        const cur = which === 'out' ? stdout : stderr;
        if (cur.length + buf.length > MAX_OUTPUT_BYTES) {
          const room = Math.max(0, MAX_OUTPUT_BYTES - cur.length);
          const tail = '\n... [输出过长，已截断] ...';
          if (which === 'out') stdout = cur + buf.toString('utf8', 0, room) + tail;
          else stderr = cur + buf.toString('utf8', 0, room) + tail;
          truncated = true;
          if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ } }
          return;
        }
        if (which === 'out') stdout = cur + buf.toString('utf8');
        else stderr = cur + buf.toString('utf8');
      };

      child.stdout?.on('data', (b: Buffer) => append(b, 'out'));
      child.stderr?.on('data', (b: Buffer) => append(b, 'err'));

      // nsjail 自带 -t 超时，这里再加一层墙钟兜底，防 nsjail 本身卡住
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ } }
      }, req.timeoutMs + 5000);

      const abort = () => {
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
      };
      if (req.signal?.aborted) abort();
      else req.signal?.addEventListener('abort', abort, { once: true });

      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', abort);
        resolve({
          code, signal, stdout, stderr,
          durationMs: Date.now() - started,
          timedOut, truncated,
        });
      };

      child.on('error', (err) => {
        stderr += `\n[nsjail] 启动失败: ${(err as Error).message}`;
        finish(null, null);
      });
      child.on('close', finish);
    });
  }
}
