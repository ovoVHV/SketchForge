import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  installGitHubLibrary,
  mergeInstalledLibraries,
  normalizeGitHubLibraryImport,
} from '../public/library-import.js';

describe('unknown GitHub library import', () => {
  it('normalizes owner/repo and GitHub repository URLs without forwarding a URL host', () => {
    expect(normalizeGitHubLibraryImport(' FastLED/FastLED ')).toEqual({
      repository: 'FastLED/FastLED',
    });
    expect(normalizeGitHubLibraryImport(
      'https://github.com/adafruit/DHT-sensor-library.git/',
      'release/1.4.7',
    )).toEqual({
      repository: 'adafruit/DHT-sensor-library',
      ref: 'release/1.4.7',
    });
    expect(normalizeGitHubLibraryImport('github.com/knolleary/pubsubclient')).toEqual({
      repository: 'knolleary/pubsubclient',
    });
  });

  it.each([
    ['', 'HEAD', '请输入 GitHub 仓库'],
    ['https://example.com/owner/repo', '', '目前只支持 github.com 仓库'],
    ['https://github.com/owner/repo/tree/main', '', '仓库主页地址'],
    ['owner/repo', 'feature/../main', '不能包含 ..'],
    ['owner/repo', 'feature branch', '只能包含'],
    [`${'x'.repeat(513)}`, '', '不能超过 512'],
    ['owner/repo', 'x'.repeat(151), '不能超过 150'],
  ])('rejects invalid repository/ref input %#', (repository, ref, message) => {
    expect(() => normalizeGitHubLibraryImport(repository, ref)).toThrow(message);
  });

  it('posts the canonical repository to the existing install endpoint', async () => {
    const payload = {
      status: 'accepted',
      stage: 'done',
      library: { name: 'Example Arduino', version: '1.2.3', owner: 'owner', repo: 'repo' },
    };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(installGitHubLibrary({
      repository: 'https://github.com/owner/repo.git',
      ref: 'v1.2.3',
      visitorId: 'visitor-1',
      fetchFn,
    })).resolves.toEqual(payload);

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('/v1/libraries/install');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('X-AF-Visitor')).toBe('visitor-1');
    expect(JSON.parse(String(init.body))).toEqual({ repository: 'owner/repo', ref: 'v1.2.3' });
  });

  it('surfaces pipeline and transport failures as readable messages', async () => {
    const rejectedFetch = vi.fn(async () => new Response(JSON.stringify({
      status: 'rejected',
      stage: 'gates',
      rejections: [{ code: 'missing_manifest', message: '没有找到 library.properties' }],
    }), { status: 422, headers: { 'Content-Type': 'application/json' } }));
    await expect(installGitHubLibrary({ repository: 'owner/repo', fetchFn: rejectedFetch }))
      .rejects.toThrow('没有找到 library.properties');

    const offlineFetch = vi.fn(async () => { throw new Error('network offline'); });
    await expect(installGitHubLibrary({ repository: 'owner/repo', fetchFn: offlineFetch }))
      .rejects.toThrow('无法连接库导入服务：network offline');
  });

  it('rejects a malformed success response instead of selecting an unknown identity', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(installGitHubLibrary({ repository: 'owner/repo', fetchFn }))
      .rejects.toThrow('库导入服务返回了无效结果');
  });

  it('merges installed unknown libraries into the catalog and marks known entries installed', () => {
    const catalog = [{
      id: 'known',
      name: 'Known Library',
      version: '1.0.0',
      installed: false,
      source: { kind: 'github', repository: 'https://github.com/owner/known' },
    }];
    const merged = mergeInstalledLibraries(catalog, [
      { name: 'Known Library', version: '1.0.0', owner: 'owner', repo: 'known', importedAt: 1 },
      {
        name: 'Unknown Library',
        version: '2.0.0',
        owner: 'maker',
        repo: 'unknown',
        commit: '0123456789abcdef0123456789abcdef01234567',
        importedAt: 2,
      },
    ]);

    expect(catalog[0]!.installed).toBe(false);
    expect(merged.find((library) => library.name === 'Known Library')?.installed).toBe(true);
    expect(merged.find((library) => library.name === 'Unknown Library')).toMatchObject({
      version: '2.0.0',
      installed: true,
      imported: true,
      source: {
        kind: 'github',
        repository: 'https://github.com/maker/unknown',
        ref: '0123456789abcdef0123456789abcdef01234567',
      },
    });
  });

  it('wires the compact import form to refresh and select an accepted library', () => {
    const index = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
    const app = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');

    expect(index).toContain('id="library-import-form"');
    expect(index).toContain('id="library-repository" name="repository" maxlength="512"');
    expect(index).toContain('id="library-ref" name="ref" maxlength="150"');
    expect(index).toContain('id="library-import-status"');
    expect(app).toContain("fetch(apiUrl('libraries/installed')");
    expect(app).toContain('await refreshAndSelectImportedLibrary(result.library, true, operation)');
    expect(app).toContain("libraryImportFormEl?.addEventListener('submit'");
  });
});
