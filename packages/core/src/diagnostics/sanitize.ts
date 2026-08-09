/**
 * 编译器输出的路径清洗。
 *
 * 编译错误是高频返回给前端的内容，而 gcc 的输出里满是服务端绝对路径
 * （构建目录、工具链目录、库目录）。这些路径一旦泄漏出去：
 *   - 暴露服务端目录结构，是信息泄漏
 *   - 对用户毫无意义，纯噪音，尤其在图形化平台上更是完全无关
 *
 * 因此**所有**返回给前端的文本都必须先过这里。
 */

export interface SanitizeRoots {
  /** 本次编译的构建目录 */
  buildDir?: string;
  /** 工具链根目录 */
  toolchainDir?: string;
  /** 核心库目录 */
  coreDir?: string;
  /** 第三方库根目录（可能有多个：内置库 + 用户库 + 白名单仓库） */
  librariesDirs?: string[];
}

/** 正则转义 */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 同一路径的多种写法：原始 / 正斜杠 / 反斜杠 */
function pathVariants(p: string): string[] {
  const trimmed = p.replace(/[\\/]+$/, '');
  const fwd = trimmed.replace(/\\/g, '/');
  const back = trimmed.replace(/\//g, '\\');
  return Array.from(new Set([trimmed, fwd, back])).filter(Boolean);
}

export function createSanitizer(roots: SanitizeRoots) {
  const rules: Array<{ re: RegExp; to: string }> = [];

  const add = (dir: string | undefined, label: string) => {
    if (!dir) return;
    for (const v of pathVariants(dir)) {
      rules.push({ re: new RegExp(esc(v), 'gi'), to: label });
    }
  };

  // 顺序有意义：构建目录通常嵌在临时目录下，先替换更具体的
  add(roots.buildDir, '');            // 构建目录直接抹掉，剩下相对路径
  for (const d of roots.librariesDirs ?? []) add(d, '<libraries>');
  add(roots.coreDir, '<core>');
  add(roots.toolchainDir, '<toolchain>');

  return function sanitize(text: string): string {
    let s = text;
    for (const { re, to } of rules) s = s.replace(re, to);

    // 兜底：任何漏网的绝对路径都打掉，只留文件名。
    // 覆盖 Windows 盘符路径和 Unix 绝对路径。
    //
    // 两条正则的前置否定断言都是必需的 —— 少了就会把 URL 咬碎：
    //   https://deb.li/bubblewrap  →  <httpbubblewrap>
    //   file:///usr/share/doc/x.gz →  <filREADME.gz>
    // 真凶是盘符那条：`https:` 里的 `s:` 会被当成 Windows 盘符。
    // 所以盘符前必须有词边界（`C:\` 合法，`https:` 里的 `s:` 不合法）。
    // 编译器和链接器的报错里经常带文档链接，咬碎后反而误导用户。
    s = s.replace(/(?<!\w)[A-Za-z]:[\\/][^\s:'"()]*[\\/]([^\s:'"()\\/]+)/g, '$1');
    s = s.replace(/(?<![\w<:/])\/(?:[^\s:'"()/]+\/)+([^\s:'"()/]+)/g, '$1');

    // 清理抹掉构建目录后可能残留的前导分隔符
    s = s.replace(/(^|\s)[\\/]+(?=[\w.])/g, '$1');

    return s;
  };
}

export type Sanitizer = ReturnType<typeof createSanitizer>;

/** 不做任何映射的空清洗器（仅用于测试） */
export const identitySanitizer: Sanitizer = (t: string) => t;
