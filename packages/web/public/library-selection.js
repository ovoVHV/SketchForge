function libraryKey(name, version) {
  return `${name.toLowerCase()}@${version ?? ''}`;
}

export function normalizeLibraryReferences(references) {
  const normalized = new Map();
  for (const value of Array.isArray(references) ? references : []) {
    if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim()) continue;
    const name = value.name.trim();
    const explicitVersion = typeof value.version === 'string' ? value.version.trim() : '';
    const version = explicitVersion;
    const reference = { name, ...(version ? { version } : {}) };
    normalized.set(libraryKey(reference.name, reference.version), reference);
  }
  return [...normalized.values()].sort((left, right) => (
    left.name.localeCompare(right.name) || String(left.version ?? '').localeCompare(String(right.version ?? ''))
  ));
}

export function mergeLibrarySelectionRows(references, catalog) {
  const selections = normalizeLibraryReferences(references);
  const selectedByKey = new Map(selections.map((selection) => [
    libraryKey(selection.name, selection.version),
    selection,
  ]));
  const represented = new Set();
  const catalogRows = [];
  for (const library of Array.isArray(catalog) ? catalog : []) {
    if (!library || typeof library.name !== 'string' || typeof library.version !== 'string') continue;
    const catalogKey = libraryKey(library.name, library.version);
    const versionlessKey = libraryKey(library.name, '');
    const selection = selectedByKey.get(catalogKey)
      ?? (represented.has(versionlessKey) ? undefined : selectedByKey.get(versionlessKey));
    const selectionKey = selection
      ? libraryKey(selection.name, selection.version)
      : catalogKey;
    if (selection) represented.add(selectionKey);
    catalogRows.push({ ...library, catalogKey, selectionKey, selected: Boolean(selection), retained: false });
  }
  const retainedRows = selections
    .filter((selection) => !represented.has(libraryKey(selection.name, selection.version)))
    .map((selection) => ({
      name: selection.name,
      version: selection.version ?? '',
      description: 'Saved selection is not present in the current catalog',
      catalogKey: '',
      selectionKey: libraryKey(selection.name, selection.version),
      selected: true,
      retained: true,
    }));
  return [...retainedRows, ...catalogRows];
}
