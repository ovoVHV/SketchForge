import { createBrowserToolchainPackLoader } from '../../avr/v3/toolchain-pack.js?recovery=20260809';
import {
  ESP32_C3_RUNTIME_PACK_LIMITS,
  resolveEsp32RuntimePackManifestUrl,
} from '../v1/c3-runtime.js';
import { materializeEsp32PackArtifactTrees } from './c3-compiler.js';

const SHA256 = /^[a-f0-9]{64}$/;
const STABLE_PACK_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/;
const ESP32_ESP_SR_MODEL = Object.freeze({
  partitionScheme: 'esp_sr_16',
  artifactId: 'srmodels',
  path: 'packs/board/srmodels.bin',
  role: 'model-source',
  output: 'build/srmodels.bin',
  offset: '0xd10000',
  capacity: 0x2f0000,
  size: 2468362,
  sha256: '0312f2dde9581cd604e752fbfa287d687a2acc0631e593a35a24c4a518d75879',
  flashBytes: 16 * 1024 * 1024,
});
const POST_LINK_BOARD_INPUT_ROLES = Object.freeze({
  'packs/board/bootloader.bin': 'bootloader-source',
  'packs/board/partitions.bin': 'partitions-source',
  'packs/board/boot_app0.bin': 'boot-app0-source',
  [ESP32_ESP_SR_MODEL.path]: ESP32_ESP_SR_MODEL.role,
});
const POST_LINK_BOARD_ROLES = new Set(Object.values(POST_LINK_BOARD_INPUT_ROLES));

/** Materialize only Pack files explicitly named by the CK Build IR. */
export function createEsp32BrowserPackProvider({ capability, planning, ir, dependencies = {} } = {}) {
  const descriptor = capability?.pinnedRuntime?.descriptor;
  const descriptorUrl = capability?.pinnedRuntime?.descriptorUrl;
  if (!descriptor || !descriptorUrl || !planning?.platformManifest || !ir?.packs || !ir?.graph?.actions) {
    throw new TypeError('ESP32 browser Pack provider inputs are incomplete');
  }
  const expectedPacks = bindBuildPacksToRuntime(ir.packs, descriptor, planning);
  const packLoaderFactory = typeof dependencies.createPackLoader === 'function'
    ? dependencies.createPackLoader
    : createBrowserToolchainPackLoader;
  const espSr16 = resolveEspSr16PackProfile(planning, ir);
  const { requested, boardArtifacts } = collectPackRequests(
    ir.graph.actions,
    expectedPacks.board,
    espSr16,
  );

  return Object.freeze({
    async materialize(packs, context) {
      assertSameBuildPackIdentity(expectedPacks, packs);
      await materializeLibrarySources(planning.librarySources, requested, context);
      await materializePlatformFiles(
        descriptor,
        descriptorUrl,
        planning.platformManifest,
        requested,
        context,
        packLoaderFactory,
        expectedPacks.platform.version,
      );
      await materializeBoardFiles(
        descriptor,
        descriptorUrl,
        planning,
        requested,
        context,
        packLoaderFactory,
        expectedPacks.board,
        boardArtifacts,
      );
      const missing = [...requested].filter(([path]) => !context.hasFile(path)).map(([path]) => path);
      if (missing.length) throw new Error(`ESP32 Pack files are missing: ${missing.join(', ')}`);
    },
  });
}

function resolveEspSr16PackProfile(planning, ir) {
  const targetValues = [
    ir?.target?.options?.partition_scheme,
    ir?.target?.options?.PartitionScheme,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  const flashProfile = planning?.platformManifest?.flash;
  const selected = targetValues.includes(ESP32_ESP_SR_MODEL.partitionScheme);
  if (!selected) return false;
  if (targetValues.some((value) => value !== ESP32_ESP_SR_MODEL.partitionScheme)) {
    throw new TypeError('ESP32 esp_sr_16 Pack profile does not match the Build IR target');
  }
  const model = flashProfile?.model;
  if (!model || typeof model !== 'object' || Array.isArray(model)
    || model.artifactId !== ESP32_ESP_SR_MODEL.artifactId
    || model.offset !== ESP32_ESP_SR_MODEL.offset
    || model.size !== ESP32_ESP_SR_MODEL.size
    || model.capacity !== ESP32_ESP_SR_MODEL.capacity
    || model.size > model.capacity
    || BigInt(model.offset) + BigInt(model.capacity) > BigInt(ESP32_ESP_SR_MODEL.flashBytes)) {
    throw new TypeError('ESP32 esp_sr_16 Pack model profile is invalid');
  }
  const flashSizeValues = [
    ir?.target?.options?.flash_size,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  if (!flashSizeValues.length || flashSizeValues.some((value) => (
    parseEsp32FlashSizeBytes(value) !== ESP32_ESP_SR_MODEL.flashBytes
  ))) {
    throw new TypeError('ESP32 esp_sr_16 Pack profile requires a 16MB flash layout');
  }
  return true;
}

function parseEsp32FlashSizeBytes(value) {
  const match = /^(\d+)(B|KB|K|MB|M)$/i.exec(value.trim());
  if (!match) throw new TypeError(`ESP32 Pack flash size is invalid: ${value}`);
  const amount = BigInt(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = unit === 'B' ? 1n
    : unit === 'K' || unit === 'KB' ? 1024n
      : 1024n * 1024n;
  const bytes = amount * multiplier;
  if (bytes <= 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`ESP32 Pack flash size is out of range: ${value}`);
  }
  return Number(bytes);
}

function collectPackRequests(actions, boardPack, espSr16 = false) {
  const requested = new Map();
  const boardArtifacts = new Map();
  let modelRequestCount = 0;
  let modelProvenanceCount = 0;
  for (const action of actions) {
    const inputs = Array.isArray(action?.inputs) ? action.inputs : [];
    const packInputs = Array.isArray(action?.packInputs) ? action.packInputs : [];
    for (const input of inputs) {
      if (typeof input?.path !== 'string' || !input.path.startsWith('packs/')) continue;
      if (input.path === ESP32_ESP_SR_MODEL.path) {
        if (!espSr16) {
          throw new TypeError('ESP32 model Pack request is only valid for esp_sr_16');
        }
        modelRequestCount += 1;
      }
      const previous = requested.get(input.path);
      if (requested.has(input.path)
        && previous !== undefined
        && input.sha256 !== undefined
        && previous !== input.sha256) {
        throw new TypeError(`ESP32 Pack input hash conflict: ${input.path}`);
      }
      if (!requested.has(input.path) || previous === undefined) requested.set(input.path, input.sha256);

      const expectedRole = POST_LINK_BOARD_INPUT_ROLES[input.path];
      if (expectedRole === undefined) continue;
      if (input.role !== expectedRole || !SHA256.test(input.sha256)) {
        throw new TypeError(`ESP32 post-link Board Pack request is invalid: ${input.path}`);
      }
      const provenance = packInputs.filter((candidate) => candidate?.role === expectedRole);
      if (provenance.length !== 1) {
        throw new TypeError(`ESP32 post-link Board Pack provenance is missing or ambiguous: ${input.path}`);
      }
      const binding = normalizeBoardArtifactBinding(provenance[0], boardPack, input);
      if (input.path === ESP32_ESP_SR_MODEL.path && !isExactEspSr16ModelBinding(binding)) {
        throw new TypeError('ESP32 esp_sr_16 model Pack binding is invalid');
      }
      const previousBinding = boardArtifacts.get(input.path);
      if (previousBinding !== undefined && !sameBoardArtifactBinding(previousBinding, binding)) {
        throw new TypeError(`ESP32 post-link Board Pack provenance conflicts: ${input.path}`);
      }
      boardArtifacts.set(input.path, binding);
    }
    for (const packInput of packInputs) {
      if (packInput?.role === ESP32_ESP_SR_MODEL.role) {
        if (!espSr16) {
          throw new TypeError('ESP32 model-source provenance is only valid for esp_sr_16');
        }
        modelProvenanceCount += 1;
      }
      if (!POST_LINK_BOARD_ROLES.has(packInput?.role)) continue;
      const path = Object.keys(POST_LINK_BOARD_INPUT_ROLES)
        .find((candidate) => POST_LINK_BOARD_INPUT_ROLES[candidate] === packInput.role);
      const matches = inputs.filter((input) => input?.path === path && input.role === packInput.role);
      if (matches.length !== 1 || matches[0].sha256 !== packInput.sha256) {
        throw new TypeError(`ESP32 post-link Board Pack provenance has no exact file request: ${packInput.role}`);
      }
    }
  }
  if (espSr16) {
    const modelBinding = boardArtifacts.get(ESP32_ESP_SR_MODEL.path);
    if (modelRequestCount !== 1 || modelProvenanceCount !== 1
      || !modelBinding || !isExactEspSr16ModelBinding(modelBinding)) {
      throw new TypeError('ESP32 esp_sr_16 requires exactly one model Pack request and provenance');
    }
  }
  return Object.freeze({ requested, boardArtifacts });
}

function isExactEspSr16ModelBinding(binding) {
  return binding?.path === ESP32_ESP_SR_MODEL.path
    && binding.role === ESP32_ESP_SR_MODEL.role
    && binding.packSchema === 2
    && binding.artifactId === ESP32_ESP_SR_MODEL.artifactId
    && binding.sha256 === ESP32_ESP_SR_MODEL.sha256;
}

function normalizeBoardArtifactBinding(value, boardPack, input) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.kind !== 'pack-artifact'
    || value.packId !== boardPack.id || value.packRevision !== boardPack.sha256
    || !Number.isSafeInteger(value.packSchema) || value.packSchema < 1
    || typeof value.artifactId !== 'string' || !STABLE_PACK_ID.test(value.artifactId)
    || !SHA256.test(value.sha256) || value.sha256 !== input.sha256
    || value.role !== input.role) {
    throw new TypeError(`ESP32 post-link Board Pack identity is invalid: ${input.path}`);
  }
  return Object.freeze({
    path: input.path,
    role: value.role,
    packId: value.packId,
    packRevision: value.packRevision,
    packSchema: value.packSchema,
    artifactId: value.artifactId,
    sha256: value.sha256,
  });
}

function sameBoardArtifactBinding(left, right) {
  return left.path === right.path && left.role === right.role
    && left.packId === right.packId && left.packRevision === right.packRevision
    && left.packSchema === right.packSchema && left.artifactId === right.artifactId
    && left.sha256 === right.sha256;
}

function bindBuildPacksToRuntime(packs, descriptor, planning) {
  const identity = buildPackIdentity(packs);
  if (!Array.isArray(descriptor?.packs)) {
    throw new TypeError('ESP32 runtime descriptor Pack list is invalid');
  }
  const byRole = new Map();
  for (const pack of descriptor.packs) {
    if (!pack || typeof pack !== 'object' || typeof pack.role !== 'string') {
      throw new TypeError('ESP32 runtime descriptor Pack identity is invalid');
    }
    if (byRole.has(pack.role)) throw new TypeError(`ESP32 runtime descriptor Pack role is duplicated: ${pack.role}`);
    byRole.set(pack.role, pack);
  }
  assertDescriptorPack(identity.toolchain, byRole.get('compiler'), 'Toolchain');
  assertPlatformManifestPack(identity.platform, planning?.platformManifest?.platformManifest);
  assertDescriptorManifest(byRole.get('sdk'), planning?.sdkManifest, 'SDK');
  const board = byRole.get('board');
  if (board) {
    assertDescriptorPack(identity.board, board, 'Board');
  } else {
    throw new TypeError('ESP32 runtime descriptor Board Pack is missing');
  }
  if (typeof descriptor.board === 'string' && descriptor.board !== identity.board.fqbn) {
    throw new TypeError('ESP32 Build IR Board Pack does not match the runtime target');
  }
  return identity;
}

function assertPlatformManifestPack(actual, manifest) {
  if (!manifest || actual.id !== manifest.id || actual.sha256 !== manifest.sha256
    || actual.version !== manifest.version) {
    throw new TypeError('ESP32 Build IR Platform Pack does not match the Platform Manifest');
  }
}

function assertDescriptorManifest(descriptorPack, manifest, label) {
  if (!descriptorPack || !manifest || descriptorPack.id !== manifest.id
    || descriptorPack.revision !== manifest.revision) {
    throw new TypeError(`ESP32 ${label} Pack Manifest does not match the runtime descriptor`);
  }
}

function assertDescriptorPack(actual, expected, label) {
  if (!expected || actual.id !== expected.id || actual.sha256 !== expected.revision) {
    throw new TypeError(`ESP32 Build IR ${label} Pack does not match the runtime descriptor`);
  }
}

function assertSameBuildPackIdentity(expected, packs) {
  const actual = buildPackIdentity(packs);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError('ESP32 executor BuildPacks do not match the Pack provider Build IR');
  }
}

function buildPackIdentity(packs) {
  if (!packs || typeof packs !== 'object' || Array.isArray(packs)) {
    throw new TypeError('ESP32 executor BuildPacks are invalid');
  }
  const toolchain = packIdentity(packs.toolchain, 'toolchain');
  const platform = packIdentity(packs.platform, 'platform');
  const board = packIdentity(packs.board, 'board');
  if (typeof packs.toolchain.abi !== 'string' || typeof packs.toolchain.instructionSet !== 'string') {
    throw new TypeError('ESP32 Toolchain Pack target identity is invalid');
  }
  if (typeof packs.platform.platform !== 'string') {
    throw new TypeError('ESP32 Platform Pack target identity is invalid');
  }
  if (typeof packs.board.fqbn !== 'string' || typeof packs.board.variant !== 'string') {
    throw new TypeError('ESP32 Board Pack target identity is invalid');
  }
  const librarySet = packs.libraries;
  if (!librarySet || !Array.isArray(librarySet.roots) || !Array.isArray(librarySet.packs)) {
    throw new TypeError('ESP32 Library Pack set is invalid');
  }
  const libraries = librarySet.packs.map((pack) => packIdentity(pack, 'library'))
    .sort((left, right) => compareText(left.id, right.id));
  const libraryIds = new Set(libraries.map((pack) => pack.id));
  if (libraryIds.size !== libraries.length
    || librarySet.roots.some((id) => typeof id !== 'string' || !libraryIds.has(id))) {
    throw new TypeError('ESP32 Library Pack identities are invalid');
  }
  return Object.freeze({
    toolchain: Object.freeze({
      ...toolchain,
      abi: packs.toolchain.abi,
      instructionSet: packs.toolchain.instructionSet,
    }),
    platform: Object.freeze({ ...platform, platform: packs.platform.platform }),
    board: Object.freeze({ ...board, fqbn: packs.board.fqbn, variant: packs.board.variant }),
    libraries: Object.freeze({
      roots: Object.freeze([...new Set(librarySet.roots)].sort(compareText)),
      packs: Object.freeze(libraries),
    }),
  });
}

function packIdentity(pack, kind) {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)
    || pack.kind !== kind
    || typeof pack.id !== 'string' || !pack.id
    || typeof pack.version !== 'string' || !pack.version
    || typeof pack.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pack.sha256)) {
    throw new TypeError(`ESP32 ${kind} Pack identity is invalid`);
  }
  return Object.freeze({ kind, id: pack.id, version: pack.version, sha256: pack.sha256 });
}

async function materializeLibrarySources(sources, requested, context) {
  for (const source of sources ?? []) {
    const root = `packs/libraries/${source.packId}`;
    for (const file of source.files ?? []) {
      const path = `${root}/${file.path}`;
      if (!requested.has(path) || context.hasFile(path)) continue;
      await context.writeFile(path, new TextEncoder().encode(file.content), requested.get(path));
    }
  }
}

async function materializePlatformFiles(
  descriptor,
  descriptorUrl,
  profile,
  requested,
  context,
  packLoaderFactory,
  expectedVersion,
) {
  const paths = [...requested.keys()].filter((path) => path.startsWith('packs/platform/'));
  if (!paths.length) return;
  const loader = runtimePackLoader(descriptor, descriptorUrl, 'sdk', packLoaderFactory, expectedVersion);
  try {
    for (const artifactIds of [profile.compile.artifactIds, profile.link.artifactIds]) {
      const tree = await materializeEsp32PackArtifactTrees(artifactIds, loader, 'ESP32 browser Pack provider');
      for (const path of paths) {
        if (context.hasFile(path)) continue;
        const value = treeFile(tree, packPathToVfs(path));
        const bytes = fileBytes(value);
        if (bytes) await context.writeFile(path, bytes, requested.get(path));
      }
    }
  } finally {
    loader.reset?.();
  }
}

async function materializeBoardFiles(
  descriptor,
  descriptorUrl,
  planning,
  requested,
  context,
  packLoaderFactory,
  expectedPack,
  boardArtifacts,
) {
  const profile = planning.platformManifest;
  const variantPaths = [...requested.keys()].filter((path) => path.startsWith('packs/board/variant/'));
  const needed = [...boardArtifacts.values()];
  const collision = needed.find(({ path }) => context.hasFile(path));
  if (collision) {
    throw new TypeError(`ESP32 post-link Board Pack path collides with an existing file: ${collision.path}`);
  }
  if (!needed.length && !variantPaths.length) return;
  const loader = runtimePackLoader(descriptor, descriptorUrl, 'board', packLoaderFactory, expectedPack.version);
  try {
    if (variantPaths.length) {
      const tree = await materializeEsp32PackArtifactTrees(
        profile.boardPack?.artifactIds ?? [],
        loader,
        'ESP32 browser Board Pack provider',
      );
      await writeRequestedTreeFiles(tree, variantPaths, requested, context);
    }
    if (needed.length) {
      const manifest = await loader.loadManifest();
      for (const binding of needed) {
        const artifact = resolveBoardArtifact(manifest, expectedPack, binding);
        const loaded = await loader.loadArtifact(binding.artifactId);
        const bytes = await verifyLoadedBoardArtifact(loaded, artifact, binding);
        await context.writeFile(binding.path, bytes, binding.sha256);
      }
    }
  } finally {
    loader.reset?.();
  }
}

function resolveBoardArtifact(manifest, expectedPack, binding) {
  const espSr16Model = binding.path === ESP32_ESP_SR_MODEL.path;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.schema !== binding.packSchema
    || manifest.id !== expectedPack.id || manifest.revision !== expectedPack.sha256
    || manifest.version !== expectedPack.version || !Array.isArray(manifest.artifacts)) {
    throw new TypeError(`ESP32 post-link Board Pack Manifest identity is invalid: ${binding.path}`);
  }
  const matches = manifest.artifacts.filter((artifact) => artifact?.id === binding.artifactId);
  const artifact = matches[0];
  if (matches.length !== 1 || !artifact || artifact.kind !== 'bin'
    || !Number.isSafeInteger(artifact.size) || artifact.size < 1
    || artifact.sha256 !== binding.sha256
    || (espSr16Model && (!isExactEspSr16ModelBinding(binding)
      || artifact.size !== ESP32_ESP_SR_MODEL.size
      || artifact.size > ESP32_ESP_SR_MODEL.capacity
      || artifact.sha256 !== ESP32_ESP_SR_MODEL.sha256))) {
    throw new TypeError(`ESP32 post-link Board Pack artifact binding is invalid: ${binding.path}`);
  }
  return artifact;
}

async function verifyLoadedBoardArtifact(loaded, artifact, binding) {
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)
    || !loaded.artifact || typeof loaded.artifact !== 'object' || Array.isArray(loaded.artifact)
    || !(loaded.bytes instanceof Uint8Array)
    || loaded.artifact.id !== artifact.id || loaded.artifact.kind !== artifact.kind
    || loaded.artifact.size !== artifact.size || loaded.artifact.sha256 !== artifact.sha256
    || loaded.bytes.byteLength !== artifact.size
    || await sha256Hex(loaded.bytes) !== binding.sha256) {
    throw new TypeError(`ESP32 post-link Board Pack artifact bytes are invalid: ${binding.path}`);
  }
  return new Uint8Array(loaded.bytes);
}

async function sha256Hex(bytes) {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new TypeError('ESP32 browser Pack provider SHA-256 is unavailable');
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function writeRequestedTreeFiles(tree, paths, requested, context) {
  for (const path of paths) {
    if (context.hasFile(path)) continue;
    const bytes = fileBytes(treeFile(tree, packPathToVfs(path)));
    if (bytes) await context.writeFile(path, bytes, requested.get(path));
  }
}

function runtimePackLoader(
  descriptor,
  descriptorUrl,
  role,
  packLoaderFactory = createBrowserToolchainPackLoader,
  expectedVersion,
) {
  const pack = descriptor.packs.find((candidate) => candidate.role === role);
  if (!pack) throw new Error(`ESP32 runtime Pack is missing: ${role}`);
  const manifestUrl = resolveEsp32RuntimePackManifestUrl(pack, descriptorUrl);
  const loader = packLoaderFactory({
    manifestUrl,
    expectedId: pack.id,
    expectedRevision: pack.revision,
    limits: ESP32_C3_RUNTIME_PACK_LIMITS[role],
  });
  if (typeof expectedVersion !== 'string' || !expectedVersion) return loader;
  if (typeof loader?.loadManifest !== 'function') {
    throw new TypeError(`ESP32 ${role} Pack loader cannot verify its version`);
  }
  const loadManifest = loader.loadManifest.bind(loader);
  const loadArtifact = typeof loader.loadArtifact === 'function'
    ? loader.loadArtifact.bind(loader)
    : undefined;
  let verifiedManifest;
  const verifyManifest = async () => {
    if (!verifiedManifest) {
      const manifest = await loadManifest();
      if (!manifest || manifest.version !== expectedVersion) {
        throw new TypeError(`ESP32 ${role} Pack manifest version does not match Build IR`);
      }
      verifiedManifest = manifest;
    }
    return verifiedManifest;
  };
  return {
    ...loader,
    async loadManifest() {
      return verifyManifest();
    },
    ...(loadArtifact === undefined ? {} : {
      async loadArtifact(id) {
        await verifyManifest();
        return loadArtifact(id);
      },
    }),
    reset() {
      verifiedManifest = undefined;
      loader.reset?.();
    },
  };
}

function packPathToVfs(path) {
  if (path === 'packs/platform/core.a') return 'core.a';
  if (path.startsWith('packs/platform/')) return path.slice('packs/platform/'.length);
  if (path.startsWith('packs/toolchain/')) return path.slice('packs/toolchain/'.length);
  if (path.startsWith('packs/board/')) return path.slice('packs/board/'.length);
  return path;
}

function treeFile(tree, path) {
  let value = tree;
  for (const segment of path.split('/')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function fileBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return null;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
