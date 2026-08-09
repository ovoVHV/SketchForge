/**
 * bubblewrap 执行器 —— 生产环境（Linux）的默认隔离方案。
 *
 * ## 为什么是 bubblewrap 而不是 nsjail
 *
 * 实测发现：**nsjail 不在 Debian 稳定版仓库里**（bookworm 没有该包），
 * 生产镜像要么从源码编译（引入 protobuf/libnl/bison/flex 一堆构建依赖
 * 和长期维护负担），要么跟 unstable。而 bubblewrap 在 main 仓库、
 * 是 Flatpak 的沙箱底座，久经考验。
 *
 * ## 提供的隔离
 *   · mount namespace：编译进程眼里只有工具链（只读）+ 本次构建目录（读写）。
 *     **这是防 `.incbin` 任意文件读的唯一可靠防线** —— 看不见的文件读不走。
 *   · network namespace：`--unshare-net`，完全无网卡，
 *     顺带屏蔽云元数据端点 169.254.169.254。
 *   · pid namespace + 全新 /proc：堵掉从 /proc 翻其他进程信息的路。
 *   · `--new-session`：切断 TTY，防 TIOCSTI 注入。
 *   · `--clearenv`：宿主环境变量（含密钥）一律不进沙箱。
 *
 * ## rlimit 怎么来的
 * bubblewrap 自己不管 rlimit，所以外面套一层 util-linux 的 `prlimit`：
 *     prlimit → bwrap → 编译器
 * rlimit 会经 exec 继承下去，也会穿透进命名空间。
 *
 * ## ⚠️ 容器权限要求（实测结论，务必照做）
 * 在 Docker 默认配置下 bwrap **起不来** —— Docker 的 seccomp profile 拦掉了
 * 创建 user namespace 所需的系统调用。实测：
 *     默认                        → 失败
 *     --cap-add SYS_ADMIN         → 仍失败（pivot_root 被拦）
 *     --security-opt seccomp=unconfined → 成功（且不需要 SYS_ADMIN）
 *     --privileged                → 成功（权限过大，不要用）
 *
 * 所以最小可行配置是放宽 seccomp，**不需要** SYS_ADMIN 或 privileged。
 *
 * 需要理解的权衡：放宽 worker 容器的 seccomp，意味着**容器与宿主之间**的
 * 边界变弱了。所以正确的部署形态是分两层看：
 *   · 「用户代码 ↔ worker 容器」——由 bwrap 负责，已验证（scripts/verify-sandbox.ts）
 *   · 「worker 容器 ↔ 宿主」——**不能只靠 Docker**，要用专用 VM，
 *     或 gVisor / Firecracker 承担。公网产品尤其不能省这一层。
 *
 * 想收紧到比 seccomp=unconfined 更精确，需要以 Docker 默认 profile 为基础
 * 放行创建命名空间所需的调用（clone 的 CLONE_NEWUSER 参数过滤、setns、
 * pivot_root、mount/umount2）。默认 profile 有上千行，手写不现实，
 * 应当从 moby/profiles/seccomp/default.json 派生后打补丁再挂载。
 */

import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import type { ExecRequest, ExecResult, SandboxExecutor } from './types.js';
import { MAX_OUTPUT_BYTES } from './types.js';

export interface BubblewrapOptions {
  bwrapPath?: string;
  prlimitPath?: string;
  /** 需要只读暴露的系统目录 */
  systemPaths?: string[];
}

const DEFAULT_SYSTEM_PATHS = ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc/alternatives'];
// RLIMIT_NPROC is accounted per UID on hosts that do not give each container
// a private user namespace. Every worker image uses the same fixed runtime UID,
// so a literal 64 here makes two otherwise idle pools reject fork/vfork with
// EAGAIN. The deployed worker cgroup remains the tighter bound (96 PIDs by
// default); this floor only prevents cross-container false positives.
const MIN_NPROC_LIMIT = 256;

export class BubblewrapExecutor implements SandboxExecutor {
  readonly name = 'bubblewrap';
  readonly isolationLevel = 'namespace' as const;

  private readonly bwrap: string;
  private readonly prlimit: string;
  private readonly systemPaths: string[];

  constructor(opts: BubblewrapOptions = {}) {
    this.bwrap = opts.bwrapPath ?? 'bwrap';
    this.prlimit = opts.prlimitPath ?? 'prlimit';
    this.systemPaths = opts.systemPaths ?? DEFAULT_SYSTEM_PATHS;
  }

  private buildArgs(req: ExecRequest): { cmd: string; args: string[] } {
    const l = req.limits;

    // 外层：rlimit。挡模板递归炸弹 / fork 炸弹 / 写满磁盘
    const prlimitArgs = [
      `--as=${l.memoryBytes}`,
      `--cpu=${l.cpuSeconds}`,
      `--fsize=${l.fileSizeBytes}`,
      `--nproc=${Math.max(l.processes, MIN_NPROC_LIMIT)}`,
      `--nofile=256`,
      `--core=0`,
      '--',
      this.bwrap,
    ];

    // 内层：命名空间隔离
    const bwrapArgs = [
      '--unshare-all',      // user / ipc / pid / net / uts / cgroup
      '--die-with-parent',  // 父进程一死，整棵子树跟着走，杜绝孤儿进程
      '--new-session',      // 切断 TTY，防 TIOCSTI 注入
      '--clearenv',         // 宿主环境变量（含密钥）不进沙箱
    ];

    for (const p of this.systemPaths) bwrapArgs.push('--ro-bind-try', p, p);
    // 只读工具链
    for (const p of normalizeMountPaths(req.readOnlyPaths ?? [], 'read-only')) {
      bwrapArgs.push('--ro-bind', p, p);
    }
    // 可读写：仅本次构建目录
    for (const p of req.readWritePaths ?? [req.cwd]) bwrapArgs.push('--bind', p, p);

    bwrapArgs.push(
      '--proc', '/proc',   // 新 pid namespace 的独立 /proc，看不到别人
      '--dev', '/dev',     // 最小 /dev，不含任何真实设备
      '--tmpfs', '/tmp',
      '--chdir', req.cwd,
    );

    for (const [k, v] of Object.entries(req.env ?? {})) bwrapArgs.push('--setenv', k, v);
    // 编译器需要 PATH 才能找到 cc1plus 等后端
    if (!req.env?.PATH) bwrapArgs.push('--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin');

    bwrapArgs.push('--', req.command, ...req.args);

    return { cmd: this.prlimit, args: [...prlimitArgs, ...bwrapArgs] };
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
    const { cmd, args } = this.buildArgs(req);

    return new Promise<ExecResult>((resolve) => {
      const child = spawn(cmd, args, { detached: true });

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const killTree = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
      };

      const append = (buf: Buffer, which: 'out' | 'err') => {
        if (truncated) return;
        const cur = which === 'out' ? stdout : stderr;
        if (cur.length + buf.length > MAX_OUTPUT_BYTES) {
          const room = Math.max(0, MAX_OUTPUT_BYTES - cur.length);
          const tail = '\n... [输出过长，已截断] ...';
          if (which === 'out') stdout = cur + buf.toString('utf8', 0, room) + tail;
          else stderr = cur + buf.toString('utf8', 0, room) + tail;
          truncated = true;
          killTree(); // 输出炸弹本身就是攻击手段，直接终止
          return;
        }
        if (which === 'out') stdout = cur + buf.toString('utf8');
        else stderr = cur + buf.toString('utf8');
      };

      child.stdout?.on('data', (b: Buffer) => append(b, 'out'));
      child.stderr?.on('data', (b: Buffer) => append(b, 'err'));

      // rlimit 管的是 CPU 时间，睡眠不计入 —— 所以墙钟超时必须另外兜底
      const timer = setTimeout(() => { timedOut = true; killTree(); }, req.timeoutMs);

      const abort = () => killTree();
      if (req.signal?.aborted) abort();
      else req.signal?.addEventListener('abort', abort, { once: true });

      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', abort);
        resolve({ code, signal, stdout, stderr, durationMs: Date.now() - started, timedOut, truncated });
      };

      child.on('error', (err) => {
        stderr += `\n[bubblewrap] 启动失败: ${(err as Error).message}`;
        finish(null, null);
      });
      child.on('close', finish);
    });
  }
}

function normalizeMountPaths(paths: readonly string[], label: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (typeof path !== 'string' || !isAbsolute(path)) {
      throw new TypeError(`bubblewrap ${label} mount path must be absolute`);
    }
    const normalized = resolve(path);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}
