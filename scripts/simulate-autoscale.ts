import {
  decideWorkerReplicas,
  initialAutoscaleState,
  type AutoscalePolicy,
} from '../packages/server/src/autoscale.js';

const TICK_MS = 10_000;
const HOURS = 24;
const SAMPLES = (HOURS * 60 * 60 * 1_000) / TICK_MS;
const START = Date.UTC(2026, 0, 1);

const policy: AutoscalePolicy = {
  minReplicas: 1,
  maxReplicas: 12,
  targetJobsPerReplica: 2,
  hysteresis: 0.2,
  scaleUpCooldownMs: 30_000,
  scaleDownCooldownMs: 120_000,
  idleGraceMs: 300_000,
  capacityPerReplica: 1,
};

let replicas = 1;
let queued = 0;
let state = initialAutoscaleState(replicas);
let scaleUps = 0;
let scaleDowns = 0;
let cooldownBlocks = 0;
let maxReplicasObserved = replicas;
let maxWaiting = 0;
let boundsViolations = 0;
let workerLossRecovered = false;
let workerLossAt = -1;
const timeline: Array<Record<string, number | string>> = [];

function arrivalsAt(tick: number): number {
  if (tick >= 360 && tick < 540) return 8; // First sustained queue surge.
  if (tick >= 2_800 && tick < 3_020) return 7; // Load surrounding worker loss.
  if (tick >= 4_320 && tick < 4_350) return 10; // Rapid second surge exercises cooldown.
  return tick % 12 === 0 ? 1 : 0; // Low 24-hour background traffic.
}

for (let tick = 0; tick < SAMPLES; tick += 1) {
  const observedAt = START + tick * TICK_MS;
  queued += arrivalsAt(tick);

  if (tick === 2_879) {
    // Model a healthy externally managed pool immediately before host loss.
    replicas = Math.max(replicas, 5);
    queued += 40;
    timeline.push({ tick, event: 'worker-pool-before-loss', replicas, queued });
  }
  if (tick === 2_880) {
    replicas = Math.max(policy.minReplicas, replicas - 3);
    workerLossAt = tick;
    timeline.push({ tick, event: 'worker-loss', replicas, queued });
  }

  const active = Math.min(queued, replicas);
  const waiting = Math.max(0, queued - active);
  const result = decideWorkerReplicas({
    pool: 'esp32-xtensa',
    waiting,
    active,
    currentReplicas: replicas,
    currentCapacity: replicas,
    observedAt,
  }, policy, state);
  state = result.nextState;
  if (result.decision.reason === 'cooldown') cooldownBlocks += 1;
  if (result.decision.changed) {
    const before = replicas;
    replicas = result.decision.desiredReplicas;
    if (replicas > before) scaleUps += 1;
    else scaleDowns += 1;
    if (timeline.length < 80) {
      timeline.push({
        tick,
        event: result.decision.reason,
        before,
        after: replicas,
        waiting,
        active,
      });
    }
  }
  if (workerLossAt >= 0 && tick <= workerLossAt + 18
    && result.decision.desiredReplicas > result.decision.current.replicas) {
    workerLossRecovered = true;
  }

  queued = Math.max(0, queued - replicas);
  maxReplicasObserved = Math.max(maxReplicasObserved, replicas);
  maxWaiting = Math.max(maxWaiting, waiting);
  if (replicas < policy.minReplicas || replicas > policy.maxReplicas) boundsViolations += 1;
}

const checks = {
  queueSurgeScaled: maxReplicasObserved >= 4 && scaleUps > 0,
  recoveryScaledDown: scaleDowns > 0 && replicas === policy.minReplicas,
  workerLossRecovered,
  cooldownObserved: cooldownBlocks > 0,
  replicaBoundsHeld: boundsViolations === 0,
};
const report = {
  schema: 1,
  kind: 'ck-autoscale-long-steady-simulation',
  virtualHours: HOURS,
  tickMs: TICK_MS,
  samples: SAMPLES,
  policy,
  metrics: {
    scaleUps,
    scaleDowns,
    cooldownBlocks,
    maxReplicasObserved,
    maxWaiting,
    finalReplicas: replicas,
    finalQueued: queued,
    boundsViolations,
  },
  checks,
  passed: Object.values(checks).every(Boolean),
  timeline,
};

console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
