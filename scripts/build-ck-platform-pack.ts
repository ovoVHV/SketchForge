import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalJson } from '../packages/core/src/build-ir/canonical.js';
import { createPlatformManifest } from '../packages/core/src/platform-pack/builder.js';
import type { PlatformSourceFile, PlatformToolRequirement } from '../packages/core/src/platform-pack/types.js';

interface CliArgs {
  platformDir: string;
  id: string;
  version: string;
  vendor: string;
  architecture: string;
  output: string;
  packRoot?: string;
  tools: PlatformToolRequirement[];
  deferredCkToolBinding: boolean;
}

const TOOL_METADATA_EXTENSIONS = new Set(['.csv', '.json', '.ld', '.properties', '.txt', '.xml', '.yaml', '.yml']);

export function buildCkPlatformPack(argv: string[]): Readonly<{
  output: string;
  sha256: string;
  files: number;
}> {
  const args = parseArgs(argv);
  const root = resolve(args.platformDir);
  const files = collectPlatformSourceFiles(root);
  const platformText = readSourceText(files, 'platform.txt', root, true);
  const boardsText = readSourceText(files, 'boards.txt', root, true);
  const programmersText = readSourceText(files, 'programmers.txt', root, false);
  const manifest = createPlatformManifest({
    id: args.id,
    version: args.version,
    vendor: args.vendor,
    architecture: args.architecture,
    platformText,
    boardsText,
    programmersText,
    files,
    tools: args.tools,
    ...(args.deferredCkToolBinding ? { runtimeToolPolicy: 'deferred-ck-binding' as const } : {}),
  });

  const output = resolve(args.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${canonicalJson(manifest)}\n`, 'utf8');
  if (args.packRoot) {
    const destination = resolve(args.packRoot);
    mkdirSync(destination, { recursive: true });
    for (const path of files.map((file) => file.path)) {
      const source = join(root, ...path.split('/'));
      const target = join(destination, 'files', ...path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target);
    }
    writeFileSync(join(destination, 'manifest.json'), `${canonicalJson(manifest)}\n`, 'utf8');
  }
  return Object.freeze({ output, sha256: manifest.sha256, files: manifest.files.length });
}

export function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  const tools: PlatformToolRequirement[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--defer-ck-tool-binding') {
      values.set('defer-ck-tool-binding', 'true');
      continue;
    }
    if (token === '--tool') {
      const value = argv[++index];
      if (!value) throw new Error('--tool requires id@version#sha256');
      const hashIndex = value.indexOf('#');
      if (hashIndex < 0) throw new Error('--tool requires id@version#sha256');
      const identity = value.slice(0, hashIndex);
      const at = identity.lastIndexOf('@');
      if (at <= 0 || at === identity.length - 1) throw new Error('--tool requires id@version#sha256');
      const sha256 = value.slice(hashIndex + 1).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('--tool sha256 must be 64 lowercase hex characters');
      tools.push({
        id: identity.slice(0, at),
        version: identity.slice(at + 1),
        sha256,
      });
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`);
    const key = token.slice(2);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    values.set(key, value);
  }
  const required = ['platform-dir', 'id', 'version', 'vendor', 'architecture', 'output'] as const;
  for (const key of required) if (!values.get(key)) throw new Error(`missing --${key}`);
  return {
    platformDir: values.get('platform-dir')!,
    id: values.get('id')!,
    version: values.get('version')!,
    vendor: values.get('vendor')!,
    architecture: values.get('architecture')!,
    output: values.get('output')!,
    ...(values.get('pack-root') ? { packRoot: values.get('pack-root')! } : {}),
    tools,
    deferredCkToolBinding: values.get('defer-ck-tool-binding') === 'true',
  };
}

function existsFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

export function collectPlatformSourceFiles(root: string): PlatformSourceFile[] {
  const platformRoot = resolve(root);
  return collectFiles(platformRoot).map((path): PlatformSourceFile => ({
    path: relative(platformRoot, path).replaceAll('\\', '/'),
    content: new Uint8Array(readFileSync(path)),
  }));
}

function collectFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string, include: (path: string) => boolean = () => true): void => {
    if (!existsFileOrDirectory(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`platform pack cannot contain a symlink: ${path}`);
      if (entry.isDirectory()) visit(path, include);
      else if (entry.isFile() && include(path)) result.push(path);
    }
  };

  for (const name of ['platform.txt', 'boards.txt', 'programmers.txt']) {
    const path = join(root, name);
    if (existsFile(path)) result.push(path);
  }
  visit(join(root, 'cores'));
  visit(join(root, 'variants'));
  visit(join(root, 'tools'), (path) => TOOL_METADATA_EXTENSIONS.has(extname(path).toLowerCase()));
  return result.sort((left, right) => {
    const leftPath = relative(root, left).replaceAll('\\', '/');
    const rightPath = relative(root, right).replaceAll('\\', '/');
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
}

function readSourceText(
  files: readonly PlatformSourceFile[],
  path: string,
  root: string,
  required: boolean,
): string {
  const matches = files.filter((file) => file.path === path);
  if (matches.length === 0 && !required) return '';
  if (matches.length !== 1) throw new Error(`missing required platform file: ${join(root, path)}`);
  const content = matches[0]!.content;
  try {
    return typeof content === 'string'
      ? content
      : new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error(`platform file is not valid UTF-8: ${join(root, path)}`);
  }
}

function existsFileOrDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`platform pack cannot contain a symlink: ${path}`);
    return stat.isFile() || stat.isDirectory();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('platform pack cannot contain')) throw error;
    return false;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = buildCkPlatformPack(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  }
}
