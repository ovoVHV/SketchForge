const INVALID_PUBLIC_BASE_PATH_CHARACTER = /[\u0000-\u0020\u007f\\?#]/;

export function normalizePublicBasePath(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '' || trimmed === '/') return '';
  if (!trimmed.startsWith('/')
    || trimmed.startsWith('//')
    || INVALID_PUBLIC_BASE_PATH_CHARACTER.test(trimmed)) {
    throw new Error('AF_PUBLIC_BASE_PATH must be an absolute URL path without whitespace, query, or fragment');
  }

  const normalized = trimmed.replace(/\/+$/, '');
  const segments = normalized.slice(1).split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('AF_PUBLIC_BASE_PATH must not contain empty, dot, or parent segments');
  }
  return normalized;
}

export function prefixPublicPath(
  publicBasePath: string | undefined,
  absolutePath: string,
): string {
  if (!absolutePath.startsWith('/') || absolutePath.startsWith('//')) {
    throw new Error('public response path must start with exactly one slash');
  }
  return `${normalizePublicBasePath(publicBasePath)}${absolutePath}`;
}
