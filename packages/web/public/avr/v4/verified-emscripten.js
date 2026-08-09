/**
 * Instantiate Emscripten glue only after its WASM payload has passed the
 * immutable-pack size and SHA-256 checks. The glue module itself must be
 * imported from the application's trusted, same-origin runtime.
 */
export async function createVerifiedEmscriptenModule({
  loader,
  artifactId,
  factory,
  moduleOptions = {},
} = {}) {
  if (typeof loader?.loadArtifact !== "function") {
    throw new TypeError("verified browser toolchain loader is required");
  }
  if (typeof artifactId !== "string" || !artifactId) {
    throw new TypeError("WASM artifact id is required");
  }
  if (typeof factory !== "function") {
    throw new TypeError("Emscripten module factory is required");
  }
  if (!moduleOptions || typeof moduleOptions !== "object" || Array.isArray(moduleOptions)) {
    throw new TypeError("Emscripten module options must be an object");
  }

  const { artifact, bytes } = await loader.loadArtifact(artifactId);
  if (artifact?.kind !== "wasm") {
    throw new Error(`browser toolchain artifact is not WASM: ${artifactId}`);
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`browser toolchain WASM payload is invalid: ${artifactId}`);
  }

  // Place wasmBinary last so a caller cannot replace the verified payload.
  return factory({ ...moduleOptions, wasmBinary: bytes });
}
