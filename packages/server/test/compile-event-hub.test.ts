import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({
  constructors: [] as Array<{ name: string; prefix: string | undefined }>,
}));

vi.mock('bullmq', () => ({
  QueueEvents: class FakeQueueEvents extends EventEmitter {
    constructor(
      readonly name: string,
      options: { prefix?: string },
    ) {
      super();
      observed.constructors.push({ name, prefix: options.prefix });
    }

    async waitUntilReady(): Promise<void> {}
    async close(): Promise<void> {}
  },
}));

import type { Redis } from 'ioredis';
import { CompileEventHub } from '../src/compile-event-hub.js';
import { createCompileRedisNamespace } from '../src/compile-namespace.js';
import { bullQueueIdentityForNamespace, WORKER_POOLS } from '../src/distributed-queue.js';

describe('CompileEventHub queue namespace', () => {
  beforeEach(() => observed.constructors.splice(0));

  it('listens to every pool with the same BullMQ prefix used by its bundle', async () => {
    const namespace = createCompileRedisNamespace('test-compile', 'bundle-v1');
    const hub = new CompileEventHub({} as Redis, namespace);

    expect(observed.constructors).toEqual(WORKER_POOLS.map((pool) => {
      const identity = bullQueueIdentityForNamespace(namespace, pool);
      return { name: identity.name, prefix: identity.prefix };
    }));

    await hub.ready();
    await hub.close();
  });

  it('does not subscribe a new bundle to an old bundle event stream', async () => {
    const first = createCompileRedisNamespace('test-compile', 'bundle-v1');
    const second = createCompileRedisNamespace('test-compile', 'bundle-v2');
    const firstHub = new CompileEventHub({} as Redis, first);
    const secondHub = new CompileEventHub({} as Redis, second);

    const qualified = observed.constructors.map(({ name, prefix }) => `${prefix}:${name}`);
    expect(new Set(qualified).size).toBe(WORKER_POOLS.length * 2);

    await Promise.all([firstHub.close(), secondHub.close()]);
  });
});
