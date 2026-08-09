import { createHash } from 'node:crypto';
import type { WorkerPool } from './distributed-queue.js';

export interface AutoscalePolicy {
  minReplicas: number;
  maxReplicas: number;
  /** Queue pressure tolerated per compile slot before another replica is requested. */
  targetJobsPerReplica: number;
  /** Fraction in [0, 0.9] used for symmetric scale-up/down dead bands. */
  hysteresis: number;
  scaleUpCooldownMs: number;
  scaleDownCooldownMs: number;
  idleGraceMs: number;
  /** Used when no live worker exists from which average capacity can be inferred. */
  capacityPerReplica: number;
}

export interface AutoscaleSample {
  pool: WorkerPool;
  waiting: number;
  active: number;
  currentReplicas: number;
  currentCapacity: number;
  observedAt: number;
}

export interface AutoscaleState {
  lastScaleAt: number | null;
  lastDirection: 'up' | 'down' | null;
  idleSince: number | null;
  lastDesiredReplicas: number;
}

export type AutoscaleDecisionReason =
  | 'below-minimum'
  | 'above-maximum'
  | 'scale-up'
  | 'scale-down'
  | 'idle-grace'
  | 'hysteresis'
  | 'cooldown'
  | 'steady';

export interface AutoscaleDecision {
  schema: 1;
  kind: 'ck-worker-scale-decision';
  decisionId: string;
  pool: WorkerPool;
  observedAt: number;
  queue: { waiting: number; active: number };
  current: { replicas: number; capacity: number };
  desiredReplicas: number;
  changed: boolean;
  reason: AutoscaleDecisionReason;
  policy: AutoscalePolicy;
}

export interface AutoscaleDecisionResult {
  decision: AutoscaleDecision;
  nextState: AutoscaleState;
}

function integer(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} is invalid`);
}

export function validateAutoscalePolicy(policy: AutoscalePolicy): AutoscalePolicy {
  integer(policy.minReplicas, 'minReplicas');
  integer(policy.maxReplicas, 'maxReplicas', 1);
  integer(policy.targetJobsPerReplica, 'targetJobsPerReplica', 1);
  integer(policy.scaleUpCooldownMs, 'scaleUpCooldownMs');
  integer(policy.scaleDownCooldownMs, 'scaleDownCooldownMs');
  integer(policy.idleGraceMs, 'idleGraceMs');
  if (policy.minReplicas > policy.maxReplicas) throw new TypeError('minReplicas exceeds maxReplicas');
  if (!Number.isFinite(policy.hysteresis) || policy.hysteresis < 0 || policy.hysteresis > 0.9) {
    throw new TypeError('hysteresis is invalid');
  }
  if (!Number.isFinite(policy.capacityPerReplica) || policy.capacityPerReplica <= 0
    || policy.capacityPerReplica > 1_000) {
    throw new TypeError('capacityPerReplica is invalid');
  }
  return { ...policy };
}

function validateSample(sample: AutoscaleSample): void {
  integer(sample.waiting, 'waiting');
  integer(sample.active, 'active');
  integer(sample.currentReplicas, 'currentReplicas');
  integer(sample.currentCapacity, 'currentCapacity');
  integer(sample.observedAt, 'observedAt', 1);
  if (sample.currentReplicas === 0 && sample.currentCapacity !== 0) {
    throw new TypeError('currentCapacity must be zero when currentReplicas is zero');
  }
}

export function initialAutoscaleState(currentReplicas: number): AutoscaleState {
  integer(currentReplicas, 'currentReplicas');
  return {
    lastScaleAt: null,
    lastDirection: null,
    idleSince: null,
    lastDesiredReplicas: currentReplicas,
  };
}

export function parseAutoscaleState(value: unknown, currentReplicas: number): AutoscaleState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return initialAutoscaleState(currentReplicas);
  const candidate = value as Partial<AutoscaleState>;
  const nullableTime = (time: unknown): time is number | null => time === null
    || (Number.isSafeInteger(time) && Number(time) > 0);
  if (!nullableTime(candidate.lastScaleAt) || !nullableTime(candidate.idleSince)
    || (candidate.lastDirection !== null && candidate.lastDirection !== 'up' && candidate.lastDirection !== 'down')
    || !Number.isSafeInteger(candidate.lastDesiredReplicas) || Number(candidate.lastDesiredReplicas) < 0) {
    return initialAutoscaleState(currentReplicas);
  }
  return candidate as AutoscaleState;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function decisionId(decision: Omit<AutoscaleDecision, 'decisionId' | 'observedAt'>): string {
  // observedAt is deliberately excluded so retrying an unchanged decision is idempotent.
  const canonical = JSON.stringify({
    schema: decision.schema,
    kind: decision.kind,
    pool: decision.pool,
    queue: decision.queue,
    current: decision.current,
    desiredReplicas: decision.desiredReplicas,
    reason: decision.reason,
    policy: decision.policy,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function decideWorkerReplicas(
  sample: AutoscaleSample,
  policyInput: AutoscalePolicy,
  stateInput: AutoscaleState = initialAutoscaleState(sample.currentReplicas),
): AutoscaleDecisionResult {
  validateSample(sample);
  const policy = validateAutoscalePolicy(policyInput);
  const parsedState = parseAutoscaleState(stateInput, sample.currentReplicas);
  const state = parsedState.lastScaleAt !== null && parsedState.lastScaleAt > sample.observedAt
    ? initialAutoscaleState(sample.currentReplicas)
    : parsedState;
  const demand = sample.waiting + sample.active;
  const averageCapacity = sample.currentReplicas > 0 && sample.currentCapacity > 0
    ? sample.currentCapacity / sample.currentReplicas
    : policy.capacityPerReplica;
  const jobsPerReplica = averageCapacity * policy.targetJobsPerReplica;
  const activeFloor = Math.ceil(sample.active / averageCapacity);
  const rawDesired = clamp(
    Math.max(demand === 0 ? policy.minReplicas : Math.ceil(demand / jobsPerReplica), activeFloor),
    policy.minReplicas,
    policy.maxReplicas,
  );

  let desired = sample.currentReplicas;
  let reason: AutoscaleDecisionReason = 'steady';
  let idleSince = demand === 0 ? state.idleSince ?? sample.observedAt : null;
  const elapsedSinceScale = state.lastScaleAt === null ? Number.POSITIVE_INFINITY : sample.observedAt - state.lastScaleAt;

  if (sample.currentReplicas < policy.minReplicas) {
    desired = policy.minReplicas;
    reason = 'below-minimum';
  } else if (sample.currentReplicas > policy.maxReplicas) {
    desired = Math.max(policy.maxReplicas, Math.min(sample.currentReplicas, activeFloor));
    reason = desired < sample.currentReplicas ? 'above-maximum' : 'steady';
  } else if (rawDesired > sample.currentReplicas) {
    const threshold = sample.currentCapacity * policy.targetJobsPerReplica * (1 + policy.hysteresis);
    if (demand <= threshold) {
      reason = 'hysteresis';
    } else if (elapsedSinceScale < policy.scaleUpCooldownMs) {
      reason = 'cooldown';
    } else {
      desired = rawDesired;
      reason = 'scale-up';
    }
  } else if (rawDesired < sample.currentReplicas) {
    if (demand === 0 && sample.observedAt - idleSince! < policy.idleGraceMs) {
      reason = 'idle-grace';
    } else {
      const capacityAfterOneRemoval = Math.max(0, sample.currentReplicas - 1) * averageCapacity;
      const downThreshold = capacityAfterOneRemoval * policy.targetJobsPerReplica * (1 - policy.hysteresis);
      if (demand >= downThreshold && demand !== 0) {
        reason = 'hysteresis';
      } else if (elapsedSinceScale < policy.scaleDownCooldownMs) {
        reason = 'cooldown';
      } else {
        desired = Math.max(rawDesired, activeFloor, sample.currentReplicas - 1, policy.minReplicas);
        reason = 'scale-down';
      }
    }
  }

  desired = clamp(desired, policy.minReplicas, policy.maxReplicas);
  const changed = desired !== sample.currentReplicas;
  const nextState: AutoscaleState = {
    lastScaleAt: changed ? sample.observedAt : state.lastScaleAt,
    lastDirection: changed ? (desired > sample.currentReplicas ? 'up' : 'down') : state.lastDirection,
    idleSince,
    lastDesiredReplicas: desired,
  };
  const body: Omit<AutoscaleDecision, 'decisionId' | 'observedAt'> = {
    schema: 1,
    kind: 'ck-worker-scale-decision',
    pool: sample.pool,
    queue: { waiting: sample.waiting, active: sample.active },
    current: { replicas: sample.currentReplicas, capacity: sample.currentCapacity },
    desiredReplicas: desired,
    changed,
    reason,
    policy,
  };
  return {
    decision: { ...body, observedAt: sample.observedAt, decisionId: decisionId(body) },
    nextState,
  };
}

export interface AutoscaleWebhookOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  allowInsecureHttp?: boolean;
  fetcher?: typeof fetch;
}

async function errorSnippet(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < 1_024) {
      const next = await reader.read();
      if (next.done) break;
      const room = 1_024 - total;
      const chunk = next.value.subarray(0, room);
      chunks.push(chunk);
      total += chunk.length;
      if (next.value.length > room) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+/g, ' ').slice(0, 1_024);
}

/** Authenticated, bounded webhook adapter. The receiver owns host orchestration. */
export class AutoscaleWebhookAdapter {
  private readonly url: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: AutoscaleWebhookOptions) {
    this.url = new URL(options.url);
    if (this.url.username || this.url.password || this.url.hash) {
      throw new TypeError('autoscale webhook URL must not contain credentials or a fragment');
    }
    if (this.url.protocol !== 'https:' && !(options.allowInsecureHttp && this.url.protocol === 'http:')) {
      throw new TypeError('autoscale webhook must use HTTPS');
    }
    if (!options.token || options.token.length < 16 || options.token.length > 4_096 || /[\r\n]/.test(options.token)) {
      throw new TypeError('autoscale webhook token is invalid');
    }
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new TypeError('autoscale webhook timeout is invalid');
    }
    this.fetcher = options.fetcher ?? fetch;
  }

  async apply(decision: AutoscaleDecision): Promise<void> {
    if (!decision.changed) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('autoscale webhook timed out')), this.timeoutMs);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.fetcher(this.url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'idempotency-key': decision.decisionId,
          'x-arduinofast-decision-id': decision.decisionId,
        },
        body: JSON.stringify(decision),
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('autoscale webhook timed out', { cause: error });
      throw new Error(`autoscale webhook request failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const snippet = await errorSnippet(response);
      throw new Error(`autoscale webhook returned HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`);
    }
    await response.body?.cancel().catch(() => {});
  }
}
