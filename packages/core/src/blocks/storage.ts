import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseBlocksMetadata, type BlocksMetadata } from './schema.js';

export const BLOCKS_METADATA_FILE = 'blocks.json';
const MAX_BLOCKS_METADATA_BYTES = 4 * 1024 * 1024;

export function readBlocksMetadata(root: string, strict = false): BlocksMetadata | null {
  const path = join(root, BLOCKS_METADATA_FILE);
  if (!existsSync(path)) return null;
  try {
    const info = statSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > MAX_BLOCKS_METADATA_BYTES) {
      throw new TypeError('blocks.json size or file type is invalid');
    }
    return parseBlocksMetadata(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

export function writeBlocksMetadata(root: string, metadata: BlocksMetadata): string {
  const value = parseBlocksMetadata(metadata);
  const path = join(root, BLOCKS_METADATA_FILE);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
  return path;
}
