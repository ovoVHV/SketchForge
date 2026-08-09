import { canonicalJson, sha256Hex } from '../build-ir/canonical.js';
import { parseArduinoProperties } from './properties.js';
import {
  CK_PLATFORM_PACK_KIND,
  CK_PLATFORM_PACK_SCHEMA_VERSION,
  CK_RECIPE_LOWERING_SCHEMA_VERSION,
  type CKPlatformLogicalPathLayout,
  type CKPlatformManifest,
  type CKPlatformRecipeLowering,
  type CKPlatformRecipeLoweringBody,
  type CKPlatformSdkArchiveRewrite,
  type CreatePlatformManifestInput,
  type PlatformBoard,
  type PlatformFileEntry,
  type PlatformFileRole,
  type PlatformMenu,
  type PlatformMenuOption,
  type PlatformProgrammer,
  type PlatformRecipe,
  type PlatformSourceFile,
  type ResolvedPlatformManifest,
  type ResolvePlatformManifestInput,
  type PlatformRuntimeToolPolicy,
  type PlatformToolRequirement,
} from './types.js';

const SHA256 = /^[a-f0-9]{64}$/;
const PLACEHOLDER = /\{([^{}]+)\}/g;
const RUNTIME_TOOL_PATH = /\{runtime\.tools\.([A-Za-z0-9_.+-]+)\.path\}/g;
const CK_DYNAMIC_RECIPE_PLACEHOLDERS = new Set([
  'archive_file_path',
  'build.arch',
  'build.fqbn',
  'build.opt.path',
  'build.path',
  'build.project_name',
  'build.source.path',
  'build.variant.path',
  'compiler.path',
  'compiler.prefix',
  'compiler.sdk.path',
  'file_opts.path',
  'includes',
  'object_file',
  'object_files',
  'runtime.hardware.path',
  'runtime.ide.version',
  'runtime.os',
  'runtime.platform.path',
  'sketch_path',
  'source_file',
]);
const TOOL_METADATA_PATHS = new Set([
  'installed.json',
  'tools.json',
  'tools/metadata.json',
  'tools/requirements.json',
]);
const ARCHIVE_ARGUMENT_ORDER = Object.freeze([
  'operation', 'output', 'inputs', 'flags',
] as const);

const DEFAULT_RECIPE_LOWERING_INPUT: CKPlatformRecipeLoweringBody = Object.freeze({
  schemaVersion: CK_RECIPE_LOWERING_SCHEMA_VERSION,
  bindings: Object.freeze({
    compile: Object.freeze({
      c: 'recipe.c.o',
      cxx: 'recipe.cpp.o',
      asm: 'recipe.S.o',
    }),
    archive: 'recipe.ar',
    link: 'recipe.c.combine',
  }),
  paths: Object.freeze({
    logicalToAction: Object.freeze({
      exact: Object.freeze({}),
      prefixes: Object.freeze({}),
    }),
  }),
  responseFiles: Object.freeze({
    marker: '@',
    roles: Object.freeze({
      compiler: 'compiler-response-file',
      linker: 'linker-response-file',
    }),
    languageFiles: Object.freeze({ c: 'c_flags', cxx: 'cpp_flags', asm: 'S_flags' }),
  }),
  compatibility: Object.freeze({
    compiler: Object.freeze({ disableBuiltinCxxIncludes: false, runtimeIncludes: Object.freeze([]) }),
    linker: Object.freeze({
      searchPaths: Object.freeze([]), responseFiles: Object.freeze([]),
      runtimeLibraryDirectories: 'none', forceLldTargetPrefixes: Object.freeze([]),
    }),
  }),
  archive: Object.freeze({
    command: 'ar', operation: 'rcs',
    argumentOrder: ARCHIVE_ARGUMENT_ORDER,
  }),
  publication: Object.freeze({ sdkArchiveRewrites: Object.freeze([]) }),
});

const ESP32_RECIPE_LOWERING_INPUT: CKPlatformRecipeLoweringBody = Object.freeze({
  ...DEFAULT_RECIPE_LOWERING_INPUT,
  paths: Object.freeze({
    logicalToAction: Object.freeze({
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
    }),
  }),
  compatibility: Object.freeze({
    compiler: Object.freeze({
      disableBuiltinCxxIncludes: true,
      runtimeIncludes: Object.freeze([
        Object.freeze({ role: 'cxx' as const, flag: '-isystem' as const }),
        Object.freeze({ role: 'cxx-target' as const, flag: '-isystem' as const }),
        Object.freeze({ role: 'cxx-backward' as const, flag: '-isystem' as const }),
        Object.freeze({ role: 'gcc' as const, flag: '-isystem' as const }),
        Object.freeze({ role: 'gcc-fixed' as const, flag: '-isystem' as const }),
        Object.freeze({ role: 'sysroot' as const, flag: '-isystem' as const }),
      ]),
    }),
    linker: Object.freeze({
      searchPaths: Object.freeze(['sdk/lld-compat']),
      responseFiles: Object.freeze(['sdk/lld-compat/ld_flags']),
      runtimeLibraryDirectories: 'all',
      forceLldTargetPrefixes: Object.freeze(['xtensa-']),
    }),
  }),
  publication: Object.freeze({
    sdkArchiveRewrites: Object.freeze<CKPlatformSdkArchiveRewrite[]>([
      'strip-debug', 'deterministic-archives',
    ]),
  }),
});

/** Create a canonical, internally hashed recipe-lowering contract. */
export function createPlatformRecipeLowering(
  input: Partial<CKPlatformRecipeLoweringBody> = {},
): CKPlatformRecipeLowering {
  const body = normalizeRecipeLoweringBody({
    ...DEFAULT_RECIPE_LOWERING_INPUT,
    ...input,
    schemaVersion: CK_RECIPE_LOWERING_SCHEMA_VERSION,
  });
  return Object.freeze({ ...body, sha256: sha256Hex(canonicalJson(body)) });
}

export function createPlatformManifest(input: CreatePlatformManifestInput): CKPlatformManifest {
  for (const [label, value] of Object.entries({
    id: input.id, version: input.version, vendor: input.vendor, architecture: input.architecture,
  })) {
    if (!value.trim()) throw new TypeError(`platform ${label} must not be empty`);
  }

  const platform = parseArduinoProperties(input.platformText);
  const boards = parseArduinoProperties(input.boardsText);
  const programmers = parseArduinoProperties(input.programmersText ?? '');
  const recipes = Object.entries(platform.properties)
    .filter(([key]) => key.startsWith('recipe.') && key.endsWith('.pattern'))
    .map(([key, value]) => createRecipe(key.slice(0, -'.pattern'.length), value))
    .sort((left, right) => compareText(left.id, right.id));
  const recipeLowering = createPlatformRecipeLowering(
    input.recipeLowering ?? (input.architecture === 'esp32' ? ESP32_RECIPE_LOWERING_INPUT : undefined),
  );
  assertRecipeLoweringBindings(recipes, recipeLowering);
  const recipeKeys = new Set(recipes.map((recipe) => `${recipe.id}.pattern`));
  const platformProperties = Object.fromEntries(Object.entries(platform.properties)
    .filter(([key]) => !recipeKeys.has(key))
    .sort(([left], [right]) => compareText(left, right)));
  const sourceFiles = (input.files ?? []).map((file) => ({
    ...file,
    path: normalizePath(file.path),
  }));
  assertUnique(sourceFiles.map((file) => file.path), 'platform file');
  assertConfigSourceMatches(sourceFiles, 'platform.txt', input.platformText);
  assertConfigSourceMatches(sourceFiles, 'boards.txt', input.boardsText);
  assertConfigSourceMatches(sourceFiles, 'programmers.txt', input.programmersText ?? '');
  const files = sourceFiles.map((file): PlatformFileEntry => {
    const bytes = typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content;
    return {
      path: file.path,
      role: file.role ?? inferRole(file.path),
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
    };
  }).sort((left, right) => compareText(left.path, right.path));
  const tools = resolveToolRequirements(
    input.tools ?? [],
    sourceFiles,
    [input.platformText, input.boardsText, input.programmersText ?? ''],
    input.runtimeToolPolicy ?? 'require-source-metadata',
  );

  const withoutHash = {
    kind: CK_PLATFORM_PACK_KIND,
    schemaVersion: CK_PLATFORM_PACK_SCHEMA_VERSION,
    id: input.id,
    version: input.version,
    vendor: input.vendor,
    architecture: input.architecture,
    platformProperties,
    recipes,
    boards: createBoards(boards.entries, boards.properties, input.vendor, input.architecture),
    programmers: createProgrammers(programmers.properties),
    tools,
    files,
    recipeLowering,
  };
  return { ...withoutHash, sha256: sha256Hex(canonicalJson(withoutHash)) };
}

export function validatePlatformManifest(value: unknown): CKPlatformManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('platform manifest must be an object');
  const candidate = value as CKPlatformManifest;
  if (candidate.kind !== CK_PLATFORM_PACK_KIND) throw new TypeError(`expected ${CK_PLATFORM_PACK_KIND}`);
  if (candidate.schemaVersion !== CK_PLATFORM_PACK_SCHEMA_VERSION) {
    throw new TypeError(`unsupported platform manifest schema ${String(candidate.schemaVersion)}`);
  }
  const recipeLowering = validateRecipeLowering(candidate.recipeLowering);
  assertRecipeLoweringBindings(candidate.recipes, recipeLowering);
  if (!Array.isArray(candidate.tools)) throw new TypeError('platform manifest tools must be an array');
  const toolIds = new Set<string>();
  candidate.tools.forEach((tool) => {
    validateTool(tool);
    if (toolIds.has(tool.id)) throw new TypeError(`platform tool ${tool.id} is duplicated`);
    toolIds.add(tool.id);
  });
  if (!SHA256.test(candidate.sha256)) throw new TypeError('platform manifest sha256 is invalid');
  const { sha256, ...withoutHash } = candidate;
  if (sha256Hex(canonicalJson(withoutHash)) !== sha256) throw new TypeError('platform manifest sha256 mismatch');
  return candidate;
}

function assertRecipeLoweringBindings(
  recipes: unknown,
  lowering: CKPlatformRecipeLowering,
): void {
  if (!Array.isArray(recipes)) throw new TypeError('platform manifest recipes must be an array');
  const counts = new Map<string, number>();
  for (const recipe of recipes) {
    if (!isRecord(recipe) || typeof recipe.id !== 'string') continue;
    counts.set(recipe.id, (counts.get(recipe.id) ?? 0) + 1);
  }
  const bindings = [
    ['compile.c', lowering.bindings.compile.c],
    ['compile.cxx', lowering.bindings.compile.cxx],
    ['compile.asm', lowering.bindings.compile.asm],
    ['archive', lowering.bindings.archive],
    ['link', lowering.bindings.link],
  ] as const;
  for (const [name, recipeId] of bindings) {
    const count = counts.get(recipeId) ?? 0;
    if (count !== 1) {
      throw new TypeError(
        `platform recipe lowering ${name} binding must resolve exactly one recipe: ${recipeId} (found ${count})`,
      );
    }
  }
}

/** Validate the immutable lowering contract independently of its Manifest hash. */
export function validateRecipeLowering(value: unknown): CKPlatformRecipeLowering {
  if (!isRecord(value)) throw new TypeError('platform recipe lowering contract must be an object');
  const candidate = value as unknown as CKPlatformRecipeLowering;
  const { sha256, ...body } = candidate;
  if (!SHA256.test(sha256)) throw new TypeError('platform recipe lowering sha256 is invalid');
  const normalized = normalizeRecipeLoweringBody(body);
  if (sha256Hex(canonicalJson(normalized)) !== sha256) {
    throw new TypeError('platform recipe lowering sha256 mismatch');
  }
  return candidate;
}

/** Resolve one FQBN and its menu choices from an immutable Platform Manifest. */
export function resolvePlatformManifest(input: ResolvePlatformManifestInput): ResolvedPlatformManifest {
  const manifest = validatePlatformManifest(input.manifest);
  if (typeof input.fqbn !== 'string' || !input.fqbn.trim()) {
    throw new TypeError('platform target fqbn must not be empty');
  }
  if (!Array.isArray(manifest.boards)) throw new TypeError('platform manifest boards must be an array');
  const matches = manifest.boards.filter((board) => board?.fqbn === input.fqbn);
  if (matches.length !== 1) {
    throw new TypeError(`platform target must resolve exactly one board: ${input.fqbn}`);
  }
  const board = matches[0]!;
  if (!board.core?.trim() || !board.variant?.trim() || !Array.isArray(board.menus)) {
    throw new TypeError(`platform board is incomplete: ${input.fqbn}`);
  }
  const requested = input.options ?? {};
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    throw new TypeError('platform target options must be an object');
  }
  const requestedOptions = new Map<string, string>();
  for (const [name, value] of Object.entries(requested)) {
    if (!name || typeof value !== 'string' || !value) {
      throw new TypeError(`platform target option is invalid: ${name}`);
    }
    requestedOptions.set(name, value);
  }
  const properties = { ...manifest.platformProperties, ...board.properties };
  const menuIds = new Set<string>();
  const menusByAlias = new Map<string, PlatformMenu>();
  const propertyKeysByAlias = new Map<string, Set<string>>();
  const registerProperty = (property: string) => {
    const alias = toOptionName(property.split('.').at(-1) ?? '');
    if (!alias) return;
    let keys = propertyKeysByAlias.get(alias);
    if (!keys) {
      keys = new Set();
      propertyKeysByAlias.set(alias, keys);
    }
    keys.add(property);
  };
  for (const property of Object.keys(board.properties)) registerProperty(property);
  for (const menu of board.menus) {
    if (!menu?.id || menuIds.has(menu.id) || !Array.isArray(menu.options) || !menu.options.length) {
      throw new TypeError(`platform board menu is invalid: ${String(menu?.id)}`);
    }
    menuIds.add(menu.id);
    const optionIds = new Set<string>();
    for (const option of menu.options) {
      if (!option?.id || optionIds.has(option.id)) {
        throw new TypeError(`platform board menu option is invalid: ${String(option?.id)}`);
      }
      optionIds.add(option.id);
      for (const property of Object.keys(option.properties)) registerProperty(property);
    }
    for (const alias of platformMenuAliases(menu)) {
      const existing = menusByAlias.get(alias);
      if (existing && existing.id !== menu.id) {
        throw new TypeError(`platform board menu alias is ambiguous: ${alias}`);
      }
      menusByAlias.set(alias, menu);
    }
  }
  const requestedByMenu = new Map<string, string>();
  const propertyConstraints: Array<{ name: string; value: string; keys: string[] }> = [];
  for (const [name, value] of requestedOptions) {
    const menu = menusByAlias.get(name);
    if (!menu) {
      const keys = [...(propertyKeysByAlias.get(name) ?? [])];
      if (!keys.length) throw new TypeError(`unknown platform target option: ${name}`);
      propertyConstraints.push({ name, value, keys });
      continue;
    }
    const existing = requestedByMenu.get(menu.id);
    if (existing !== undefined && existing !== value) {
      throw new TypeError(`conflicting platform target option ${menu.id}: ${existing} != ${value}`);
    }
    requestedByMenu.set(menu.id, value);
  }
  const options: Record<string, string> = {};
  for (const menu of board.menus) {
    const requestedValue = requestedByMenu.get(menu.id) ?? menu.default;
    const selected = resolvePlatformMenuOption(menu, requestedValue);
    if (!selected) throw new TypeError(`unknown platform menu option ${menu.id}=${requestedValue}`);
    options[menu.id] = selected.id;
    Object.assign(properties, selected.properties);
  }
  for (const constraint of propertyConstraints) {
    if (!constraint.keys.some((key) => properties[key] === constraint.value)) {
      throw new TypeError(`unknown platform target option value ${constraint.name}=${constraint.value}`);
    }
  }
  const sortedProperties = sortRecord(properties);
  return {
    manifestSha256: manifest.sha256,
    id: manifest.id,
    version: manifest.version,
    vendor: manifest.vendor,
    architecture: manifest.architecture,
    board,
    options: sortRecord(options),
    properties: sortedProperties,
    resolvedRecipes: resolvePlatformRecipes(manifest.recipes, sortedProperties),
    recipeLowering: manifest.recipeLowering,
  };
}

function resolvePlatformRecipes(
  recipes: readonly PlatformRecipe[],
  properties: Readonly<Record<string, string>>,
): PlatformRecipe[] {
  const cache = new Map<string, string>();

  const resolveProperty = (key: string, stack: string[], recipeId: string): string => {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const cycleAt = stack.indexOf(key);
    if (cycleAt >= 0) {
      throw new TypeError(`cyclic platform property placeholder: ${[...stack.slice(cycleAt), key].join(' -> ')}`);
    }
    const raw = properties[key];
    if (raw === undefined) {
      if (isCkDynamicRecipePlaceholder(key)) return `{${key}}`;
      throw new TypeError(`unknown platform recipe placeholder ${key} in ${recipeId}`);
    }
    const resolved = expand(raw, [...stack, key], recipeId);
    cache.set(key, resolved);
    return resolved;
  };

  const expand = (raw: string, stack: string[], recipeId: string): string => {
    let value = raw;
    for (;;) {
      const matches = innermostPlaceholders(value, recipeId);
      if (!matches.length) return value;
      let changed = false;
      let next = '';
      let offset = 0;
      for (const match of matches) {
        next += value.slice(offset, match.start);
        const replacement = resolveProperty(match.key, stack, recipeId);
        next += replacement;
        changed ||= replacement !== value.slice(match.start, match.end);
        offset = match.end;
      }
      next += value.slice(offset);
      value = next;
      if (!changed) return value;
    }
  };

  return recipes.map((recipe) => {
    const argv: string[] = [];
    for (const raw of recipe.argv) {
      const exact = /^\{([^{}]+)\}$/.exec(raw);
      const expanded = expand(raw, [], recipe.id);
      if (!expanded.trim()) continue;
      if (exact && Object.prototype.hasOwnProperty.call(properties, exact[1]!)) {
        argv.push(...tokenizeRecipe(expanded));
      } else {
        argv.push(expanded);
      }
    }
    if (!argv.length) throw new TypeError(`platform recipe expands to an empty command: ${recipe.id}`);
    const placeholders = new Set<string>();
    for (const token of argv) {
      for (const match of innermostPlaceholders(token, recipe.id)) {
        if (!isCkDynamicRecipePlaceholder(match.key)) {
          throw new TypeError(`unknown platform recipe placeholder ${match.key} in ${recipe.id}`);
        }
        placeholders.add(match.key);
      }
    }
    return { id: recipe.id, argv, placeholders: [...placeholders].sort(compareText) };
  });
}

function isCkDynamicRecipePlaceholder(key: string): boolean {
  return CK_DYNAMIC_RECIPE_PLACEHOLDERS.has(key)
    || (key.startsWith('runtime.tools.') && key.endsWith('.path'));
}

function innermostPlaceholders(
  value: string,
  recipeId: string,
): Array<{ start: number; end: number; key: string }> {
  const stack: number[] = [];
  const result: Array<{ start: number; end: number; key: string }> = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '{') {
      stack.push(index);
    } else if (char === '}') {
      const start = stack.pop();
      if (start === undefined) throw new TypeError(`invalid platform recipe placeholder syntax in ${recipeId}`);
      const key = value.slice(start + 1, index);
      if (!key || key.includes('{') || key.includes('}')) continue;
      result.push({ start, end: index + 1, key });
    }
  }
  if (stack.length) throw new TypeError(`invalid platform recipe placeholder syntax in ${recipeId}`);
  return result.sort((left, right) => left.start - right.start);
}

function platformMenuAliases(menu: PlatformMenu): string[] {
  const aliases = new Set([menu.id, toOptionName(menu.id)]);
  const canonical = toOptionName(menu.id);
  if (/^(?:cdc|msc|dfu)_/.test(canonical)) aliases.add(`usb_${canonical}`);
  if (canonical === 'events_core') aliases.add('event_core');
  if (canonical === 'core_debug_level') aliases.add('debug_level');
  return [...aliases].filter(Boolean);
}

function resolvePlatformMenuOption(menu: PlatformMenu, value: string): PlatformMenuOption | undefined {
  const exact = menu.options.find((option) => option.id === value);
  if (exact) return exact;
  const folded = menu.options.filter((option) => option.id.toLowerCase() === value.toLowerCase());
  if (folded.length === 1) return folded[0];
  const byLabel = menu.options.filter((option) => option.label.toLowerCase() === value.toLowerCase());
  if (byLabel.length === 1) return byLabel[0];
  const byProperty = menu.options.filter((option) => Object.values(option.properties).includes(value));
  return byProperty.length === 1 ? byProperty[0] : undefined;
}

function toOptionName(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function tokenizeRecipe(pattern: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of pattern) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  if (quote) throw new TypeError('unterminated quote in Arduino recipe');
  if (current) result.push(current);
  if (result.length === 0) throw new TypeError('Arduino recipe must not be empty');
  return result;
}

function createRecipe(id: string, pattern: string): PlatformRecipe {
  const argv = tokenizeRecipe(pattern);
  const placeholders = new Set<string>();
  for (const token of argv) {
    PLACEHOLDER.lastIndex = 0;
    for (let match = PLACEHOLDER.exec(token); match; match = PLACEHOLDER.exec(token)) placeholders.add(match[1]!);
  }
  return { id, argv, placeholders: [...placeholders].sort(compareText) };
}

function createBoards(
  entries: Array<{ key: string; value: string }>,
  properties: Record<string, string>,
  vendor: string,
  architecture: string,
): PlatformBoard[] {
  const boardIds = new Set<string>();
  const menuLabels = new Map<string, string>();
  for (const entry of entries) {
    const menu = /^menu\.([^.]+)$/.exec(entry.key);
    if (menu) menuLabels.set(menu[1]!, entry.value);
    const board = /^([^.]+)\./.exec(entry.key);
    if (board && !['menu', 'tools'].includes(board[1]!)) boardIds.add(board[1]!);
  }
  return [...boardIds].sort(compareText).map((id): PlatformBoard => {
    const prefix = `${id}.`;
    const direct: Record<string, string> = {};
    const menuOptions = new Map<string, Map<string, { label: string; properties: Record<string, string> }>>();
    for (const entry of entries) {
      if (!entry.key.startsWith(prefix)) continue;
      const key = entry.key.slice(prefix.length);
      const menu = /^menu\.([^.]+)\.([^.]+)(?:\.(.+))?$/.exec(key);
      if (!menu) {
        direct[key] = entry.value;
        continue;
      }
      const [, menuId, optionId, property] = menu;
      let options = menuOptions.get(menuId!);
      if (!options) {
        options = new Map();
        menuOptions.set(menuId!, options);
      }
      let option = options.get(optionId!);
      if (!option) {
        option = { label: optionId!, properties: {} };
        options.set(optionId!, option);
      }
      if (property) option.properties[property] = entry.value;
      else option.label = entry.value;
    }
    const menus: PlatformMenu[] = [...menuOptions].map(([menuId, options]) => {
      const values = [...options].map(([optionId, option]) => ({
        id: optionId,
        label: option.label,
        properties: sortRecord(option.properties),
      }));
      return {
        id: menuId,
        label: menuLabels.get(menuId) ?? menuId,
        default: values[0]!.id,
        options: values,
      };
    }).sort((left, right) => compareText(left.id, right.id));
    return {
      id,
      fqbn: `${vendor}:${architecture}:${id}`,
      name: properties[`${id}.name`] ?? id,
      core: direct['build.core'] ?? '',
      variant: direct['build.variant'] ?? '',
      properties: sortRecord(direct),
      menus,
    };
  });
}

function createProgrammers(properties: Record<string, string>): PlatformProgrammer[] {
  const ids = new Set(Object.keys(properties).map((key) => key.split('.')[0]!).filter(Boolean));
  return [...ids].sort(compareText).map((id) => {
    const prefix = `${id}.`;
    const values = Object.fromEntries(Object.entries(properties)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]));
    return { id, name: values.name ?? id, properties: sortRecord(values) };
  });
}

function validateTool(tool: PlatformToolRequirement): PlatformToolRequirement {
  if (!tool || typeof tool !== 'object'
    || typeof tool.id !== 'string' || typeof tool.version !== 'string'
    || !tool.id.trim() || !tool.version.trim()) {
    throw new TypeError('platform tool id and version must not be empty');
  }
  if (typeof tool.sha256 !== 'string' || !SHA256.test(tool.sha256)) {
    throw new TypeError(`platform tool ${tool.id} sha256 is required and must be valid`);
  }
  return { id: tool.id, version: tool.version, sha256: tool.sha256 };
}

function resolveToolRequirements(
  explicit: readonly PlatformToolRequirement[],
  files: readonly { path: string; content: string | Uint8Array }[],
  propertyTexts: readonly string[],
  policy: PlatformRuntimeToolPolicy,
): PlatformToolRequirement[] {
  if (policy !== 'require-source-metadata' && policy !== 'ck-transformed') {
    if (policy !== 'deferred-ck-binding') {
      throw new TypeError(`unsupported platform runtime tool policy: ${String(policy)}`);
    }
  }
  const byId = new Map<string, PlatformToolRequirement>();
  const add = (value: PlatformToolRequirement, source: string): void => {
    const tool = validateTool(value);
    const existing = byId.get(tool.id);
    if (existing && (existing.version !== tool.version || existing.sha256 !== tool.sha256)) {
      throw new TypeError(`conflicting platform tool metadata for ${tool.id}: ${source}`);
    }
    byId.set(tool.id, tool);
  };

  for (const file of files) {
    if (!TOOL_METADATA_PATHS.has(file.path.toLowerCase())) continue;
    for (const tool of parseToolMetadata(file)) add(tool, file.path);
  }
  for (const tool of explicit) add(tool, 'input tools');

  if (policy === 'deferred-ck-binding') {
    if (explicit.length) {
      throw new TypeError('deferred-ck-binding platform cannot bind a target-specific CK tool Pack');
    }
    return [];
  }

  if (policy === 'ck-transformed') {
    if (!explicit.length) {
      throw new TypeError('ck-transformed platform must bind at least one immutable CK tool Pack');
    }
    return [...byId.values()].sort((left, right) => compareText(left.id, right.id));
  }

  const required = new Set<string>();
  for (const text of propertyTexts) {
    RUNTIME_TOOL_PATH.lastIndex = 0;
    for (let match = RUNTIME_TOOL_PATH.exec(text); match; match = RUNTIME_TOOL_PATH.exec(text)) {
      required.add(match[1]!);
    }
  }
  for (const id of [...required].sort(compareText)) {
    if (!byId.has(id)) {
      throw new TypeError(
        `platform tool ${id} is referenced but has no version and sha256 metadata`,
      );
    }
  }
  return [...byId.values()].sort((left, right) => compareText(left.id, right.id));
}

function parseToolMetadata(
  file: { path: string; content: string | Uint8Array },
): PlatformToolRequirement[] {
  let text: string;
  try {
    text = typeof file.content === 'string'
      ? file.content
      : new TextDecoder('utf-8', { fatal: true }).decode(file.content);
  } catch {
    throw new TypeError(`platform tool metadata is not UTF-8: ${file.path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError(`platform tool metadata is not valid JSON: ${file.path}`);
  }
  const record = isRecord(value) ? value : undefined;
  const raw = Array.isArray(value)
    ? value
    : record?.tools ?? record?.toolRequirements ?? record?.toolsDependencies ?? [];
  const entries = Array.isArray(raw)
    ? raw
    : isRecord(raw)
      ? Object.entries(raw).map(([id, tool]) => ({ ...(isRecord(tool) ? tool : {}), id }))
      : [];
  return entries.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`platform tool metadata entry ${index} is invalid: ${file.path}`);
    }
    const id = entry.id ?? entry.name;
    const version = entry.version;
    const digest = normalizeToolDigest(entry.sha256 ?? entry.integrity ?? entry.checksum);
    return validateTool({ id, version, sha256: digest } as PlatformToolRequirement);
  });
}

function normalizeToolDigest(value: unknown): string {
  if (typeof value !== 'string') return '';
  const match = /^(?:SHA-?256:)?([A-Fa-f0-9]{64})$/.exec(value.trim());
  return match ? match[1]!.toLowerCase() : '';
}

function normalizeRecipeLoweringBody(value: unknown): CKPlatformRecipeLoweringBody {
  if (!isRecord(value)) throw new TypeError('platform recipe lowering contract must be an object');
  assertExactKeys(value, [
    'schemaVersion', 'bindings', 'paths', 'responseFiles', 'compatibility', 'archive', 'publication',
  ], 'platform recipe lowering contract');
  if (value.schemaVersion !== CK_RECIPE_LOWERING_SCHEMA_VERSION) {
    throw new TypeError(`unsupported recipe lowering schema ${String(value.schemaVersion)}`);
  }

  const bindings = exactRecord(value.bindings, 'platform recipe lowering bindings', ['compile', 'archive', 'link']);
  const compileBindings = exactRecord(
    bindings.compile,
    'platform recipe lowering compile bindings',
    ['c', 'cxx', 'asm'],
  );
  for (const [name, recipe] of Object.entries(compileBindings)) {
    if (typeof recipe !== 'string' || !recipe.trim()) {
      throw new TypeError(`platform recipe lowering compile ${name} binding is invalid`);
    }
  }
  for (const name of ['archive', 'link'] as const) {
    const recipe = bindings[name];
    if (typeof recipe !== 'string' || !recipe.trim()) {
      throw new TypeError(`platform recipe lowering ${name} binding is invalid`);
    }
  }

  const paths = exactRecord(value.paths, 'platform recipe lowering paths', ['logicalToAction']);
  const logicalToAction = normalizePathLayout(paths.logicalToAction);

  const responseFiles = exactRecord(
    value.responseFiles,
    'platform recipe lowering response files',
    ['marker', 'roles', 'languageFiles'],
  );
  if (responseFiles.marker !== '@') throw new TypeError('platform recipe lowering response marker must be @');
  const roles = exactRecord(responseFiles.roles, 'platform recipe lowering response roles', ['compiler', 'linker']);
  if ([roles.compiler, roles.linker].some((role) => typeof role !== 'string' || !role.trim())) {
    throw new TypeError('platform recipe lowering response roles are invalid');
  }
  const languageFiles = exactRecord(
    responseFiles.languageFiles,
    'platform recipe lowering language response files',
    ['c', 'cxx', 'asm'],
  );
  if (Object.values(languageFiles).some((name) => typeof name !== 'string' || !name.trim())) {
    throw new TypeError('platform recipe lowering language response files are invalid');
  }

  const compatibility = exactRecord(value.compatibility, 'platform recipe lowering compatibility', ['compiler', 'linker']);
  const compiler = exactRecord(
    compatibility.compiler,
    'platform recipe lowering compiler compatibility',
    ['disableBuiltinCxxIncludes', 'runtimeIncludes'],
  );
  if (typeof compiler.disableBuiltinCxxIncludes !== 'boolean' || !Array.isArray(compiler.runtimeIncludes)) {
    throw new TypeError('platform recipe lowering compiler compatibility is invalid');
  }
  const runtimeRoles = new Set<string>();
  const runtimeIncludes = compiler.runtimeIncludes.map((entry, index) => {
    const include = exactRecord(entry, `platform runtime include ${index}`, ['role', 'flag']);
    if (!['cxx', 'cxx-target', 'cxx-backward', 'gcc', 'gcc-fixed', 'sysroot'].includes(String(include.role))
      || include.flag !== '-isystem') {
      throw new TypeError(`platform runtime include ${index} is invalid`);
    }
    if (runtimeRoles.has(include.role as string)) throw new TypeError(`duplicate platform runtime include role: ${include.role}`);
    runtimeRoles.add(include.role as string);
    return Object.freeze({ role: include.role as CKPlatformRecipeLoweringBody['compatibility']['compiler']['runtimeIncludes'][number]['role'], flag: '-isystem' as const });
  });

  const linker = exactRecord(
    compatibility.linker,
    'platform recipe lowering linker compatibility',
    ['searchPaths', 'responseFiles', 'runtimeLibraryDirectories', 'forceLldTargetPrefixes'],
  );
  if (!Array.isArray(linker.searchPaths) || !Array.isArray(linker.responseFiles)
    || !Array.isArray(linker.forceLldTargetPrefixes)
    || !['all', 'none'].includes(String(linker.runtimeLibraryDirectories))) {
    throw new TypeError('platform recipe lowering linker compatibility is invalid');
  }
  const searchPaths = normalizeLogicalPathList(linker.searchPaths, 'linker search path');
  const responseFilePaths = normalizeLogicalPathList(linker.responseFiles, 'linker response file');
  const forceLldTargetPrefixes = normalizePrefixList(linker.forceLldTargetPrefixes, 'lld target prefix');

  const archive = exactRecord(
    value.archive,
    'platform recipe lowering archive',
    ['command', 'operation', 'argumentOrder'],
  );
  const archiveArgumentOrder = archive.argumentOrder;
  if (archive.command !== 'ar'
    || archive.operation !== 'rcs'
    || !Array.isArray(archiveArgumentOrder)
    || archiveArgumentOrder.length !== ARCHIVE_ARGUMENT_ORDER.length
    || ARCHIVE_ARGUMENT_ORDER.some((part, index) => archiveArgumentOrder[index] !== part)) {
    throw new TypeError('platform recipe lowering archive contract is invalid');
  }

  const publication = exactRecord(
    value.publication,
    'platform recipe lowering publication',
    ['sdkArchiveRewrites'],
  );
  if (!Array.isArray(publication.sdkArchiveRewrites)) {
    throw new TypeError('platform recipe lowering archive rewrites are invalid');
  }
  const rewrites = publication.sdkArchiveRewrites.map((rewrite) => String(rewrite)) as CKPlatformSdkArchiveRewrite[];
  if (new Set(rewrites).size !== rewrites.length
    || rewrites.some((rewrite) => !['strip-debug', 'deterministic-archives'].includes(rewrite))) {
    throw new TypeError('platform recipe lowering archive rewrites are invalid');
  }

  return Object.freeze({
    schemaVersion: CK_RECIPE_LOWERING_SCHEMA_VERSION,
    bindings: Object.freeze({
      compile: Object.freeze({
        c: compileBindings.c as string,
        cxx: compileBindings.cxx as string,
        asm: compileBindings.asm as string,
      }),
      archive: bindings.archive as string,
      link: bindings.link as string,
    }),
    paths: Object.freeze({ logicalToAction }),
    responseFiles: Object.freeze({
      marker: '@',
      roles: Object.freeze({ compiler: roles.compiler as string, linker: roles.linker as string }),
      languageFiles: Object.freeze({ c: languageFiles.c as string, cxx: languageFiles.cxx as string, asm: languageFiles.asm as string }),
    }),
    compatibility: Object.freeze({
      compiler: Object.freeze({
        disableBuiltinCxxIncludes: compiler.disableBuiltinCxxIncludes as boolean,
        runtimeIncludes: Object.freeze(runtimeIncludes),
      }),
      linker: Object.freeze({
        searchPaths: Object.freeze(searchPaths),
        responseFiles: Object.freeze(responseFilePaths),
        runtimeLibraryDirectories: linker.runtimeLibraryDirectories as 'all' | 'none',
        forceLldTargetPrefixes: Object.freeze(forceLldTargetPrefixes),
      }),
    }),
    archive: Object.freeze({
      command: 'ar',
      operation: 'rcs',
      argumentOrder: ARCHIVE_ARGUMENT_ORDER,
    }),
    publication: Object.freeze({ sdkArchiveRewrites: Object.freeze(rewrites) }),
  });
}

function normalizePathLayout(value: unknown): CKPlatformLogicalPathLayout {
  const layout = exactRecord(value, 'platform recipe lowering logical paths', ['exact', 'prefixes']);
  if (!isRecord(layout.exact) || !isRecord(layout.prefixes)) {
    throw new TypeError('platform recipe lowering logical paths are invalid');
  }
  const exact: Record<string, string> = {};
  for (const [from, to] of Object.entries(layout.exact)) {
    if (typeof to !== 'string') throw new TypeError('platform Action path is invalid');
    validateLogicalPath(from, 'logical path');
    validateLogicalPath(to, 'Action path');
    exact[from] = to;
  }
  const prefixes: Record<string, string> = {};
  for (const [from, to] of Object.entries(layout.prefixes)) {
    if (typeof to !== 'string') throw new TypeError('platform Action path prefix is invalid');
    if (!from.endsWith('/') || !to.endsWith('/')) throw new TypeError('platform path prefix must end with /');
    validateLogicalPath(from.slice(0, -1), 'logical path prefix');
    validateLogicalPath(to.slice(0, -1), 'Action path prefix');
    prefixes[from] = to;
  }
  const destinations = [...Object.values(exact), ...Object.values(prefixes)];
  if (new Set(destinations).size !== destinations.length) {
    throw new TypeError('platform recipe lowering path destinations are duplicated');
  }
  return Object.freeze({ exact: Object.freeze(sortRecord(exact)), prefixes: Object.freeze(sortRecord(prefixes)) });
}

function normalizeLogicalPathList(value: unknown[], label: string): string[] {
  const result = value.map((path) => {
    if (typeof path !== 'string') throw new TypeError(`platform ${label} is invalid`);
    validateLogicalPath(path.replace(/^@/, ''), label);
    return path;
  });
  if (new Set(result).size !== result.length) throw new TypeError(`platform ${label}s are duplicated`);
  return result;
}

function normalizePrefixList(value: unknown[], label: string): string[] {
  const result = value.map((prefix) => {
    if (typeof prefix !== 'string' || !prefix.trim() || prefix.includes('/') || prefix.includes('\\')) {
      throw new TypeError(`platform ${label} is invalid`);
    }
    return prefix;
  });
  if (new Set(result).size !== result.length) throw new TypeError(`platform ${label}s are duplicated`);
  return result;
}

function validateLogicalPath(value: string, label: string): void {
  if (!value || value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError(`platform ${label} is invalid: ${value}`);
  }
}

function exactRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, keys, label);
  return value;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = [...keys].sort(compareText);
  const actual = Object.keys(value).sort(compareText);
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new TypeError(`${label} has unexpected fields`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function inferRole(path: string): PlatformFileRole {
  if (path === 'platform.txt' || path === 'boards.txt' || path === 'programmers.txt') return 'config';
  if (path.startsWith('cores/')) return 'core';
  if (path.startsWith('variants/')) return 'variant';
  return 'other';
}

function normalizePath(value: string): string {
  const path = value.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError(`platform file path must be a relative POSIX path: ${value}`);
  }
  return path;
}

function assertConfigSourceMatches(
  files: readonly PlatformSourceFile[],
  path: string,
  expected: string,
): void {
  const source = files.find((file) => file.path === path);
  if (!source) return;
  const expectedBytes = new TextEncoder().encode(expected);
  const actualBytes = typeof source.content === 'string'
    ? new TextEncoder().encode(source.content)
    : source.content;
  if (actualBytes.byteLength !== expectedBytes.byteLength
    || actualBytes.some((byte, index) => byte !== expectedBytes[index])) {
    throw new TypeError(`platform config source does not match parsed input: ${path}`);
  }
}

function sortRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, value[key]!]));
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
