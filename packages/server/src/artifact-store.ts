import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  type BigIntStats,
} from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Artifact, CompileResult } from '@arduinofast/core';
import { prefixPublicPath } from './public-base-path.js';

const SAFE_SHA256 = /^[a-f0-9]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const SAFE_BUCKET = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;
const SAFE_PREFIX_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const METADATA_FILE = /^([a-f0-9]{64})\.meta\.json$/;
const TEMP_FILE = /^\.[a-f0-9]{64}(?:\.meta)?\.\d+\.[0-9a-f-]{36}\.tmp$/;
const TEMP_FILE_GRACE_MS = 5 * 60 * 1_000;
const MAX_METADATA_BYTES = 2 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;

export interface ArtifactDownload {
  body: Readable;
  size: number;
  sha256: string;
}

export interface ArtifactStore {
  readonly kind: 'local' | 's3';
  externalize(result: CompileResult): Promise<CompileResult>;
  open(sha256: string, name: string): Promise<ArtifactDownload | null>;
  redirectUrl?(sha256: string, name: string): Promise<string | null>;
  close?(): Promise<void> | void;
}

export interface ArtifactStoreOptions {
  rootDir: string;
  publicBasePath?: string;
  maxArtifactBytes?: number;
  ttlMs?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
}

export interface ArtifactStoreFactoryOptions extends ArtifactStoreOptions {
  env?: NodeJS.ProcessEnv;
}

export interface S3ArtifactStoreOptions {
  client: S3Client;
  bucket: string;
  prefix?: string;
  publicBasePath?: string;
  maxArtifactBytes?: number;
  requestTimeoutMs?: number;
  publicBaseUrl?: string;
  presignExpiresSeconds?: number;
  signer?: S3ArtifactUrlSigner;
  spoolDir?: string;
}

interface LocalArtifactMetadata {
  version: 1;
  sha256: string;
  size: number;
  dev: string;
  ino: string;
  mtimeNs: string;
  ctimeNs: string;
}

interface OpenedLocalFile {
  handle: FileHandle;
  stat: BigIntStats;
}

export type S3ArtifactUrlSigner = (
  client: S3Client,
  command: GetObjectCommand,
  expiresIn: number,
) => Promise<string>;

export class ArtifactStoreUnavailableError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ArtifactStoreUnavailableError';
    this.cause = cause;
  }
}

function normalizePublicBasePath(value: string | undefined): string {
  return (value ?? '/v1/artifacts').replace(/\/$/, '');
}

function normalizePublicBaseUrl(value: string | undefined, production = false): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('AF_ARTIFACT_PUBLIC_BASE_URL must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('AF_ARTIFACT_PUBLIC_BASE_URL must be a credential-free http(s) URL without query or fragment');
  }
  if (production && url.protocol !== 'https:') {
    throw new Error('production AF_ARTIFACT_PUBLIC_BASE_URL must use HTTPS');
  }
  return url.toString().replace(/\/$/, '');
}

function assertArtifactAddress(artifact: Artifact): void {
  if (!SAFE_NAME.test(artifact.name)) throw new Error(`invalid artifact name: ${artifact.name}`);
  if (!SAFE_SHA256.test(artifact.sha256)) throw new Error(`invalid artifact sha256: ${artifact.sha256}`);
}

function decodeArtifact(artifact: Artifact, maxArtifactBytes: number): Buffer | null {
  assertArtifactAddress(artifact);
  if (artifact.base64 === undefined) {
    if (!artifact.url) throw new Error(`artifact ${artifact.name} has no body or URL`);
    return null;
  }

  const body = Buffer.from(artifact.base64, 'base64');
  if (body.length !== artifact.size) throw new Error(`artifact ${artifact.name} size mismatch`);
  if (body.length > maxArtifactBytes) throw new Error(`artifact ${artifact.name} exceeds storage limit`);
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest !== artifact.sha256) throw new Error(`artifact ${artifact.name} checksum mismatch`);
  return body;
}

function publicArtifact(artifact: Artifact, size: number, publicBasePath: string): Artifact {
  return {
    offset: artifact.offset,
    name: artifact.name,
    sha256: artifact.sha256,
    size,
    url: `${publicBasePath}/${artifact.sha256}/${encodeURIComponent(artifact.name)}`,
  };
}

function normalizeS3Prefix(value: string | undefined): string {
  const normalized = (value ?? 'artifacts').trim().replace(/^\/+|\/+$/g, '');
  if (!normalized) throw new Error('AF_ARTIFACT_S3_PREFIX must not be empty');
  const segments = normalized.split('/');
  if (segments.some((segment) => !SAFE_PREFIX_SEGMENT.test(segment) || segment === '.' || segment === '..')) {
    throw new Error('AF_ARTIFACT_S3_PREFIX contains an invalid key segment');
  }
  return segments.join('/');
}

function positiveEnvInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function optionalBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(`${name} must be 0 or 1`);
}

function optionalNonNegativeEnvInt(env: NodeJS.ProcessEnv, name: string, fallback = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function parseS3Endpoint(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.AF_ARTIFACT_S3_ENDPOINT?.trim();
  if (!raw) return undefined;

  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error('AF_ARTIFACT_S3_ENDPOINT must be an absolute http(s) URL');
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw new Error('AF_ARTIFACT_S3_ENDPOINT must use http or https');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('AF_ARTIFACT_S3_ENDPOINT must not include credentials, query, or fragment');
  }
  const allowInsecureEndpoint = optionalBoolean(env, 'AF_ARTIFACT_S3_ALLOW_INSECURE_ENDPOINT', false);
  if (env.NODE_ENV === 'production' && endpoint.protocol !== 'https:' && !allowInsecureEndpoint) {
    throw new Error('production S3 endpoint must use HTTPS; set AF_ARTIFACT_S3_ALLOW_INSECURE_ENDPOINT=1 only for a trusted private network');
  }
  return endpoint.toString().replace(/\/$/, '');
}

function s3CredentialsFromEnv(env: NodeJS.ProcessEnv): S3ClientConfig['credentials'] | undefined {
  const accessKeyId = env.AF_ARTIFACT_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AF_ARTIFACT_S3_SECRET_ACCESS_KEY?.trim();
  const sessionToken = env.AF_ARTIFACT_S3_SESSION_TOKEN?.trim();
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error('AF_ARTIFACT_S3_ACCESS_KEY_ID and AF_ARTIFACT_S3_SECRET_ACCESS_KEY must be configured together');
  }
  if (sessionToken && !accessKeyId) {
    throw new Error('AF_ARTIFACT_S3_SESSION_TOKEN requires explicit S3 access keys');
  }
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  const status = Number(metadata?.httpStatusCode);
  return Number.isInteger(status) ? status : undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String((error as { name?: unknown } | undefined)?.name ?? '');
}

function isMissingObjectError(error: unknown): boolean {
  return errorName(error) === 'NoSuchKey' || errorName(error) === 'NoSuchObject';
}

function isConditionalWriteError(error: unknown): boolean {
  const name = errorName(error);
  return errorStatus(error) === 409 || errorStatus(error) === 412
    || name === 'ConditionalRequestConflict' || name === 'PreconditionFailed';
}

function isWriteConflict(error: unknown): boolean {
  return errorStatus(error) === 409 || errorName(error) === 'ConditionalRequestConflict';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function destroyBody(body: unknown): void {
  try {
    (body as { destroy?: () => void } | undefined)?.destroy?.();
  } catch {
    // A corrupted or oversized response is discarded; connection cleanup is best effort.
  }
}

function artifactBody(body: unknown): AsyncIterable<unknown> {
  if (!body || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function') {
    throw new ArtifactStoreUnavailableError('object storage returned a non-streaming artifact body');
  }
  return body as AsyncIterable<unknown>;
}

function artifactChunk(chunk: unknown): Buffer {
  if (typeof chunk === 'string') return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new ArtifactStoreUnavailableError('object storage returned an invalid artifact chunk');
}

function exactLengthStream(body: unknown, expectedBytes: number, maxBytes: number): Readable {
  const source = artifactBody(body);
  const stream = Readable.from((async function* streamArtifact(): AsyncGenerator<Buffer> {
    let total = 0;
    try {
      for await (const chunk of source) {
        const part = artifactChunk(chunk);
        total += part.length;
        if (total > maxBytes || total > expectedBytes) {
          destroyBody(body);
          throw new ArtifactStoreUnavailableError('artifact body exceeded its declared size');
        }
        yield part;
      }
      if (total !== expectedBytes) {
        throw new ArtifactStoreUnavailableError('artifact body did not match its declared size');
      }
    } catch (error) {
      if (error instanceof ArtifactStoreUnavailableError) throw error;
      throw new ArtifactStoreUnavailableError('failed while streaming artifact from storage', error);
    }
  })());
  stream.once('close', () => destroyBody(body));
  return stream;
}

function safeContentLength(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function metadataSize(value: string | undefined): number | undefined {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  return safeContentLength(value);
}

async function writeAll(handle: FileHandle, body: Buffer): Promise<void> {
  let offset = 0;
  while (offset < body.length) {
    const { bytesWritten } = await handle.write(body, offset, body.length - offset, null);
    if (bytesWritten <= 0) throw new Error('temporary artifact spool stopped accepting bytes');
    offset += bytesWritten;
  }
}

async function spoolVerifiedBody(
  body: unknown,
  sha256: string,
  maxBytes: number,
  expectedBytes: number | undefined,
  spoolDir: string,
): Promise<ArtifactDownload | null> {
  const source = artifactBody(body);
  const path = join(spoolDir, `.${sha256}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle;
  try {
    await mkdir(spoolDir, { recursive: true });
    handle = await open(path, 'wx+', 0o600);
  } catch (error) {
    destroyBody(body);
    throw new ArtifactStoreUnavailableError('failed to prepare artifact verification spool', error);
  }
  const hash = createHash('sha256');
  let total = 0;
  try {
    for await (const chunk of source) {
      const part = artifactChunk(chunk);
      total += part.length;
      if (total > maxBytes || (expectedBytes !== undefined && total > expectedBytes)) {
        destroyBody(body);
        await handle.close();
        await rm(path, { force: true });
        return null;
      }
      hash.update(part);
      await writeAll(handle, part);
    }
    if ((expectedBytes !== undefined && total !== expectedBytes) || hash.digest('hex') !== sha256) {
      await handle.close();
      await rm(path, { force: true });
      return null;
    }

    const stream = handle.createReadStream({ start: 0, autoClose: true });
    stream.once('close', () => { void rm(path, { force: true }); });
    return { body: stream, size: total, sha256 };
  } catch (error) {
    try { await handle.close(); } catch { /* cleanup is best effort */ }
    try { await rm(path, { force: true }); } catch { /* cleanup is best effort */ }
    if (error instanceof ArtifactStoreUnavailableError) throw error;
    throw new ArtifactStoreUnavailableError('failed while reading artifact from object storage', error);
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function localMetadata(sha256: string, stat: BigIntStats): LocalArtifactMetadata {
  return {
    version: 1,
    sha256,
    size: Number(stat.size),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

function isLocalMetadata(value: unknown): value is LocalArtifactMetadata {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<LocalArtifactMetadata>;
  return item.version === 1
    && typeof item.sha256 === 'string'
    && Number.isSafeInteger(item.size)
    && Number(item.size) >= 0
    && typeof item.dev === 'string'
    && typeof item.ino === 'string'
    && typeof item.mtimeNs === 'string'
    && typeof item.ctimeNs === 'string';
}

function metadataMatches(metadata: LocalArtifactMetadata, sha256: string, stat: BigIntStats): boolean {
  return metadata.sha256 === sha256
    && metadata.size === Number(stat.size)
    && metadata.dev === stat.dev.toString()
    && metadata.ino === stat.ino.toString()
    && metadata.mtimeNs === stat.mtimeNs.toString()
    && metadata.ctimeNs === stat.ctimeNs.toString();
}

/**
 * Local content-addressed firmware storage for development and single-host
 * deployments. Use the S3 store through createArtifactStore for split hosts.
 */
export class ContentAddressedArtifactStore implements ArtifactStore {
  readonly kind = 'local' as const;
  private readonly rootDir: string;
  private readonly publicBasePath: string;
  private readonly maxArtifactBytes: number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private lastPruneAt = 0;

  constructor(options: ArtifactStoreOptions) {
    this.rootDir = options.rootDir;
    this.publicBasePath = normalizePublicBasePath(options.publicBasePath);
    this.maxArtifactBytes = options.maxArtifactBytes ?? 32 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1_000;
    this.maxEntries = options.maxEntries ?? 20_000;
    this.maxTotalBytes = options.maxTotalBytes ?? 4 * 1024 * 1024 * 1024;
    mkdirSync(this.rootDir, { recursive: true });
  }

  async externalize(result: CompileResult): Promise<CompileResult> {
    if (result.status !== 'success') return result;
    const [artifacts, staticArtifacts] = await Promise.all([
      Promise.all(result.artifacts.map((artifact) => this.put(artifact))),
      Promise.all(result.staticArtifacts.map((artifact) => this.put(artifact))),
    ]);
    return { ...result, artifacts, staticArtifacts };
  }

  async put(artifact: Artifact): Promise<Artifact> {
    const body = decodeArtifact(artifact, this.maxArtifactBytes);
    if (!body) return artifact;

    const path = this.pathFor(artifact.sha256);
    const current = await this.openVerifiedFile(artifact.sha256);
    if (current) {
      const size = Number(current.stat.size);
      await current.handle.close();
      this.maybePrune();
      return publicArtifact(artifact, size, this.publicBasePath);
    }

    // A killed writer or damaged shared volume must not permanently poison a
    // content address. A complete replacement is published with one rename.
    await Promise.all([
      rm(path, { force: true }),
      rm(this.metadataPathFor(artifact.sha256), { force: true }),
    ]);
    const dir = join(this.rootDir, artifact.sha256.slice(0, 2));
    await mkdir(dir, { recursive: true });
    const temporary = join(dir, `.${artifact.sha256}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
      try {
        await rename(temporary, path);
      } catch (error) {
        // Windows cannot replace an existing destination. A concurrent writer
        // is accepted only when its content address can be verified.
        const winner = await this.openVerifiedFile(artifact.sha256);
        if (!winner) throw error;
        await winner.handle.close();
      }
    } finally {
      try { await rm(temporary, { force: true }); } catch { /* best effort */ }
    }

    const published = await this.openStableFile(path);
    if (!published || Number(published.stat.size) !== body.length) {
      try { await published?.handle.close(); } catch { /* best effort */ }
      throw new Error(`artifact ${artifact.name} failed post-write verification`);
    }
    try {
      await this.publishMetadata(artifact.sha256, published.stat);
    } finally {
      await published.handle.close();
    }
    this.maybePrune();
    return publicArtifact(artifact, body.length, this.publicBasePath);
  }

  async open(sha256: string, name: string): Promise<ArtifactDownload | null> {
    if (!SAFE_SHA256.test(sha256) || !SAFE_NAME.test(name)) return null;
    const opened = await this.openVerifiedFile(sha256);
    if (!opened) return null;
    const size = Number(opened.stat.size);
    try {
      const now = new Date();
      try { await utimes(this.metadataPathFor(sha256), now, now); } catch { /* recency is best effort */ }
      const source = opened.handle.createReadStream({ start: 0, autoClose: true });
      return { body: exactLengthStream(source, size, this.maxArtifactBytes), size, sha256 };
    } catch {
      try { await opened.handle.close(); } catch { /* best effort */ }
      return null;
    }
  }

  private pathFor(sha256: string): string {
    return join(this.rootDir, sha256.slice(0, 2), sha256);
  }

  private metadataPathFor(sha256: string): string {
    return `${this.pathFor(sha256)}.meta.json`;
  }

  private async openStableFile(path: string): Promise<OpenedLocalFile | null> {
    let handle: FileHandle | null = null;
    try {
      handle = await open(path, 'r');
      const [stat, pathStat] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(path, { bigint: true }),
      ]);
      if (!stat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() || !sameFile(stat, pathStat)) {
        await handle.close();
        return null;
      }
      return { handle, stat };
    } catch {
      try { await handle?.close(); } catch { /* best effort */ }
      return null;
    }
  }

  private async openVerifiedFile(sha256: string): Promise<OpenedLocalFile | null> {
    const opened = await this.openStableFile(this.pathFor(sha256));
    if (!opened) return null;
    try {
      const size = Number(opened.stat.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > this.maxArtifactBytes) {
        await opened.handle.close();
        return null;
      }

      const stored = await this.readMetadata(sha256);
      if (!stored || !metadataMatches(stored, sha256, opened.stat)) {
        if (!await this.verifyOpenedFile(opened, sha256)) {
          await opened.handle.close();
          try { await rm(this.metadataPathFor(sha256), { force: true }); } catch { /* best effort */ }
          return null;
        }
        try { await this.publishMetadata(sha256, opened.stat); } catch { /* verified legacy file remains readable */ }
      }
      return opened;
    } catch {
      try { await opened.handle.close(); } catch { /* best effort */ }
      return null;
    }
  }

  private async readMetadata(sha256: string): Promise<LocalArtifactMetadata | null> {
    const opened = await this.openStableFile(this.metadataPathFor(sha256));
    if (!opened) return null;
    try {
      if (opened.stat.size > BigInt(MAX_METADATA_BYTES)) return null;
      const parsed: unknown = JSON.parse(await opened.handle.readFile('utf8'));
      return isLocalMetadata(parsed) ? parsed : null;
    } catch {
      return null;
    } finally {
      await opened.handle.close();
    }
  }

  private async publishMetadata(sha256: string, stat: BigIntStats): Promise<void> {
    const metadata = localMetadata(sha256, stat);
    const path = this.metadataPathFor(sha256);
    const temporary = join(
      this.rootDir,
      sha256.slice(0, 2),
      `.${sha256}.meta.${process.pid}.${randomUUID()}.tmp`,
    );
    await writeFile(temporary, `${JSON.stringify(metadata)}\n`, { flag: 'wx', mode: 0o600 });
    try {
      try {
        await rename(temporary, path);
      } catch (error) {
        const current = await this.readMetadata(sha256);
        if (current && metadataMatches(current, sha256, stat)) return;
        await rm(path, { force: true });
        await rename(temporary, path).catch(() => { throw error; });
      }
    } finally {
      try { await rm(temporary, { force: true }); } catch { /* best effort */ }
    }
  }

  private async verifyOpenedFile(opened: OpenedLocalFile, sha256: string): Promise<boolean> {
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
    let position = 0;
    while (position <= this.maxArtifactBytes) {
      const { bytesRead } = await opened.handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > this.maxArtifactBytes) return false;
      hash.update(chunk.subarray(0, bytesRead));
    }
    return position === Number(opened.stat.size) && hash.digest('hex') === sha256;
  }

  private maybePrune(): void {
    const now = Date.now();
    if (now - this.lastPruneAt < 60_000) return;
    this.lastPruneAt = now;
    const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
    try {
      for (const shard of readdirSync(this.rootDir, { withFileTypes: true })) {
        if (!shard.isDirectory() || shard.isSymbolicLink()) continue;
        const shardPath = join(this.rootDir, shard.name);
        for (const entry of readdirSync(shardPath, { withFileTypes: true })) {
          const path = join(shardPath, entry.name);
          try {
            const stat = lstatSync(path);
            if (!entry.isFile() || stat.isSymbolicLink()) continue;
            if (!SAFE_SHA256.test(entry.name)) {
              // Another worker can be between the temporary write and rename.
              // Only reap our well-known temporary shape after a generous
              // grace period; unrelated files are not trusted or followed.
              if (TEMP_FILE.test(entry.name) && stat.mtimeMs <= now - TEMP_FILE_GRACE_MS) {
                rmSync(path, { force: true });
              } else {
                const metadata = METADATA_FILE.exec(entry.name);
                if (metadata && stat.mtimeMs <= now - TEMP_FILE_GRACE_MS
                  && !existsSync(join(shardPath, metadata[1]!))) {
                  rmSync(path, { force: true });
                }
              }
              continue;
            }
            let recencyMs = stat.mtimeMs;
            try {
              const metadataStat = lstatSync(this.metadataPathFor(entry.name));
              if (metadataStat.isFile() && !metadataStat.isSymbolicLink()) {
                recencyMs = Math.max(recencyMs, metadataStat.mtimeMs);
              }
            } catch { /* legacy artifact without metadata */ }
            if (this.ttlMs === 0 || recencyMs <= now - this.ttlMs) {
              rmSync(path, { force: true });
              rmSync(this.metadataPathFor(entry.name), { force: true });
              continue;
            }
            files.push({ path, size: stat.size, mtimeMs: recencyMs });
          } catch { /* concurrent writer or pruner */ }
        }
      }
    } catch {
      return;
    }
    files.sort((left, right) => left.mtimeMs - right.mtimeMs
      || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    let count = files.length;
    let bytes = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (count <= this.maxEntries && bytes <= this.maxTotalBytes) break;
      try {
        rmSync(file.path, { force: true });
        rmSync(`${file.path}.meta.json`, { force: true });
        count--;
        bytes -= file.size;
      } catch { /* concurrent reader or pruner */ }
    }
  }
}

/**
 * Shared S3-compatible content-addressed storage. It only needs GetObject and
 * conditional PutObject privileges; lifecycle expiration belongs to the bucket
 * policy so workers never need ListBucket or DeleteObject permission.
 */
export class S3ContentAddressedArtifactStore implements ArtifactStore {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly publicBasePath: string;
  private readonly maxArtifactBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly publicBaseUrl: string | undefined;
  private readonly presignExpiresSeconds: number;
  private readonly signer: S3ArtifactUrlSigner;
  private readonly spoolDir: string;

  constructor(options: S3ArtifactStoreOptions) {
    if (!SAFE_BUCKET.test(options.bucket)) throw new Error('invalid S3 artifact bucket');
    if (!Number.isInteger(options.maxArtifactBytes ?? 32 * 1024 * 1024) || (options.maxArtifactBytes ?? 32 * 1024 * 1024) <= 0) {
      throw new Error('S3 artifact size limit must be a positive integer');
    }
    if (!Number.isInteger(options.requestTimeoutMs ?? 15_000) || (options.requestTimeoutMs ?? 15_000) <= 0) {
      throw new Error('S3 artifact request timeout must be a positive integer');
    }
    if (!Number.isSafeInteger(options.presignExpiresSeconds ?? 0)
      || (options.presignExpiresSeconds ?? 0) < 0
      || (options.presignExpiresSeconds ?? 0) > 7 * 24 * 60 * 60) {
      throw new Error('S3 artifact presign expiry must be between 0 and 604800 seconds');
    }
    if (options.publicBaseUrl && (options.presignExpiresSeconds ?? 0) > 0) {
      throw new Error('S3 artifact CDN and presigned delivery modes are mutually exclusive');
    }
    this.client = options.client;
    this.bucket = options.bucket;
    this.prefix = normalizeS3Prefix(options.prefix);
    this.publicBasePath = normalizePublicBasePath(options.publicBasePath);
    this.maxArtifactBytes = options.maxArtifactBytes ?? 32 * 1024 * 1024;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.publicBaseUrl = normalizePublicBaseUrl(options.publicBaseUrl);
    this.presignExpiresSeconds = options.presignExpiresSeconds ?? 0;
    this.signer = options.signer ?? ((client, command, expiresIn) => getSignedUrl(client, command, { expiresIn }));
    this.spoolDir = options.spoolDir ?? join(tmpdir(), 'arduinofast-artifact-spool');
  }

  async externalize(result: CompileResult): Promise<CompileResult> {
    if (result.status !== 'success') return result;
    const [artifacts, staticArtifacts] = await Promise.all([
      Promise.all(result.artifacts.map((artifact) => this.put(artifact))),
      Promise.all(result.staticArtifacts.map((artifact) => this.put(artifact))),
    ]);
    return { ...result, artifacts, staticArtifacts };
  }

  async open(sha256: string, name: string): Promise<ArtifactDownload | null> {
    if (!SAFE_SHA256.test(sha256) || !SAFE_NAME.test(name)) return null;
    return this.openDigest(sha256);
  }

  async redirectUrl(sha256: string, name: string): Promise<string | null> {
    if (!SAFE_SHA256.test(sha256) || !SAFE_NAME.test(name) || this.presignExpiresSeconds === 0) return null;
    try {
      return await this.signer(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.keyFor(sha256),
          ResponseContentType: 'application/octet-stream',
          ResponseContentDisposition: `attachment; filename="${name}"`,
        }),
        this.presignExpiresSeconds,
      );
    } catch (error) {
      throw new ArtifactStoreUnavailableError(`failed to sign artifact ${sha256}`, error);
    }
  }

  close(): void {
    this.client.destroy();
  }

  private async put(artifact: Artifact): Promise<Artifact> {
    const body = decodeArtifact(artifact, this.maxArtifactBytes);
    if (!body) return artifact;

    const key = this.keyFor(artifact.sha256);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: 'application/octet-stream',
      CacheControl: 'public, max-age=31536000, immutable',
      ChecksumSHA256: Buffer.from(artifact.sha256, 'hex').toString('base64'),
      Metadata: { sha256: artifact.sha256, size: String(body.length) },
      IfNoneMatch: '*',
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.client.send(command, { abortSignal: AbortSignal.timeout(this.requestTimeoutMs) });
        return this.publicArtifact(artifact, body.length);
      } catch (error) {
        if (!isConditionalWriteError(error)) {
          throw new ArtifactStoreUnavailableError(`failed to write artifact ${artifact.sha256} to object storage`, error);
        }

        if (await this.readExisting(artifact.sha256)) return this.publicArtifact(artifact, body.length);
        if (isWriteConflict(error) && attempt < 2) {
          await sleep(25 * (attempt + 1));
          continue;
        }
        throw new ArtifactStoreUnavailableError(
          `object storage reported an unverified collision for artifact ${artifact.sha256}`,
          error,
        );
      }
    }
    throw new ArtifactStoreUnavailableError(`failed to publish artifact ${artifact.sha256} after conditional write retries`);
  }

  private async readExisting(sha256: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const download = await this.openDigest(sha256);
      if (download !== null) {
        download.body.destroy();
        return true;
      }
      if (attempt < 2) await sleep(25 * (attempt + 1));
    }
    return false;
  }

  private async openDigest(sha256: string): Promise<ArtifactDownload | null> {
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.keyFor(sha256),
          ChecksumMode: 'ENABLED',
        }),
        { abortSignal: AbortSignal.timeout(this.requestTimeoutMs) },
      );
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw new ArtifactStoreUnavailableError(`failed to read artifact ${sha256} from object storage`, error);
    }

    const contentLength = safeContentLength(response.ContentLength);
    if (response.ContentLength !== undefined && contentLength === undefined) {
      destroyBody(response.Body);
      return null;
    }
    const storedSize = metadataSize(response.Metadata?.size);
    if (response.Metadata?.size !== undefined && storedSize === undefined) {
      destroyBody(response.Body);
      return null;
    }
    if (contentLength !== undefined && storedSize !== undefined && contentLength !== storedSize) {
      destroyBody(response.Body);
      return null;
    }

    const size = contentLength ?? storedSize;
    if (size !== undefined && size > this.maxArtifactBytes) {
      destroyBody(response.Body);
      return null;
    }

    const expectedChecksum = Buffer.from(sha256, 'hex').toString('base64');
    const checksum = response.ChecksumSHA256;
    const storedSha256 = response.Metadata?.sha256?.toLowerCase();
    if ((checksum !== undefined && checksum !== expectedChecksum)
      || (storedSha256 !== undefined && storedSha256 !== sha256)) {
      destroyBody(response.Body);
      return null;
    }

    if (size !== undefined && checksum === expectedChecksum) {
      return {
        body: exactLengthStream(response.Body, size, this.maxArtifactBytes),
        size,
        sha256,
      };
    }

    return spoolVerifiedBody(
      response.Body,
      sha256,
      this.maxArtifactBytes,
      size,
      this.spoolDir,
    );
  }

  private keyFor(sha256: string): string {
    return `${this.prefix}/${sha256.slice(0, 2)}/${sha256}`;
  }

  private publicArtifact(artifact: Artifact, size: number): Artifact {
    if (!this.publicBaseUrl) return publicArtifact(artifact, size, this.publicBasePath);
    return {
      offset: artifact.offset,
      name: artifact.name,
      sha256: artifact.sha256,
      size,
      url: `${this.publicBaseUrl}/${this.keyFor(artifact.sha256)}`,
    };
  }
}

/**
 * Select the explicitly configured storage backend. Local storage stays the
 * development default; every gateway and worker in a split-host deployment
 * must set AF_ARTIFACT_STORE=s3 and use the same bucket and prefix.
 */
export function createArtifactStore(options: ArtifactStoreFactoryOptions): ArtifactStore {
  const env = options.env ?? process.env;
  const mode = (env.AF_ARTIFACT_STORE ?? 'local').trim().toLowerCase();
  const publicBasePath = options.publicBasePath
    ?? prefixPublicPath(env.AF_PUBLIC_BASE_PATH, '/v1/artifacts');
  if (mode === 'local') return new ContentAddressedArtifactStore({ ...options, publicBasePath });
  if (mode !== 's3') throw new Error('AF_ARTIFACT_STORE must be local or s3');

  const bucket = env.AF_ARTIFACT_S3_BUCKET?.trim();
  if (!bucket) throw new Error('AF_ARTIFACT_S3_BUCKET is required when AF_ARTIFACT_STORE=s3');
  const region = env.AF_ARTIFACT_S3_REGION?.trim() || 'us-east-1';
  const endpoint = parseS3Endpoint(env);
  const credentials = s3CredentialsFromEnv(env);
  const publicBaseUrl = normalizePublicBaseUrl(
    env.AF_ARTIFACT_PUBLIC_BASE_URL,
    env.NODE_ENV === 'production',
  );
  const presignExpiresSeconds = optionalNonNegativeEnvInt(
    env,
    'AF_ARTIFACT_S3_PRESIGN_EXPIRES_SECONDS',
  );
  if (publicBaseUrl && presignExpiresSeconds > 0) {
    throw new Error('AF_ARTIFACT_PUBLIC_BASE_URL and AF_ARTIFACT_S3_PRESIGN_EXPIRES_SECONDS are mutually exclusive');
  }
  const client = new S3Client({
    region,
    forcePathStyle: optionalBoolean(env, 'AF_ARTIFACT_S3_FORCE_PATH_STYLE', false),
    ...(endpoint ? { endpoint } : {}),
    ...(credentials ? { credentials } : {}),
  });
  return new S3ContentAddressedArtifactStore({
    client,
    bucket,
    prefix: env.AF_ARTIFACT_S3_PREFIX,
    publicBasePath,
    maxArtifactBytes: options.maxArtifactBytes,
    requestTimeoutMs: positiveEnvInt(env, 'AF_ARTIFACT_S3_REQUEST_TIMEOUT_MS', 15_000),
    publicBaseUrl,
    presignExpiresSeconds,
  });
}
