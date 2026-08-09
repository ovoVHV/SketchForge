/**
 * 编译器输出 → 结构化诊断，并把行号映射回用户的 .ino。
 *
 * 底座对外的全部承诺就浓缩在这个文件里：
 *   **给我 .ino，还你精确到 行/列 的结构化诊断。**
 * 上层（图形化平台）拿到 line 之后查自己的 sourceMap 就能高亮到具体积木，
 * 所以这里错一行，上层所有平台的积木报错定位就全错。
 */

import type { Diagnostic, DiagnosticSeverity } from '../types.js';
import type { FunctionDef } from '../preprocess/functions.js';
import { GENERATED_FILE } from '../preprocess/index.js';
import type { Sanitizer } from './sanitize.js';

export interface RemapContext {
  sourceName: string;
  sourceLineCount: number;
  projectFiles?: ReadonlyArray<{ name: string; lineCount: number }>;
  generatedLineToFunction: Map<number, FunctionDef>;
  sanitize: Sanitizer;
}

/** `file:line:col: severity: message`（col 可缺省） */
const DIAG_RE = /^(.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/;
/** `In file included from file:line[,:]` 及其续行 `                 from file:line[,:]` */
const INCLUDE_RE = /^\s*(?:In file included from|from)\s+(.*?):(\d+)[,:]?\s*$/;
/** 无文件归属的编译器级错误，如 `cc1plus: error: ...` */
const TOOL_RE = /^([A-Za-z0-9_.+-]+):\s*(fatal error|error|warning):\s*(.*)$/;
/**
 * 链接器错误。ld 的输出**不带 `error:` 前缀**，格式也和编译器完全不同：
 *     lib0.a(Foo.cpp.o):(.text+0x1a): undefined reference to `bar()'
 *     main.cpp.o: In function `loop': main.ino:12: undefined reference to `helper()'
 * 不单独识别的话，这类错误会被整段丢弃，用户只看到一句
 * "collect2: ld returned 1 exit status"，完全无法排查。
 */
const LINKER_RE = /(undefined reference to|multiple definition of|relocation truncated|region .* overflowed|will not fit in region)/i;
/** 从链接器错误里尽量抠出 `文件:行号` */
const LINKER_LOC_RE = /(?:^|\s)([\w:./\\-]+\.(?:ino|c|cc|cpp|cxx|S|h|hh|hpp|hxx)):(\d+)(?::|\s|$)/;

function toSeverity(s: string): DiagnosticSeverity {
  if (s === 'note') return 'info';
  if (s === 'warning') return 'warning';
  return 'error';
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? p : p.slice(idx + 1);
}

function projectFileFor(path: string, ctx: RemapContext): { name: string; lineCount: number } | undefined {
  const normalized = path.replaceAll('\\', '/');
  return ctx.projectFiles?.find((file) => (
    normalized === file.name || normalized.endsWith(`/${file.name}`)
  ));
}

export function parseDiagnostics(output: string, ctx: RemapContext): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const lines = output.split(/\r?\n/);

  /** 当前的 #include 链，最后一项是最外层（最接近用户代码的那一层） */
  let includeChain: Array<{ file: string; line: number }> = [];

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;

    // ---- #include 链 ----
    const inc = INCLUDE_RE.exec(rawLine);
    if (inc) {
      if (/^\s*In file included from/.test(rawLine)) includeChain = [];
      includeChain.push({ file: inc[1] ?? '', line: Number(inc[2]) });
      continue;
    }

    // ---- 源码回显行 / 波浪线 / 插入符 —— 丢弃 ----
    if (/^\s*[\^~|]/.test(rawLine) || /^\s*\d+\s*\|/.test(rawLine)) continue;

    const m = DIAG_RE.exec(rawLine);
    if (m) {
      const file = (m[1] ?? '').trim();
      const line = Number(m[2]);
      const column = m[3] ? Number(m[3]) : undefined;
      const severity = toSeverity(m[4] ?? 'error');
      const message = ctx.sanitize(m[5] ?? '');
      const raw = ctx.sanitize(rawLine);

      diags.push(remap({ file, line, column, severity, message, raw }, ctx, includeChain));
      includeChain = [];
      continue;
    }

    // ---- `main.ino: In function 'void loop()':` 这类上下文行 ----
    if (/:\s*In (function|member function|constructor|destructor|instantiation)/.test(rawLine)) {
      continue;
    }

    // ---- 链接器错误（无 error: 前缀，格式与编译器完全不同）----
    if (LINKER_RE.test(rawLine)) {
      const loc = LINKER_LOC_RE.exec(rawLine);
      const located = loc && (
        basename(loc[1] ?? '') === ctx.sourceName
          ? { name: ctx.sourceName, lineCount: ctx.sourceLineCount }
          : projectFileFor(loc[1] ?? '', ctx)
      );
      const line = located ? Number(loc![2]) : 1;
      const inRange = Boolean(located && line >= 1 && line <= located.lineCount);
      diags.push({
        severity: 'error',
        file: located?.name ?? ctx.sourceName,
        line: inRange ? line : 1,
        message: ctx.sanitize(explainLinkerError(rawLine)),
        raw: ctx.sanitize(rawLine),
        ...(located && inRange ? {} : { unmapped: true }),
      });
      continue;
    }

    // ---- 编译器自身的错误（无文件归属） ----
    const t = TOOL_RE.exec(rawLine);
    if (t) {
      // collect2 的 "ld returned 1 exit status" 只是个汇总，
      // 真正原因已经在上面的链接器错误里给出了，不必重复打扰用户
      if (/collect2.*ld returned/i.test(rawLine) && diags.some((d) => d.severity === 'error')) continue;
      diags.push({
        severity: toSeverity(t[2] ?? 'error'),
        file: ctx.sourceName,
        line: 1,
        message: ctx.sanitize(`${t[1]}: ${t[3]}`),
        raw: ctx.sanitize(rawLine),
        unmapped: true,
      });
    }
  }

  return foldNotes(diags);
}

/**
 * 给链接器错误补一句人话。
 * 原始信息（"undefined reference to X"）对新手基本等于天书，
 * 而这几类错误的成因高度集中，值得直接说清楚。
 */
function explainLinkerError(raw: string): string {
  const line = raw.trim();
  if (/undefined reference to/i.test(line)) {
    const sym = /undefined reference to [`'"]?([^'"`]+)/i.exec(line)?.[1] ?? '';
    return `找不到 ${sym ? `\`${sym}\` 的定义` : '某个函数的定义'}：` +
           `可能是函数只声明未实现，或漏了对应的库。`;
  }
  if (/multiple definition of/i.test(line)) {
    const sym = /multiple definition of [`'"]?([^'"`]+)/i.exec(line)?.[1] ?? '';
    return `${sym ? `\`${sym}\`` : '某个符号'} 被重复定义：通常是在头文件里直接定义了变量或函数。`;
  }
  if (/will not fit in region|overflowed/i.test(line)) {
    return `程序太大，超出了板子的存储空间：${line}`;
  }
  if (/relocation truncated/i.test(line)) {
    return `代码超出芯片可寻址范围：${line}`;
  }
  return line;
}

function remap(
  d: {
    file: string;
    line: number;
    column?: number;
    severity: DiagnosticSeverity;
    message: string;
    raw: string;
  },
  ctx: RemapContext,
  includeChain: Array<{ file: string; line: number }>,
): Diagnostic {
  const base: Diagnostic = {
    severity: d.severity,
    file: ctx.sourceName,
    line: d.line,
    message: d.message,
    raw: d.raw,
  };
  if (d.column !== undefined) base.column = d.column;

  // ① 用户源文件 —— #line 指令已经让编译器直接报 .ino 行号，直用即可
  if (d.file === ctx.sourceName || basename(d.file) === ctx.sourceName) {
    if (d.line < 1 || d.line > ctx.sourceLineCount) {
      return { ...base, line: Math.min(Math.max(d.line, 1), ctx.sourceLineCount), unmapped: true };
    }
    return base;
  }

  // ② 自动生成的函数原型 —— 回溯到对应函数定义的真实位置
  if (d.file === GENERATED_FILE || basename(d.file) === GENERATED_FILE) {
    const fn = ctx.generatedLineToFunction.get(d.line);
    if (fn) {
      return {
        ...base,
        line: fn.line,
        column: 1,
        fromGenerated: true,
        message: `函数 \`${fn.name}\` 的自动生成声明有问题：${d.message}`,
      };
    }
    return { ...base, line: 1, fromGenerated: true, unmapped: true };
  }


  // ③ 用户随项目上传的源码或头文件 —— 保留相对路径和真实行号。
  const projectFile = projectFileFor(d.file, ctx);
  if (projectFile) {
    const inRange = d.line >= 1 && d.line <= projectFile.lineCount;
    return {
      ...base,
      file: projectFile.name,
      line: inRange ? d.line : Math.min(Math.max(d.line, 1), projectFile.lineCount),
      ...(inRange ? {} : { unmapped: true }),
    };
  }

  // ④ 平台库头文件里的错误 —— 回溯 #include 链到用户代码
  //    比 Arduino IDE 直接甩一个头文件路径有用得多：
  //    图形化平台可以据此高亮"引入了这个库的那个积木"。
  const root = [...includeChain].reverse().map((entry) => {
    if (entry.file === ctx.sourceName || basename(entry.file) === ctx.sourceName) {
      return { ...entry, name: ctx.sourceName, lineCount: ctx.sourceLineCount };
    }
    const project = projectFileFor(entry.file, ctx);
    return project ? { ...entry, name: project.name, lineCount: project.lineCount } : null;
  }).find((entry) => entry !== null);
  const where = `${basename(d.file)}:${d.line}`;
  if (root && root.line >= 1 && root.line <= root.lineCount) {
    return {
      ...base,
      file: root.name,
      line: root.line,
      column: 1,
      message: `库文件 ${where} 中报错：${d.message}`,
    };
  }

  return {
    ...base,
    line: 1,
    message: `${where}: ${d.message}`,
    unmapped: true,
  };
}

/**
 * 把紧跟在错误后面、位置相同的 `note: suggested alternative: 'x'` 折叠进主错误。
 *
 * 拼错函数名是最高频的错误，gcc 的 "did you mean" 提示极有价值，
 * 但拆成两条诊断的话前端很难关联。折叠成一条可直接操作的提示。
 */
function foldNotes(diags: Diagnostic[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const d of diags) {
    const prev = out[out.length - 1];
    if (
      d.severity === 'info' &&
      prev &&
      prev.severity === 'error' &&
      prev.file === d.file &&
      prev.line === d.line
    ) {
      const alt = /suggested alternative:\s*[‘'"`]?([^’'"`\s]+)/.exec(d.message);
      if (alt) {
        prev.message = `${prev.message}（是不是想写 \`${alt[1]}\`？）`;
        continue;
      }
    }
    out.push(d);
  }
  return out;
}
