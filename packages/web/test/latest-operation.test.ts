import { describe, expect, it } from 'vitest';
import { createLatestOperationCoordinator } from '../public/latest-operation.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('latest operation coordinator', () => {
  it('allows only the latest operation to commit when A and B finish in reverse order', async () => {
    const coordinator = createLatestOperationCoordinator();
    const aGate = deferred<string>();
    const bGate = deferred<string>();
    const committed: string[] = [];

    async function run(gate: Promise<string>) {
      const token = coordinator.begin();
      const value = await gate;
      if (!coordinator.isCurrent(token)) return false;
      committed.push(value);
      return coordinator.finish(token);
    }

    const a = run(aGate.promise);
    const b = run(bGate.promise);

    bGate.resolve('B');
    await expect(b).resolves.toBe(true);
    aGate.resolve('A');
    await expect(a).resolves.toBe(false);
    expect(committed).toEqual(['B']);
  });

  it('invalidates the previous token when a new operation begins', () => {
    const coordinator = createLatestOperationCoordinator();
    const first = coordinator.begin();
    const second = coordinator.begin();

    expect(second.generation).toBeGreaterThan(first.generation);
    expect(coordinator.isCurrent(first)).toBe(false);
    expect(coordinator.isCurrent(second)).toBe(true);
    expect(coordinator.cancel(first)).toBe(false);
    expect(coordinator.isCurrent(second)).toBe(true);
  });

  it('cancels the current operation explicitly', () => {
    const coordinator = createLatestOperationCoordinator();
    const token = coordinator.begin();

    expect(coordinator.cancel(token)).toBe(true);
    expect(coordinator.isCurrent(token)).toBe(false);
    expect(coordinator.cancel(token)).toBe(false);
  });

  it('invalidates a token after it finishes', () => {
    const coordinator = createLatestOperationCoordinator();
    const token = coordinator.begin();

    expect(coordinator.finish(token)).toBe(true);
    expect(coordinator.isCurrent(token)).toBe(false);
    expect(coordinator.finish(token)).toBe(false);
  });

  it('cancels whichever operation is current without exposing its token', () => {
    const coordinator = createLatestOperationCoordinator();
    const token = coordinator.begin();

    expect(coordinator.cancelCurrent()).toBe(true);
    expect(coordinator.isCurrent(token)).toBe(false);
    expect(coordinator.cancelCurrent()).toBe(false);
  });
});
