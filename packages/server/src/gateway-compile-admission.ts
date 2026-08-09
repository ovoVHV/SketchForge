import type { FastifyReply, FastifyRequest } from 'fastify';

export const COMPILE_ADMISSION_BASE_COST = 1;

export interface CompileAdmissionDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export interface CompileAdmissionRateLimiter {
  take(ip: string, suppliedVisitorId: unknown, cost: number): Promise<CompileAdmissionDecision>;
}

export interface CompileAdmissionCosts {
  avr: number;
  esp32: number;
}

/**
 * Charges a small parsing fee before Fastify reads the body, then tops the
 * request up to the configured architecture cost once its board is known.
 */
export class GatewayCompileAdmission {
  private readonly chargedCosts = new WeakMap<FastifyRequest, number>();

  constructor(
    private readonly limiter: CompileAdmissionRateLimiter,
    private readonly costs: CompileAdmissionCosts,
  ) {
    for (const [architecture, cost] of Object.entries(costs)) {
      if (!Number.isInteger(cost) || cost < COMPILE_ADMISSION_BASE_COST) {
        throw new Error(`${architecture} compile cost must be an integer no lower than ${COMPILE_ADMISSION_BASE_COST}`);
      }
    }
  }

  readonly onRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!await this.take(request, reply, COMPILE_ADMISSION_BASE_COST)) return reply;
    this.chargedCosts.set(request, COMPILE_ADMISSION_BASE_COST);
  };

  async chargeArchitecture(
    request: FastifyRequest,
    reply: FastifyReply,
    architecture: keyof CompileAdmissionCosts,
  ): Promise<boolean> {
    const charged = this.chargedCosts.get(request);
    if (charged === undefined) {
      throw new Error('compile admission base charge is missing');
    }

    const targetCost = this.costs[architecture];
    const remainder = targetCost - charged;
    if (remainder <= 0) return true;
    if (!await this.take(request, reply, remainder)) return false;

    this.chargedCosts.set(request, targetCost);
    return true;
  }

  private async take(request: FastifyRequest, reply: FastifyReply, cost: number): Promise<boolean> {
    let decision: CompileAdmissionDecision;
    try {
      decision = await this.limiter.take(request.ip, request.headers['x-af-visitor'], cost);
    } catch (error) {
      request.log.warn({ err: error }, 'compile admission dependency unavailable');
      reply.header('Retry-After', '2');
      reply.code(503).send({
        error: 'compile_service_unavailable',
        message: '编译调度服务暂时不可用，请稍后重试',
      });
      return false;
    }

    if (decision.allowed) return true;

    reply.header('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))));
    reply.code(429).send({ error: 'rate_limited', message: '请求过于频繁，请稍后重试' });
    return false;
  }
}
