/**
 * 库导入流水线编排。
 *
 *   取包 → 安全解包 → 硬闸门 → 白名单裁剪 → 试编译 → 入库
 *
 * 每一步的失败都要能说清"卡在哪、为什么"，因为这份结果会直接呈给人看：
 * 自动通过的进公共池；报告里有 high 级发现的，由人决定要不要提拔进精选池。
 *
 * 试编译做成**注入的回调**，避免本模块反向依赖 compile.ts 造成循环依赖。
 * 顺带的好处：试编译产出的 `.a` 会直接落进 L1 缓存 ——
 * **审核动作本身就是预编译动作**，用户第一次用到该库时已经是热的。
 */

import { mkdtempSync, rmSync, renameSync, existsSync, cpSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

import { fetchLibraryArchive, LibraryFetchError } from './fetch.js';
import { extractTarGz, ExtractError, DEFAULT_EXTRACT_LIMITS, type ExtractLimits } from './extract.js';
import { runHardGates, scanForReview, sanitizeTree, type GateRejection, type ReviewReport } from './gates.js';
import { LibraryStore, type StoredLibrary } from './store.js';
import { loadLibrary } from '../toolchain/library.js';
import { collectLibraryBlocks } from '../blocks/collector.js';
import { writeBlocksMetadata } from '../blocks/storage.js';

export interface TrialCompileResult {
  board: string;
  ok: boolean;
  /** 失败时的编译器输出（已清洗） */
  output?: string;
}

/** 试编译回调：给定库目录，尝试对目标板编译，返回结果 */
export type TrialCompiler = (libraryDir: string) => Promise<TrialCompileResult[]>;

export interface ImportOptions {
  store: LibraryStore;
  trialCompile?: TrialCompiler;
  githubToken?: string;
  extractLimits?: ExtractLimits;
  /** 工作目录根，用于临时解压 */
  workDir?: string;
}

export interface ImportResult {
  status: 'accepted' | 'rejected' | 'error';
  /** 卡在哪一步 */
  stage: 'fetch' | 'extract' | 'gates' | 'trial_compile' | 'store' | 'done';
  message?: string;
  library?: StoredLibrary;
  rejections: GateRejection[];
  review?: ReviewReport;
  trial?: TrialCompileResult[];
  stats?: {
    archiveBytes: number;
    extractedBytes: number;
    fileCount: number;
    removedFiles: number;
    commit: string;
  };
}

export async function importLibrary(
  repoUrl: string,
  ref: string,
  opts: ImportOptions,
): Promise<ImportResult> {
  const base = { rejections: [] as GateRejection[] };
  let tmp: string | null = null;

  try {
    // ---- 1. 取包 ----
    // 主机名全程由我们拼，用户只提供 owner/repo（见 fetch.ts 的 SSRF 说明）
    let archive;
    try {
      archive = await fetchLibraryArchive(repoUrl, ref, { token: opts.githubToken });
    } catch (err) {
      const e = err as LibraryFetchError;
      return { ...base, status: 'error', stage: 'fetch', message: e.message };
    }

    // 同一 commit 已经导入过就直接复用，不重复下载编译
    const existing = opts.store.get(archive.owner, archive.repo, archive.commit);
    if (existing) {
      opts.store.touch(existing.dir);
      return {
        ...base,
        status: 'accepted',
        stage: 'done',
        message: '该 commit 此前已导入，直接复用',
        library: existing,
      };
    }

    // ---- 2. 安全解包 ----
    tmp = mkdtempSync(join(opts.workDir ?? tmpdir(), 'af-import-'));
    const extractDir = join(tmp, 'src');
    let extracted;
    try {
      // GitHub tarball 顶层多一层 `repo-sha/`，剥掉
      extracted = await extractTarGz(archive.data, extractDir, 1, opts.extractLimits ?? DEFAULT_EXTRACT_LIMITS);
    } catch (err) {
      const e = err as ExtractError;
      return {
        ...base,
        status: 'rejected',
        stage: 'extract',
        message: e.message,
        rejections: [{ code: e.code ?? 'extract_failed', message: e.message }],
        stats: {
          archiveBytes: archive.data.length,
          extractedBytes: 0, fileCount: 0, removedFiles: 0,
          commit: archive.commit,
        },
      };
    }

    // ---- 3. 硬闸门（确定性判断，不是启发式）----
    const gates = runHardGates(extractDir);
    if (!gates.ok || !gates.libraryRoot || !gates.manifest) {
      return {
        ...base,
        status: 'rejected',
        stage: 'gates',
        message: gates.rejections[0]?.message ?? '未通过安全闸门',
        rejections: gates.rejections,
        stats: {
          archiveBytes: archive.data.length,
          extractedBytes: extracted.totalBytes,
          fileCount: extracted.files.length,
          removedFiles: 0,
          commit: archive.commit,
        },
      };
    }

    // ---- 4. 审核报告（只提示，不自动拒）----
    // 报告在裁剪**之前**生成：裁剪会删掉一些文件，
    // 但人工审核时应该知道原始包里有什么。
    const review = scanForReview(gates.libraryRoot);

    // ---- 5. 白名单裁剪 ----
    const sanitized = sanitizeTree(gates.libraryRoot);

    // 裁剪后重新确认还是个能用的库
    const lib = loadLibrary(gates.libraryRoot);
    if (!lib) {
      return {
        ...base,
        status: 'rejected',
        stage: 'gates',
        message: '裁剪后已不是有效的 Arduino 库',
        rejections: [{ code: 'invalid_after_sanitize', message: '裁剪后已不是有效的 Arduino 库' }],
        review,
      };
    }

    // Deterministic collector output is always a draft. Public APIs expose it
    // only after an administrator reviews and approves the evidence-backed JSON.
    writeBlocksMetadata(gates.libraryRoot, collectLibraryBlocks(lib));
    lib.blocksMeta = loadLibrary(gates.libraryRoot)?.blocksMeta ?? null;

    // ---- 6. 试编译：编不过直接拒，省掉人工时间 ----
    let trial: TrialCompileResult[] | undefined;
    if (opts.trialCompile) {
      trial = await opts.trialCompile(gates.libraryRoot);
      if (trial.length > 0 && trial.every((t) => !t.ok)) {
        return {
          ...base,
          status: 'rejected',
          stage: 'trial_compile',
          message: '该库在所有目标板上都编译失败',
          rejections: [{ code: 'trial_compile_failed', message: '试编译全部失败' }],
          review,
          trial,
        };
      }
    }

    // ---- 7. 入库（目录按 commit 锁定）----
    const dirName = LibraryStore.dirNameFor(archive.owner, archive.repo, archive.commit);
    const dest = opts.store.pathFor(archive.owner, archive.repo, archive.commit);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    try {
      renameSync(gates.libraryRoot, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;

      // 生产中 workDir 与缓存通常是两个挂载点，rename 会报 EXDEV。
      // 先复制到目标文件系统的临时目录，再在同一文件系统内原子改名。
      const staging = `${dest}.tmp-${randomUUID()}`;
      try {
        cpSync(gates.libraryRoot, staging, { recursive: true, errorOnExist: true });
        renameSync(staging, dest);
        rmSync(gates.libraryRoot, { recursive: true, force: true });
      } catch (copyErr) {
        rmSync(staging, { recursive: true, force: true });
        throw copyErr;
      }
    }

    const stored = opts.store.add({
      name: gates.manifest.name,
      version: gates.manifest.version,
      owner: archive.owner,
      repo: archive.repo,
      commit: archive.commit,
      dir: dirName,
    });

    return {
      ...base,
      status: 'accepted',
      stage: 'done',
      library: stored,
      review,
      ...(trial ? { trial } : {}),
      stats: {
        archiveBytes: archive.data.length,
        extractedBytes: extracted.totalBytes,
        fileCount: extracted.files.length,
        removedFiles: sanitized.removed.length,
        commit: archive.commit,
      },
    };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      stage: 'store',
      message: String((err as Error)?.message ?? err),
    };
  } finally {
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
  }
}

export { basename };
