import { describe, expect, it } from 'vitest';
import {
  assertCompileRedisNamespace,
  compileRedisKey,
  createCompileRedisNamespace,
} from '../src/compile-namespace.js';
import { compileCancellationNamespace } from '../src/compile-cancellation.js';
import { workerCapabilityNamespace } from '../src/capabilities.js';
import {
  bullQueueIdentityForNamespace,
  compileRequestByteLedgerKey,
  queueName,
  queueNameForNamespace,
} from '../src/distributed-queue.js';
import { compileEventNamespace } from '../src/distributed-events.js';

describe('compile Redis namespace', () => {
  it('derives every queue key and BullMQ identity from bundle and release identities', () => {
    const namespace = createCompileRedisNamespace('deploy-a', 'bundle-v1');

    expect(Object.isFrozen(namespace)).toBe(true);
    expect(namespace.bundleHash).toMatch(/^[a-f0-9]{24}$/);
    expect(namespace.releaseId).toBe('unverified-local');
    expect(namespace.releaseHash).toMatch(/^[a-f0-9]{24}$/);
    expect(namespace.redisPrefix)
      .toBe(`deploy-a:b${namespace.bundleHash}:r${namespace.releaseHash}`);
    expect(namespace.bullPrefix)
      .toBe(`deploy-a:bullmq:b${namespace.bundleHash}:r${namespace.releaseHash}`);
    expect(namespace.bullQueueStem)
      .toBe(`deploy-a-b${namespace.bundleHash}-r${namespace.releaseHash}`);
    expect(queueNameForNamespace(namespace, 'avr'))
      .toBe(`${namespace.bullQueueStem}-avr`);
    expect(queueName('deploy-a', 'avr', 'bundle-v1'))
      .toBe(queueNameForNamespace(namespace, 'avr'));
    expect(bullQueueIdentityForNamespace(namespace, 'avr')).toEqual({
      name: queueNameForNamespace(namespace, 'avr'),
      prefix: namespace.bullPrefix,
      qualifiedName: `${namespace.bullPrefix}:${queueNameForNamespace(namespace, 'avr')}`,
    });

    for (const key of [
      compileRequestByteLedgerKey(namespace),
      compileCancellationNamespace(namespace),
      compileEventNamespace(namespace),
      workerCapabilityNamespace(namespace),
    ]) {
      expect(key.startsWith(`${namespace.redisPrefix}:`)).toBe(true);
    }
  });

  it('isolates the same compiler bundle between host runtime releases', () => {
    const firstRelease = `sha256:${'a'.repeat(64)}`;
    const secondRelease = `sha256:${'b'.repeat(64)}`;
    const first = createCompileRedisNamespace('deploy-a', 'bundle-v1', firstRelease);
    const second = createCompileRedisNamespace('deploy-a', 'bundle-v1', secondRelease);

    expect(first.bundleHash).toBe(second.bundleHash);
    expect(first.releaseHash).not.toBe(second.releaseHash);
    expect(first.redisPrefix).not.toBe(second.redisPrefix);
    expect(first.bullPrefix).not.toBe(second.bullPrefix);
    expect(queueName('deploy-a', 'avr', 'bundle-v1', firstRelease))
      .not.toBe(queueName('deploy-a', 'avr', 'bundle-v1', secondRelease));
  });

  it('isolates both custom Redis keys and BullMQ keys between bundle revisions', () => {
    const first = createCompileRedisNamespace('deploy-a', 'bundle-v1');
    const second = createCompileRedisNamespace('deploy-a', 'bundle-v2');

    expect(second.bundleHash).not.toBe(first.bundleHash);
    expect(second.redisPrefix).not.toBe(first.redisPrefix);
    expect(second.bullPrefix).not.toBe(first.bullPrefix);
    expect(queueNameForNamespace(second, 'esp32-riscv'))
      .not.toBe(queueNameForNamespace(first, 'esp32-riscv'));
    expect(compileEventNamespace(second)).not.toBe(compileEventNamespace(first));
    expect(compileCancellationNamespace(second)).not.toBe(compileCancellationNamespace(first));
    expect(workerCapabilityNamespace(second)).not.toBe(workerCapabilityNamespace(first));
  });

  it('rejects invalid input and forged derived fields', () => {
    expect(() => createCompileRedisNamespace('bad prefix', 'bundle-v1')).toThrow(/queue prefix/);
    expect(() => createCompileRedisNamespace('deploy-a', '../bundle')).toThrow(/bundle id/);
    expect(() => createCompileRedisNamespace('deploy-a', 'bundle-v1', 'latest'))
      .toThrow(/release id/);
    expect(() => compileRedisKey(createCompileRedisNamespace('deploy-a', 'bundle-v1'), 'bad:key'))
      .toThrow(/key part/);

    const valid = createCompileRedisNamespace('deploy-a', 'bundle-v1');
    expect(() => assertCompileRedisNamespace({ ...valid, bullPrefix: 'bull' }))
      .toThrow(/inconsistent/);
    expect(() => assertCompileRedisNamespace({ ...valid, releaseHash: '0'.repeat(24) }))
      .toThrow(/inconsistent/);
  });
});
