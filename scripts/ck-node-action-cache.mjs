import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_ENTRY_BYTES = 48 * 1024 * 1024;

/** Content-addressed Action cache for Node-based browser executor verification. */
export class NodeFilesystemActionCache {
  constructor(directory, { maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES } = {}) {
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new TypeError('Node Action cache directory is required');
    }
    if (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes <= 0) {
      throw new TypeError('Node Action cache entry limit is invalid');
    }
    this.directory = resolve(directory);
    this.maxEntryBytes = maxEntryBytes;
  }

  async get(actionKey) {
    if (!SHA256.test(actionKey)) return null;
    const path = this.#entryPath(actionKey);
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength > this.maxEntryBytes) return null;
      const record = JSON.parse(bytes.toString('utf8'));
      if (record?.schema !== 1 || record.actionKey !== actionKey || !Array.isArray(record.outputs)) return null;
      const outputs = [];
      for (const output of record.outputs) {
        if (
          typeof output?.path !== 'string'
          || !SHA256.test(output.sha256)
          || typeof output.base64 !== 'string'
        ) return null;
        const decoded = Buffer.from(output.base64, 'base64');
        if (decoded.toString('base64') !== output.base64) return null;
        outputs.push({ path: output.path, sha256: output.sha256, bytes: new Uint8Array(decoded) });
      }
      return { actionKey, outputs };
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
      return null;
    }
  }

  async put(entry) {
    if (!entry || !SHA256.test(entry.actionKey) || !Array.isArray(entry.outputs)) return;
    const outputs = [];
    for (const output of entry.outputs) {
      if (typeof output?.path !== 'string' || !SHA256.test(output.sha256)) return;
      const bytes = asBytes(output.bytes);
      if (!bytes) return;
      outputs.push({ path: output.path, sha256: output.sha256, base64: Buffer.from(bytes).toString('base64') });
    }
    const encoded = Buffer.from(`${JSON.stringify({ schema: 1, actionKey: entry.actionKey, outputs })}\n`, 'utf8');
    if (encoded.byteLength > this.maxEntryBytes) return;

    const path = this.#entryPath(entry.actionKey);
    const directory = join(this.directory, entry.actionKey.slice(0, 2));
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, encoded, { flag: 'wx' });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    }
  }

  #entryPath(actionKey) {
    return join(this.directory, actionKey.slice(0, 2), `${actionKey}.json`);
  }
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}
