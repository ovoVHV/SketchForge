/**
 * 库导入的安全闸门。
 *
 * ## 设计原则：硬闸门只做确定性判断
 *
 * 这里的每一条**硬拒**都是查事实（文件在不在、字段等于什么），
 * 不是"看起来像不像恶意"。启发式判断放在另一个函数里，只产出**报告**，
 * 供人工终审参考，绝不用来自动拒绝 —— 因为静态分析任意 C++ 的恶意性
 * 本来就做不到（`.incbin` 用宏一拼就绕过了，这在沙箱验证里实测过）。
 *
 * 换句话说：
 *   · 服务器安全 → **沙箱**负责，已实测 11/11 拦截
 *   · 编译期 RCE → **硬闸门**负责，确定性，见下
 *   · "这库是不是好东西" → **人工/AI 策展**负责，不在本文件职责内
 */

import { readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, extname, basename, relative, sep } from 'node:path';
import { parseManifest, type LibraryManifest } from '../toolchain/library.js';

// ---------------------------------------------------------------------------
// 硬闸门
// ---------------------------------------------------------------------------

/**
 * 出现即拒。
 *
 * Arduino 的平台规范允许 platform.txt 里写：
 *     recipe.hooks.sketch.prebuild.1.pattern=<任意命令>
 *     recipe.hooks.sketch.prebuild.1.use_shell_execute=true
 * 这是**设计上就允许执行任意 shell 命令**的。一个"库"如果携带了这些文件，
 * 等价于在我们的构建机上拿到了代码执行权。
 *
 * 这条检查是查文件名，不是猜内容，因此 100% 可靠 —— 也正因如此，
 * 它必须是硬拒而不是警告。
 */
const FORBIDDEN_FILENAMES = [
  'platform.txt',
  'platform.local.txt',
  'boards.txt',
  'boards.local.txt',
  'programmers.txt',
  'programmers.local.txt',
];

/** 可执行文件/脚本，库里没有任何正当理由携带 */
const FORBIDDEN_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.ps1', '.sh', '.msi', '.scr', '.com',
]);

export interface GateRejection {
  code: string;
  message: string;
  path?: string;
}

export interface HardGateResult {
  ok: boolean;
  rejections: GateRejection[];
  manifest?: LibraryManifest;
  /** 库根目录（可能是解压根，也可能是其下唯一的子目录） */
  libraryRoot?: string;
}

/** 递归列出所有文件的相对路径（POSIX 分隔符） */
function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(root, p, out);
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

/**
 * 定位真正的库根目录。
 * 有些仓库把库放在子目录里（例如仓库根有 README + `MyLib/library.properties`）。
 */
function findLibraryRoot(dir: string): string | null {
  if (existsSync(join(dir, 'library.properties'))) return dir;
  const subdirs = readdirSync(dir).filter((e) => {
    try { return statSync(join(dir, e)).isDirectory(); } catch { return false; }
  });
  const matches = subdirs.filter((d) => existsSync(join(dir, d, 'library.properties')));
  return matches.length === 1 ? join(dir, matches[0]!) : null;
}

export function runHardGates(extractedDir: string): HardGateResult {
  const rejections: GateRejection[] = [];

  // ---- ① 构建系统文件 = 编译期 RCE，出现即拒 ----
  //
  // 刻意扫**整个解压树**，而不只是检测到的库根目录。
  // 反例：仓库根有 platform.txt、子目录里才是 MyLib/library.properties。
  // 只扫库根的话这个 platform.txt 就漏了。当前流程下它确实不会被入库
  // （只有库根会被移走），但安全属性不该建立在"下游恰好没搬它"之上。
  const allFiles = walk(extractedDir);
  for (const f of allFiles) {
    if (FORBIDDEN_FILENAMES.includes(basename(f).toLowerCase())) {
      rejections.push({
        code: 'build_system_file',
        message:
          `包含构建系统文件 \`${basename(f)}\`。Arduino 的构建钩子可以执行任意 shell 命令，` +
          `等同于远程代码执行，本平台一律不接受。`,
        path: f,
      });
    }
    if (FORBIDDEN_EXTENSIONS.has(extname(f).toLowerCase())) {
      rejections.push({
        code: 'executable_file',
        message: `包含可执行文件或脚本 \`${basename(f)}\`。`,
        path: f,
      });
    }
  }

  const libraryRoot = findLibraryRoot(extractedDir);
  if (!libraryRoot) {
    rejections.push({
      code: 'no_manifest',
      message: '仓库里找不到 library.properties —— 这不是一个标准 Arduino 库。',
    });
    return { ok: false, rejections };
  }

  const files = walk(libraryRoot);

  // ---- ③ 清单校验 ----
  let manifest: LibraryManifest | undefined;
  try {
    manifest = parseManifest(readFileSync(join(libraryRoot, 'library.properties'), 'utf8'));
  } catch {
    rejections.push({ code: 'bad_manifest', message: 'library.properties 无法解析。' });
  }

  if (manifest) {
    if (!manifest.name) {
      rejections.push({ code: 'bad_manifest', message: 'library.properties 缺少 name 字段。' });
    }
    if (!/^\d+\.\d+/.test(manifest.version)) {
      rejections.push({
        code: 'bad_version',
        message: `版本号 \`${manifest.version}\` 不合法，需形如 1.2.3。`,
      });
    }
    // precompiled=true 意味着核心逻辑是二进制，源码审计无从谈起。
    // 我们的整个信任模型建立在"能看到源码"之上，所以必须拒。
    if (manifest.precompiled) {
      rejections.push({
        code: 'precompiled',
        message:
          '清单声明 precompiled，库主体是预编译二进制而非源码。' +
          '无法审计的二进制不接受。',
      });
    }
  }

  // ---- ④ 至少得有点能用的东西 ----
  const hasCode = files.some((f) =>
    ['.h', '.hpp', '.c', '.cpp', '.cc', '.cxx', '.S'].includes(extname(f).toLowerCase()),
  );
  if (!hasCode) {
    rejections.push({ code: 'no_sources', message: '库里没有任何头文件或源文件。' });
  }

  return {
    ok: rejections.length === 0,
    rejections,
    ...(manifest ? { manifest } : {}),
    libraryRoot,
  };
}

// ---------------------------------------------------------------------------
// 审核报告（只提示，不自动拒绝）
// ---------------------------------------------------------------------------

export type ReviewSeverity = 'high' | 'medium' | 'low';

export interface ReviewFinding {
  severity: ReviewSeverity;
  rule: string;
  message: string;
  path: string;
  line?: number;
  /** 命中的那行原文，便于人工快速判断 */
  excerpt?: string;
}

interface ScanRule {
  re: RegExp;
  severity: ReviewSeverity;
  rule: string;
  message: string;
}

/**
 * 这些**不是**自动拒绝条件。
 *
 * 它们全都能被绕过（宏拼接、字符串拼接、编码），所以当成安全边界是自欺欺人。
 * 真正的边界是沙箱。这里的价值在于：把人工审核时最该看的几十行**挑出来**，
 * 让你不必通读整个库。
 */
const SCAN_RULES: ScanRule[] = [
  { re: /\.incbin\b/i, severity: 'high', rule: 'asm.incbin',
    message: '内联汇编 .incbin 可把服务端任意文件嵌入编译产物' },
  { re: /\.include\b/i, severity: 'high', rule: 'asm.include',
    message: '汇编 .include 可读取服务端任意文件' },
  { re: /\bsystem\s*\(/, severity: 'high', rule: 'exec.system',
    message: '调用 system()' },
  { re: /\b(popen|execl|execv|execve|fork)\s*\(/, severity: 'high', rule: 'exec.process',
    message: '进程创建/执行相关调用' },
  { re: /#\s*include\s*[<"](?:[A-Za-z]:)?[\\/]/, severity: 'high', rule: 'include.absolute',
    message: '用绝对路径 include' },
  { re: /#\s*include\s*[<"][^>"]*\.\.[\\/]/, severity: 'medium', rule: 'include.traversal',
    message: 'include 路径含 `..`' },
  { re: /\b__has_include\b/, severity: 'low', rule: 'probe.has_include',
    message: '用 __has_include 探测文件是否存在' },
  { re: /\basm\s*(?:volatile\s*)?\(/, severity: 'low', rule: 'asm.inline',
    message: '使用内联汇编（AVR 库中常见且正常，仅供留意）' },
];

const TEXT_EXT = new Set([
  '.h', '.hpp', '.hh', '.hxx', '.c', '.cpp', '.cc', '.cxx', '.S', '.s',
  '.ino', '.txt', '.properties', '.md', '.json',
]);
const MAX_SCAN_FILE_BYTES = 1024 * 1024;

export interface ReviewReport {
  findings: ReviewFinding[];
  /** 非文本文件清单，人工需要留意 */
  binaryFiles: string[];
  fileCount: number;
  totalBytes: number;
}

export function scanForReview(libraryRoot: string): ReviewReport {
  const findings: ReviewFinding[] = [];
  const binaryFiles: string[] = [];
  let totalBytes = 0;

  const files = walk(libraryRoot);
  for (const rel of files) {
    const full = join(libraryRoot, rel);
    let st;
    try { st = statSync(full); } catch { continue; }
    totalBytes += st.size;

    if (!TEXT_EXT.has(extname(rel).toLowerCase())) {
      binaryFiles.push(rel);
      continue;
    }
    if (st.size > MAX_SCAN_FILE_BYTES) continue;

    let text: string;
    try { text = readFileSync(full, 'utf8'); } catch { continue; }

    const lines = text.split(/\r?\n/);
    for (const rule of SCAN_RULES) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!rule.re.test(line)) continue;
        findings.push({
          severity: rule.severity,
          rule: rule.rule,
          message: rule.message,
          path: rel,
          line: i + 1,
          excerpt: line.trim().slice(0, 200),
        });
        break; // 同一规则同一文件只报一次，避免刷屏
      }
    }
  }

  const order: Record<ReviewSeverity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path));

  return { findings, binaryFiles, fileCount: files.length, totalBytes };
}

// ---------------------------------------------------------------------------
// 白名单式裁剪
// ---------------------------------------------------------------------------

/** 允许保留的扩展名 */
const KEEP_EXT = new Set([
  '.h', '.hpp', '.hh', '.hxx', '.inc',
  '.c', '.cpp', '.cc', '.cxx', '.S', '.s',
  '.ino', '.pde',           // examples，编译时不参与，但 AI 生成积木元数据时有用
  '.txt', '.properties', '.md', '.json',
]);
/** 无扩展名也保留的文件（LICENSE、COPYING 之类） */
const KEEP_BASENAMES = new Set(['license', 'licence', 'copying', 'notice', 'authors', 'readme']);

export interface SanitizeResult {
  removed: string[];
  kept: number;
}

/**
 * 白名单式裁剪：**不在名单上的一律删掉**，而不是"黑名单里的删掉"。
 *
 * 黑名单永远追不上新的花样；白名单只需要回答"我们确实需要什么"，
 * 而库真正需要的东西就那么几类。
 */
export function sanitizeTree(libraryRoot: string): SanitizeResult {
  const removed: string[] = [];
  let kept = 0;

  for (const rel of walk(libraryRoot)) {
    const ext = extname(rel).toLowerCase();
    const base = basename(rel, ext).toLowerCase();
    const keep = KEEP_EXT.has(ext) || (ext === '' && KEEP_BASENAMES.has(base));
    if (keep) { kept++; continue; }
    try {
      rmSync(join(libraryRoot, rel), { force: true });
      removed.push(rel);
    } catch { /* 尽力而为 */ }
  }

  return { removed, kept };
}
