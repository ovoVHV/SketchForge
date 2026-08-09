import { basename } from 'node:path';
import { hashJson, sha256Hex } from './build-ir/canonical.js';
import type { JsonValue } from './build-ir/types.js';
import { libraryIdentity } from './cache/identity.js';
import { buildOptions, resolveOptions, type BoardDefinition } from './toolchain/board.js';
import type { LibraryRegistry } from './toolchain/library.js';

export const CK_FEATURED_PREBUILD_SCHEMA = 1 as const;
export const CK_FEATURED_PREBUILD_KIND = 'ck-featured-library-combinations' as const;

export interface FeaturedLibraryRef {
  name: string;
  version: string;
}

export interface FeaturedPrebuildTarget {
  fqbn: string;
  options?: Record<string, string>;
}

export interface FeaturedLibraryCombination {
  id: string;
  name: string;
  libraries: FeaturedLibraryRef[];
  headers: string[];
  targets: FeaturedPrebuildTarget[];
  /** Includes are prepended automatically. Defaults to empty setup/loop. */
  sketchBody?: string;
}

export interface FeaturedPrebuildSpec {
  schema: typeof CK_FEATURED_PREBUILD_SCHEMA;
  kind: typeof CK_FEATURED_PREBUILD_KIND;
  combinations: FeaturedLibraryCombination[];
}

export interface FeaturedPrebuildEntry {
  id: string;
  combinationId: string;
  combinationName: string;
  fqbn: string;
  options: Record<string, string>;
  libraries: FeaturedLibraryRef[];
  resolvedLibraries: Array<FeaturedLibraryRef & { sha256: string }>;
  source: string;
  sourceSha256: string;
  identity: string;
}

const SAFE_ID = /^[a-z][a-z0-9._-]{0,95}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SAFE_HEADER = /^(?:[A-Za-z0-9_.-]+\/){0,7}[A-Za-z0-9_.-]+\.(?:h|hh|hpp|hxx)$/i;
const SAFE_FQBN = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseFeaturedPrebuildSpec(value: unknown): FeaturedPrebuildSpec {
  if (!object(value) || value.schema !== CK_FEATURED_PREBUILD_SCHEMA || value.kind !== CK_FEATURED_PREBUILD_KIND
    || !Array.isArray(value.combinations) || value.combinations.length < 1 || value.combinations.length > 128) {
    throw new TypeError('featured library combination manifest is invalid');
  }
  const ids = new Set<string>();
  const combinations = value.combinations.map((raw, index) => {
    if (!object(raw) || typeof raw.id !== 'string' || !SAFE_ID.test(raw.id)
      || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 128
      || !Array.isArray(raw.libraries) || raw.libraries.length < 1 || raw.libraries.length > 16
      || !Array.isArray(raw.headers) || raw.headers.length < 1 || raw.headers.length > 64
      || !Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > 32
      || (raw.sketchBody !== undefined && (typeof raw.sketchBody !== 'string' || raw.sketchBody.length > 64 * 1024))) {
      throw new TypeError(`featured combination[${index}] is invalid`);
    }
    if (ids.has(raw.id)) throw new TypeError(`duplicate featured combination ID: ${raw.id}`);
    ids.add(raw.id);
    const refs = new Set<string>();
    const libraries = raw.libraries.map((candidate, libraryIndex) => {
      if (!object(candidate) || typeof candidate.name !== 'string' || !candidate.name.trim()
        || candidate.name.length > 256 || typeof candidate.version !== 'string' || !SAFE_VERSION.test(candidate.version)) {
        throw new TypeError(`featured combination[${index}].libraries[${libraryIndex}] is invalid`);
      }
      const key = candidate.name.trim().toLowerCase();
      if (refs.has(key)) throw new TypeError(`duplicate root library in ${raw.id}: ${candidate.name}`);
      refs.add(key);
      return { name: candidate.name.trim(), version: candidate.version };
    }).sort((left, right) => compareText(left.name.toLowerCase(), right.name.toLowerCase()));
    const headers = [...new Set(raw.headers.map((header) => {
      if (typeof header !== 'string' || !SAFE_HEADER.test(header)) throw new TypeError(`invalid header in ${raw.id}`);
      return header;
    }))].sort(compareText);
    const targets = raw.targets.map((candidate, targetIndex) => {
      if (!object(candidate) || typeof candidate.fqbn !== 'string' || !SAFE_FQBN.test(candidate.fqbn)
        || (candidate.options !== undefined && (!object(candidate.options)
          || Object.keys(candidate.options).length > 32
          || Object.entries(candidate.options).some(([key, option]) => !/^[A-Za-z0-9_.-]{1,64}$/.test(key)
            || typeof option !== 'string' || option.length > 128)))) {
        throw new TypeError(`featured combination[${index}].targets[${targetIndex}] is invalid`);
      }
      return {
        fqbn: candidate.fqbn,
        ...(candidate.options ? { options: Object.fromEntries(Object.entries(candidate.options).sort(([a], [b]) => compareText(a, b))) as Record<string, string> } : {}),
      };
    }).sort((left, right) => compareText(left.fqbn, right.fqbn) || compareText(JSON.stringify(left.options), JSON.stringify(right.options)));
    return {
      id: raw.id,
      name: raw.name.trim(),
      libraries,
      headers,
      targets,
      ...(raw.sketchBody === undefined ? {} : { sketchBody: raw.sketchBody.replace(/\r\n?/g, '\n').trim() }),
    };
  }).sort((left, right) => compareText(left.id, right.id));
  return { schema: CK_FEATURED_PREBUILD_SCHEMA, kind: CK_FEATURED_PREBUILD_KIND, combinations };
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function planFeaturedPrebuildMatrix(
  specInput: FeaturedPrebuildSpec,
  boards: readonly BoardDefinition[],
  libraries: LibraryRegistry,
  compilerBundleId: string,
): FeaturedPrebuildEntry[] {
  const spec = parseFeaturedPrebuildSpec(specInput);
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(compilerBundleId)) throw new TypeError('compiler bundle ID is invalid');
  const byFqbn = new Map(boards.map((board) => [board.fqbn, board] as const));
  const entries: FeaturedPrebuildEntry[] = [];
  for (const combination of spec.combinations) {
    for (const target of combination.targets) {
      const board = byFqbn.get(target.fqbn);
      if (!board) throw new TypeError(`${combination.id} references unknown board ${target.fqbn}`);
      const resolvedOptions = resolveOptions(board, target.options);
      if (resolvedOptions.errors.length > 0) throw new TypeError(`${combination.id}: ${resolvedOptions.errors.join('; ')}`);
      const options = buildOptions(board, resolvedOptions.options);
      for (const root of combination.libraries) {
        const library = libraries.get(root.name, board.arch);
        if (!library) throw new TypeError(`${combination.id}: library ${root.name} does not support ${board.arch}`);
        if (library.manifest.version !== root.version) {
          throw new TypeError(`${combination.id}: expected ${root.name}@${root.version}, found ${library.manifest.version}`);
        }
      }
      const resolution = libraries.resolve(combination.libraries.map((library) => library.name), board.arch);
      if (resolution.errors.length > 0) throw new TypeError(`${combination.id}: ${resolution.errors.join('; ')}`);
      const headers = new Set(resolution.libraries.flatMap((library) => library.headers.map((header) => header.toLowerCase())));
      for (const header of combination.headers) {
        if (!headers.has(basename(header).toLowerCase())) {
          throw new TypeError(`${combination.id}: header ${header} is absent from the resolved library closure`);
        }
      }
      const resolvedLibraries = resolution.libraries.map((library) => ({
        name: library.manifest.name,
        version: library.manifest.version,
        sha256: libraryIdentity(library),
      })).sort((left, right) => compareText(left.name.toLowerCase(), right.name.toLowerCase()));
      const source = [
        ...combination.headers.map((header) => `#include <${header}>`),
        '',
        combination.sketchBody || 'void setup() {}\nvoid loop() {}',
        '',
      ].join('\n');
      const sourceSha256 = sha256Hex(source);
      const identity = hashJson({
        schema: 1,
        kind: 'featured-library-firmware',
        compilerBundleId,
        combinationId: combination.id,
        fqbn: board.fqbn,
        options,
        libraries: resolvedLibraries,
        sourceSha256,
      } as unknown as JsonValue);
      entries.push({
        id: `${combination.id}-${safeId(board.fqbn)}-${identity.slice(0, 16)}`,
        combinationId: combination.id,
        combinationName: combination.name,
        fqbn: board.fqbn,
        options,
        libraries: combination.libraries,
        resolvedLibraries,
        source,
        sourceSha256,
        identity,
      });
    }
  }
  return entries.sort((left, right) => compareText(left.combinationId, right.combinationId)
    || compareText(left.fqbn, right.fqbn) || compareText(left.identity, right.identity));
}
