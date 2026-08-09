const MAX_REPOSITORY_LENGTH = 512;
const MAX_REF_LENGTH = 150;
const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_REF = /^[A-Za-z0-9_.\-/]{1,150}$/;

import { apiUrl } from './deployment-url.js';

function requiredText(value, message) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(message);
  return normalized;
}

function repositoryPath(input) {
  if (/^https?:\/\//i.test(input)) {
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new Error('GitHub 仓库地址格式无效');
    }
    if (!/^https?:$/.test(url.protocol)
      || !/^(?:www\.)?github\.com$/i.test(url.hostname)
      || url.port
      || url.username
      || url.password) {
      throw new Error('目前只支持 github.com 仓库');
    }
    return url.pathname;
  }

  const withoutHost = input.replace(/^(?:www\.)?github\.com\//i, '');
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(withoutHost)) {
    throw new Error('目前只支持 github.com 仓库');
  }
  return withoutHost;
}

export function normalizeGitHubLibraryImport(repositoryInput, refInput = '') {
  const input = requiredText(repositoryInput, '请输入 GitHub 仓库');
  if (input.length > MAX_REPOSITORY_LENGTH) {
    throw new Error(`GitHub 仓库不能超过 ${MAX_REPOSITORY_LENGTH} 个字符`);
  }

  const parts = repositoryPath(input).split('/').filter(Boolean);
  if (parts.length !== 2) {
    throw new Error('请输入 owner/repo 或 GitHub 仓库主页地址');
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!REPOSITORY_SEGMENT.test(owner) || !REPOSITORY_SEGMENT.test(repo)) {
    throw new Error('GitHub owner/repo 格式无效');
  }

  const ref = typeof refInput === 'string' ? refInput.trim() : '';
  if (ref.length > MAX_REF_LENGTH) {
    throw new Error(`ref 不能超过 ${MAX_REF_LENGTH} 个字符`);
  }
  if (ref && (!GITHUB_REF.test(ref) || ref.split('/').includes('..'))) {
    throw new Error('ref 只能包含字母、数字、点、横线、下划线和斜杠，且不能包含 .. 路径段');
  }

  return {
    repository: `${owner}/${repo}`,
    ...(ref ? { ref } : {}),
  };
}

function responseErrorMessage(payload, status) {
  if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message.trim();
  const rejection = Array.isArray(payload?.rejections)
    ? payload.rejections.find((item) => typeof item?.message === 'string' && item.message.trim())
    : null;
  if (rejection) return rejection.message.trim();
  if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim();
  return `库导入服务返回 HTTP ${status}`;
}

export async function installGitHubLibrary({
  repository,
  ref = '',
  visitorId = '',
  fetchFn = globalThis.fetch,
}) {
  if (typeof fetchFn !== 'function') throw new Error('当前环境无法连接库导入服务');
  const body = normalizeGitHubLibraryImport(repository, ref);
  let response;
  try {
    response = await fetchFn(apiUrl('libraries/install'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(visitorId ? { 'X-AF-Visitor': visitorId } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`无法连接库导入服务：${String(error?.message ?? error)}`);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(responseErrorMessage(payload, response.status));
  if (payload?.status !== 'accepted'
    || typeof payload.library?.name !== 'string'
    || !payload.library.name.trim()
    || typeof payload.library?.version !== 'string'
    || !payload.library.version.trim()) {
    throw new Error('库导入服务返回了无效结果');
  }
  return payload;
}

function libraryKey(name, version) {
  return `${String(name).trim().toLowerCase()}@${String(version).trim()}`;
}

function validInstalledLibrary(value) {
  return value
    && typeof value === 'object'
    && typeof value.name === 'string'
    && value.name.trim()
    && typeof value.version === 'string'
    && value.version.trim();
}

export function mergeInstalledLibraries(catalog, installed) {
  const rows = (Array.isArray(catalog) ? catalog : [])
    .filter((library) => library && typeof library.name === 'string' && typeof library.version === 'string')
    .map((library) => ({ ...library }));
  const byKey = new Map(rows.map((library) => [libraryKey(library.name, library.version), library]));
  const stored = (Array.isArray(installed) ? installed : [])
    .filter(validInstalledLibrary)
    .slice()
    .sort((left, right) => Number(right.importedAt ?? 0) - Number(left.importedAt ?? 0));

  for (const library of stored) {
    const key = libraryKey(library.name, library.version);
    const existing = byKey.get(key);
    if (existing) {
      existing.installed = true;
      continue;
    }

    const owner = typeof library.owner === 'string' ? library.owner.trim() : '';
    const repo = typeof library.repo === 'string' ? library.repo.trim() : '';
    const commit = typeof library.commit === 'string' ? library.commit.trim() : '';
    const repository = owner && repo ? `https://github.com/${owner}/${repo}` : '';
    const imported = {
      id: `imported:${key}`,
      name: library.name.trim(),
      version: library.version.trim(),
      architectures: ['*'],
      dependencies: [],
      publicHeaders: [],
      description: owner && repo ? `${owner}/${repo}${commit ? ` @ ${commit.slice(0, 12)}` : ''}` : '已导入库',
      source: repository
        ? { kind: 'github', repository, ...(commit ? { ref: commit } : {}) }
        : { kind: 'imported' },
      installed: true,
      imported: true,
    };
    rows.push(imported);
    byKey.set(key, imported);
  }

  return rows.sort((left, right) => (
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  ));
}
