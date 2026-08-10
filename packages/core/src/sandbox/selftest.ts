/**
 * 沙箱启动自检 —— **真的去跑一遍，而不是相信声明**。
 *
 * 起因是一个实测踩到的坑：服务在容器里正常启动、`/healthz` 返回
 * `isolation: "namespace"` 一片绿，但 bubblewrap 实际上创建不了命名空间
 * （Docker 默认 seccomp 拦住了），直到第一个用户点编译才暴露。
 * 生产环境的表现就是「健康检查全绿，所有编译失败」。
 *
 * 根因：`isolationLevel` 是执行器的**静态声明**，不代表运行时真的具备该能力。
 * 声明和现实之间必须有一次真实验证。
 *
 * 因此这里在启动时真的跑三个用例：
 *   1. 沙箱能不能执行命令（抓「命名空间创建失败」这类环境问题）
 *   2. 沙箱外的文件是否真的读不到（`.incbin` 攻击面的核心防线）
 *   3. 网络是否真的断开（顺带屏蔽云元数据端点）
 *
 * 生产模式下任何一项失败都必须拒绝启动 —— 带着失效的沙箱对公网提供服务，
 * 比直接不启动危险得多。
 */

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SandboxExecutor } from './types.js';
import { DEFAULT_LIMITS } from './types.js';

export interface SelfTestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SelfTestResult {
  ok: boolean;
  /** 未做隔离检查（执行器本就声明无隔离，如开发用的 LocalExecutor） */
  skipped: boolean;
  checks: SelfTestCheck[];
}

const CANARY = 'SKETCHFORGE_CANARY_MUST_NOT_BE_READABLE';

export async function selfTestSandbox(
  executor: SandboxExecutor,
  workDirRoot: string,
): Promise<SelfTestResult> {
  const checks: SelfTestCheck[] = [];

  if (executor.isolationLevel !== 'namespace') {
    return {
      ok: false,
      skipped: true,
      checks: [{
        name: '隔离等级',
        ok: false,
        detail: `执行器 "${executor.name}" 声明隔离等级为 "${executor.isolationLevel}"，仅可用于开发`,
      }],
    };
  }

  mkdirSync(workDirRoot, { recursive: true });
  const base = mkdtempSync(join(workDirRoot, 'selftest-'));
  const sandboxDir = join(base, 'build');
  mkdirSync(sandboxDir, { recursive: true });

  // 诱饵文件放在**沙箱可见范围之外**（base 下，但只挂载 base/build）
  const canaryPath = join(base, 'canary.txt');
  writeFileSync(canaryPath, CANARY, 'utf8');

  const run = (args: string[], cmd = '/bin/sh') =>
    executor.exec({
      command: cmd,
      args,
      cwd: sandboxDir,
      timeoutMs: 15_000,
      limits: DEFAULT_LIMITS,
      readOnlyPaths: [],
      readWritePaths: [sandboxDir],
    });

  try {
    // ---- 1. 沙箱能否执行命令 ----
    const echo = await run(['-c', 'echo SANDBOX_ALIVE']);
    const alive = echo.code === 0 && echo.stdout.includes('SANDBOX_ALIVE');
    checks.push({
      name: '沙箱可执行命令',
      ok: alive,
      detail: alive ? undefined : (echo.stderr || echo.stdout || `exit=${echo.code}`).trim().slice(0, 300),
    });

    if (!alive) {
      // 后面的隔离检查会"因为跑不起来所以看起来通过"，是假阳性，直接短路
      return { ok: false, skipped: false, checks };
    }

    // ---- 2. 沙箱外的文件必须读不到（防 .incbin 外泄的核心防线）----
    const readOutside = await run(['-c', `cat ${JSON.stringify(canaryPath)} 2>&1`]);
    const leaked = readOutside.stdout.includes(CANARY) || readOutside.stderr.includes(CANARY);
    checks.push({
      name: '沙箱外文件不可读',
      ok: !leaked,
      detail: leaked ? `诱饵文件 ${canaryPath} 在沙箱内被读到了` : undefined,
    });

    // ---- 3. 网络必须断开 ----
    // 有独立 netns 时 /proc/net/dev 里只剩 lo
    const net = await run(['-c', 'cat /proc/net/dev 2>/dev/null | tail -n +3 | awk \'{print $1}\'']);
    const ifaces = net.stdout.split(/\s+/).map((s) => s.replace(/:$/, '')).filter(Boolean);
    const onlyLoopback = ifaces.length > 0 && ifaces.every((i) => i === 'lo');
    checks.push({
      name: '网络已隔离',
      ok: onlyLoopback,
      detail: onlyLoopback ? undefined : `沙箱内可见网卡: ${ifaces.join(', ') || '(读不到 /proc/net/dev)'}`,
    });

    return { ok: checks.every((c) => c.ok), skipped: false, checks };
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
}

/** 格式化成可直接打印到启动日志的多行文本 */
export function formatSelfTest(r: SelfTestResult): string {
  return r.checks.map((c) => `  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `\n      ${c.detail}` : ''}`).join('\n');
}

export { tmpdir };
