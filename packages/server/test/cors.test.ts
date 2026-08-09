import Fastify from 'fastify';
import cors from '@fastify/cors';
import { describe, expect, it } from 'vitest';
import { API_CORS_METHODS } from '../src/cors.js';

describe('API CORS', () => {
  it('allows cross-origin compile cancellation and its token header', async () => {
    const app = Fastify();
    await app.register(cors, { origin: true, methods: API_CORS_METHODS });

    try {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/v1/compile/job/requests/request',
        headers: {
          origin: 'https://editor.example.test',
          'access-control-request-method': 'DELETE',
          'access-control-request-headers': 'x-af-cancel-token',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-methods']).toContain('DELETE');
      expect(response.headers['access-control-allow-headers']).toBe('x-af-cancel-token');
    } finally {
      await app.close();
    }
  });
});
