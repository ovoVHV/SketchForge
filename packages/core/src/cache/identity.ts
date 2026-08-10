/**
 * L0 缓存使用的编译环境身份。
 *
 * 身份只包含会影响编译产物的内容，不包含部署机器上的绝对路径。这样同一套
 * 工具链搬到另一台机器仍可共享缓存，而原路径下原地升级编译器、core、SDK
 * 或第三方库时会自然失效。
 */

import { createHash, type Hash } from 'node:crypto';
import {
  createReadStream, lstatSync, readFileSync, readdirSync, realpathSync,
} from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { platform } from 'node:os';

import type { ToolchainConfig } from '../toolchain/config.js';
import { toolPath } from '../toolchain/config.js';
import { esp32SdkTargets, type BoardDefinition, type BoardRegistry } from '../toolchain/board.js';
import type { Library } from '../toolchain/library.js';

const IDENTITY_FORMAT = 'sketchforge-cache-identity-v1';
const EXE = platform() === 'win32' ? '.exe' : '';
export type ToolchainIdentityScope = 'all' | 'avr' | 'esp32';

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 长度前缀避免不同字段拼接后产生歧义。 */
function field(hash: Hash, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  fieldPrefix(hash, bytes.length);
  hash.update(bytes);
}

function fieldPrefix(hash: Hash, byteLength: number): void {
  hash.update(String(byteLength));
  hash.update(':');
}

function portablePath(path: string): string {
  return path.split(sep).join('/');
}

/**
 * 按相对路径排序后对目录内容做摘要。根目录名和绝对路径不会进入结果。
 * 缺失或暂时不可读的路径也会得到稳定标记，服务启动不会因此崩溃。
 */
export function contentIdentity(root: string): string {
  const hash = createHash('sha256');
  field(hash, IDENTITY_FORMAT);

  const walk = (actualPath: string, logicalPath: string, ancestors: Set<string>): void => {
    let stat;
    try {
      stat = lstatSync(actualPath);
    } catch {
      field(hash, `missing:${logicalPath}`);
      return;
    }

    if (stat.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = realpathSync(actualPath);
      } catch {
        field(hash, `broken-link:${logicalPath}`);
        return;
      }
      walk(resolved, logicalPath, ancestors);
      return;
    }

    if (stat.isDirectory()) {
      let real: string;
      try {
        real = realpathSync(actualPath);
      } catch {
        field(hash, `unreadable-dir:${logicalPath}`);
        return;
      }
      if (ancestors.has(real)) {
        field(hash, `directory-cycle:${logicalPath}`);
        return;
      }

      field(hash, `directory:${logicalPath}`);
      let entries: string[];
      try {
        entries = readdirSync(actualPath).sort(compareText);
      } catch {
        field(hash, `unreadable-dir:${logicalPath}`);
        return;
      }

      const nextAncestors = new Set(ancestors);
      nextAncestors.add(real);
      for (const entry of entries) {
        const childLogical = logicalPath === '.' ? entry : `${logicalPath}/${entry}`;
        walk(join(actualPath, entry), childLogical, nextAncestors);
      }
      return;
    }

    if (stat.isFile()) {
      field(hash, `file:${logicalPath}`);
      try {
        field(hash, readFileSync(actualPath));
      } catch {
        field(hash, `unreadable-file:${logicalPath}`);
      }
      return;
    }

    field(hash, `special:${logicalPath}`);
  };

  walk(root, '.', new Set());
  return hash.digest('hex');
}

function sameFileSnapshot(before: Stats, after: Stats): boolean {
  return before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
    && before.dev === after.dev
    && before.ino === after.ino;
}

/**
 * Async counterpart to {@link contentIdentity}. It keeps the exact same
 * stable-file format, but walks directories and streams file bytes through
 * the event loop. A first local ESP32 SDK scan can therefore take time
 * without preventing HTTP/SSE handlers from running.
 */
export async function contentIdentityAsync(root: string): Promise<string> {
  const state: { hash: Hash } = { hash: createHash('sha256') };
  field(state.hash, IDENTITY_FORMAT);

  const appendFile = async (actualPath: string, initial: Stats): Promise<boolean> => {
    try {
      fieldPrefix(state.hash, initial.size);
      let bytes = 0;
      // Keep chunks modest: each await gives the event loop a chance to serve
      // status and SSE requests while a multi-GB SDK is being fingerprinted.
      for await (const chunk of createReadStream(actualPath, { highWaterMark: 64 * 1024 })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        state.hash.update(buffer);
        bytes += buffer.length;
      }
      const after = await lstat(actualPath);
      return bytes === initial.size && after.isFile() && sameFileSnapshot(initial, after);
    } catch {
      return false;
    }
  };

  const walk = async (actualPath: string, logicalPath: string, ancestors: Set<string>): Promise<void> => {
    let stat: Stats;
    try {
      stat = await lstat(actualPath);
    } catch {
      field(state.hash, `missing:${logicalPath}`);
      return;
    }

    if (stat.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = await realpath(actualPath);
      } catch {
        field(state.hash, `broken-link:${logicalPath}`);
        return;
      }
      await walk(resolved, logicalPath, ancestors);
      return;
    }

    if (stat.isDirectory()) {
      let real: string;
      try {
        real = await realpath(actualPath);
      } catch {
        field(state.hash, `unreadable-dir:${logicalPath}`);
        return;
      }
      if (ancestors.has(real)) {
        field(state.hash, `directory-cycle:${logicalPath}`);
        return;
      }

      field(state.hash, `directory:${logicalPath}`);
      let entries: string[];
      try {
        entries = (await readdir(actualPath)).sort(compareText);
      } catch {
        field(state.hash, `unreadable-dir:${logicalPath}`);
        return;
      }

      ancestors.add(real);
      try {
        for (const entry of entries) {
          const childLogical = logicalPath === '.' ? entry : `${logicalPath}/${entry}`;
          await walk(join(actualPath, entry), childLogical, ancestors);
        }
      } finally {
        ancestors.delete(real);
      }
      return;
    }

    if (stat.isFile()) {
      field(state.hash, `file:${logicalPath}`);
      // A concurrent replacement can otherwise make the length prefix and
      // streamed content disagree. Retry once from a cloned hash state; an
      // actively changing file is treated like an unreadable one.
      const beforeContent = state.hash.copy();
      let current = stat;
      for (let attempt = 0; attempt < 2; attempt++) {
        state.hash = beforeContent.copy();
        if (await appendFile(actualPath, current)) return;
        try {
          current = await lstat(actualPath);
        } catch {
          break;
        }
        if (!current.isFile()) break;
      }
      state.hash = beforeContent;
      field(state.hash, `unreadable-file:${logicalPath}`);
      return;
    }

    field(state.hash, `special:${logicalPath}`);
  };

  await walk(root, '.', new Set());
  return state.hash.digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;

  const object = value as Record<string, unknown>;
  const entries = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`);
  return `{${entries.join(',')}}`;
}

function addPath(hash: Hash, label: string, path: string | null | undefined): void {
  field(hash, label);
  field(hash, path ? contentIdentity(path) : 'not-configured');
}

async function addPathAsync(
  hash: Hash,
  label: string,
  path: string | null | undefined,
): Promise<void> {
  field(hash, label);
  field(hash, path ? await contentIdentityAsync(path) : 'not-configured');
}

function espBoards(boards: BoardDefinition[]): BoardDefinition[] {
  return boards.filter((board) => board.arch === 'esp32');
}

/**
 * 计算工具链身份。生产 worker 应传具体架构，避免 AVR 请求扫描庞大的 ESP32 SDK，
 * 也避免一个池的工具链升级无意义地冲掉另一个池的缓存。
 */
export function toolchainIdentity(
  config: ToolchainConfig,
  registry: BoardRegistry,
  scope: ToolchainIdentityScope = 'all',
): string {
  const hash = createHash('sha256');
  field(hash, IDENTITY_FORMAT);
  field(hash, `scope:${scope}`);

  const boards = registry.list()
    .filter((board) => scope === 'all' || board.arch === scope)
    .sort((a, b) => compareText(a.fqbn, b.fqbn));
  field(hash, stableJson(boards));

  if ((scope === 'all' || scope === 'avr') && config.avr) {
    field(hash, 'avr');
    addPath(
      hash,
      'avr-toolchain-root',
      config.avr.rootDir ?? dirname(config.avr.binDir),
    );
    for (const tool of ['avr-gcc', 'avr-g++', 'avr-gcc-ar', 'avr-objcopy', 'avr-size']) {
      addPath(hash, `avr-tool:${tool}`, toolPath(config.avr, tool));
    }
    addPath(hash, 'avr-core', config.avr.coreDir);
    addPath(hash, 'avr-variants', config.avr.variantsDir);
  } else if (scope === 'all' || scope === 'avr') {
    field(hash, 'avr:disabled');
  }

  if ((scope === 'all' || scope === 'esp32') && config.esp32) {
    field(hash, 'esp32');
    const esp = config.esp32;
    const compilerSets = new Map<string, { binDir?: string; rootDir?: string; prefix: string }>();
    for (const board of espBoards(boards)) {
      const tarch = board.build.tarch ?? 'xtensa';
      const target = board.build.target ?? 'esp32';
      const binDir = tarch === 'riscv32' ? esp.riscvBinDir : esp.xtensaBinDir;
      const rootDir = tarch === 'riscv32'
        ? (esp.riscvRootDir ?? (binDir ? dirname(binDir) : undefined))
        : (esp.xtensaRootDir ?? (binDir ? dirname(binDir) : undefined));
      const prefix = tarch === 'riscv32' ? 'riscv32-esp-elf-' : `${tarch}-${target}-elf-`;
      compilerSets.set(`${tarch}:${target}`, { binDir, rootDir, prefix });
    }

    for (const [name, compiler] of [...compilerSets].sort(([a], [b]) => compareText(a, b))) {
      addPath(
        hash,
        `esp32-toolchain-root:${name}`,
        compiler.rootDir ?? null,
      );
      for (const tool of ['gcc', 'g++', 'gcc-ar', 'size']) {
        addPath(
          hash,
          `esp32-tool:${name}:${tool}`,
          compiler.binDir ? join(compiler.binDir, `${compiler.prefix}${tool}${EXE}`) : null,
        );
      }
    }

    addPath(hash, 'esp32-core', esp.coreDir);
    addPath(hash, 'esp32-variants', esp.variantsDir);
    addPath(hash, 'esp32-esptool', esp.esptool);
    addPath(
      hash,
      'esp32-partition-tool',
      join(esp.platformDir, 'tools', platform() === 'win32' ? 'gen_esp32part.exe' : 'gen_esp32part.py'),
    );
    addPath(hash, 'esp32-partitions', join(esp.platformDir, 'tools', 'partitions'));

    const sdkTargets = [...new Set(espBoards(boards).flatMap(esp32SdkTargets))].sort();
    for (const sdkTarget of sdkTargets) {
      let sdkRoot: string | null = null;
      try { sdkRoot = esp.sdkRootFor(sdkTarget); } catch { /* 身份计算不能阻止服务启动 */ }
      addPath(hash, `esp32-sdk:${sdkTarget}`, sdkRoot);
    }
  } else if (scope === 'all' || scope === 'esp32') {
    field(hash, 'esp32:disabled');
  }

  return hash.digest('hex');
}

/**
 * Event-loop-friendly variant for an unpacked local toolchain. It has the
 * same inputs and output format as {@link toolchainIdentity}, but streams the
 * SDK tree asynchronously so status and SSE endpoints keep responding.
 */
export async function toolchainIdentityAsync(
  config: ToolchainConfig,
  registry: BoardRegistry,
  scope: ToolchainIdentityScope = 'all',
): Promise<string> {
  const hash = createHash('sha256');
  field(hash, IDENTITY_FORMAT);
  field(hash, `scope:${scope}`);

  const boards = registry.list()
    .filter((board) => scope === 'all' || board.arch === scope)
    .sort((a, b) => compareText(a.fqbn, b.fqbn));
  field(hash, stableJson(boards));

  if ((scope === 'all' || scope === 'avr') && config.avr) {
    field(hash, 'avr');
    await addPathAsync(
      hash,
      'avr-toolchain-root',
      config.avr.rootDir ?? dirname(config.avr.binDir),
    );
    for (const tool of ['avr-gcc', 'avr-g++', 'avr-gcc-ar', 'avr-objcopy', 'avr-size']) {
      await addPathAsync(hash, `avr-tool:${tool}`, toolPath(config.avr, tool));
    }
    await addPathAsync(hash, 'avr-core', config.avr.coreDir);
    await addPathAsync(hash, 'avr-variants', config.avr.variantsDir);
  } else if (scope === 'all' || scope === 'avr') {
    field(hash, 'avr:disabled');
  }

  if ((scope === 'all' || scope === 'esp32') && config.esp32) {
    field(hash, 'esp32');
    const esp = config.esp32;
    const compilerSets = new Map<string, { binDir?: string; rootDir?: string; prefix: string }>();
    for (const board of espBoards(boards)) {
      const tarch = board.build.tarch ?? 'xtensa';
      const target = board.build.target ?? 'esp32';
      const binDir = tarch === 'riscv32' ? esp.riscvBinDir : esp.xtensaBinDir;
      const rootDir = tarch === 'riscv32'
        ? (esp.riscvRootDir ?? (binDir ? dirname(binDir) : undefined))
        : (esp.xtensaRootDir ?? (binDir ? dirname(binDir) : undefined));
      const prefix = tarch === 'riscv32' ? 'riscv32-esp-elf-' : `${tarch}-${target}-elf-`;
      compilerSets.set(`${tarch}:${target}`, { binDir, rootDir, prefix });
    }

    for (const [name, compiler] of [...compilerSets].sort(([a], [b]) => compareText(a, b))) {
      await addPathAsync(
        hash,
        `esp32-toolchain-root:${name}`,
        compiler.rootDir ?? null,
      );
      for (const tool of ['gcc', 'g++', 'gcc-ar', 'size']) {
        await addPathAsync(
          hash,
          `esp32-tool:${name}:${tool}`,
          compiler.binDir ? join(compiler.binDir, `${compiler.prefix}${tool}${EXE}`) : null,
        );
      }
    }

    await addPathAsync(hash, 'esp32-core', esp.coreDir);
    await addPathAsync(hash, 'esp32-variants', esp.variantsDir);
    await addPathAsync(hash, 'esp32-esptool', esp.esptool);
    await addPathAsync(
      hash,
      'esp32-partition-tool',
      join(esp.platformDir, 'tools', platform() === 'win32' ? 'gen_esp32part.exe' : 'gen_esp32part.py'),
    );
    await addPathAsync(hash, 'esp32-partitions', join(esp.platformDir, 'tools', 'partitions'));

    const sdkTargets = [...new Set(espBoards(boards).flatMap(esp32SdkTargets))].sort();
    for (const sdkTarget of sdkTargets) {
      let sdkRoot: string | null = null;
      try { sdkRoot = esp.sdkRootFor(sdkTarget); } catch { /* Identity calculation must not stop service startup. */ }
      await addPathAsync(hash, `esp32-sdk:${sdkTarget}`, sdkRoot);
    }
  } else if (scope === 'all' || scope === 'esp32') {
    field(hash, 'esp32:disabled');
  }

  return hash.digest('hex');
}

/**
 * Identity for the immutable native Toolchain Pack only. Core, variants,
 * platform tools, partitions and SDK trees deliberately do not participate;
 * those belong to Platform/Core or Board Packs. A bundle/hint provenance can
 * skip hashing a packaged compiler root, but the executable files are always
 * fingerprinted so a same-version replacement cannot silently pass.
 */
export async function nativeToolchainPackIdentityAsync(
  config: ToolchainConfig,
  registry: BoardRegistry,
  scope: Exclude<ToolchainIdentityScope, 'all'>,
  provenance?: { kind: 'bundle' | 'hint'; value: string },
): Promise<string> {
  const hash = createHash('sha256');
  field(hash, 'sketchforge-native-toolchain-pack-v2');
  field(hash, `scope:${scope}`);
  if (provenance) field(hash, `${provenance.kind}:${provenance.value}`);

  if (scope === 'avr' && config.avr) {
    field(hash, 'avr');
    if (!provenance) {
      await addPathAsync(hash, 'avr-toolchain-root', config.avr.rootDir ?? dirname(config.avr.binDir));
    }
    for (const tool of ['avr-gcc', 'avr-g++', 'avr-gcc-ar', 'avr-objcopy', 'avr-size']) {
      await addPathAsync(hash, `avr-tool:${tool}`, toolPath(config.avr, tool));
    }
  } else if (scope === 'avr') {
    field(hash, 'avr:disabled');
  }

  if (scope === 'esp32' && config.esp32) {
    field(hash, 'esp32');
    const esp = config.esp32;
    const compilerSets = new Map<string, { binDir?: string; rootDir?: string; prefix: string }>();
    for (const board of espBoards(registry.list())) {
      const tarch = board.build.tarch ?? 'xtensa';
      const target = board.build.target ?? 'esp32';
      const binDir = tarch === 'riscv32' ? esp.riscvBinDir : esp.xtensaBinDir;
      const rootDir = tarch === 'riscv32'
        ? (esp.riscvRootDir ?? (binDir ? dirname(binDir) : undefined))
        : (esp.xtensaRootDir ?? (binDir ? dirname(binDir) : undefined));
      const prefix = tarch === 'riscv32' ? 'riscv32-esp-elf-' : `${tarch}-${target}-elf-`;
      compilerSets.set(`${tarch}:${target}`, { binDir, rootDir, prefix });
    }
    for (const [name, compiler] of [...compilerSets].sort(([left], [right]) => compareText(left, right))) {
      field(hash, `compiler:${name}`);
      if (!provenance) await addPathAsync(hash, `compiler-root:${name}`, compiler.rootDir ?? null);
      for (const tool of ['gcc', 'g++', 'gcc-ar', 'objcopy', 'size']) {
        await addPathAsync(
          hash,
          `compiler-tool:${name}:${tool}`,
          compiler.binDir ? join(compiler.binDir, `${compiler.prefix}${tool}${EXE}`) : null,
        );
      }
    }
    await addPathAsync(hash, 'esp32-esptool', esp.esptool);
  } else if (scope === 'esp32') {
    field(hash, 'esp32:disabled');
  }

  return hash.digest('hex');
}

const toolchainIdentities = new WeakMap<
ToolchainConfig,
WeakMap<BoardRegistry, Map<ToolchainIdentityScope, string>>
>();

const asyncToolchainIdentities = new WeakMap<
ToolchainConfig,
WeakMap<BoardRegistry, Map<ToolchainIdentityScope, Promise<string>>>
>();

/** 同一份启动配置可被主服务和库试编译服务复用，避免重复扫描工具链。 */
export function memoizedToolchainIdentity(
  config: ToolchainConfig,
  registry: BoardRegistry,
  scope: ToolchainIdentityScope = 'all',
): string {
  let byRegistry = toolchainIdentities.get(config);
  if (!byRegistry) {
    byRegistry = new WeakMap();
    toolchainIdentities.set(config, byRegistry);
  }

  let byScope = byRegistry.get(registry);
  if (!byScope) {
    byScope = new Map();
    byRegistry.set(registry, byScope);
  }

  const cached = byScope.get(scope);
  if (cached) return cached;
  const identity = toolchainIdentity(config, registry, scope);
  byScope.set(scope, identity);
  return identity;
}

/**
 * Async single-flight variant for local development installations. Concurrent
 * compile jobs share one SDK walk rather than hashing the same tree repeatedly.
 */
export function memoizedToolchainIdentityAsync(
  config: ToolchainConfig,
  registry: BoardRegistry,
  scope: ToolchainIdentityScope = 'all',
): Promise<string> {
  let byRegistry = asyncToolchainIdentities.get(config);
  if (!byRegistry) {
    byRegistry = new WeakMap();
    asyncToolchainIdentities.set(config, byRegistry);
  }

  let byScope = byRegistry.get(registry);
  if (!byScope) {
    byScope = new Map();
    byRegistry.set(registry, byScope);
  }

  const cached = byScope.get(scope);
  if (cached) return cached;

  const identity = toolchainIdentityAsync(config, registry, scope);
  byScope.set(scope, identity);
  void identity.catch(() => {
    if (byScope!.get(scope) === identity) byScope!.delete(scope);
  });
  return identity;
}

const libraryIdentities = new WeakMap<Library, string>();

/**
 * 库身份覆盖实际参与编译的清单、源码和头文件。README/examples 等不参与编译的
 * 文件变化不会制造无意义的缓存失效。
 */
export function libraryIdentity(library: Library): string {
  const cached = libraryIdentities.get(library);
  if (cached) return cached;

  const hash = createHash('sha256');
  field(hash, IDENTITY_FORMAT);
  field(hash, stableJson(library.manifest));
  field(hash, library.layout);
  addPath(hash, 'manifest', join(library.rootDir, 'library.properties'));

  const files = library.allFiles
    .map((path) => ({ path, relative: portablePath(relative(library.rootDir, path)) }))
    .sort((a, b) => compareText(a.relative, b.relative));
  for (const file of files) addPath(hash, `library-file:${file.relative}`, file.path);

  const identity = hash.digest('hex');
  libraryIdentities.set(library, identity);
  return identity;
}
