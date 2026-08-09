import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GatewayCompileAdmission,
  type CompileAdmissionCosts,
  type CompileAdmissionDecision,
} from '../src/gateway-compile-admission.js';

type LimiterOutcome = CompileAdmissionDecision | Error;

class RecordingLimiter {
  readonly calls: Array<{ ip: string; visitor: unknown; cost: number }> = [];

  constructor(private readonly outcomes: LimiterOutcome[] = []) {}

  async take(ip: string, visitor: unknown, cost: number): Promise<CompileAdmissionDecision> {
    this.calls.push({ ip, visitor, cost });
    const outcome = this.outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome ?? { allowed: true, retryAfterMs: 0 };
  }
}

const apps: FastifyInstance[] = [];

function createApp(
  limiter: RecordingLimiter,
  bodyLimit = 256,
  costs: CompileAdmissionCosts = { avr: 1, esp32: 8 },
): FastifyInstance {
  const app = Fastify({ bodyLimit });
  const admission = new GatewayCompileAdmission(limiter, costs);
  app.post('/v1/compile', { onRequest: admission.onRequest }, async (request, reply) => {
    const architecture = (request.body as { architecture?: unknown } | null)?.architecture;
    if (architecture !== 'avr' && architecture !== 'esp32') {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (!await admission.chargeArchitecture(request, reply, architecture)) return;
    return reply.send({ ok: true });
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GatewayCompileAdmission', () => {
  it.each([
    ['avr', { avr: 1, esp32: 8 }, [1]],
    ['avr', { avr: 3, esp32: 8 }, [1, 2]],
    ['esp32', { avr: 1, esp32: 11 }, [1, 10]],
  ] as const)('charges a successful %s request exactly its configured total cost', async (
    architecture,
    configuredCosts,
    expectedCharges,
  ) => {
    const limiter = new RecordingLimiter();
    const response = await createApp(limiter, 256, configuredCosts).inject({
      method: 'POST',
      url: '/v1/compile',
      headers: { 'x-af-visitor': 'visitor-0000000001' },
      payload: { architecture },
    });

    expect(response.statusCode).toBe(200);
    expect(limiter.calls.map((call) => call.cost)).toEqual(expectedCharges);
    expect(limiter.calls.reduce((total, call) => total + call.cost, 0)).toBe(configuredCosts[architecture]);
    expect(limiter.calls.every((call) => call.visitor === 'visitor-0000000001')).toBe(true);
  });

  it.each([
    ['malformed JSON', '{"architecture":', 400],
    ['an oversized body', JSON.stringify({ padding: 'x'.repeat(256) }), 413],
  ])('charges the base cost before parsing %s', async (_label, payload, statusCode) => {
    const limiter = new RecordingLimiter();
    const response = await createApp(limiter, 64).inject({
      method: 'POST',
      url: '/v1/compile',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(response.statusCode).toBe(statusCode);
    expect(limiter.calls.map((call) => call.cost)).toEqual([1]);
  });

  it('returns the existing 429 semantics before an oversized body is parsed', async () => {
    const limiter = new RecordingLimiter([{ allowed: false, retryAfterMs: 1_001 }]);
    const response = await createApp(limiter, 64).inject({
      method: 'POST',
      url: '/v1/compile',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(256) }),
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('2');
    expect(response.json()).toMatchObject({ error: 'rate_limited' });
    expect(limiter.calls.map((call) => call.cost)).toEqual([1]);
  });

  it('fails closed when Redis is unavailable during the base charge', async () => {
    const limiter = new RecordingLimiter([new Error('redis offline')]);
    const response = await createApp(limiter).inject({
      method: 'POST',
      url: '/v1/compile',
      payload: { architecture: 'avr' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('2');
    expect(response.json()).toMatchObject({ error: 'compile_service_unavailable' });
    expect(limiter.calls.map((call) => call.cost)).toEqual([1]);
  });

  it('preserves 429 and fail-closed semantics during architecture top-up', async () => {
    const limited = new RecordingLimiter([
      { allowed: true, retryAfterMs: 0 },
      { allowed: false, retryAfterMs: 2_001 },
    ]);
    const limitedResponse = await createApp(limited).inject({
      method: 'POST',
      url: '/v1/compile',
      payload: { architecture: 'esp32' },
    });
    expect(limitedResponse.statusCode).toBe(429);
    expect(limitedResponse.headers['retry-after']).toBe('3');
    expect(limited.calls.map((call) => call.cost)).toEqual([1, 7]);

    const unavailable = new RecordingLimiter([
      { allowed: true, retryAfterMs: 0 },
      new Error('redis offline'),
    ]);
    const unavailableResponse = await createApp(unavailable).inject({
      method: 'POST',
      url: '/v1/compile',
      payload: { architecture: 'esp32' },
    });
    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailableResponse.headers['retry-after']).toBe('2');
    expect(unavailable.calls.map((call) => call.cost)).toEqual([1, 7]);
  });

  it('is wired to the real compile route as an onRequest hook', () => {
    const source = readFileSync(new URL('../src/gateway.ts', import.meta.url), 'utf8');
    expect(source).toContain("app.post('/v1/compile', { onRequest: compileAdmission.onRequest }");
    expect(source).toContain('compileAdmission.chargeArchitecture(request, reply, board.arch)');
  });
});
