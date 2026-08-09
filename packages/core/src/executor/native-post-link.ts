import { sha256Hex } from '../build-ir/canonical.js';
import type { BuildAction, TransformAction } from '../build-ir/types.js';
import type { NativeActionRunnerContext, NativeActionRunnerResult } from './native.js';

const CONTRACT_PREFIX = '--ck-post-link-contract=';
const SHA256 = /^[a-f0-9]{64}$/;
const HEX_OFFSET = /^0x[0-9a-f]+$/i;
const SAFE_VALUE = /^[A-Za-z0-9._+]+$/;
const RESERVED_TOOLS = new Set([
  'toolchain:esptool',
  'platform:gen-esp32part',
  'ck:copy',
]);

type ProductId = 'application' | 'bootloader' | 'partitions' | 'boot-app0' | 'model' | 'merged';

const MODEL_COPY_FORMAT = 'model' as const;
const MODEL_PRODUCT_ID = 'model' as const;
const MODEL_SOURCE_ROLE = 'model-source' as const;
const MODEL_IMAGE_ROLE = 'model-image' as const;
const MODEL_OUTPUT = 'build/srmodels.bin';
const ESP_SR_FLASH_CAPACITY = 0x1000000n;
const ESP_SR_MODEL_OFFSET = 0xd10000n;
const ESP_SR_MODEL_CAPACITY = 0x2f0000n;

interface MergeSegment {
  offset: string;
  offsetBytes: bigint;
  path: string;
}

interface ParsedMerge {
  chip: string;
  output: string;
  padToSize: string;
  capacityBytes: bigint;
  segmentCount: 4 | 5;
  segments: MergeSegment[];
}

/**
 * Fail closed on the logical tools reserved for ESP32 post-link work. The
 * Manifest contributes only data to the contract; these are the only native
 * process shapes that may be reached through the reserved tool ids.
 */
export function validateNativePostLinkActions(actions: readonly BuildAction[]): string | null {
  const reserved = actions.filter((action) => RESERVED_TOOLS.has(action.tool));
  if (!reserved.length) return null;

  let contractFlag: string | undefined;
  let contractMode = false;
  for (const action of reserved) {
    if (action.kind !== 'transform') {
      return `reserved post-link tool requires a transform Action: ${action.id}`;
    }
    if (Object.keys(action.environment).length !== 0) {
      return `reserved post-link Action must not define an environment: ${action.id}`;
    }
    const markers = action.transform.flags.filter((flag) => flag.startsWith(CONTRACT_PREFIX));
    if (markers.length > 1) return `post-link contract flag is duplicated: ${action.id}`;
    if (markers.length === 1) {
      contractMode = true;
      const marker = markers[0]!;
      if (!SHA256.test(marker.slice(CONTRACT_PREFIX.length))) {
        return `post-link contract flag is invalid: ${action.id}`;
      }
      if (contractFlag !== undefined && marker !== contractFlag) {
        return `post-link contract identity differs between Actions: ${action.id}`;
      }
      contractFlag = marker;
    }
  }

  contractMode ||= reserved.some((action) => (
    action.outputs.some((output) => (
      output.kind === 'application' || output.kind === 'partitions'
      || output.kind === MODEL_PRODUCT_ID || output.kind === 'merged'
    ))
  ));
  if (contractMode && contractFlag === undefined) {
    return 'post-link contract flag is missing from the stable product graph';
  }

  if (contractMode) {
    for (const action of reserved) {
      if (action.kind !== 'transform') continue;
      if (!action.transform.flags.includes(contractFlag!)) {
        return `post-link contract flag is missing: ${action.id}`;
      }
    }
  }

  for (const action of reserved) {
    if (action.kind !== 'transform') continue;
    const error = validateReservedOperation(action, contractMode ? contractFlag : undefined);
    if (error) return error;
  }

  return contractMode
    ? validateContractGraph(actions, reserved as TransformAction[])
    : null;
}

/** Execute CK-owned byte materialization without invoking a host command. */
export function runNativeInternalAction(
  context: NativeActionRunnerContext,
): NativeActionRunnerResult | undefined {
  const { action } = context;
  if (action.tool !== 'ck:copy') return undefined;
  if (action.kind !== 'transform' || action.inputs.length !== 1 || action.outputs.length !== 1) {
    return { ok: false, message: `invalid copy Action: ${action.id}` };
  }
  const bytes = context.readFile(action.transform.input);
  if (isModelCopyFormat(action)) {
    const input = action.inputs[0]!;
    const output = action.outputs[0]!;
    if (input.role !== MODEL_SOURCE_ROLE || output.kind !== MODEL_PRODUCT_ID) {
      return { ok: false, message: `model copy provenance is invalid: ${action.id}` };
    }
    if (bytes.byteLength === 0 || BigInt(bytes.byteLength) > ESP_SR_MODEL_CAPACITY) {
      return { ok: false, message: `model copy exceeds its flash capacity: ${action.id}` };
    }
  }
  return {
    outputs: [{
      path: action.transform.output,
      bytes,
      sha256: sha256Hex(bytes),
    }],
  };
}

function validateReservedOperation(
  action: TransformAction,
  contractFlag: string | undefined,
): string | null {
  if (action.outputs.length !== 1 || action.transform.output !== action.outputs[0]!.path) {
    return `post-link Action must declare exactly its transform output: ${action.id}`;
  }
  if (action.tool === 'ck:copy') return validateCopy(action, contractFlag);
  if (action.tool === 'platform:gen-esp32part') return validatePartition(action, contractFlag);
  if (action.arguments[2] === 'elf2image') return validateElf2Image(action, contractFlag);
  if (action.arguments[2] === 'merge-bin') return validateMerge(action, contractFlag);
  return `unsupported esptool post-link operation: ${action.id}`;
}

function validateCopy(action: TransformAction, contractFlag: string | undefined): string | null {
  const format = action.transform.format as string;
  const modelCopy = isModelCopyFormat(action);
  if (!['bootloader', 'partition', 'boot-app0'].includes(format) && !modelCopy) {
    return `copy Action has an unsupported transform format: ${action.id}`;
  }
  const ioError = validateSingleInput(action, true);
  if (ioError) return ioError;
  if (format === MODEL_COPY_FORMAT && action.outputs[0]?.kind !== MODEL_PRODUCT_ID) {
    return `model copy output format is invalid: ${action.id}`;
  }
  if (modelCopy && action.inputs[0]!.role !== MODEL_SOURCE_ROLE) {
    return `model copy input provenance is invalid: ${action.id}`;
  }
  if (!sameStrings(action.arguments, [
    action.transform.input,
    '-o',
    action.transform.output,
  ])) return `copy Action arguments do not match its declared input/output: ${action.id}`;
  if (contractFlag && !sameStrings(action.transform.flags, [contractFlag])) {
    return `copy Action flags do not match the post-link contract: ${action.id}`;
  }
  return null;
}

function validatePartition(action: TransformAction, contractFlag: string | undefined): string | null {
  if (action.transform.format !== 'partition') {
    return `partition Action has an unsupported transform format: ${action.id}`;
  }
  const ioError = validateSingleInput(action, true);
  if (ioError) return ioError;
  if (!sameStrings(action.arguments, [
    '-q',
    action.transform.input,
    action.transform.output,
  ])) return `partition Action arguments do not match its declared input/output: ${action.id}`;
  if (contractFlag && !sameStrings(action.transform.flags, ['--quiet=true', contractFlag])) {
    return `partition Action flags do not match the post-link contract: ${action.id}`;
  }
  if (action.transform.input === 'partitions.csv'
    && (!action.outputs[0]!.sha256 || !SHA256.test(action.outputs[0]!.sha256))) {
    return `project partition Action output hash is missing: ${action.id}`;
  }
  return null;
}

function validateElf2Image(action: TransformAction, contractFlag: string | undefined): string | null {
  if (!['bin', 'bootloader'].includes(action.transform.format)) {
    return `elf2image Action has an unsupported transform format: ${action.id}`;
  }
  const immutable = action.transform.format === 'bootloader';
  const ioError = validateSingleInput(action, contractFlag !== undefined && immutable);
  if (ioError) return ioError;

  const args = action.arguments;
  if (args[0] !== '--chip' || !safeValue(args[1]) || args[2] !== 'elf2image'
    || args[3] !== '--flash-mode' || !safeValue(args[4])
    || args[5] !== '--flash-freq' || !safeValue(args[6])
    || args[7] !== '--flash-size' || !safeValue(args[8])) {
    return `elf2image Action arguments are invalid: ${action.id}`;
  }
  let cursor = 9;
  let elfSha256Offset: string | undefined;
  if (args[cursor] === '--elf-sha256-offset') {
    elfSha256Offset = args[cursor + 1];
    if (!elfSha256Offset || !HEX_OFFSET.test(elfSha256Offset)) {
      return `elf2image SHA offset is invalid: ${action.id}`;
    }
    cursor += 2;
  }
  if (!sameStrings(args.slice(cursor), [
    '-o',
    action.transform.output,
    action.transform.input,
  ])) return `elf2image Action paths do not match its declared input/output: ${action.id}`;

  if (contractFlag) {
    const expectedFlags = [
      `--chip=${args[1]}`,
      `--flash-mode=${args[4]}`,
      `--flash-freq=${args[6]}`,
      `--flash-size=${args[8]}`,
      ...(elfSha256Offset ? [`--elf-sha256-offset=${elfSha256Offset}`] : []),
      contractFlag,
    ];
    if (!sameStrings(action.transform.flags, expectedFlags)) {
      return `elf2image Action flags do not match its arguments: ${action.id}`;
    }
  }
  return null;
}

function validateMerge(action: TransformAction, contractFlag: string | undefined): string | null {
  if (action.transform.format !== 'bin') {
    return `merge-bin Action has an unsupported transform format: ${action.id}`;
  }
  const parsed = parseMerge(action);
  if (typeof parsed === 'string') return parsed;
  if (parsed.segmentCount === 5 && contractFlag === undefined) {
    return `five-segment merge-bin Action requires the stable ESP-SR contract: ${action.id}`;
  }
  if (contractFlag) {
    const expectedFlags = [
      `--chip=${parsed.chip}`,
      `--pad-to-size=${parsed.padToSize}`,
      '--flash-mode=keep',
      '--flash-freq=keep',
      '--flash-size=keep',
      contractFlag,
    ];
    if (!sameStrings(action.transform.flags, expectedFlags)) {
      return `merge-bin Action flags do not match its arguments: ${action.id}`;
    }
  }
  return null;
}

function parseMerge(action: TransformAction): ParsedMerge | string {
  const args = action.arguments;
  if (args[0] !== '--chip' || !safeValue(args[1]) || args[2] !== 'merge-bin'
    || args[3] !== '-o' || args[4] !== action.transform.output
    || args[5] !== '--pad-to-size' || !safeValue(args[6])
    || args[7] !== '--flash-mode' || args[8] !== 'keep'
    || args[9] !== '--flash-freq' || args[10] !== 'keep'
    || args[11] !== '--flash-size' || args[12] !== 'keep') {
    return `merge-bin Action arguments are invalid: ${action.id}`;
  }
  const tail = args.slice(13);
  const isFourSegment = tail.length === 8 && action.inputs.length === 4;
  const isFiveSegment = tail.length === 10 && action.inputs.length === 5;
  if (!isFourSegment && !isFiveSegment) {
    return tail.length <= 8 && action.inputs.length <= 4
      ? `merge-bin Action must declare exactly four segments: ${action.id}`
      : `merge-bin Action must declare exactly four or five segments: ${action.id}`;
  }
  const capacityBytes = parseFlashCapacity(args[6]!);
  if (capacityBytes === null) {
    return `merge-bin pad-to-size is invalid: ${action.id}`;
  }
  const segmentCount: 4 | 5 = isFiveSegment ? 5 : 4;
  const segments: MergeSegment[] = [];
  const seenOffsets = new Set<string>();
  const seenPaths = new Set<string>();
  for (let index = 0; index < tail.length; index += 2) {
    const offset = tail[index]!;
    const path = tail[index + 1]!;
    if (!HEX_OFFSET.test(offset)) return `merge-bin segment offset is invalid: ${action.id}`;
    const normalizedOffset = canonicalOffset(offset);
    if (normalizedOffset === null) return `merge-bin segment offset is out of range: ${action.id}`;
    const offsetBytes = BigInt(normalizedOffset);
    if (offsetBytes >= capacityBytes) {
      return `merge-bin segment offset is outside the flash image: ${action.id}`;
    }
    if (seenOffsets.has(normalizedOffset)) return `merge-bin segment offset is duplicated: ${action.id}`;
    if (seenPaths.has(path)) return `merge-bin segment input is duplicated: ${action.id}`;
    if (!path || path === action.transform.output) {
      return `merge-bin segment input is invalid: ${action.id}`;
    }
    seenOffsets.add(normalizedOffset);
    seenPaths.add(path);
    segments.push({ offset: normalizedOffset, offsetBytes, path });
  }
  const declaredPaths = new Set(action.inputs.map((input) => input.path));
  if (declaredPaths.size !== segmentCount || seenPaths.size !== segmentCount
    || [...seenPaths].some((path) => !declaredPaths.has(path))) {
    return `merge-bin segments do not match the declared inputs: ${action.id}`;
  }
  if (action.transform.input !== segments[0]!.path) {
    return `merge-bin primary input does not match its first segment: ${action.id}`;
  }
  return {
    chip: args[1]!,
    output: args[4]!,
    padToSize: args[6]!,
    capacityBytes,
    segmentCount,
    segments,
  };
}

function validateContractGraph(
  actions: readonly BuildAction[],
  reserved: readonly TransformAction[],
): string | null {
  const expected: Record<ProductId, {
    id: string;
    output: string;
    format: TransformAction['transform']['format'] | typeof MODEL_COPY_FORMAT;
    tools: readonly string[];
  }> = {
    application: {
      id: 'transform-application', output: 'build/firmware.bin', format: 'bin',
      tools: ['toolchain:esptool'],
    },
    bootloader: {
      id: 'transform-bootloader', output: 'build/bootloader.bin', format: 'bootloader',
      tools: ['toolchain:esptool', 'ck:copy'],
    },
    partitions: {
      id: 'transform-partitions', output: 'build/partitions.bin', format: 'partition',
      tools: ['platform:gen-esp32part', 'ck:copy'],
    },
    'boot-app0': {
      id: 'transform-boot-app0', output: 'build/boot_app0.bin', format: 'boot-app0',
      tools: ['ck:copy'],
    },
    model: {
      id: 'transform-model', output: MODEL_OUTPUT, format: 'bin',
      tools: ['ck:copy'],
    },
    merged: {
      id: 'transform-merged', output: 'build/firmware.merged.bin', format: 'bin',
      tools: ['toolchain:esptool'],
    },
  };
  const byProduct = new Map<string, TransformAction>();
  for (const action of reserved) {
    const productId = action.outputs[0]?.kind;
    if (!productId || byProduct.has(productId)) {
      return `post-link product identity is missing or duplicated: ${action.id}`;
    }
    byProduct.set(productId, action);
  }
  const fullProducts: ProductId[] = ['application', 'bootloader', 'partitions', 'boot-app0', 'merged'];
  const espSrFullProducts: ProductId[] = [
    'application', 'bootloader', 'partitions', 'boot-app0', 'model', 'merged',
  ];
  const staticProducts: ProductId[] = ['bootloader', 'partitions', 'boot-app0'];
  const espSrStaticProducts: ProductId[] = ['bootloader', 'partitions', 'boot-app0', 'model'];
  const presentProducts = [...byProduct.keys()].sort(compareText);
  const fullGraph = sameStrings(presentProducts, [...fullProducts].sort(compareText));
  const espSrFullGraph = sameStrings(presentProducts, [...espSrFullProducts].sort(compareText));
  const staticGraph = sameStrings(presentProducts, [...staticProducts].sort(compareText));
  const espSrStaticGraph = sameStrings(
    presentProducts,
    [...espSrStaticProducts].sort(compareText),
  );
  if ((!fullGraph && !espSrFullGraph && !staticGraph && !espSrStaticGraph)
    || reserved.length !== byProduct.size) {
    return 'post-link contract must contain the complete graph or its strict static-product subset';
  }
  const graphProducts = fullGraph
    ? fullProducts
    : espSrFullGraph
      ? espSrFullProducts
      : staticGraph
        ? staticProducts
        : espSrStaticProducts;
  const espSrGraph = espSrFullGraph || espSrStaticGraph;
  for (const productId of graphProducts) {
    const action = byProduct.get(productId);
    const shape = expected[productId];
    if (!action) return `post-link product mapping is invalid: ${productId}`;
    const formatMatches = productId === MODEL_PRODUCT_ID
      ? isModelCopyFormat(action)
      : action.transform.format === shape.format;
    if (action.id !== shape.id || action.transform.output !== shape.output
      || !formatMatches || !shape.tools.includes(action.tool)) {
      return `post-link product mapping is invalid: ${productId}`;
    }
  }

  const bootloader = byProduct.get('bootloader')!;
  const partitions = byProduct.get('partitions')!;
  const bootApp0 = byProduct.get('boot-app0')!;
  const immutableInputs: Array<[TransformAction, string]> = [
    [bootloader, 'bootloader-source'],
    [partitions, 'partitions-source'],
    [bootApp0, 'boot-app0-source'],
  ];
  const model = byProduct.get(MODEL_PRODUCT_ID);
  if (espSrGraph && model) immutableInputs.push([model, MODEL_SOURCE_ROLE]);
  for (const [action, role] of immutableInputs) {
    const input = action.inputs[0];
    if (!input || input.role !== role || !input.sha256 || !SHA256.test(input.sha256)) {
      return `post-link immutable input provenance is invalid: ${action.id}`;
    }
  }
  if (staticGraph || espSrStaticGraph) return null;

  const application = byProduct.get('application')!;
  const merged = byProduct.get('merged')!;
  if (application.inputs[0]?.path !== 'build/firmware.elf'
    || application.inputs[0]?.role !== 'linked-elf'
    || application.inputs[0]?.sha256 !== undefined) {
    return 'application image input does not match the linked ELF contract';
  }
  const producer = actions.find((action) => (
    action.outputs.some((output) => output.path === application.inputs[0]!.path)
  ));
  if (!producer || !application.dependencies.includes(producer.id)) {
    return 'application image does not depend on its linked ELF producer';
  }

  const parsed = parseMerge(merged);
  if (typeof parsed === 'string') return parsed;
  const sourceProducts = [
    application,
    bootloader,
    partitions,
    bootApp0,
    ...(espSrGraph ? [model!] : []),
  ];
  if (parsed.segmentCount !== sourceProducts.length) {
    return `merge-bin segment count does not match the post-link product graph`;
  }
  const expectedDependencies = sourceProducts.map((action) => action.id).sort(compareText);
  if (!sameStrings([...merged.dependencies].sort(compareText), expectedDependencies)) {
    return `merge-bin dependencies do not cover all ${sourceProducts.length} source products`;
  }
  const expectedByPath = new Map(sourceProducts.map((action) => [
    action.transform.output,
    `${action.outputs[0]!.kind}-image`,
  ]));
  for (const input of merged.inputs) {
    const expectedRole = expectedByPath.get(input.path);
    if (!expectedRole || expectedRole !== input.role || input.sha256 !== undefined) {
      return `merge-bin input provenance is invalid: ${input.path}`;
    }
  }
  const roleByPath = new Map(merged.inputs.map((input) => [input.path, input.role]));
  const requiredOffsets = new Map<string, string>([
    ['application-image', '0x10000'],
    ['partitions-image', '0x8000'],
    ['boot-app0-image', '0xe000'],
  ]);
  if (espSrGraph) requiredOffsets.set(MODEL_IMAGE_ROLE, '0xd10000');
  for (const segment of parsed.segments) {
    const role = roleByPath.get(segment.path);
    const required = role && requiredOffsets.get(role);
    if (required && segment.offset !== required) {
      return `merge-bin offset does not match ${role}`;
    }
    if (role === 'bootloader-image' && !['0x0', '0x1000'].includes(segment.offset)) {
      return 'merge-bin bootloader offset is invalid';
    }
  }
  const layoutError = validateEspSrMergeLayout(parsed, roleByPath, espSrGraph);
  if (layoutError) return layoutError;
  return null;
}

function validateEspSrMergeLayout(
  parsed: ParsedMerge,
  roleByPath: ReadonlyMap<string, string | undefined>,
  espSrGraph: boolean,
): string | null {
  if (!espSrGraph) return null;
  if (parsed.segmentCount !== 5 || parsed.capacityBytes !== ESP_SR_FLASH_CAPACITY) {
    return 'ESP-SR merge must target a 16MB flash image with five segments';
  }
  const model = parsed.segments.find((segment) => roleByPath.get(segment.path) === MODEL_IMAGE_ROLE);
  if (!model) return 'ESP-SR merge is missing the model segment';
  if (model.offsetBytes !== ESP_SR_MODEL_OFFSET) {
    return 'ESP-SR model offset does not match the reserved flash layout';
  }
  const modelEnd = ESP_SR_MODEL_OFFSET + ESP_SR_MODEL_CAPACITY;
  if (modelEnd > parsed.capacityBytes) {
    return 'ESP-SR model allocation exceeds the flash image';
  }
  for (const segment of parsed.segments) {
    if (segment === model) continue;
    if (segment.offsetBytes >= ESP_SR_MODEL_OFFSET && segment.offsetBytes < modelEnd) {
      return 'ESP-SR model allocation overlaps another merge segment';
    }
  }
  return null;
}

function validateSingleInput(action: TransformAction, requireSha256: boolean): string | null {
  if (action.inputs.length !== 1 || action.transform.input !== action.inputs[0]!.path) {
    return `post-link Action must declare exactly its transform input: ${action.id}`;
  }
  if (requireSha256 && (!action.inputs[0]!.sha256 || !SHA256.test(action.inputs[0]!.sha256))) {
    return `post-link Action immutable input hash is missing: ${action.id}`;
  }
  return null;
}

function isModelCopyFormat(action: TransformAction): boolean {
  const format = action.transform.format as string;
  return action.outputs[0]?.kind === MODEL_PRODUCT_ID
    && (format === 'bin' || format === MODEL_COPY_FORMAT);
}

function safeValue(value: string | undefined): value is string {
  return value !== undefined && SAFE_VALUE.test(value);
}

function canonicalOffset(value: string): string | null {
  const parsed = Number.parseInt(value.slice(2), 16);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffff_ffff
    ? `0x${parsed.toString(16)}`
    : null;
}

function parseFlashCapacity(value: string): bigint | null {
  if (/^0x[0-9a-f]+$/i.test(value)) {
    const capacity = BigInt(value);
    return capacity > 0n && capacity <= 0xffff_ffffn ? capacity : null;
  }
  const match = /^(\d+)(B|KB|K|MB|M)$/i.exec(value);
  if (!match) return null;
  const amount = BigInt(match[1]!);
  const unit = match[2]!.toUpperCase();
  const multiplier = unit === 'B'
    ? 1n
    : unit === 'K' || unit === 'KB'
      ? 1024n
      : 1024n * 1024n;
  const capacity = amount * multiplier;
  return capacity > 0n && capacity <= 0xffff_ffffn ? capacity : null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
