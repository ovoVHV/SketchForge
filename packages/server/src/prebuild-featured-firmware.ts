/** Release-time publication of explicitly curated library firmware combinations. */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BoardRegistry,
  CompileService,
  LibraryRegistry,
  LocalExecutor,
  detectLocalToolchain,
  esp32BoardSupported,
  hashJson,
  parseFeaturedPrebuildSpec,
  parsePrebuildShard,
  planFeaturedPrebuildMatrix,
  selectPrebuildShard,
  type Artifact,
  type BuildIR,
  type FeaturedPrebuildEntry,
  type JsonValue,
} from '@arduinofast/core';
import { createArtifactStore, type ArtifactStore } from './artifact-store.js';
import { loadPublishedPlatformManifests } from './platform-manifests.js';
import {
  compilerRuntimeEvidenceFromEnvironment,
  normalizeCompilerRuntimeEvidence,
  type CompilerRuntimeEvidence,
} from './compiler-runtime-release.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SHA256 = /^[a-f0-9]{64}$/;

export interface PublishedFeaturedFirmwareEntry {
  id: string;
  combinationId: string;
  combinationName: string;
  fqbn: string;
  options: Record<string, string>;
  combinationIdentity: string;
  sourceSha256: string;
  buildIrSha256: string;
  packSetSha256: string;
  resolvedLibraries: Array<{ name: string; version: string; sha256: string }>;
  cacheReplay: { actions: number; cachedActions: number; allCached: true };
  artifacts: Array<Pick<Artifact, 'name' | 'offset' | 'sha256' | 'size' | 'url'>>;
}

export interface FeaturedFirmwareManifest {
  schema: 2;
  kind: 'ck-featured-firmware-manifest';
  compilerBundleId: string;
  runtimeIdentities: readonly CompilerRuntimeEvidence[];
  generatedAt: string;
  entries: PublishedFeaturedFirmwareEntry[];
  manifestSha256: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function packSetIdentity(ir: BuildIR): string {
  return hashJson(ir.packs as unknown as JsonValue);
}

function normalizeEntry(entry: PublishedFeaturedFirmwareEntry): PublishedFeaturedFirmwareEntry {
  return {
    ...entry,
    options: Object.fromEntries(Object.entries(entry.options).sort(([left], [right]) => compareText(left, right))),
    resolvedLibraries: [...entry.resolvedLibraries].sort((left, right) => (
      compareText(left.name.toLowerCase(), right.name.toLowerCase()) || compareText(left.version, right.version)
    )),
    artifacts: [...entry.artifacts].sort((left, right) => compareText(left.name, right.name)),
  };
}

export function createFeaturedFirmwareManifest(
  compilerBundleId: string,
  runtimeIdentities: readonly CompilerRuntimeEvidence[],
  entries: readonly PublishedFeaturedFirmwareEntry[],
  generatedAt = new Date().toISOString(),
): FeaturedFirmwareManifest {
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(compilerBundleId)) throw new TypeError('compiler bundle ID is invalid');
  const normalizedRuntimeIdentities = normalizeCompilerRuntimeEvidence(runtimeIdentities);
  if (!Number.isFinite(Date.parse(generatedAt))) throw new TypeError('featured firmware generatedAt is invalid');
  const normalized = entries.map(normalizeEntry).sort((left, right) => (
    compareText(left.combinationId, right.combinationId)
      || compareText(left.fqbn, right.fqbn)
      || compareText(left.id, right.id)
  ));
  const body = {
    schema: 2 as const,
    kind: 'ck-featured-firmware-manifest' as const,
    compilerBundleId,
    runtimeIdentities: normalizedRuntimeIdentities,
    generatedAt,
    entries: normalized,
  };
  return { ...body, manifestSha256: hashJson(body as unknown as JsonValue) };
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertArtifact(value: unknown, source: string): void {
  if (!object(value) || typeof value.name !== 'string' || !value.name
    || (value.offset !== null && typeof value.offset !== 'string')
    || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)
    || !Number.isSafeInteger(value.size) || Number(value.size) < 1
    || (value.url !== undefined && (typeof value.url !== 'string' || value.url.length > 4_096))) {
    throw new TypeError(`${source}: featured firmware artifact is invalid`);
  }
}

function assertEntry(value: unknown, source: string): asserts value is PublishedFeaturedFirmwareEntry {
  if (!object(value) || typeof value.id !== 'string' || !value.id
    || typeof value.combinationId !== 'string' || !value.combinationId
    || typeof value.combinationName !== 'string' || !value.combinationName
    || typeof value.fqbn !== 'string' || !value.fqbn
    || !object(value.options)
    || Object.values(value.options).some((option) => typeof option !== 'string')
    || typeof value.combinationIdentity !== 'string' || !SHA256.test(value.combinationIdentity)
    || typeof value.sourceSha256 !== 'string' || !SHA256.test(value.sourceSha256)
    || typeof value.buildIrSha256 !== 'string' || !SHA256.test(value.buildIrSha256)
    || typeof value.packSetSha256 !== 'string' || !SHA256.test(value.packSetSha256)
    || !Array.isArray(value.resolvedLibraries) || value.resolvedLibraries.length < 1
    || value.resolvedLibraries.some((library) => !object(library)
      || typeof library.name !== 'string' || !library.name
      || typeof library.version !== 'string' || !library.version
      || typeof library.sha256 !== 'string' || !SHA256.test(library.sha256))
    || !object(value.cacheReplay)
    || !Number.isSafeInteger(value.cacheReplay.actions) || Number(value.cacheReplay.actions) < 1
    || value.cacheReplay.cachedActions !== value.cacheReplay.actions
    || value.cacheReplay.allCached !== true
    || !Array.isArray(value.artifacts) || value.artifacts.length < 1) {
    throw new TypeError(`${source}: featured firmware entry is invalid`);
  }
  value.artifacts.forEach((artifact, index) => assertArtifact(artifact, `${source}.artifacts[${index}]`));
}

export function assertFeaturedFirmwareManifest(
  value: unknown,
  source = 'featured firmware manifest',
): asserts value is FeaturedFirmwareManifest {
  if (!object(value) || value.schema !== 2 || value.kind !== 'ck-featured-firmware-manifest'
    || typeof value.compilerBundleId !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/.test(value.compilerBundleId)
    || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))
    || !Array.isArray(value.entries)
    || typeof value.manifestSha256 !== 'string' || !SHA256.test(value.manifestSha256)) {
    throw new TypeError(`${source}: unsupported featured firmware manifest schema`);
  }
  if (!Array.isArray(value.runtimeIdentities)) {
    throw new TypeError(`${source}: compiler runtime identities are missing`);
  }
  const runtimeIdentities = normalizeCompilerRuntimeEvidence(
    value.runtimeIdentities as unknown as CompilerRuntimeEvidence[],
  );
  if (JSON.stringify(value.runtimeIdentities) !== JSON.stringify(runtimeIdentities)) {
    throw new TypeError(`${source}: compiler runtime identities are not canonical`);
  }
  value.entries.forEach((entry, index) => assertEntry(entry, `${source}.entries[${index}]`));
  const { manifestSha256, ...body } = value as unknown as FeaturedFirmwareManifest;
  if (hashJson(body as unknown as JsonValue) !== manifestSha256) {
    throw new TypeError(`${source}: manifest digest mismatch`);
  }
}

export function mergeFeaturedFirmwareManifests(
  manifests: readonly FeaturedFirmwareManifest[],
): FeaturedFirmwareManifest {
  if (manifests.length === 0) throw new TypeError('at least one featured firmware manifest is required');
  manifests.forEach((manifest, index) => assertFeaturedFirmwareManifest(manifest, `manifest[${index}]`));
  const compilerBundleId = manifests[0]!.compilerBundleId;
  if (manifests.some((manifest) => manifest.compilerBundleId !== compilerBundleId)) {
    throw new TypeError('cannot merge featured firmware manifests from different compiler bundles');
  }
  const runtimeIdentities = normalizeCompilerRuntimeEvidence(
    manifests.flatMap((manifest) => manifest.runtimeIdentities),
  );
  const entries: PublishedFeaturedFirmwareEntry[] = [];
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      if (ids.has(entry.id)) throw new TypeError(`duplicate featured firmware entry ID: ${entry.id}`);
      if (identities.has(entry.combinationIdentity)) {
        throw new TypeError(`duplicate featured firmware combination identity: ${entry.combinationIdentity}`);
      }
      ids.add(entry.id);
      identities.add(entry.combinationIdentity);
      entries.push(entry);
    }
  }
  const generatedAt = manifests.map((manifest) => manifest.generatedAt).sort(compareText).at(-1)!;
  return createFeaturedFirmwareManifest(compilerBundleId, runtimeIdentities, entries, generatedAt);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function mergeFeaturedFirmwareManifestFiles(
  output: string,
  inputs: readonly string[],
): Promise<FeaturedFirmwareManifest> {
  const manifests: FeaturedFirmwareManifest[] = [];
  for (const input of inputs) {
    const info = await stat(input);
    if (!info.isFile() || info.size < 2 || info.size > 32 * 1024 * 1024) {
      throw new TypeError(`${input}: manifest file size is invalid`);
    }
    const value = JSON.parse(await readFile(input, 'utf8')) as unknown;
    assertFeaturedFirmwareManifest(value, input);
    manifests.push(value);
  }
  const merged = mergeFeaturedFirmwareManifests(manifests);
  await atomicJson(output, merged);
  return merged;
}

function allowlist(raw: string | undefined): Set<string> | null {
  if (raw === undefined || !raw.trim()) return null;
  const values = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
  if (values.length === 0) throw new Error('AF_FEATURED_PREBUILD_BOARDS does not contain a board FQBN');
  return new Set(values);
}

async function publishEntry(
  compiler: CompileService,
  artifacts: ArtifactStore,
  entry: FeaturedPrebuildEntry,
  requireDirectUrl: boolean,
): Promise<PublishedFeaturedFirmwareEntry> {
  const ir = await compiler.planActionGraph({
    board: entry.fqbn,
    options: entry.options,
    files: [{ name: `${entry.combinationId}.ino`, content: entry.source }],
  });
  const first = await compiler.compileBuildIR(ir);
  if (first.status !== 'success') {
    throw new Error(`${entry.id}: ${first.reason}: ${first.message}`);
  }
  let replayActions = 0;
  let replayCachedActions = 0;
  const replay = await compiler.compileBuildIR(ir, () => {}, {
    onProgress: ({ cached }) => {
      replayActions += 1;
      if (cached) replayCachedActions += 1;
    },
  });
  if (replay.status !== 'success' || !replay.cached
    || replayActions !== ir.graph.actions.length || replayCachedActions !== replayActions) {
    throw new Error(`${entry.id}: Action cache replay missed (${replayCachedActions}/${replayActions})`);
  }

  // Static ESP32 shards have their own release manifest and must not be uploaded again here.
  const externalized = await artifacts.externalize({ ...first, staticArtifacts: [] });
  if (externalized.status !== 'success') throw new Error(`${entry.id}: artifact externalization failed`);
  if (externalized.artifacts.length === 0) throw new Error(`${entry.id}: compile produced no user firmware`);
  if (requireDirectUrl && externalized.artifacts.some((artifact) => !/^https:\/\//.test(artifact.url ?? ''))) {
    throw new Error(`${entry.id}: did not publish direct HTTPS firmware URLs`);
  }
  return {
    id: entry.id,
    combinationId: entry.combinationId,
    combinationName: entry.combinationName,
    fqbn: entry.fqbn,
    options: entry.options,
    combinationIdentity: entry.identity,
    sourceSha256: entry.sourceSha256,
    buildIrSha256: hashJson(ir as unknown as JsonValue),
    packSetSha256: packSetIdentity(ir),
    resolvedLibraries: entry.resolvedLibraries,
    cacheReplay: {
      actions: replayActions,
      cachedActions: replayCachedActions,
      allCached: true,
    },
    artifacts: externalized.artifacts.map((artifact) => ({
      name: artifact.name,
      offset: artifact.offset,
      sha256: artifact.sha256,
      size: artifact.size,
      url: artifact.url,
    })),
  };
}

export interface PrebuildFeaturedFirmwareOptions {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export async function prebuildFeaturedFirmware(
  options: PrebuildFeaturedFirmwareOptions = {},
): Promise<FeaturedFirmwareManifest> {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const compilerBundleId = env.AF_COMPILER_BUNDLE_ID?.trim() ?? '';
  if (!compilerBundleId) throw new Error('AF_COMPILER_BUNDLE_ID is required');
  const runtimeIdentity = compilerRuntimeEvidenceFromEnvironment(env, compilerBundleId);
  const specPath = resolve(env.AF_FEATURED_PREBUILD_SPEC
    ?? join(repoRoot, 'prebuild', 'featured-library-combinations.json'));
  const specInfo = await stat(specPath);
  if (!specInfo.isFile() || specInfo.size < 2 || specInfo.size > 1024 * 1024) {
    throw new TypeError('featured prebuild specification size is invalid');
  }
  const spec = parseFeaturedPrebuildSpec(JSON.parse(await readFile(specPath, 'utf8')) as unknown);
  const detected = detectLocalToolchain();
  if (!detected.avr && !detected.esp32) throw new Error('a native AVR or ESP32 toolchain is required');
  const registry = BoardRegistry.fromDirectory(join(repoRoot, 'boards'));
  const libraries = LibraryRegistry.fromDirectories(detected.librariesDirs);
  const selected = allowlist(env.AF_FEATURED_PREBUILD_BOARDS);
  const usableBoards = registry.list().filter((board) => {
    if (selected && !selected.has(board.fqbn)) return false;
    if (board.arch === 'avr') return Boolean(detected.avr);
    return board.arch === 'esp32' && Boolean(detected.esp32 && esp32BoardSupported(detected.esp32, board));
  });
  if (selected) {
    const missing = [...selected].filter((fqbn) => !usableBoards.some((board) => board.fqbn === fqbn));
    if (missing.length > 0) throw new Error(`unsupported featured firmware board(s): ${missing.join(', ')}`);
  }
  const usable = new Set(usableBoards.map((board) => board.fqbn));
  const allEntries = planFeaturedPrebuildMatrix(spec, registry.list(), libraries, compilerBundleId)
    .filter((entry) => usable.has(entry.fqbn));
  const shard = parsePrebuildShard(env.AF_PREBUILD_SHARD);
  const entries = selectPrebuildShard(allEntries, shard);
  const maxEntries = Number(env.AF_FEATURED_PREBUILD_MAX_ENTRIES ?? 1_000);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || entries.length > maxEntries) {
    throw new Error(`featured firmware matrix has ${entries.length} entries; AF_FEATURED_PREBUILD_MAX_ENTRIES=${String(maxEntries)}`);
  }
  if (entries.length === 0) throw new Error('featured firmware selection is empty');
  log(`Featured firmware shard ${shard.index + 1}/${shard.total}: ${entries.length}/${allEntries.length} identities`);
  const hasEsp32 = entries.some((entry) => entry.fqbn.startsWith('esp32:'));
  const compiler = new CompileService({
    boards: registry,
    toolchain: detected,
    executor: new LocalExecutor(),
    libraries,
    compilerBundleId,
    platformManifests: hasEsp32 ? loadPublishedPlatformManifests({ repoRoot }) : [],
  });
  const artifactStore = createArtifactStore({
    rootDir: resolve(env.AF_ARTIFACT_DIR ?? join(repoRoot, 'var', 'featured-firmware-artifacts')),
    env,
  });
  const published: PublishedFeaturedFirmwareEntry[] = [];
  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      log(`[${index + 1}/${entries.length}] ${entry.combinationId} ${entry.fqbn}`);
      published.push(await publishEntry(
        compiler,
        artifactStore,
        entry,
        env.AF_FEATURED_PREBUILD_REQUIRE_DIRECT_URL === '1',
      ));
    }
  } finally {
    await artifactStore.close?.();
  }
  const manifest = createFeaturedFirmwareManifest(compilerBundleId, [runtimeIdentity], published);
  const output = resolve(env.AF_FEATURED_PREBUILD_OUTPUT
    ?? join(repoRoot, 'var', 'featured-firmware', 'manifest.json'));
  await atomicJson(output, manifest);
  log(`Published ${manifest.entries.length} featured firmware identities: ${output}`);
  return manifest;
}

export async function runPrebuildFeaturedFirmwareCli(): Promise<void> {
  try {
    await prebuildFeaturedFirmware();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
