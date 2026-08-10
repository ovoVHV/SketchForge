/** Release-time publication of immutable ESP32 bootloader/partition assets. */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BoardRegistry,
  CompileService,
  LocalExecutor,
  detectLocalToolchain,
  esp32BoardSupported,
  hashJson,
  parsePrebuildShard,
  planPrebuildMatrix,
  selectPrebuildShard,
  type Artifact,
  type BuildIR,
  type CompileResult,
  type JsonValue,
  type PrebuildMatrixEntry,
} from '@sketchforge/core';
import { createArtifactStore, type ArtifactStore } from './artifact-store.js';
import { loadPublishedPlatformManifests } from './platform-manifests.js';
import {
  compilerRuntimeEvidenceFromEnvironment,
  normalizeCompilerRuntimeEvidence,
  type CompilerRuntimeEvidence,
} from './compiler-runtime-release.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKETCH = 'void setup() {}\nvoid loop() {}\n';

export interface PublishedStaticFirmwareEntry {
  id: string;
  fqbn: string;
  options: Record<string, string>;
  matrixIdentity: string;
  buildIrSha256: string;
  packSetSha256: string;
  artifacts: Array<Pick<Artifact, 'name' | 'offset' | 'sha256' | 'size' | 'url'>>;
}

export interface PrebuiltFirmwareManifest {
  schema: 2;
  kind: 'ck-static-firmware-manifest';
  compilerBundleId: string;
  runtimeIdentities: readonly CompilerRuntimeEvidence[];
  generatedAt: string;
  entries: PublishedStaticFirmwareEntry[];
  manifestSha256: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function packSetIdentity(ir: BuildIR): string {
  return hashJson({
    toolchain: ir.packs.toolchain,
    platform: ir.packs.platform,
    board: ir.packs.board,
    libraries: ir.packs.libraries.packs,
  } as unknown as JsonValue);
}

export function createPrebuiltFirmwareManifest(
  compilerBundleId: string,
  runtimeIdentities: readonly CompilerRuntimeEvidence[],
  entries: readonly PublishedStaticFirmwareEntry[],
  generatedAt = new Date().toISOString(),
): PrebuiltFirmwareManifest {
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(compilerBundleId)) throw new TypeError('compiler bundle ID is invalid');
  const normalizedRuntimeIdentities = normalizeCompilerRuntimeEvidence(runtimeIdentities);
  const normalized = entries.map((entry) => ({
    ...entry,
    options: Object.fromEntries(Object.entries(entry.options).sort(([left], [right]) => compareText(left, right))),
    artifacts: [...entry.artifacts].sort((left, right) => compareText(left.name, right.name)),
  })).sort((left, right) => compareText(left.fqbn, right.fqbn) || compareText(left.id, right.id));
  const body = {
    schema: 2 as const,
    kind: 'ck-static-firmware-manifest' as const,
    compilerBundleId,
    runtimeIdentities: normalizedRuntimeIdentities,
    generatedAt,
    entries: normalized,
  };
  return { ...body, manifestSha256: hashJson(body as unknown as JsonValue) };
}

function assertPrebuiltFirmwareManifest(value: unknown, source: string): asserts value is PrebuiltFirmwareManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${source}: manifest must be an object`);
  const candidate = value as Partial<PrebuiltFirmwareManifest>;
  if (candidate.schema !== 2 || candidate.kind !== 'ck-static-firmware-manifest') {
    throw new TypeError(`${source}: unsupported static firmware manifest schema`);
  }
  if (typeof candidate.compilerBundleId !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/.test(candidate.compilerBundleId)) {
    throw new TypeError(`${source}: compiler bundle ID is invalid`);
  }
  if (!Array.isArray(candidate.runtimeIdentities)) {
    throw new TypeError(`${source}: compiler runtime identities are missing`);
  }
  const runtimeIdentities = normalizeCompilerRuntimeEvidence(candidate.runtimeIdentities);
  if (JSON.stringify(candidate.runtimeIdentities) !== JSON.stringify(runtimeIdentities)) {
    throw new TypeError(`${source}: compiler runtime identities are not canonical`);
  }
  if (typeof candidate.generatedAt !== 'string' || !Number.isFinite(Date.parse(candidate.generatedAt))) {
    throw new TypeError(`${source}: generatedAt is invalid`);
  }
  if (!Array.isArray(candidate.entries) || typeof candidate.manifestSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(candidate.manifestSha256)) {
    throw new TypeError(`${source}: entries or digest is invalid`);
  }
  const { manifestSha256, ...body } = candidate as PrebuiltFirmwareManifest;
  if (hashJson(body as unknown as JsonValue) !== manifestSha256) {
    throw new TypeError(`${source}: manifest digest mismatch`);
  }
}

export function mergePrebuiltFirmwareManifests(
  manifests: readonly PrebuiltFirmwareManifest[],
): PrebuiltFirmwareManifest {
  if (manifests.length === 0) throw new TypeError('at least one static firmware manifest is required');
  manifests.forEach((manifest, index) => assertPrebuiltFirmwareManifest(manifest, `manifest[${index}]`));
  const compilerBundleId = manifests[0]!.compilerBundleId;
  if (manifests.some((manifest) => manifest.compilerBundleId !== compilerBundleId)) {
    throw new TypeError('cannot merge static firmware manifests from different compiler bundles');
  }
  const runtimeIdentities = normalizeCompilerRuntimeEvidence(
    manifests.flatMap((manifest) => manifest.runtimeIdentities),
  );
  const entries: PublishedStaticFirmwareEntry[] = [];
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string'
        || typeof entry.matrixIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(entry.matrixIdentity)) {
        throw new TypeError('static firmware manifest contains an invalid entry');
      }
      if (ids.has(entry.id)) throw new TypeError(`duplicate static firmware entry ID: ${entry.id}`);
      if (identities.has(entry.matrixIdentity)) {
        throw new TypeError(`duplicate static firmware matrix identity: ${entry.matrixIdentity}`);
      }
      ids.add(entry.id);
      identities.add(entry.matrixIdentity);
      entries.push(entry);
    }
  }
  const generatedAt = manifests.map((manifest) => manifest.generatedAt).sort(compareText).at(-1)!;
  return createPrebuiltFirmwareManifest(compilerBundleId, runtimeIdentities, entries, generatedAt);
}

export async function mergePrebuiltFirmwareManifestFiles(
  output: string,
  inputs: readonly string[],
): Promise<PrebuiltFirmwareManifest> {
  const manifests: PrebuiltFirmwareManifest[] = [];
  for (const input of inputs) {
    const info = await stat(input);
    if (!info.isFile() || info.size < 2 || info.size > 32 * 1024 * 1024) {
      throw new TypeError(`${input}: manifest file size is invalid`);
    }
    const value = JSON.parse(await readFile(input, 'utf8')) as unknown;
    assertPrebuiltFirmwareManifest(value, input);
    manifests.push(value);
  }
  const merged = mergePrebuiltFirmwareManifests(manifests);
  await atomicJson(output, merged);
  return merged;
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

function allowlist(raw: string | undefined): Set<string> | null {
  if (raw === undefined || !raw.trim()) return null;
  const values = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
  if (values.length === 0) throw new Error('AF_PREBUILD_BOARDS does not contain a board FQBN');
  return new Set(values);
}

async function publishEntry(
  compiler: CompileService,
  artifacts: ArtifactStore,
  entry: PrebuildMatrixEntry,
  requireDirectUrl: boolean,
): Promise<PublishedStaticFirmwareEntry> {
  const ir = await compiler.planActionGraph({
    board: entry.fqbn,
    options: entry.options,
    files: [{ name: 'prebuild.ino', content: SKETCH }],
  });
  const result = await compiler.compileStaticBuildIR(ir);
  if (result.status !== 'success') {
    throw new Error(`${entry.fqbn} ${JSON.stringify(entry.options)}: ${result.reason}: ${result.message}`);
  }
  if (result.staticArtifacts.length !== 3) {
    throw new Error(`${entry.fqbn} produced ${result.staticArtifacts.length} static artifacts, expected 3`);
  }
  const externalized = await artifacts.externalize({ ...result, artifacts: [] });
  if (externalized.status !== 'success') throw new Error(`${entry.fqbn} static artifact externalization failed`);
  if (requireDirectUrl && externalized.staticArtifacts.some((artifact) => !/^https:\/\//.test(artifact.url ?? ''))) {
    throw new Error(`${entry.fqbn} did not publish direct HTTPS static artifact URLs`);
  }
  return {
    id: entry.id,
    fqbn: entry.fqbn,
    options: entry.options,
    matrixIdentity: entry.identity,
    buildIrSha256: hashJson(ir as unknown as JsonValue),
    packSetSha256: packSetIdentity(ir),
    artifacts: externalized.staticArtifacts.map((artifact) => ({
      name: artifact.name,
      offset: artifact.offset,
      sha256: artifact.sha256,
      size: artifact.size,
      url: artifact.url,
    })),
  };
}

export interface PrebuildFirmwareAssetsOptions {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export async function prebuildFirmwareAssets(options: PrebuildFirmwareAssetsOptions = {}): Promise<PrebuiltFirmwareManifest> {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const compilerBundleId = env.AF_COMPILER_BUNDLE_ID?.trim() ?? '';
  if (!compilerBundleId) throw new Error('AF_COMPILER_BUNDLE_ID is required');
  const runtimeIdentity = compilerRuntimeEvidenceFromEnvironment(env, compilerBundleId);
  const detected = detectLocalToolchain();
  if (!detected.esp32) throw new Error('ESP32 toolchain is required to prebuild static firmware');
  const registry = BoardRegistry.fromDirectory(join(repoRoot, 'boards'));
  const selected = allowlist(env.AF_PREBUILD_BOARDS);
  const boards = registry.list().filter((board) => (
    board.arch === 'esp32'
    && (!selected || selected.has(board.fqbn))
    && esp32BoardSupported(detected.esp32!, board)
  ));
  if (selected) {
    const missing = [...selected].filter((fqbn) => !boards.some((board) => board.fqbn === fqbn));
    if (missing.length > 0) throw new Error(`unsupported static firmware board(s): ${missing.join(', ')}`);
  }
  const allEntries = planPrebuildMatrix(boards, ['static-firmware']);
  const shard = parsePrebuildShard(env.AF_PREBUILD_SHARD);
  const entries = selectPrebuildShard(allEntries, shard);
  const maxEntries = Number(env.AF_PREBUILD_MAX_ENTRIES ?? 10_000);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || entries.length > maxEntries) {
    throw new Error(`static firmware matrix has ${entries.length} entries; AF_PREBUILD_MAX_ENTRIES=${String(maxEntries)}`);
  }
  log(`Static firmware shard ${shard.index + 1}/${shard.total}: ${entries.length}/${allEntries.length} identities`);
  const compiler = new CompileService({
    boards: registry,
    toolchain: detected,
    executor: new LocalExecutor(),
    compilerBundleId,
    platformManifests: loadPublishedPlatformManifests({ repoRoot }),
  });
  const artifactStore = createArtifactStore({
    rootDir: resolve(env.AF_ARTIFACT_DIR ?? join(repoRoot, 'var', 'prebuilt-artifacts')),
    env,
  });
  const published: PublishedStaticFirmwareEntry[] = [];
  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      log(`[${index + 1}/${entries.length}] ${entry.fqbn} ${JSON.stringify(entry.options)}`);
      published.push(await publishEntry(
        compiler,
        artifactStore,
        entry,
        env.AF_PREBUILD_REQUIRE_DIRECT_URL === '1',
      ));
    }
  } finally {
    await artifactStore.close?.();
  }
  const manifest = createPrebuiltFirmwareManifest(compilerBundleId, [runtimeIdentity], published);
  const output = resolve(env.AF_PREBUILD_OUTPUT ?? join(repoRoot, 'var', 'prebuilt-firmware', 'manifest.json'));
  await atomicJson(output, manifest);
  log(`Published ${manifest.entries.length} static firmware identities: ${output}`);
  return manifest;
}

export async function runPrebuildFirmwareAssetsCli(): Promise<void> {
  try {
    await prebuildFirmwareAssets();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
