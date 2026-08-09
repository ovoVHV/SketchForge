// packages/core/src/preprocess/scanner.ts
var isIdentChar = (c) => /[A-Za-z0-9_$]/.test(c);
function maskRange(out, src, start, end) {
  for (let i = start; i < end; i++) {
    out[i] = src.charAt(i) === "\n" ? "\n" : " ";
  }
}
function scan(source) {
  const n = source.length;
  const out = new Array(n);
  for (let i2 = 0; i2 < n; i2++) out[i2] = source.charAt(i2);
  const lineStarts = [0];
  for (let i2 = 0; i2 < n; i2++) {
    if (source.charAt(i2) === "\n") lineStarts.push(i2 + 1);
  }
  const offsetToLine2 = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const directives = [];
  let i = 0;
  let atLineStart = true;
  while (i < n) {
    const c = source.charAt(i);
    const c2 = source.charAt(i + 1);
    if (c === "/" && c2 === "/") {
      const start = i;
      i += 2;
      while (i < n) {
        if (source.charAt(i) === "\\") {
          let j = i + 1;
          if (source.charAt(j) === "\r") j++;
          if (source.charAt(j) === "\n") {
            i = j + 1;
            continue;
          }
        }
        if (source.charAt(i) === "\n") break;
        i++;
      }
      maskRange(out, source, start, i);
      atLineStart = false;
      continue;
    }
    if (c === "/" && c2 === "*") {
      const start = i;
      i += 2;
      while (i < n && !(source.charAt(i) === "*" && source.charAt(i + 1) === "/")) i++;
      i = Math.min(i + 2, n);
      maskRange(out, source, start, i);
      atLineStart = false;
      continue;
    }
    if (c === "R" || (c === "u" || c === "U" || c === "L") && source.charAt(i + 1) === "R" || c === "u" && c2 === "8" && source.charAt(i + 2) === "R") {
      let rPos = i;
      if (c !== "R") rPos = source.indexOf("R", i);
      const quotePos = rPos + 1;
      if (source.charAt(quotePos) === '"') {
        const prev = i > 0 ? source.charAt(i - 1) : "";
        if (!isIdentChar(prev)) {
          const delimStart = quotePos + 1;
          let d = delimStart;
          while (d < n && source.charAt(d) !== "(" && d - delimStart <= 16) d++;
          if (source.charAt(d) === "(") {
            const delim = source.slice(delimStart, d);
            const terminator = ")" + delim + '"';
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
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      while (i < n) {
        const ch = source.charAt(i);
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === quote) {
          i++;
          break;
        }
        if (ch === "\n") break;
        i++;
      }
      maskRange(out, source, start, i);
      atLineStart = false;
      continue;
    }
    if (c === "#" && atLineStart) {
      const start = i;
      const startLine = offsetToLine2(start);
      let j = i + 1;
      while (j < n && /[ \t]/.test(source.charAt(j))) j++;
      let nameEnd = j;
      while (nameEnd < n && isIdentChar(source.charAt(nameEnd))) nameEnd++;
      const name = source.slice(j, nameEnd);
      let k = nameEnd;
      while (k < n) {
        if (source.charAt(k) === "\\") {
          let m = k + 1;
          if (source.charAt(m) === "\r") m++;
          if (source.charAt(m) === "\n") {
            k = m + 1;
            continue;
          }
        }
        if (source.charAt(k) === "\n") break;
        k++;
      }
      directives.push({
        name,
        start,
        end: k,
        line: startLine,
        endLine: offsetToLine2(Math.max(start, k - 1)),
        text: source.slice(start, k)
      });
      maskRange(out, source, start, k);
      i = k;
      atLineStart = false;
      continue;
    }
    if (c === "\n") {
      atLineStart = true;
    } else if (!/[ \t\r]/.test(c)) {
      atLineStart = false;
    }
    i++;
  }
  return { masked: out.join(""), lineStarts, directives };
}
function offsetToLine(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// packages/core/src/preprocess/functions.ts
var CONTROL_KEYWORDS = /* @__PURE__ */ new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "return",
  "sizeof",
  "catch",
  "try",
  "throw",
  "new",
  "delete",
  "alignof",
  "decltype",
  "typeid",
  "static_assert",
  "noexcept",
  "and",
  "or",
  "not",
  "xor",
  "bitand",
  "bitor",
  "compl"
]);
var REJECT_IN_RETURN_TYPE = [
  "template",
  // 模板：无法可靠前置声明
  "extern",
  // extern "C"：链接规约会丢，导致链接错误
  "typedef",
  "using",
  "namespace",
  "class",
  "struct",
  "union",
  "enum",
  // 类型定义体，不是函数
  "operator",
  // 运算符重载
  "friend",
  "::",
  // 类外定义 / 限定名
  "~"
  // 析构函数
];
var TRAILING_QUALIFIERS = ["const", "volatile", "noexcept", "override", "final", "mutable"];
function matchParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked.charAt(i);
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function hasDefaultArgs(maskedParamsWithParens) {
  const inner = maskedParamsWithParens.replace(/^\s*\(/, "").replace(/\)\s*$/, "");
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charAt(i);
    if (c === "(" || c === "[" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === ">") depth--;
    else if (c === "=" && depth === 0) {
      const prev = inner.charAt(i - 1);
      const next = inner.charAt(i + 1);
      if (prev !== "=" && prev !== "!" && prev !== "<" && prev !== ">" && next !== "=") {
        return true;
      }
    }
  }
  return false;
}
function classifyAfterParams(masked, from) {
  let i = from;
  const n = masked.length;
  for (; ; ) {
    while (i < n && /\s/.test(masked.charAt(i))) i++;
    if (i >= n) return null;
    const c = masked.charAt(i);
    if (c === "{") return "definition";
    if (c === ";") return "declaration";
    if (c === "-" && masked.charAt(i + 1) === ">") return null;
    if (masked.startsWith("__attribute__", i)) {
      const open = masked.indexOf("(", i);
      if (open === -1) return null;
      const close = matchParen(masked, open);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }
    if (c === "[" && masked.charAt(i + 1) === "[") {
      const close = masked.indexOf("]]", i);
      if (close === -1) return null;
      i = close + 2;
      continue;
    }
    let word = "";
    let j = i;
    while (j < n && isIdentChar(masked.charAt(j))) {
      word += masked.charAt(j);
      j++;
    }
    if (word && TRAILING_QUALIFIERS.includes(word)) {
      i = j;
      if (word === "noexcept") {
        let k = i;
        while (k < n && /\s/.test(masked.charAt(k))) k++;
        if (masked.charAt(k) === "(") {
          const close = matchParen(masked, k);
          if (close === -1) return null;
          i = close + 1;
        }
      }
      continue;
    }
    return null;
  }
}
function findDeclStart(masked, identStart, directives) {
  let barrier = 0;
  for (const d of directives) {
    if (d.end <= identStart && d.end > barrier) barrier = d.end;
  }
  let start = barrier;
  let i = identStart - 1;
  while (i >= barrier) {
    const c = masked.charAt(i);
    if (c === ";" || c === "}" || c === "{" || c === ":") {
      start = i + 1;
      break;
    }
    i--;
  }
  while (start < identStart && /\s/.test(masked.charAt(start))) start++;
  return start;
}
function scanFunctions(source, scanned) {
  const { masked, lineStarts, directives } = scanned ?? scan(source);
  const n = masked.length;
  const functions = [];
  let braceDepth = 0;
  let insertOffset = null;
  let i = 0;
  while (i < n) {
    const c = masked.charAt(i);
    if (c === "{") {
      braceDepth++;
      i++;
      continue;
    }
    if (c === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      i++;
      continue;
    }
    if (braceDepth !== 0 || !/[A-Za-z_$]/.test(c)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && isIdentChar(masked.charAt(j))) j++;
    const ident = masked.slice(i, j);
    let k = j;
    while (k < n && /\s/.test(masked.charAt(k))) k++;
    if (masked.charAt(k) !== "(") {
      i = j;
      continue;
    }
    if (CONTROL_KEYWORDS.has(ident)) {
      i = j;
      continue;
    }
    const closeParen = matchParen(masked, k);
    if (closeParen === -1) {
      i = j;
      continue;
    }
    const kind = classifyAfterParams(masked, closeParen + 1);
    if (kind !== "definition") {
      i = j;
      continue;
    }
    const declStart = findDeclStart(masked, i, directives);
    const returnTypeRaw = source.slice(declStart, i);
    const returnTypeMasked = masked.slice(declStart, i);
    const paramsRaw = source.slice(k, closeParen + 1);
    const paramsMasked = masked.slice(k, closeParen + 1);
    if (insertOffset === null) {
      const line = offsetToLine(lineStarts, declStart);
      insertOffset = lineStarts[line - 1] ?? declStart;
    }
    const rt = returnTypeMasked.trim();
    if (!rt) {
      i = j;
      continue;
    }
    if (REJECT_IN_RETURN_TYPE.some((kw) => returnTypeMasked.includes(kw))) {
      i = j;
      continue;
    }
    if (/\bauto\s*$/.test(rt)) {
      i = j;
      continue;
    }
    if (hasDefaultArgs(paramsMasked)) {
      i = j;
      continue;
    }
    if (ident === "main") {
      i = j;
      continue;
    }
    const collapse = (s) => s.replace(/\s+/g, " ").trim();
    const prototype = `${collapse(returnTypeRaw)} ${ident}${collapse(paramsRaw)};`;
    functions.push({
      name: ident,
      returnType: collapse(returnTypeRaw),
      params: collapse(paramsRaw),
      declStart,
      line: offsetToLine(lineStarts, declStart),
      prototype
    });
    i = j;
  }
  const insertLine = insertOffset === null ? null : offsetToLine(lineStarts, insertOffset);
  return { functions, insertOffset, insertLine };
}

// packages/core/src/preprocess/index.ts
var GENERATED_FILE = "<generated>";
function escapeForLineDirective(name) {
  return name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function normalizeSource(src) {
  let s = src;
  if (s.charCodeAt(0) === 65279) s = s.slice(1);
  return s.replace(/\r\n?/g, "\n");
}
function composeArduinoSketch(files) {
  if (!files.length) throw new TypeError("Arduino sketch bundle must not be empty");
  const normalized = files.map((file) => ({
    path: file.path,
    content: normalizeSource(file.content)
  }));
  if (normalized.every((file) => file.content.trim().length === 0)) {
    return { source: "", lineOrigins: /* @__PURE__ */ new Map() };
  }
  let source = normalized[0].content;
  const lineOrigins = /* @__PURE__ */ new Map();
  addLineOrigins(lineOrigins, 1, normalized[0].path, normalized[0].content);
  for (const file of normalized.slice(1)) {
    if (source.length > 0 && !source.endsWith("\n")) source += "\n";
    const contentStartLine = countNewlines(source) + 2;
    source += `#line 1 "${escapeForLineDirective(file.path)}"
${file.content}`;
    addLineOrigins(lineOrigins, contentStartLine, file.path, file.content);
  }
  return { source, lineOrigins };
}
function composeArduinoSketchSource(files) {
  return composeArduinoSketch(files).source;
}
function addLineOrigins(origins, generatedStartLine, sourceFile, source) {
  const lineCount = source.split("\n").length;
  for (let index = 0; index < lineCount; index += 1) {
    origins.set(generatedStartLine + index, { sourceFile, sourceLine: index + 1 });
  }
}
function countNewlines(value) {
  let count = 0;
  for (const character of value) if (character === "\n") count += 1;
  return count;
}
function sourceLocationAtLine(sourceName, physicalLine, directives) {
  let anchorPhysicalLine = 1;
  let anchorLogicalLine = 1;
  let file = escapeForLineDirective(sourceName);
  for (const directive of directives) {
    if (directive.endLine >= physicalLine) break;
    if (directive.name !== "line") continue;
    const match = directive.text.match(/^\s*#\s*line\s+([0-9]+)(?:\s+"((?:\\.|[^"\\])*)")?\s*$/);
    if (!match) continue;
    const line = Number(match[1]);
    if (!Number.isSafeInteger(line) || line < 1) continue;
    anchorPhysicalLine = directive.endLine + 1;
    anchorLogicalLine = line;
    if (match[2] !== void 0) file = match[2];
  }
  return {
    file,
    line: anchorLogicalLine + (physicalLine - anchorPhysicalLine)
  };
}
function preprocess(source, opts = {}) {
  const sourceName = opts.sourceName ?? "main.ino";
  const normalized = normalizeSource(source);
  const warnings = [];
  const scanResult = scan(normalized);
  const { functions, insertLine } = scanFunctions(normalized, scanResult);
  const lines = normalized.split("\n");
  const sourceLineCount = lines.length;
  const escapedName = escapeForLineDirective(sourceName);
  const out = [];
  out.push("#include <Arduino.h>");
  out.push(`#line 1 "${escapedName}"`);
  const generatedLineToFunction = /* @__PURE__ */ new Map();
  if (normalized.trim().length === 0) {
    out.push(`#line 1 "${GENERATED_FILE}"`);
    out.push("void setup() {}");
    out.push("void loop() {}");
  } else if (functions.length === 0 || insertLine === null) {
    out.push(...lines);
    if (functions.length === 0 && normalized.trim().length > 0) {
      warnings.push("\u672A\u8BC6\u522B\u5230\u4EFB\u4F55\u9876\u5C42\u51FD\u6570\u5B9A\u4E49\uFF0C\u672A\u751F\u6210\u51FD\u6570\u539F\u578B");
    }
  } else {
    for (let i = 0; i < insertLine - 1; i++) {
      out.push(lines[i] ?? "");
    }
    out.push(`#line 1 "${GENERATED_FILE}"`);
    functions.forEach((fn, idx) => {
      out.push(fn.prototype);
      generatedLineToFunction.set(idx + 1, fn);
    });
    const location = sourceLocationAtLine(sourceName, insertLine, scanResult.directives);
    out.push(`#line ${location.line} "${location.file}"`);
    for (let i = insertLine - 1; i < lines.length; i++) {
      out.push(lines[i] ?? "");
    }
  }
  return {
    cpp: out.join("\n") + "\n",
    sourceName,
    normalizedSource: normalized,
    sourceLineCount,
    functions,
    generatedLineToFunction,
    warnings,
    scanResult
  };
}
export {
  GENERATED_FILE,
  composeArduinoSketch,
  composeArduinoSketchSource,
  normalizeSource,
  preprocess,
  scan,
  scanFunctions
};
