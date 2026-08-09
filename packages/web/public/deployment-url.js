const DEFAULT_MODULE_URL = import.meta.url;

function normalizedRelativePath(value) {
  if (typeof value !== 'string') throw new TypeError('application path must be a string');
  const path = value.replace(/^\/+/, '');
  if (!path || path.includes('\\') || path.split('/').includes('..')) {
    throw new TypeError('application path is invalid');
  }
  return path;
}

/** Resolve an application resource under either / or an operator path prefix. */
export function applicationUrl(path, moduleUrl = DEFAULT_MODULE_URL) {
  const relative = normalizedRelativePath(path);
  const base = new URL('./', moduleUrl);
  // Node-based tests import the checked-in module through file:. Preserve the
  // root deployment contract there without inventing a network origin.
  if (base.protocol === 'file:') return `/${relative}`;
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError('application module URL must use http(s)');
  }
  return new URL(relative, base).href;
}

export function apiUrl(path, moduleUrl = DEFAULT_MODULE_URL) {
  const relative = normalizedRelativePath(path).replace(/^v1\//, '');
  return applicationUrl(`v1/${relative}`, moduleUrl);
}
