import { resolveEsp32BrowserLibraries } from './esp32/v1/library-registry.js';

function publishedVersion(registry, library, architecture) {
  const requested = typeof library?.version === 'string' && library.version
    ? library.version
    : undefined;
  const exact = resolveEsp32BrowserLibraries(
    registry,
    [{ name: library.name, ...(requested ? { version: requested } : {}) }],
    architecture,
  );
  if (exact.supported) return requested ?? registry.byName.get(library.name.toLowerCase())?.defaultVersion;

  const fallback = registry.byName.get(library.name.toLowerCase())?.defaultVersion;
  if (!fallback) return null;
  const resolved = resolveEsp32BrowserLibraries(
    registry,
    [{ name: library.name, version: fallback }],
    architecture,
  );
  return resolved.supported ? fallback : null;
}

export function reconcileEsp32BrowserLibraryCatalog(catalog, registry, architecture = 'esp32') {
  const source = Array.isArray(catalog) ? catalog : [];
  if (!registry?.byName || architecture !== 'esp32') return source;

  const rows = [];
  const represented = new Set();
  const append = (library) => {
    const key = `${library.name.toLowerCase()}@${library.version}`;
    if (represented.has(key)) return;
    represented.add(key);
    rows.push(library);
  };

  for (const library of source) {
    if (!library || typeof library.name !== 'string') continue;
    const published = registry.byName.get(library.name.toLowerCase());
    if (!published) {
      append(library);
      continue;
    }
    const version = publishedVersion(registry, library, architecture);
    if (!version) {
      append(library);
      continue;
    }
    const metadata = published.byVersion.get(version);
    append({
      ...library,
      name: published.name,
      version,
      architectures: metadata?.architectures ?? library.architectures ?? [architecture],
      browserPack: true,
    });
  }

  const representedNames = new Set(rows.map(({ name }) => name.toLowerCase()));
  for (const published of registry.libraries) {
    if (representedNames.has(published.name.toLowerCase())) continue;
    const version = publishedVersion(registry, { name: published.name }, architecture);
    if (!version) continue;
    const metadata = published.byVersion.get(version);
    append({
      name: published.name,
      version,
      architectures: metadata?.architectures ?? [architecture],
      description: 'Browser WASM Pack',
      source: { kind: 'pack' },
      browserPack: true,
    });
  }
  return rows;
}

export function reconcileEsp32BrowserLibraryReferences(references, registry, architecture = 'esp32') {
  if (!registry?.byName || architecture !== 'esp32') return Array.isArray(references) ? references : [];
  return (Array.isArray(references) ? references : []).map((reference) => {
    if (!reference || typeof reference.name !== 'string') return reference;
    const version = publishedVersion(registry, reference, architecture);
    if (!version || version === reference.version) return reference;
    return { name: registry.byName.get(reference.name.toLowerCase())?.name ?? reference.name, version };
  });
}

export function resolveEsp32BrowserCatalogLibrary(registry, library, architecture = 'esp32') {
  if (!registry?.byName || !library || typeof library.name !== 'string') return null;
  const resolved = resolveEsp32BrowserLibraries(
    registry,
    [{ name: library.name, ...(library.version ? { version: library.version } : {}) }],
    architecture,
  );
  return resolved.supported ? resolved : null;
}
