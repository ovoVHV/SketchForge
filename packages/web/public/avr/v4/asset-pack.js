const PACK_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.pack$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function normalizeAssetPath(value) {
  if (typeof value !== "string") throw new TypeError("asset path must be a string");
  const path = value.replace(/^\/+/, "");
  const segments = path.split("/");
  if (
    !path
    || path.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) throw new Error(`invalid packed asset path: ${value}`);
  return path;
}

export function validateAssetPackDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("invalid AVR asset pack descriptor");
  }
  if (typeof descriptor.file !== "string" || !PACK_FILE.test(descriptor.file)) {
    throw new Error("invalid AVR asset pack filename");
  }
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size <= 0) {
    throw new Error("invalid AVR asset pack size");
  }
  if (typeof descriptor.sha256 !== "string" || !SHA256.test(descriptor.sha256)) {
    throw new Error("invalid AVR asset pack checksum");
  }
  if (!Array.isArray(descriptor.entries) || descriptor.entries.length === 0) {
    throw new Error("invalid AVR asset pack entries");
  }

  const entries = new Map();
  let cursor = 0;
  let previousPath = "";
  for (const entry of descriptor.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("invalid AVR asset pack entry");
    }
    const path = normalizeAssetPath(entry.path);
    if (path !== entry.path || path <= previousPath) {
      throw new Error(`AVR asset pack entries are not strictly sorted: ${path}`);
    }
    if (!Number.isSafeInteger(entry.offset) || entry.offset !== cursor) {
      throw new Error(`invalid AVR asset pack offset for ${path}`);
    }
    if (!Number.isSafeInteger(entry.length) || entry.length < 0) {
      throw new Error(`invalid AVR asset pack length for ${path}`);
    }
    entries.set(path, Object.freeze({ offset: entry.offset, length: entry.length }));
    cursor += entry.length;
    previousPath = path;
  }
  if (cursor !== descriptor.size) {
    throw new Error(`AVR asset pack size mismatch: index=${cursor}, manifest=${descriptor.size}`);
  }
  return entries;
}

export function openAssetPack(descriptor, bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("asset pack must be Uint8Array");
  const entries = validateAssetPackDescriptor(descriptor);
  if (bytes.byteLength !== descriptor.size) {
    throw new Error(`AVR asset pack byte length mismatch: body=${bytes.byteLength}, manifest=${descriptor.size}`);
  }

  return Object.freeze({
    read(value) {
      const path = normalizeAssetPath(value);
      const entry = entries.get(path);
      if (!entry) throw new Error(`asset ${path} is missing from AVR asset pack`);
      return bytes.subarray(entry.offset, entry.offset + entry.length);
    },
  });
}
