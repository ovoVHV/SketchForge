import { canonicalJson, sha256Hex } from './canonical.js';
import type { ActionInput, ActionPackInput } from './types.js';
import type { PlannerCompilerFlags, PlannerTransformSpec } from './planner.js';
import type { CKPlatformRecipeLowering } from '../platform-pack/types.js';
import type {
  CKEsp32PostLinkContract,
  CKEsp32PostLinkOperation,
  CKEsp32PostLinkProduct,
  CKPostLinkInput,
} from '../platform-pack/recipe-command-lowering.js';

export {
  CK_ESP32_POST_LINK_CONTRACT_SCHEMA_VERSION,
  deriveEsp32PostLinkContract,
  derivePlatformArchiveCommand,
  type CKEsp32PostLinkBindings,
  type CKEsp32PostLinkContract,
  type CKEsp32PostLinkContractBody,
  type CKEsp32PostLinkContractSource,
  type CKEsp32PostLinkOperation,
  type CKEsp32PostLinkProduct,
  type CKEsp32PostLinkProductId,
  type CKHexOffset,
  type CKPostLinkActionOutputInput,
  type CKPostLinkImmutableInput,
  type CKPostLinkImmutableProvenance,
  type CKPostLinkInput,
  type CKPostLinkPackIdentity,
  type CKPostLinkPackArtifactManifest,
  type DeriveEsp32PostLinkContractInput,
} from '../platform-pack/recipe-command-lowering.js';

export interface PlatformCompileCommand {
  args: readonly string[];
  source: string;
  object: string;
}

export interface PlatformLinkCommand {
  args: readonly string[];
  object: string;
  elf: string;
  /** Defaults to the archive placeholder emitted by the CK planner. */
  coreArchive?: string;
}

export interface PlatformCommandPathLayout {
  exact?: Readonly<Record<string, string>>;
  prefixes?: Readonly<Record<string, string>>;
}

export interface LowerPlatformBuildCommandsInput {
  compile: PlatformCompileCommand;
  link: PlatformLinkCommand;
  /** Language-only flags that are not present in the canonical compile recipe. */
  languageFlags?: PlannerCompilerFlags;
  pathLayout?: PlatformCommandPathLayout;
  /** Manifest-owned response-file roles and language filename bindings. */
  recipeLowering?: CKPlatformRecipeLowering;
}

export interface LoweredPlatformBuildCommands {
  macros: Record<string, string | boolean>;
  includePaths: string[];
  flags: PlannerCompilerFlags;
  compilerInputs: ActionInput[];
  linkerFlags: string[];
  linkerInputs: ActionInput[];
  linkerTailFlags: string[];
}

export interface CKEsp32PostLinkToolBindings {
  elf2image?: string;
  partitionBin?: string;
  materialize?: string;
  mergeBin?: string;
}

/** Logical layout used by the immutable browser Platform and Board Packs. */
export const CK_BROWSER_PLATFORM_PATH_LAYOUT: PlatformCommandPathLayout = Object.freeze({
  exact: Object.freeze({
    'core.a': 'packs/platform/core.a',
    core: 'packs/platform/core',
    variant: 'packs/board/variant',
  }),
  prefixes: Object.freeze({
    'sdk/': 'packs/platform/sdk/',
    'core/': 'packs/platform/core/',
    'variant/': 'packs/board/variant/',
    'runtime/': 'packs/toolchain/runtime/',
  }),
});

/** Lower one verified post-link contract to environment-neutral planner inputs. */
export function lowerEsp32PostLinkTransforms(
  contract: CKEsp32PostLinkContract,
  tools: CKEsp32PostLinkToolBindings,
): PlannerTransformSpec[] {
  verifyEsp32PostLinkContract(contract);
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
    throw new TypeError('ESP32 post-link tool bindings are invalid');
  }
  return contract.products.map((product) => lowerEsp32PostLinkProduct(product, tools, contract));
}

function lowerEsp32PostLinkProduct(
  product: CKEsp32PostLinkProduct,
  tools: CKEsp32PostLinkToolBindings,
  contract: CKEsp32PostLinkContract,
): PlannerTransformSpec {
  const operation = product.operation;
  const packInputs = operationPackInputs(operation);
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
  } satisfies Partial<PlannerTransformSpec>;
  if (operation.kind === 'esp32.elf2image') {
    const input = actionInput(operation.input);
    const flags = esp32ImageFlags(operation);
    const argumentsList = [
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
    ];
    return {
      ...base,
      input: operation.input.path,
      inputs: [input],
      flags: [...flags, contractFlag],
      tool: requiredPostLinkTool(tools.elf2image, operation.kind),
      arguments: argumentsList,
      dependencies: actionInputDependencies([operation.input]),
    } as PlannerTransformSpec;
  }
  if (operation.kind === 'esp32.partition-bin') {
    return {
      ...base,
      input: operation.input.path,
      inputs: [actionInput(operation.input)],
      flags: ['--quiet=true', contractFlag],
      tool: requiredPostLinkTool(tools.partitionBin, operation.kind),
      arguments: ['-q', operation.input.path, product.output],
      dependencies: [],
    } as PlannerTransformSpec;
  }
  if (operation.kind === 'materialize') {
    return {
      ...base,
      input: operation.input.path,
      inputs: [actionInput(operation.input)],
      flags: [contractFlag],
      tool: requiredPostLinkTool(tools.materialize, operation.kind),
      arguments: [operation.input.path, '-o', product.output],
      dependencies: [],
    } as PlannerTransformSpec;
  }
  const inputs = operation.segments.map((segment) => actionInput(segment.input));
  if (!inputs.length) throw new TypeError('ESP32 merge operation has no inputs');
  return {
    ...base,
    input: inputs[0]!.path,
    inputs,
    flags: [
      `--chip=${operation.chip}`,
      `--pad-to-size=${operation.padToSize}`,
      '--flash-mode=keep',
      '--flash-freq=keep',
      '--flash-size=keep',
      contractFlag,
    ],
    tool: requiredPostLinkTool(tools.mergeBin, operation.kind),
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
    dependencies: actionInputDependencies(operation.segments.map((segment) => segment.input)),
  } as PlannerTransformSpec;
}

function operationPackInputs(operation: CKEsp32PostLinkOperation): ActionPackInput[] {
  return postLinkOperationInputs(operation).flatMap((input) => {
    if (input.kind !== 'immutable' || input.provenance.kind !== 'pack-artifact') return [];
    return [{
      kind: 'pack-artifact' as const,
      packId: input.provenance.packId,
      packRevision: input.provenance.packSha256,
      packSchema: input.provenance.packSchema,
      artifactId: input.provenance.artifactId,
      sha256: input.sha256,
      role: input.role,
    }];
  });
}

function postLinkOperationInputs(
  operation: CKEsp32PostLinkOperation,
): readonly CKPostLinkInput[] {
  return operation.kind === 'esp32.merge-bin'
    ? operation.segments.map((segment) => segment.input)
    : [operation.input];
}

function esp32ImageFlags(
  operation: Extract<CKEsp32PostLinkOperation, { kind: 'esp32.elf2image' }>,
): string[] {
  return [
    `--chip=${operation.chip}`,
    `--flash-mode=${operation.flashMode}`,
    `--flash-freq=${operation.flashFrequency}`,
    `--flash-size=${operation.flashSize}`,
    ...(operation.elfSha256Offset === undefined
      ? []
      : [`--elf-sha256-offset=${operation.elfSha256Offset}`]),
  ];
}

function actionInput(input: CKPostLinkInput): ActionInput {
  return {
    path: input.path,
    role: input.role,
    ...(input.kind === 'immutable' ? { sha256: input.sha256 } : {}),
  };
}

function actionInputDependencies(inputs: readonly CKPostLinkInput[]): string[] {
  return [...new Set(inputs
    .filter((input) => input.kind === 'action-output')
    .map((input) => input.actionId))].sort(compareStrings);
}

function requiredPostLinkTool(value: string | undefined, operation: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._:-]*$/.test(value)) {
    throw new TypeError(`ESP32 post-link tool is unavailable for ${operation}`);
  }
  return value;
}

function verifyEsp32PostLinkContract(contract: CKEsp32PostLinkContract): void {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)
    || contract.kind !== 'ck-esp32-post-link-contract'
    || contract.schemaVersion !== 1
    || typeof contract.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(contract.sha256)
    || !Array.isArray(contract.products)) {
    throw new TypeError('ESP32 post-link contract is invalid');
  }
  const { sha256, ...body } = contract;
  if (sha256Hex(canonicalJson(body)) !== sha256) {
    throw new TypeError('ESP32 post-link contract sha256 mismatch');
  }
  const hasModel = contract.products.some((product) => (
    (product.productId as string) === 'model'
  ));
  const expected = hasModel
    ? ['application', 'bootloader', 'partitions', 'boot-app0', 'model', 'merged']
    : ['application', 'bootloader', 'partitions', 'boot-app0', 'merged'];
  if (contract.products.length !== expected.length
    || contract.products.some((product, index) => product.productId !== expected[index])) {
    throw new TypeError('ESP32 post-link contract product order is invalid');
  }
}

/**
 * Lower one Pack-produced compile/link profile into the environment-neutral
 * fields consumed by ck-build-core. Browser and native callers provide only
 * their Pack path layout and immutable input identities.
 */
export function lowerPlatformBuildCommands(
  input: LowerPlatformBuildCommandsInput,
): LoweredPlatformBuildCommands {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Platform planning input is invalid');
  }
  const lowering = input.recipeLowering;
  const compile = splitCompileArguments(input.compile, input.pathLayout);
  const link = splitLinkArguments(input.link, input.pathLayout, lowering?.responseFiles);
  const splitFlags = splitCompileLanguageFlags(compile.flags, lowering?.responseFiles.languageFiles);
  const explicitFlags = remapCompilerFlags(
    normalizeCompilerFlags(input.languageFlags),
    input.pathLayout,
  );
  const flags: PlannerCompilerFlags = {
    common: [...splitFlags.common, ...explicitFlags.common],
    c: [...splitFlags.c, ...explicitFlags.c],
    cxx: [...splitFlags.cxx, ...explicitFlags.cxx],
    asm: [...splitFlags.asm, ...explicitFlags.asm],
  };
  const compilerInputs = responseFileInputs(
    [...flags.common!, ...flags.c!, ...flags.cxx!, ...flags.asm!],
    lowering?.responseFiles.marker ?? '@',
    lowering?.responseFiles.roles.compiler ?? 'compiler-response-file',
  );
  return {
    macros: compile.macros,
    includePaths: compile.includePaths,
    flags,
    compilerInputs,
    linkerFlags: link.prefix,
    linkerInputs: link.inputs,
    linkerTailFlags: link.tail,
  };
}

function splitCompileArguments(
  command: PlatformCompileCommand,
  layout: PlatformCommandPathLayout | undefined,
): {
  flags: string[];
  macros: Record<string, string | boolean>;
  includePaths: string[];
} {
  if (!command || !Array.isArray(command.args) || typeof command.source !== 'string'
    || typeof command.object !== 'string') {
    throw new TypeError('Platform Manifest compile command is invalid');
  }
  const flags: string[] = [];
  const macros: Record<string, string | boolean> = {};
  const includePaths: string[] = [];
  let sourceCount = 0;
  let outputCount = 0;
  let compileCount = 0;
  for (let index = 1; index < command.args.length; index += 1) {
    const argument = command.args[index];
    if (typeof argument !== 'string') throw new TypeError('Platform Manifest argument is invalid');
    if (argument === command.source) {
      sourceCount += 1;
      continue;
    }
    if (argument === '-o' && command.args[index + 1] === command.object) {
      outputCount += 1;
      index += 1;
      continue;
    }
    if (argument === '-c') {
      compileCount += 1;
      continue;
    }
    const logical = logicalArgument(argument, layout);
    if (logical.startsWith('-D') && logical.length > 2) {
      const definition = logical.slice(2);
      const equals = definition.indexOf('=');
      const key = equals < 0 ? definition : definition.slice(0, equals);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        macros[key] = equals < 0 ? true : definition.slice(equals + 1);
        continue;
      }
    }
    if (logical.startsWith('-I') && logical.length > 2) {
      includePaths.push(logical.slice(2));
      continue;
    }
    flags.push(logical);
  }
  if (sourceCount !== 1 || outputCount !== 1 || compileCount !== 1) {
    throw new TypeError('Platform Manifest compile placeholders are invalid');
  }
  return { flags, macros, includePaths };
}

function splitCompileLanguageFlags(
  flags: readonly string[],
  languageFiles: Readonly<{ c: string; cxx: string; asm: string }> | undefined,
): Required<PlannerCompilerFlags> {
  const common: string[] = [];
  const c: string[] = [];
  const cxx: string[] = [];
  const asm: string[] = [];
  const cFile = languageFiles?.c ?? 'c_flags';
  const cxxFile = languageFiles?.cxx ?? 'cpp_flags';
  const asmFile = languageFiles?.asm ?? 'S_flags';
  for (const flag of flags) {
    if (flag.startsWith('@') && flag.endsWith(`/${cFile}`)) c.push(flag);
    else if (flag.startsWith('@') && flag.endsWith(`/${cxxFile}`)) cxx.push(flag);
    else if (flag.startsWith('@') && flag.endsWith(`/${asmFile}`)) asm.push(flag);
    else common.push(flag);
  }
  return { common, c, cxx, asm };
}

function splitLinkArguments(
  command: PlatformLinkCommand,
  layout: PlatformCommandPathLayout | undefined,
  responseFiles: CKPlatformRecipeLowering['responseFiles'] | undefined,
): { prefix: string[]; tail: string[]; inputs: ActionInput[] } {
  if (!command || !Array.isArray(command.args) || typeof command.object !== 'string'
    || typeof command.elf !== 'string') {
    throw new TypeError('Platform Manifest link command is invalid');
  }
  const coreArchive = command.coreArchive ?? 'core.a';
  const prefix: string[] = [];
  const tail: string[] = [];
  let objectCount = 0;
  let outputCount = 0;
  let coreCount = 0;
  let afterObject = false;
  for (let index = 1; index < command.args.length; index += 1) {
    const argument = command.args[index];
    if (typeof argument !== 'string') throw new TypeError('Platform Manifest argument is invalid');
    if (argument === command.object) {
      objectCount += 1;
      afterObject = true;
      continue;
    }
    if (argument === coreArchive) {
      coreCount += 1;
      afterObject = true;
      continue;
    }
    if (argument === '-o' && command.args[index + 1] === command.elf) {
      outputCount += 1;
      index += 1;
      continue;
    }
    (afterObject ? tail : prefix).push(logicalArgument(argument, layout));
  }
  if (objectCount !== 1 || outputCount !== 1 || coreCount !== 1) {
    throw new TypeError('Platform Manifest link placeholders are invalid');
  }
  return {
    prefix,
    tail,
    inputs: responseFileInputs(
      [...prefix, ...tail],
      responseFiles?.marker ?? '@',
      responseFiles?.roles.linker ?? 'linker-response-file',
    ),
  };
}

function responseFileInputs(argumentsList: readonly string[], marker: string, role: string): ActionInput[] {
  return uniqueInputs(argumentsList
    .filter((argument) => argument.startsWith(marker))
    .map((argument) => ({ path: argument.slice(marker.length), role })));
}

function logicalArgument(argument: string, layout: PlatformCommandPathLayout | undefined): string {
  if (argument.startsWith('@')) return `@${resolvePlatformLogicalPath(argument.slice(1), layout)}`;
  const joinedPath = argument.match(/^(-[IL])(.+)$/);
  if (joinedPath) return `${joinedPath[1]}${resolvePlatformLogicalPath(joinedPath[2]!, layout)}`;
  return resolvePlatformLogicalPath(argument, layout);
}

export function resolvePlatformLogicalPath(
  path: string,
  layout: PlatformCommandPathLayout | undefined,
): string {
  if (typeof path !== 'string') throw new TypeError('Platform Manifest path is invalid');
  const exact = layout?.exact?.[path];
  if (exact !== undefined) return exact;
  const prefixes = Object.entries(layout?.prefixes ?? {})
    .sort(([left], [right]) => right.length - left.length || compareStrings(left, right));
  for (const [prefix, replacement] of prefixes) {
    if (path.startsWith(prefix)) return `${replacement}${path.slice(prefix.length)}`;
  }
  return path;
}

/** Reverse a Manifest logical-to-Action mapping for an executor VFS. */
export function invertPlatformLogicalPathLayout(
  layout: PlatformCommandPathLayout | undefined,
): PlatformCommandPathLayout | undefined {
  if (!layout) return undefined;
  const exact = Object.fromEntries(Object.entries(layout.exact ?? {}).map(([from, to]) => [to, from]));
  const prefixes = Object.fromEntries(Object.entries(layout.prefixes ?? {}).map(([from, to]) => [to, from]));
  if (new Set(Object.keys(exact)).size !== Object.keys(layout.exact ?? {}).length
    || new Set(Object.keys(prefixes)).size !== Object.keys(layout.prefixes ?? {}).length) {
    throw new TypeError('Platform path layout cannot be inverted because destinations are duplicated');
  }
  return { exact, prefixes };
}

function normalizeCompilerFlags(value: PlannerCompilerFlags | undefined): Required<PlannerCompilerFlags> {
  const normalize = (flags: readonly string[] | undefined, label: string): string[] => {
    if (flags === undefined) return [];
    if (!Array.isArray(flags) || flags.some((flag) => typeof flag !== 'string')) {
      throw new TypeError(`Platform ${label} flags are invalid`);
    }
    return [...flags];
  };
  return {
    common: normalize(value?.common, 'common compiler'),
    c: normalize(value?.c, 'C compiler'),
    cxx: normalize(value?.cxx, 'C++ compiler'),
    asm: normalize(value?.asm, 'assembler'),
  };
}

function remapCompilerFlags(
  value: Required<PlannerCompilerFlags>,
  layout: PlatformCommandPathLayout | undefined,
): Required<PlannerCompilerFlags> {
  const remap = (flags: readonly string[]): string[] => (
    flags.map((flag) => logicalArgument(flag, layout))
  );
  return {
    common: remap(value.common),
    c: remap(value.c),
    cxx: remap(value.cxx),
    asm: remap(value.asm),
  };
}

function uniqueInputs(inputs: readonly ActionInput[]): ActionInput[] {
  const byPath = new Map<string, ActionInput>();
  for (const input of inputs) if (!byPath.has(input.path)) byPath.set(input.path, input);
  return [...byPath.values()].sort((left, right) => compareStrings(left.path, right.path));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
