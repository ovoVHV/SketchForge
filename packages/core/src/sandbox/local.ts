/**
 * 本地执行器 —— **仅供开发使用，没有任何隔离**。
 *
 * 只提供三样东西：墙钟超时、输出截断、进程树清理。
 * 它挡不住 `.incbin` 读文件，挡不住内存炸弹，挡不住出网。
 *
 * 服务在生产模式下会检查 isolationLevel，见到 'none' 直接拒绝启动 ——
 * 这是刻意设计的，防止有人不小心把开发配置带到线上。
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { ExecRequest, ExecResult, SandboxExecutor } from './types.js';
import { MAX_OUTPUT_BYTES } from './types.js';

const isWindows = platform() === 'win32';

/** 杀掉整棵进程树。avr-g++ 会拉起 cc1plus，只杀直接子进程是不够的 */
function killTree(pid: number, child: { kill: (s?: NodeJS.Signals) => boolean }): void {
  if (isWindows) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    try {
      // 负号 = 杀掉整个进程组（spawn 时设了 detached）
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

export class LocalExecutor implements SandboxExecutor {
  readonly name = 'local';
  readonly isolationLevel = 'none' as const;

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

    return new Promise<ExecResult>((resolve) => {
      const child = spawn(req.command, req.args, {
        cwd: req.cwd,
        env: { ...process.env, ...req.env },
        windowsHide: true,
        detached: !isWindows, // POSIX 下建独立进程组，便于整组杀
      });

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
          // 输出炸弹本身就是攻击手段，直接终止
          if (child.pid) killTree(child.pid, child);
          return;
        }
        if (which === 'out') stdout = cur + buf.toString('utf8');
        else stderr = cur + buf.toString('utf8');
      };

      child.stdout?.on('data', (b: Buffer) => append(b, 'out'));
      child.stderr?.on('data', (b: Buffer) => append(b, 'err'));

      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killTree(child.pid, child);
      }, req.timeoutMs);

      const abort = () => {
        if (child.pid) killTree(child.pid, child);
      };
      if (req.signal?.aborted) abort();
      else req.signal?.addEventListener('abort', abort, { once: true });

      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', abort);
        resolve({
          code,
          signal,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          timedOut,
          truncated,
        });
      };

      child.on('error', (err) => {
        stderr += `\n[executor] 启动失败: ${(err as Error).message}`;
        finish(null, null);
      });
      child.on('close', finish);
    });
  }
}
