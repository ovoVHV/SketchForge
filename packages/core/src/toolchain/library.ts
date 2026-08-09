/**
 * Arduino 库的解析、索引与依赖解析。
 *
 * 三个来自真实库的坑，设计时必须照顾到：
 *
 * 1. **两种目录布局并存。** 1.5 格式源码在 `src/`（递归编译）；
 *    1.0 格式源码直接在根目录（**只编译根目录 + utility/，不能递归**，
 *    否则会把 examples/ 里的 .ino 和 .cpp 一起卷进来，必然编译失败）。
 *    实测本机 15 个第三方库里 Adafruit 全家都是 1.0 布局。
 *
 * 2. **`depends` 写的是显示名不是文件夹名。**
 *    Adafruit_SSD1306 的清单里写 `depends=Adafruit GFX Library`（带空格），
 *    而文件夹叫 `Adafruit_GFX_Library`。所以索引必须按 library.properties
 *    里的 `name` 建，按文件夹名找一定会断链。
 *
 * 3. **依赖是传递的。** SSD1306 → GFX → BusIO，少解析一层就会缺 -I 而报找不到头文件。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { scan } from '../preprocess/scanner.js';
import { LibraryCatalog } from '../library/catalog.js';
import { readBlocksMetadata } from '../blocks/storage.js';
import type { BlocksMetadata } from '../blocks/schema.js';
import type { LibraryRef } from '../types.js';

export interface LibraryManifest {
  name: string;
  version: string;
  /** `['*']` 表示不限架构 */
  architectures: string[];
  /** 依赖的库**显示名** */
  depends: string[];
  /** 只含预编译二进制。无法审计源码，白名单流程应直接拒绝 */
  precompiled: boolean;
  dotALinkage: boolean;
  /** 清单里声明的主头文件 */
  includes: string[];
  category?: string;
  license?: string;
  url?: string;
}

export interface Library {
  manifest: LibraryManifest;
  rootDir: string;
  layout: '1.0' | '1.5';
  /** 编译时要加的 -I 路径 */
  includeDirs: string[];
  /** 需要编译进 .a 的源文件绝对路径 */
  sources: string[];
  /** 本库暴露的头文件名（不含路径），用于从 #include 反查库 */
  headers: string[];
  /** 本库自身源码/头文件里 #include 的头文件名。惰性计算，见 referencedHeadersOf */
  _referenced?: string[];
  /** 参与扫描的全部文件（源码 + 头文件） */
  allFiles: string[];
  /** Reviewed Blockly metadata loaded from the library-local blocks.json. */
  blocksMeta: BlocksMetadata | null;
}

const SOURCE_EXT = new Set(['.c', '.cpp', '.cc', '.cxx', '.S']);
const HEADER_EXT = new Set(['.h', '.hpp', '.hh', '.hxx']);

/** library.properties 是简单的 key=value，不是标准 ini（无 section） */
export function parseManifest(text: string): LibraryManifest {
  const kv = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    kv.set(t.slice(0, i).trim().toLowerCase(), t.slice(i + 1).trim());
  }
  const list = (k: string) =>
    (kv.get(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  return {
    name: kv.get('name') ?? '',
    version: kv.get('version') ?? '0.0.0',
    architectures: list('architectures').length ? list('architectures') : ['*'],
    // depends 可能写成 "Name (>=1.0.0)"，版本约束这里先剥掉
    depends: list('depends').map((d) => d.replace(/\s*\(.*\)\s*$/, '').trim()).filter(Boolean),
    precompiled: /^(true|full|separate)$/i.test(kv.get('precompiled') ?? ''),
    dotALinkage: /^true$/i.test(kv.get('dot_a_linkage') ?? ''),
    includes: list('includes'),
    ...(kv.get('category') ? { category: kv.get('category') } : {}),
    ...(kv.get('license') ? { license: kv.get('license') } : {}),
    ...(kv.get('url') ? { url: kv.get('url') } : {}),
  };
}

function listFiles(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (recursive) out.push(...listFiles(p, true));
    } else {
      out.push(p);
    }
  }
  return out;
}

/** 从一个库目录读出 Library，读不出返回 null */
export function loadLibrary(rootDir: string): Library | null {
  const manifestPath = join(rootDir, 'library.properties');
  if (!existsSync(manifestPath)) return null;

  let manifest: LibraryManifest;
  try {
    manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  if (!manifest.name) return null;

  const srcDir = join(rootDir, 'src');
  const hasSrc = existsSync(srcDir) && statSync(srcDir).isDirectory();

  let files: string[];
  let includeDirs: string[];

  if (hasSrc) {
    // 1.5 格式：src/ 下递归
    files = listFiles(srcDir, true);
    includeDirs = [srcDir];
  } else {
    // 1.0 格式：**只取根目录 + utility/**。
    // 递归会把 examples/ 里的 .ino/.cpp 卷进来，编译必炸。
    const utility = join(rootDir, 'utility');
    files = [...listFiles(rootDir, false), ...listFiles(utility, false)];
    includeDirs = [rootDir];
    if (existsSync(utility)) includeDirs.push(utility);
  }

  const sources = files.filter((f) => SOURCE_EXT.has(extname(f)));
  const headerFiles = files.filter((f) => HEADER_EXT.has(extname(f)));

  return {
    manifest,
    rootDir,
    layout: hasSrc ? '1.5' : '1.0',
    includeDirs,
    sources,
    headers: headerFiles.map((f) => basename(f)),
    allFiles: [...sources, ...headerFiles],
    blocksMeta: readBlocksMetadata(rootDir),
  };
}

/** 单个文件最大扫描字节数，避免被超大生成文件拖慢 */
const MAX_SCAN_BYTES = 512 * 1024;

/**
 * 一个库自身引用了哪些头文件。
 *
 * 这一步是必需的，不是优化：**内置库几乎从不出现在 `depends` 里**。
 * 实测 Adafruit BusIO 用了 `Wire.h` 和 `SPI.h`，但 library.properties
 * 里一个 depends 都没写 —— 因为 Arduino IDE 本来就是靠递归扫描
 * 库源码里的 #include 来发现这些依赖的。只信 `depends` 必然缺 -I。
 *
 * 结果缓存在 Library 上，每个库只扫一次。
 */
export function referencedHeadersOf(lib: Library): string[] {
  if (lib._referenced) return lib._referenced;

  const found = new Set<string>();
  for (const f of lib.allFiles) {
    let text: string;
    try {
      const st = statSync(f);
      if (st.size > MAX_SCAN_BYTES) continue;
      text = readFileSync(f, 'utf8');
    } catch { continue; }

    // 用词法扫描而非裸正则：被注释掉的 #include 不该算数
    for (const d of scan(text).directives) {
      if (d.name !== 'include') continue;
      const target = /[<"]([^>"]+)[>"]/.exec(d.text)?.[1];
      if (target) found.add(basename(target));
    }
  }

  lib._referenced = [...found];
  return lib._referenced;
}

export interface ResolveResult {
  /** 按依赖顺序排列：被依赖的在前 */
  libraries: Library[];
  errors: string[];
  /** 从 #include 自动推断出来的（非请求显式声明） */
  autoDetected: string[];
}

type LibraryCandidateSelection =
  | { status: 'selected'; library: Library }
  | { status: 'missing' }
  | { status: 'version-missing'; availableVersions: string[] }
  | { status: 'unsupported'; architectures: string[] }
  | { status: 'ambiguous'; name: string; version: string };

export class LibraryRegistry {
  /**
   * Retain every candidate. AVR and ESP32 platform libraries deliberately
   * overlap (for example Wire, SPI, and EEPROM); array order is directory
   * priority, so lookups select the first compatible candidate.
   */
  private readonly byName = new Map<string, Library[]>();
  /** Header name => candidate libraries, in directory-priority order. */
  private readonly byHeader = new Map<string, Library[]>();

  static fromDirectories(dirs: string[]): LibraryRegistry {
    const reg = new LibraryRegistry();
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      const directLibrary = loadLibrary(dir);
      if (directLibrary) {
        reg.add(directLibrary);
        continue;
      }
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
        const lib = loadLibrary(p);
        if (lib) reg.add(lib);
      }
    }
    return reg;
  }

  add(lib: Library): void {
    // Registration order is the configured directory priority.
    this.addCandidate(this.byName, lib.manifest.name.toLowerCase(), lib);
    for (const h of lib.headers) {
      this.addCandidate(this.byHeader, h, lib);
    }
  }

  /**
   * Omitting arch retains the historical inspection behavior: first
   * registered candidate. Compilation always supplies an architecture.
   */
  get(name: string, arch?: string): Library | undefined {
    return this.pickCandidate(this.byName.get(name.toLowerCase()), arch);
  }

  /** Return one highest-priority candidate per display name. */
  list(arch?: string): Library[] {
    return [...this.byName.values()]
      .map((candidates) => this.pickCandidate(candidates, arch))
      .filter((lib): lib is Library => lib !== undefined);
  }

  /** Export the resolved registry as the shared, content-addressed CK catalog. */
  toCatalog(arch?: string): LibraryCatalog {
    return LibraryCatalog.fromLibraries(this.list(arch));
  }

  /** 该库是否支持目标架构 */
  supportsArch(lib: Library, arch: string): boolean {
    return lib.manifest.architectures.some((a) => a === '*' || a.toLowerCase() === arch.toLowerCase());
  }

  private addCandidate(index: Map<string, Library[]>, key: string, lib: Library): void {
    const candidates = index.get(key);
    if (candidates) {
      // A library may contain same-named headers in separate source folders.
      if (!candidates.some((candidate) => candidate.rootDir === lib.rootDir)) candidates.push(lib);
      return;
    }
    index.set(key, [lib]);
  }

  private selectCandidate(
    candidates: readonly Library[] | undefined,
    arch?: string,
    version?: string,
  ): LibraryCandidateSelection {
    if (!candidates?.length) return { status: 'missing' };
    const versionCandidates = version === undefined
      ? candidates
      : candidates.filter((library) => library.manifest.version === version);
    if (!versionCandidates.length) {
      return {
        status: 'version-missing',
        availableVersions: [...new Set(candidates.map((library) => library.manifest.version))],
      };
    }
    const compatible = arch === undefined
      ? versionCandidates
      : versionCandidates.filter((library) => this.supportsArch(library, arch));
    if (!compatible.length) {
      return {
        status: 'unsupported',
        architectures: [...new Set(versionCandidates.flatMap((library) => library.manifest.architectures))],
      };
    }
    const selected = compatible[0]!;
    const logicalName = selected.manifest.name.toLowerCase();
    const sameLogicalVersion = compatible.filter((library) => (
      library.manifest.name.toLowerCase() === logicalName
      && library.manifest.version === selected.manifest.version
    ));
    if (sameLogicalVersion.length !== 1) {
      return {
        status: 'ambiguous',
        name: selected.manifest.name,
        version: selected.manifest.version,
      };
    }
    return { status: 'selected', library: selected };
  }

  private pickCandidate(
    candidates: readonly Library[] | undefined,
    arch?: string,
    version?: string,
  ): Library | undefined {
    const selection = this.selectCandidate(candidates, arch, version);
    if (selection.status === 'ambiguous') {
      throw new TypeError(
        `Library \`${selection.name}@${selection.version}\` is ambiguous across multiple source revisions`,
      );
    }
    return selection.status === 'selected' ? selection.library : undefined;
  }

  /**
   * 从源码的 #include 反查需要哪些库。
   *
   * 用词法扫描出来的指令，而不是裸正则 —— 注释掉的 #include 不该被算数。
   */
  detectFromSource(
    source: string,
    arch: string,
    ignoredHeaders: ReadonlySet<string> = new Set(),
  ): string[] {
    const { directives } = scan(source);
    const found = new Set<string>();
    for (const d of directives) {
      if (d.name !== 'include') continue;
      const target = /[<"]([^>"]+)[>"]/.exec(d.text)?.[1];
      if (!target) continue;
      const header = basename(target);
      if (ignoredHeaders.has(header)) continue;
      const lib = this.pickCandidate(this.byHeader.get(header), arch);
      if (lib) found.add(lib.manifest.name);
    }
    return [...found];
  }

  /**
   * 解析库清单，展开传递依赖，按依赖顺序返回（被依赖的在前，便于链接）。
   */
  resolve(refs: readonly (string | LibraryRef)[], arch: string): ResolveResult {
    const errors: string[] = [];
    const ordered: Library[] = [];
    const seen = new Map<string, Library>();
    const visiting = new Set<string>();

    const visit = (name: string, requestedVersion: string | undefined, chain: string[]): void => {
      const nameKey = name.toLowerCase();
      const selected = seen.get(nameKey);
      if (selected) {
        if (requestedVersion !== undefined && selected.manifest.version !== requestedVersion) {
          errors.push(
            `Library version conflict: ${name}@${selected.manifest.version} vs ${requestedVersion}`,
          );
        }
        return;
      }
      if (visiting.has(nameKey)) {
        // 库之间互相 include 是常见现象（例如 GFX 与其驱动），
        // 隐式依赖成环不该让整次编译失败 —— 跳过即可，两者都已在解析集合里。
        return;
      }
      const candidates = this.byName.get(nameKey);
      if (!candidates?.length) {
        errors.push(
          chain.length
            ? `缺少依赖库 \`${name}\`（由 ${chain[chain.length - 1]} 依赖）`
            : `未找到库 \`${name}\``,
        );
        return;
      }
      const selection = this.selectCandidate(candidates, arch, requestedVersion);
      if (selection.status === 'version-missing') {
        const provided = selection.availableVersions.length === 1
          ? selection.availableVersions[0]
          : `one of ${selection.availableVersions.join(', ')}`;
        errors.push(`Library ${name} requested version ${requestedVersion}, but the platform provides ${provided}`);
        return;
      }
      if (selection.status === 'unsupported') {
        errors.push(`库 \`${name}\` 不支持 ${arch} 架构（声明支持：${selection.architectures.join(', ')}）`);
        return;
      }
      if (selection.status === 'ambiguous') {
        errors.push(`Library \`${selection.name}@${selection.version}\` is ambiguous across multiple source revisions`);
        return;
      }
      if (selection.status !== 'selected') {
        return;
      }
      const lib = selection.library;

      visiting.add(nameKey);

      // ① 清单里显式声明的依赖
      for (const dep of lib.manifest.depends) visit(dep, undefined, [...chain, name]);

      // ② 从库自身源码 #include 推断出的隐式依赖。
      //    内置库（Wire / SPI / EEPROM…）几乎只能从这里发现 —— 见 referencedHeadersOf。
      for (const header of referencedHeadersOf(lib)) {
        const dependencySelection = this.selectCandidate(this.byHeader.get(header), arch);
        if (dependencySelection.status === 'ambiguous') {
          errors.push(
            `Library \`${dependencySelection.name}@${dependencySelection.version}\` is ambiguous across multiple source revisions`,
          );
          continue;
        }
        const dep = dependencySelection.status === 'selected' ? dependencySelection.library : undefined;
        if (!dep || dep.manifest.name.toLowerCase() === nameKey) continue;
        visit(dep.manifest.name, undefined, [...chain, name]);
      }

      visiting.delete(nameKey);

      seen.set(nameKey, lib);
      ordered.push(lib);   // 依赖先入列，天然满足链接顺序
    };

    for (const ref of refs) {
      if (typeof ref === 'string') visit(ref, undefined, []);
      else visit(ref.name, ref.version, []);
    }
    return { libraries: ordered, errors, autoDetected: [] };
  }

  /** 显式声明 + 自动探测，合并后一次解析 */
  resolveForSketch(
    explicit: readonly (string | LibraryRef)[],
    source: string,
    arch: string,
    ignoredHeaders: ReadonlySet<string> = new Set(),
  ): ResolveResult {
    const detected = this.detectFromSource(source, arch, ignoredHeaders);
    const explicitNames = new Set(explicit.map((ref) => (
      typeof ref === 'string' ? ref.toLowerCase() : ref.name.toLowerCase()
    )));
    const auto = detected.filter((name) => !explicitNames.has(name.toLowerCase()));
    const r = this.resolve([...explicit, ...auto], arch);
    r.autoDetected = auto;
    return r;
  }
}
