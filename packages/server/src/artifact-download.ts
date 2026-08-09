import type { FastifyInstance } from 'fastify';
import type { ArtifactStore } from './artifact-store.js';

export interface ArtifactDownloadParams {
  sha256: string;
  name: string;
}

/** Register the content-addressed download endpoint without buffering firmware bytes. */
export function registerArtifactDownloadRoute(app: FastifyInstance, artifacts: ArtifactStore): void {
  app.get<{ Params: ArtifactDownloadParams }>('/v1/artifacts/:sha256/:name', async (request, reply) => {
    if (artifacts.redirectUrl) {
      try {
        const redirect = await artifacts.redirectUrl(request.params.sha256, request.params.name);
        if (redirect) {
          reply.header('Cache-Control', 'private, no-store');
          return reply.redirect(redirect, 307);
        }
      } catch (error) {
        request.log.error({ err: error }, 'artifact download signing failed');
        reply.header('Retry-After', '2');
        return reply.code(503).send({
          error: 'artifact_storage_unavailable',
          message: 'artifact storage is temporarily unavailable',
        });
      }
    }

    let download;
    try {
      download = await artifacts.open(request.params.sha256, request.params.name);
    } catch (error) {
      request.log.error({ err: error }, 'artifact storage read failed');
      reply.header('Retry-After', '2');
      return reply.code(503).send({
        error: 'artifact_storage_unavailable',
        message: 'artifact storage is temporarily unavailable',
      });
    }
    if (!download) return reply.code(404).send({ error: 'not_found', message: '固件不存在或已过期' });

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${request.params.name}"`);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('ETag', `"${download.sha256}"`);
    reply.header('Content-Length', String(download.size));
    return reply.send(download.body);
  });
}
