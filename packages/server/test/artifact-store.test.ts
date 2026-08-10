import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, CompileResult } from '@sketchforge/core';
import {
  ArtifactStoreUnavailableError,
  ContentAddressedArtifactStore,
  S3ContentAddressedArtifactStore,
  createArtifactStore,
  type ArtifactStore,
} from '../src/artifact-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(body = Buffer.from(':00000001FF\n')): Artifact {
  return {
    offset: null,
    name: 'firmware.hex',
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.length,
    base64: body.toString('base64'),
  };
}

function store(): ContentAddressedArtifactStore {
  const root = mkdtempSync(join(tmpdir(), 'af-artifacts-'));
  roots.push(root);
  return new ContentAddressedArtifactStore({ rootDir: root });
}

function storeAt(root: string): ContentAddressedArtifactStore {
  return new ContentAddressedArtifactStore({ rootDir: root });
}

async function readArtifact(
  artifacts: Pick<ArtifactStore, 'open'>,
  sha256: string,
  name: string,
): Promise<Buffer | null> {
  const download = await artifacts.open(sha256, name);
  if (!download) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of download.body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('ContentAddressedArtifactStore', () => {
  it('externalizes firmware and serves it by verified content hash', async () => {
    const artifacts = store();
    const artifact = fixture();
    const input: CompileResult = {
      status: 'success',
      artifacts: [artifact],
      staticArtifacts: [],
      diagnostics: [],
      timings: {},
      cached: false,
    };

    const output = await artifacts.externalize(input);
    expect(output.status).toBe('success');
    if (output.status !== 'success') return;
    expect(output.artifacts[0]).toMatchObject({
      sha256: artifact.sha256,
      url: `/v1/artifacts/${artifact.sha256}/firmware.hex`,
    });
    expect(output.artifacts[0]?.base64).toBeUndefined();
    const download = await artifacts.open(artifact.sha256, artifact.name);
    expect(download).toMatchObject({ size: artifact.size, sha256: artifact.sha256 });
    expect(download?.body).toBeInstanceOf(Readable);
    download?.body.destroy();
    await expect(readArtifact(artifacts, artifact.sha256, artifact.name))
      .resolves.toEqual(Buffer.from(':00000001FF\n'));
  });

  it('rejects forged metadata and traversal names', async () => {
    const artifacts = store();
    await expect(artifacts.put({ ...fixture(), size: 1 })).rejects.toThrow(/size mismatch/);
    await expect(artifacts.put({ ...fixture(), sha256: '0'.repeat(64) })).rejects.toThrow(/checksum mismatch/);
    await expect(artifacts.open('0'.repeat(64), '../secret')).resolves.toBeNull();
  });

  it('deduplicates repeated content-addressed writes', async () => {
    const artifacts = store();
    const artifact = fixture();
    expect(await artifacts.put(artifact)).toEqual(await artifacts.put(artifact));
  });

  it('repairs a corrupt file that occupies a content address', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-artifacts-'));
    roots.push(root);
    const artifact = fixture();
    const shard = join(root, artifact.sha256.slice(0, 2));
    mkdirSync(shard, { recursive: true });
    writeFileSync(join(shard, artifact.sha256), 'corrupt');
    const artifacts = storeAt(root);

    await artifacts.put(artifact);

    await expect(readArtifact(artifacts, artifact.sha256, artifact.name))
      .resolves.toEqual(Buffer.from(':00000001FF\n'));
  });

  it('revalidates a same-size file changed after metadata publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-artifacts-'));
    roots.push(root);
    const artifact = fixture();
    const artifacts = storeAt(root);
    await artifacts.put(artifact);
    const path = join(root, artifact.sha256.slice(0, 2), artifact.sha256);
    writeFileSync(path, Buffer.alloc(artifact.size, 0x78));

    await expect(artifacts.open(artifact.sha256, artifact.name)).resolves.toBeNull();
    await artifacts.put(artifact);
    await expect(readArtifact(artifacts, artifact.sha256, artifact.name))
      .resolves.toEqual(Buffer.from(artifact.base64!, 'base64'));
  });

  it('does not prune another worker active temporary write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-artifacts-'));
    roots.push(root);
    const digest = 'a'.repeat(64);
    const shard = join(root, digest.slice(0, 2));
    mkdirSync(shard, { recursive: true });
    const temporary = join(shard, `.${digest}.123.00000000-0000-4000-8000-000000000000.tmp`);
    writeFileSync(temporary, 'active');

    await storeAt(root).put(fixture(Buffer.from(':0100000001FE\n')));

    expect(existsSync(temporary)).toBe(true);
  });

  it('reaps stale temporary writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-artifacts-'));
    roots.push(root);
    const digest = 'b'.repeat(64);
    const shard = join(root, digest.slice(0, 2));
    mkdirSync(shard, { recursive: true });
    const temporary = join(shard, `.${digest}.123.00000000-0000-4000-8000-000000000000.tmp`);
    writeFileSync(temporary, 'stale');
    const old = new Date(Date.now() - 10 * 60 * 1_000);
    utimesSync(temporary, old, old);

    await storeAt(root).put(fixture(Buffer.from(':0100000001FE\n')));

    expect(existsSync(temporary)).toBe(false);
  });

  it('does not synchronously read whole artifact files', () => {
    const source = readFileSync(new URL('../src/artifact-store.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\breadFileSync\b/);
  });
});

function s3Store(
  send: (command: unknown) => Promise<unknown>,
  options: Partial<ConstructorParameters<typeof S3ContentAddressedArtifactStore>[0]> = {},
): {
  client: S3Client;
  store: S3ContentAddressedArtifactStore;
} {
  const client = {
    send: vi.fn(async (command: unknown) => send(command)),
    destroy: vi.fn(),
  } as unknown as S3Client;
  return {
    client,
    store: new S3ContentAddressedArtifactStore({
      client,
      bucket: 'firmware-artifacts',
      prefix: 'sketchforge/artifacts',
      requestTimeoutMs: 1_000,
      ...options,
    }),
  };
}

describe('S3ContentAddressedArtifactStore', () => {
  it('publishes verified firmware through a conditional content-addressed key', async () => {
    const sent = vi.fn(async (_command: unknown) => ({}));
    const { client, store } = s3Store(sent);
    const artifact = fixture();
    const output = await store.externalize({
      status: 'success',
      artifacts: [artifact],
      staticArtifacts: [],
      diagnostics: [],
      timings: {},
      cached: false,
    });

    expect(output.status).toBe('success');
    if (output.status !== 'success') return;
    expect(output.artifacts[0]).toMatchObject({
      name: artifact.name,
      sha256: artifact.sha256,
      url: `/v1/artifacts/${artifact.sha256}/firmware.hex`,
    });
    expect(output.artifacts[0]?.base64).toBeUndefined();
    const command = (client.send as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({
      Bucket: 'firmware-artifacts',
      Key: `sketchforge/artifacts/${artifact.sha256.slice(0, 2)}/${artifact.sha256}`,
      ContentLength: artifact.size,
      IfNoneMatch: '*',
      ChecksumSHA256: Buffer.from(artifact.sha256, 'hex').toString('base64'),
      Metadata: { sha256: artifact.sha256, size: String(artifact.size) },
    });
  });

  it('accepts a concurrently published object only after reading and hashing it', async () => {
    const artifact = fixture();
    const { store } = s3Store(async (command) => {
      if (command instanceof PutObjectCommand) {
        throw Object.assign(new Error('already exists'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        });
      }
      if (command instanceof GetObjectCommand) {
        return { ContentLength: artifact.size, Body: Readable.from([Buffer.from(artifact.base64!, 'base64')]) };
      }
      throw new Error('unexpected command');
    });

    const output = await store.externalize({
      status: 'success',
      artifacts: [artifact],
      staticArtifacts: [],
      diagnostics: [],
      timings: {},
      cached: false,
    });
    expect(output.status).toBe('success');
  });

  it('returns immutable CDN URLs without routing firmware bytes through the gateway', async () => {
    const artifact = fixture();
    const { store } = s3Store(async () => ({}), {
      publicBaseUrl: 'https://firmware.example.test/content',
    });
    const output = await store.externalize({
      status: 'success', artifacts: [artifact], staticArtifacts: [], diagnostics: [], timings: {}, cached: false,
    });
    expect(output.status).toBe('success');
    if (output.status !== 'success') return;
    expect(output.artifacts[0]?.url).toBe(
      `https://firmware.example.test/content/sketchforge/artifacts/${artifact.sha256.slice(0, 2)}/${artifact.sha256}`,
    );
    await expect(store.redirectUrl(artifact.sha256, artifact.name)).resolves.toBeNull();
  });

  it('creates fresh private-bucket redirects without persisting expiring URLs', async () => {
    const artifact = fixture();
    const signer = vi.fn(async () => 'https://signed.example.test/object?signature=fresh');
    const { store } = s3Store(async () => ({}), {
      presignExpiresSeconds: 300,
      signer,
    });
    const output = await store.externalize({
      status: 'success', artifacts: [artifact], staticArtifacts: [], diagnostics: [], timings: {}, cached: false,
    });
    expect(output.status).toBe('success');
    if (output.status !== 'success') return;
    expect(output.artifacts[0]?.url).toBe(`/v1/artifacts/${artifact.sha256}/${artifact.name}`);

    await expect(store.redirectUrl(artifact.sha256, artifact.name))
      .resolves.toBe('https://signed.example.test/object?signature=fresh');
    expect(signer).toHaveBeenCalledTimes(1);
    const command = signer.mock.calls[0]?.[1] as GetObjectCommand;
    expect(command.input).toMatchObject({
      Bucket: 'firmware-artifacts',
      Key: `sketchforge/artifacts/${artifact.sha256.slice(0, 2)}/${artifact.sha256}`,
      ResponseContentDisposition: `attachment; filename="${artifact.name}"`,
    });
    expect(signer.mock.calls[0]?.[2]).toBe(300);
  });

  it('checks stored object bytes before serving them', async () => {
    const artifact = fixture();
    const { store } = s3Store(async (command) => {
      if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
      return { ContentLength: artifact.size, Body: Readable.from([Buffer.from(artifact.base64!, 'base64')]) };
    });

    await expect(readArtifact(store, artifact.sha256, artifact.name))
      .resolves.toEqual(Buffer.from(':00000001FF\n'));
  });

  it('opens checksum-bearing objects without consuming their body first', async () => {
    const artifact = fixture();
    let started = false;
    const { store, client } = s3Store(async (command) => {
      if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
      return {
        ContentLength: artifact.size,
        ChecksumSHA256: Buffer.from(artifact.sha256, 'hex').toString('base64'),
        Metadata: { sha256: artifact.sha256, size: String(artifact.size) },
        Body: Readable.from((async function* body() {
          started = true;
          yield Buffer.from(artifact.base64!, 'base64');
        })()),
      };
    });

    const download = await store.open(artifact.sha256, artifact.name);
    expect(download).toMatchObject({ size: artifact.size, sha256: artifact.sha256 });
    expect(started).toBe(false);
    const command = (client.send as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as GetObjectCommand;
    expect(command.input.ChecksumMode).toBe('ENABLED');

    const chunks: Buffer[] = [];
    for await (const chunk of download!.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(artifact.base64!, 'base64'));
    expect(started).toBe(true);
  });

  it('does not treat user metadata as an object checksum', async () => {
    const artifact = fixture();
    let started = false;
    const { store } = s3Store(async (command) => {
      if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
      return {
        ContentLength: artifact.size,
        Metadata: { sha256: artifact.sha256, size: String(artifact.size) },
        Body: Readable.from((async function* body() {
          started = true;
          yield Buffer.from(artifact.base64!, 'base64');
        })()),
      };
    });

    const download = await store.open(artifact.sha256, artifact.name);
    expect(started).toBe(true);
    expect(download).toMatchObject({ size: artifact.size, sha256: artifact.sha256 });
    const chunks: Buffer[] = [];
    for await (const chunk of download!.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(artifact.base64!, 'base64'));
  });

  it('does not serve a corrupt object or hide an object storage outage as a cache miss', async () => {
    const artifact = fixture();
    const corrupt = s3Store(async () => ({ ContentLength: 7, Body: Readable.from(['corrupt']) }));
    await expect(corrupt.store.open(artifact.sha256, artifact.name)).resolves.toBeNull();

    const unavailable = s3Store(async () => { throw new Error('connection reset'); });
    await expect(unavailable.store.open(artifact.sha256, artifact.name))
      .rejects.toBeInstanceOf(ArtifactStoreUnavailableError);
  });

  it('reports an unavailable verification spool as a storage outage', async () => {
    const artifact = fixture();
    const root = mkdtempSync(join(tmpdir(), 'af-artifact-spool-'));
    roots.push(root);
    const blocked = join(root, 'not-a-directory');
    writeFileSync(blocked, 'blocked');
    const { store } = s3Store(async () => ({
      ContentLength: artifact.size,
      Body: Readable.from([Buffer.from(artifact.base64!, 'base64')]),
    }), { spoolDir: blocked });

    await expect(store.open(artifact.sha256, artifact.name))
      .rejects.toBeInstanceOf(ArtifactStoreUnavailableError);
  });
});

describe('createArtifactStore', () => {
  it('keeps local storage as the default and requires explicit complete S3 configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'af-artifacts-'));
    roots.push(root);
    expect(createArtifactStore({ rootDir: root, env: {} }).kind).toBe('local');
    expect(() => createArtifactStore({
      rootDir: root,
      env: { AF_ARTIFACT_STORE: 's3' },
    })).toThrow(/AF_ARTIFACT_S3_BUCKET/);
  });

  it('prefixes local artifact URLs with AF_PUBLIC_BASE_PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-artifacts-'));
    roots.push(root);
    const artifact = fixture();
    const store = createArtifactStore({
      rootDir: root,
      env: { AF_PUBLIC_BASE_PATH: '/arduino/' },
    });

    const output = await store.externalize({
      status: 'success',
      artifacts: [artifact],
      staticArtifacts: [],
      diagnostics: [],
      timings: {},
      cached: false,
    });

    expect(output.status).toBe('success');
    if (output.status !== 'success') return;
    expect(output.artifacts[0]?.url)
      .toBe(`/arduino/v1/artifacts/${artifact.sha256}/${artifact.name}`);
  });

  it('constructs S3 storage without allowing cleartext endpoints in production', () => {
    const root = mkdtempSync(join(tmpdir(), 'af-artifacts-'));
    roots.push(root);
    const store = createArtifactStore({
      rootDir: root,
      env: {
        AF_ARTIFACT_STORE: 's3',
        AF_ARTIFACT_S3_BUCKET: 'firmware-artifacts',
        AF_ARTIFACT_S3_REGION: 'auto',
        AF_ARTIFACT_S3_ENDPOINT: 'https://example.invalid',
      },
    });
    expect(store.kind).toBe('s3');
    store.close?.();
    expect(() => createArtifactStore({
      rootDir: root,
      env: {
        NODE_ENV: 'production',
        AF_ARTIFACT_STORE: 's3',
        AF_ARTIFACT_S3_BUCKET: 'firmware-artifacts',
        AF_ARTIFACT_S3_ENDPOINT: 'http://minio.internal:9000',
      },
    })).toThrow(/must use HTTPS/);
    expect(() => createArtifactStore({
      rootDir: root,
      env: {
        NODE_ENV: 'production',
        AF_ARTIFACT_STORE: 's3',
        AF_ARTIFACT_S3_BUCKET: 'firmware-artifacts',
        AF_ARTIFACT_PUBLIC_BASE_URL: 'http://cdn.example.test',
      },
    })).toThrow(/must use HTTPS/);
    expect(() => createArtifactStore({
      rootDir: root,
      env: {
        AF_ARTIFACT_STORE: 's3',
        AF_ARTIFACT_S3_BUCKET: 'firmware-artifacts',
        AF_ARTIFACT_PUBLIC_BASE_URL: 'https://cdn.example.test',
        AF_ARTIFACT_S3_PRESIGN_EXPIRES_SECONDS: '300',
      },
    })).toThrow(/mutually exclusive/);
  });
});
