const SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._+/-]*$/;

const BROWSER_TOOLCHAIN_PACK_LEGACY_SCHEMA = 1;
export const BROWSER_TOOLCHAIN_PACK_SCHEMA = 2;
export const BROWSER_TOOLCHAIN_PACK_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_BROWSER_TOOLCHAIN_PACK_LIMITS = Object.freeze({
  maxArtifacts: 128,
  maxChunksPerArtifact: 256,
  maxFilesPerArtifact: 16 * 1024,
  maxFileBytes: 256 * 1024 * 1024,
  maxArtifactBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
});

/**
 * A pack is transport-agnostic. One artifact can be split into many immutable
 * CDN chunks; each chunk and the reconstructed artifact have SHA-256 digests.
 * Future board, runtime, core, and library packs can use the same shape.
 */
export function validateBrowserToolchainPackManifest(value, limits) {
  const normalizedLimits = normalizeBrowserToolchainPackLimits(limits);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid browser toolchain pack manifest");
  }
  if (value.schema !== BROWSER_TOOLCHAIN_PACK_LEGACY_SCHEMA
    && value.schema !== BROWSER_TOOLCHAIN_PACK_SCHEMA) {
    throw new Error("unsupported browser toolchain pack manifest schema");
  }
  if (typeof value.id !== "string" || !IDENTIFIER.test(value.id)) {
    throw new Error("invalid browser toolchain pack id");
  }
  if (typeof value.version !== "string" || !VERSION.test(value.version)) {
    throw new Error("invalid browser toolchain pack version");
  }
  if (typeof value.revision !== "string" || !SHA256.test(value.revision)) {
    throw new Error("invalid browser toolchain pack revision");
  }
  if (
    !Array.isArray(value.artifacts)
    || value.artifacts.length === 0
    || value.artifacts.length > normalizedLimits.maxArtifacts
  ) throw new Error("invalid browser toolchain pack artifacts");

  const artifacts = [];
  let previousId = "";
  let totalSize = 0;
  for (const valueArtifact of value.artifacts) {
    if (!valueArtifact || typeof valueArtifact !== "object" || Array.isArray(valueArtifact)) {
      throw new Error("invalid browser toolchain pack artifact");
    }
    const { id, kind, size, sha256 } = valueArtifact;
    if (typeof id !== "string" || !IDENTIFIER.test(id) || id <= previousId) {
      throw new Error(`browser toolchain artifacts must have sorted unique ids: ${id}`);
    }
    if (typeof kind !== "string" || !IDENTIFIER.test(kind)) {
      throw new Error(`invalid browser toolchain artifact kind: ${id}`);
    }
    if (!Number.isSafeInteger(size) || size <= 0 || size > normalizedLimits.maxArtifactBytes) {
      throw new Error(`invalid browser toolchain artifact size: ${id}`);
    }
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
      throw new Error(`invalid browser toolchain artifact checksum: ${id}`);
    }
    const chunks = validateArtifactChunks(valueArtifact.chunks, id, size, normalizedLimits);
    const files = validateArtifactFiles(
      valueArtifact.files,
      id,
      kind,
      size,
      value.schema,
      normalizedLimits,
    );
    totalSize += size;
    if (totalSize > normalizedLimits.maxTotalBytes) {
      throw new Error("browser toolchain pack exceeds the total size limit");
    }
    artifacts.push(Object.freeze({
      id,
      kind,
      size,
      sha256,
      ...(files === undefined ? {} : { files: Object.freeze(files) }),
      chunks: Object.freeze(chunks),
    }));
    previousId = id;
  }

  return Object.freeze({
    schema: value.schema,
    id: value.id,
    version: value.version,
    revision: value.revision,
    artifacts: Object.freeze(artifacts),
  });
}

export function normalizeBrowserToolchainPackLimits(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("browser toolchain pack limits must be an object");
  }
  const normalized = {};
  for (const [key, fallback] of Object.entries(DEFAULT_BROWSER_TOOLCHAIN_PACK_LIMITS)) {
    const candidate = value[key] ?? fallback;
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      throw new TypeError(`invalid browser toolchain pack limit: ${key}`);
    }
    normalized[key] = candidate;
  }
  return Object.freeze(normalized);
}

export function normalizeBrowserToolchainPath(value) {
  if (typeof value !== "string" || !RELATIVE_PATH.test(value)) {
    throw new Error("invalid browser toolchain artifact path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("invalid browser toolchain artifact path");
  }
  return value;
}

function validateArtifactFiles(value, artifactId, kind, artifactSize, schema, limits) {
  if (schema === BROWSER_TOOLCHAIN_PACK_LEGACY_SCHEMA) {
    if (value !== undefined) throw new Error(`legacy browser toolchain artifact cannot declare files: ${artifactId}`);
    return undefined;
  }
  if (kind !== "tree") {
    if (value !== undefined) throw new Error(`non-tree browser toolchain artifact cannot declare files: ${artifactId}`);
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > limits.maxFilesPerArtifact) {
    throw new Error(`invalid browser toolchain artifact files: ${artifactId}`);
  }
  const files = [];
  let previousPath = "";
  for (const valueFile of value) {
    if (!valueFile || typeof valueFile !== "object" || Array.isArray(valueFile)) {
      throw new Error(`invalid browser toolchain artifact file: ${artifactId}`);
    }
    const path = normalizeBrowserToolchainPath(valueFile.path);
    if (path.length > 512 || path <= previousPath) {
      throw new Error(`browser toolchain artifact files must have sorted unique paths: ${artifactId}`);
    }
    files.push({ valueFile, path });
    previousPath = path;
  }
  const indexedFiles = [];
  let expectedOffset = 0;
  for (const { valueFile, path } of files) {
    if (!Number.isSafeInteger(valueFile.offset) || valueFile.offset !== expectedOffset
      || !Number.isSafeInteger(valueFile.length) || valueFile.length < 0
      || valueFile.length > limits.maxFileBytes
      || valueFile.length > artifactSize - valueFile.offset) {
      throw new Error(`invalid browser toolchain artifact file range: ${artifactId}/${path}`);
    }
    if (typeof valueFile.sha256 !== "string" || !SHA256.test(valueFile.sha256)) {
      throw new Error(`invalid browser toolchain artifact file checksum: ${artifactId}/${path}`);
    }
    indexedFiles.push(Object.freeze({
      path,
      offset: valueFile.offset,
      length: valueFile.length,
      sha256: valueFile.sha256,
    }));
    expectedOffset += valueFile.length;
  }
  if (expectedOffset !== artifactSize) {
    throw new Error(`browser toolchain artifact file size mismatch: ${artifactId}`);
  }
  return indexedFiles;
}

/** The stable digest input deliberately excludes the self-referential revision. */
export function browserToolchainPackRevisionInput(manifest, limits) {
  const normalized = validateBrowserToolchainPackManifest(manifest, limits);
  return JSON.stringify({
    schema: normalized.schema,
    id: normalized.id,
    version: normalized.version,
    artifacts: normalized.artifacts,
  });
}

/**
 * Creates a lazy, integrity-checking loader for one immutable pack directory.
 * Its callback receives byte-accurate progress while a payload is downloaded.
 */
export function createBrowserToolchainPackLoader({
  manifestUrl,
  fallbackManifestUrl,
  expectedId,
  expectedRevision,
  fetchFn = globalThis.fetch,
  cryptoRef = globalThis.crypto,
  DecompressionStreamClass = globalThis.DecompressionStream,
  limits,
  onProgress = () => {},
} = {}) {
  if (typeof fetchFn !== "function") throw new TypeError("fetch is required to load a browser toolchain pack");
  if (expectedId != null && (typeof expectedId !== "string" || !IDENTIFIER.test(expectedId))) {
    throw new TypeError("expected browser toolchain pack id is invalid");
  }
  if (expectedRevision != null && (typeof expectedRevision !== "string" || !SHA256.test(expectedRevision))) {
    throw new TypeError("expected browser toolchain pack revision is invalid");
  }
  if (typeof onProgress !== "function") throw new TypeError("browser toolchain progress callback must be a function");

  const normalizedLimits = normalizeBrowserToolchainPackLimits(limits);
  const url = absolutePackUrl(manifestUrl);
  const fallbackUrl = fallbackManifestUrl == null ? null : absolutePackUrl(fallbackManifestUrl);
  const manifestUrls = fallbackUrl && fallbackUrl.href !== url.href ? [url, fallbackUrl] : [url];
  let activeManifestUrl = url;
  let manifestPromise;
  const artifactPromises = new Map();

  const loadManifest = () => {
    if (!manifestPromise) {
      const pending = (async () => {
        let lastError;
        for (const candidateUrl of manifestUrls) {
          try {
            const value = await fetchJson(
              fetchFn,
              candidateUrl,
              "browser toolchain manifest",
              BROWSER_TOOLCHAIN_PACK_MANIFEST_MAX_BYTES,
            );
            const manifest = validateBrowserToolchainPackManifest(value, normalizedLimits);
            if (expectedId && manifest.id !== expectedId) {
              throw new Error(`unexpected browser toolchain pack: ${manifest.id}`);
            }
            if (expectedRevision && manifest.revision !== expectedRevision) {
              throw new Error("unexpected browser toolchain pack revision");
            }
            const actualRevision = await digestText(
              browserToolchainPackRevisionInput(manifest, normalizedLimits),
              cryptoRef,
            );
            if (actualRevision !== manifest.revision) {
              throw new Error("browser toolchain pack revision mismatch");
            }
            activeManifestUrl = candidateUrl;
            return manifest;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError;
      })();
      const wrapped = pending.catch((error) => {
        if (manifestPromise === wrapped) manifestPromise = undefined;
        throw error;
      });
      manifestPromise = wrapped;
    }
    return manifestPromise;
  };

  const loadArtifact = async (id) => {
    const manifest = await loadManifest();
    const artifact = manifest.artifacts.find((candidate) => candidate.id === id);
    if (!artifact) throw new Error(`browser toolchain artifact is missing: ${id}`);
    if (!artifactPromises.has(id)) {
      const pending = loadArtifactChunks({
        fetchFn,
        cryptoRef,
        DecompressionStreamClass,
        baseUrls: orderedPackBaseUrls(activeManifestUrl, manifestUrls),
        manifest,
        artifact,
        onProgress,
      });
      const wrapped = pending.catch((error) => {
        if (artifactPromises.get(id) === wrapped) artifactPromises.delete(id);
        throw error;
      });
      artifactPromises.set(id, wrapped);
    }
    return artifactPromises.get(id);
  };

  return Object.freeze({
    loadManifest,
    loadArtifact,
    reset() {
      manifestPromise = undefined;
      artifactPromises.clear();
    },
  });
}

function validateArtifactChunks(value, artifactId, artifactSize, limits) {
  if (!Array.isArray(value) || value.length === 0 || value.length > limits.maxChunksPerArtifact) {
    throw new Error(`invalid browser toolchain artifact chunks: ${artifactId}`);
  }
  let previousPath = "";
  let totalSize = 0;
  const chunks = [];
  for (const valueChunk of value) {
    if (!valueChunk || typeof valueChunk !== "object" || Array.isArray(valueChunk)) {
      throw new Error(`invalid browser toolchain artifact chunk: ${artifactId}`);
    }
    const path = normalizeBrowserToolchainPath(valueChunk.path);
    if (path <= previousPath) {
      throw new Error(`browser toolchain artifact chunks must have sorted unique paths: ${artifactId}`);
    }
    if (!Number.isSafeInteger(valueChunk.size) || valueChunk.size <= 0 || valueChunk.size > limits.maxArtifactBytes) {
      throw new Error(`invalid browser toolchain artifact chunk size: ${artifactId}`);
    }
    if (typeof valueChunk.sha256 !== "string" || !SHA256.test(valueChunk.sha256)) {
      throw new Error(`invalid browser toolchain artifact chunk checksum: ${artifactId}`);
    }
    const compression = valueChunk.compression;
    let transport;
    if (compression === undefined) {
      if (valueChunk.compressedSize !== undefined || valueChunk.compressedSha256 !== undefined) {
        throw new Error(`invalid browser toolchain artifact chunk compression: ${artifactId}`);
      }
    } else {
      if (compression !== "gzip") {
        throw new Error(`unsupported browser toolchain artifact chunk compression: ${artifactId}`);
      }
      if (
        !Number.isSafeInteger(valueChunk.compressedSize)
        || valueChunk.compressedSize <= 0
        || valueChunk.compressedSize > limits.maxArtifactBytes
        || valueChunk.compressedSize >= valueChunk.size
        || typeof valueChunk.compressedSha256 !== "string"
        || !SHA256.test(valueChunk.compressedSha256)
      ) throw new Error(`invalid browser toolchain artifact chunk compression: ${artifactId}`);
      transport = Object.freeze({
        compression,
        compressedSize: valueChunk.compressedSize,
        compressedSha256: valueChunk.compressedSha256,
      });
    }
    totalSize += valueChunk.size;
    if (totalSize > artifactSize) throw new Error(`browser toolchain artifact chunk size mismatch: ${artifactId}`);
    chunks.push(Object.freeze({
      path,
      size: valueChunk.size,
      sha256: valueChunk.sha256,
      ...(transport ?? {}),
    }));
    previousPath = path;
  }
  if (totalSize !== artifactSize) throw new Error(`browser toolchain artifact chunk size mismatch: ${artifactId}`);
  return chunks;
}

async function loadArtifactChunks({
  fetchFn,
  cryptoRef,
  DecompressionStreamClass,
  baseUrls,
  manifest,
  artifact,
  onProgress,
}) {
  const chunks = [];
  let completedBytes = 0;
  const totalDownloadBytes = artifact.chunks.reduce(
    (total, chunk) => total + (chunk.compressedSize ?? chunk.size),
    0,
  );
  for (let index = 0; index < artifact.chunks.length; index++) {
    const chunk = artifact.chunks[index];
    const transportSize = chunk.compressedSize ?? chunk.size;
    const transportSha256 = chunk.compressedSha256 ?? chunk.sha256;
    const downloaded = await fetchVerifiedBytes({
      fetchFn,
      urls: baseUrls.map((baseUrl) => resolveArtifactUrl(baseUrl, chunk.path)),
      label: `browser toolchain artifact ${artifact.id}`,
      expectedSize: transportSize,
      expectedSha256: transportSha256,
      cryptoRef,
      onChunk: (receivedBytes) => {
        if (receivedBytes > transportSize) {
          throw new Error(`browser toolchain artifact chunk size mismatch: ${artifact.id}`);
        }
        onProgress({
          packId: manifest.id,
          packVersion: manifest.version,
          artifactId: artifact.id,
          chunkIndex: index,
          chunkCount: artifact.chunks.length,
          completedBytes: completedBytes + receivedBytes,
          totalBytes: totalDownloadBytes,
          artifactBytes: artifact.size,
        });
      },
    });
    const bytes = chunk.compression
      ? await decompressChunk(downloaded, chunk.compression, chunk.size, DecompressionStreamClass)
      : downloaded;
    if (bytes.byteLength !== chunk.size || await digestBytes(bytes, cryptoRef) !== chunk.sha256) {
      throw new Error(`browser toolchain artifact decoded chunk mismatch: ${artifact.id}`);
    }
    chunks.push(bytes);
    completedBytes += downloaded.byteLength;
  }

  const bytes = concatenateChunks(chunks, artifact.size);
  const actualArtifactSha256 = await digestBytes(bytes, cryptoRef);
  if (actualArtifactSha256 !== artifact.sha256) {
    throw new Error(`browser toolchain artifact checksum mismatch: ${artifact.id}`);
  }
  onProgress({
    packId: manifest.id,
    packVersion: manifest.version,
    artifactId: artifact.id,
    chunkIndex: artifact.chunks.length - 1,
    chunkCount: artifact.chunks.length,
    completedBytes: totalDownloadBytes,
    totalBytes: totalDownloadBytes,
    artifactBytes: artifact.size,
    complete: true,
  });
  return { artifact, bytes };
}

async function decompressChunk(bytes, compression, expectedSize, DecompressionStreamClass) {
  if (compression !== "gzip" || typeof DecompressionStreamClass !== "function") {
    throw new Error(`browser toolchain chunk compression is unavailable: ${compression}`);
  }
  let stream;
  try {
    stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStreamClass(compression));
  } catch {
    throw new Error(`browser toolchain chunk decompression failed: ${compression}`);
  }
  const reader = stream.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("browser toolchain decompressor returned invalid bytes");
      if (size + value.byteLength > expectedSize) {
        throw new Error("browser toolchain decompressed chunk exceeds its declared size");
      }
      parts.push(value);
      size += value.byteLength;
    }
  } catch (error) {
    try { await reader.cancel?.(error); } catch {}
    throw error;
  } finally {
    reader.releaseLock?.();
  }
  if (size !== expectedSize) throw new Error("browser toolchain decompressed chunk size mismatch");
  return concatenateChunks(parts, size);
}

function absolutePackUrl(value) {
  if (typeof value !== "string" && !(value instanceof URL)) {
    throw new TypeError("browser toolchain manifest URL is required");
  }
  const fallback = typeof self !== "undefined" && self.location ? self.location.href : import.meta.url;
  const url = new URL(value, fallback);
  if (url.search || url.hash) throw new Error("browser toolchain manifest URL must not include a query or fragment");
  return url;
}

function resolveArtifactUrl(baseUrl, path) {
  const url = new URL(normalizeBrowserToolchainPath(path), baseUrl);
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
    throw new Error(`browser toolchain artifact escapes its pack directory: ${path}`);
  }
  return url;
}

async function fetchJson(fetchFn, url, label, maxBytes) {
  let lastError;
  for (const cache of ["no-cache", "reload"]) {
    try {
      const response = await fetchFn(url, { cache });
      if (!response?.ok) throw httpFetchError(label, response?.status);
      const bytes = await readResponseBytes(response, label, maxBytes);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) {
      lastError = error instanceof SyntaxError
        ? new Error(`${label} is not valid UTF-8 JSON`)
        : error;
      if (cache === "reload" || !shouldRetryFetch(lastError)) throw lastError;
    }
  }
  throw lastError;
}

async function fetchVerifiedBytes({
  fetchFn,
  urls,
  label,
  expectedSize,
  expectedSha256,
  cryptoRef,
  onChunk,
}) {
  let lastError;
  for (const url of urls) {
    for (const cache of ["force-cache", "reload"]) {
      try {
        const downloaded = await fetchBytes(fetchFn, url, label, expectedSize, onChunk, cache);
        if (downloaded.byteLength !== expectedSize) {
          throw new Error(`${label} chunk size mismatch`);
        }
        if (await digestBytes(downloaded, cryptoRef) !== expectedSha256) {
          throw new Error(`${label} chunk checksum mismatch`);
        }
        return downloaded;
      } catch (error) {
        lastError = error;
        if (cache !== "reload" && shouldRetryFetch(error)) continue;
        break;
      }
    }
  }
  throw lastError;
}

function orderedPackBaseUrls(activeManifestUrl, manifestUrls) {
  const ordered = [activeManifestUrl, ...manifestUrls.filter((url) => url.href !== activeManifestUrl.href)];
  return ordered.map((url) => new URL("./", url));
}

async function fetchBytes(fetchFn, url, label, maxBytes, onChunk, cache = "force-cache") {
  const response = await fetchFn(url, { cache });
  if (!response?.ok) throw httpFetchError(label, response?.status);
  return readResponseBytes(response, label, maxBytes, onChunk);
}

function httpFetchError(label, status) {
  const error = new Error(`${label} returned HTTP ${status ?? "unknown"}`);
  error.retryable = status === undefined || status === 408 || status === 429 || status >= 500;
  return error;
}

function shouldRetryFetch(error) {
  return error?.retryable !== false;
}

async function readResponseBytes(response, label, maxBytes, onChunk = () => {}) {
  validateResponseContentLength(response, label, maxBytes);
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeds its size limit`);
    onChunk(bytes.byteLength);
    return bytes;
  }

  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error(`${label} returned an invalid stream chunk`);
      if (size + value.byteLength > maxBytes) {
        await reader.cancel?.();
        throw new Error(`${label} exceeds its size limit`);
      }
      parts.push(value);
      size += value.byteLength;
      onChunk(size);
    }
  } finally {
    reader.releaseLock?.();
  }
  return concatenateChunks(parts, size);
}

function validateResponseContentLength(response, label, maxBytes) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength == null || contentLength === "") return;
  const size = Number(contentLength);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${label} returned an invalid Content-Length`);
  }
  if (size > maxBytes) throw new Error(`${label} exceeds its size limit`);
}

function concatenateChunks(chunks, size) {
  if (chunks.length === 1 && chunks[0].byteLength === size) return chunks[0];
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function digestText(value, cryptoRef) {
  return digestBytes(new TextEncoder().encode(value), cryptoRef);
}

async function digestBytes(bytes, cryptoRef) {
  if (typeof cryptoRef?.subtle?.digest !== "function") {
    throw new Error("Web Crypto is required to verify browser toolchain packs");
  }
  const digest = new Uint8Array(await cryptoRef.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}
