import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BubblewrapExecutor } from '../src/sandbox/bubblewrap.js';
import { DEFAULT_LIMITS, type ExecRequest } from '../src/sandbox/types.js';

interface BubblewrapArgsBuilder {
  buildArgs(request: ExecRequest): { cmd: string; args: string[] };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function request(command: string, cwd: string): ExecRequest {
  return {
    command,
    args: ['--version'],
    cwd,
    timeoutMs: 1_000,
    limits: DEFAULT_LIMITS,
    readWritePaths: [cwd],
  };
}

function build(requestValue: ExecRequest): string[] {
  const executor = new BubblewrapExecutor({
    bwrapPath: 'bwrap-test',
    prlimitPath: 'prlimit-test',
    systemPaths: ['/usr', '/bin'],
  }) as unknown as BubblewrapArgsBuilder;
  return executor.buildArgs(requestValue).args;
}

describe('BubblewrapExecutor mounts', () => {
  it('emits one read-only bind for a normalized approved tool root', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ck-bwrap-workspace-'));
    const toolchainRoot = mkdtempSync(join(tmpdir(), 'ck-bwrap-toolchain-'));
    roots.push(workspace, toolchainRoot);
    const command = join(toolchainRoot, 'bin', 'compiler');
    const args = build({
      ...request(command, workspace),
      readOnlyPaths: [toolchainRoot, `${toolchainRoot}${sep}`, toolchainRoot],
    });

    const mounts: string[][] = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--ro-bind') mounts.push(args.slice(index + 1, index + 3));
    }
    expect(mounts).toEqual([[toolchainRoot, toolchainRoot]]);
    expect(args.slice(args.lastIndexOf('--') + 1)).toEqual([command, '--version']);
  });

  it('keeps /bin commands on the fixed system mounts without an extra grant', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ck-bwrap-workspace-'));
    roots.push(workspace);
    const args = build(request('/bin/sh', workspace));

    expect(args).not.toContain('--ro-bind');
    expect(args.slice(args.lastIndexOf('--') + 1)).toEqual(['/bin/sh', '--version']);
  });

  it('rejects relative read-only mount paths', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ck-bwrap-workspace-'));
    roots.push(workspace);

    expect(() => build({
      ...request('/bin/sh', workspace),
      readOnlyPaths: ['relative/toolchain'],
    })).toThrow(/must be absolute/);
  });
});
