import { resolveLocalLibraries } from './ck-project-resolver.js';
import { planBuildIR, resolvePlatformManifest } from './ck-rust-build-core.js';
import {
  projectSnapshotSha256,
  resolveCustomEsp32Partitions,
} from './ck-esp32-partitions.js';
import {
  browserToolchainPackRevisionInput,
} from './avr/v3/toolchain-pack.js';
import {
  CK_BROWSER_PLATFORM_PATH_LAYOUT,
  deriveEsp32PostLinkContract,
  derivePlatformArchiveCommand,
  lowerEsp32PostLinkTransforms,
  lowerPlatformBuildCommands,
  resolvePlatformLogicalPath,
} from './ck-platform-planning.js';

const SHA256 = /^[a-f0-9]{64}$/;
const CUSTOM_PARTITIONS_BY_BUILD_IR = new WeakMap();
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
const ESP32_BASE_POST_LINK_PRODUCTS = Object.freeze([
  'application', 'bootloader', 'partitions', 'boot-app0', 'merged',
]);
const ESP32_ESP_SR_POST_LINK_PRODUCTS = Object.freeze([
  'application', 'bootloader', 'partitions', 'boot-app0', 'model', 'merged',
]);
const ESP32_BASE_MERGE_PRODUCTS = Object.freeze([
  'bootloader', 'partitions', 'boot-app0', 'application',
]);

export function customEsp32PartitionsForBuildIR(ir) {
  if (!ir || typeof ir !== 'object') return null;
  const customPartitions = CUSTOM_PARTITIONS_BY_BUILD_IR.get(ir);
  const declaresCustomPartitions = ir?.project?.files?.some?.((file) => file?.path === 'partitions.csv')
    || ir?.graph?.actions?.some?.((action) => (
      action?.kind === 'transform'
      && action?.transform?.format === 'partition'
      && action?.inputs?.some?.((input) => input?.path === 'partitions.csv')
    ));
  if (declaresCustomPartitions && !customPartitions) {
    throw new Error('custom ESP32 partition application slot evidence is unavailable');
  }
  return customPartitions ?? null;
}

export function browserBoardPackRevisionInput(manifest) {
  return browserToolchainPackRevisionInput(manifest);
}

const ESP32_POST_LINK_PROFILE_BINDINGS = Object.freeze([
  Object.freeze({
    label: 'build.partitions',
    allowEspSr16: true,
    properties: Object.freeze(['build.partitions', 'build.custom_partitions']),
    recipes: Object.freeze([
      'recipe.hooks.prebuild.1',
      'recipe.hooks.prebuild.2',
      'recipe.hooks.prebuild.3',
      'recipe.objcopy.partitions.bin',
    ]),
  }),
  Object.freeze({
    label: 'build.flash_mode/build.img_freq/build.flash_size',
    properties: Object.freeze(['build.flash_mode', 'build.img_freq', 'build.flash_size']),
    recipes: Object.freeze(['recipe.objcopy.bin']),
  }),
  Object.freeze({
    label: 'bootloader selection',
    properties: Object.freeze([
      'build.boot',
      'build.boot_freq',
      'build.bootloader_addr',
      'build.custom_bootloader',
      'build.mcu',
    ]),
    recipes: Object.freeze(['recipe.hooks.prebuild.4']),
  }),
  Object.freeze({
    label: 'merged image layout',
    allowEspSr16: true,
    properties: Object.freeze([]),
    recipes: Object.freeze(['recipe.hooks.objcopy.postobjcopy.3']),
  }),
]);

/** Build a complete browser-compatible CK Build IR from a verified Platform Manifest. */
export async function createEsp32BrowserBuildIR(request, capability, planning = {}) {
  const profile = capability?.profile;
  const runtime = capability?.pinnedRuntime?.descriptor;
  const platformManifest = planning.platformManifest;
  if (!profile || !runtime || !Array.isArray(runtime.packs)) {
    throw new TypeError('ESP32 browser runtime is not resolved');
  }
  if (!platformManifest || platformManifest.board !== profile.board) {
    throw new TypeError('ESP32 browser Platform Manifest is not resolved');
  }
  const resolvedProfilePlatform = await resolvePlatformManifest({
    manifest: platformManifest.platformManifest,
    fqbn: profile.board,
    options: platformManifest.options,
  });
  const requestedTargetOptions = { ...platformManifest.options, ...(request.options ?? {}) };
  const resolvedStandardPlatform = await resolvePlatformManifest({
    manifest: platformManifest.platformManifest,
    fqbn: profile.board,
    options: requestedTargetOptions,
  });
  if (resolvedStandardPlatform.version !== platformManifest.sdkVersion
    || (platformManifest.variant && resolvedStandardPlatform.board.variant !== platformManifest.variant)) {
    throw new TypeError('ESP32 browser Platform Manifest profile identity mismatch');
  }
  const espSr16 = resolveBrowserEspSr16Selection(resolvedStandardPlatform, platformManifest.flash);
  assertBrowserPostLinkProfileBindings(resolvedProfilePlatform, resolvedStandardPlatform, espSr16);
  const packs = runtime.packs;
  const compiler = packs.find((pack) => pack.role === 'compiler');
  const sdk = packs.find((pack) => pack.role === 'sdk');
  const board = packs.find((pack) => pack.role === 'board');
  if (!compiler || !sdk || !board
    || !SHA256.test(compiler.revision) || !SHA256.test(sdk.revision) || !SHA256.test(board.revision)) {
    throw new TypeError('ESP32 browser descriptor has incomplete Pack revisions');
  }
  const boardVersion = manifestVersion(
    planning.boardManifest,
    board,
    'Board',
    planning.platformManifest?.platformManifest?.version ?? platformManifest.sdkVersion,
  );
  const targetOptions = resolvedStandardPlatform.options;
  const variant = resolvedStandardPlatform.board.variant;
  const boardPack = {
    kind: 'board', id: board.id, version: boardVersion,
    sha256: board.revision,
    fqbn: profile.board, variant,
  };
  const externalLibraries = (capability.pinnedLibraries ?? []).map((library) => ({
    kind: 'library', id: library.packId, name: library.name, version: library.version,
    sha256: library.revision, architectures: [profile.architecture], manifest: {
      name: library.name, version: library.version,
    }, dependencies: (library.dependencies ?? []).map((dependency) => ({ ...dependency })),
  }));
  const projectFiles = request.files.map((file) => ({ path: file.name, content: file.content }));
  const localLibraries = resolveLocalLibraries(
    projectFiles,
    profile.board.split(':')[1] ?? 'esp32',
    externalLibraries,
  );
  const customPartitions = resolveCustomEsp32Partitions(request.files, {
    flashSizeBytes: parseEsp32FlashSizeBytes(resolvedStandardPlatform.properties['build.flash_size']),
  });
  const projectSha256 = projectSnapshotSha256(localLibraries.projectFiles);
  const libraries = [...externalLibraries, ...localLibraries.libraries.map((library) => library.pack)];
  const toolchain = {
    kind: 'toolchain', id: compiler.id,
    version: planning.compilerManifest?.version ?? compiler.revision,
    sha256: compiler.revision,
    abi: profile.runtime, instructionSet: profile.architecture,
  };
  const platform = {
    kind: 'platform', id: resolvedStandardPlatform.id, version: resolvedStandardPlatform.version,
    sha256: resolvedStandardPlatform.manifestSha256,
    platform: resolvedStandardPlatform.id,
  };
  const requestedNames = new Set((request.libraries ?? []).map((library) => String(library.name).toLowerCase()));
  const roots = [
    ...libraries.filter((library) => requestedNames.has(library.name.toLowerCase())).map((library) => library.id),
    ...localLibraries.libraries.map((library) => library.pack.id),
  ];
  const buildPacks = {
    toolchain,
    platform,
    board: boardPack,
    libraries: { roots: roots.length ? roots : libraries.map((library) => library.id), packs: libraries },
  };
  const recipeLowering = resolvedStandardPlatform.recipeLowering;
  const pathLayout = recipeLowering?.paths?.logicalToAction ?? CK_BROWSER_PLATFORM_PATH_LAYOUT;
  const archiveCommand = recipeLowering === undefined
    ? { operation: 'rcs', flags: [] }
    : derivePlatformArchiveCommand({
      recipes: platformManifest.platformManifest.recipes,
      recipeLowering,
      properties: {
        ...resolvedStandardPlatform.properties,
        'compiler.path': '',
        'compiler.prefix': '',
        'compiler.sdk.path': 'sdk',
        archive_file_path: '__ck_archive__',
        object_file: '__ck_object__',
      },
    });
  const profileLanguageFlags = platformManifest.compile.languageFlags ?? { c: [], cxx: [], asm: [] };
  const languageFlags = Object.fromEntries(['c', 'cxx', 'asm'].map((language) => [
    language,
    remapProfileResponseFlags(
      profileLanguageFlags[language],
      recipeLowering?.responseFiles?.marker ?? '@',
      pathLayout,
    ),
  ]));
  const commandPlan = lowerPlatformBuildCommands({
    compile: platformManifest.compile,
    link: platformManifest.link,
    pathLayout,
    ...(recipeLowering === undefined ? {} : { recipeLowering }),
    languageFlags: {
      c: languageFlags.c,
      // GCC accepts C++ list-initialization narrowing as a warning while
      // Clang defaults it to an error. Keep the same spelling in both
      // BrowserWasmExecutor and NativeExecutor plans.
      cxx: [...languageFlags.cxx, '-Wno-error=narrowing'],
      asm: [...languageFlags.asm, '-D__ASSEMBLY__'],
    },
  });
  const compilerTrees = resolvePackArtifactTrees(
    platformManifest.compile.artifactIds,
    sdk,
    planning.sdkManifest,
    'platform-compile-tree',
    platform,
    pathLayout,
  );
  const boardTrees = resolvePackArtifactTrees(
    platformManifest.boardPack?.artifactIds,
    board,
    planning.boardManifest,
    'board-variant-tree',
    board,
    pathLayout,
  );
  const boardCompilerInputs = boardTrees.files.map((file) => ({ ...file, role: 'board-variant-file' }));
  const compilerPackInputs = [...compilerTrees.packInputs, ...boardTrees.packInputs];
  const linkerTrees = resolvePackArtifactTrees(
    platformManifest.link.artifactIds,
    sdk,
    planning.sdkManifest,
    'platform-link-tree',
    platform,
    pathLayout,
  );
  const linkerPackInputs = linkerTrees.packInputs;
  const coreArchivePath = resolvePlatformLogicalPath('core.a', pathLayout);
  const coreArchive = linkerTrees.files.find((file) => file.path === coreArchivePath);
  if (!coreArchive) throw new TypeError('ESP32 browser Platform Pack core archive is not indexed');
  const postLinkBindings = resolveBrowserPostLinkBindings(
    planning.flashManifest,
    platformManifest.flash,
    board,
    customPartitions,
    projectSha256,
    espSr16,
  );
  const postLinkContractInput = {
    manifest: platformManifest.platformManifest,
    resolved: resolvedStandardPlatform,
    boardPack: { id: board.id, sha256: board.revision },
    boardPackRevisionInput: browserBoardPackRevisionInput(planning.flashManifest),
    bindings: postLinkBindings,
  };
  const postLinkContract = espSr16
    ? await deriveBrowserEspSr16PostLinkContract(postLinkContractInput)
    : deriveEsp32PostLinkContract(postLinkContractInput);
  const postLinkTools = {
    elf2image: 'ck:esp32-image',
    partitionBin: 'platform:gen-esp32part',
    materialize: 'ck:pack-copy',
    mergeBin: 'ck:esp32-merge',
  };
  const derivedPostLinkTransforms = espSr16
    ? lowerBrowserEspSr16PostLinkTransforms(postLinkContract, postLinkTools)
    : lowerEsp32PostLinkTransforms(postLinkContract, postLinkTools);
  const postLinkTransforms = customPartitions === null
    ? derivedPostLinkTransforms
    : derivedPostLinkTransforms.map((transform) => (
        transform.id === 'transform-partitions'
          ? { ...transform, outputSha256: customPartitions.tableSha256 }
          : transform
      ));
  const librarySources = normalizeLibrarySources(planning.librarySources, libraries, localLibraries.libraries);
  const toolPrefix = `toolchain:${compiler.id}`;

  const ir = await planBuildIR({
    project: localLibraries.projectFiles,
    projectCompilePaths: localLibraries.projectCompilePaths,
    target: { fqbn: profile.board, options: targetOptions, boardPack },
    packs: buildPacks,
    libraries: librarySources,
    tools: {
      preprocess: 'ck:arduino-preprocess',
      c: `${toolPrefix}:clang`,
      cxx: `${toolPrefix}:clang++`,
      asm: `${toolPrefix}:clang`,
      ar: `${toolPrefix}:llvm-ar`,
      ld: `${toolPrefix}:clang++`,
      objcopy: `${toolPrefix}:objcopy`,
    },
    macros: { ...commandPlan.macros, ...normalizeProjectMacros(request.macros) },
    includePaths: [...commandPlan.includePaths, ...projectIncludePaths(request.files)],
    flags: commandPlan.flags,
    compilerInputs: uniqueInputs([
      ...bindIndexedFileInputs(commandPlan.compilerInputs, compilerTrees.files, 'compile'),
      ...boardCompilerInputs,
    ]),
    compilerPackInputs,
    platform: {
      prebuiltArchives: [{
        path: coreArchive.path,
        sha256: coreArchive.sha256,
        role: 'static-library',
      }],
      linkerInputs: uniqueInputs([
        ...bindIndexedFileInputs(commandPlan.linkerInputs, linkerTrees.files, 'link'),
        ...linkerTrees.files
          .filter((file) => file.path.endsWith('.ld'))
          .map((file) => ({ ...file, role: 'linker-script' })),
      ]),
    },
    linkerFlags: commandPlan.linkerFlags,
    linkerPackInputs,
    linkerTailFlags: commandPlan.linkerTailFlags,
    archiveOperation: archiveCommand.operation,
    archiveFlags: archiveCommand.flags,
    transforms: postLinkTransforms,
    resourceLimits: {
      compile: { cpuMs: 120_000, memoryBytes: 640 * 1024 * 1024, outputBytes: 32 * 1024 * 1024 },
      archive: { cpuMs: 60_000, memoryBytes: 256 * 1024 * 1024, outputBytes: 32 * 1024 * 1024 },
      link: { cpuMs: 180_000, memoryBytes: 768 * 1024 * 1024, outputBytes: 32 * 1024 * 1024 },
      transform: { cpuMs: 60_000, memoryBytes: 256 * 1024 * 1024, outputBytes: 32 * 1024 * 1024 },
    },
  });
  if (customPartitions) CUSTOM_PARTITIONS_BY_BUILD_IR.set(ir, customPartitions);
  return ir;
}

async function deriveBrowserEspSr16PostLinkContract(input) {
  const bindings = input?.bindings;
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new TypeError('ESP32 esp_sr_16 post-link bindings are invalid');
  }
  const model = normalizeBrowserEspSr16ModelBinding(bindings.model, input.boardPack);
  return deriveEsp32PostLinkContract({
    ...input,
    bindings: {
      application: bindings.application,
      bootloader: bindings.bootloader,
      partitions: bindings.partitions,
      bootApp0: bindings.bootApp0,
      model,
    },
  });
}

function normalizeBrowserEspSr16ModelBinding(value, boardPack) {
  const provenance = value?.provenance;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.kind !== 'immutable'
    || value.path !== ESP32_ESP_SR_MODEL.path
    || value.role !== ESP32_ESP_SR_MODEL.role
    || value.size !== ESP32_ESP_SR_MODEL.size
    || value.sha256 !== ESP32_ESP_SR_MODEL.sha256
    || !provenance || typeof provenance !== 'object' || Array.isArray(provenance)
    || provenance.kind !== 'pack-artifact'
    || provenance.packId !== boardPack?.id
    || provenance.packSha256 !== boardPack?.sha256
    || provenance.packSchema !== 2
    || provenance.artifactId !== ESP32_ESP_SR_MODEL.artifactId) {
    throw new TypeError('ESP32 esp_sr_16 model binding is invalid');
  }
  return Object.freeze({
    kind: 'immutable',
    path: ESP32_ESP_SR_MODEL.path,
    role: ESP32_ESP_SR_MODEL.role,
    size: ESP32_ESP_SR_MODEL.size,
    sha256: ESP32_ESP_SR_MODEL.sha256,
    provenance: Object.freeze({
      kind: 'pack-artifact',
      packId: provenance.packId,
      packSha256: provenance.packSha256,
      packSchema: provenance.packSchema,
      artifactId: provenance.artifactId,
    }),
  });
}

function lowerBrowserEspSr16PostLinkTransforms(contract, tools) {
  assertBrowserEspSr16PostLinkContract(contract);
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
    throw new TypeError('ESP32 post-link tool bindings are invalid');
  }
  return contract.products.map((product) => (
    lowerBrowserEspSr16PostLinkProduct(product, tools, contract)
  ));
}

function lowerBrowserEspSr16PostLinkProduct(product, tools, contract) {
  const operation = product.operation;
  const packInputs = browserPostLinkOperationPackInputs(operation);
  const contractFlag = `--ck-post-link-contract=${contract.sha256}`;
  const base = {
    id: product.id,
    productId: product.productId,
    lifecycle: product.lifecycle,
    format: product.format,
    output: product.output,
    ...(product.lifecycle === 'configuration'
      ? { packDependencies: [contract.source.boardPackId] }
      : {}),
    ...(packInputs.length ? { packInputs } : {}),
    ...(product.offset === undefined ? {} : { offset: product.offset }),
  };
  if (operation.kind === 'esp32.elf2image') {
    const input = browserPostLinkActionInput(operation.input);
    const flags = [
      `--chip=${operation.chip}`,
      `--flash-mode=${operation.flashMode}`,
      `--flash-freq=${operation.flashFrequency}`,
      `--flash-size=${operation.flashSize}`,
      ...(operation.elfSha256Offset === undefined
        ? []
        : [`--elf-sha256-offset=${operation.elfSha256Offset}`]),
    ];
    return {
      ...base,
      input: operation.input.path,
      inputs: [input],
      flags: [...flags, contractFlag],
      tool: requiredBrowserPostLinkTool(tools.elf2image, operation.kind),
      arguments: [
        '--chip', operation.chip,
        'elf2image',
        '--flash-mode', operation.flashMode,
        '--flash-freq', operation.flashFrequency,
        '--flash-size', operation.flashSize,
        ...(operation.elfSha256Offset === undefined
          ? []
          : ['--elf-sha256-offset', operation.elfSha256Offset]),
        '-o', product.output,
        operation.input.path,
      ],
      dependencies: browserPostLinkActionDependencies([operation.input]),
    };
  }
  if (operation.kind === 'esp32.partition-bin') {
    return {
      ...base,
      input: operation.input.path,
      inputs: [browserPostLinkActionInput(operation.input)],
      flags: ['--quiet=true', contractFlag],
      tool: requiredBrowserPostLinkTool(tools.partitionBin, operation.kind),
      arguments: ['-q', operation.input.path, product.output],
      dependencies: [],
    };
  }
  if (operation.kind === 'materialize') {
    return {
      ...base,
      input: operation.input.path,
      inputs: [browserPostLinkActionInput(operation.input)],
      flags: [contractFlag],
      tool: requiredBrowserPostLinkTool(tools.materialize, operation.kind),
      arguments: [operation.input.path, '-o', product.output],
      dependencies: [],
    };
  }
  if (operation.kind !== 'esp32.merge-bin') {
    throw new TypeError(`ESP32 post-link operation is invalid: ${String(operation.kind)}`);
  }
  const inputs = operation.segments.map((segment) => browserPostLinkActionInput(segment.input));
  if (!inputs.length) throw new TypeError('ESP32 merge operation has no inputs');
  return {
    ...base,
    input: inputs[0].path,
    inputs,
    flags: [
      `--chip=${operation.chip}`,
      `--pad-to-size=${operation.padToSize}`,
      '--flash-mode=keep',
      '--flash-freq=keep',
      '--flash-size=keep',
      contractFlag,
    ],
    tool: requiredBrowserPostLinkTool(tools.mergeBin, operation.kind),
    arguments: [
      '--chip', operation.chip,
      'merge-bin',
      '-o', product.output,
      '--pad-to-size', operation.padToSize,
      '--flash-mode', operation.flashMode,
      '--flash-freq', operation.flashFrequency,
      '--flash-size', operation.flashSize,
      ...operation.segments.flatMap((segment) => [segment.offset, segment.input.path]),
    ],
    dependencies: browserPostLinkActionDependencies(
      operation.segments.map((segment) => segment.input),
    ),
  };
}

function assertBrowserEspSr16PostLinkContract(contract) {
  const productIds = contract?.products?.map((product) => product?.productId);
  const model = contract?.products?.[4];
  const modelInput = model?.operation?.input;
  const provenance = modelInput?.provenance;
  const merged = contract?.products?.[5];
  const segments = merged?.operation?.segments;
  const modelSegment = segments?.[4];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)
    || contract.kind !== 'ck-esp32-post-link-contract'
    || contract.schemaVersion !== 1
    || !SHA256.test(contract.sha256)
    || !sameStringSequence(productIds, ESP32_ESP_SR_POST_LINK_PRODUCTS)
    || model?.id !== 'transform-model'
    || model.lifecycle !== 'configuration'
    || model.format !== 'bin'
    || model.output !== ESP32_ESP_SR_MODEL.output
    || model.offset !== ESP32_ESP_SR_MODEL.offset
    || model?.operation?.kind !== 'materialize'
    || modelInput?.kind !== 'immutable'
    || modelInput.path !== ESP32_ESP_SR_MODEL.path
    || modelInput.role !== ESP32_ESP_SR_MODEL.role
    || modelInput.size !== ESP32_ESP_SR_MODEL.size
    || modelInput.sha256 !== ESP32_ESP_SR_MODEL.sha256
    || provenance?.kind !== 'pack-artifact'
    || provenance.packId !== contract.source?.boardPackId
    || provenance.packSha256 !== contract.source?.boardPackSha256
    || provenance.packSchema !== 2
    || provenance.artifactId !== ESP32_ESP_SR_MODEL.artifactId
    || merged?.operation?.kind !== 'esp32.merge-bin'
    || !Array.isArray(segments)
    || !sameStringSequence(
      segments.map((segment) => segment?.productId),
      [...ESP32_BASE_MERGE_PRODUCTS, 'model'],
    )
    || modelSegment?.offset !== ESP32_ESP_SR_MODEL.offset
    || modelSegment?.input?.kind !== 'action-output'
    || modelSegment.input.actionId !== 'transform-model'
    || modelSegment.input.path !== ESP32_ESP_SR_MODEL.output
    || modelSegment.input.role !== 'model-image'
    || parseEsp32FlashSizeBytes(contract.target?.flashSize) !== ESP32_ESP_SR_MODEL.flashBytes) {
    throw new TypeError('ESP32 esp_sr_16 post-link contract is invalid');
  }
}

function browserPostLinkOperationPackInputs(operation) {
  const inputs = operation?.kind === 'esp32.merge-bin'
    ? operation.segments.map((segment) => segment.input)
    : [operation?.input];
  return inputs.flatMap((input) => {
    if (input?.kind !== 'immutable' || input.provenance?.kind !== 'pack-artifact') return [];
    return [{
      kind: 'pack-artifact',
      packId: input.provenance.packId,
      packRevision: input.provenance.packSha256,
      packSchema: input.provenance.packSchema,
      artifactId: input.provenance.artifactId,
      sha256: input.sha256,
      role: input.role,
    }];
  });
}

function browserPostLinkActionInput(input) {
  return {
    path: input.path,
    role: input.role,
    ...(input.kind === 'immutable' ? { sha256: input.sha256 } : {}),
  };
}

function browserPostLinkActionDependencies(inputs) {
  return [...new Set(inputs
    .filter((input) => input.kind === 'action-output')
    .map((input) => input.actionId))].sort(compareStrings);
}

function requiredBrowserPostLinkTool(value, operation) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._:-]*$/.test(value)) {
    throw new TypeError(`ESP32 post-link tool is unavailable for ${operation}`);
  }
  return value;
}

function sameStringSequence(values, expected) {
  return Array.isArray(values)
    && values.length === expected.length
    && values.every((value, index) => value === expected[index]);
}

async function browserCanonicalSha256(value) {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    throw new TypeError('ESP32 browser post-link SHA-256 is unavailable');
  }
  const bytes = new TextEncoder().encode(browserCanonicalJson(value));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((item) => item.toString(16).padStart(2, '0')).join('');
}

function browserCanonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot contain a non-finite number');
    return JSON.stringify(value);
  }
  if (value === undefined) throw new TypeError('canonical JSON cannot contain undefined');
  if (typeof value !== 'object') {
    throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
  }
  if (Array.isArray(value)) return `[${value.map((item) => browserCanonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort(compareStrings);
  return `{${keys.map((key) => (
    `${JSON.stringify(key)}:${browserCanonicalJson(value[key])}`
  )).join(',')}}`;
}

function remapProfileResponseFlags(flags, marker, pathLayout) {
  return flags.map((flag) => (
    flag.startsWith(marker)
      ? `${marker}${resolvePlatformLogicalPath(flag.slice(marker.length), pathLayout)}`
      : flag
  ));
}

function normalizeProjectMacros(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('ESP32 browser project macros are invalid');
  }
  const entries = Object.entries(value);
  if (entries.length > 64) throw new TypeError('ESP32 browser project macro limit exceeded');
  const normalized = {};
  for (const [name, macroValue] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`ESP32 browser project macro name is invalid: ${name}`);
    }
    if (macroValue !== true && (typeof macroValue !== 'string' || macroValue.length > 256 || macroValue.includes('\0'))) {
      throw new TypeError(`ESP32 browser project macro value is invalid: ${name}`);
    }
    normalized[name] = macroValue;
  }
  return normalized;
}

function manifestVersion(manifest, descriptorPack, label, fallback) {
  if (manifest !== undefined && manifest !== null) {
    if (typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new TypeError(`ESP32 browser ${label} Pack manifest is invalid`);
    }
    if (manifest.id !== undefined && manifest.id !== descriptorPack.id) {
      throw new TypeError(`ESP32 browser ${label} Pack manifest id does not match the descriptor`);
    }
    if (manifest.revision !== undefined && manifest.revision !== descriptorPack.revision) {
      throw new TypeError(`ESP32 browser ${label} Pack manifest revision does not match the descriptor`);
    }
    if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
      throw new TypeError(`ESP32 browser ${label} Pack manifest version is invalid`);
    }
    return manifest.version;
  }
  if (typeof fallback !== 'string' || !fallback.trim()) {
    throw new TypeError(`ESP32 browser ${label} Pack version is unavailable`);
  }
  return fallback;
}

function parseEsp32FlashSizeBytes(value) {
  const match = typeof value === 'string' && /^(\d+)(B|KB|K|MB|M)$/i.exec(value.trim());
  if (!match) throw new TypeError(`ESP32 browser flash size is invalid: ${String(value)}`);
  const amount = BigInt(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = unit === 'B' ? 1n
    : unit === 'K' || unit === 'KB' ? 1024n
      : 1024n * 1024n;
  const bytes = amount * multiplier;
  if (bytes <= 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`ESP32 browser flash size is out of range: ${value}`);
  }
  return Number(bytes);
}

function assertBrowserPostLinkProfileBindings(profilePlatform, requestedPlatform, espSr16 = false) {
  const profileRecipes = new Map(profilePlatform.resolvedRecipes.map((recipe) => [recipe.id, recipe]));
  const requestedRecipes = new Map(requestedPlatform.resolvedRecipes.map((recipe) => [recipe.id, recipe]));
  for (const binding of ESP32_POST_LINK_PROFILE_BINDINGS) {
    const propertyChanged = binding.properties.some((property) => (
      profilePlatform.properties[property] !== requestedPlatform.properties[property]
    ));
    const recipeChanged = binding.recipes.some((recipeId) => (
      !sameResolvedRecipe(profileRecipes.get(recipeId), requestedRecipes.get(recipeId))
    ));
    if ((propertyChanged || recipeChanged) && !(espSr16 && binding.allowEspSr16 === true)) {
      throw new TypeError(
        `ESP32 browser post-link option override changes ${binding.label}; `
        + 'the current Board Pack has no artifact selector for that configuration',
      );
    }
  }
}

function resolveBrowserEspSr16Selection(resolvedPlatform, flashProfile) {
  const optionValues = [
    resolvedPlatform?.options?.partition_scheme,
    resolvedPlatform?.options?.PartitionScheme,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  const propertyValue = resolvedPlatform?.properties?.['build.partitions'];
  const flashValues = [
    flashProfile?.partition_scheme,
    flashProfile?.partitionScheme,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  const resolvedSelectsEspSr16 = optionValues.includes(ESP32_ESP_SR_MODEL.partitionScheme)
    || propertyValue === ESP32_ESP_SR_MODEL.partitionScheme;
  const flashSelectsEspSr16 = flashValues.includes(ESP32_ESP_SR_MODEL.partitionScheme);
  if (!resolvedSelectsEspSr16) {
    if (flashSelectsEspSr16) {
      throw new TypeError('ESP32 esp_sr_16 Flash profile does not match the resolved partition layout');
    }
    return false;
  }
  if ((optionValues.length > 0
      && optionValues.some((value) => value !== ESP32_ESP_SR_MODEL.partitionScheme))
    || propertyValue !== ESP32_ESP_SR_MODEL.partitionScheme
    || flashValues.some((value) => value !== ESP32_ESP_SR_MODEL.partitionScheme)) {
    throw new TypeError('ESP32 esp_sr_16 option does not match the resolved partition layout');
  }
  resolveEspSr16FlashModelProfile(flashProfile);
  const flashBytes = parseEsp32FlashSizeBytes(resolvedPlatform.properties['build.flash_size']);
  if (flashBytes !== ESP32_ESP_SR_MODEL.flashBytes) {
    throw new TypeError('ESP32 esp_sr_16 requires a 16MB flash layout');
  }
  return true;
}

function resolveEspSr16FlashModelProfile(flashProfile) {
  const model = flashProfile?.model;
  if (!model || typeof model !== 'object' || Array.isArray(model)
    || model.artifactId !== ESP32_ESP_SR_MODEL.artifactId
    || model.offset !== ESP32_ESP_SR_MODEL.offset
    || model.size !== ESP32_ESP_SR_MODEL.size
    || model.capacity !== ESP32_ESP_SR_MODEL.capacity
    || model.size > model.capacity
    || BigInt(model.offset) + BigInt(model.capacity) > BigInt(ESP32_ESP_SR_MODEL.flashBytes)) {
    throw new TypeError('ESP32 esp_sr_16 Flash model profile is invalid');
  }
  return model;
}

function sameResolvedRecipe(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.id === right.id
    && left.argv.length === right.argv.length
    && left.argv.every((argument, index) => argument === right.argv[index]);
}

function resolvePackArtifactTrees(
  artifactIds,
  pack,
  manifest,
  role,
  logicalPack = pack,
  pathLayout = CK_BROWSER_PLATFORM_PATH_LAYOUT,
) {
  if (!Array.isArray(artifactIds) || !artifactIds.length) {
    throw new TypeError(`ESP32 browser ${role} artifact ids are invalid`);
  }
  if (!manifest || manifest.schema !== 2
    || manifest.id !== pack.id || manifest.revision !== pack.revision
    || !Array.isArray(manifest.artifacts)) {
    throw new TypeError(`ESP32 browser ${role} Pack Manifest identity is invalid`);
  }
  const artifacts = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  const files = [];
  const packInputs = [];
  let previousId = '';
  const paths = new Set();
  for (const artifactId of artifactIds) {
    if (typeof artifactId !== 'string' || artifactId <= previousId) {
      throw new TypeError(`ESP32 browser ${role} artifact ids must be sorted and unique`);
    }
    const artifact = artifacts.get(artifactId);
    if (!artifact || artifact.kind !== 'tree' || !Number.isSafeInteger(artifact.size)
      || artifact.size <= 0 || !SHA256.test(artifact.sha256)
      || !Array.isArray(artifact.files) || !artifact.files.length) {
      throw new TypeError(`ESP32 browser ${role} Pack artifact is invalid: ${artifactId}`);
    }
    let expectedOffset = 0;
    let previousPath = '';
    for (const file of artifact.files) {
      if (typeof file?.path !== 'string' || file.path <= previousPath || paths.has(file.path)
        || !Number.isSafeInteger(file.offset) || file.offset !== expectedOffset
        || !Number.isSafeInteger(file.length) || file.length < 0
        || file.length > artifact.size - file.offset || !SHA256.test(file.sha256)) {
        throw new TypeError(`ESP32 browser ${role} Pack file index is invalid: ${artifactId}`);
      }
      const path = resolvePlatformLogicalPath(file.path, pathLayout);
      files.push({ path, sha256: file.sha256, role: `${role}-file` });
      paths.add(file.path);
      expectedOffset += file.length;
      previousPath = file.path;
    }
    if (expectedOffset !== artifact.size) {
      throw new TypeError(`ESP32 browser ${role} Pack file index size is invalid: ${artifactId}`);
    }
    packInputs.push({
      kind: 'pack-artifact',
      packId: logicalPack.id,
      packRevision: logicalPack.sha256 ?? logicalPack.revision,
      packSchema: logicalPack.kind === 'platform' ? 1 : manifest.schema,
      artifactId: artifact.id,
      sha256: artifact.sha256,
      role,
    });
    previousId = artifactId;
  }
  return Object.freeze({
    files: Object.freeze(uniqueInputs(files)),
    packInputs: Object.freeze(packInputs),
  });
}

function bindIndexedFileInputs(inputs, indexedFiles, phase) {
  const byPath = new Map(indexedFiles.map((file) => [file.path, file]));
  return inputs.map((input) => {
    const indexed = byPath.get(input.path);
    if (!indexed) throw new TypeError(`ESP32 browser ${phase} Pack input is not indexed: ${input.path}`);
    return { ...input, sha256: indexed.sha256 };
  });
}

function uniqueInputs(inputs) {
  const byPath = new Map();
  for (const input of inputs) if (!byPath.has(input.path)) byPath.set(input.path, input);
  return [...byPath.values()].sort((left, right) => compareStrings(left.path, right.path));
}

function resolveBrowserPostLinkBindings(
  manifest,
  flashProfile,
  boardPack,
  customPartitions = null,
  projectSha256,
  espSr16 = false,
) {
  if (!manifest || manifest.schema !== 2 || manifest.id !== boardPack.id
    || manifest.revision !== boardPack.revision || !Array.isArray(manifest.artifacts)
    || !flashProfile || typeof flashProfile !== 'object' || Array.isArray(flashProfile)) {
    throw new TypeError('ESP32 browser Board/Flash Pack Manifest identity is invalid');
  }
  const modelProfile = espSr16 ? resolveEspSr16FlashModelProfile(flashProfile) : null;
  const definitions = [
    {
      key: 'bootloader', artifactId: flashProfile.bootloader,
      path: 'packs/board/bootloader.bin', role: 'bootloader-source',
    },
    ...(customPartitions === null ? [{
      key: 'partitions', artifactId: flashProfile.partitions,
      path: 'packs/board/partitions.bin', role: 'partitions-source',
    }] : []),
    {
      key: 'bootApp0', artifactId: flashProfile.bootApp0,
      path: 'packs/board/boot_app0.bin', role: 'boot-app0-source',
    },
    ...(modelProfile === null ? [] : [{
      key: 'model', artifactId: modelProfile.artifactId,
      path: ESP32_ESP_SR_MODEL.path, role: ESP32_ESP_SR_MODEL.role,
      size: modelProfile.size, sha256: ESP32_ESP_SR_MODEL.sha256,
    }]),
  ];
  if (definitions.some(({ artifactId }) => (
    typeof artifactId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/.test(artifactId)
  )) || new Set(definitions.map(({ artifactId }) => artifactId)).size !== definitions.length) {
    throw new TypeError('ESP32 browser flash artifact bindings are invalid');
  }
  const immutable = Object.fromEntries(definitions.map((definition) => {
    const matches = manifest.artifacts.filter((artifact) => artifact?.id === definition.artifactId);
    const artifact = matches[0];
    if (matches.length !== 1 || artifact.kind !== 'bin'
      || !Number.isSafeInteger(artifact.size) || artifact.size <= 0
      || !SHA256.test(artifact.sha256)
      || (definition.size !== undefined && artifact.size !== definition.size)
      || (definition.sha256 !== undefined && artifact.sha256 !== definition.sha256)
      || (definition.key === 'model' && artifact.size > ESP32_ESP_SR_MODEL.capacity)) {
      throw new TypeError(`ESP32 browser Board Pack artifact is invalid: ${definition.artifactId}`);
    }
    return [definition.key, {
      kind: 'immutable',
      path: definition.path,
      role: definition.role,
      ...(definition.size === undefined ? {} : { size: definition.size }),
      sha256: artifact.sha256,
      provenance: {
        kind: 'pack-artifact',
        packId: boardPack.id,
        packSha256: boardPack.revision,
        packSchema: manifest.schema,
        artifactId: definition.artifactId,
      },
    }];
  }));
  const partitions = customPartitions === null
    ? { source: 'immutable-bin', input: immutable.partitions }
    : {
        source: 'csv',
        input: {
          kind: 'immutable',
          path: customPartitions.path,
          role: 'partitions-source',
          sha256: customPartitions.sourceSha256,
          provenance: {
            kind: 'project-file',
            path: customPartitions.path,
            projectSha256: projectSha256 ?? customPartitions.projectSnapshotSha256,
            fileSha256: customPartitions.sourceSha256,
          },
        },
      };
  return {
    application: {
      kind: 'action-output', actionId: 'link-firmware',
      path: 'build/firmware.elf', role: 'linked-elf',
    },
    bootloader: { source: 'immutable-bin', input: immutable.bootloader },
    partitions,
    bootApp0: immutable.bootApp0,
    ...(immutable.model === undefined ? {} : { model: immutable.model }),
  };
}

function normalizeLibrarySources(values, packs, localSources = []) {
  const sources = Array.isArray(values) ? values : [];
  const byPack = new Map(sources.map((source) => [source.packId, source]));
  const localByPack = new Map(localSources.map((source) => [source.pack.id, source]));
  return packs.map((pack) => {
    const source = byPack.get(pack.id);
    const local = localByPack.get(pack.id);
    if (local) {
      return {
        pack,
        files: local.files.map((file) => ({ path: file.path, content: file.content })),
        includePaths: [...local.includePaths],
        rootPath: local.rootPath,
      };
    }
    if (!source || !Array.isArray(source.files) || !Array.isArray(source.includeDirs)) {
      throw new TypeError(`ESP32 browser Library Source Pack is not resolved: ${pack.id}`);
    }
    return {
      pack,
      files: source.files.map((file) => ({ path: file.path, content: file.content })),
      includePaths: [...source.includeDirs],
      rootPath: libraryRoot(pack),
    };
  });
}

function libraryRoot(pack) {
  return `packs/libraries/${pack.id}`;
}

// Action arguments are hashed, so sorting must not depend on the browser locale.
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function languageFor(path) {
  const extension = path.toLowerCase().split('.').at(-1);
  if (extension === 'ino') return 'ino';
  if (extension === 'c') return 'c';
  if (['cc', 'cpp', 'cxx'].includes(extension)) return 'c++';
  if (['s', 'asm'].includes(extension)) return 'asm';
  if (['h', 'hh', 'hpp', 'hxx'].includes(extension)) return 'header';
  return 'other';
}

function projectIncludePaths(files) {
  const paths = new Set(['project']);
  for (const file of Array.isArray(files) ? files : []) {
    const segments = String(file?.name ?? '').replaceAll('\\', '/').split('/');
    segments.pop();
    for (let length = 1; length <= segments.length; length++) {
      paths.add(`project/${segments.slice(0, length).join('/')}`);
    }
  }
  return [...paths].sort();
}
