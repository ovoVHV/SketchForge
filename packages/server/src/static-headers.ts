import { posix, relative, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

const RETIRED_AVR_STATIC_ROOT = '/avr/v2';

/** Match retired static assets before Fastify resolves them on disk. */
export function isRetiredStaticPath(requestTarget: string): boolean {
  const delimiter = requestTarget.search(/[?#]/u);
  const encodedPath = delimiter === -1 ? requestTarget : requestTarget.slice(0, delimiter);
  if (!encodedPath.startsWith('/')) return false;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return false;
  }

  // Windows static lookup accepts case and backslash variants of the same path.
  const normalizedPath = posix.normalize(decodedPath.replaceAll('\\', '/')).toLowerCase();
  return normalizedPath === RETIRED_AVR_STATIC_ROOT
    || normalizedPath.startsWith(`${RETIRED_AVR_STATIC_ROOT}/`);
}

export function registerRetiredStaticPathGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!isRetiredStaticPath(request.raw.url ?? request.url)) return;
    reply.header('Cache-Control', 'no-store');
    return reply.code(404).send({ error: 'not_found', message: 'static asset not found' });
  });
}

/** Headers for immutable, versioned browser compiler assets. */
export function setStaticHeaders(publicRoot: string) {
  const browserRoot = `${resolve(publicRoot, 'avr')}${sep}`;
  const esp32Root = `${resolve(publicRoot, 'esp32')}${sep}`;
  return (reply: FastifyReply, filePath: string): void => {
    const resolved = resolve(filePath);
    const immutable = isVersionedAvrAsset(resolved, browserRoot)
      || isImmutableEsp32Asset(resolved, esp32Root);
    if (!immutable) return;
    // Keep these in Fastify's reply header store. Writing directly to
    // reply.raw is overwritten when the static plugin finalizes its response.
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  };
}

function isVersionedAvrAsset(filePath: string, browserRoot: string): boolean {
  if (!filePath.startsWith(browserRoot)) return false;
  const version = filePath.slice(browserRoot.length).split(sep, 1)[0] ?? '';
  return version.toLowerCase() !== 'v2' && /^v[1-9][0-9]*$/.test(version);
}

/**
 * ESP32 pack manifests and runtime.json intentionally retain stable URLs so a
 * release can update them atomically. Only bytes whose paths are derived from
 * their checksum may be cached forever. The stable Clang glue URL must be
 * revalidated because a compiler release can replace it.
 */
function isImmutableEsp32Asset(filePath: string, esp32Root: string): boolean {
  if (!filePath.startsWith(esp32Root)) return false;
  const segments = relative(esp32Root, filePath).split(sep);
  const [version, first, second, third, fourth] = segments;
  if (!/^v[1-9][0-9]*$/.test(version ?? '')) return false;
  const runtimeChunk = (first === 'runtime' || first === 'xtensa')
    && second === 'packs'
    && third !== undefined
    && fourth === 'chunks';
  const sharedToolchainChunk = first === 'toolchains'
    && /^[a-z][a-z0-9._-]{0,63}$/.test(second ?? '')
    && /^[a-f0-9]{64}$/.test(third ?? '')
    && fourth === 'chunks';
  return (runtimeChunk || sharedToolchainChunk)
    && segments.length === 6
    && /\.bin(?:\.gz)?$/.test(segments[5]!);
}
