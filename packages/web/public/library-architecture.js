function normalizedArchitecture(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
}

export function supportsLibraryArchitecture(library, architecture) {
  const target = normalizedArchitecture(architecture);
  if (!target) return true;
  if (!Array.isArray(library?.architectures)) return false;
  return library.architectures.some((value) => {
    const candidate = normalizedArchitecture(value);
    return candidate === '*' || candidate === target;
  });
}

/** A versionless legacy reference is valid when any matching version is valid. */
export function libraryReferenceSupported(reference, libraries, architecture) {
  if (!reference || typeof reference.name !== 'string') return false;
  const name = reference.name.trim().toLowerCase();
  const version = typeof reference.version === 'string' ? reference.version.trim() : '';
  return (Array.isArray(libraries) ? libraries : []).some((library) => (
    typeof library?.name === 'string'
      && library.name.trim().toLowerCase() === name
      && (!version || library.version === version)
      && supportsLibraryArchitecture(library, architecture)
  ));
}

export function filterLibrariesForArchitecture(libraries, architecture) {
  return (Array.isArray(libraries) ? libraries : []).filter((library) => (
    supportsLibraryArchitecture(library, architecture)
  ));
}
