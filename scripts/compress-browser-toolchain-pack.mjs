#!/usr/bin/env node

/**
 * Convert an existing verified CK Pack to explicit gzip transport chunks.
 * Artifact identity remains the digest of the decoded bytes; transport bytes
 * receive their own content-addressed path, size, and digest.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/;
const DEFAULT_MINIMUM_SAVING = 1024;
const PUBLISHED_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'web', 'public');

export function compressBrowserToolchainPack(manifestPath, {
  minimumSaving = DEFAULT_MINIMUM_SAVING,
  removeReplacedChunks = true,
} = {}) {
  const path = resolve(manifestPath);
  refusePublishedPackMutation(path);
  requireFile(path, 'Pack manifest');
  if (!Number.isSafeInteger(minimumSaving) || minimumSaving < 0) {
    throw new TypeError('minimum gzip saving must be a non-negative integer');
  }
  const root = dirname(path);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  validateManifestShape(manifest);
  const previousRevision = manifest.revision;
  const replaced = [];
  let rawBytes = 0;
  let downloadBytes = 0;

  for (const artifact of manifest.artifacts) {
    let artifactBytes = 0;
    const artifactHash = createHash('sha256');
    for (const chunk of artifact.chunks) {
      const oldPath = resolveChunk(root, chunk.path);
      requireFile(oldPath, `Pack chunk ${chunk.path}`);
      const transport = readFileSync(oldPath);
      const expectedTransportSize = chunk.compressedSize ?? chunk.size;
      const expectedTransportSha256 = chunk.compressedSha256 ?? chunk.sha256;
      if (transport.byteLength !== expectedTransportSize || sha256(transport) !== expectedTransportSha256) {
        throw new Error(`Pack chunk transport integrity mismatch: ${chunk.path}`);
      }
      let decoded;
      if (chunk.compression === undefined) decoded = transport;
      else if (chunk.compression === 'gzip') {
        try { decoded = gunzipSync(transport); }
        catch { throw new Error(`Pack gzip chunk is invalid: ${chunk.path}`); }
      } else throw new Error(`Pack chunk compression is unsupported: ${chunk.compression}`);
      if (decoded.byteLength !== chunk.size || sha256(decoded) !== chunk.sha256) {
        throw new Error(`Pack decoded chunk integrity mismatch: ${chunk.path}`);
      }

      artifactBytes += decoded.byteLength;
      artifactHash.update(decoded);
      rawBytes += decoded.byteLength;
      const compressed = gzipSync(decoded, { level: 9 });
      if (compressed.byteLength + minimumSaving < decoded.byteLength) {
        const compressedSha256 = sha256(compressed);
        const compressedPath = contentAddressedPath(chunk.path, compressedSha256, true);
        const output = resolveChunk(root, compressedPath);
        if (existsSync(output)) {
          const existing = readFileSync(output);
          if (existing.byteLength !== compressed.byteLength || sha256(existing) !== compressedSha256) {
            throw new Error(`immutable gzip chunk contains different bytes: ${compressedPath}`);
          }
        } else writeFileSync(output, compressed);
        if (compressedPath !== chunk.path) replaced.push(oldPath);
        chunk.path = compressedPath;
        chunk.compression = 'gzip';
        chunk.compressedSize = compressed.byteLength;
        chunk.compressedSha256 = compressedSha256;
        downloadBytes += compressed.byteLength;
      } else {
        const rawPath = contentAddressedPath(chunk.path, chunk.sha256, false);
        const output = resolveChunk(root, rawPath);
        if (rawPath !== chunk.path) {
          if (existsSync(output)) {
            const existing = readFileSync(output);
            if (existing.byteLength !== decoded.byteLength || sha256(existing) !== chunk.sha256) {
              throw new Error(`immutable raw chunk contains different bytes: ${rawPath}`);
            }
          } else writeFileSync(output, decoded);
          replaced.push(oldPath);
        }
        chunk.path = rawPath;
        delete chunk.compression;
        delete chunk.compressedSize;
        delete chunk.compressedSha256;
        downloadBytes += decoded.byteLength;
      }
    }
    if (artifactBytes !== artifact.size || artifactHash.digest('hex') !== artifact.sha256) {
      throw new Error(`Pack artifact integrity mismatch: ${artifact.id}`);
    }
  }

  manifest.revision = manifestRevision(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (removeReplacedChunks) {
    const referenced = new Set(manifest.artifacts.flatMap((artifact) => (
      artifact.chunks.map((chunk) => resolveChunk(root, chunk.path))
    )));
    for (const oldPath of new Set(replaced)) {
      if (!referenced.has(oldPath)) rmSync(oldPath, { force: true });
    }
  }
  return Object.freeze({
    manifest: path,
    id: manifest.id,
    previousRevision,
    revision: manifest.revision,
    rawBytes,
    downloadBytes,
    savingBytes: rawBytes - downloadBytes,
  });
}

function refusePublishedPackMutation(path) {
  const location = relative(PUBLISHED_ROOT, path);
  if (location === '' || (location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location))) {
    throw new Error(
      `refusing to mutate a published Pack in place; compress a staging Pack and republish it: ${path}`,
    );
  }
}

export function manifestRevision(manifest) {
  return sha256(Buffer.from(JSON.stringify({
    schema: manifest.schema,
    id: manifest.id,
    version: manifest.version,
    artifacts: manifest.artifacts,
  }), 'utf8'));
}

function validateManifestShape(manifest) {
  if (
    manifest?.schema !== 1
    || !IDENTIFIER.test(manifest.id)
    || typeof manifest.version !== 'string'
    || !SHA256.test(manifest.revision)
    || !Array.isArray(manifest.artifacts)
    || !manifest.artifacts.length
  ) throw new Error('Pack manifest is invalid');
  if (manifestRevision(manifest) !== manifest.revision) throw new Error('Pack manifest revision mismatch');
  for (const artifact of manifest.artifacts) {
    if (
      !IDENTIFIER.test(artifact?.id)
      || !Number.isSafeInteger(artifact.size)
      || artifact.size <= 0
      || !SHA256.test(artifact.sha256)
      || !Array.isArray(artifact.chunks)
      || !artifact.chunks.length
    ) throw new Error(`Pack artifact is invalid: ${String(artifact?.id)}`);
    for (const chunk of artifact.chunks) {
      if (
        typeof chunk?.path !== 'string'
        || !Number.isSafeInteger(chunk.size)
        || chunk.size <= 0
        || !SHA256.test(chunk.sha256)
      ) throw new Error(`Pack chunk is invalid: ${artifact.id}`);
    }
  }
}

function contentAddressedPath(previous, digest, compressed) {
  if (!SHA256.test(digest)) throw new Error('Pack chunk digest is invalid');
  const normalized = previous.replaceAll('\\', '/');
  const slash = normalized.lastIndexOf('/');
  const directory = slash >= 0 ? normalized.slice(0, slash + 1) : '';
  const filename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const stem = filename.replace(/-[a-f0-9]{16}\.bin(?:\.gz)?$/, '').replace(/\.bin(?:\.gz)?$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(stem)) throw new Error(`Pack chunk name is invalid: ${previous}`);
  return `${directory}${stem}-${digest.slice(0, 16)}.bin${compressed ? '.gz' : ''}`;
}

function resolveChunk(root, path) {
  if (typeof path !== 'string' || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new Error(`Pack chunk path is invalid: ${String(path)}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Pack chunk path is invalid: ${path}`);
  }
  const output = resolve(root, ...segments);
  const value = relative(root, output);
  if (!value || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`Pack chunk escapes its directory: ${path}`);
  }
  return output;
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(argv) {
  const manifests = [];
  let keepRaw = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--keep-raw') { keepRaw = true; continue; }
    if (argument !== '--manifest') throw new Error(`unknown argument: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error('--manifest requires a path');
    manifests.push(resolve(value));
  }
  if (!manifests.length) throw new Error('at least one --manifest is required');
  return { manifests, keepRaw };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    for (const manifest of options.manifests) {
      const result = compressBrowserToolchainPack(manifest, { removeReplacedChunks: !options.keepRaw });
      console.log(`${relative(process.cwd(), result.manifest)} ${result.id}@${result.revision}`);
      console.log(`  ${(result.rawBytes / 1024 / 1024).toFixed(2)} MiB raw -> ${(result.downloadBytes / 1024 / 1024).toFixed(2)} MiB download`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  }
}
