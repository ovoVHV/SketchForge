/**
 * 安全解包。
 *
 * **不使用 tar 的自动解压功能**，而是自己逐条目校验、自己写盘。
 * 理由：把"要不要落这个文件"的决定权留在自己手里，是防御的关键。
 * 交给库去 extract，就等于把安全边界外包给别人的默认配置。
 *
 * 拦截的威胁（每条都对应下面一个具体检查）：
 *   · tar slip —— 条目路径写成 `../../etc/cron.d/x`，解压时逃出目标目录
 *   · 绝对路径 —— `/etc/passwd`，同上
 *   · 符号链接 / 硬链接 —— 指向 `/etc/shadow`，后续读取时把宿主文件读出来；
 *     Windows 上还可能是目录联接。**一律拒绝，不区分指向哪里**
 *   · 特殊文件 —— 字符/块设备、FIFO、socket，没有任何正当理由出现在库里
 *   · 解压炸弹 —— 几十 KB 的包解出几十 GB；靠总量 + 文件数 + 压缩比三重限制
 *   · 超长路径 —— 打爆文件系统限制
 */

import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { Parser } from 'tar';

export interface ExtractLimits {
  /** 解压后总字节数上限 */
  maxTotalBytes: number;
  /** 文件数量上限 */
  maxFiles: number;
  /** 单文件字节数上限 */
  maxFileBytes: number;
  /** 压缩比上限（解压后 / 压缩包），超过判定为炸弹 */
  maxRatio: number;
  /** 路径深度上限 */
  maxDepth: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxTotalBytes: 100 * 1024 * 1024,
  maxFiles: 5000,
  maxFileBytes: 16 * 1024 * 1024,
  maxRatio: 200,
  maxDepth: 16,
};

export class ExtractError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

export interface ExtractResult {
  /** 实际落盘的文件相对路径（POSIX 分隔符） */
  files: string[];
  totalBytes: number;
  /** 被跳过的条目及原因，用于生成审核报告 */
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * 校验并归一化条目路径。
 * 返回归一化后的相对路径；不安全则抛错。
 *
 * @param stripComponents GitHub 的 tarball 顶层多包一层 `repo-sha/`，剥掉它
 */
export function safeEntryPath(raw: string, stripComponents: number, maxDepth: number): string {
  // tar 里一律用 /，但恶意包可能塞反斜杠试图在 Windows 上逃逸
  const unified = raw.replace(/\\/g, '/');

  if (unified.includes('\0')) {
    throw new ExtractError(`条目路径含空字节：${raw}`, 'null_byte');
  }
  // 绝对路径（Unix 与 Windows 盘符两种写法）
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    throw new ExtractError(`条目使用了绝对路径：${raw}`, 'absolute_path');
  }
  // UNC 路径
  if (unified.startsWith('//')) {
    throw new ExtractError(`条目使用了 UNC 路径：${raw}`, 'unc_path');
  }

  const segments = unified.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) {
    throw new ExtractError(`条目路径试图向上穿越：${raw}`, 'path_traversal');
  }

  const stripped = segments.slice(stripComponents);
  if (stripped.length === 0) return '';
  if (stripped.length > maxDepth) {
    throw new ExtractError(`条目路径过深（${stripped.length} 层）：${raw}`, 'too_deep');
  }
  for (const s of stripped) {
    if (s.length > 255) throw new ExtractError(`路径片段过长：${raw}`, 'segment_too_long');
  }

  const rel = stripped.join('/');

  // 双保险：归一化之后再确认一次没有跑出去。
  // 上面的逐段检查已经够了，但这一步几乎零成本，且能挡住某些平台特有的怪写法。
  const normalized = normalize(rel);
  if (normalized.startsWith('..') || normalized.split(sep).includes('..')) {
    throw new ExtractError(`条目路径归一化后仍越界：${raw}`, 'path_traversal');
  }

  return rel;
}

/**
 * 解压 tar.gz 到目标目录。
 *
 * @param stripComponents 剥掉的顶层目录数。GitHub tarball 传 1。
 */
export async function extractTarGz(
  archive: Buffer,
  destDir: string,
  stripComponents = 1,
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS,
): Promise<ExtractResult> {
  const files: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let totalBytes = 0;

  mkdirSync(destDir, { recursive: true });

  const parser = new Parser();
  let fatal: Error | null = null;

  parser.on('entry', (entry) => {
    // 出过错就把剩下的条目全部排空，别再落盘
    if (fatal) { entry.resume(); return; }

    try {
      const type = String(entry.type);

      // ---- 链接类一律拒绝 ----
      // 不判断"指向哪里"：判断链接目标是经典的 TOCTOU 漏洞源头，
      // 而库里本来就没有任何正当理由需要符号链接。
      if (type === 'SymbolicLink' || type === 'Link') {
        throw new ExtractError(`包内含链接文件（${type}）：${entry.path}`, 'link_entry');
      }
      // ---- 特殊文件一律拒绝 ----
      if (type === 'CharacterDevice' || type === 'BlockDevice' || type === 'FIFO') {
        throw new ExtractError(`包内含特殊文件（${type}）：${entry.path}`, 'special_file');
      }

      const rel = safeEntryPath(String(entry.path), stripComponents, limits.maxDepth);

      if (type === 'Directory') {
        if (rel) mkdirSync(join(destDir, rel), { recursive: true });
        entry.resume();
        return;
      }
      if (type !== 'File' && type !== 'OldFile' && type !== 'ContiguousFile') {
        skipped.push({ path: String(entry.path), reason: `不支持的条目类型 ${type}` });
        entry.resume();
        return;
      }
      if (!rel) { entry.resume(); return; }

      // ---- 数量与体积闸门 ----
      if (files.length >= limits.maxFiles) {
        throw new ExtractError(`文件数超过 ${limits.maxFiles} 上限`, 'too_many_files');
      }
      const declaredSize = Number(entry.size ?? 0);
      if (declaredSize > limits.maxFileBytes) {
        throw new ExtractError(
          `单个文件超过 ${limits.maxFileBytes / 1024 / 1024} MB：${entry.path}`,
          'file_too_large',
        );
      }

      const chunks: Buffer[] = [];
      let size = 0;

      entry.on('data', (c: Buffer) => {
        if (fatal) return;
        size += c.length;
        totalBytes += c.length;
        // 声明的 size 可以撒谎，所以按实际读到的字节数判定
        if (size > limits.maxFileBytes) {
          fatal = new ExtractError(`文件超过单文件上限：${entry.path}`, 'file_too_large');
          return;
        }
        if (totalBytes > limits.maxTotalBytes) {
          fatal = new ExtractError(
            `解压后总体积超过 ${limits.maxTotalBytes / 1024 / 1024} MB`,
            'bomb_total',
          );
          return;
        }
        if (totalBytes / Math.max(1, archive.length) > limits.maxRatio) {
          fatal = new ExtractError(
            `压缩比超过 ${limits.maxRatio}:1，判定为解压炸弹`,
            'bomb_ratio',
          );
          return;
        }
        chunks.push(c);
      });

      entry.on('end', () => {
        if (fatal) return;
        const full = join(destDir, rel);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, Buffer.concat(chunks));
        files.push(rel);
      });
    } catch (err) {
      fatal = err as Error;
      entry.resume();
    }
  });

  await pipeline(Readable.from(archive), createGunzip(), parser);

  if (fatal) throw fatal;
  return { files, totalBytes, skipped };
}
