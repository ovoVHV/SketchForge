/**
 * 源码安全预检 —— 廉价的绊线，**不是安全边界**。
 *
 * ⚠️ 必须反复强调：真正的防线是文件系统隔离（mount namespace / chroot）+
 *    编译容器断网 + 容器内零密钥。本文件只是在那之前顺手拦掉 99% 的顺手试探，
 *    成本接近于零。**任何时候都不要因为有了这个预检就放松沙箱。**
 *
 * 主要目标：内联汇编的 `.incbin`。
 *
 *     asm(".incbin \"/etc/passwd\"");
 *
 * `.incbin` 会把任意文件逐字节塞进输出的 ELF section，用户下载编译产物
 * 一解析就拿到了服务端文件。`-I` 白名单、`--sysroot` 都拦不住它，
 * 因为是汇编器直接开的文件。
 *
 * 实现上有个要命的细节：`.incbin` 出现在**字符串字面量内部**，
 * 所以绝不能在遮罩后的源码上扫（那样字符串已经被抹平，永远扫不到）。
 * 必须在原始源码上扫。
 */

import { scan } from '../preprocess/scanner.js';

export interface PrecheckFinding {
  rule: string;
  message: string;
  line: number;
}

export interface PrecheckResult {
  ok: boolean;
  findings: PrecheckFinding[];
}

/** 危险的汇编伪指令 */
const DANGEROUS_ASM_DIRECTIVES = [
  { re: /\.incbin\b/i, rule: 'asm.incbin', desc: '.incbin 可以把服务端任意文件嵌入编译产物' },
  { re: /\.include\b/i, rule: 'asm.include', desc: '.include 可以读取服务端任意文件' },
];

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charAt(i) === '\n') line++;
  }
  return line;
}

export function precheck(source: string): PrecheckResult {
  const findings: PrecheckFinding[] = [];

  // ---- 规则 1：直接扫原始源码里的危险汇编伪指令 ----
  // 在原始源码上扫，因为攻击载荷藏在字符串字面量里。
  // 代价是注释里提到 .incbin 也会被拦 —— 极其罕见，且提示信息说得清楚，可接受。
  for (const { re, rule, desc } of DANGEROUS_ASM_DIRECTIVES) {
    const m = re.exec(source);
    if (m && m.index !== undefined) {
      findings.push({
        rule,
        message: `代码中出现了 \`${m[0]}\`：${desc}，本平台不允许。`,
        line: lineOf(source, m.index),
      });
    }
  }

  // ---- 规则 2：#include 绝对路径 / 目录穿越 ----
  const { directives } = scan(source);
  for (const d of directives) {
    if (d.name !== 'include') continue;
    const target = /[<"]([^>"]*)[>"]/.exec(d.text)?.[1] ?? '';
    if (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith('/') || target.startsWith('\\')) {
      findings.push({
        rule: 'include.absolute',
        message: `不允许用绝对路径 include：\`${target}\``,
        line: d.line,
      });
    } else if (target.split(/[\\/]/).includes('..')) {
      findings.push({
        rule: 'include.traversal',
        message: `不允许在 include 路径里使用 \`..\`：\`${target}\``,
        line: d.line,
      });
    }
  }

  return { ok: findings.length === 0, findings };
}
