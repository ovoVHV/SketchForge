/**
 * 从 GitHub 取库源码包。
 *
 * ## 核心安全设计：用户永远不控制主机名
 *
 * 直觉做法是"拿用户给的 URL 去 fetch"，那是 SSRF 的标准入口 ——
 * 用户可以填 `http://169.254.169.254/latest/meta-data/`（云厂商元数据端点，
 * 里面有临时凭证）、`http://127.0.0.1:6379/`（打内网 Redis）、
 * 或者一个会 302 跳到内网的域名。
 *
 * 这里的做法是：**只从用户输入里解析出 `owner/repo`，其余全部由我们自己拼。**
 * 请求只会打到两个写死的主机：
 *   · api.github.com        —— 把 ref（分支/tag）解析成 commit sha
 *   · codeload.github.com   —— 下载该 sha 的 tar.gz
 * 用户对主机、协议、端口、路径结构统统没有影响力，SSRF 无从谈起。
 *
 * 另外禁止重定向（`redirect: 'manual'`）：codeload 的直链本来就不该跳转，
 * 一旦跳转就说明有异常，宁可失败也不跟。
 */

/** 库源码包体积上限。真实 Arduino 库极少超过几 MB */
export const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
export const MAX_REPOSITORY_LENGTH = 512;
export const MAX_REF_LENGTH = 150;

export interface RepoRef {
  owner: string;
  repo: string;
  /** 用户给的分支 / tag / sha，未解析 */
  ref: string;
}

export interface FetchedArchive {
  owner: string;
  repo: string;
  /** **已解析的 commit sha**。入库锁定它，不锁 tag */
  commit: string;
  data: Buffer;
}

export class LibraryFetchError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'LibraryFetchError';
  }
}

/** owner / repo 的合法字符，GitHub 官方规则 */
const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
/** ref 可以是分支名、tag、sha。禁掉可能被塞进 URL 路径的字符 */
const REF = /^[A-Za-z0-9_.\-/]+$/;

/**
 * 从各种写法里抠出 owner/repo。
 * 支持：
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   github.com/owner/repo
 *   owner/repo
 * 可接受末尾 `/`，但不接受任何额外路径段。
 */
export function parseRepoUrl(input: string, ref = 'HEAD'): RepoRef {
  const trimmed = input.trim();
  if (!trimmed) throw new LibraryFetchError('仓库地址不能为空', 'empty_url');
  if (trimmed.length > MAX_REPOSITORY_LENGTH) {
    throw new LibraryFetchError('仓库地址过长', 'url_too_long');
  }

  const normalizedRef = ref.trim();
  if (!normalizedRef || normalizedRef.length > MAX_REF_LENGTH || !REF.test(normalizedRef)) {
    throw new LibraryFetchError(`ref \`${ref}\` 含有不允许的字符或长度无效`, 'bad_ref');
  }
  if (normalizedRef.split('/').includes('..')) {
    throw new LibraryFetchError('ref 不允许包含 `..`', 'bad_ref');
  }

  let path = trimmed;

  // URL 由结构化解析器验证；凭据、端口和附加参数一律 fail closed。
  if (/^(?:https?:\/\/|\/\/)/i.test(trimmed)) {
    const rawUrl = /^(?:https?:)?\/\/([^/?#]*)([^?#]*)/i.exec(trimmed);
    let url: URL;
    try {
      url = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed);
    } catch {
      throw new LibraryFetchError('仓库地址不是有效 URL', 'bad_url');
    }
    if (url.hostname.toLowerCase() !== 'github.com' && url.hostname.toLowerCase() !== 'www.github.com') {
      throw new LibraryFetchError(
        '目前只支持 github.com 上的库。请提供形如 https://github.com/owner/repo 的地址。',
        'unsupported_host',
      );
    }
    if (url.username || url.password) {
      throw new LibraryFetchError('仓库地址不允许包含凭据', 'credentials_not_allowed');
    }
    if (url.port || /:\d+$/.test(rawUrl?.[1] ?? '') || url.search || url.hash) {
      throw new LibraryFetchError('仓库地址不允许包含端口、查询参数或片段', 'bad_url');
    }
    try {
      if ((rawUrl?.[2] ?? '').split('/').filter(Boolean).map((part) => decodeURIComponent(part)).includes('..')) {
        throw new LibraryFetchError('仓库地址包含不允许的路径', 'bad_url');
      }
    } catch (error) {
      if (error instanceof LibraryFetchError) throw error;
      throw new LibraryFetchError('仓库地址含有无效编码', 'bad_url');
    }
    path = url.pathname;
  } else {
    path = path.replace(/^(?:www\.)?github\.com\//i, '');
  }

  let parts: string[];
  try {
    parts = path.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    throw new LibraryFetchError('仓库地址含有无效编码', 'bad_url');
  }
  if (parts.includes('..') || parts.length !== 2) {
    throw new LibraryFetchError('仓库地址包含不允许的路径', 'bad_url');
  }
  const owner = parts[0] ?? '';
  const repo = (parts[1] ?? '').replace(/\.git$/i, '');

  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) {
    throw new LibraryFetchError(`无法从 \`${input}\` 解析出 owner/repo`, 'bad_url');
  }
  return { owner, repo, ref: normalizedRef };
}

interface FetchOptions {
  /** GitHub token，可选。仅用于提高速率限制 */
  token?: string;
  timeoutMs?: number;
}

function headers(opts: FetchOptions): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': 'sketchforge-library-importer',
    Accept: 'application/vnd.github+json',
  };
  if (opts.token) h.Authorization = `Bearer ${opts.token}`;
  return h;
}

/**
 * 把 ref 解析成确切的 commit sha。
 *
 * **必须锁 sha 而不是 tag** —— GitHub 的 tag 可以被仓库作者随时移动指向
 * 另一份代码。锁 tag 等于把"这份代码是我审过的"这句话建在流沙上。
 */
export async function resolveCommit(
  ref: RepoRef,
  opts: FetchOptions = {},
): Promise<string> {
  // 已经是完整 sha 就直接用
  if (/^[0-9a-f]{40}$/i.test(ref.ref)) return ref.ref.toLowerCase();

  const url = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/commits/${encodeURIComponent(ref.ref)}`;
  const res = await fetch(url, {
    headers: headers(opts),
    redirect: 'manual',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });

  if (res.status === 404) {
    throw new LibraryFetchError(`找不到仓库或 ref：${ref.owner}/${ref.repo}@${ref.ref}`, 'not_found');
  }
  if (res.status === 403) {
    throw new LibraryFetchError('GitHub 速率限制。请稍后重试，或配置访问令牌。', 'rate_limited');
  }
  if (!res.ok) {
    throw new LibraryFetchError(`GitHub 返回 HTTP ${res.status}`, 'api_error');
  }

  const body = (await res.json()) as { sha?: string };
  if (!body.sha || !/^[0-9a-f]{40}$/i.test(body.sha)) {
    throw new LibraryFetchError('GitHub 返回的 commit sha 不合法', 'api_error');
  }
  return body.sha.toLowerCase();
}

/**
 * 下载指定 commit 的 tar.gz。
 *
 * 边下边计数，超过上限立刻中止 —— 不能等下载完再检查体积，
 * 那样对方给一个无限流就能把内存吃光。
 */
export async function downloadArchive(
  ref: RepoRef,
  commit: string,
  opts: FetchOptions = {},
): Promise<Buffer> {
  const url = `https://codeload.github.com/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/tar.gz/${commit}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'sketchforge-library-importer' },
    redirect: 'manual',   // 直链不该跳转；跳转即异常
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });

  if (res.status >= 300 && res.status < 400) {
    throw new LibraryFetchError('下载地址发生了预期外的重定向，已中止', 'unexpected_redirect');
  }
  if (!res.ok) {
    throw new LibraryFetchError(`下载失败：HTTP ${res.status}`, 'download_failed');
  }

  // Content-Length 只是提示，可以撒谎，所以下面还要边读边数
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_ARCHIVE_BYTES) {
    throw new LibraryFetchError(
      `源码包 ${(declared / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB 上限`,
      'too_large',
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new LibraryFetchError('下载响应为空', 'download_failed');

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new LibraryFetchError(
        `源码包超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB 上限`,
        'too_large',
      );
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

/** 解析 → 定 sha → 下载，一步到位 */
export async function fetchLibraryArchive(
  repoUrl: string,
  ref = 'HEAD',
  opts: FetchOptions = {},
): Promise<FetchedArchive> {
  const parsed = parseRepoUrl(repoUrl, ref);
  const commit = await resolveCommit(parsed, opts);
  const data = await downloadArchive(parsed, commit, opts);
  return { owner: parsed.owner, repo: parsed.repo, commit, data };
}
