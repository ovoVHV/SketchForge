import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8').replaceAll('\r\n', '\n');
}

function readPackage(path: string): { scripts: Record<string, string> } {
  return JSON.parse(readRepoFile(path)) as { scripts: Record<string, string> };
}

describe('server entrypoint contract', () => {
  it('uses the Gateway for the repository and server default commands', () => {
    const rootScripts = readPackage('package.json').scripts;
    const serverScripts = readPackage('packages/server/package.json').scripts;

    expect(rootScripts.dev).toBe(
      'npm run dev:gateway --workspace @sketchforge/server',
    );
    expect(rootScripts.start).toBe(
      'npm run start:gateway --workspace @sketchforge/server',
    );
    expect(serverScripts.dev).toBe('tsx watch src/gateway.ts');
    expect(serverScripts['dev:gateway']).toBe('tsx watch src/gateway.ts');
    expect(serverScripts.start).toBe('node dist/gateway.js');
    expect(serverScripts['start:gateway']).toBe('node dist/gateway.js');
  });

  it('keeps monolith and distributed worker commands explicit and distinct', () => {
    const rootScripts = readPackage('package.json').scripts;
    const serverScripts = readPackage('packages/server/package.json').scripts;

    expect(rootScripts['dev:monolith']).toBe(
      'npm run dev:monolith --workspace @sketchforge/server',
    );
    expect(rootScripts['start:monolith']).toBe(
      'npm run start:monolith --workspace @sketchforge/server',
    );
    expect(serverScripts['dev:monolith']).toBe('tsx watch src/index.ts');
    expect(serverScripts['start:monolith']).toBe('node dist/index.js');
    expect(serverScripts['dev:worker']).toBe('tsx watch src/worker.ts');
    expect(serverScripts['start:worker']).toBe('node dist/worker.js');
  });

  it('publishes distributed done events only after BullMQ commits a terminal state', () => {
    const worker = readRepoFile('packages/server/src/worker.ts');
    const gateway = readRepoFile('packages/server/src/gateway.ts');

    expect(worker).not.toContain("eventStore.append(job.id!, { event: 'done'");
    expect(worker).toContain('terminalCoordinator.reconcile');
    expect(gateway).toContain('await terminals.reconcile(job.id!)');
  });

  it('points the reference web client at APIs implemented only by the Gateway', () => {
    const web = readRepoFile('packages/web/public/app.js');
    const gateway = readRepoFile('packages/server/src/gateway.ts');
    const monolith = readRepoFile('packages/server/src/index.ts');

    expect(web).toContain('fetch(apiUrl(`libraries/catalog${query}`)');
    expect(web).toContain('`?arch=${encodeURIComponent(architecture)}`');
    expect(web).toContain("fetch(apiUrl('libraries/installed')");
    expect(web).toContain('fetch(apiUrl(`projects/${encodeURIComponent(id)}`)');

    expect(gateway).toContain("('/v1/libraries/catalog'");
    expect(gateway).toContain("('/v1/libraries/installed'");
    expect(gateway).toContain("('/v1/projects/:projectId'");

    expect(monolith).not.toContain("'/v1/libraries/catalog'");
    expect(monolith).not.toContain("'/v1/libraries/installed'");
    expect(monolith).not.toContain("'/v1/projects");
  });

  it('prefixes every server-generated browser API URL without changing route registration', () => {
    const gateway = readRepoFile('packages/server/src/gateway.ts');
    const monolith = readRepoFile('packages/server/src/index.ts');
    const artifactStore = readRepoFile('packages/server/src/artifact-store.ts');

    for (const source of [gateway, monolith]) {
      expect(source).toContain('normalizePublicBasePath(process.env.AF_PUBLIC_BASE_PATH)');
      expect(source).toContain('stream: prefixPublicPath(publicBasePath, `/v1/compile/${job.id}/events`)');
      expect(source).toContain('`/v1/compile/${job.id}/requests/${job.cancellation.requestId}`');
    }
    expect(artifactStore).toContain(
      "prefixPublicPath(env.AF_PUBLIC_BASE_PATH, '/v1/artifacts')",
    );
    expect(gateway).toContain("('/v1/compile/:jobId/events'");
    expect(monolith).toContain("('/v1/compile/:jobId/events'");
  });
});
