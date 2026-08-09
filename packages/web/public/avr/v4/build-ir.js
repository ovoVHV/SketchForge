import { planBuildIR } from '../../ck-rust-build-core.js';
import { createBrowserToolchainPackLoader } from './toolchain-pack.js';
import { openAssetPack, validateAssetPackDescriptor } from './asset-pack.js';
import {
  AVR_BOARD_PACK,
  AVR_PLATFORM_PACK,
  AVR_TOOLCHAIN_PACK,
} from './release.js';

const BOARD = 'arduino:avr:uno';
const SHA256 = /^[a-f0-9]{64}$/;
const PACK_ROLES = Object.freeze(['toolchain', 'platform', 'board']);
const RELEASE_PACKS = Object.freeze({
  toolchain: AVR_TOOLCHAIN_PACK,
  platform: AVR_PLATFORM_PACK,
  board: AVR_BOARD_PACK,
});
const LOGICAL_PACK_PREFIXES = Object.freeze({
  toolchain: 'packs/toolchain/',
  platform: 'packs/platform/',
  board: 'packs/board/',
});

/** Resolve and verify the three independently published AVR Packs. */
export async function loadAvrBrowserBuildPlanning({
  manifest,
  assetsBase,
  createPackLoader = createBrowserToolchainPackLoader,
} = {}) {
  validateRuntimeManifest(manifest);
  if (typeof createPackLoader !== 'function') throw new TypeError('AVR Pack loader factory is required');
  const base = new URL(String(assetsBase));
  const loaders = {};
  for (const role of PACK_ROLES) {
    const descriptor = manifest.packs[role];
    loaders[role] = createPackLoader({
      manifestUrl: new URL(descriptor.manifest, base),
      expectedId: RELEASE_PACKS[role].id,
      expectedRevision: RELEASE_PACKS[role].revision,
    });
  }

  try {
    const packManifests = {};
    const assetArtifacts = {};
    await Promise.all(PACK_ROLES.map(async (role) => {
      const descriptor = manifest.packs[role];
      const packManifest = await loaders[role].loadManifest();
      const artifact = packManifest.artifacts.find((candidate) => candidate.id === descriptor.artifactId);
      validatePublishedPack(role, descriptor, packManifest, artifact);
      packManifests[role] = packManifest;
      assetArtifacts[role] = artifact;
    }));
    return Object.freeze({
      manifest,
      assetsBase: base.href,
      packManifests: Object.freeze(packManifests),
      assetArtifacts: Object.freeze(assetArtifacts),
      loaders: Object.freeze(loaders),
      reset() { for (const loader of Object.values(loaders)) loader.reset?.(); },
    });
  } catch (error) {
    for (const loader of Object.values(loaders)) loader.reset?.();
    throw error;
  }
}

/** Build a complete Uno CK Build IR with physical Toolchain, Platform, and Board identities. */
export async function createAvrBrowserBuildIR(request, planning) {
  const manifest = planning?.manifest;
  validateRuntimeManifest(manifest);
  for (const role of PACK_ROLES) {
    const packManifest = planning?.packManifests?.[role];
    const artifact = planning?.assetArtifacts?.[role];
    if (!packManifest
      || packManifest.id !== RELEASE_PACKS[role].id
      || packManifest.version !== RELEASE_PACKS[role].version
      || packManifest.revision !== RELEASE_PACKS[role].revision
      || !artifact
      || !SHA256.test(artifact.sha256)) {
      throw new TypeError(`AVR browser ${role} Pack planning is incomplete`);
    }
  }
  if (request?.board !== BOARD || !Array.isArray(request.files) || request.files.length < 1
    || request.files.some((file) => (
      !file || typeof file.name !== 'string' || file.name.includes('/')
      || !/^[A-Za-z0-9_-]{1,64}\.ino$/.test(file.name)
      || typeof file.content !== 'string'
    ))) {
    throw new TypeError('AVR browser request is invalid');
  }

  const toolchain = planning.packManifests.toolchain;
  const platform = planning.packManifests.platform;
  const boardManifest = planning.packManifests.board;
  const boardPack = {
    kind: 'board',
    id: boardManifest.id,
    version: boardManifest.version,
    sha256: boardManifest.revision,
    fqbn: BOARD,
    variant: 'standard',
  };
  const packs = {
    toolchain: {
      kind: 'toolchain',
      id: toolchain.id,
      version: toolchain.version,
      sha256: toolchain.revision,
      abi: 'avr-gcc-wasm-v1',
      instructionSet: 'avr5',
    },
    platform: {
      kind: 'platform',
      id: platform.id,
      version: platform.version,
      sha256: platform.revision,
      platform: 'arduino-avr',
    },
    board: boardPack,
    libraries: { roots: [], packs: [] },
  };
  const packInputs = Object.fromEntries(PACK_ROLES.map((role) => {
    const packManifest = planning.packManifests[role];
    const artifact = planning.assetArtifacts[role];
    return [role, {
      kind: 'pack-artifact',
      packId: packManifest.id,
      packRevision: packManifest.revision,
      packSchema: packManifest.schema,
      artifactId: artifact.id,
      sha256: artifact.sha256,
      role: `avr-${role}-assets`,
    }];
  }));
  const headerInputs = manifest.headerFiles.map((path) => ({
    path: logicalAssetPath(path),
    role: 'compiler-header',
  }));
  const objectInputs = manifest.objectFiles.map((path) => ({
    path: logicalAssetPath(path),
    role: 'platform-object',
  }));
  const libraryInputs = manifest.libs.map((path) => ({
    path: logicalAssetPath(path),
    role: path.endsWith('.a') ? 'static-library' : 'runtime-object',
  }));
  const linkerScript = logicalAssetPath('/ldscripts/avr5.xn');
  const crt = manifest.libs.find((path) => path.endsWith('/crtatmega328p.o'));
  if (!crt) throw new TypeError('AVR browser runtime is missing its startup object');
  const coreObjects = manifest.objectFiles.map(logicalAssetPath);
  const toolPrefix = `toolchain:${toolchain.id}`;

  return planBuildIR({
    project: request.files.map((file) => ({ path: file.name, content: file.content })),
    target: { fqbn: BOARD, options: request.options ?? {}, boardPack },
    packs,
    tools: {
      preprocess: 'ck:arduino-preprocess',
      c: `${toolPrefix}:avr-gcc`,
      cxx: `${toolPrefix}:avr-g++`,
      asm: `${toolPrefix}:avr-gcc`,
      ar: `${toolPrefix}:avr-ar`,
      ld: `${toolPrefix}:avr-ld`,
      objcopy: `${toolPrefix}:avr-objcopy`,
    },
    macros: {
      __AVR_ATmega328P__: true,
      __AVR_DEVICE_NAME__: 'atmega328p',
      F_CPU: '16000000L',
      ARDUINO: '10819',
      ARDUINO_AVR_UNO: true,
      ARDUINO_ARCH_AVR: true,
    },
    includePaths: [
      'packs/toolchain/sysroot/gcc/include',
      'packs/toolchain/sysroot/avr/include',
      'packs/platform/core',
      'packs/board/variant',
    ],
    flags: {
      common: [
        '-mmcu=atmega328p',
        '-mn-flash=1',
        '-mno-skip-bug',
        '-Os',
        '-ffunction-sections',
        '-fdata-sections',
      ],
      c: ['-std=gnu11'],
      cxx: [
        '-std=gnu++11',
        '-fpermissive',
        '-fno-exceptions',
        '-fno-threadsafe-statics',
        '-fno-rtti',
        '-fno-enforce-eh-specs',
      ],
    },
    compilerInputs: headerInputs,
    compilerPackInputs: [packInputs.toolchain, packInputs.platform, packInputs.board],
    platform: {
      linkerScript,
      linkerFlags: [
        '-m', 'avr5',
        '-Tdata=0x800100',
        '--gc-sections',
        logicalAssetPath(crt),
      ],
      linkerInputs: [...objectInputs, ...libraryInputs],
      linkerTailFlags: [
        ...coreObjects,
        '-Lpacks/toolchain/libs',
        '-lm',
        '-lc',
        '-lgcc',
      ],
    },
    linkerPackInputs: [packInputs.toolchain, packInputs.platform],
    transforms: [{
      format: 'hex',
      output: 'build/firmware.hex',
      tool: `${toolPrefix}:avr-objcopy`,
      arguments: [
        '-O', 'ihex', '-R', '.eeprom',
        'build/firmware.elf', 'build/firmware.hex',
      ],
    }],
    resourceLimits: {
      compile: { cpuMs: 30_000, memoryBytes: 256 * 1024 * 1024, outputBytes: 2 * 1024 * 1024 },
      link: { cpuMs: 30_000, memoryBytes: 256 * 1024 * 1024, outputBytes: 4 * 1024 * 1024 },
      transform: { cpuMs: 15_000, memoryBytes: 128 * 1024 * 1024, outputBytes: 2 * 1024 * 1024 },
    },
  });
}

/** Materialize immutable files from their owning physical Pack. */
export function createAvrBrowserPackProvider({ planning, ir } = {}) {
  if (!planning?.loaders || !planning?.manifest?.packs || !ir?.graph?.actions) {
    throw new TypeError('AVR browser Pack provider inputs are incomplete');
  }
  const requestedByRole = Object.fromEntries(PACK_ROLES.map((role) => [role, new Set()]));
  for (const input of ir.graph.actions.flatMap((action) => action.inputs ?? [])) {
    if (typeof input.path !== 'string') continue;
    const role = PACK_ROLES.find((candidate) => input.path.startsWith(LOGICAL_PACK_PREFIXES[candidate]));
    if (role) requestedByRole[role].add(input.path);
  }

  return Object.freeze({
    async materialize(_packs, context) {
      for (const role of PACK_ROLES) {
        const requested = [...requestedByRole[role]].sort();
        if (!requested.length) continue;
        const descriptor = planning.manifest.packs[role];
        const { artifact, bytes } = await planning.loaders[role].loadArtifact(descriptor.artifactId);
        if (artifact.size !== descriptor.assetPack.size || artifact.sha256 !== descriptor.assetPack.sha256) {
          throw new Error(`AVR ${role} Pack identity changed after planning`);
        }
        const pack = openAssetPack(descriptor.assetPack, bytes);
        for (const path of requested) await context.writeFile(path, pack.read(packedAssetPath(path)));
      }
    },
  });
}

export function logicalAssetPath(value) {
  const path = String(value);
  if (path.startsWith('/sysroot/')) return `packs/toolchain${path}`;
  if (path.startsWith('/arduino/core/')) return `packs/platform/core/${path.slice('/arduino/core/'.length)}`;
  if (path.startsWith('/arduino/variant/')) return `packs/board/variant/${path.slice('/arduino/variant/'.length)}`;
  if (path.startsWith('/objects/')) return `packs/platform/objects/${path.slice('/objects/'.length)}`;
  if (path.startsWith('/libs/')) return `packs/toolchain/libs/${path.slice('/libs/'.length)}`;
  if (path.startsWith('/ldscripts/')) return `packs/toolchain/ldscripts/${path.slice('/ldscripts/'.length)}`;
  throw new TypeError(`unsupported AVR asset path: ${path}`);
}

export function packedAssetPath(value) {
  const path = String(value);
  if (path.startsWith('packs/toolchain/sysroot/')) return `fs/${path.slice('packs/toolchain/'.length)}`;
  if (path.startsWith('packs/platform/core/')) return `fs/arduino/core/${path.slice('packs/platform/core/'.length)}`;
  if (path.startsWith('packs/board/variant/')) return `fs/arduino/variant/${path.slice('packs/board/variant/'.length)}`;
  if (path.startsWith('packs/platform/objects/')) return `objects/${path.slice('packs/platform/objects/'.length)}`;
  if (path.startsWith('packs/toolchain/libs/')) return `libs/${path.slice('packs/toolchain/libs/'.length)}`;
  if (path.startsWith('packs/toolchain/ldscripts/')) return `ldscripts/${path.slice('packs/toolchain/ldscripts/'.length)}`;
  throw new TypeError(`unsupported AVR logical Pack path: ${path}`);
}

function validateRuntimeManifest(value) {
  if (!value
    || value.schema !== 3
    || value.board !== BOARD
    || value.target !== 'atmega328p'
    || !Array.isArray(value.headerFiles)
    || !Array.isArray(value.objectFiles)
    || !Array.isArray(value.libs)
    || !Array.isArray(value.browserHeaders)
    || !value.packs
    || typeof value.packs !== 'object') {
    throw new TypeError('AVR browser runtime Manifest is invalid');
  }
  for (const role of PACK_ROLES) validateRuntimePackDescriptor(value.packs[role], role);
}

function validateRuntimePackDescriptor(value, role) {
  const release = RELEASE_PACKS[role];
  if (!value
    || value.kind !== role
    || value.id !== release.id
    || value.version !== release.version
    || value.revision !== release.revision
    || typeof value.manifest !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(value.manifest)
    || typeof value.artifactId !== 'string'
    || !value.artifactId) {
    throw new TypeError(`AVR browser ${role} Pack descriptor is invalid`);
  }
  validateAssetPackDescriptor(value.assetPack);
}

function validatePublishedPack(role, descriptor, packManifest, artifact) {
  const release = RELEASE_PACKS[role];
  if (packManifest.id !== release.id
    || packManifest.version !== release.version
    || packManifest.revision !== release.revision
    || !artifact
    || artifact.kind !== 'asset-pack'
    || artifact.size !== descriptor.assetPack.size
    || artifact.sha256 !== descriptor.assetPack.sha256
    || artifact.chunks.length !== 1
    || artifact.chunks[0].path !== `assets/${descriptor.assetPack.file}`) {
    throw new Error(`AVR ${role} assets do not match their Pack Manifest`);
  }
}
