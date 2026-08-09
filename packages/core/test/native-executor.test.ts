import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  calculateActionKeys,
  MemoryActionCache,
  FileActionCache,
  NativeExecutor,
  sha256Hex,
  type BoardPackRef,
  type ActionCache,
  type ActionCacheEntry,
  type BuildPacks,
  type BuildIR,
  type BuildActionDraft,
  type CompileAction,
  type ExecRequest,
  type ExecResult,
  type SandboxExecutor,
} from '../src/index.js';
import { createBuildIR } from '../src/build-ir/builder.js';

const board: BoardPackRef = {
  kind: 'board', id: 'board:test', version: '1.0.0', sha256: 'b'.repeat(64),
  fqbn: 'test:core:board', variant: 'test',
};
const packs: BuildPacks = {
  toolchain: {
    kind: 'toolchain', id: 'tool:test', version: '1.0.0', sha256: 'a'.repeat(64),
    abi: 'test-elf', instructionSet: 'test',
  },
  platform: {
    kind: 'platform', id: 'platform:test', version: '1.0.0', sha256: 'c'.repeat(64),
    platform: 'test',
  },
  board,
  libraries: { roots: [], packs: [] },
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeAction(source: string, sourceHash = sha256Hex(source)): CompileAction {
  return {
    id: 'compile-main', kind: 'compile', tool: 'tool:test-cc',
    inputs: [{ path: 'src/main.cpp', sha256: sourceHash, role: 'source' }],
    outputs: [{ path: 'build/main.o', kind: 'object' }],
    arguments: ['build/main.o'], environment: {}, dependencies: [], packDependencies: [], cacheKey: '',
    compileUnit: {
      language: 'c++', source: 'src/main.cpp', output: 'build/main.o', macros: {},
      includePaths: [], flags: [],
    },
  };
}

function makeIr(action: CompileAction, source = 'int main() { return 0; }\n') {
  return createBuildIR({
    project: [{ path: 'src/main.cpp', content: source }],
    target: { fqbn: board.fqbn, options: {}, boardPack: board },
    packs, actions: [action], artifacts: [{ path: 'build/main.o', format: 'elf' }],
    diagnosticMap: [{ generatedFile: 'src/main.cpp', generatedLine: 1, sourceFile: 'src/main.cpp', sourceLine: 1 }],
  });
}

class FakeSandbox implements SandboxExecutor {
  readonly name = 'fake';
  readonly isolationLevel = 'process' as const;
  calls = 0;
  requests: ExecRequest[] = [];
  result: ExecResult = {
    code: 0, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, truncated: false,
  };

  async exec(req: ExecRequest): Promise<ExecResult> {
    this.calls += 1;
    this.requests.push(req);
    if (this.result.code === 0) {
      const output = join(req.cwd, req.args[0]!);
      writeFileSync(output, `object-${this.calls}`);
    }
    return this.result;
  }
}

class PostLinkSandbox implements SandboxExecutor {
  readonly name = 'post-link-fake';
  readonly isolationLevel = 'process' as const;
  calls = 0;
  requests: ExecRequest[] = [];
  mergeInputs: string[] = [];

  async exec(req: ExecRequest): Promise<ExecResult> {
    this.calls += 1;
    this.requests.push(req);
    let output: string | undefined;
    if (req.command === 'fake-partition') output = req.args[2];
    else {
      const marker = req.args.indexOf('-o');
      output = marker >= 0 ? req.args[marker + 1] : undefined;
    }
    if (!output) throw new Error(`test tool did not receive an output: ${req.command}`);

    if (req.command === 'fake-esptool' && req.args[2] === 'merge-bin') {
      this.mergeInputs = req.args.slice(13).filter((_value, index) => index % 2 === 1);
      for (const input of this.mergeInputs) {
        if (!existsSync(join(req.cwd, ...input.split('/')))) {
          throw new Error(`merge input was not materialized: ${input}`);
        }
      }
    }
    const absoluteOutput = join(req.cwd, ...output.split('/'));
    mkdirSync(dirname(absoluteOutput), { recursive: true });
    const body = req.command === 'fake-esptool' && req.args[2] === 'merge-bin'
      ? this.mergeInputs.map((input) => readFileSync(join(req.cwd, ...input.split('/')))).join('|')
      : `output:${output}`;
    writeFileSync(absoluteOutput, body);
    return {
      code: 0, signal: null, stdout: '', stderr: '', durationMs: 1,
      timedOut: false, truncated: false,
    };
  }
}

class DiagnosticActionCache implements ActionCache {
  entry: ActionCacheEntry | null = null;

  async get(actionKey: string): Promise<ActionCacheEntry | null> {
    if (this.entry?.actionKey !== actionKey) return null;
    return {
      actionKey,
      outputs: this.entry.outputs.map((output) => ({ ...output, bytes: new Uint8Array(output.bytes) })),
      diagnostics: this.entry.diagnostics?.map((diagnostic) => ({ ...diagnostic })),
    };
  }

  async put(entry: ActionCacheEntry): Promise<void> {
    this.entry = {
      actionKey: entry.actionKey,
      outputs: entry.outputs.map((output) => ({ ...output, bytes: new Uint8Array(output.bytes) })),
      diagnostics: entry.diagnostics?.map((diagnostic) => ({ ...diagnostic })),
    };
  }
}

function executor(
  sandbox: FakeSandbox,
  cache = new MemoryActionCache(),
  policyIdentity?: string,
): NativeExecutor {
  const root = mkdtempSync(join(tmpdir(), 'ck-native-executor-'));
  roots.push(root);
  return new NativeExecutor({
    sandbox,
    tools: { resolve: (tool) => tool === 'tool:test-cc' ? 'fake-cc' : (() => { throw new Error('unknown tool'); })() },
    workspaceRoot: root,
    cache,
    ...(policyIdentity === undefined ? {} : { policyIdentity }),
  });
}

function makePostLinkIr(options: {
  omitMergeInput?: boolean;
  mergeOperation?: string;
  customPartitionOutputSha256?: string;
} = {}): BuildIR {
  const contract = '9'.repeat(64);
  const contractFlag = `--ck-post-link-contract=${contract}`;
  const files = {
    object: 'linked-object',
    bootloader: 'bootloader-elf',
    partitions: 'partition-csv',
    bootApp0: 'boot-app0',
  };
  const sourceProducts = [
    { id: 'transform-bootloader', path: 'build/bootloader.bin', role: 'bootloader-image' },
    { id: 'transform-partitions', path: 'build/partitions.bin', role: 'partitions-image' },
    { id: 'transform-boot-app0', path: 'build/boot_app0.bin', role: 'boot-app0-image' },
    { id: 'transform-application', path: 'build/firmware.bin', role: 'application-image' },
  ];
  const mergeProducts = options.omitMergeInput ? sourceProducts.slice(0, 3) : sourceProducts;
  const partitionPath = options.customPartitionOutputSha256 === undefined
    ? 'packs/board/partitions.csv'
    : 'partitions.csv';
  const actions: BuildActionDraft[] = [
    {
      id: 'link-firmware', kind: 'link', tool: 'tool:test-ld',
      inputs: [{ path: 'obj/main.o', sha256: sha256Hex(files.object), role: 'object' }],
      outputs: [{ path: 'build/firmware.elf', kind: 'elf' }],
      arguments: ['-o', 'build/firmware.elf', 'obj/main.o'], environment: {},
      dependencies: [], packDependencies: [],
      link: { objects: ['obj/main.o'], archives: [], output: 'build/firmware.elf', flags: [] },
    },
    {
      id: 'transform-application', kind: 'transform', tool: 'toolchain:esptool',
      inputs: [{ path: 'build/firmware.elf', role: 'linked-elf' }],
      outputs: [{ path: 'build/firmware.bin', kind: 'application' }],
      arguments: [
        '--chip', 'esp32c3', 'elf2image', '--flash-mode', 'dio',
        '--flash-freq', '40m', '--flash-size', '4MB', '--elf-sha256-offset', '0xb0',
        '-o', 'build/firmware.bin', 'build/firmware.elf',
      ],
      environment: {}, dependencies: ['link-firmware'], packDependencies: [],
      transform: {
        input: 'build/firmware.elf', output: 'build/firmware.bin', format: 'bin',
        flags: [
          '--chip=esp32c3', '--flash-mode=dio', '--flash-freq=40m', '--flash-size=4MB',
          '--elf-sha256-offset=0xb0', contractFlag,
        ],
      },
    },
    {
      id: 'transform-bootloader', kind: 'transform', tool: 'toolchain:esptool',
      inputs: [{
        path: 'packs/board/bootloader.elf', sha256: sha256Hex(files.bootloader), role: 'bootloader-source',
      }],
      outputs: [{ path: 'build/bootloader.bin', kind: 'bootloader' }],
      arguments: [
        '--chip', 'esp32c3', 'elf2image', '--flash-mode', 'dio',
        '--flash-freq', '40m', '--flash-size', '4MB',
        '-o', 'build/bootloader.bin', 'packs/board/bootloader.elf',
      ],
      environment: {}, dependencies: [], packDependencies: [],
      transform: {
        input: 'packs/board/bootloader.elf', output: 'build/bootloader.bin', format: 'bootloader',
        flags: [
          '--chip=esp32c3', '--flash-mode=dio', '--flash-freq=40m', '--flash-size=4MB', contractFlag,
        ],
      },
    },
    {
      id: 'transform-partitions', kind: 'transform', tool: 'platform:gen-esp32part',
      inputs: [{
        path: partitionPath, sha256: sha256Hex(files.partitions), role: 'partitions-source',
      }],
      outputs: [{
        path: 'build/partitions.bin', kind: 'partitions',
        ...(options.customPartitionOutputSha256 === undefined
          ? {}
          : { sha256: options.customPartitionOutputSha256 }),
      }],
      arguments: ['-q', partitionPath, 'build/partitions.bin'],
      environment: {}, dependencies: [], packDependencies: [],
      transform: {
        input: partitionPath, output: 'build/partitions.bin', format: 'partition',
        flags: ['--quiet=true', contractFlag],
      },
    },
    {
      id: 'transform-boot-app0', kind: 'transform', tool: 'ck:copy',
      inputs: [{
        path: 'packs/board/boot_app0.bin', sha256: sha256Hex(files.bootApp0), role: 'boot-app0-source',
      }],
      outputs: [{ path: 'build/boot_app0.bin', kind: 'boot-app0' }],
      arguments: ['packs/board/boot_app0.bin', '-o', 'build/boot_app0.bin'],
      environment: {}, dependencies: [], packDependencies: [],
      transform: {
        input: 'packs/board/boot_app0.bin', output: 'build/boot_app0.bin', format: 'boot-app0',
        flags: [contractFlag],
      },
    },
    {
      id: 'transform-merged', kind: 'transform', tool: 'toolchain:esptool',
      inputs: mergeProducts.map((product) => ({ path: product.path, role: product.role })),
      outputs: [{ path: 'build/firmware.merged.bin', kind: 'merged' }],
      arguments: [
        '--chip', 'esp32c3', options.mergeOperation ?? 'merge-bin',
        '-o', 'build/firmware.merged.bin', '--pad-to-size', '4MB',
        '--flash-mode', 'keep', '--flash-freq', 'keep', '--flash-size', 'keep',
        '0x0', 'build/bootloader.bin', '0x8000', 'build/partitions.bin',
        '0xe000', 'build/boot_app0.bin', '0x10000', 'build/firmware.bin',
      ],
      environment: {}, dependencies: mergeProducts.map((product) => product.id), packDependencies: [],
      transform: {
        input: 'build/bootloader.bin', output: 'build/firmware.merged.bin', format: 'bin',
        flags: [
          '--chip=esp32c3', '--pad-to-size=4MB', '--flash-mode=keep',
          '--flash-freq=keep', '--flash-size=keep', contractFlag,
        ],
      },
    },
  ];
  return createBuildIR({
    project: [
      { path: 'obj/main.o', content: files.object },
      { path: 'packs/board/bootloader.elf', content: files.bootloader },
      { path: partitionPath, content: files.partitions },
      { path: 'packs/board/boot_app0.bin', content: files.bootApp0 },
    ],
    target: { fqbn: board.fqbn, options: {}, boardPack: board },
    packs,
    actions,
    artifacts: [
      { path: 'build/firmware.bin', format: 'bin', offset: '0x10000' },
      { path: 'build/bootloader.bin', format: 'bootloader', offset: '0x0' },
      { path: 'build/partitions.bin', format: 'partition', offset: '0x8000' },
      { path: 'build/boot_app0.bin', format: 'boot-app0', offset: '0xe000' },
      { path: 'build/firmware.merged.bin', format: 'bin' },
    ],
    diagnosticMap: [],
  });
}

describe('NativeExecutor', () => {
  it('executes a valid IR and reuses Action outputs by content key', async () => {
    const sandbox = new FakeSandbox();
    const cache = new MemoryActionCache();
    const run = executor(sandbox, cache);
    const ir = makeIr(makeAction('int main() { return 0; }\n'));

    const first = await run.execute(ir);
    expect(first).toMatchObject({ status: 'success', executor: 'native' });
    expect(first.status === 'success' && first.actions[0]).toMatchObject({ cached: false, actionId: 'compile-main' });
    expect(sandbox.calls).toBe(1);

    const second = await run.execute(ir);
    expect(second).toMatchObject({ status: 'success', executor: 'native' });
    expect(second.status === 'success' && second.actions[0]).toMatchObject({ cached: true });
    expect(sandbox.calls).toBe(1);
    expect(second.status === 'success' && second.artifacts[0]).toMatchObject({ path: 'build/main.o', size: 8 });
  });

  it('rejects a self-consistent cache entry that violates the declared output hash', async () => {
    const staleBytes = new TextEncoder().encode('stale-object');
    let cacheWrites = 0;
    const cache: ActionCache = {
      get: async (actionKey) => ({
        actionKey,
        outputs: [{ path: 'build/main.o', bytes: staleBytes, sha256: sha256Hex(staleBytes) }],
      }),
      put: async () => { cacheWrites += 1; },
    };
    const sandbox = new FakeSandbox();
    const action = makeAction('int main() { return 0; }\n');
    action.outputs[0]!.sha256 = sha256Hex('object-1');

    await expect(executor(sandbox, cache).execute(makeIr(action))).resolves.toMatchObject({
      status: 'success', actions: [{ actionId: 'compile-main', cached: false }],
    });
    expect(sandbox.calls).toBe(1);
    expect(cacheWrites).toBe(1);
  });

  it('runs the five ESP32 post-link products with four materialized merge inputs', async () => {
    const sandbox = new PostLinkSandbox();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-native-post-link-'));
    roots.push(workspaceRoot);
    const run = new NativeExecutor({
      sandbox,
      tools: {
        resolve: (tool) => {
          if (tool === 'tool:test-ld') return 'fake-ld';
          if (tool === 'toolchain:esptool') return 'fake-esptool';
          if (tool === 'platform:gen-esp32part') return 'fake-partition';
          throw new Error(`unexpected native tool: ${tool}`);
        },
      },
      workspaceRoot,
    });

    const result = await run.execute(makePostLinkIr());

    expect(result).toMatchObject({ status: 'success', executor: 'native' });
    expect(sandbox.mergeInputs).toEqual([
      'build/bootloader.bin',
      'build/partitions.bin',
      'build/boot_app0.bin',
      'build/firmware.bin',
    ]);
    expect(sandbox.requests.map((request) => request.command)).not.toContain('ck:copy');
    expect(sandbox.requests.every((request) => (
      ['fake-ld', 'fake-esptool', 'fake-partition'].includes(request.command)
    ))).toBe(true);
    expect(result.status === 'success' && result.artifacts.map((artifact) => artifact.path)).toEqual([
      'build/boot_app0.bin',
      'build/bootloader.bin',
      'build/firmware.bin',
      'build/firmware.merged.bin',
      'build/partitions.bin',
    ]);
  });

  it('rejects Native gen_esp32part bytes that differ from the planned table hash', async () => {
    const sandbox = new PostLinkSandbox();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-native-partition-contract-'));
    roots.push(workspaceRoot);
    const run = new NativeExecutor({
      sandbox,
      tools: {
        resolve: (tool) => {
          if (tool === 'tool:test-ld') return 'fake-ld';
          if (tool === 'toolchain:esptool') return 'fake-esptool';
          if (tool === 'platform:gen-esp32part') return 'fake-partition';
          throw new Error(`unexpected native tool: ${tool}`);
        },
      },
      workspaceRoot,
    });

    await expect(run.execute(makePostLinkIr({
      customPartitionOutputSha256: sha256Hex('planned-partition-table'),
    }))).resolves.toMatchObject({
      status: 'error',
      reason: 'integrity',
      actionId: 'transform-partitions',
      message: expect.stringMatching(/output contract mismatch/),
    });
    expect(sandbox.requests.some((request) => request.command === 'fake-partition')).toBe(true);
    expect(sandbox.mergeInputs).toEqual([]);
  });

  it('rejects a project partition Action without a declared output hash before execution', async () => {
    const original = makePostLinkIr({ customPartitionOutputSha256: '8'.repeat(64) });
    const tampered = await calculateActionKeys({
      ...original,
      graph: {
        actions: original.graph.actions.map((action) => (
          action.id === 'transform-partitions'
            ? { ...action, outputs: action.outputs.map(({ sha256: _sha256, ...output }) => output) }
            : action
        )),
      },
    });
    const sandbox = new PostLinkSandbox();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-native-partition-contract-'));
    roots.push(workspaceRoot);
    const run = new NativeExecutor({
      sandbox,
      tools: { resolve: () => 'unexpected-tool' },
      workspaceRoot,
    });

    await expect(run.execute(tampered)).resolves.toMatchObject({
      status: 'error', reason: 'invalid_ir',
      message: expect.stringMatching(/project partition Action output hash is missing/),
    });
    expect(sandbox.calls).toBe(0);
  });

  it('rejects an incomplete four-segment merge before any native command starts', async () => {
    const sandbox = new PostLinkSandbox();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-native-post-link-reject-'));
    roots.push(workspaceRoot);
    const run = new NativeExecutor({
      sandbox,
      tools: { resolve: () => 'unexpected-tool' },
      workspaceRoot,
    });

    await expect(run.execute(makePostLinkIr({ omitMergeInput: true }))).resolves.toMatchObject({
      status: 'error', reason: 'invalid_ir', message: expect.stringMatching(/exactly four segments/),
    });
    expect(sandbox.calls).toBe(0);
  });

  it('rejects non-build esptool operations before any native command starts', async () => {
    const sandbox = new PostLinkSandbox();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-native-post-link-command-reject-'));
    roots.push(workspaceRoot);
    const run = new NativeExecutor({
      sandbox,
      tools: { resolve: () => 'unexpected-tool' },
      workspaceRoot,
    });

    await expect(run.execute(makePostLinkIr({ mergeOperation: 'erase-flash' }))).resolves.toMatchObject({
      status: 'error', reason: 'invalid_ir', message: expect.stringMatching(/unsupported esptool/),
    });
    expect(sandbox.calls).toBe(0);
  });

  it('rejects a stable post-link graph whose contract marker was stripped', async () => {
    const sandbox = new PostLinkSandbox();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-native-post-link-contract-reject-'));
    roots.push(workspaceRoot);
    const original = makePostLinkIr();
    const stripped = await calculateActionKeys({
      ...original,
      graph: {
        actions: original.graph.actions.map((action) => action.kind === 'transform'
          ? {
              ...action,
              transform: {
                ...action.transform,
                flags: action.transform.flags.filter((flag) => !flag.startsWith('--ck-post-link-contract=')),
              },
            }
          : action),
      },
    });
    const run = new NativeExecutor({
      sandbox,
      tools: { resolve: () => 'unexpected-tool' },
      workspaceRoot,
    });

    await expect(run.execute(stripped)).resolves.toMatchObject({
      status: 'error', reason: 'invalid_ir', message: expect.stringMatching(/contract flag is missing/),
    });
    expect(sandbox.calls).toBe(0);
  });

  it('namespaces cached outputs by the Native execution policy identity', async () => {
    const cache = new MemoryActionCache();
    const firstSandbox = new FakeSandbox();
    const secondSandbox = new FakeSandbox();
    const firstPolicy = executor(firstSandbox, cache, '1'.repeat(64));
    const secondPolicy = executor(secondSandbox, cache, '2'.repeat(64));
    const ir = makeIr(makeAction('int main() { return 0; }\n'));

    await expect(firstPolicy.execute(ir)).resolves.toMatchObject({
      status: 'success', actions: [{ cached: false }],
    });
    await expect(firstPolicy.execute(ir)).resolves.toMatchObject({
      status: 'success', actions: [{ cached: true }],
    });
    await expect(secondPolicy.execute(ir)).resolves.toMatchObject({
      status: 'success', actions: [{ cached: false }],
    });
    await expect(firstPolicy.execute(ir)).resolves.toMatchObject({
      status: 'success', actions: [{ cached: true }],
    });
    expect(firstSandbox.calls).toBe(1);
    expect(secondSandbox.calls).toBe(1);
  });

  it('folds the resolver integrity identity into Action cache keys', async () => {
    const cache = new MemoryActionCache();
    const ir = makeIr(makeAction('int main() { return 0; }\n'));
    const run = (sandbox: FakeSandbox, toolPolicyIdentity: string) => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-native-tool-policy-'));
      roots.push(workspaceRoot);
      return new NativeExecutor({
        sandbox,
        tools: {
          policyIdentity: toolPolicyIdentity,
          resolve: () => 'fake-cc',
        },
        workspaceRoot,
        cache,
      });
    };
    const firstSandbox = new FakeSandbox();
    const secondSandbox = new FakeSandbox();

    await expect(run(firstSandbox, '3'.repeat(64)).execute(ir)).resolves.toMatchObject({
      status: 'success', actions: [{ cached: false }],
    });
    await expect(run(firstSandbox, '3'.repeat(64)).execute(ir)).resolves.toMatchObject({
      status: 'success', actions: [{ cached: true }],
    });
    await expect(run(secondSandbox, '4'.repeat(64)).execute(ir)).resolves.toMatchObject({
      status: 'success', actions: [{ cached: false }],
    });
    expect(firstSandbox.calls).toBe(1);
    expect(secondSandbox.calls).toBe(1);
  });

  it('runs tool integrity preflight before accepting a cached Action', async () => {
    const cache = new MemoryActionCache();
    const ir = makeIr(makeAction('int main() { return 0; }\n'));
    const firstSandbox = new FakeSandbox();
    const firstRoot = mkdtempSync(join(tmpdir(), 'ck-native-tool-preflight-'));
    roots.push(firstRoot);
    const toolPolicyIdentity = '5'.repeat(64);
    const first = new NativeExecutor({
      sandbox: firstSandbox,
      tools: {
        policyIdentity: toolPolicyIdentity,
        verifyForExecution: () => {},
        resolve: () => 'fake-cc',
      },
      workspaceRoot: firstRoot,
      cache,
    });
    await expect(first.execute(ir)).resolves.toMatchObject({
      status: 'success', actions: [{ cached: false }],
    });

    const secondSandbox = new FakeSandbox();
    const secondRoot = mkdtempSync(join(tmpdir(), 'ck-native-tool-preflight-'));
    roots.push(secondRoot);
    const second = new NativeExecutor({
      sandbox: secondSandbox,
      tools: {
        policyIdentity: toolPolicyIdentity,
        verifyForExecution: () => { throw new Error('closure drift'); },
        resolve: () => 'fake-cc',
      },
      workspaceRoot: secondRoot,
      cache,
    });
    await expect(second.execute(ir)).resolves.toMatchObject({
      status: 'error', reason: 'tool', message: expect.stringMatching(/closure drift/),
    });
    expect(secondSandbox.calls).toBe(0);
  });

  it('passes the execution deadline and cancellation signal into tool preflight', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-native-tool-preflight-options-'));
    roots.push(workspaceRoot);
    const controller = new AbortController();
    const deadlineAt = Date.now() + 60_000;
    let observedSignal: AbortSignal | undefined;
    let observedDeadline: number | undefined;
    const instance = new NativeExecutor({
      sandbox: new FakeSandbox(),
      tools: {
        verifyForExecution: (_packs, options) => {
          observedSignal = options?.signal;
          observedDeadline = options?.deadlineAt;
        },
        resolve: () => 'fake-cc',
      },
      workspaceRoot,
    });

    await expect(instance.execute(makeIr(makeAction('int main() { return 0; }\n')), {
      signal: controller.signal,
      deadlineAt,
    })).resolves.toMatchObject({ status: 'success' });
    expect(observedSignal).toBe(controller.signal);
    expect(observedDeadline).toBe(deadlineAt);
  });

  it('rejects a malformed Native execution policy identity', () => {
    expect(() => executor(new FakeSandbox(), new MemoryActionCache(), 'not-a-sha256'))
      .toThrow(/policyIdentity must be a SHA-256 identity/);
  });

  it('rejects a malformed Native tool resolver policy identity', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-native-tool-policy-'));
    roots.push(workspaceRoot);
    expect(() => new NativeExecutor({
      sandbox: new FakeSandbox(),
      tools: { policyIdentity: 'not-a-sha256', resolve: () => 'fake-cc' },
      workspaceRoot,
    })).toThrow(/resolver policyIdentity must be a SHA-256 identity/);
  });

  it('propagates a non-cacheable custom Action through every dependent Action', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-native-non-cacheable-'));
    roots.push(workspaceRoot);
    const runnerCalls = new Map<string, number>();
    let cacheReads = 0;
    let cacheWrites = 0;
    const cache: ActionCache = {
      get: async () => { cacheReads += 1; return null; },
      put: async () => { cacheWrites += 1; },
    };
    const action = (
      id: string,
      input: string,
      output: string,
      dependencies: string[],
      cacheable = true,
    ) => ({
      id,
      kind: 'transform' as const,
      tool: `ck:${id}`,
      inputs: input === 'unused'
        ? [{ path: input, sha256: sha256Hex(''), role: 'source' }]
        : [{ path: input, role: 'generated' }],
      outputs: [{ path: output, kind: 'binary' }],
      arguments: [], environment: {}, dependencies, packDependencies: [],
      transform: { input, output, format: 'other' as const, flags: [] },
      cacheable,
    });
    const drafts = [
      action('compile', 'unused', 'build/a.bin', [], false),
      action('link', 'build/a.bin', 'build/b.bin', ['compile']),
      action('image', 'build/b.bin', 'build/c.bin', ['link']),
    ];
    const ir = createBuildIR({
      project: [{ path: 'unused', content: '' }],
      target: { fqbn: board.fqbn, options: {}, boardPack: board },
      packs,
      actions: drafts.map(({ cacheable: _cacheable, ...draft }) => draft),
      artifacts: [{ path: 'build/c.bin', format: 'bin' }],
      diagnosticMap: [],
    });
    const run = new NativeExecutor({
      sandbox: new FakeSandbox(),
      tools: { resolve: () => { throw new Error('custom Action unexpectedly used a native tool'); } },
      workspaceRoot,
      cache,
      runAction: ({ action: current }) => {
        runnerCalls.set(current.id, (runnerCalls.get(current.id) ?? 0) + 1);
        const draft = drafts.find((candidate) => candidate.id === current.id)!;
        const bytes = new Uint8Array([current.id.length]);
        return {
          outputs: [{ path: current.outputs[0]!.path, bytes, sha256: sha256Hex(bytes) }],
          ...(draft.cacheable ? {} : { cacheable: false }),
        };
      },
    });

    await expect(run.execute(ir)).resolves.toMatchObject({ status: 'success', actions: [
      { cached: false }, { cached: false }, { cached: false },
    ] });
    await expect(run.execute(ir)).resolves.toMatchObject({ status: 'success', actions: [
      { cached: false }, { cached: false }, { cached: false },
    ] });
    expect(Object.fromEntries(runnerCalls)).toEqual({ compile: 2, link: 2, image: 2 });
    expect(cacheReads).toBe(2);
    expect(cacheWrites).toBe(0);
  });

  it('passes only normalized resolver-approved tool roots to the sandbox', async () => {
    const sandbox = new FakeSandbox();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-native-mounts-'));
    const toolchainRoot = mkdtempSync(join(tmpdir(), 'ck-native-toolchain-'));
    roots.push(workspaceRoot, toolchainRoot);
    const bin = join(toolchainRoot, 'bin');
    mkdirSync(bin, { recursive: true });
    const command = join(bin, 'fake-cc');
    writeFileSync(command, 'compiler');
    const action = makeAction('int main() { return 0; }\n');
    action.arguments.push('/opt/from-untrusted-ir');
    const run = new NativeExecutor({
      sandbox,
      tools: {
        resolve: () => command,
        resolveForExecution: () => ({
          command,
          readOnlyPaths: [toolchainRoot, `${toolchainRoot}${sep}`, toolchainRoot],
        }),
      },
      workspaceRoot,
    });

    await expect(run.execute(makeIr(action))).resolves.toMatchObject({ status: 'success' });
    expect(sandbox.requests).toHaveLength(1);
    expect(sandbox.requests[0]!.readOnlyPaths).toEqual([toolchainRoot]);
    expect(sandbox.requests[0]!.readOnlyPaths).not.toContain('/opt/from-untrusted-ir');
    expect(sandbox.requests[0]!.readWritePaths).toHaveLength(1);
  });

  it('prepends only resolver-owned launcher arguments to the IR argv', async () => {
    const sandbox = new FakeSandbox();
    sandbox.exec = async (request: ExecRequest) => {
      sandbox.calls += 1;
      sandbox.requests.push(request);
      const output = join(request.cwd, 'build', 'main.o');
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, 'prefixed-output');
      return sandbox.result;
    };
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-native-prefix-'));
    roots.push(workspaceRoot);
    const run = new NativeExecutor({
      sandbox,
      tools: {
        resolve: () => 'unused',
        resolveForExecution: () => ({
          command: 'trusted-launcher',
          argumentsPrefix: ['host-private-entrypoint'],
        }),
      },
      workspaceRoot,
    });
    const ir = makeIr(makeAction('int main() { return 0; }\n'));

    await expect(run.execute(ir)).resolves.toMatchObject({ status: 'success' });
    expect(sandbox.requests[0]).toMatchObject({
      command: 'trusted-launcher',
      args: ['host-private-entrypoint', 'build/main.o'],
    });
    expect(JSON.stringify(ir)).not.toContain('host-private-entrypoint');
  });

  it('rejects a resolver mount that does not contain the approved command', async () => {
    const sandbox = new FakeSandbox();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ck-native-mounts-'));
    const toolchainRoot = mkdtempSync(join(tmpdir(), 'ck-native-toolchain-'));
    const unrelatedRoot = mkdtempSync(join(tmpdir(), 'ck-native-unrelated-'));
    roots.push(workspaceRoot, toolchainRoot, unrelatedRoot);
    const command = join(toolchainRoot, 'fake-cc');
    writeFileSync(command, 'compiler');
    const run = new NativeExecutor({
      sandbox,
      tools: {
        resolve: () => command,
        resolveForExecution: () => ({ command, readOnlyPaths: [unrelatedRoot] }),
      },
      workspaceRoot,
    });

    await expect(run.execute(makeIr(makeAction('int main() { return 0; }\n')))).resolves.toMatchObject({
      status: 'error', reason: 'tool', message: expect.stringMatching(/outside its approved/),
    });
    expect(sandbox.calls).toBe(0);
  });

  it('keeps ordinary /bin tools compatible without granting extra mounts', async () => {
    const sandbox = new FakeSandbox();
    const root = mkdtempSync(join(tmpdir(), 'ck-native-system-tool-'));
    roots.push(root);
    const run = new NativeExecutor({
      sandbox,
      tools: { resolve: () => '/bin/sh' },
      workspaceRoot: root,
    });

    await expect(run.execute(makeIr(makeAction('int main() { return 0; }\n')))).resolves.toMatchObject({
      status: 'success',
    });
    expect(sandbox.requests[0]).toMatchObject({ command: '/bin/sh', readOnlyPaths: [] });
  });

  it('maps successful compiler warnings and restores them on an Action cache hit', async () => {
    const sandbox = new FakeSandbox();
    sandbox.result = {
      code: 0, signal: null, stdout: '', stderr: 'src/main.cpp:1:2: warning: unused variable',
      durationMs: 0, timedOut: false, truncated: false,
    };
    const cache = new DiagnosticActionCache();
    const run = executor(sandbox, cache);
    const ir = makeIr(makeAction('int main() { return 0; }\n'));

    const first = await run.execute(ir);
    expect(first.status === 'success' && first.diagnostics[0]).toMatchObject({
      severity: 'warning', sourceFile: 'src/main.cpp', sourceLine: 1, fromGenerated: true,
    });
    expect(cache.entry?.diagnostics).toEqual(first.diagnostics);

    const second = await run.execute(ir);
    expect(second.status === 'success' && second.actions[0]).toMatchObject({ cached: true });
    expect(second.status === 'success' && second.diagnostics).toEqual(first.diagnostics);
    expect(sandbox.calls).toBe(1);
  });

  it('rejects an immutable source input whose hash does not match the snapshot', async () => {
    const sandbox = new FakeSandbox();
    const run = executor(sandbox);
    const ir = makeIr(makeAction('int main() { return 0; }\n', 'f'.repeat(64)));

    await expect(run.execute(ir)).resolves.toMatchObject({ status: 'error', reason: 'integrity', actionId: 'compile-main' });
    expect(sandbox.calls).toBe(0);
  });

  it('maps compiler diagnostics through the IR source map', async () => {
    const sandbox = new FakeSandbox();
    sandbox.result = {
      code: 1, signal: null, stdout: '', stderr: 'src/main.cpp:1:2: error: expected expression',
      durationMs: 0, timedOut: false, truncated: false,
    };
    const run = executor(sandbox);
    const result = await run.execute(makeIr(makeAction('int main() { return 0; }\n')));

    expect(result).toMatchObject({ status: 'error', reason: 'compile' });
    expect(result.status === 'error' && result.diagnostics[0]).toMatchObject({
      file: 'src/main.cpp', sourceFile: 'src/main.cpp', sourceLine: 1, fromGenerated: true,
    });
  });

  it('supports a compatibility Action runner without exposing compiler paths', async () => {
    const sandbox = new FakeSandbox();
    const root = mkdtempSync(join(tmpdir(), 'ck-native-runner-'));
    roots.push(root);
    const run = new NativeExecutor({
      sandbox,
      tools: { resolve: () => 'unused' },
      workspaceRoot: root,
      runAction: async ({ action }) => ({
        outputs: [{ path: action.outputs[0]!.path, bytes: new TextEncoder().encode('adapter'), sha256: sha256Hex('adapter') }],
      }),
    });
    const result = await run.execute(makeIr(makeAction('int main() { return 0; }\n')));
    expect(result).toMatchObject({ status: 'success', executor: 'native' });
    expect(sandbox.calls).toBe(0);
  });

  it('applies the Action CPU limit to a compatibility runner', async () => {
    const sandbox = new FakeSandbox();
    const root = mkdtempSync(join(tmpdir(), 'ck-native-runner-timeout-'));
    roots.push(root);
    const action = makeAction('int main() { return 0; }\n');
    action.resourceLimits = { cpuMs: 10 };
    const run = new NativeExecutor({
      sandbox,
      tools: { resolve: () => 'unused' },
      workspaceRoot: root,
      runAction: async ({ signal }) => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return undefined;
      },
    });

    await expect(run.execute(makeIr(action))).resolves.toMatchObject({
      status: 'error', reason: 'timeout', actionId: 'compile-main',
    });
    expect(sandbox.calls).toBe(0);
  });

  it('rejects synchronous Action output that returns after the job deadline', async () => {
    const sandbox = new FakeSandbox();
    const root = mkdtempSync(join(tmpdir(), 'ck-native-runner-wall-deadline-'));
    roots.push(root);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
    const bytes = new TextEncoder().encode('late-output');
    const run = new NativeExecutor({
      sandbox,
      tools: { resolve: () => 'unused' },
      workspaceRoot: root,
      runAction: ({ action }) => {
        clock.mockReturnValue(200);
        return {
          outputs: [{ path: action.outputs[0]!.path, bytes, sha256: sha256Hex(bytes) }],
        };
      },
    });

    try {
      await expect(run.execute(makeIr(makeAction('int main() { return 0; }\n')), {
        deadlineAt: 150,
      })).resolves.toMatchObject({ status: 'error', reason: 'timeout' });
      expect(sandbox.calls).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it('applies the Action output limit to compatibility runner outputs', async () => {
    const sandbox = new FakeSandbox();
    const root = mkdtempSync(join(tmpdir(), 'ck-native-runner-output-limit-'));
    roots.push(root);
    const action = makeAction('int main() { return 0; }\n');
    action.resourceLimits = { outputBytes: 4 };
    const bytes = new TextEncoder().encode('too-large');
    const run = new NativeExecutor({
      sandbox,
      tools: { resolve: () => 'unused' },
      workspaceRoot: root,
      runAction: ({ action: current }) => ({
        outputs: [{ path: current.outputs[0]!.path, bytes, sha256: sha256Hex(bytes) }],
      }),
    });

    await expect(run.execute(makeIr(action))).resolves.toMatchObject({
      status: 'error', reason: 'resource_limit', actionId: 'compile-main',
    });
    expect(sandbox.calls).toBe(0);
  });

  it('runs the shared IR validator before materializing the workspace', async () => {
    const sandbox = new FakeSandbox();
    const root = mkdtempSync(join(tmpdir(), 'ck-native-validator-'));
    roots.push(root);
    let seen = 0;
    const run = new NativeExecutor({
      sandbox,
      tools: { resolve: () => 'fake-cc' },
      workspaceRoot: root,
      validateIR: (ir) => {
        seen += 1;
        expect(ir.kind).toBe('ck-build-ir');
      },
    });
    const result = await run.execute(makeIr(makeAction('int main() { return 0; }\n')));
    expect(result.status).toBe('success');
    expect(seen).toBe(1);
    expect(sandbox.calls).toBe(1);
  });

  it('migrates a v0 Build IR before local and shared validation', async () => {
    const sandbox = new FakeSandbox();
    const root = mkdtempSync(join(tmpdir(), 'ck-native-v0-migration-'));
    roots.push(root);
    const current = makeIr(makeAction('int main() { return 0; }\n'));
    const legacy = {
      kind: 'ck-build-ir',
      schemaVersion: 0,
      project: current.project.files.map((file) => ({
        name: file.path,
        content: file.content,
        language: file.language,
        generated: file.generated,
      })),
      target: { board: current.target.fqbn, options: current.target.options, boardPack: current.target.boardPack },
      packs: current.packs,
      actions: current.graph.actions,
      artifacts: current.artifacts,
      diagnostics: current.diagnosticMap.entries,
    };
    let validatedVersion: number | undefined;
    const run = new NativeExecutor({
      sandbox,
      tools: { resolve: () => 'fake-cc' },
      workspaceRoot: root,
      validateIR: (ir) => { validatedVersion = ir.schemaVersion; },
    });

    await expect(run.execute(legacy as unknown as BuildIR)).resolves.toMatchObject({ status: 'success' });
    expect(validatedVersion).toBe(1);
    expect(sandbox.calls).toBe(1);
  });

  it('rejects a future Build IR version before execution', async () => {
    const sandbox = new FakeSandbox();
    const run = executor(sandbox);
    const future = { ...makeIr(makeAction('int main() { return 0; }\n')), schemaVersion: 99 };

    await expect(run.execute(future as unknown as BuildIR)).resolves.toMatchObject({
      status: 'error', reason: 'invalid_ir',
    });
    expect(sandbox.calls).toBe(0);
  });

  it('turns a shared IR validator rejection into an invalid_ir result', async () => {
    const sandbox = new FakeSandbox();
    const root = mkdtempSync(join(tmpdir(), 'ck-native-validator-reject-'));
    roots.push(root);
    const run = new NativeExecutor({
      sandbox,
      tools: { resolve: () => 'fake-cc' },
      workspaceRoot: root,
      validateIR: () => { throw new Error('schema parity failure'); },
    });
    const result = await run.execute(makeIr(makeAction('int main() { return 0; }\n')));
    expect(result).toMatchObject({ status: 'error', reason: 'invalid_ir' });
    expect(result.message).toContain('schema parity failure');
    expect(sandbox.calls).toBe(0);
  });

  it('falls back to the logical tool when an Action adapter declines a task', async () => {
    const sandbox = new FakeSandbox();
    const root = mkdtempSync(join(tmpdir(), 'ck-native-fallback-'));
    roots.push(root);
    const run = new NativeExecutor({
      sandbox,
      tools: { resolve: (tool) => tool === 'tool:test-cc' ? 'fake-cc' : (() => { throw new Error('unknown tool'); })() },
      workspaceRoot: root,
      runAction: () => undefined,
    });
    const result = await run.execute(makeIr(makeAction('int main() { return 0; }\n')));
    expect(result).toMatchObject({ status: 'success', executor: 'native' });
    expect(sandbox.calls).toBe(1);
  });

  it('forwards cancellation to the running sandbox command', async () => {
    const sandbox = new FakeSandbox();
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => { commandStarted = resolve; });
    sandbox.exec = async (req: ExecRequest) => {
      sandbox.calls += 1;
      commandStarted();
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) resolve();
        else req.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        code: null, signal: 'SIGKILL', stdout: '', stderr: '',
        durationMs: 1, timedOut: false, truncated: false,
      };
    };
    const run = executor(sandbox);
    const controller = new AbortController();
    const result = run.execute(makeIr(makeAction('int main() { return 0; }\n')), {
      signal: controller.signal,
    });

    await started;
    controller.abort();
    await expect(result).resolves.toMatchObject({ status: 'error', reason: 'cancelled' });
    expect(sandbox.calls).toBe(1);
  });

  it('does not start a sandbox command for an already cancelled build', async () => {
    const sandbox = new FakeSandbox();
    const run = executor(sandbox);
    const controller = new AbortController();
    controller.abort();
    await expect(run.execute(makeIr(makeAction('int main() { return 0; }\n')), {
      signal: controller.signal,
    })).resolves.toMatchObject({ status: 'error', reason: 'cancelled' });
    expect(sandbox.calls).toBe(0);
  });
});

describe('FileActionCache', () => {
  it('persists verified Action blobs across cache instances', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-action-cache-'));
    roots.push(root);
    const bytes = new TextEncoder().encode('same output');
    const digest = sha256Hex(bytes);
    const actionKey = 'e'.repeat(64);
    await new FileActionCache(root).put({
      actionKey,
      outputs: [
        { path: 'build/a.o', bytes, sha256: digest },
        { path: 'build/b.o', bytes: new Uint8Array(bytes), sha256: digest },
      ],
      diagnostics: [{
        severity: 'warning', file: 'src/main.cpp', line: 1, message: 'cached warning',
        sourceFile: 'src/main.cpp', sourceLine: 1, fromGenerated: false,
      }],
    });
    const entry = await new FileActionCache(root).get(actionKey);
    expect(entry?.outputs.map((output) => output.path)).toEqual(['build/a.o', 'build/b.o']);
    expect(entry?.outputs[0]?.bytes).toEqual(bytes);
    expect(entry?.diagnostics).toEqual([expect.objectContaining({ message: 'cached warning' })]);
  });

  it('evicts the least recently used entry when the local entry limit is exceeded', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-action-cache-'));
    roots.push(root);
    const cache = new FileActionCache(root, {
      ttlMs: 60_000,
      maxEntries: 1,
      maxTotalBytes: 1024 * 1024,
      pruneIntervalMs: 0,
    });
    const bytes = new TextEncoder().encode('cached output');
    const digest = sha256Hex(bytes);
    const olderKey = 'a'.repeat(64);
    const newerKey = 'b'.repeat(64);
    await cache.put({ actionKey: olderKey, outputs: [{ path: 'build/a.o', bytes, sha256: digest }] });
    const old = new Date(Date.now() - 5_000);
    utimesSync(join(root, 'aa', olderKey, 'manifest.json'), old, old);
    await cache.put({ actionKey: newerKey, outputs: [{ path: 'build/b.o', bytes, sha256: digest }] });

    expect(await cache.get(olderKey)).toBeNull();
    expect(await cache.get(newerKey)).not.toBeNull();
  });

  it('does not retain an entry that exceeds the local byte budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-action-cache-'));
    roots.push(root);
    const cache = new FileActionCache(root, {
      ttlMs: 60_000,
      maxEntries: 10,
      maxTotalBytes: 1_024,
      pruneIntervalMs: 0,
    });
    const bytes = new Uint8Array(2_048).fill(7);
    const actionKey = 'd'.repeat(64);
    await cache.put({
      actionKey,
      outputs: [{ path: 'build/large.o', bytes, sha256: sha256Hex(bytes) }],
    });

    expect(await cache.get(actionKey)).toBeNull();
  });

  it('removes expired entries and stale writer directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-action-cache-'));
    roots.push(root);
    const cache = new FileActionCache(root, {
      ttlMs: 1_000,
      maxEntries: 10,
      maxTotalBytes: 1024 * 1024,
      pruneIntervalMs: 60_000,
    });
    const bytes = new TextEncoder().encode('cached output');
    const digest = sha256Hex(bytes);
    const actionKey = 'c'.repeat(64);
    await cache.put({ actionKey, outputs: [{ path: 'build/a.o', bytes, sha256: digest }] });
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(root, 'cc', actionKey, 'manifest.json'), old, old);
    const temporary = join(root, 'cc', '.action-abandoned');
    mkdirSync(temporary);
    utimesSync(temporary, old, old);

    await cache.prune();

    expect(await cache.get(actionKey)).toBeNull();
    expect(existsSync(temporary)).toBe(false);
  });
});
