/**
 * C/C++ 词法遮罩扫描器。
 *
 * 核心手法：**遮罩(mask)而非删除**。
 * 把注释、字符串、字符字面量全部替换成等长的空格（换行符原样保留），
 * 得到一个与原文 **长度完全相同** 的 `masked` 字符串。
 * 于是 masked 里任何偏移量都可以直接拿到原文里用 —— 这是后续
 * 函数识别和行号映射不出错的地基。
 *
 * 如果改成删除，偏移量就要维护一张位移表，那是 bug 的温床。
 */

export interface Directive {
  /** 指令名，不含 '#'，如 "include" / "define" */
  name: string;
  /** 起始偏移（'#' 所在位置） */
  start: number;
  /** 结束偏移（不含），已包含行接续 '\' 连接的后续行 */
  end: number;
  /** 起始行号，1-based */
  line: number;
  /** 结束行号，1-based（行接续时会大于 line） */
  endLine: number;
  /** 原始文本 */
  text: string;
}

export interface ScanResult {
  /** 与原文等长；注释/字符串/字符字面量已被空格遮罩 */
  masked: string;
  /** 每一行的起始偏移，lineStarts[0] 对应第 1 行 */
  lineStarts: number[];
  /** 所有预处理指令 */
  directives: Directive[];
}

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdentChar = (c: string) => /[A-Za-z0-9_$]/.test(c);

/** 把一段区间遮罩成空格，但保留其中的换行符（否则行号会错乱） */
function maskRange(out: string[], src: string, start: number, end: number): void {
  for (let i = start; i < end; i++) {
    out[i] = src.charAt(i) === '\n' ? '\n' : ' ';
  }
}

export function scan(source: string): ScanResult {
  const n = source.length;
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = source.charAt(i);

  const lineStarts: number[] = [0];
  for (let i = 0; i < n; i++) {
    if (source.charAt(i) === '\n') lineStarts.push(i + 1);
  }

  const offsetToLine = (offset: number): number => {
    // 二分查找
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const directives: Directive[] = [];

  let i = 0;
  /** 当前是否处于"行首（只有空白）"状态 —— 预处理指令只能出现在这里 */
  let atLineStart = true;

  while (i < n) {
    const c = source.charAt(i);
    const c2 = source.charAt(i + 1);

    // ---- 行注释 ----
    if (c === '/' && c2 === '/') {
      const start = i;
      i += 2;
      // 行注释可以被行末反斜杠接续到下一行
      while (i < n) {
        if (source.charAt(i) === '\\') {
          // 吞掉 \ + (\r)? + \n
          let j = i + 1;
          if (source.charAt(j) === '\r') j++;
          if (source.charAt(j) === '\n') { i = j + 1; continue; }
        }
        if (source.charAt(i) === '\n') break;
        i++;
      }
      maskRange(out, source, start, i);
      atLineStart = false;
      continue;
    }

    // ---- 块注释 ----
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      while (i < n && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) i++;
      i = Math.min(i + 2, n);
      maskRange(out, source, start, i);
      atLineStart = false;
      continue;
    }

    // ---- 原始字符串 R"delim( ... )delim" （ESP32 代码里常见） ----
    // 允许前缀 u8 / L / u / U，例如 u8R"(...)"
    if (c === 'R' || ((c === 'u' || c === 'U' || c === 'L') && source.charAt(i + 1) === 'R') ||
        (c === 'u' && c2 === '8' && source.charAt(i + 2) === 'R')) {
      // 定位到 R 的位置
      let rPos = i;
      if (c !== 'R') rPos = source.indexOf('R', i);
      const quotePos = rPos + 1;
      if (source.charAt(quotePos) === '"') {
        // 前一个字符不能是标识符字符，否则这是个变量名的一部分
        const prev = i > 0 ? source.charAt(i - 1) : '';
        if (!isIdentChar(prev)) {
          const delimStart = quotePos + 1;
          let d = delimStart;
          while (d < n && source.charAt(d) !== '(' && d - delimStart <= 16) d++;
          if (source.charAt(d) === '(') {
            const delim = source.slice(delimStart, d);
            const terminator = ')' + delim + '"';
            const endIdx = source.indexOf(terminator, d + 1);
            const stop = endIdx === -1 ? n : endIdx + terminator.length;
            maskRange(out, source, i, stop);
            i = stop;
            atLineStart = false;
            continue;
          }
        }
      }
    }

    // ---- 普通字符串 / 字符字面量 ----
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      while (i < n) {
        const ch = source.charAt(i);
        if (ch === '\\') { i += 2; continue; }
        if (ch === quote) { i++; break; }
        // 未闭合的字面量：遇到换行就停，避免把整个文件吞掉
        if (ch === '\n') break;
        i++;
      }
      maskRange(out, source, start, i);
      atLineStart = false;
      continue;
    }

    // ---- 预处理指令 ----
    if (c === '#' && atLineStart) {
      const start = i;
      const startLine = offsetToLine(start);
      let j = i + 1;
      while (j < n && /[ \t]/.test(source.charAt(j))) j++;
      let nameEnd = j;
      while (nameEnd < n && isIdentChar(source.charAt(nameEnd))) nameEnd++;
      const name = source.slice(j, nameEnd);

      // 吞掉整行，处理行末反斜杠接续
      let k = nameEnd;
      while (k < n) {
        if (source.charAt(k) === '\\') {
          let m = k + 1;
          if (source.charAt(m) === '\r') m++;
          if (source.charAt(m) === '\n') { k = m + 1; continue; }
        }
        if (source.charAt(k) === '\n') break;
        k++;
      }

      directives.push({
        name,
        start,
        end: k,
        line: startLine,
        endLine: offsetToLine(Math.max(start, k - 1)),
        text: source.slice(start, k),
      });

      // 指令内容对函数识别是噪音，一并遮罩掉
      maskRange(out, source, start, k);
      i = k;
      atLineStart = false;
      continue;
    }

    // ---- 普通字符 ----
    if (c === '\n') {
      atLineStart = true;
    } else if (!/[ \t\r]/.test(c)) {
      atLineStart = false;
    }
    i++;
  }

  return { masked: out.join(''), lineStarts, directives };
}

/** 偏移量 → 行号(1-based) */
export function offsetToLine(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export { isIdentStart, isIdentChar };
