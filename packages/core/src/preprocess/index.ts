/**
 * .ino → .cpp 预处理 + 行号映射。
 *
 * 输出布局（cpp 行号 → 含义）：
 *
 *   1  | #include <Arduino.h>
 *   2  | #line 1 "main.ino"
 *   3+ | 用户第 1..P-1 行                      ← #line 让编译器直接报 .ino 行号
 *      | #line 1 "<generated>"                ← 关键：生成代码用独立伪文件名
 *      | void foo();                          ← <generated>:1
 *      | void bar();                          ← <generated>:2
 *      | #line <logical-line> "<active-file>"
 *      | 插入点之后的用户代码（恢复组合源码当时的文件/行号上下文）
 *
 * 为什么给生成代码单独一个伪文件名：
 * 如果沿用 "main.ino"，编译器报在自动生成原型上的错会带一个**看似合法**的
 * 用户行号，指向一段用户根本没写过的代码 —— 这正是 Arduino IDE 长期被诟病
 * 的行号错位问题。用 `<generated>` 隔开后，这类诊断能被明确识别出来，
 * 再回溯到对应函数定义的真实位置。
 */

import { scan, type ScanResult } from './scanner.js';
import { scanFunctions, type FunctionDef } from './functions.js';

export const GENERATED_FILE = '<generated>';

export interface PreprocessOptions {
  /** 用户源文件名，会写进 #line 指令并回填到诊断的 file 字段 */
  sourceName?: string;
}

export interface PreprocessResult {
  cpp: string;
  /** 用户源文件名 */
  sourceName: string;
  /** 归一化后的用户源码（CRLF→LF、去 BOM），行号以它为准 */
  normalizedSource: string;
  /** 用户源码总行数，用于校验诊断行号是否越界 */
  sourceLineCount: number;
  /** 识别到的顶层函数 */
  functions: FunctionDef[];
  /** <generated> 内的行号(1-based) → 该原型对应的函数 */
  generatedLineToFunction: Map<number, FunctionDef>;
  warnings: string[];
  /** 复用的词法扫描结果，避免下游重复扫描 */
  scanResult: ScanResult;
}

/** `#line` 指令里的文件名必须能安全地放进双引号 */
function escapeForLineDirective(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 归一化源码：去 BOM、CRLF/CR → LF。
 * 行号在归一化前后完全一致（只是行尾字符变了），所以对外契约不受影响。
 */
export function normalizeSource(src: string): string {
  let s = src;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n?/g, '\n');
}

export interface ArduinoSketchSource {
  path: string;
  content: string;
}

export interface ArduinoSketchLineOrigin {
  sourceFile: string;
  sourceLine: number;
}

export interface ArduinoSketchComposition {
  source: string;
  lineOrigins: Map<number, ArduinoSketchLineOrigin>;
}

/** Concatenate an already ordered Arduino sketch bundle without losing tab locations. */
export function composeArduinoSketch(files: readonly ArduinoSketchSource[]): ArduinoSketchComposition {
  if (!files.length) throw new TypeError('Arduino sketch bundle must not be empty');
  const normalized = files.map((file) => ({
    path: file.path,
    content: normalizeSource(file.content),
  }));
  if (normalized.every((file) => file.content.trim().length === 0)) {
    return { source: '', lineOrigins: new Map() };
  }

  let source = normalized[0]!.content;
  const lineOrigins = new Map<number, ArduinoSketchLineOrigin>();
  addLineOrigins(lineOrigins, 1, normalized[0]!.path, normalized[0]!.content);
  for (const file of normalized.slice(1)) {
    if (source.length > 0 && !source.endsWith('\n')) source += '\n';
    const contentStartLine = countNewlines(source) + 2;
    source += `#line 1 "${escapeForLineDirective(file.path)}"\n${file.content}`;
    addLineOrigins(lineOrigins, contentStartLine, file.path, file.content);
  }
  return { source, lineOrigins };
}

export function composeArduinoSketchSource(files: readonly ArduinoSketchSource[]): string {
  return composeArduinoSketch(files).source;
}

function addLineOrigins(
  origins: Map<number, ArduinoSketchLineOrigin>,
  generatedStartLine: number,
  sourceFile: string,
  source: string,
): void {
  const lineCount = source.split('\n').length;
  for (let index = 0; index < lineCount; index += 1) {
    origins.set(generatedStartLine + index, { sourceFile, sourceLine: index + 1 });
  }
}

function countNewlines(value: string): number {
  let count = 0;
  for (const character of value) if (character === '\n') count += 1;
  return count;
}

interface SourceLocation {
  /** Escaped filename spelling suitable for a `#line` directive. */
  file: string;
  /** Logical line assigned to the physical insertion line. */
  line: number;
}

/**
 * Find the logical source location that is active at a physical source line.
 * Multi-tab composition uses `#line` markers between tabs; restoring the
 * original source name here is what keeps diagnostics after generated
 * prototypes attached to the correct tab.
 */
function sourceLocationAtLine(
  sourceName: string,
  physicalLine: number,
  directives: ScanResult['directives'],
): SourceLocation {
  let anchorPhysicalLine = 1;
  let anchorLogicalLine = 1;
  let file = escapeForLineDirective(sourceName);

  for (const directive of directives) {
    if (directive.endLine >= physicalLine) break;
    if (directive.name !== 'line') continue;
    const match = directive.text.match(/^\s*#\s*line\s+([0-9]+)(?:\s+"((?:\\.|[^"\\])*)")?\s*$/);
    if (!match) continue;
    const line = Number(match[1]);
    if (!Number.isSafeInteger(line) || line < 1) continue;
    anchorPhysicalLine = directive.endLine + 1;
    anchorLogicalLine = line;
    if (match[2] !== undefined) file = match[2];
  }

  return {
    file,
    line: anchorLogicalLine + (physicalLine - anchorPhysicalLine),
  };
}

export function preprocess(source: string, opts: PreprocessOptions = {}): PreprocessResult {
  const sourceName = opts.sourceName ?? 'main.ino';
  const normalized = normalizeSource(source);
  const warnings: string[] = [];

  const scanResult = scan(normalized);
  const { functions, insertLine } = scanFunctions(normalized, scanResult);

  const lines = normalized.split('\n');
  const sourceLineCount = lines.length;

  const escapedName = escapeForLineDirective(sourceName);
  const out: string[] = [];

  out.push('#include <Arduino.h>');
  out.push(`#line 1 "${escapedName}"`);

  const generatedLineToFunction = new Map<number, FunctionDef>();

  if (normalized.trim().length === 0) {
    // An empty editor is a valid starter project in CK. Arduino's core still
    // links against setup()/loop(), so provide inert generated definitions
    // without changing the project snapshot or pretending they are user code.
    out.push(`#line 1 "${GENERATED_FILE}"`);
    out.push('void setup() {}');
    out.push('void loop() {}');
  } else if (functions.length === 0 || insertLine === null) {
    // 没有可生成原型的函数，原样输出
    out.push(...lines);
    if (functions.length === 0 && normalized.trim().length > 0) {
      warnings.push('未识别到任何顶层函数定义，未生成函数原型');
    }
  } else {
    // 插入点之前的用户代码
    for (let i = 0; i < insertLine - 1; i++) {
      out.push(lines[i] ?? '');
    }

    // 生成的原型块 —— 用独立伪文件名隔离
    out.push(`#line 1 "${GENERATED_FILE}"`);
    functions.forEach((fn, idx) => {
      out.push(fn.prototype);
      generatedLineToFunction.set(idx + 1, fn);
    });

    // 切回插入点原本所在的文件。组合多个 .ino 时，插入点可能已经
    // 越过了某个 tab 的 #line 标记，不能无条件切回主文件。
    const location = sourceLocationAtLine(sourceName, insertLine, scanResult.directives);
    out.push(`#line ${location.line} "${location.file}"`);
    for (let i = insertLine - 1; i < lines.length; i++) {
      out.push(lines[i] ?? '');
    }
  }

  return {
    cpp: out.join('\n') + '\n',
    sourceName,
    normalizedSource: normalized,
    sourceLineCount,
    functions,
    generatedLineToFunction,
    warnings,
    scanResult,
  };
}

export { scanFunctions, type FunctionDef } from './functions.js';
export { scan, type ScanResult } from './scanner.js';
