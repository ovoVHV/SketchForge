/**
 * 顶层函数定义识别 —— 用于自动生成函数原型。
 *
 * 这是启发式扫描，不是完整的 C++ 解析（那需要 clang）。因此贯彻一条铁律：
 *
 *      **吃不准就跳过。**
 *
 * 漏生成一个原型，最坏结果是用户得自己写一行声明（和标准 C++ 行为一致）；
 * 错生成一个原型，会把本来能编译的代码变成编译不过 —— 后者严重得多。
 * 所有 `return null` / `continue` 的分支都是这条铁律的体现。
 */

import { scan, offsetToLine, isIdentChar, type Directive, type ScanResult } from './scanner.js';

export interface FunctionDef {
  name: string;
  returnType: string;
  params: string;
  /** 声明起始偏移（返回类型的第一个字符） */
  declStart: number;
  /** 定义所在行，1-based。生成原型报错时回溯到这里 */
  line: number;
  /** 生成的原型，**保证是单行**（含分号）——行映射依赖这个前提 */
  prototype: string;
}

export interface ScanFunctionsResult {
  functions: FunctionDef[];
  /** 原型插入点的偏移（第一个函数定义所在行的行首）；无函数时为 null */
  insertOffset: number | null;
  /** 插入点对应的行号，1-based */
  insertLine: number | null;
}

/** 不可能是函数名的关键字 */
const CONTROL_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'return', 'sizeof', 'catch', 'try', 'throw', 'new', 'delete',
  'alignof', 'decltype', 'typeid', 'static_assert', 'noexcept',
  'and', 'or', 'not', 'xor', 'bitand', 'bitor', 'compl',
]);

/** 出现在返回类型里就说明我们处理不了，直接跳过 */
const REJECT_IN_RETURN_TYPE = [
  'template',  // 模板：无法可靠前置声明
  'extern',    // extern "C"：链接规约会丢，导致链接错误
  'typedef',
  'using',
  'namespace',
  'class', 'struct', 'union', 'enum',  // 类型定义体，不是函数
  'operator',  // 运算符重载
  'friend',
  '::',        // 类外定义 / 限定名
  '~',         // 析构函数
];

/** ')' 之后允许出现、且不影响原型的限定符 */
const TRAILING_QUALIFIERS = ['const', 'volatile', 'noexcept', 'override', 'final', 'mutable'];

/**
 * 从 `open` 位置的 '(' 出发找到配对的 ')'。找不到返回 -1。
 */
function matchParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked.charAt(i);
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 检查参数列表里是否有顶层的 '='（默认参数）。
 *
 * 有默认参数的函数一律不生成原型：
 * 若原型和定义都写默认值，C++ 报 "default argument given ... after previous
 * specification"；若原型剥掉默认值，定义之前的省参调用又会失败。
 * 两害相权，不生成 —— 退化成标准 C++ 行为，用户自己加声明即可。
 */
function hasDefaultArgs(maskedParamsWithParens: string): boolean {
  // 传进来的串含最外层圆括号，先剥掉，否则顶层 '=' 会被算成 depth 1 而漏判
  const inner = maskedParamsWithParens.replace(/^\s*\(/, '').replace(/\)\s*$/, '');
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charAt(i);
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '>') depth--;
    else if (c === '=' && depth === 0) {
      // 排除 '==' '>=' '<=' '!=' 这类比较运算符（默认值里可能出现）
      const prev = inner.charAt(i - 1);
      const next = inner.charAt(i + 1);
      if (prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>' && next !== '=') {
        return true;
      }
    }
  }
  return false;
}

/**
 * 从 ')' 之后开始判断这是不是一个函数**定义**。
 * @returns 'definition' | 'declaration' | null(处理不了)
 */
function classifyAfterParams(masked: string, from: number): 'definition' | 'declaration' | null {
  let i = from;
  const n = masked.length;

  for (;;) {
    while (i < n && /\s/.test(masked.charAt(i))) i++;
    if (i >= n) return null;

    const c = masked.charAt(i);
    if (c === '{') return 'definition';
    if (c === ';') return 'declaration';

    // 尾置返回类型 `-> T`：返回类型是 auto，无法可靠生成原型
    if (c === '-' && masked.charAt(i + 1) === '>') return null;

    // __attribute__((...)) / [[...]]
    if (masked.startsWith('__attribute__', i)) {
      const open = masked.indexOf('(', i);
      if (open === -1) return null;
      const close = matchParen(masked, open);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }
    if (c === '[' && masked.charAt(i + 1) === '[') {
      const close = masked.indexOf(']]', i);
      if (close === -1) return null;
      i = close + 2;
      continue;
    }

    // 普通限定符
    let word = '';
    let j = i;
    while (j < n && isIdentChar(masked.charAt(j))) { word += masked.charAt(j); j++; }
    if (word && TRAILING_QUALIFIERS.includes(word)) {
      i = j;
      // noexcept(expr) 形式
      if (word === 'noexcept') {
        let k = i;
        while (k < n && /\s/.test(masked.charAt(k))) k++;
        if (masked.charAt(k) === '(') {
          const close = matchParen(masked, k);
          if (close === -1) return null;
          i = close + 1;
        }
      }
      continue;
    }

    // 认不出来的东西 —— 按铁律跳过
    return null;
  }
}

/**
 * 向前回溯，找到这条声明的起始位置（返回类型的第一个字符）。
 *
 * 屏障：';' '}' '{' 、文件开头、以及**最近一条预处理指令的结尾**。
 * 最后这个屏障很关键 —— 指令在 masked 里已被遮罩成空白，
 * 不设屏障的话回溯会一路穿过 `#include` 滑到更早的代码里去。
 */
function findDeclStart(masked: string, identStart: number, directives: Directive[]): number {
  let barrier = 0;
  for (const d of directives) {
    if (d.end <= identStart && d.end > barrier) barrier = d.end;
  }

  let start = barrier;
  let i = identStart - 1;
  while (i >= barrier) {
    const c = masked.charAt(i);
    if (c === ';' || c === '}' || c === '{' || c === ':') { start = i + 1; break; }
    i--;
  }

  // 跳过分隔符之后的空白，落到返回类型的第一个实际字符上。
  // 少了这一步，declStart 会停在换行符上，函数行号会被算到上一行去。
  while (start < identStart && /\s/.test(masked.charAt(start))) start++;
  return start;
}

export function scanFunctions(source: string, scanned?: ScanResult): ScanFunctionsResult {
  const { masked, lineStarts, directives } = scanned ?? scan(source);
  const n = masked.length;
  const functions: FunctionDef[] = [];

  let braceDepth = 0;
  let insertOffset: number | null = null;

  let i = 0;
  while (i < n) {
    const c = masked.charAt(i);

    if (c === '{') { braceDepth++; i++; continue; }
    if (c === '}') { braceDepth = Math.max(0, braceDepth - 1); i++; continue; }

    // 只认顶层（depth 0）的函数。
    // namespace / extern "C" / class 体内的函数会落在 depth > 0，
    // 给它们在文件顶部生成原型是错的（作用域不对），因此不碰。
    if (braceDepth !== 0 || !/[A-Za-z_$]/.test(c)) { i++; continue; }

    // 读一个标识符
    let j = i;
    while (j < n && isIdentChar(masked.charAt(j))) j++;
    const ident = masked.slice(i, j);

    // 标识符后面必须紧跟 '('
    let k = j;
    while (k < n && /\s/.test(masked.charAt(k))) k++;
    if (masked.charAt(k) !== '(') { i = j; continue; }

    if (CONTROL_KEYWORDS.has(ident)) { i = j; continue; }

    const closeParen = matchParen(masked, k);
    if (closeParen === -1) { i = j; continue; }

    const kind = classifyAfterParams(masked, closeParen + 1);
    if (kind !== 'definition') { i = j; continue; }

    // —— 确认是函数定义，开始提取 ——
    const declStart = findDeclStart(masked, i, directives);
    const returnTypeRaw = source.slice(declStart, i);
    const returnTypeMasked = masked.slice(declStart, i);
    const paramsRaw = source.slice(k, closeParen + 1);
    const paramsMasked = masked.slice(k, closeParen + 1);

    // 记录插入点（第一个函数定义所在行的行首）
    if (insertOffset === null) {
      const line = offsetToLine(lineStarts, declStart);
      insertOffset = lineStarts[line - 1] ?? declStart;
    }

    const rt = returnTypeMasked.trim();

    // ---- 逐条否决 ----
    if (!rt) { i = j; continue; }                                    // 构造函数 / 宏展开
    if (REJECT_IN_RETURN_TYPE.some((kw) => returnTypeMasked.includes(kw))) { i = j; continue; }
    if (/\bauto\s*$/.test(rt)) { i = j; continue; }                  // 尾置返回类型
    if (hasDefaultArgs(paramsMasked)) { i = j; continue; }           // 默认参数（见 hasDefaultArgs 注释）
    if (ident === 'main') { i = j; continue; }

    // 原型必须压成单行 —— 行映射依赖"1 个原型 = 1 行"这个前提
    const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
    const prototype = `${collapse(returnTypeRaw)} ${ident}${collapse(paramsRaw)};`;

    functions.push({
      name: ident,
      returnType: collapse(returnTypeRaw),
      params: collapse(paramsRaw),
      declStart,
      line: offsetToLine(lineStarts, declStart),
      prototype,
    });

    i = j;
  }

  const insertLine = insertOffset === null ? null : offsetToLine(lineStarts, insertOffset);
  return { functions, insertOffset, insertLine };
}
