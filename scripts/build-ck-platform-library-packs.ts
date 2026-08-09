#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { parseArduinoProperties } from '../packages/core/src/platform-pack/properties.js';
import {
  createCatalogSourcePackFromFiles,
  inferCatalogRegistryDependencies,
} from './build-browser-esp32-catalog-packs.mjs';

interface PlatformLibraryBuildOptions {
  platformRoot: string;
  platformId: string;
  platformVersion: string;
  platformRevision?: string;
  registry: string;
  output: string;
  names?: string[];
}

interface SourceFile {
  path: string;
  bytes: Buffer;
}

export function buildCkPlatformLibraryPacks(options: PlatformLibraryBuildOptions) {
  const platformRoot = resolve(options.platformRoot);
  const librariesRoot = join(platformRoot, 'libraries');
  requireFile(join(platformRoot, 'platform.txt'), 'platform.txt');
  requireDirectory(librariesRoot, 'platform libraries');
  const registryPath = resolve(options.registry);
  const output = resolve(options.output);
  const baseRegistry = JSON.parse(readFileSync(registryPath, 'utf8'));
  mkdirSync(output, { recursive: true });
  copyRegistryPacks(baseRegistry, registryPath, output);

  const requested = new Set((options.names ?? []).map((value) => value.toLowerCase()));
  const matchedRequested = new Set<string>();
  const rows = [];
  for (const entry of readdirSync(librariesRoot, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`platform library cannot be a symlink: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const root = join(librariesRoot, entry.name);
    const propertiesPath = join(root, 'library.properties');
    if (!isFile(propertiesPath)) continue;
    const propertiesText = readFileSync(propertiesPath, 'utf8');
    const properties = parseArduinoProperties(propertiesText).properties;
    const name = properties.name?.trim();
    const version = properties.version?.trim() || options.platformVersion;
    if (!name) throw new Error(`platform library name is missing: ${entry.name}`);
    const aliases = [name.toLowerCase(), entry.name.toLowerCase()];
    if (requested.size && !aliases.some((alias) => requested.has(alias))) continue;
    for (const alias of aliases) if (requested.has(alias)) matchedRequested.add(alias);
    const files = collectSourceFiles(root, propertiesText);
    const sourceTreeSha256 = hashSourceTree(files);
    const architectures = [...new Set((properties.architectures ?? 'esp32')
      .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))].sort(compareText);
    const providesIncludes = platformPublicHeaders(
      entry.name,
      name,
      properties.includes,
      files,
    );
    const built = createCatalogSourcePackFromFiles({
      name,
      version,
      architectures,
      dependencies: [],
      providesIncludes,
      url: `ck-platform://${options.platformId}/${options.platformVersion}/${entry.name}`,
      checksum: `SHA-256:${sourceTreeSha256}`,
      repository: `${options.platformId}@${options.platformRevision ?? options.platformVersion}`,
    }, files);
    const manifest = writePlatformLibraryPack(output, {
      directoryName: entry.name,
      name,
      version,
      architectures,
      platformId: options.platformId,
      platformVersion: options.platformVersion,
      platformRevision: options.platformRevision ?? options.platformVersion,
      sourceTreeSha256,
      built,
    });
    rows.push({
      name,
      defaultVersion: version,
      versions: [{
        version,
        architectures,
        publicHeaders: built.publicHeaders,
        depends: [],
        pack: {
          id: built.id,
          revision: built.revision,
          manifest,
          artifact: 'sources',
        },
      }],
    });
  }
  if (requested.size) {
    const missing = [...requested].filter((name) => !matchedRequested.has(name));
    if (missing.length) throw new Error(`platform libraries were not found: ${missing.join(', ')}`);
  }

  removeAmbiguousPlatformHeaders(rows);
  const merged = mergeRegistry(baseRegistry, rows);
  const registry = inferCatalogRegistryDependencies(merged, output);
  const registryBytes = Buffer.from(stableJson(registry));
  writeFileSync(join(output, 'registry.staging.json'), registryBytes);
  const report = {
    schema: 1,
    platform: {
      id: options.platformId,
      version: options.platformVersion,
      revision: options.platformRevision ?? options.platformVersion,
    },
    built: rows.map((row) => ({ name: row.name, version: row.defaultVersion })),
    registry: {
      libraries: registry.libraries.length,
      sha256: sha256(registryBytes),
    },
  };
  writeFileSync(join(output, 'platform-library-pack-report.json'), stableJson(report));
  return Object.freeze({ output, registry, report });
}

function collectSourceFiles(root: string, propertiesText: string): SourceFile[] {
  const files: SourceFile[] = [{ path: 'library.properties', bytes: Buffer.from(propertiesText, 'utf8') }];
  const sourceRoot = join(root, 'src');
  requireDirectory(sourceRoot, `${root} source directory`);
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`platform library source cannot be a symlink: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push({
        path: relative(root, path).split(sep).join('/'),
        bytes: readFileSync(path),
      });
    }
  };
  visit(sourceRoot);
  return files;
}

function writePlatformLibraryPack(output: string, row: any): string {
  const slug = safeSlug(row.name);
  const directory = join(output, slug, row.version);
  mkdirSync(join(directory, 'chunks'), { recursive: true });
  for (const chunk of row.built.chunks) writeFileSync(join(directory, ...chunk.path.split('/')), chunk.bytes);
  writeFileSync(join(directory, 'toolchain.json'), stableJson({
    schema: 1,
    id: row.built.id,
    version: row.version,
    revision: row.built.revision,
    artifacts: [row.built.artifact],
  }));
  writeFileSync(join(directory, 'source-lock.json'), stableJson({
    schema: 1,
    platform: {
      id: row.platformId,
      version: row.platformVersion,
      revision: row.platformRevision,
      libraryDirectory: row.directoryName,
      sourceTreeSha256: row.sourceTreeSha256,
    },
    files: row.built.files.map((file: any) => ({
      path: file.path,
      sha256: sha256(file.bytes),
      ...(file.sourceEncoding ? {
        sourceEncoding: file.sourceEncoding,
        upstreamSha256: file.upstreamSha256,
      } : {}),
    })),
  }));
  return `${slug}/${row.version}/toolchain.json`;
}

function mergeRegistry(base: any, additions: any[]) {
  const platformDefaults = new Map<string, { name: string; version: string }>();
  for (const addition of additions) {
    const key = addition.name.toLowerCase();
    const existing = platformDefaults.get(key);
    if (existing && existing.version !== addition.defaultVersion) {
      throw new Error(`platform library default version is ambiguous: ${addition.name}`);
    }
    platformDefaults.set(key, {
      name: addition.name,
      version: addition.defaultVersion,
    });
  }
  const platformHeaders = new Map<string, string>();
  for (const addition of additions) for (const version of addition.versions) {
    for (const header of version.publicHeaders) {
      const key = header.toLowerCase();
      const owner = platformHeaders.get(key);
      if (owner && owner !== addition.name.toLowerCase()) {
        throw new Error(`platform library public header is ambiguous: ${header}`);
      }
      platformHeaders.set(key, addition.name.toLowerCase());
    }
  }
  const retained = (base.libraries ?? []).flatMap((library: any) => {
    const name = library.name.toLowerCase();
    // A library shipped by the selected platform is the canonical provider
    // for that target. Keeping older same-name catalog versions makes an
    // explicit version request bypass Arduino's platform-library precedence
    // and can combine sources written for a different core ABI.
    if (platformDefaults.has(name)) return [];
    const versions = library.versions.filter((version: any) => !version.publicHeaders.some((header: string) => {
      const owner = platformHeaders.get(header.toLowerCase());
      return owner !== undefined && owner !== name;
    }));
    if (!versions.length) return [];
    const value = structuredClone(library);
    value.versions = versions.map((version: any) => ({
      ...version,
      // Keep existing dependency pins aligned with the selected platform
      // provider so one closure cannot select sources from two platform ABIs.
      depends: version.depends.map((dependency: any) => {
        const platform = platformDefaults.get(dependency.name.toLowerCase());
        return platform ? { name: platform.name, version: platform.version } : dependency;
      }),
    }));
    if (!versions.some((version: any) => version.version === value.defaultVersion)) {
      value.defaultVersion = versions.at(-1).version;
    }
    return [value];
  });
  const byName = new Map(retained.map((library: any) => [library.name.toLowerCase(), library]));
  for (const addition of additions) {
    const key = addition.name.toLowerCase();
    const current: any = byName.get(key);
    if (!current) {
      byName.set(key, structuredClone(addition));
      continue;
    }
    current.defaultVersion = addition.defaultVersion;
    for (const version of addition.versions) {
      const index = current.versions.findIndex((candidate: any) => candidate.version === version.version);
      if (index < 0) current.versions.push(structuredClone(version));
      else current.versions[index] = structuredClone(version);
    }
    current.versions.sort((left: any, right: any) => compareText(left.version, right.version));
  }
  return {
    schema: 2,
    libraries: [...byName.values()].sort((left: any, right: any) => compareText(left.name.toLowerCase(), right.name.toLowerCase())),
  };
}

export function platformPublicHeaders(
  _directoryName: string,
  _libraryName: string,
  declaredValue: string | undefined,
  files: SourceFile[],
): string[] {
  const declared = (declaredValue ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (declared.length) return declared;
  const rootHeaders = files.map((file) => file.path)
    .filter((path) => /^src\/[^/]+\.(?:h|hh|hpp|hxx)$/i.test(path))
    .map((path) => path.slice(4));
  // Arduino exports every root header when library.properties omits
  // `includes=`. Compatibility aliases such as WiFiClientSecure.h are part of
  // that public surface even when a library-named primary header also exists.
  return rootHeaders;
}

export function removeAmbiguousPlatformHeaders(rows: any[]): void {
  const owners = new Map<string, Set<string>>();
  for (const row of rows) for (const version of row.versions) {
    for (const header of version.publicHeaders) {
      const key = header.toLowerCase();
      const names = owners.get(key) ?? new Set<string>();
      names.add(row.name.toLowerCase());
      owners.set(key, names);
    }
  }
  const ambiguous = new Set([...owners]
    .filter(([, names]) => names.size > 1)
    .map(([header]) => header));
  for (const row of rows) for (const version of row.versions) {
    version.publicHeaders = version.publicHeaders.filter(
      (header: string) => !ambiguous.has(header.toLowerCase()),
    );
    if (!version.publicHeaders.length) {
      throw new Error(`platform library has no unambiguous public headers: ${row.name}`);
    }
  }
}

function copyRegistryPacks(registry: any, registryPath: string, output: string) {
  const sourceRoot = dirname(registryPath);
  if (resolve(sourceRoot) === output) return;
  const copied = new Set<string>();
  for (const library of registry.libraries ?? []) for (const version of library.versions ?? []) {
    const manifest = String(version.pack?.manifest ?? '').replaceAll('\\', '/');
    const segments = manifest.split('/');
    if (segments.length < 3 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error(`base registry manifest path is invalid: ${manifest}`);
    }
    const key = segments[0]!;
    if (copied.has(key)) continue;
    copied.add(key);
    cpSync(join(sourceRoot, key), join(output, key), { recursive: true, force: true });
  }
}

function hashSourceTree(files: SourceFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path, 'utf8');
    hash.update('\0');
    hash.update(sha256(file.bytes), 'ascii');
    hash.update('\n');
  }
  return hash.digest('hex');
}

function parseArgs(argv: string[]): PlatformLibraryBuildOptions {
  const values = new Map<string, string>();
  const names: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    const value = argv[++index];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`${key ?? 'argument'} requires a value`);
    if (key === '--name') names.push(value.toLowerCase());
    else values.set(key.slice(2), value);
  }
  for (const key of ['platform-root', 'platform-id', 'platform-version', 'registry', 'output']) {
    if (!values.has(key)) throw new Error(`missing --${key}`);
  }
  return {
    platformRoot: values.get('platform-root')!,
    platformId: values.get('platform-id')!,
    platformVersion: values.get('platform-version')!,
    ...(values.has('platform-revision') ? { platformRevision: values.get('platform-revision')! } : {}),
    registry: values.get('registry')!,
    output: values.get('output')!,
    names,
  };
}

function safeSlug(value: string): string {
  return value.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'library';
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function requireFile(path: string, label: string) {
  if (!isFile(path)) throw new Error(`${label} is missing: ${path}`);
}

function requireDirectory(path: string, label: string) {
  try {
    if (lstatSync(path).isDirectory()) return;
  } catch { /* handled below */ }
  throw new Error(`${label} is missing: ${path}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = buildCkPlatformLibraryPacks(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
