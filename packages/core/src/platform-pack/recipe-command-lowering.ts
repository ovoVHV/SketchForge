import { canonicalJson, sha256Hex } from '../build-ir/canonical.js';
import type { Sha256, TransformFormat } from '../build-ir/types.js';
import {
  resolvePlatformManifest,
  tokenizeRecipe,
  validatePlatformManifest,
} from './builder.js';
import {
  CK_RECIPE_LOWERING_SCHEMA_VERSION,
  type CKPlatformManifest,
  type CKPlatformRecipeLowering,
  type PlatformRecipe,
  type ResolvedPlatformManifest,
} from './types.js';

export type PlatformCompileLanguage = 'c' | 'cxx' | 'asm';

export interface ExpandedPlatformRecipeArgument {
  value: string;
  dependencies: ReadonlySet<string>;
}

export interface DerivedPlatformArchiveCommand {
  recipeId: string;
  command: 'ar';
  operation: 'rcs';
  argumentOrder: readonly ['operation', 'output', 'inputs', 'flags'];
  flags: readonly string[];
}

export interface DerivedPlatformRecipeCommands {
  compile: Readonly<{
    common: readonly ExpandedPlatformRecipeArgument[];
    languageFlags: Readonly<Record<PlatformCompileLanguage, readonly string[]>>;
  }>;
  archive: Readonly<DerivedPlatformArchiveCommand>;
  link: readonly ExpandedPlatformRecipeArgument[];
}

export interface DerivePlatformRecipeCommandsInput {
  recipes: readonly PlatformRecipe[];
  recipeLowering: CKPlatformRecipeLowering;
  properties: Readonly<Record<string, string>>;
}

export const CK_ESP32_POST_LINK_CONTRACT_SCHEMA_VERSION = 1 as const;

export type CKEsp32PostLinkProductId =
  | 'application'
  | 'bootloader'
  | 'partitions'
  | 'boot-app0'
  | 'model'
  | 'merged';

type Esp32FlashProductId = Exclude<CKEsp32PostLinkProductId, 'merged'>;

export type CKHexOffset = `0x${string}`;

const ESP32_ESP_SR_PARTITION_SCHEME = 'esp_sr_16';
const ESP32_ESP_SR_MODEL_ARTIFACT_ID = 'srmodels';
const ESP32_ESP_SR_MODEL_PATH = 'packs/board/srmodels.bin';
const ESP32_ESP_SR_MODEL_OUTPUT = 'build/srmodels.bin';
const ESP32_ESP_SR_MODEL_ROLE = 'model-source';
const ESP32_ESP_SR_MODEL_OFFSET: CKHexOffset = '0xd10000';
const ESP32_ESP_SR_MODEL_CAPACITY_BYTES = 0x2f0000n;

export interface CKPostLinkActionOutputInput {
  kind: 'action-output';
  actionId: string;
  path: string;
  role: string;
}

export interface CKPostLinkImmutableInput {
  kind: 'immutable';
  path: string;
  role: string;
  sha256: Sha256;
  /** Pack artifacts used by ESP-SR carry their manifest byte length as well. */
  size?: number;
  provenance: CKPostLinkImmutableProvenance;
}

export interface CKEsp32PostLinkModelInput extends CKPostLinkImmutableInput {
  size: number;
}

export type CKPostLinkImmutableProvenance =
  | Readonly<{
    kind: 'pack-artifact';
    packId: string;
    packSha256: Sha256;
    packSchema: number;
    artifactId: string;
  }>
  | Readonly<{
    kind: 'pack-file';
    packId: string;
    packSha256: Sha256;
    selector: string;
  }>
  | Readonly<{
    /** A project-owned immutable file; currently only root partitions.csv. */
    kind: 'project-file';
    path: string;
    projectSha256: Sha256;
    fileSha256: Sha256;
  }>;

export type CKPostLinkInput = CKPostLinkActionOutputInput | CKPostLinkImmutableInput;

export interface CKEsp32PostLinkBindings {
  application: CKPostLinkActionOutputInput;
  bootloader: Readonly<{
    source: 'sdk-elf' | 'immutable-bin';
    input: CKPostLinkImmutableInput;
  }>;
  partitions: Readonly<{
    source: 'csv' | 'immutable-bin';
    input: CKPostLinkImmutableInput;
  }>;
  bootApp0: CKPostLinkImmutableInput;
  /** Required only when the selected partition scheme is esp_sr_16. */
  model?: CKEsp32PostLinkModelInput;
}

export type CKEsp32PostLinkOperation =
  | Readonly<{
    kind: 'esp32.elf2image';
    input: CKPostLinkInput;
    chip: string;
    flashMode: string;
    flashFrequency: string;
    flashSize: string;
    elfSha256Offset?: CKHexOffset;
  }>
  | Readonly<{
    kind: 'esp32.partition-bin';
    input: CKPostLinkImmutableInput;
    quiet: true;
  }>
  | Readonly<{
    kind: 'materialize';
    input: CKPostLinkImmutableInput;
  }>
  | Readonly<{
    kind: 'esp32.merge-bin';
    chip: string;
    padToSize: string;
    flashMode: 'keep';
    flashFrequency: 'keep';
    flashSize: 'keep';
    segments: readonly Readonly<{
      productId: Exclude<CKEsp32PostLinkProductId, 'merged'>;
      offset: CKHexOffset;
      input: CKPostLinkActionOutputInput;
    }>[];
  }>;

export interface CKEsp32PostLinkProduct {
  id: `transform-${CKEsp32PostLinkProductId}`;
  productId: CKEsp32PostLinkProductId;
  lifecycle: 'project' | 'configuration';
  format: TransformFormat;
  output: string;
  offset?: CKHexOffset;
  operation: CKEsp32PostLinkOperation;
}

export interface CKEsp32PostLinkContractSource {
  platformManifestSha256: Sha256;
  recipeLoweringSha256: Sha256;
  fqbn: string;
  boardPackId: string;
  boardPackSha256: Sha256;
}

export interface CKPostLinkPackIdentity {
  id: string;
  sha256: Sha256;
}

export interface CKPostLinkPackArtifactManifest {
  schema: 2;
  id: string;
  version: string;
  artifacts: readonly Readonly<{
    id: string;
    kind: string;
    size: number;
    sha256: Sha256;
  }>[];
}

export interface CKEsp32PostLinkContractBody {
  kind: 'ck-esp32-post-link-contract';
  schemaVersion: typeof CK_ESP32_POST_LINK_CONTRACT_SCHEMA_VERSION;
  source: CKEsp32PostLinkContractSource;
  target: Readonly<{
    chip: string;
    flashMode: string;
    flashFrequency: string;
    flashSize: string;
  }>;
  products: readonly CKEsp32PostLinkProduct[];
}

export interface CKEsp32PostLinkContract extends CKEsp32PostLinkContractBody {
  sha256: Sha256;
}

export interface DeriveEsp32PostLinkContractInput {
  manifest: CKPlatformManifest;
  resolved: ResolvedPlatformManifest;
  boardPack: CKPostLinkPackIdentity;
  /** Exact, content-addressed revision input required by Board Pack artifact bindings. */
  boardPackRevisionInput?: string;
  bindings: CKEsp32PostLinkBindings;
}

export function expandPlatformProperty(
  properties: Readonly<Record<string, string>>,
  raw: string,
): Readonly<{ value: string; dependencies: ReadonlySet<string> }> {
  let value = raw;
  const dependencies = new Set<string>();
  for (let pass = 0; pass < 32; pass += 1) {
    let changed = false;
    value = value.replace(/\{([^{}]+)\}/g, (placeholder, key: string) => {
      dependencies.add(key);
      if (!Object.prototype.hasOwnProperty.call(properties, key)) return placeholder;
      changed = true;
      return properties[key]!;
    });
    if (!changed) break;
  }
  return Object.freeze({ value, dependencies });
}

export function hasPlatformPropertyDependency(
  argument: ExpandedPlatformRecipeArgument,
  key: string,
): boolean {
  return [...argument.dependencies].some((dependency) => (
    dependency === key || dependency.startsWith(`${key}.`)
  ));
}

export function derivePlatformRecipeCommands(
  input: DerivePlatformRecipeCommandsInput,
): DerivedPlatformRecipeCommands {
  const lowering = validateRecipeCommandInput(input);
  const boundRecipeIds = [
    lowering.bindings.compile.c,
    lowering.bindings.compile.cxx,
    lowering.bindings.compile.asm,
    lowering.bindings.archive,
    lowering.bindings.link,
  ];
  if (new Set(boundRecipeIds).size !== boundRecipeIds.length) {
    throw new TypeError('Platform recipe lowering bindings must be distinct');
  }
  for (const id of boundRecipeIds) requiredRecipe(input.recipes, id);

  const compile = deriveLanguageCompileRecipes(input.recipes, lowering, input.properties);
  const archive = deriveArchiveRecipe(input.recipes, lowering, input.properties);
  const link = expandRecipeArguments(
    requiredRecipe(input.recipes, lowering.bindings.link),
    input.properties,
  );
  return Object.freeze({
    compile,
    archive,
    link: Object.freeze(link),
  });
}

export function derivePlatformArchiveCommand(
  input: DerivePlatformRecipeCommandsInput,
): Readonly<DerivedPlatformArchiveCommand> {
  const lowering = validateRecipeCommandInput(input);
  return deriveArchiveRecipe(input.recipes, lowering, input.properties);
}

/**
 * Lower the modeled ESP32 post-link recipes to internal CK operations. Shell
 * hook bodies are deliberately ignored; immutable Pack bindings own inputs.
 */
export function deriveEsp32PostLinkContract(
  input: DeriveEsp32PostLinkContractInput,
): Readonly<CKEsp32PostLinkContract> {
  const { manifest, resolved, properties, espSr16 } = resolveEsp32PostLinkPlatform(input);
  validateEsp32ModeledTools(properties);
  requireDirectPatternRecipe(
    manifest.recipes,
    'recipe.objcopy.bin',
    '{tools.esptool_py.path}/{tools.esptool_py.cmd}',
    'recipe.objcopy.bin.pattern_args',
  );
  requirePartitionRecipe(manifest.recipes);
  requireDirectPatternRecipe(
    manifest.recipes,
    'recipe.hooks.objcopy.postobjcopy.3',
    '{tools.esptool_py.path}/{tools.esptool_py.cmd}',
    'recipe.hooks.objcopy.postobjcopy.3.pattern_args',
  );

  const application = parseEsp32Application(properties);
  const partitions = parseEsp32Partitions(properties);
  const bootloader = parseEsp32Bootloader(properties);
  assertExpectedEsp32Image(application, properties);
  assertSameEsp32Target(application, bootloader, 'bootloader');
  const merge = parseEsp32Merge(properties, application, partitions, espSr16);
  if (merge.chip !== application.chip) {
    throw new TypeError('ESP32 merge chip does not match application chip');
  }
  if (merge.padToSize !== application.flashSize) {
    throw new TypeError('ESP32 merge pad size does not match application flash size');
  }
  assertExpectedEsp32Paths(application, partitions, merge);

  const boardPack = normalizePostLinkPackIdentity(input.boardPack);
  const bindings = normalizeEsp32Bindings(input.bindings, application.input, boardPack, espSr16);
  validatePostLinkPackArtifacts(bindings, input.boardPackRevisionInput, boardPack);
  assertExpectedEsp32FlashLayout(merge, properties, espSr16, bindings.model?.size);
  const offsets = new Map(merge.segments.map((segment) => [segment.productId, segment.offset]));
  const applicationProduct = freezeProduct({
    id: 'transform-application',
    productId: 'application',
    lifecycle: 'project',
    format: 'bin',
    output: application.output,
    offset: requiredProductOffset(offsets, 'application'),
    operation: Object.freeze({
      kind: 'esp32.elf2image',
      input: bindings.application,
      chip: application.chip,
      flashMode: application.flashMode,
      flashFrequency: application.flashFrequency,
      flashSize: application.flashSize,
      elfSha256Offset: application.elfSha256Offset,
    }),
  });
  const bootloaderProduct = freezeProduct({
    id: 'transform-bootloader',
    productId: 'bootloader',
    lifecycle: 'configuration',
    format: 'bootloader',
    output: 'build/bootloader.bin',
    offset: requiredProductOffset(offsets, 'bootloader'),
    operation: bindings.bootloader.source === 'sdk-elf'
      ? Object.freeze({
        kind: 'esp32.elf2image' as const,
        input: bindings.bootloader.input,
        chip: bootloader.chip,
        flashMode: bootloader.flashMode,
        flashFrequency: bootloader.flashFrequency,
        flashSize: bootloader.flashSize,
      })
      : Object.freeze({
        kind: 'materialize' as const,
        input: bindings.bootloader.input,
      }),
  });
  const partitionsProduct = freezeProduct({
    id: 'transform-partitions',
    productId: 'partitions',
    lifecycle: 'configuration',
    format: 'partition',
    output: 'build/partitions.bin',
    offset: requiredProductOffset(offsets, 'partitions'),
    operation: bindings.partitions.source === 'csv'
      ? Object.freeze({
        kind: 'esp32.partition-bin' as const,
        input: bindings.partitions.input,
        quiet: true as const,
      })
      : Object.freeze({
        kind: 'materialize' as const,
        input: bindings.partitions.input,
      }),
  });
  const bootApp0Product = freezeProduct({
    id: 'transform-boot-app0',
    productId: 'boot-app0',
    lifecycle: 'configuration',
    format: 'boot-app0',
    output: 'build/boot_app0.bin',
    offset: requiredProductOffset(offsets, 'boot-app0'),
    operation: Object.freeze({
      kind: 'materialize',
      input: bindings.bootApp0,
    }),
  });
  let modelProduct: Readonly<CKEsp32PostLinkProduct> | undefined;
  if (espSr16) {
    if (!bindings.model) {
      throw new TypeError('ESP32 model binding is required for esp_sr_16');
    }
    modelProduct = freezeProduct({
      id: 'transform-model',
      productId: 'model',
      lifecycle: 'configuration',
      format: 'bin',
      output: ESP32_ESP_SR_MODEL_OUTPUT,
      offset: requiredProductOffset(offsets, 'model'),
      operation: Object.freeze({
        kind: 'materialize',
        input: bindings.model,
      }),
    });
  }
  const sourceProducts: CKEsp32PostLinkProduct[] = [
    applicationProduct,
    bootloaderProduct,
    partitionsProduct,
    bootApp0Product,
  ];
  if (modelProduct) sourceProducts.push(modelProduct);
  const sourceById = new Map(sourceProducts.map((product) => [product.productId, product]));
  const mergeSegments = merge.segments.map((segment) => {
    const product = sourceById.get(segment.productId);
    if (!product) throw new TypeError(`ESP32 merge product is unavailable: ${segment.productId}`);
    return Object.freeze({
      productId: segment.productId,
      offset: segment.offset,
      input: Object.freeze({
        kind: 'action-output' as const,
        actionId: product.id,
        path: product.output,
        role: `${segment.productId}-image`,
      }),
    });
  });
  const mergedProduct = freezeProduct({
    id: 'transform-merged',
    productId: 'merged',
    lifecycle: 'project',
    format: 'bin',
    output: merge.output,
    operation: Object.freeze({
      kind: 'esp32.merge-bin',
      chip: merge.chip,
      padToSize: merge.padToSize,
      flashMode: 'keep',
      flashFrequency: 'keep',
      flashSize: 'keep',
      segments: Object.freeze(mergeSegments),
    }),
  });
  const body: CKEsp32PostLinkContractBody = Object.freeze({
    kind: 'ck-esp32-post-link-contract',
    schemaVersion: CK_ESP32_POST_LINK_CONTRACT_SCHEMA_VERSION,
    source: Object.freeze({
      platformManifestSha256: manifest.sha256,
      recipeLoweringSha256: manifest.recipeLowering.sha256,
      fqbn: resolved.board.fqbn,
      boardPackId: boardPack.id,
      boardPackSha256: boardPack.sha256,
    }),
    target: Object.freeze({
      chip: application.chip,
      flashMode: application.flashMode,
      flashFrequency: application.flashFrequency,
      flashSize: application.flashSize,
    }),
    products: Object.freeze([...sourceProducts, mergedProduct]),
  });
  return Object.freeze({
    ...body,
    sha256: sha256Hex(canonicalJson(body)),
  });
}

interface ParsedEsp32Image {
  chip: string;
  flashMode: string;
  flashFrequency: string;
  flashSize: string;
}

interface ParsedEsp32Application extends ParsedEsp32Image {
  elfSha256Offset: CKHexOffset;
  input: string;
  output: string;
}

interface ParsedEsp32Merge {
  chip: string;
  output: string;
  padToSize: string;
  paths: Readonly<Partial<Record<Esp32FlashProductId, string>>>;
  segments: readonly Readonly<{
    productId: Esp32FlashProductId;
    offset: CKHexOffset;
  }>[];
}

const ESP32_IMAGE_OPTIONS = Object.freeze([
  '--chip',
  '--flash-mode',
  '--flash-freq',
  '--flash-size',
] as const);

const ESP32_FLASH_PRODUCT_ORDER = Object.freeze([
  'bootloader',
  'partitions',
  'boot-app0',
  'application',
] as const) as readonly Esp32FlashProductId[];

function esp32FlashProductOrder(espSr16: boolean): readonly Esp32FlashProductId[] {
  return espSr16
    ? Object.freeze([...ESP32_FLASH_PRODUCT_ORDER, 'model'])
    : ESP32_FLASH_PRODUCT_ORDER;
}

function parseEsp32Application(
  properties: Readonly<Record<string, string>>,
): ParsedEsp32Application {
  const label = 'ESP32 application recipe';
  const tokens = strictPropertyTokens(properties, 'recipe.objcopy.bin.pattern_args');
  const options = new Map<string, string>();
  let operationCount = 0;
  let output: string | undefined;
  let input: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === 'elf2image') {
      operationCount += 1;
      continue;
    }
    if (token === '-o') {
      if (output !== undefined) throw new TypeError(`${label} contains duplicate -o`);
      output = requiredFollowingToken(tokens, ++index, '-o', label);
      continue;
    }
    if ([...ESP32_IMAGE_OPTIONS, '--elf-sha256-offset'].includes(token as never)) {
      if (options.has(token)) throw new TypeError(`${label} contains duplicate ${token}`);
      options.set(token, requiredFollowingToken(tokens, ++index, token, label));
      continue;
    }
    if (token.startsWith('-')) throw new TypeError(`${label} contains an unmodeled argument: ${token}`);
    if (input !== undefined) throw new TypeError(`${label} contains an unmodeled positional argument: ${token}`);
    input = token;
  }
  requireOperationCount(operationCount, 'elf2image', label);
  requireOptionSet(options, [...ESP32_IMAGE_OPTIONS, '--elf-sha256-offset'], label);
  if (output === undefined || input === undefined) {
    throw new TypeError(`${label} requires exactly one output and ELF input`);
  }
  const elfSha256Offset = normalizeHexOffset(
    options.get('--elf-sha256-offset')!,
    `${label} ELF SHA-256 offset`,
  );
  if (elfSha256Offset !== '0xb0') {
    throw new TypeError(`${label} ELF SHA-256 offset must be 0xb0`);
  }
  const normalizedInput = normalizeContractPath(input, `${label} input`);
  const normalizedOutput = normalizeContractPath(output, `${label} output`);
  if (!normalizedInput.endsWith('.elf') || !normalizedOutput.endsWith('.bin')) {
    throw new TypeError(`${label} input/output formats are invalid`);
  }
  return {
    ...normalizeEsp32ImageOptions(options, label),
    elfSha256Offset,
    input: normalizedInput,
    output: normalizedOutput,
  };
}

function parseEsp32Bootloader(
  properties: Readonly<Record<string, string>>,
): ParsedEsp32Image {
  const label = 'ESP32 bootloader recipe';
  const tokens = strictPropertyTokens(properties, 'recipe.hooks.prebuild.4.pattern_args');
  const options = new Map<string, string>();
  let operationCount = 0;
  let outputMarkerCount = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === 'elf2image') {
      operationCount += 1;
      continue;
    }
    if (token === '-o') {
      outputMarkerCount += 1;
      if (index !== tokens.length - 1) {
        throw new TypeError(`${label} -o marker must be the final argument`);
      }
      continue;
    }
    if ((ESP32_IMAGE_OPTIONS as readonly string[]).includes(token)) {
      if (options.has(token)) throw new TypeError(`${label} contains duplicate ${token}`);
      options.set(token, requiredFollowingToken(tokens, ++index, token, label));
      continue;
    }
    throw new TypeError(`${label} contains an unmodeled argument: ${token}`);
  }
  requireOperationCount(operationCount, 'elf2image', label);
  if (outputMarkerCount !== 1) throw new TypeError(`${label} must contain exactly one -o marker`);
  requireOptionSet(options, ESP32_IMAGE_OPTIONS, label);
  return normalizeEsp32ImageOptions(options, label);
}

function parseEsp32Partitions(
  properties: Readonly<Record<string, string>>,
): Readonly<{ input: string; output: string }> {
  const input = normalizeContractPath(
    strictExpandedArgument(properties, '{build.path}/partitions.csv', 'ESP32 partition input').value,
    'ESP32 partition input',
  );
  const output = normalizeContractPath(
    strictExpandedArgument(
      properties,
      '{build.path}/{build.project_name}.partitions.bin',
      'ESP32 partition output',
    ).value,
    'ESP32 partition output',
  );
  if (!input.endsWith('.csv') || !output.endsWith('.bin')) {
    throw new TypeError('ESP32 partition recipe input/output formats are invalid');
  }
  return Object.freeze({ input, output });
}

function parseEsp32Merge(
  properties: Readonly<Record<string, string>>,
  application: ParsedEsp32Application,
  partitions: Readonly<{ input: string; output: string }>,
  espSr16: boolean,
): ParsedEsp32Merge {
  const label = 'ESP32 merge recipe';
  const tokens = strictPropertyTokens(
    properties,
    'recipe.hooks.objcopy.postobjcopy.3.pattern_args',
  );
  const options = new Map<string, string>();
  const rawSegments: Array<{ offset: CKHexOffset; path: string }> = [];
  let operationCount = 0;
  let output: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (/^0x[0-9a-f]+$/i.test(token)) {
      for (let pair = index; pair < tokens.length; pair += 2) {
        const rawOffset = tokens[pair];
        const rawPath = tokens[pair + 1];
        if (rawOffset === undefined || rawPath === undefined || !/^0x[0-9a-f]+$/i.test(rawOffset)) {
          throw new TypeError(`${label} flash layout must contain offset/path pairs`);
        }
        rawSegments.push({
          offset: normalizeHexOffset(rawOffset, `${label} segment offset`),
          path: normalizeContractPath(rawPath, `${label} segment path`),
        });
      }
      break;
    }
    if (token === 'merge-bin') {
      operationCount += 1;
      continue;
    }
    if (token === '-o') {
      if (output !== undefined) throw new TypeError(`${label} contains duplicate -o`);
      output = requiredFollowingToken(tokens, ++index, '-o', label);
      continue;
    }
    if (['--chip', '--pad-to-size', '--flash-mode', '--flash-freq', '--flash-size'].includes(token)) {
      if (options.has(token)) throw new TypeError(`${label} contains duplicate ${token}`);
      options.set(token, requiredFollowingToken(tokens, ++index, token, label));
      continue;
    }
    throw new TypeError(`${label} contains an unmodeled argument: ${token}`);
  }
  requireOperationCount(operationCount, 'merge-bin', label);
  requireOptionSet(
    options,
    ['--chip', '--pad-to-size', '--flash-mode', '--flash-freq', '--flash-size'],
    label,
  );
  for (const option of ['--flash-mode', '--flash-freq', '--flash-size']) {
    if (options.get(option) !== 'keep') {
      throw new TypeError(`${label} ${option} must be keep`);
    }
  }
  if (output === undefined || rawSegments.length !== ESP32_FLASH_PRODUCT_ORDER.length) {
    throw new TypeError(`${label} requires one output and exactly four recipe flash segments`);
  }
  const recipePaths: Partial<Record<Esp32FlashProductId, string>> = {
    application: application.output,
    bootloader: normalizeContractPath(
      strictExpandedArgument(
        properties,
        '{build.path}/{build.project_name}.bootloader.bin',
        'ESP32 bootloader output',
      ).value,
      'ESP32 bootloader output',
    ),
    partitions: partitions.output,
    'boot-app0': normalizeContractPath(
      strictExpandedArgument(
        properties,
        '{runtime.platform.path}/tools/partitions/boot_app0.bin',
        'ESP32 boot_app0 input',
      ).value,
      'ESP32 boot_app0 input',
    ),
  };
  const expectedByPath = new Map<string, Esp32FlashProductId>();
  for (const [productId, path] of Object.entries(recipePaths)) {
    if (path !== undefined) expectedByPath.set(path, productId as Esp32FlashProductId);
  }
  const offsets = new Map<Esp32FlashProductId, CKHexOffset>();
  const seenOffsets = new Set<CKHexOffset>();
  const flashBytes = parseFlashSizeBytes(application.flashSize, `${label} flash size`);
  for (const segment of rawSegments) {
    const productId = expectedByPath.get(segment.path);
    if (!productId) throw new TypeError(`${label} contains an unknown product path: ${segment.path}`);
    if (offsets.has(productId)) throw new TypeError(`${label} contains duplicate product: ${productId}`);
    if (seenOffsets.has(segment.offset)) throw new TypeError(`${label} contains duplicate offset: ${segment.offset}`);
    if (BigInt(segment.offset) >= flashBytes) {
      throw new TypeError(`${label} segment offset exceeds flash size: ${segment.offset}`);
    }
    offsets.set(productId, segment.offset);
    seenOffsets.add(segment.offset);
  }
  if (offsets.size !== ESP32_FLASH_PRODUCT_ORDER.length) {
    throw new TypeError(`${label} does not contain every required product`);
  }
  const segments: Array<Readonly<{
    productId: Esp32FlashProductId;
    offset: CKHexOffset;
  }>> = ESP32_FLASH_PRODUCT_ORDER.map((productId) => Object.freeze({
    productId,
    offset: offsets.get(productId)!,
  }));
  const paths: Partial<Record<Esp32FlashProductId, string>> = { ...recipePaths };
  if (espSr16) {
    // The upstream recipe owns four base images; CK owns the structured model segment.
    paths.model = ESP32_ESP_SR_MODEL_OUTPUT;
    segments.push(Object.freeze({
      productId: 'model',
      offset: ESP32_ESP_SR_MODEL_OFFSET,
    }));
  }
  return Object.freeze({
    chip: normalizeEsp32Scalar(options.get('--chip')!, `${label} chip`),
    output: normalizeContractPath(output, `${label} output`),
    padToSize: normalizeEsp32Scalar(options.get('--pad-to-size')!, `${label} pad size`),
    paths: Object.freeze(paths),
    segments: Object.freeze(segments),
  });
}

function normalizeEsp32ImageOptions(
  options: ReadonlyMap<string, string>,
  label: string,
): ParsedEsp32Image {
  return Object.freeze({
    chip: normalizeEsp32Scalar(options.get('--chip')!, `${label} chip`),
    flashMode: normalizeEsp32Scalar(options.get('--flash-mode')!, `${label} flash mode`),
    flashFrequency: normalizeEsp32Scalar(
      options.get('--flash-freq')!,
      `${label} flash frequency`,
    ),
    flashSize: normalizeEsp32Scalar(options.get('--flash-size')!, `${label} flash size`),
  });
}

function assertSameEsp32Target(
  expected: ParsedEsp32Image,
  actual: ParsedEsp32Image,
  label: string,
): void {
  if (actual.chip !== expected.chip
    || actual.flashMode !== expected.flashMode
    || actual.flashFrequency !== expected.flashFrequency
    || actual.flashSize !== expected.flashSize) {
    throw new TypeError(`ESP32 ${label} image parameters do not match the application image`);
  }
}

function assertExpectedEsp32Image(
  image: ParsedEsp32Application,
  properties: Readonly<Record<string, string>>,
): void {
  const expected: ParsedEsp32Image = {
    chip: normalizeEsp32Scalar(
      strictExpandedArgument(properties, '{build.mcu}', 'build.mcu').value,
      'ESP32 build.mcu',
    ),
    flashMode: normalizeEsp32Scalar(
      strictExpandedArgument(properties, '{build.flash_mode}', 'build.flash_mode').value,
      'ESP32 build.flash_mode',
    ),
    flashFrequency: normalizeEsp32Scalar(
      strictExpandedArgument(properties, '{build.img_freq}', 'build.img_freq').value,
      'ESP32 build.img_freq',
    ),
    flashSize: normalizeEsp32Scalar(
      strictExpandedArgument(properties, '{build.flash_size}', 'build.flash_size').value,
      'ESP32 build.flash_size',
    ),
  };
  assertSameEsp32Target(expected, image, 'application');
}

function assertExpectedEsp32Paths(
  application: ParsedEsp32Application,
  partitions: Readonly<{ input: string; output: string }>,
  merge: ParsedEsp32Merge,
): void {
  const expected = {
    applicationInput: 'build/firmware.elf',
    applicationOutput: 'build/firmware.bin',
    partitionInput: 'build/partitions.csv',
    partitionOutput: 'build/firmware.partitions.bin',
    mergedOutput: 'build/firmware.merged.bin',
  };
  if (application.input !== expected.applicationInput
    || application.output !== expected.applicationOutput
    || partitions.input !== expected.partitionInput
    || partitions.output !== expected.partitionOutput
    || merge.output !== expected.mergedOutput) {
    throw new TypeError('ESP32 post-link recipe paths do not match the CK logical layout');
  }
}

function assertExpectedEsp32FlashLayout(
  merge: ParsedEsp32Merge,
  properties: Readonly<Record<string, string>>,
  espSr16: boolean,
  modelSize: number | undefined,
): void {
  const actual = new Map(merge.segments.map((segment) => [segment.productId, segment.offset]));
  const expected: Partial<Record<Esp32FlashProductId, CKHexOffset>> = {
    bootloader: normalizeHexOffset(
      strictExpandedArgument(
        properties,
        '{build.bootloader_addr}',
        'build.bootloader_addr',
      ).value,
      'ESP32 build.bootloader_addr',
    ),
    partitions: '0x8000',
    'boot-app0': '0xe000',
    application: '0x10000',
  };
  const productOrder = esp32FlashProductOrder(espSr16);
  if (espSr16) expected.model = ESP32_ESP_SR_MODEL_OFFSET;
  for (const productId of productOrder) {
    if (actual.get(productId) !== expected[productId]) {
      throw new TypeError(`ESP32 ${productId} flash offset does not match the modeled layout`);
    }
  }
  if (!espSr16) return;

  const flashBytes = parseFlashSizeBytes(
    strictExpandedArgument(properties, '{build.flash_size}', 'ESP32 flash size').value,
    'ESP32 flash size',
  );
  const expectedFlashBytes = 16n * 1024n * 1024n;
  if (flashBytes !== expectedFlashBytes) {
    throw new TypeError('ESP32 esp_sr_16 requires a 16MB flash layout');
  }
  if (modelSize === undefined || !Number.isSafeInteger(modelSize) || modelSize < 1) {
    throw new TypeError('ESP32 esp_sr_16 model artifact size is invalid');
  }
  const modelBytes = BigInt(modelSize);
  if (modelBytes > ESP32_ESP_SR_MODEL_CAPACITY_BYTES) {
    throw new TypeError('ESP32 esp_sr_16 model artifact exceeds its allocated capacity');
  }
  const modelOffset = actual.get('model');
  if (!modelOffset || BigInt(modelOffset) + modelBytes > flashBytes) {
    throw new TypeError('ESP32 esp_sr_16 model artifact exceeds the flash layout');
  }
}

function resolveEsp32PostLinkPlatform(
  input: DeriveEsp32PostLinkContractInput,
): Readonly<{
  manifest: CKPlatformManifest;
  resolved: ResolvedPlatformManifest;
  properties: Readonly<Record<string, string>>;
  espSr16: boolean;
}> {
  if (!isRecord(input) || !isRecord(input.manifest)
    || !isRecord(input.resolved) || !isRecord(input.boardPack)
    || !isRecord(input.bindings)) {
    throw new TypeError('ESP32 post-link contract input is invalid');
  }
  const manifest = validatePlatformManifest(input.manifest);
  const provided = input.resolved;
  if (typeof provided.board?.fqbn !== 'string' || !isRecord(provided.options)) {
    throw new TypeError('ESP32 post-link resolved platform is invalid');
  }
  const resolved = resolvePlatformManifest({
    manifest,
    fqbn: provided.board.fqbn,
    options: provided.options,
  });
  if (canonicalJson(resolved) !== canonicalJson(provided)) {
    throw new TypeError('ESP32 post-link resolved platform does not match its Manifest');
  }
  if (resolved.architecture.toLowerCase() !== 'esp32' || !resolved.recipeLowering
    || resolved.manifestSha256 !== manifest.sha256
    || resolved.recipeLowering.sha256 !== manifest.recipeLowering.sha256) {
    throw new TypeError('ESP32 post-link platform identity is invalid');
  }
  const properties: Readonly<Record<string, string>> = Object.freeze({
    ...resolved.properties,
    'build.path': 'build',
    'build.project_name': 'firmware',
    'runtime.platform.path': 'packs/platform',
  });
  if (typeof properties['build.partitions'] !== 'string'
    || !properties['build.partitions']!.trim()) {
    throw new TypeError('ESP32 custom partition selection requires an explicit project binding');
  }
  if (properties['upload.extra_flags']?.trim()) {
    throw new TypeError('ESP32 upload extra flash segments are not modeled by the post-link contract');
  }
  const partitionOptionValues = [
    resolved.options.partition_scheme,
    resolved.options.PartitionScheme,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const optionSelectsEspSr16 = partitionOptionValues.some(
    (value) => value === ESP32_ESP_SR_PARTITION_SCHEME,
  );
  const propertySelectsEspSr16 = properties['build.partitions'] === ESP32_ESP_SR_PARTITION_SCHEME;
  if (partitionOptionValues.length > 0 && optionSelectsEspSr16 !== propertySelectsEspSr16) {
    throw new TypeError('ESP32 esp_sr_16 option does not match the resolved partition layout');
  }
  const espSr16 = optionSelectsEspSr16 || propertySelectsEspSr16;
  return Object.freeze({ manifest, resolved, properties, espSr16 });
}

function validateEsp32ModeledTools(properties: Readonly<Record<string, string>>): void {
  if (properties['tools.esptool_py.cmd'] !== 'esptool') {
    throw new TypeError('ESP32 image recipe tool binding is invalid');
  }
  const partitionTool = strictPropertyTokens(properties, 'tools.gen_esp32part.cmd');
  if (canonicalJson(partitionTool) !== canonicalJson([
    'python3',
    'packs/platform/tools/gen_esp32part.py',
  ])) {
    throw new TypeError('ESP32 partition recipe tool binding is invalid');
  }
}

function requireDirectPatternRecipe(
  recipes: readonly PlatformRecipe[],
  id: string,
  executable: string,
  patternProperty: string,
): void {
  const recipe = requiredRecipe(recipes, id);
  const expected = [executable, `{${patternProperty}}`];
  if (canonicalJson(recipe.argv) !== canonicalJson(expected)) {
    throw new TypeError(`ESP32 ${id} must be a direct modeled tool invocation`);
  }
}

function requirePartitionRecipe(recipes: readonly PlatformRecipe[]): void {
  const recipe = requiredRecipe(recipes, 'recipe.objcopy.partitions.bin');
  const expected = [
    '{tools.gen_esp32part.cmd}',
    '-q',
    '{build.path}/partitions.csv',
    '{build.path}/{build.project_name}.partitions.bin',
  ];
  if (canonicalJson(recipe.argv) !== canonicalJson(expected)) {
    throw new TypeError('ESP32 partition recipe must be exactly -q CSV BIN');
  }
}

function strictPropertyTokens(
  properties: Readonly<Record<string, string>>,
  key: string,
): string[] {
  if (!Object.prototype.hasOwnProperty.call(properties, key)
    || typeof properties[key] !== 'string'
    || !properties[key]!.trim()) {
    throw new TypeError(`ESP32 post-link property is missing: ${key}`);
  }
  return tokenizeRecipe(properties[key]!).map((token) => (
    strictExpandedArgument(properties, token, key).value
  ));
}

function strictExpandedArgument(
  properties: Readonly<Record<string, string>>,
  raw: string,
  label: string,
): ExpandedPlatformRecipeArgument {
  const expanded = expandPlatformProperty(properties, raw);
  if (!expanded.value || expanded.value.includes('\0') || /[{}]/.test(expanded.value)) {
    throw new TypeError(`ESP32 ${label} contains an unresolved or invalid argument: ${raw}`);
  }
  return Object.freeze({ value: expanded.value, dependencies: expanded.dependencies });
}

function requiredFollowingToken(
  tokens: readonly string[],
  index: number,
  option: string,
  label: string,
): string {
  const token = tokens[index];
  if (token === undefined || !token || token.startsWith('-')) {
    throw new TypeError(`${label} ${option} requires one value`);
  }
  return token;
}

function requireOperationCount(count: number, operation: string, label: string): void {
  if (count !== 1) throw new TypeError(`${label} must contain exactly one ${operation}`);
}

function requireOptionSet(
  options: ReadonlyMap<string, string>,
  expected: readonly string[],
  label: string,
): void {
  if (options.size !== expected.length || expected.some((option) => !options.has(option))) {
    throw new TypeError(`${label} does not contain the required option set`);
  }
}

function normalizeEsp32Scalar(value: string, label: string): string {
  if (typeof value !== 'string' || value !== value.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) {
    throw new TypeError(`${label} is invalid: ${String(value)}`);
  }
  return value;
}

function normalizeHexOffset(value: string, label: string): CKHexOffset {
  if (!/^0x[0-9a-f]+$/i.test(value)) throw new TypeError(`${label} is not hexadecimal: ${value}`);
  return `0x${BigInt(value).toString(16)}`;
}

function parseFlashSizeBytes(value: string, label: string): bigint {
  const match = /^(\d+)(B|KB|K|MB|M)$/i.exec(value);
  if (!match) throw new TypeError(`${label} is invalid: ${value}`);
  const amount = BigInt(match[1]!);
  const unit = match[2]!.toUpperCase();
  const multiplier = unit === 'B' ? 1n : unit === 'K' || unit === 'KB' ? 1024n : 1024n * 1024n;
  const bytes = amount * multiplier;
  if (bytes <= 0n) throw new TypeError(`${label} must be positive`);
  return bytes;
}

function normalizeContractPath(value: string, label: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0')) {
    throw new TypeError(`${label} is invalid`);
  }
  const path = value.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('//')) {
    throw new TypeError(`${label} must be a logical relative path: ${value}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError(`${label} contains an invalid path segment: ${value}`);
  }
  return path;
}

function normalizeEsp32Bindings(
  value: CKEsp32PostLinkBindings,
  applicationInput: string,
  boardPack: Readonly<CKPostLinkPackIdentity>,
  espSr16: boolean,
): Readonly<CKEsp32PostLinkBindings> {
  if (!isRecord(value) || !isRecord(value.bootloader) || !isRecord(value.partitions)) {
    throw new TypeError('ESP32 post-link bindings are invalid');
  }
  const application = normalizeActionOutputInput(value.application, 'ESP32 application binding');
  if (application.path !== applicationInput) {
    throw new TypeError('ESP32 application binding does not match the Manifest ELF input');
  }
  if (value.bootloader.source !== 'sdk-elf' && value.bootloader.source !== 'immutable-bin') {
    throw new TypeError('ESP32 bootloader binding source is invalid');
  }
  if (value.partitions.source !== 'csv' && value.partitions.source !== 'immutable-bin') {
    throw new TypeError('ESP32 partitions binding source is invalid');
  }
  const bootloaderInput = normalizeImmutableInput(
    value.bootloader.input,
    'ESP32 bootloader binding',
    boardPack,
    false,
  );
  const partitionInput = normalizeImmutableInput(
    value.partitions.input,
    'ESP32 partitions binding',
    boardPack,
    value.partitions.source === 'csv',
  );
  const bootApp0 = normalizeImmutableInput(
    value.bootApp0,
    'ESP32 boot_app0 binding',
    boardPack,
    false,
  );
  requirePathExtension(
    bootloaderInput.path,
    value.bootloader.source === 'sdk-elf' ? '.elf' : '.bin',
    'ESP32 bootloader binding',
  );
  requirePathExtension(
    partitionInput.path,
    value.partitions.source === 'csv' ? '.csv' : '.bin',
    'ESP32 partitions binding',
  );
  requirePathExtension(bootApp0.path, '.bin', 'ESP32 boot_app0 binding');
  let model: CKEsp32PostLinkModelInput | undefined;
  if (espSr16) {
    if (!value.model) {
      throw new TypeError('ESP32 model binding is required for esp_sr_16');
    }
    const modelInput = normalizeImmutableInput(
      value.model,
      'ESP32 model binding',
      boardPack,
      false,
    );
    if (modelInput.role !== ESP32_ESP_SR_MODEL_ROLE) {
      throw new TypeError('ESP32 model binding role must be model-source');
    }
    if (modelInput.path !== ESP32_ESP_SR_MODEL_PATH
      || modelInput.provenance.kind !== 'pack-artifact'
      || modelInput.provenance.artifactId !== ESP32_ESP_SR_MODEL_ARTIFACT_ID) {
      throw new TypeError('ESP32 esp_sr_16 model binding must use the srmodels Board Pack artifact');
    }
    requirePathExtension(modelInput.path, '.bin', 'ESP32 model binding');
    const modelSize = modelInput.size;
    if (modelSize === undefined) {
      throw new TypeError('ESP32 model binding size is required');
    }
    if (modelSize > Number(ESP32_ESP_SR_MODEL_CAPACITY_BYTES)) {
      throw new TypeError('ESP32 model binding exceeds the esp_sr_16 model capacity');
    }
    model = Object.freeze({ ...modelInput, size: modelSize });
  } else if (value.model !== undefined) {
    throw new TypeError('ESP32 model binding is only valid for esp_sr_16');
  }
  const immutablePaths = [
    bootloaderInput.path,
    partitionInput.path,
    bootApp0.path,
    ...(model === undefined ? [] : [model.path]),
  ];
  if (new Set(immutablePaths).size !== immutablePaths.length) {
    throw new TypeError('ESP32 immutable post-link bindings must use distinct paths');
  }
  return Object.freeze({
    application,
    bootloader: Object.freeze({ source: value.bootloader.source, input: bootloaderInput }),
    partitions: Object.freeze({ source: value.partitions.source, input: partitionInput }),
    bootApp0,
    ...(model === undefined ? {} : { model }),
  });
}

function normalizePostLinkPackIdentity(
  value: CKPostLinkPackIdentity,
): Readonly<CKPostLinkPackIdentity> {
  if (!isRecord(value) || !stablePackIdentity(value.id) || !isSha256(value.sha256)) {
    throw new TypeError('ESP32 post-link Board Pack identity is invalid');
  }
  return Object.freeze({ id: value.id, sha256: value.sha256 });
}

function validatePostLinkPackArtifacts(
  bindings: Readonly<CKEsp32PostLinkBindings>,
  revisionInput: string | undefined,
  boardPack: Readonly<CKPostLinkPackIdentity>,
): void {
  const immutableInputs = [
    bindings.bootloader.input,
    bindings.partitions.input,
    bindings.bootApp0,
    ...(bindings.model === undefined ? [] : [bindings.model]),
  ];
  const artifactInputs = immutableInputs.filter((item) => item.provenance.kind === 'pack-artifact');
  if (!artifactInputs.length) return;
  if (typeof revisionInput !== 'string' || revisionInput.length < 1
    || sha256Hex(revisionInput) !== boardPack.sha256) {
    throw new TypeError('ESP32 post-link Board Pack revision input is invalid');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(revisionInput);
  } catch {
    throw new TypeError('ESP32 post-link Board Pack revision input is invalid');
  }
  if (!isRecord(manifest) || manifest.schema !== 2
    || manifest.id !== boardPack.id
    || typeof manifest.version !== 'string' || manifest.version.length < 1
    || !Array.isArray(manifest.artifacts)) {
    throw new TypeError('ESP32 post-link Board Pack Manifest identity is invalid');
  }
  const artifactIds = new Set<string>();
  for (const candidate of manifest.artifacts) {
    if (!isRecord(candidate) || !stablePackIdentity(candidate.id)
      || artifactIds.has(candidate.id)
      || typeof candidate.kind !== 'string' || candidate.kind.length < 1
      || typeof candidate.size !== 'number' || !Number.isSafeInteger(candidate.size)
      || candidate.size < 1 || !isSha256(candidate.sha256)) {
      throw new TypeError('ESP32 post-link Board Pack Manifest artifacts are invalid');
    }
    artifactIds.add(candidate.id);
  }
  for (const input of artifactInputs) {
    const provenance = input.provenance;
    if (provenance.kind !== 'pack-artifact'
      || provenance.packId !== boardPack.id
      || provenance.packSha256 !== boardPack.sha256
      || provenance.packSchema !== manifest.schema) {
      throw new TypeError(`ESP32 post-link Board Pack artifact schema is invalid: ${input.role}`);
    }
    const matches = manifest.artifacts.filter((artifact) => artifact?.id === provenance.artifactId);
    const artifact = matches[0];
    if (matches.length !== 1 || !isRecord(artifact) || artifact.kind !== 'bin'
      || artifact.sha256 !== input.sha256
      || (input.size !== undefined && artifact.size !== input.size)) {
      throw new TypeError(`ESP32 post-link Board Pack artifact is invalid: ${input.role}`);
    }
  }
}

function normalizeActionOutputInput(
  value: CKPostLinkActionOutputInput,
  label: string,
): Readonly<CKPostLinkActionOutputInput> {
  if (!isRecord(value) || value.kind !== 'action-output'
    || typeof value.actionId !== 'string' || !/^[a-z][a-z0-9._-]*$/.test(value.actionId)
    || typeof value.role !== 'string' || !/^[a-z][a-z0-9._-]*$/.test(value.role)) {
    throw new TypeError(`${label} is invalid`);
  }
  return Object.freeze({
    kind: 'action-output',
    actionId: value.actionId,
    path: normalizeContractPath(value.path, `${label} path`),
    role: value.role,
  });
}

function normalizeImmutableInput(
  value: CKPostLinkImmutableInput,
  label: string,
  boardPack: Readonly<CKPostLinkPackIdentity>,
  allowProjectFile: boolean,
): Readonly<CKPostLinkImmutableInput> {
  if (!isRecord(value) || value.kind !== 'immutable' || !isSha256(value.sha256)
    || typeof value.role !== 'string' || !/^[a-z][a-z0-9._-]*$/.test(value.role)
    || !isRecord(value.provenance)) {
    throw new TypeError(`${label} is invalid`);
  }
  const size = normalizeImmutableSize(value.size, label);
  const path = normalizeContractPath(value.path, `${label} path`);
  const provenance = normalizeImmutableProvenance(
    value.provenance,
    label,
    boardPack,
    path,
    value.sha256,
    allowProjectFile,
  );
  return Object.freeze({
    kind: 'immutable',
    path,
    role: value.role,
    sha256: value.sha256,
    ...(size === undefined ? {} : { size }),
    provenance,
  });
}

function normalizeImmutableSize(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} size is invalid`);
  }
  return value;
}

function normalizeImmutableProvenance(
  value: CKPostLinkImmutableProvenance,
  label: string,
  boardPack: Readonly<CKPostLinkPackIdentity>,
  inputPath: string,
  inputSha256: Sha256,
  allowProjectFile: boolean,
): CKPostLinkImmutableProvenance {
  if (!isRecord(value)) {
    throw new TypeError(`${label} provenance is invalid`);
  }
  if (value.kind === 'project-file') {
    if (!allowProjectFile
      || value.path !== 'partitions.csv'
      || inputPath !== value.path
      || !isSha256(value.projectSha256)
      || !isSha256(value.fileSha256)
      || value.fileSha256 !== inputSha256) {
      throw new TypeError(`${label} project-file provenance is invalid`);
    }
    return Object.freeze({
      kind: 'project-file',
      path: value.path,
      projectSha256: value.projectSha256,
      fileSha256: value.fileSha256,
    });
  }
  if (!stablePackIdentity(value.packId) || !isSha256(value.packSha256)) {
    throw new TypeError(`${label} provenance is invalid`);
  }
  if (value.packId !== boardPack.id || value.packSha256 !== boardPack.sha256) {
    throw new TypeError(`${label} provenance does not match the selected Board Pack`);
  }
  if (value.kind === 'pack-artifact') {
    if (!Number.isSafeInteger(value.packSchema) || value.packSchema < 1
      || !stablePackIdentity(value.artifactId)) {
      throw new TypeError(`${label} artifact provenance is invalid`);
    }
    return Object.freeze({
      kind: 'pack-artifact',
      packId: value.packId,
      packSha256: value.packSha256,
      packSchema: value.packSchema,
      artifactId: value.artifactId,
    });
  }
  if (value.kind === 'pack-file' && stablePackIdentity(value.selector)) {
    return Object.freeze({
      kind: 'pack-file',
      packId: value.packId,
      packSha256: value.packSha256,
      selector: value.selector,
    });
  }
  throw new TypeError(`${label} file provenance is invalid`);
}

function stablePackIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/.test(value);
}

function requirePathExtension(path: string, extension: string, label: string): void {
  if (!path.toLowerCase().endsWith(extension)) {
    throw new TypeError(`${label} must reference a ${extension} input`);
  }
}

function requiredProductOffset(
  offsets: ReadonlyMap<Esp32FlashProductId, CKHexOffset>,
  productId: Esp32FlashProductId,
): CKHexOffset {
  const offset = offsets.get(productId);
  if (!offset) throw new TypeError(`ESP32 post-link offset is missing: ${productId}`);
  return offset;
}

function freezeProduct(
  value: CKEsp32PostLinkProduct,
): Readonly<CKEsp32PostLinkProduct> {
  return Object.freeze(value);
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deriveArchiveRecipe(
  recipes: readonly PlatformRecipe[],
  lowering: CKPlatformRecipeLowering,
  properties: Readonly<Record<string, string>>,
): Readonly<DerivedPlatformArchiveCommand> {
  const recipe = requiredRecipe(recipes, lowering.bindings.archive);
  const expanded = expandRecipeArguments(recipe, properties);
  const executable = expanded[0]!;
  if (!hasPlatformPropertyDependency(executable, 'compiler.ar.cmd')
    && !/(?:^|[\\/-])(?:gcc-)?ar(?:\.exe)?$/i.test(executable.value)) {
    throw new TypeError('Platform archive recipe executable is not bound to compiler.ar.cmd');
  }

  const argumentsList = expanded.slice(1);
  const operation = argumentsList.filter((argument) => (
    (argument.value === 'cr' || argument.value === lowering.archive.operation)
      && (hasPlatformPropertyDependency(argument, 'compiler.ar.flags')
        || argument.dependencies.size === 0)
  ));
  const output = argumentsList.filter((argument) => (
    hasPlatformPropertyDependency(argument, 'archive_file_path')
  ));
  const inputs = argumentsList.filter((argument) => (
    hasPlatformPropertyDependency(argument, 'object_file')
  ));
  if (operation.length !== 1) {
    throw new TypeError('Platform archive recipe must contain exactly one cr or rcs operation');
  }
  if (output.length !== 1 || inputs.length !== 1) {
    throw new TypeError('Platform archive recipe must contain exactly one output and object input');
  }

  const structural = new Set([operation[0], output[0], inputs[0]]);
  const flags: string[] = [];
  for (const argument of argumentsList) {
    if (structural.has(argument)) continue;
    if (!hasPlatformPropertyDependency(argument, 'compiler.ar.extra_flags')) {
      throw new TypeError(`Platform archive recipe contains an unmodeled argument: ${argument.value}`);
    }
    flags.push(argument.value);
  }
  return Object.freeze({
    recipeId: lowering.bindings.archive,
    command: lowering.archive.command,
    operation: lowering.archive.operation,
    argumentOrder: Object.freeze([
      'operation', 'output', 'inputs', 'flags',
    ] as const),
    flags: Object.freeze(flags),
  });
}

function deriveLanguageCompileRecipes(
  recipes: readonly PlatformRecipe[],
  lowering: CKPlatformRecipeLowering,
  properties: Readonly<Record<string, string>>,
): DerivedPlatformRecipeCommands['compile'] {
  const languages = ['c', 'cxx', 'asm'] as const;
  const dependencyKeys: Record<PlatformCompileLanguage, Readonly<{
    command: string;
    flags: string;
    extraFlags: string;
  }>> = {
    c: { command: 'compiler.c.cmd', flags: 'compiler.c.flags', extraFlags: 'compiler.c.extra_flags' },
    cxx: { command: 'compiler.cpp.cmd', flags: 'compiler.cpp.flags', extraFlags: 'compiler.cpp.extra_flags' },
    // Arduino assembly recipes use the C driver but own separate flags.
    asm: { command: 'compiler.c.cmd', flags: 'compiler.S.flags', extraFlags: 'compiler.S.extra_flags' },
  };
  const expanded = Object.fromEntries(languages.map((language) => [
    language,
    expandRecipeArguments(
      requiredRecipe(recipes, lowering.bindings.compile[language]),
      properties,
    ),
  ])) as Record<PlatformCompileLanguage, ExpandedPlatformRecipeArgument[]>;
  const common = {} as Record<PlatformCompileLanguage, ExpandedPlatformRecipeArgument[]>;
  const languageFlags = {} as Record<PlatformCompileLanguage, string[]>;

  for (const language of languages) {
    const command = expanded[language];
    const keys = dependencyKeys[language];
    const languageDependencies = [keys.command, keys.flags, keys.extraFlags];
    if (!command.length || !hasPlatformPropertyDependency(command[0]!, keys.command)) {
      throw new TypeError(
        `Platform ${language} compile recipe executable is not bound to ${keys.command}`,
      );
    }
    if (command.filter((argument) => argument.value === '-c').length !== 1) {
      throw new TypeError(
        `Platform ${language} compile recipe must contain exactly one structural -c`,
      );
    }
    common[language] = [];
    languageFlags[language] = [];
    for (let index = 1; index < command.length; index += 1) {
      const argument = command[index]!;
      if (argument.value === '-c') continue;
      const languageSpecific = languageDependencies.some((dependency) => (
        hasPlatformPropertyDependency(argument, dependency)
      ));
      if (hasPlatformPropertyDependency(argument, keys.command)) {
        throw new TypeError(
          `Platform ${language} compile recipe contains an unmodeled executable argument`,
        );
      }
      if (languageSpecific) languageFlags[language].push(argument.value);
      else common[language].push(argument);
    }

    const marker = lowering.responseFiles.marker;
    const filename = lowering.responseFiles.languageFiles[language];
    const responseMatches = languageFlags[language].filter((argument) => {
      if (!argument.startsWith(marker)) return false;
      const path = argument.slice(marker.length);
      return path === filename || path.endsWith(`/${filename}`);
    });
    if (responseMatches.length !== 1) {
      throw new TypeError(
        `Platform ${language} compile recipe must contain exactly one ${filename} response file`,
      );
    }
  }

  const commonSignature = (argumentsList: readonly ExpandedPlatformRecipeArgument[]): string => (
    canonicalJson(argumentsList.map((argument) => ({
      value: argument.value,
      dependencies: [...argument.dependencies].sort(),
    })))
  );
  const expected = commonSignature(common.cxx);
  for (const language of ['c', 'asm'] as const) {
    if (commonSignature(common[language]) !== expected) {
      throw new TypeError(
        `Platform ${language} and cxx compile recipes contain unmodeled common argv differences`,
      );
    }
  }

  return Object.freeze({
    common: Object.freeze(common.cxx),
    languageFlags: freezeCompileLanguageFlags(languageFlags),
  });
}

function expandRecipeArguments(
  recipe: PlatformRecipe,
  properties: Readonly<Record<string, string>>,
): ExpandedPlatformRecipeArgument[] {
  const result: ExpandedPlatformRecipeArgument[] = [];
  for (const raw of recipe.argv) {
    const expanded = expandPlatformProperty(properties, raw);
    if (!expanded.value.trim()) continue;
    for (const rawValue of tokenizeRecipe(expanded.value)) {
      const value = normalizeArduinoRecipeArgument(rawValue);
      if (value === '@' || /\{[^{}]+\}/.test(value)) continue;
      result.push(Object.freeze({ value, dependencies: expanded.dependencies }));
    }
  }
  if (!result.length) {
    throw new TypeError(`Platform recipe ${recipe.id} expands to an empty command`);
  }
  return result;
}

function normalizeArduinoRecipeArgument(value: string): string {
  for (const prefix of ['-DARDUINO_BOARD=', '-DARDUINO_VARIANT=']) {
    if (value.startsWith(prefix) && !value.startsWith(`${prefix}"`)) {
      return `${prefix}"${value.slice(prefix.length)}"`;
    }
  }
  return value;
}

function validateRecipeCommandInput(
  input: DerivePlatformRecipeCommandsInput,
): CKPlatformRecipeLowering {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !Array.isArray(input.recipes) || !input.properties
    || typeof input.properties !== 'object' || Array.isArray(input.properties)) {
    throw new TypeError('Platform recipe command input is invalid');
  }
  return requireRecipeLoweringV2(input.recipeLowering);
}

function requiredRecipe(recipes: readonly PlatformRecipe[], id: string): PlatformRecipe {
  const matches = recipes.filter((recipe) => recipe.id === id);
  if (matches.length !== 1) {
    throw new TypeError(`CK Platform Manifest must contain exactly one ${id} recipe`);
  }
  return matches[0]!;
}

function requireRecipeLoweringV2(value: unknown): CKPlatformRecipeLowering {
  const candidate = value as Partial<CKPlatformRecipeLowering> | undefined;
  const compile = candidate?.bindings?.compile;
  if (candidate?.schemaVersion !== CK_RECIPE_LOWERING_SCHEMA_VERSION
    || !compile || typeof compile !== 'object' || Array.isArray(compile)
    || (['c', 'cxx', 'asm'] as const).some((language) => (
      typeof compile[language] !== 'string' || !compile[language]!.trim()
    ))
    || typeof candidate.bindings?.archive !== 'string' || !candidate.bindings.archive.trim()
    || typeof candidate.bindings?.link !== 'string' || !candidate.bindings.link.trim()
    || candidate.archive?.command !== 'ar'
    || candidate.archive.operation !== 'rcs'
    || canonicalJson(candidate.archive.argumentOrder) !== canonicalJson([
      'operation', 'output', 'inputs', 'flags',
    ])) {
    throw new TypeError('Platform recipe command lowering requires schema 2 bindings');
  }
  return candidate as CKPlatformRecipeLowering;
}

function freezeCompileLanguageFlags(
  value: Record<PlatformCompileLanguage, string[]>,
): Readonly<Record<PlatformCompileLanguage, readonly string[]>> {
  const normalized = Object.fromEntries((['c', 'cxx', 'asm'] as const).map((language) => {
    const flags = value[language];
    if (!Array.isArray(flags) || !flags.length
      || flags.some((flag) => typeof flag !== 'string' || !flag)) {
      throw new TypeError(`Platform ${language} compile language flags are invalid`);
    }
    return [language, Object.freeze([...flags])];
  })) as Record<PlatformCompileLanguage, readonly string[]>;
  return Object.freeze(normalized);
}
