import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import type { Library } from '../toolchain/library.js';
import { scan, offsetToLine } from '../preprocess/scanner.js';
import { sha256Hex } from '../build-ir/canonical.js';
import {
  CK_BLOCKS_KIND,
  CK_BLOCKS_SCHEMA,
  createBlocksMetadata,
  type BlockEvidence,
  type BlockInputDefinition,
  type BlocksMetadata,
  type LibraryBlockDefinition,
} from './schema.js';

const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_FILES = 512;
const MAX_DRAFT_BLOCKS = 128;
const HEADER_EXTENSIONS = new Set(['.h', '.hh', '.hpp', '.hxx']);
const EXAMPLE_EXTENSIONS = new Set(['.ino', '.c', '.cc', '.cpp', '.cxx']);
const DECLARATION = /(?:^|(?<=[;{}]))\s*(?:(?:public|private|protected)\s*:\s*)?(?<prefix>(?:(?:virtual|static|inline|constexpr|friend|explicit)\s+)*)(?<returns>[A-Za-z_][A-Za-z0-9_:<>, \t*&]*?)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*\((?<args>[^(){};]*)\)\s*(?<suffix>(?:const\s*)?(?:noexcept\s*)?(?:=\s*0\s*)?);/gm;
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'decltype']);

interface SourceFile {
  path: string;
  relativePath: string;
  content: string;
  sha256: string;
}

interface ClassRange {
  name: string;
  kind: 'class' | 'struct';
  start: number;
  open: number;
  end: number;
}

interface ApiDraft {
  name: string;
  returns: string;
  args: Array<{ type: string; name: string }>;
  owner?: string;
  isStatic: boolean;
  source: SourceFile;
  offset: number;
  excerpt: string;
}

function safeId(value: string, fallback = 'library'): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  const base = normalized || fallback;
  return /^[a-z]/.test(base) ? base : `lib_${base}`;
}

function sourceFile(root: string, path: string): SourceFile | null {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SOURCE_FILE_BYTES) return null;
    const content = readFileSync(path, 'utf8');
    return {
      path,
      relativePath: relative(root, path).replaceAll('\\', '/'),
      content,
      sha256: sha256Hex(content),
    };
  } catch {
    return null;
  }
}

function walk(root: string, dir: string, extensions: ReadonlySet<string>, output: SourceFile[]): void {
  if (output.length >= MAX_SOURCE_FILES) return;
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return; }
  for (const name of names) {
    if (output.length >= MAX_SOURCE_FILES) break;
    const path = join(dir, name);
    let info;
    try { info = statSync(path); } catch { continue; }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) walk(root, path, extensions, output);
    else if (extensions.has(extname(name).toLowerCase())) {
      const file = sourceFile(root, path);
      if (file) output.push(file);
    }
  }
}

function inspectedSources(library: Library): { headers: SourceFile[]; examples: SourceFile[]; keywords: SourceFile | null } {
  const headers = library.allFiles
    .filter((path) => HEADER_EXTENSIONS.has(extname(path).toLowerCase()))
    .sort()
    .map((path) => sourceFile(library.rootDir, path))
    .filter((file): file is SourceFile => file !== null);
  const examples: SourceFile[] = [];
  walk(library.rootDir, join(library.rootDir, 'examples'), EXAMPLE_EXTENSIONS, examples);
  const keywords = sourceFile(library.rootDir, join(library.rootDir, 'keywords.txt'));
  const all = [...headers, ...examples, ...(keywords ? [keywords] : [])];
  let bytes = 0;
  const allowed = new Set<string>();
  for (const file of all.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const size = Buffer.byteLength(file.content, 'utf8');
    if (bytes + size > MAX_SOURCE_TOTAL_BYTES) continue;
    bytes += size;
    allowed.add(file.path);
  }
  return {
    headers: headers.filter((file) => allowed.has(file.path)),
    examples: examples.filter((file) => allowed.has(file.path)),
    keywords: keywords && allowed.has(keywords.path) ? keywords : null,
  };
}

function sourceIdentity(files: readonly SourceFile[]): string {
  return sha256Hex(files
    .map((file) => `${file.relativePath}\0${file.sha256}\0${Buffer.byteLength(file.content, 'utf8')}`)
    .sort()
    .join('\n'));
}

function matchingBrace(masked: string, open: number): number {
  let depth = 0;
  for (let index = open; index < masked.length; index++) {
    if (masked[index] === '{') depth++;
    else if (masked[index] === '}' && --depth === 0) return index;
  }
  return masked.length;
}

function classes(masked: string): ClassRange[] {
  const result: ClassRange[] = [];
  const pattern = /\b(class|struct)\s+([A-Za-z_][A-Za-z0-9_]*)[^;{]*\{/g;
  for (const match of masked.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf('{');
    result.push({
      kind: match[1] as 'class' | 'struct', name: match[2]!,
      start: match.index ?? 0, open, end: matchingBrace(masked, open),
    });
  }
  return result;
}

function publicAt(masked: string, range: ClassRange, offset: number): boolean {
  const prefix = masked.slice(range.open + 1, offset);
  const matches = [...prefix.matchAll(/\b(public|private|protected)\s*:/g)];
  if (matches.length === 0) return range.kind === 'struct';
  return matches.at(-1)?.[1] === 'public';
}

function splitArguments(raw: string): string[] | null {
  if (!raw.trim() || raw.trim() === 'void') return [];
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === '<' || char === '[' || char === '(') depth++;
    else if (char === '>' || char === ']' || char === ')') depth--;
    else if (char === ',' && depth === 0) {
      result.push(raw.slice(start, index));
      start = index + 1;
    }
    if (depth < 0 || depth > 8) return null;
  }
  if (depth !== 0) return null;
  result.push(raw.slice(start));
  return result;
}

function parseArguments(raw: string): Array<{ type: string; name: string }> | null {
  const values = splitArguments(raw);
  if (!values || values.length > 12) return null;
  return values.map((argument, index) => {
    const withoutDefault = argument.replace(/\s*=.*$/, '').trim();
    const match = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*$/.exec(withoutDefault);
    if (!match) return { type: withoutDefault, name: `arg${index + 1}` };
    return {
      type: withoutDefault.slice(0, match.index).trim() || 'auto',
      name: match[1]!,
    };
  });
}

function apis(file: SourceFile): ApiDraft[] {
  const scanned = scan(file.content);
  const ranges = classes(scanned.masked);
  const result: ApiDraft[] = [];
  for (const match of scanned.masked.matchAll(DECLARATION)) {
    const name = match.groups?.name ?? '';
    if (!name || CONTROL_WORDS.has(name) || name.startsWith('operator')) continue;
    const matchOffset = match.index ?? 0;
    const offset = matchOffset + match[0].lastIndexOf(name);
    const owner = ranges
      .filter((range) => offset > range.open && offset < range.end)
      .sort((left, right) => left.end - left.open - (right.end - right.open))[0];
    if (owner && !publicAt(scanned.masked, owner, offset)) continue;
    const args = parseArguments(match.groups?.args ?? '');
    if (!args) continue;
    const excerpt = file.content.slice(matchOffset, matchOffset + match[0].length).replace(/\s+/g, ' ').trim().slice(0, 500);
    result.push({
      name,
      returns: (match.groups?.returns ?? 'void').replace(/\s+/g, ' ').trim(),
      args,
      ...(owner ? { owner: owner.name } : {}),
      isStatic: /\bstatic\b/.test(match.groups?.prefix ?? ''),
      source: file,
      offset,
      excerpt,
    });
  }
  return result;
}

function inputForArgument(argument: { type: string; name: string }): BlockInputDefinition {
  const type = argument.type.replace(/\bconst\b/g, '').trim();
  const lowerName = argument.name.toLowerCase();
  if (/\b(bool|boolean)\b/i.test(type)) return { name: argument.name, label: argument.name, kind: 'boolean', default: false };
  if (/\b(char\s*\*|String\b|string\b)/i.test(type)) return { name: argument.name, label: argument.name, kind: 'text', default: '' };
  if (/(?:^|_)(?:pin|gpio)(?:$|_)/i.test(lowerName) || /^(?:pin|gpio)/i.test(lowerName)) {
    return { name: argument.name, label: argument.name, kind: 'pin', default: '0' };
  }
  if (/\b(?:u?int(?:8|16|32|64)?_t|u?long|u?short|u?int|float|double|size_t|byte)\b/i.test(type)) {
    return { name: argument.name, label: argument.name, kind: 'number', default: 0 };
  }
  return { name: argument.name, label: argument.name, kind: 'value', check: type || 'Any', default: '0' };
}

function evidenceFor(file: SourceFile, offset: number, excerpt: string, kind: BlockEvidence['kind']): BlockEvidence {
  const id = `evidence:${sha256Hex(`${file.relativePath}\0${offset}\0${excerpt}`).slice(0, 24)}`;
  const scanned = scan(file.content);
  return {
    id,
    kind,
    file: file.relativePath,
    line: offsetToLine(scanned.lineStarts, offset),
    excerpt,
    sha256: sha256Hex(excerpt),
  };
}

function keywordSymbols(file: SourceFile | null): Map<string, BlockEvidence> {
  const result = new Map<string, BlockEvidence>();
  if (!file) return result;
  let offset = 0;
  for (const line of file.content.split(/\r?\n/)) {
    const symbol = line.trim().split(/\s+/)[0];
    if (symbol && /^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol)) {
      result.set(symbol, evidenceFor(file, offset, line.trim().slice(0, 500), 'keyword'));
    }
    offset += line.length + 1;
  }
  return result;
}

function exampleEvidence(symbol: string, files: readonly SourceFile[]): BlockEvidence | null {
  const pattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
  for (const file of files) {
    const match = pattern.exec(scan(file.content).masked);
    if (!match) continue;
    const lineStart = file.content.lastIndexOf('\n', match.index) + 1;
    const lineEnd = file.content.indexOf('\n', match.index);
    const excerpt = file.content.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim().slice(0, 500);
    return evidenceFor(file, match.index, excerpt, 'example');
  }
  return null;
}

function blockForApi(library: Library, api: ApiDraft, evidenceIds: string[]): LibraryBlockDefinition {
  const inputs: BlockInputDefinition[] = [];
  if (api.owner && !api.isStatic) inputs.push({ name: 'instance', label: 'instance', kind: 'variable', default: safeId(api.owner) });
  inputs.push(...api.args.map(inputForArgument));
  const args = api.args.map((argument) => `{{${argument.name}}}`).join(', ');
  const invocation = api.owner
    ? api.isStatic ? `${api.owner}::${api.name}(${args})` : `{{instance}}.${api.name}(${args})`
    : `${api.name}(${args})`;
  const isValue = !/^(?:void|auto)$/i.test(api.returns.replace(/\b(?:static|inline|constexpr|virtual)\b/g, '').trim());
  const suffix = sha256Hex(`${api.owner ?? ''}:${api.name}:${api.args.map((arg) => arg.type).join(',')}`).slice(0, 8);
  return {
    type: `${safeId(library.manifest.name)}_${safeId(api.owner ? `${api.owner}_${api.name}` : api.name)}_${suffix}`,
    message: [api.owner ? `${api.owner}.${api.name}` : api.name, ...inputs.map((input, index) => `${input.label} %${index + 1}`)].join(' '),
    inputs,
    shape: isValue ? 'value' : 'statement',
    ...(isValue ? { output: api.returns.slice(0, 64) } : {}),
    colour: Number.parseInt(sha256Hex(library.manifest.name).slice(0, 4), 16) % 361,
    tooltip: `${api.excerpt} (draft; requires human review)`,
    ...(library.manifest.url ? { helpUrl: library.manifest.url } : {}),
    code: {
      includes: [{
        key: `include:${safeId(library.manifest.name)}`,
        code: `#include <${library.manifest.includes[0] ?? basename(api.source.path)}>`,
      }],
      body: `${invocation}${isValue ? '' : ';'}`,
    },
    evidence: evidenceIds,
  };
}

export interface CollectLibraryBlocksOptions {
  generatedAt?: string;
}

export function collectLibraryBlocks(
  library: Library,
  options: CollectLibraryBlocksOptions = {},
): BlocksMetadata {
  const sources = inspectedSources(library);
  const inspected = [...sources.headers, ...sources.examples, ...(sources.keywords ? [sources.keywords] : [])];
  const keywords = keywordSymbols(sources.keywords);
  const evidence = new Map<string, BlockEvidence>();
  const candidates = sources.headers.flatMap(apis)
    .sort((left, right) => (
      Number(keywords.has(right.name)) - Number(keywords.has(left.name))
      || left.source.relativePath.localeCompare(right.source.relativePath)
      || left.offset - right.offset
    ))
    .slice(0, MAX_DRAFT_BLOCKS);
  const blocks = candidates.map((api) => {
    const ids: string[] = [];
    const header = evidenceFor(api.source, api.offset, api.excerpt, 'header');
    evidence.set(header.id, header);
    ids.push(header.id);
    const keyword = keywords.get(api.name);
    if (keyword) {
      evidence.set(keyword.id, keyword);
      ids.push(keyword.id);
    }
    const example = exampleEvidence(api.name, sources.examples);
    if (example) {
      evidence.set(example.id, example);
      ids.push(example.id);
    }
    return blockForApi(library, api, ids);
  });
  const sourceSha256 = sourceIdentity(inspected);
  return createBlocksMetadata({
    schema: CK_BLOCKS_SCHEMA,
    kind: CK_BLOCKS_KIND,
    library: { name: library.manifest.name, version: library.manifest.version, sourceSha256 },
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    review: { status: 'draft' },
    category: {
      id: `category:${safeId(library.manifest.name)}`,
      name: library.manifest.name,
      colour: Number.parseInt(sha256Hex(library.manifest.name).slice(0, 4), 16) % 361,
    },
    blocks,
    evidence: [...evidence.values()].sort((left, right) => left.id.localeCompare(right.id)),
  });
}

export function libraryBlocksSourceSha256(library: Library): string {
  const sources = inspectedSources(library);
  return sourceIdentity([...sources.headers, ...sources.examples, ...(sources.keywords ? [sources.keywords] : [])]);
}

export function reviewBlocksMetadata(
  metadata: BlocksMetadata,
  status: 'approved' | 'rejected',
  reviewer: string,
  notes?: string,
  reviewedAt = new Date().toISOString(),
): BlocksMetadata {
  const { metadataSha256: _digest, ...body } = metadata;
  return createBlocksMetadata({
    ...body,
    review: {
      status,
      reviewer: reviewer.trim(),
      reviewedAt,
      ...(notes?.trim() ? { notes: notes.trim() } : {}),
    },
  });
}
