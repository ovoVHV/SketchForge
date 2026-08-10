const TOOLCHAIN_ID = /^[a-z][a-z0-9._-]{0,63}$/;

/**
 * Operators may set this before loading app.js:
 *
 *   globalThis.__SKETCHFORGE_TOOLCHAIN_ORIGINS__ = {
 *     "arduino-avr-uno": "https://cdn.example.com/arduino/avr/v4/",
 *   };
 *
 * Executable modules and Worker launchers stay on the application origin.
 * Immutable compiler data (verified WASM and packs) may be delivered directly
 * by an object store/CDN.
 */
export const BROWSER_TOOLCHAIN_ORIGINS_KEY = "__SKETCHFORGE_TOOLCHAIN_ORIGINS__";
export const LEGACY_BROWSER_TOOLCHAIN_ORIGINS_KEY = "__ARDUINOFAST_TOOLCHAIN_ORIGINS__";

export function browserToolchainOrigins(scope = globalThis) {
  return scope?.[BROWSER_TOOLCHAIN_ORIGINS_KEY]
    ?? scope?.[LEGACY_BROWSER_TOOLCHAIN_ORIGINS_KEY];
}

/** Resolve one immutable data-pack base without accepting credentials or query URLs. */
export function resolveBrowserToolchainBase({
  id,
  fallback,
  origins = browserToolchainOrigins(),
  pageUrl = globalThis.location?.href ?? import.meta.url,
} = {}) {
  if (typeof id !== "string" || !TOOLCHAIN_ID.test(id)) {
    throw new TypeError("browser toolchain id is invalid");
  }
  // `import.meta.url` is a file: URL under Node-based tests. It is only
  // acceptable for the checked-in fallback, never for an operator-supplied
  // origin, which continues to require HTTPS when it is external.
  const fallbackUrl = normalizeToolchainBase(fallback, pageUrl, {
    allowHttp: true,
    allowFile: true,
  });
  if (origins == null) return fallbackUrl;
  if (!origins || typeof origins !== "object" || Array.isArray(origins)) {
    throw new TypeError("browser toolchain origins must be an object");
  }

  const configured = origins[id];
  if (configured == null || configured === "") return fallbackUrl;
  if (typeof configured !== "string") {
    throw new TypeError(`browser toolchain origin is invalid: ${id}`);
  }

  const configuredUrl = normalizeToolchainBase(configured, pageUrl, { allowHttp: true });
  // Same-origin local development may use HTTP. An external toolchain must
  // always use HTTPS so an injected page setting cannot downgrade a compiler.
  if (configuredUrl.origin !== fallbackUrl.origin && configuredUrl.protocol !== "https:") {
    throw new Error(`browser toolchain origin must use HTTPS: ${id}`);
  }
  return configuredUrl;
}

/** Map one release-relative immutable file onto the configured mirror root. */
export function resolveBrowserToolchainMirrorUrl({
  id,
  fallbackRoot,
  fallbackUrl,
  origins = browserToolchainOrigins(),
  pageUrl = globalThis.location?.href ?? import.meta.url,
} = {}) {
  const root = normalizeToolchainBase(fallbackRoot, pageUrl, {
    allowHttp: true,
    allowFile: true,
  });
  const target = new URL(fallbackUrl, root);
  if (target.username || target.password || target.search || target.hash) {
    throw new Error("browser toolchain mirror URL cannot contain credentials, query, or fragment");
  }
  if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname)) {
    throw new Error("browser toolchain mirror URL is outside the application release root");
  }
  const mirrorRoot = resolveBrowserToolchainBase({
    id,
    fallback: root,
    origins,
    pageUrl,
  });
  return new URL(target.pathname.slice(root.pathname.length), mirrorRoot);
}

export function normalizeToolchainBase(value, base, {
  allowHttp = false,
  allowFile = false,
} = {}) {
  if (typeof value !== "string" && !(value instanceof URL)) {
    throw new TypeError("browser toolchain base is required");
  }
  const url = new URL(value, base);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("browser toolchain base cannot contain credentials, query, or fragment");
  }
  if (
    url.protocol !== "https:"
    && !(allowHttp && url.protocol === "http:")
    && !(allowFile && url.protocol === "file:")
  ) {
    throw new Error("browser toolchain base must use HTTPS");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
