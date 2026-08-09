import { describe, expect, it, vi } from 'vitest';
import {
  AutoscaleWebhookAdapter,
  decideWorkerReplicas,
  initialAutoscaleState,
  type AutoscalePolicy,
} from '../src/autoscale.js';

const policy: AutoscalePolicy = {
  minReplicas: 1,
  maxReplicas: 10,
  targetJobsPerReplica: 4,
  hysteresis: 0.2,
  scaleUpCooldownMs: 30_000,
  scaleDownCooldownMs: 300_000,
  idleGraceMs: 600_000,
  capacityPerReplica: 1,
};

describe('worker autoscaling decisions', () => {
  it('scales a surge, then applies hysteresis and scale-up cooldown', () => {
    const surge = decideWorkerReplicas({
      pool: 'avr', waiting: 20, active: 1, currentReplicas: 1, currentCapacity: 1, observedAt: 1_000,
    }, policy);
    expect(surge.decision.desiredReplicas).toBe(6);
    expect(surge.decision.reason).toBe('scale-up');

    const cooldown = decideWorkerReplicas({
      pool: 'avr', waiting: 36, active: 6, currentReplicas: 6, currentCapacity: 6, observedAt: 2_000,
    }, policy, surge.nextState);
    expect(cooldown.decision.desiredReplicas).toBe(6);
    expect(cooldown.decision.reason).toBe('cooldown');

    const deadBand = decideWorkerReplicas({
      pool: 'avr', waiting: 12, active: 5, currentReplicas: 6, currentCapacity: 6, observedAt: 400_000,
    }, policy, cooldown.nextState);
    expect(deadBand.decision.reason).toBe('hysteresis');
    expect(deadBand.decision.changed).toBe(false);
  });

  it('honors idle grace and removes at most one replica after cooldown', () => {
    const state = initialAutoscaleState(4);
    const idle = decideWorkerReplicas({
      pool: 'esp32-xtensa', waiting: 0, active: 0, currentReplicas: 4, currentCapacity: 4, observedAt: 10_000,
    }, policy, state);
    expect(idle.decision.reason).toBe('idle-grace');
    const stillIdle = decideWorkerReplicas({
      pool: 'esp32-xtensa', waiting: 0, active: 0, currentReplicas: 4, currentCapacity: 4, observedAt: 609_999,
    }, policy, idle.nextState);
    expect(stillIdle.decision.changed).toBe(false);
    const down = decideWorkerReplicas({
      pool: 'esp32-xtensa', waiting: 0, active: 0, currentReplicas: 4, currentCapacity: 4, observedAt: 610_000,
    }, policy, stillIdle.nextState);
    expect(down.decision.reason).toBe('scale-down');
    expect(down.decision.desiredReplicas).toBe(3);
  });

  it('recovers from worker loss and never scales below active compile capacity', () => {
    const loss = decideWorkerReplicas({
      pool: 'esp32-riscv', waiting: 12, active: 1, currentReplicas: 1, currentCapacity: 1, observedAt: 1_000,
    }, policy);
    expect(loss.decision.reason).toBe('scale-up');
    expect(loss.decision.desiredReplicas).toBe(4);

    const activeFloor = decideWorkerReplicas({
      pool: 'esp32-riscv', waiting: 0, active: 3, currentReplicas: 4, currentCapacity: 4, observedAt: 400_000,
    }, policy, loss.nextState);
    expect(activeFloor.decision.desiredReplicas).toBe(3);
    expect(activeFloor.decision.desiredReplicas).toBeGreaterThanOrEqual(activeFloor.decision.queue.active);
  });

  it('authenticates webhook calls and sends a stable idempotency key', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer 0123456789abcdef');
      const body = JSON.parse(String(init?.body)) as { decisionId: string };
      expect(new Headers(init?.headers).get('idempotency-key')).toBe(body.decisionId);
      return new Response(null, { status: 202 });
    });
    const adapter = new AutoscaleWebhookAdapter({
      url: 'https://orchestrator.test/v1/scale',
      token: '0123456789abcdef',
      fetcher,
    });
    const result = decideWorkerReplicas({
      pool: 'avr', waiting: 20, active: 1, currentReplicas: 1, currentCapacity: 1, observedAt: 1_000,
    }, policy);
    const retry = decideWorkerReplicas({
      pool: 'avr', waiting: 20, active: 1, currentReplicas: 1, currentCapacity: 1, observedAt: 2_000,
    }, policy);
    expect(retry.decision.decisionId).toBe(result.decision.decisionId);
    await adapter.apply(result.decision);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(() => new AutoscaleWebhookAdapter({
      url: 'http://orchestrator.test/v1/scale', token: '0123456789abcdef', fetcher,
    })).toThrow(/HTTPS/);
  });

  it('aborts a stalled webhook at the configured timeout', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const adapter = new AutoscaleWebhookAdapter({
      url: 'https://orchestrator.test/v1/scale',
      token: '0123456789abcdef',
      timeoutMs: 100,
      fetcher,
    });
    const result = decideWorkerReplicas({
      pool: 'avr', waiting: 20, active: 1, currentReplicas: 1, currentCapacity: 1, observedAt: 1_000,
    }, policy);
    await expect(adapter.apply(result.decision)).rejects.toThrow(/timed out/);
  });
});
