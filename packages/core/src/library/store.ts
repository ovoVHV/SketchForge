/**
 * 已导入库的磁盘存储：索引 + 配额 + LRU 淘汰。
 *
 * 这是"直接让用户导入"这条路**真正的**代价 —— 不是安全（那头沙箱守住了），
 * 而是成本。每个导入的库 × 每块板 × 每套编译参数 = 一份 `.a`，
 * 不设上限的话磁盘会无声增长到爆。
 *
 * 目录按 commit 锁定：`<root>/<owner>__<repo>__<commit前12位>/`
 * 同一个库的不同 commit 是**不同条目**，天然可共存、可回滚，
 * 也杜绝了"tag 被作者移动导致代码悄悄变了"的问题。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

export interface StoredLibrary {
  /** library.properties 里的显示名 */
  name: string;
  version: string;
  owner: string;
  repo: string;
  /** 完整 commit sha —— 锁定的就是它 */
  commit: string;
  /** 存储目录名 */
  dir: string;
  /** 磁盘占用（字节） */
  bytes: number;
  importedAt: number;
  lastUsedAt: number;
  /** 人工审核状态。系统只负责安全，"要不要进精选池"由人来定 */
  curation: 'unreviewed' | 'featured' | 'hidden';
}

interface IndexFile {
  version: 1;
  entries: Record<string, StoredLibrary>;
}

export interface StoreQuota {
  /** 磁盘总量上限（字节） */
  maxTotalBytes: number;
  /** 条目数上限 */
  maxEntries: number;
}

export const DEFAULT_QUOTA: StoreQuota = {
  maxTotalBytes: 2 * 1024 * 1024 * 1024, // 2 GB
  maxEntries: 500,
};

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(cur); } catch { continue; }
    for (const e of entries) {
      const p = join(cur, e);
      try {
        const st = statSync(p);
        if (st.isDirectory()) stack.push(p);
        else total += st.size;
      } catch { /* 忽略 */ }
    }
  }
  return total;
}

export class LibraryStore {
  private index: IndexFile = { version: 1, entries: {} };

  constructor(
    private readonly root: string,
    private readonly quota: StoreQuota = DEFAULT_QUOTA,
  ) {
    mkdirSync(root, { recursive: true });
    this.load();
  }

  private get indexPath(): string { return join(this.root, 'index.json'); }

  private load(): void {
    if (!existsSync(this.indexPath)) {
      this.index = { version: 1, entries: {} };
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as IndexFile;
      if (parsed.version === 1 && parsed.entries) {
        this.index = parsed;
        return;
      }
    } catch { /* 索引损坏就当空的重建 */ }
    this.index = { version: 1, entries: {} };
  }

  /** 重读共享索引，让独立 gateway/worker 进程看到最新导入。 */
  reload(): void {
    this.load();
  }

  private save(): void {
    writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf8');
  }

  /** 存储目录名。commit 取前 12 位足够避免碰撞且便于阅读 */
  static dirNameFor(owner: string, repo: string, commit: string): string {
    const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_');
    return `${safe(owner)}__${safe(repo)}__${commit.slice(0, 12)}`;
  }

  pathFor(owner: string, repo: string, commit: string): string {
    return join(this.root, LibraryStore.dirNameFor(owner, repo, commit));
  }

  get(owner: string, repo: string, commit: string): StoredLibrary | undefined {
    return this.index.entries[LibraryStore.dirNameFor(owner, repo, commit)];
  }

  getByDir(dir: string): StoredLibrary | undefined {
    return this.index.entries[dir];
  }

  list(): StoredLibrary[] {
    return Object.values(this.index.entries);
  }

  /** 所有已导入库的根目录列表，喂给 LibraryRegistry */
  libraryDirs(): string[] {
    return this.list().map((e) => join(this.root, e.dir));
  }

  totalBytes(): number {
    return this.list().reduce((a, b) => a + b.bytes, 0);
  }

  /** 记一次使用，用于 LRU */
  touch(dir: string): void {
    const e = this.index.entries[dir];
    if (!e) return;
    e.lastUsedAt = Date.now();
    this.save();
  }

  add(entry: Omit<StoredLibrary, 'bytes' | 'importedAt' | 'lastUsedAt' | 'curation'> &
      Partial<Pick<StoredLibrary, 'curation'>>): StoredLibrary {
    const now = Date.now();
    const full: StoredLibrary = {
      ...entry,
      bytes: dirSize(join(this.root, entry.dir)),
      importedAt: now,
      lastUsedAt: now,
      curation: entry.curation ?? 'unreviewed',
    };
    this.index.entries[entry.dir] = full;
    this.save();
    this.evictIfNeeded();
    return full;
  }

  setCuration(dir: string, curation: StoredLibrary['curation']): boolean {
    const e = this.index.entries[dir];
    if (!e) return false;
    e.curation = curation;
    this.save();
    return true;
  }

  remove(dir: string): boolean {
    const e = this.index.entries[dir];
    if (!e) return false;
    // 防御：dir 来自索引，但万一索引被手工改过，别让它把别处删了
    if (dir.includes('..') || dir.includes('/') || dir.includes(sep)) return false;
    try { rmSync(join(this.root, dir), { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    delete this.index.entries[dir];
    this.save();
    return true;
  }

  /**
   * 超配额时按 LRU 淘汰。
   * **人工标记为 featured 的条目永不淘汰** —— 它们是图形化平台的积木来源，
   * 被自动清掉会让积木凭空消失。
   */
  evictIfNeeded(): string[] {
    const evicted: string[] = [];
    const candidates = () =>
      this.list()
        .filter((e) => e.curation !== 'featured')
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    while (
      (this.totalBytes() > this.quota.maxTotalBytes || this.list().length > this.quota.maxEntries)
    ) {
      const victim = candidates()[0];
      if (!victim) break; // 剩下的全是 featured，不动
      this.remove(victim.dir);
      evicted.push(victim.dir);
    }
    return evicted;
  }
}
