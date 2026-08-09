import { hashJson } from '../build-ir/canonical.js';
import type { JsonValue, Sha256 } from '../build-ir/types.js';

export const CK_BLOCKS_SCHEMA = 1 as const;
export const CK_BLOCKS_KIND = 'ck-library-blocks' as const;

export type BlocksReviewStatus = 'draft' | 'approved' | 'rejected';
export type BlockInputKind = 'value' | 'number' | 'text' | 'boolean' | 'pin' | 'dropdown' | 'variable';
export type BlockEvidenceKind = 'header' | 'keyword' | 'example';

export interface BlocksReview {
  status: BlocksReviewStatus;
  reviewer?: string;
  reviewedAt?: string;
  notes?: string;
}

export interface BlockEvidence {
  id: string;
  kind: BlockEvidenceKind;
  file: string;
  line: number;
  excerpt: string;
  sha256: Sha256;
}

export interface BlockDropdownOption {
  label: string;
  value: string;
}

export interface BlockInputDefinition {
  name: string;
  label: string;
  kind: BlockInputKind;
  check?: string | string[];
  default?: string | number | boolean;
  min?: number;
  max?: number;
  precision?: number;
  options?: BlockDropdownOption[];
}

export interface BlockCodeUnit {
  key: string;
  code: string;
}

export interface BlockCodeTemplate {
  includes?: BlockCodeUnit[];
  globals?: BlockCodeUnit[];
  setup?: BlockCodeUnit[];
  /** Statement body or value expression. Inputs use `{{inputName}}`; stable variables use `{{var:key}}`. */
  body: string;
}

export interface LibraryBlockDefinition {
  type: string;
  message: string;
  inputs: BlockInputDefinition[];
  shape: 'statement' | 'value';
  output?: string | string[];
  colour: number | string;
  tooltip: string;
  helpUrl?: string;
  code: BlockCodeTemplate;
  evidence: string[];
}

export interface BlocksMetadataBody {
  schema: typeof CK_BLOCKS_SCHEMA;
  kind: typeof CK_BLOCKS_KIND;
  library: {
    name: string;
    version: string;
    sourceSha256: Sha256;
  };
  generatedAt: string;
  review: BlocksReview;
  category: {
    id: string;
    name: string;
    colour: number | string;
  };
  blocks: LibraryBlockDefinition[];
  evidence: BlockEvidence[];
}

export interface BlocksMetadata extends BlocksMetadataBody {
  metadataSha256: Sha256;
}

export interface BlocksValidationResult {
  valid: boolean;
  errors: string[];
  value?: BlocksMetadata;
}

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_INPUT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_.-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*|var:[A-Za-z][A-Za-z0-9_.:-]*)\s*\}\}/g;

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0);
}

function validPath(value: unknown): value is string {
  return boundedText(value, 512)
    && !value.includes('\\')
    && !value.startsWith('/')
    && value.split('/').every((part) => SAFE_PATH_SEGMENT.test(part) && part !== '..');
}

function validColour(value: unknown): value is number | string {
  return (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 360)
    || (typeof value === 'string' && /^#[a-fA-F0-9]{6}$/.test(value));
}

function validCodeUnits(value: unknown, path: string, errors: string[]): value is BlockCodeUnit[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 128) {
    errors.push(`${path} must be an array with at most 128 entries`);
    return false;
  }
  const keys = new Set<string>();
  value.forEach((unit, index) => {
    if (!object(unit) || !boundedText(unit.key, 128) || !SAFE_ID.test(unit.key)
      || !boundedText(unit.code, 16_384)) {
      errors.push(`${path}[${index}] is invalid`);
      return;
    }
    if (keys.has(unit.key)) errors.push(`${path}[${index}].key is duplicated`);
    keys.add(unit.key);
  });
  return true;
}

function validateInput(value: unknown, path: string, errors: string[]): value is BlockInputDefinition {
  if (!object(value) || !boundedText(value.name, 64) || !SAFE_INPUT.test(value.name)
    || !boundedText(value.label, 128)
    || !['value', 'number', 'text', 'boolean', 'pin', 'dropdown', 'variable'].includes(String(value.kind))) {
    errors.push(`${path} is invalid`);
    return false;
  }
  if (value.check !== undefined && !(boundedText(value.check, 64)
    || (Array.isArray(value.check) && value.check.length <= 16 && value.check.every((item) => boundedText(item, 64))))) {
    errors.push(`${path}.check is invalid`);
  }
  if (value.default !== undefined && !['string', 'number', 'boolean'].includes(typeof value.default)) {
    errors.push(`${path}.default is invalid`);
  }
  for (const key of ['min', 'max', 'precision'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
      errors.push(`${path}.${key} is invalid`);
    }
  }
  if (value.kind === 'dropdown') {
    if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > 128
      || value.options.some((option) => !object(option)
        || !boundedText(option.label, 128) || !boundedText(option.value, 256))) {
      errors.push(`${path}.options is required for a dropdown`);
    }
  } else if (value.options !== undefined) {
    errors.push(`${path}.options is only valid for a dropdown`);
  }
  return true;
}

function validateBlock(value: unknown, path: string, evidenceIds: Set<string>, errors: string[]): value is LibraryBlockDefinition {
  if (!object(value) || !boundedText(value.type, 128) || !SAFE_ID.test(value.type)
    || !boundedText(value.message, 512) || !Array.isArray(value.inputs) || value.inputs.length > 32
    || (value.shape !== 'statement' && value.shape !== 'value') || !validColour(value.colour)
    || !boundedText(value.tooltip, 1_024) || !object(value.code) || !boundedText(value.code.body, 16_384)
    || !Array.isArray(value.evidence) || value.evidence.length > 64) {
    errors.push(`${path} is invalid`);
    return false;
  }
  if (value.helpUrl !== undefined && !boundedText(value.helpUrl, 2_048)) errors.push(`${path}.helpUrl is invalid`);
  if (value.shape === 'value' && !(boundedText(value.output, 64)
    || (Array.isArray(value.output) && value.output.length > 0 && value.output.every((item) => boundedText(item, 64))))) {
    errors.push(`${path}.output is required for a value block`);
  }
  if (value.shape === 'statement' && value.output !== undefined) errors.push(`${path}.output is only valid for value blocks`);
  const names = new Set<string>();
  value.inputs.forEach((input, index) => {
    validateInput(input, `${path}.inputs[${index}]`, errors);
    if (object(input) && typeof input.name === 'string') {
      if (names.has(input.name)) errors.push(`${path}.inputs[${index}].name is duplicated`);
      names.add(input.name);
    }
  });
  validCodeUnits(value.code.includes, `${path}.code.includes`, errors);
  validCodeUnits(value.code.globals, `${path}.code.globals`, errors);
  validCodeUnits(value.code.setup, `${path}.code.setup`, errors);
  const code = value.code as unknown as BlockCodeTemplate;
  for (const template of [
    code.body,
    ...(code.includes ?? []).map((unit) => unit.code),
    ...(code.globals ?? []).map((unit) => unit.code),
    ...(code.setup ?? []).map((unit) => unit.code),
  ]) {
    for (const match of template.matchAll(PLACEHOLDER)) {
      const placeholder = match[1]!;
      if (!placeholder.startsWith('var:') && !names.has(placeholder)) {
        errors.push(`${path}.code references unknown input ${placeholder}`);
      }
    }
  }
  value.evidence.forEach((id) => {
    if (!boundedText(id, 128) || !evidenceIds.has(id)) errors.push(`${path}.evidence references unknown evidence ${String(id)}`);
  });
  return true;
}

export function createBlocksMetadata(body: BlocksMetadataBody): BlocksMetadata {
  return { ...body, metadataSha256: hashJson(body as unknown as JsonValue) };
}

export function validateBlocksMetadata(value: unknown): BlocksValidationResult {
  const errors: string[] = [];
  if (!object(value)) return { valid: false, errors: ['blocks metadata must be an object'] };
  if (value.schema !== CK_BLOCKS_SCHEMA || value.kind !== CK_BLOCKS_KIND) errors.push('schema/kind is unsupported');
  if (!object(value.library) || !boundedText(value.library.name, 256)
    || !boundedText(value.library.version, 128) || !SHA256.test(String(value.library.sourceSha256))) {
    errors.push('library identity is invalid');
  }
  if (!boundedText(value.generatedAt, 64) || !Number.isFinite(Date.parse(String(value.generatedAt)))) {
    errors.push('generatedAt is invalid');
  }
  if (!object(value.review) || !['draft', 'approved', 'rejected'].includes(String(value.review.status))) {
    errors.push('review status is invalid');
  } else {
    if (value.review.reviewer !== undefined && !boundedText(value.review.reviewer, 128)) errors.push('reviewer is invalid');
    if (value.review.reviewedAt !== undefined
      && (!boundedText(value.review.reviewedAt, 64) || !Number.isFinite(Date.parse(value.review.reviewedAt)))) {
      errors.push('reviewedAt is invalid');
    }
    if (value.review.notes !== undefined && !boundedText(value.review.notes, 4_096, true)) errors.push('review notes are invalid');
    if (value.review.status === 'approved' && (!value.review.reviewer || !value.review.reviewedAt)) {
      errors.push('approved metadata requires reviewer and reviewedAt');
    }
  }
  if (!object(value.category) || !boundedText(value.category.id, 128) || !SAFE_ID.test(String(value.category.id))
    || !boundedText(value.category.name, 128) || !validColour(value.category.colour)) {
    errors.push('category is invalid');
  }
  const evidenceIds = new Set<string>();
  if (!Array.isArray(value.evidence) || value.evidence.length > 2_048) errors.push('evidence array is invalid');
  else value.evidence.forEach((item, index) => {
    if (!object(item) || !boundedText(item.id, 128) || !SAFE_ID.test(item.id)
      || !['header', 'keyword', 'example'].includes(String(item.kind)) || !validPath(item.file)
      || !Number.isSafeInteger(item.line) || Number(item.line) < 1 || !boundedText(item.excerpt, 2_048)
      || !SHA256.test(String(item.sha256))) {
      errors.push(`evidence[${index}] is invalid`);
      return;
    }
    if (evidenceIds.has(item.id)) errors.push(`evidence[${index}].id is duplicated`);
    evidenceIds.add(item.id);
  });
  const blockTypes = new Set<string>();
  if (!Array.isArray(value.blocks) || value.blocks.length > 512) errors.push('blocks array is invalid');
  else value.blocks.forEach((block, index) => {
    validateBlock(block, `blocks[${index}]`, evidenceIds, errors);
    if (object(block) && typeof block.type === 'string') {
      if (blockTypes.has(block.type)) errors.push(`blocks[${index}].type is duplicated`);
      blockTypes.add(block.type);
    }
  });
  if (!SHA256.test(String(value.metadataSha256))) errors.push('metadataSha256 is invalid');
  else {
    const { metadataSha256: _digest, ...body } = value;
    if (hashJson(body as JsonValue) !== value.metadataSha256) errors.push('metadataSha256 does not match the body');
  }
  return errors.length === 0 ? { valid: true, errors, value: value as unknown as BlocksMetadata } : { valid: false, errors };
}

export function parseBlocksMetadata(value: unknown): BlocksMetadata {
  const result = validateBlocksMetadata(value);
  if (!result.valid || !result.value) throw new TypeError(result.errors.join('; '));
  return result.value;
}

export function publicBlocksMetadata(value: BlocksMetadata | null | undefined): BlocksMetadata | null {
  return value?.review.status === 'approved' ? value : null;
}
