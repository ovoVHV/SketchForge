import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createNativeToolIntegrityManifest,
  createNativeToolClosureManifest,
  DeadlineExceededError,
  DefaultNativeToolResolver,
  FileSystemNativePackProvider,
  OperationCancelledError,
  sha256Hex,
  type BoardPackRef,
  type BuildPacks,
} from '../src/index.js';
import { contentIdentity } from '../src/cache/identity.js';
import { normalizeNativeToolResolution } from '../src/executor/native.js';

const board: BoardPackRef = {
  kind: 'board',
  id: 'board:test',
  version: '1.0.0',
  sha256: 'b'.repeat(64),
  fqbn: 'arduino:avr:uno',
  variant: 'standard',
};

const packs: BuildPacks = {
  toolchain: {
    kind: 'toolchain', id: 'tool:test', version: '1.0.0', sha256: 'a'.repeat(64),
    abi: 'avr', instructionSet: 'atmega328p',
  },
  platform: {
    kind: 'platform', id: 'platform:test', version: '1.0.0', sha256: 'c'.repeat(64),
    platform: 'avr',
  },
  board,
  libraries: { roots: ['library:demo@1.0.0'], packs: [{
    kind: 'library', id: 'library:demo@1.0.0', name: 'Demo', version: '1.0.0', sha256: 'd'.repeat(64),
    architectures: ['*'], manifest: { name: 'Demo', version: '1.0.0' }, dependencies: [],
  }] },
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('FileSystemNativePackProvider', () => {
  it('rejects ambiguous logical Library Pack revisions before materialization', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ck-pack-workspace-'));
    roots.push(workspace);
    const first = packs.libraries.packs[0]!;
    const second = {
      ...first,
      id: 'library:demo-other@1.0.0',
      sha256: 'e'.repeat(64),
    };

    expect(() => new FileSystemNativePackProvider().materialize({
      ...packs,
      libraries: { roots: [first.id], packs: [first, second] },
    }, workspace)).toThrow(/ambiguous library pack demo@1\.0\.0: multiple revisions/i);
  });

  it('does not begin Pack materialization after the job deadline', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-pack-deadline-'));
    const workspace = mkdtempSync(join(tmpdir(), 'ck-pack-deadline-workspace-'));
    roots.push(root, workspace);
    const bytes = new TextEncoder().encode('#pragma once\n');
    writeFileSync(join(root, 'Arduino.h'), bytes);
    const provider = new FileSystemNativePackProvider({
      platform: {
        root,
        destination: 'packs/platform/core',
        sha256: packs.platform.sha256,
        contentSha256: contentIdentity(root),
        files: [{ path: 'Arduino.h', sha256: sha256Hex(bytes) }],
      },
    });

    expect(() => provider.materialize(packs, workspace, {
      deadlineAt: Date.now() - 1,
    })).toThrow(DeadlineExceededError);
    expect(existsSync(join(workspace, 'packs', 'platform', 'core', 'Arduino.h'))).toBe(false);
  });

  it('materializes selected Pack files at logical workspace paths and verifies hashes', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-pack-provider-'));
    const workspace = mkdtempSync(join(tmpdir(), 'ck-pack-workspace-'));
    roots.push(root, workspace);
    mkdirSync(join(root, 'core'), { recursive: true });
    const platformBytes = new TextEncoder().encode('#pragma once\n');
    writeFileSync(join(root, 'core', 'Arduino.h'), platformBytes);
    writeFileSync(join(root, 'ignored.txt'), 'ignored');
    const sourceBytes = new TextEncoder().encode('int demo() { return 1; }\n');
    const libraryRoot = join(root, 'library');
    mkdirSync(libraryRoot, { recursive: true });
    writeFileSync(join(libraryRoot, 'Demo.cpp'), sourceBytes);

    new FileSystemNativePackProvider({
      platform: {
        root: join(root, 'core'),
        destination: 'packs/platform/core',
        sha256: packs.platform.sha256,
        contentSha256: contentIdentity(join(root, 'core')),
        files: [{ path: 'Arduino.h', sha256: sha256Hex(platformBytes) }],
      },
      libraries: new Map([[packs.libraries.packs[0]!.id, {
        root: libraryRoot,
        destination: 'packs/libraries/demo',
        sha256: packs.libraries.packs[0]!.sha256,
        contentSha256: contentIdentity(libraryRoot),
        files: [{ path: 'Demo.cpp', sha256: sha256Hex(sourceBytes) }],
      }]]),
    }).materialize(packs, workspace);

    expect(readFileSync(join(workspace, 'packs', 'platform', 'core', 'Arduino.h'), 'utf8'))
      .toBe('#pragma once\n');
    expect(readFileSync(join(workspace, 'packs', 'libraries', 'demo', 'Demo.cpp'), 'utf8'))
      .toBe('int demo() { return 1; }\n');
    expect(() => readFileSync(join(workspace, 'packs', 'platform', 'core', 'ignored.txt'))).toThrow();
  });

  it('rejects a declared Pack identity mismatch before writing files', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-pack-provider-'));
    const workspace = mkdtempSync(join(tmpdir(), 'ck-pack-workspace-'));
    roots.push(root, workspace);
    const bytes = new TextEncoder().encode('#pragma once\n');
    writeFileSync(join(root, 'file.h'), bytes);
    expect(() => new FileSystemNativePackProvider({
      platform: {
        root,
        sha256: 'f'.repeat(64),
        contentSha256: contentIdentity(root),
        files: [{ path: 'file.h', sha256: sha256Hex(bytes) }],
      },
    }).materialize(packs, workspace)).toThrow(/Pack identity mismatch/);
  });

  it('requires a planning-time content digest by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-pack-provider-'));
    const workspace = mkdtempSync(join(tmpdir(), 'ck-pack-workspace-'));
    roots.push(root, workspace);
    const bytes = new TextEncoder().encode('#pragma once\n');
    writeFileSync(join(root, 'file.h'), bytes);
    expect(() => new FileSystemNativePackProvider({
      platform: {
        root,
        sha256: packs.platform.sha256,
        files: [{ path: 'file.h', sha256: sha256Hex(bytes) }],
      } as never,
    }).materialize(packs, workspace)).toThrow(/missing or invalid content hash/);
  });

  it('rejects a source without an exact Pack identity or file manifest hash', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-pack-provider-'));
    const workspace = mkdtempSync(join(tmpdir(), 'ck-pack-workspace-'));
    roots.push(root, workspace);
    writeFileSync(join(root, 'file.h'), '#pragma once\n');

    expect(() => new FileSystemNativePackProvider({
      platform: { root, files: [] } as never,
    }).materialize(packs, workspace)).toThrow(/missing or invalid source hash/);
    expect(() => new FileSystemNativePackProvider({
      platform: {
        root,
        sha256: packs.platform.sha256,
        contentSha256: contentIdentity(root),
        files: [{ path: 'file.h' }],
      } as never,
    }).materialize(packs, workspace)).toThrow(/invalid file hash/);
  });

  it('reuses content-addressed blobs without rereading an unavailable source file', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-pack-provider-'));
    const firstWorkspace = mkdtempSync(join(tmpdir(), 'ck-pack-workspace-'));
    const secondWorkspace = mkdtempSync(join(tmpdir(), 'ck-pack-workspace-'));
    const casRoot = mkdtempSync(join(tmpdir(), 'ck-pack-cas-'));
    roots.push(root, firstWorkspace, secondWorkspace, casRoot);
    const bytes = new TextEncoder().encode('#pragma once\n');
    const hash = sha256Hex(bytes);
    const sourcePath = join(root, 'Arduino.h');
    writeFileSync(sourcePath, bytes);
    const options = {
      platform: {
        root,
        destination: 'packs/platform/core',
        sha256: packs.platform.sha256,
        contentSha256: contentIdentity(root),
        files: [{ path: 'Arduino.h', sha256: hash }],
      },
      casRoot,
    };

    new FileSystemNativePackProvider(options).materialize(packs, firstWorkspace);
    rmSync(sourcePath);
    new FileSystemNativePackProvider(options).materialize(packs, secondWorkspace);

    expect(readFileSync(join(secondWorkspace, 'packs', 'platform', 'core', 'Arduino.h'), 'utf8'))
      .toBe('#pragma once\n');
    expect(readFileSync(join(casRoot, 'sha256', hash.slice(0, 2), hash), 'utf8'))
      .toBe('#pragma once\n');
  });

  it('revalidates a Pack CAS blob when its filesystem snapshot changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-pack-provider-'));
    const firstWorkspace = mkdtempSync(join(tmpdir(), 'ck-pack-workspace-'));
    const secondWorkspace = mkdtempSync(join(tmpdir(), 'ck-pack-workspace-'));
    const casRoot = mkdtempSync(join(tmpdir(), 'ck-pack-cas-'));
    roots.push(root, firstWorkspace, secondWorkspace, casRoot);
    const bytes = new TextEncoder().encode('#pragma once\n');
    const hash = sha256Hex(bytes);
    writeFileSync(join(root, 'Arduino.h'), bytes);
    const options = {
      platform: {
        root,
        destination: 'packs/platform/core',
        sha256: packs.platform.sha256,
        contentSha256: contentIdentity(root),
        files: [{ path: 'Arduino.h', sha256: hash }],
      },
      casRoot,
    };
    const provider = new FileSystemNativePackProvider(options);
    provider.materialize(packs, firstWorkspace);
    const blob = join(casRoot, 'sha256', hash.slice(0, 2), hash);
    writeFileSync(
      blob,
      new TextEncoder().encode('#pragma pack\n'),
    );
    const changed = new Date(Date.now() + 1_000);
    utimesSync(blob, changed, changed);

    expect(() => provider.materialize(packs, secondWorkspace)).toThrow(/Pack CAS hash mismatch/);
    expect(existsSync(blob)).toBe(false);
    const recoveredWorkspace = mkdtempSync(join(tmpdir(), 'ck-pack-workspace-'));
    roots.push(recoveredWorkspace);
    provider.materialize(packs, recoveredWorkspace);
    expect(readFileSync(join(recoveredWorkspace, 'packs', 'platform', 'core', 'Arduino.h'))).toEqual(Buffer.from(bytes));
  });

  it('bounds Pack CAS bytes without invalidating materialized workspace files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-pack-provider-'));
    const workspace = mkdtempSync(join(tmpdir(), 'ck-pack-workspace-'));
    const casRoot = mkdtempSync(join(tmpdir(), 'ck-pack-cas-'));
    roots.push(root, workspace, casRoot);
    const first = new TextEncoder().encode('first pack blob');
    const second = new TextEncoder().encode('newer pack blob');
    const firstHash = sha256Hex(first);
    const secondHash = sha256Hex(second);
    writeFileSync(join(root, 'first.h'), first);
    writeFileSync(join(root, 'second.h'), second);
    const provider = new FileSystemNativePackProvider({
      platform: {
        root,
        destination: 'packs/platform/core',
        sha256: packs.platform.sha256,
        contentSha256: contentIdentity(root),
        files: [
          { path: 'first.h', sha256: firstHash },
          { path: 'second.h', sha256: secondHash },
        ],
      },
      casRoot,
      casLimits: {
        ttlMs: 0,
        maxEntries: 10,
        maxTotalBytes: second.byteLength,
        pruneIntervalMs: Number.MAX_SAFE_INTEGER,
      },
    });
    provider.materialize(packs, workspace);
    const firstBlob = join(casRoot, 'sha256', firstHash.slice(0, 2), firstHash);
    const secondBlob = join(casRoot, 'sha256', secondHash.slice(0, 2), secondHash);
    const old = new Date(Date.now() - 10 * 60_000);
    const recent = new Date(Date.now() - 1_000);
    utimesSync(firstBlob, old, old);
    utimesSync(secondBlob, recent, recent);
    const temporary = `${secondBlob}.${process.pid}.00000000-0000-4000-8000-000000000000.tmp`;
    writeFileSync(temporary, 'partial');
    utimesSync(temporary, old, old);

    const result = await provider.pruneCas();

    expect(result).toMatchObject({ scannedEntries: 2, removedEntries: 1, totalEntries: 1, quotaSatisfied: true });
    expect(existsSync(firstBlob)).toBe(false);
    expect(existsSync(secondBlob)).toBe(true);
    expect(existsSync(temporary)).toBe(false);
    expect(readFileSync(join(workspace, 'packs', 'platform', 'core', 'first.h'))).toEqual(Buffer.from(first));
  });

  it('can verify the deterministic host-tree digest independently of Pack identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-pack-provider-'));
    const workspace = mkdtempSync(join(tmpdir(), 'ck-pack-workspace-'));
    roots.push(root, workspace);
    const bytes = new TextEncoder().encode('#pragma once\n');
    writeFileSync(join(root, 'file.h'), bytes);
    expect(() => new FileSystemNativePackProvider({
      platform: {
        root,
        sha256: packs.platform.sha256,
        contentSha256: 'f'.repeat(64),
        files: [{ path: 'file.h', sha256: sha256Hex(bytes) }],
      },
    }).materialize(packs, workspace)).toThrow(/content hash mismatch/);
  });

  it('rejects a change outside the copied file allowlist', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-pack-provider-'));
    const workspace = mkdtempSync(join(tmpdir(), 'ck-pack-workspace-'));
    roots.push(root, workspace);
    const bytes = new TextEncoder().encode('#pragma once\n');
    writeFileSync(join(root, 'file.h'), bytes);
    writeFileSync(join(root, 'pack.metadata'), 'revision-a');
    const contentSha256 = contentIdentity(root);
    writeFileSync(join(root, 'pack.metadata'), 'revision-b');

    expect(() => new FileSystemNativePackProvider({
      platform: {
        root,
        sha256: packs.platform.sha256,
        contentSha256,
        files: [{ path: 'file.h', sha256: sha256Hex(bytes) }],
      },
    }).materialize(packs, workspace)).toThrow(/content hash mismatch/);
  });

  it('does not overwrite a different project file at a Pack path', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-pack-provider-'));
    const workspace = mkdtempSync(join(tmpdir(), 'ck-pack-workspace-'));
    roots.push(root, workspace);
    mkdirSync(join(root, 'core'), { recursive: true });
    writeFileSync(join(root, 'core', 'Arduino.h'), 'pack\n');
    mkdirSync(join(workspace, 'packs', 'platform', 'core'), { recursive: true });
    writeFileSync(join(workspace, 'packs', 'platform', 'core', 'Arduino.h'), 'project\n');
    expect(() => new FileSystemNativePackProvider({
      platform: {
        root: join(root, 'core'),
        destination: 'packs/platform/core',
        sha256: packs.platform.sha256,
        contentSha256: contentIdentity(join(root, 'core')),
        files: [{ path: 'Arduino.h', sha256: sha256Hex('pack\n') }],
      },
    }).materialize(packs, workspace)).toThrow(/workspace path collision/);
  });
});

describe('DefaultNativeToolResolver', () => {
  it('captures a deterministic recursive regular-file closure', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-tool-closure-'));
    roots.push(root);
    mkdirSync(join(root, 'libexec'), { recursive: true });
    mkdirSync(join(root, 'sysroot', 'include'), { recursive: true });
    writeFileSync(join(root, 'sysroot', 'include', 'stdint.h'), 'stdint-v1');
    writeFileSync(join(root, 'libexec', 'cc1'), 'cc1-v1');
    writeFileSync(join(root, 'runtime.dll'), 'runtime-v1');

    const first = createNativeToolClosureManifest(root);
    const second = createNativeToolClosureManifest(root);

    expect(second).toEqual(first);
    expect(first.files).toEqual([
      { path: 'libexec/cc1', type: 'file', size: 6, sha256: sha256Hex('cc1-v1') },
      { path: 'runtime.dll', type: 'file', size: 10, sha256: sha256Hex('runtime-v1') },
      { path: 'sysroot/include/stdint.h', type: 'file', size: 9, sha256: sha256Hex('stdint-v1') },
    ]);
    expect(first).toMatchObject({ schemaVersion: 1, fileCount: 3, totalBytes: 25 });
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a symlink or junction that can escape an authorized closure root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ck-native-tool-closure-link-'));
    roots.push(parent);
    const root = join(parent, 'toolchain');
    const outside = join(parent, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'payload'), 'outside');
    symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => createNativeToolClosureManifest(root)).toThrow(/symbolic link/);
  });

  it('enforces bounded closure traversal and observes an expired deadline', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-tool-closure-limits-'));
    roots.push(root);
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'first'), '1234');
    writeFileSync(join(root, 'second'), '5678');

    expect(() => createNativeToolClosureManifest(root, {
      limits: { maxFiles: 1 },
    })).toThrow(/file count limit/);
    expect(() => createNativeToolClosureManifest(root, {
      limits: { maxFileBytes: 3 },
    })).toThrow(/single-file byte limit/);
    expect(() => createNativeToolClosureManifest(root, {
      limits: { maxTotalBytes: 7 },
    })).toThrow(/total byte limit/);
    expect(() => createNativeToolClosureManifest(root, {
      limits: { maxDirectories: 1 },
    })).toThrow(/directory count limit/);
    expect(() => createNativeToolClosureManifest(root, {
      limits: { maxDepth: 0 },
    })).toThrow(/directory depth limit/);
    expect(() => createNativeToolClosureManifest(root, {
      limits: { maxDirectoryEntries: 1 },
    })).toThrow(/per-directory entry limit/);
    writeFileSync(join(root, 'éé'), 'utf8-path');
    expect(() => createNativeToolClosureManifest(root, {
      limits: { maxPathBytes: 3 },
    })).toThrow(/relative path byte limit/);
    expect(() => createNativeToolClosureManifest(root, {
      limits: { maxManifestBytes: 1 },
    })).toThrow(/serialized manifest byte limit/);
    expect(() => createNativeToolClosureManifest(root, {
      deadlineAt: Date.now() - 1,
    })).toThrow(DeadlineExceededError);
    const controller = new AbortController();
    controller.abort();
    expect(() => createNativeToolClosureManifest(root, {
      signal: controller.signal,
    })).toThrow(OperationCancelledError);
    expect(() => createNativeToolClosureManifest(parse(root).root)).toThrow(/too broad/);
  });

  it.runIf(process.platform === 'win32')(
    'keeps Unicode case-fold collisions as distinct filesystem roots',
    () => {
      const parent = mkdtempSync(join(tmpdir(), 'ck-native-tool-unicode-root-'));
      roots.push(parent);
      const latinRoot = join(parent, 'K');
      const kelvinRoot = join(parent, String.fromCodePoint(0x212a));
      const bin = join(latinRoot, 'bin');
      mkdirSync(bin, { recursive: true });
      mkdirSync(kelvinRoot, { recursive: true });
      const compiler = join(bin, 'riscv32-esp-elf-g++.exe');
      const esptool = join(kelvinRoot, 'esptool.exe');
      writeFileSync(compiler, 'compiler-v1');
      writeFileSync(join(latinRoot, 'helper.dll'), 'latin-helper');
      writeFileSync(esptool, 'esptool-v1');
      writeFileSync(join(kelvinRoot, 'helper.dll'), 'kelvin-helper');
      const espPacks: BuildPacks = {
        ...packs,
        board: { ...board, id: 'board:esp32c3', fqbn: 'esp32:esp32:esp32c3' },
        toolchain: { ...packs.toolchain, id: 'tool:esp32', abi: 'riscv32' },
      };
      const options = {
        esp32: {
          riscvBinDir: bin,
          riscvRootDir: latinRoot,
          coreDir: join(parent, 'core'),
          variantsDir: join(parent, 'variants'),
          platformDir: join(parent, 'platform'),
          esptool,
          sdkRootFor: () => null,
        },
      };

      const integrity = createNativeToolIntegrityManifest(
        options,
        espPacks,
        ['toolchain:cxx', 'toolchain:esptool'],
      );
      expect(integrity['toolchain:cxx']!.closure.sha256)
        .not.toBe(integrity['toolchain:esptool']!.closure.sha256);
      expect(() => new DefaultNativeToolResolver({ ...options, integrity })
        .verifyForExecution(espPacks)).not.toThrow();
      expect(() => normalizeNativeToolResolution({
        command: esptool,
        readOnlyPaths: [latinRoot],
      }, 'toolchain:esptool')).toThrow(/outside its approved read-only root/);
    },
  );

  it('maps AVR planner tools to the configured native toolchain', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-tool-resolver-'));
    roots.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const suffix = process.platform === 'win32' ? '.exe' : '';
    for (const name of ['avr-gcc', 'avr-g++', 'avr-gcc-ar', 'avr-objcopy']) writeFileSync(join(bin, `${name}${suffix}`), '');
    const options = {
      avr: { binDir: bin, coreDir: join(root, 'core'), variantsDir: join(root, 'variants') },
    };
    const tools = ['toolchain:cc', 'toolchain:cxx', 'toolchain:ar', 'toolchain:objcopy'];
    const integrity = createNativeToolIntegrityManifest(options, packs, tools);
    const resolver = new DefaultNativeToolResolver({ ...options, integrity });
    expect(resolver.resolve('toolchain:cc', packs)).toMatch(/avr-gcc(?:\.exe)?$/);
    expect(resolver.resolve('toolchain:cxx', packs)).toMatch(/avr-g\+\+(?:\.exe)?$/);
    expect(resolver.resolve('toolchain:ar', packs)).toMatch(/avr-gcc-ar(?:\.exe)?$/);
    expect(resolver.resolve('toolchain:objcopy', packs)).toMatch(/avr-objcopy(?:\.exe)?$/);
  });

  it('grants an /opt-style verified toolchain root for sandbox execution', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-tool-resolver-'));
    roots.push(root);
    const toolchainRoot = join(root, 'opt', 'avr-gcc');
    const bin = join(toolchainRoot, 'bin');
    mkdirSync(bin, { recursive: true });
    const command = join(bin, `avr-gcc${process.platform === 'win32' ? '.exe' : ''}`);
    writeFileSync(command, 'compiler-a');
    const options = {
      avr: {
        binDir: bin,
        rootDir: toolchainRoot,
        coreDir: join(root, 'core'),
        variantsDir: join(root, 'variants'),
      },
    };
    const integrity = createNativeToolIntegrityManifest(options, packs, ['toolchain:cc']);
    const resolution = new DefaultNativeToolResolver({ ...options, integrity })
      .resolveForExecution('toolchain:cc', packs);

    expect(resolution.command).toBe(command);
    expect(resolution.readOnlyPaths).toEqual([toolchainRoot]);
  });

  it('normalizes duplicate approved roots and rejects a filesystem-wide mount', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-tool-resolution-'));
    roots.push(root);
    const toolchainRoot = join(root, 'toolchain');
    const bin = join(toolchainRoot, 'bin');
    mkdirSync(bin, { recursive: true });
    const command = join(bin, 'compiler');
    writeFileSync(command, 'compiler-a');

    expect(normalizeNativeToolResolution({
      command,
      readOnlyPaths: [toolchainRoot, `${toolchainRoot}${sep}`, toolchainRoot],
    }, 'toolchain:cc').readOnlyPaths).toEqual([toolchainRoot]);
    expect(() => normalizeNativeToolResolution({
      command,
      readOnlyPaths: [parse(command).root],
    }, 'toolchain:cc')).toThrow(/too broad/);
  });

  it('keeps a mounted script entrypoint in a host-private argument prefix', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-tool-script-resolution-'));
    roots.push(root);
    const tools = join(root, 'platform', 'tools');
    const script = join(tools, 'gen_esp32part.py');
    mkdirSync(tools, { recursive: true });
    writeFileSync(script, 'print("partition tool")\n');

    const resolution = normalizeNativeToolResolution({
      command: 'python3',
      argumentsPrefix: [script],
      entrypoint: script,
      readOnlyPaths: [tools],
    }, 'platform:gen-esp32part');

    expect(resolution).toEqual({
      command: 'python3',
      argumentsPrefix: [script],
      entrypoint: script,
      readOnlyPaths: [tools],
    });
    expect(normalizeNativeToolResolution(resolution, 'platform:gen-esp32part')).toEqual(resolution);
  });

  it('rejects relative, missing, and out-of-root toolchain mount configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-tool-resolver-'));
    roots.push(root);
    const bin = join(root, 'actual', 'bin');
    const approved = join(root, 'approved');
    mkdirSync(bin, { recursive: true });
    mkdirSync(approved, { recursive: true });
    const command = join(bin, `avr-gcc${process.platform === 'win32' ? '.exe' : ''}`);
    writeFileSync(command, 'compiler-a');
    const base = {
      avr: { binDir: bin, rootDir: join(root, 'actual'), coreDir: join(root, 'core'), variantsDir: join(root, 'variants') },
    };
    const integrity = createNativeToolIntegrityManifest(base, packs, ['toolchain:cc']);

    expect(() => new DefaultNativeToolResolver({
      ...base,
      avr: { ...base.avr, rootDir: 'relative-toolchain' },
      integrity,
    }).resolveForExecution('toolchain:cc', packs)).toThrow(/must be absolute/);
    expect(() => new DefaultNativeToolResolver({
      ...base,
      avr: { ...base.avr, rootDir: join(root, 'missing') },
      integrity,
    }).resolveForExecution('toolchain:cc', packs)).toThrow(/does not exist/);
    expect(() => new DefaultNativeToolResolver({
      ...base,
      avr: { ...base.avr, rootDir: approved },
      integrity,
    }).resolveForExecution('toolchain:cc', packs)).toThrow(/outside its authorized closure/);
  });

  it('derives the ESP32 RISC-V prefix from the Board and Toolchain Pack', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-tool-resolver-'));
    roots.push(root);
    const toolchainRoot = join(root, 'toolchain');
    const bin = join(toolchainRoot, 'bin');
    const esptoolRoot = join(root, 'esptool');
    const esptool = join(esptoolRoot, 'esptool');
    const python = join(root, 'python3');
    mkdirSync(bin, { recursive: true });
    mkdirSync(esptoolRoot, { recursive: true });
    writeFileSync(python, 'fake-python3-v1');
    const suffix = process.platform === 'win32' ? '.exe' : '';
    writeFileSync(join(bin, `riscv32-esp-elf-g++${suffix}`), '');
    writeFileSync(esptool, '');
    mkdirSync(join(root, 'platform', 'tools'), { recursive: true });
    writeFileSync(
      join(root, 'platform', 'tools', process.platform === 'win32' ? 'gen_esp32part.exe' : 'gen_esp32part.py'),
      '',
    );
    const espPacks: BuildPacks = {
      ...packs,
      board: { ...board, id: 'board:c3', fqbn: 'esp32:esp32:esp32c3' },
      toolchain: { ...packs.toolchain, id: 'tool:esp32', abi: 'riscv32' },
    };
    const options = {
      hostPlatform: process.platform,
      ...(process.platform === 'win32' ? {} : {
        pythonInterpreter: {
          command: python,
          commandSha256: sha256Hex(readFileSync(python)),
          authorizedDirectory: root,
        },
      }),
      esp32: {
        riscvBinDir: bin, riscvRootDir: toolchainRoot,
        coreDir: join(root, 'core'), variantsDir: join(root, 'variants'),
        platformDir: join(root, 'platform'), esptool, sdkRootFor: () => null,
      },
    };
    const tools = ['toolchain:cxx', 'toolchain:esptool', 'platform:gen-esp32part'];
    const integrity = createNativeToolIntegrityManifest(options, espPacks, tools);
    const resolver = new DefaultNativeToolResolver({ ...options, integrity });
    expect(resolver.resolve('toolchain:cxx', espPacks)).toMatch(/riscv32-esp-elf-g\+\+(?:\.exe)?$/);
    expect(resolver.resolve('toolchain:esptool', espPacks)).toBe(esptool);
    expect(resolver.resolve('platform:gen-esp32part', espPacks)).toBe(join(
      root,
      'platform',
      'tools',
      process.platform === 'win32' ? 'gen_esp32part.exe' : 'gen_esp32part.py',
    ));
    expect(resolver.resolveForExecution('toolchain:cxx', espPacks).readOnlyPaths)
      .toEqual([toolchainRoot]);
    expect(resolver.resolveForExecution('toolchain:esptool', espPacks).readOnlyPaths)
      .toEqual([esptoolRoot]);
    expect(resolver.resolveForExecution('platform:gen-esp32part', espPacks).readOnlyPaths)
      .toEqual(process.platform === 'win32'
        ? [join(root, 'platform', 'tools')]
        : [join(root, 'platform', 'tools'), root]);
  });

  it('maps the POSIX partition tool to python3 without putting its script in Build IR', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-posix-partition-tool-'));
    roots.push(root);
    const tools = join(root, 'platform', 'tools');
    const script = join(tools, 'gen_esp32part.py');
    const python = join(root, 'python3');
    mkdirSync(tools, { recursive: true });
    writeFileSync(script, 'print("partition tool")\n');
    writeFileSync(python, 'fake-python3-v1');
    const espPacks: BuildPacks = {
      ...packs,
      board: { ...board, id: 'board:c3', fqbn: 'esp32:esp32:esp32c3' },
      platform: { ...packs.platform, id: 'platform:esp32', platform: 'esp32' },
      toolchain: { ...packs.toolchain, id: 'tool:esp32', abi: 'riscv32' },
    };
    const options = {
      hostPlatform: 'linux' as const,
      pythonInterpreter: {
        command: python,
        commandSha256: sha256Hex(readFileSync(python)),
        authorizedDirectory: root,
      },
      esp32: {
        riscvBinDir: join(root, 'bin'),
        coreDir: join(root, 'core'), variantsDir: join(root, 'variants'),
        platformDir: join(root, 'platform'), esptool: join(root, 'esptool'),
        sdkRootFor: () => null,
      },
    };
    const integrity = createNativeToolIntegrityManifest(
      options,
      espPacks,
      ['platform:gen-esp32part'],
    );
    const resolver = new DefaultNativeToolResolver({ ...options, integrity });

    expect(resolver.resolve('platform:gen-esp32part', espPacks)).toBe(script);
    expect(resolver.resolveForExecution('platform:gen-esp32part', espPacks)).toEqual({
      command: python,
      argumentsPrefix: [script],
      entrypoint: script,
      readOnlyPaths: [tools, root],
    });
    expect(() => new DefaultNativeToolResolver({
      ...options,
      pythonInterpreter: undefined,
      integrity,
    }).resolveForExecution('platform:gen-esp32part', espPacks))
      .toThrow(/explicit Python interpreter identity/);
    writeFileSync(python, 'fake-python3-v2');
    expect(() => resolver.resolveForExecution('platform:gen-esp32part', espPacks))
      .toThrow(/Python interpreter command hash mismatch/);
  });

  it('allows an explicit command map for custom adapters', () => {
    const resolver = new DefaultNativeToolResolver({ commands: { 'ck:preprocess': 'node-preprocess' } });
    expect(resolver.resolve('ck:preprocess', packs)).toBe('node-preprocess');
    expect(() => resolver.resolve('unknown', packs)).toThrow(/unsupported native tool/);
  });

  it('requires an integrity manifest for Pack-backed tools', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-tool-resolver-'));
    roots.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const command = join(bin, `avr-gcc${process.platform === 'win32' ? '.exe' : ''}`);
    writeFileSync(command, 'compiler-a');
    const options = {
      avr: { binDir: bin, coreDir: join(root, 'core'), variantsDir: join(root, 'variants') },
    };

    expect(() => new DefaultNativeToolResolver(options).resolve('toolchain:cc', packs))
      .toThrow(/integrity manifest is missing/);
  });

  it('rejects a Pack mismatch and a command replaced after manifest capture', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-tool-resolver-'));
    roots.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const command = join(bin, `avr-gcc${process.platform === 'win32' ? '.exe' : ''}`);
    writeFileSync(command, 'compiler-a');
    const options = {
      avr: { binDir: bin, coreDir: join(root, 'core'), variantsDir: join(root, 'variants') },
    };
    const integrity = createNativeToolIntegrityManifest(options, packs, ['toolchain:cc']);
    const resolver = new DefaultNativeToolResolver({ ...options, integrity });

    expect(() => resolver.resolve('toolchain:cc', {
      ...packs,
      toolchain: { ...packs.toolchain, sha256: 'f'.repeat(64) },
    })).toThrow(/Pack identity mismatch/);

    writeFileSync(command, 'compiler-b');
    expect(() => resolver.resolve('toolchain:cc', packs)).toThrow(/command hash mismatch/);
  });

  it('binds libexec, dynamic-library, and sysroot bytes while the direct command stays unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-tool-runtime-closure-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const helper = join(root, 'libexec', 'cc1');
    const runtime = join(root, 'lib', 'runtime.dll');
    const sysroot = join(root, 'sysroot', 'include', 'stdint.h');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, 'libexec'), { recursive: true });
    mkdirSync(join(root, 'lib'), { recursive: true });
    mkdirSync(join(root, 'sysroot', 'include'), { recursive: true });
    const command = join(bin, `avr-gcc${process.platform === 'win32' ? '.exe' : ''}`);
    writeFileSync(command, 'compiler-v1');
    writeFileSync(helper, 'cc1-v1');
    writeFileSync(runtime, 'runtime-v1');
    writeFileSync(sysroot, 'stdint-v1');
    const options = {
      avr: { binDir: bin, rootDir: root, coreDir: join(root, 'core'), variantsDir: join(root, 'variants') },
    };

    const baseline = createNativeToolIntegrityManifest(options, packs, ['toolchain:cc']);
    const baselineEntry = baseline['toolchain:cc']!;
    const baselinePolicy = new DefaultNativeToolResolver({ ...options, integrity: baseline }).policyIdentity;
    writeFileSync(helper, 'cc1-v2');
    expect(() => new DefaultNativeToolResolver({ ...options, integrity: baseline })
      .verifyForExecution(packs)).toThrow(/closure hash mismatch/);
    const helperChanged = createNativeToolIntegrityManifest(options, packs, ['toolchain:cc']);
    expect(helperChanged['toolchain:cc']!.commandSha256).toBe(baselineEntry.commandSha256);
    expect(helperChanged['toolchain:cc']!.closure.sha256).not.toBe(baselineEntry.closure.sha256);
    expect(new DefaultNativeToolResolver({ ...options, integrity: helperChanged }).policyIdentity)
      .not.toBe(baselinePolicy);

    writeFileSync(runtime, 'runtime-v2');
    const runtimeChanged = createNativeToolIntegrityManifest(options, packs, ['toolchain:cc']);
    expect(runtimeChanged['toolchain:cc']!.commandSha256).toBe(baselineEntry.commandSha256);
    expect(runtimeChanged['toolchain:cc']!.closure.sha256)
      .not.toBe(helperChanged['toolchain:cc']!.closure.sha256);

    writeFileSync(sysroot, 'stdint-v2');
    const sysrootChanged = createNativeToolIntegrityManifest(options, packs, ['toolchain:cc']);
    expect(sysrootChanged['toolchain:cc']!.commandSha256).toBe(baselineEntry.commandSha256);
    expect(sysrootChanged['toolchain:cc']!.closure.sha256)
      .not.toBe(runtimeChanged['toolchain:cc']!.closure.sha256);
  });

  it('rescans a closure at every execution preflight on the same resolver', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-tool-preflight-rescan-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const helper = join(root, 'libexec', 'cc1');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, 'libexec'), { recursive: true });
    const command = join(bin, `avr-gcc${process.platform === 'win32' ? '.exe' : ''}`);
    writeFileSync(command, 'compiler-v1');
    writeFileSync(helper, 'cc1-v1');
    const options = {
      avr: {
        binDir: bin,
        rootDir: root,
        coreDir: join(root, 'core'),
        variantsDir: join(root, 'variants'),
      },
    };
    const integrity = createNativeToolIntegrityManifest(options, packs, ['toolchain:cc']);
    const resolver = new DefaultNativeToolResolver({ ...options, integrity });

    expect(() => resolver.resolve('toolchain:cc', packs)).not.toThrow();
    expect(() => resolver.verifyForExecution(packs)).not.toThrow();
    writeFileSync(helper, 'cc1-v2');
    expect(() => resolver.verifyForExecution(packs)).toThrow(/closure hash mismatch/);
    writeFileSync(helper, 'cc1-v1');
    expect(() => resolver.verifyForExecution(packs)).not.toThrow();
  });

  it('rescans the closure at the Native spawn-resolution boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'ck-native-tool-spawn-rescan-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const helper = join(root, 'libexec', 'cc1');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, 'libexec'), { recursive: true });
    const command = join(bin, `avr-gcc${process.platform === 'win32' ? '.exe' : ''}`);
    writeFileSync(command, 'compiler-v1');
    writeFileSync(helper, 'cc1-v1');
    const options = {
      avr: {
        binDir: bin,
        rootDir: root,
        coreDir: join(root, 'core'),
        variantsDir: join(root, 'variants'),
      },
    };
    const integrity = createNativeToolIntegrityManifest(options, packs, ['toolchain:cc']);
    const resolver = new DefaultNativeToolResolver({ ...options, integrity });

    expect(() => resolver.verifyForExecution(packs)).not.toThrow();
    writeFileSync(helper, 'cc1-v2');
    expect(() => resolver.resolveForExecution('toolchain:cc', packs))
      .toThrow(/closure hash mismatch/);
  });
});
