import { sha256Hex } from '../build-ir/canonical.js';
import type {
  BlockCodeUnit,
  BlockInputDefinition,
  BlocksMetadata,
  LibraryBlockDefinition,
} from './schema.js';

export interface BlocklyJsonDefinition {
  type: string;
  message0: string;
  args0: Array<Record<string, unknown>>;
  colour: number | string;
  tooltip: string;
  helpUrl: string;
  previousStatement?: null;
  nextStatement?: null;
  output?: string | string[] | null;
}

export interface BlocklyToolboxCategory {
  kind: 'category';
  name: string;
  colour: number | string;
  contents: Array<{ kind: 'block'; type: string }>;
}

export interface BlocklyBlockLike {
  id: string;
  type: string;
  getFieldValue(name: string): unknown;
}

export interface BlocklyGeneratorLike {
  valueToCode(block: BlocklyBlockLike, name: string, order: number): string;
  nameDB_?: { getName(name: string, type: string): string };
}

export interface GeneratedCodeFragment {
  blockId: string;
  type: string;
  includes: BlockCodeUnit[];
  globals: BlockCodeUnit[];
  setup: BlockCodeUnit[];
  body: string;
  shape: 'statement' | 'value';
}

export interface GeneratedSourceRange {
  startLine: number;
  endLine: number;
}

export interface AssembledBlockProgram {
  code: string;
  sourceMap: Record<string, GeneratedSourceRange>;
  regions: {
    includes: string[];
    globals: string[];
    setup: string[];
    body: string[];
  };
  semanticSha256: string;
}

export interface BlocklyLibraryBundle {
  definitions: BlocklyJsonDefinition[];
  toolbox: BlocklyToolboxCategory;
  generate(block: BlocklyBlockLike, generator: BlocklyGeneratorLike): GeneratedCodeFragment;
}

export interface BlocklyGenerationOptions {
  pinOptions?: Array<{ label: string; value: string }>;
  allowUnapproved?: boolean;
}

function identifier(value: string): string {
  const base = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 32) || 'value';
  const safe = /^[A-Za-z_]/.test(base) ? base : `v_${base}`;
  return `${safe}_${sha256Hex(value).slice(0, 8)}`;
}

export function canonicalBlockVariableName(name: string, namespace = 'project'): string {
  return `ck_${identifier(`${namespace}:${name}`)}`;
}

function fieldDefinition(input: BlockInputDefinition, pinOptions: BlocklyGenerationOptions['pinOptions']): Record<string, unknown> {
  switch (input.kind) {
    case 'value':
      return { type: 'input_value', name: input.name, ...(input.check === undefined ? {} : { check: input.check }) };
    case 'number':
      return {
        type: 'field_number', name: input.name, value: typeof input.default === 'number' ? input.default : 0,
        ...(input.min === undefined ? {} : { min: input.min }),
        ...(input.max === undefined ? {} : { max: input.max }),
        ...(input.precision === undefined ? {} : { precision: input.precision }),
      };
    case 'text': return { type: 'field_input', name: input.name, text: String(input.default ?? '') };
    case 'boolean': return { type: 'field_checkbox', name: input.name, checked: input.default === true };
    case 'variable': return { type: 'field_variable', name: input.name, variable: String(input.default ?? input.label) };
    case 'pin': return {
      type: 'field_dropdown', name: input.name,
      options: (pinOptions?.length ? pinOptions : [{ label: String(input.default ?? '0'), value: String(input.default ?? '0') }])
        .map((option) => [option.label, option.value]),
    };
    case 'dropdown': return {
      type: 'field_dropdown', name: input.name,
      options: (input.options ?? []).map((option) => [option.label, option.value]),
    };
  }
}

function definition(block: LibraryBlockDefinition, options: BlocklyGenerationOptions): BlocklyJsonDefinition {
  const value: BlocklyJsonDefinition = {
    type: block.type,
    message0: block.message,
    args0: block.inputs.map((input) => fieldDefinition(input, options.pinOptions)),
    colour: block.colour,
    tooltip: block.tooltip,
    helpUrl: block.helpUrl ?? '',
  };
  if (block.shape === 'statement') {
    value.previousStatement = null;
    value.nextStatement = null;
  } else value.output = block.output ?? null;
  return value;
}

function fieldCode(input: BlockInputDefinition, block: BlocklyBlockLike, generator: BlocklyGeneratorLike): string {
  if (input.kind === 'value') return generator.valueToCode(block, input.name, 0) || String(input.default ?? '0');
  const raw = block.getFieldValue(input.name) ?? input.default ?? '';
  switch (input.kind) {
    case 'number': {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new TypeError(`${block.type}.${input.name} is not a finite number`);
      return String(value);
    }
    case 'text': return JSON.stringify(String(raw));
    case 'boolean': return raw === true || raw === 'TRUE' || raw === 'true' ? 'true' : 'false';
    case 'variable': {
      const source = String(raw);
      return generator.nameDB_?.getName(source, 'VARIABLE') ?? canonicalBlockVariableName(source);
    }
    case 'pin':
      if (!/^(?:[0-9]{1,3}|A[0-9]{1,2}|D[0-9]{1,3}|DAC[0-9]{1,2})$/.test(String(raw))) {
        throw new TypeError(`${block.type}.${input.name} is not a valid pin literal`);
      }
      return String(raw);
    case 'dropdown': {
      const option = input.options?.find((candidate) => candidate.value === String(raw));
      if (!option) throw new TypeError(`${block.type}.${input.name} is not an allowed dropdown value`);
      return option.value;
    }
  }
}

function render(template: string, values: ReadonlyMap<string, string>, blockType: string): string {
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*|var:[A-Za-z][A-Za-z0-9_.:-]*)\s*\}\}/g, (_all, key: string) => {
    if (key.startsWith('var:')) return canonicalBlockVariableName(key.slice(4), blockType);
    const value = values.get(key);
    if (value === undefined) throw new TypeError(`${blockType} template references missing input ${key}`);
    return value;
  });
}

function normalizeCode(code: string): string {
  return code.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/g, '')).join('\n').trim();
}

function renderUnits(units: readonly BlockCodeUnit[] | undefined, values: ReadonlyMap<string, string>, type: string): BlockCodeUnit[] {
  return (units ?? []).map((unit) => ({ key: unit.key, code: normalizeCode(render(unit.code, values, type)) }));
}

export function createBlocklyLibraryBundle(
  metadata: BlocksMetadata,
  options: BlocklyGenerationOptions = {},
): BlocklyLibraryBundle {
  if (metadata.review.status !== 'approved' && !options.allowUnapproved) {
    throw new TypeError('Blockly generation requires approved blocks metadata');
  }
  const byType = new Map(metadata.blocks.map((block) => [block.type, block] as const));
  return {
    definitions: metadata.blocks.map((block) => definition(block, options)),
    toolbox: {
      kind: 'category', name: metadata.category.name, colour: metadata.category.colour,
      contents: metadata.blocks.map((block) => ({ kind: 'block', type: block.type })),
    },
    generate(block, generator) {
      const spec = byType.get(block.type);
      if (!spec) throw new TypeError(`unknown block type: ${block.type}`);
      const values = new Map(spec.inputs.map((input) => [input.name, fieldCode(input, block, generator)] as const));
      return {
        blockId: block.id,
        type: block.type,
        includes: renderUnits(spec.code.includes, values, spec.type),
        globals: renderUnits(spec.code.globals, values, spec.type),
        setup: renderUnits(spec.code.setup, values, spec.type),
        body: normalizeCode(render(spec.code.body, values, spec.type)),
        shape: spec.shape,
      };
    },
  };
}

function uniqueUnits(fragments: readonly GeneratedCodeFragment[], region: 'includes' | 'globals' | 'setup'): BlockCodeUnit[] {
  const byKey = new Map<string, string>();
  for (const fragment of fragments) {
    for (const unit of fragment[region]) {
      const previous = byKey.get(unit.key);
      if (previous !== undefined && previous !== unit.code) {
        throw new TypeError(`${region} key ${unit.key} has conflicting generated code`);
      }
      byKey.set(unit.key, unit.code);
    }
  }
  return [...byKey].sort(([left], [right]) => left.localeCompare(right)).map(([key, code]) => ({ key, code }));
}

function indent(code: string, spaces = 2): string[] {
  const prefix = ' '.repeat(spaces);
  return normalizeCode(code).split('\n').filter((line) => line.length > 0).map((line) => `${prefix}${line}`);
}

export function assembleBlockProgram(fragments: readonly GeneratedCodeFragment[]): AssembledBlockProgram {
  const statements = fragments.filter((fragment) => fragment.shape === 'statement');
  const includeUnits = uniqueUnits(fragments, 'includes');
  const globalUnits = uniqueUnits(fragments, 'globals');
  const setupUnits = uniqueUnits(fragments, 'setup');
  const lines: string[] = [];
  const appendRegion = (units: readonly BlockCodeUnit[]): void => {
    for (const unit of units) lines.push(...normalizeCode(unit.code).split('\n'));
    if (units.length > 0) lines.push('');
  };
  appendRegion(includeUnits);
  appendRegion(globalUnits);
  lines.push('void setup() {');
  for (const unit of setupUnits) lines.push(...indent(unit.code));
  lines.push('}', '', 'void loop() {');
  const sourceMap: Record<string, GeneratedSourceRange> = {};
  const bodyCodes: string[] = [];
  for (const fragment of statements) {
    const bodyLines = indent(fragment.body);
    const startLine = lines.length + 1;
    lines.push(...bodyLines);
    sourceMap[fragment.blockId] = { startLine, endLine: Math.max(startLine, lines.length) };
    bodyCodes.push(fragment.body);
  }
  lines.push('}');
  const code = `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
  return {
    code,
    sourceMap,
    regions: {
      includes: includeUnits.map((unit) => unit.code),
      globals: globalUnits.map((unit) => unit.code),
      setup: setupUnits.map((unit) => unit.code),
      body: bodyCodes,
    },
    semanticSha256: sha256Hex(code),
  };
}
