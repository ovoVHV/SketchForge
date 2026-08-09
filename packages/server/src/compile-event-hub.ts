import { QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import type { CompileRedisNamespace } from './compile-namespace.js';
import { bullQueueIdentityForNamespace, WORKER_POOLS } from './distributed-queue.js';
import type { SequencedCompileEvent } from './distributed-events.js';

type Listener = (event: SequencedCompileEvent) => void;

/** One BullMQ event connection per pool, fanned out to local SSE clients. */
export class CompileEventHub {
  private readonly events: QueueEvents[];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(redis: Redis, namespace: CompileRedisNamespace) {
    this.events = WORKER_POOLS.map((pool) => {
      const identity = bullQueueIdentityForNamespace(namespace, pool);
      const queueEvents = new QueueEvents(identity.name, {
        connection: redis,
        prefix: identity.prefix,
      });
      queueEvents.on('progress', ({ jobId, data }) => {
        const envelope = this.parse(data);
        if (!envelope) return;
        for (const listener of this.listeners.get(jobId) ?? []) {
          try { listener(envelope); } catch { /* disconnected SSE client */ }
        }
      });
      // QueueEvents is an EventEmitter; leaving `error` unhandled can terminate
      // the gateway during a transient Redis disconnect.
      queueEvents.on('error', () => { /* readiness and route calls fail closed */ });
      return queueEvents;
    });
  }

  async ready(): Promise<void> {
    await Promise.all(this.events.map((events) => events.waitUntilReady()));
  }

  subscribe(jobId: string, listener: Listener): () => void {
    let set = this.listeners.get(jobId);
    if (!set) {
      set = new Set();
      this.listeners.set(jobId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) this.listeners.delete(jobId);
    };
  }

  subscriberCount(jobId: string): number {
    return this.listeners.get(jobId)?.size ?? 0;
  }

  async close(): Promise<void> {
    await Promise.all(this.events.map((events) => events.close()));
  }

  private parse(data: unknown): SequencedCompileEvent | null {
    try {
      const value = typeof data === 'string' ? JSON.parse(data) as unknown : data;
      if (!value || typeof value !== 'object') return null;
      const envelope = value as Partial<SequencedCompileEvent>;
      if (typeof envelope.id !== 'string' || !envelope.event || typeof envelope.event !== 'object') return null;
      return envelope as SequencedCompileEvent;
    } catch {
      return null;
    }
  }
}
