function selectionKey(selection) {
  if (!selection || typeof selection !== 'object') return null;
  const name = typeof selection.name === 'string' ? selection.name.trim().toLowerCase() : '';
  const version = typeof selection.version === 'string' ? selection.version.trim() : '';
  const packId = typeof selection.packId === 'string' ? selection.packId.trim() : '';
  const revision = typeof selection.revision === 'string' ? selection.revision.trim() : '';
  const artifact = typeof selection.artifact === 'string' ? selection.artifact.trim() : '';
  if (!name || !version || !packId || !revision || !artifact) return null;
  return `${name}@${version}|${packId}|${revision}|${artifact}`;
}

export function browserLibraryPackKey(selection) {
  return selectionKey(selection);
}

/**
 * Deduplicate browser Pack downloads by the immutable Registry identity.
 * A successful install remains installed until a newer revision is selected;
 * failed installs are removed from the in-flight map so they can be retried.
 */
export function createBrowserLibraryCacheCoordinator({ install }) {
  if (typeof install !== 'function') throw new TypeError('browser Pack installer is required');
  const cached = new Set();
  const pending = new Map();

  function remember(entries) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const key = selectionKey(entry?.selection ?? entry);
      if (key) cached.add(key);
    }
  }

  function has(selection) {
    const key = selectionKey(selection);
    return Boolean(key && cached.has(key));
  }

  function hasAll(selections) {
    return Array.isArray(selections) && selections.every(has);
  }

  function isPending(selection) {
    const key = selectionKey(selection);
    return Boolean(key && pending.has(key));
  }

  function ensure(selection, options = {}) {
    const key = selectionKey(selection);
    if (!key) return Promise.reject(new Error('browser Pack selection is incomplete'));
    if (cached.has(key)) return Promise.resolve({ cached: true, reused: true, selection });
    const existing = pending.get(key);
    if (existing) return existing;

    const operation = Promise.resolve()
      .then(() => install({ ...options, selection }))
      .then((result) => {
        cached.add(key);
        return result;
      })
      .finally(() => {
        if (pending.get(key) === operation) pending.delete(key);
      });
    pending.set(key, operation);
    return operation;
  }

  return Object.freeze({ ensure, has, hasAll, isPending, remember });
}
