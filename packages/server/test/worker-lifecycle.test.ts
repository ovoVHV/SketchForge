import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkerJobLifetime,
  WorkerLifecycle,
  type DrainingWorker,
  type WorkerReadiness,
} from '../src/worker-lifecycle.js';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkerLifecycle', () => {
  it('withdraws readiness, stops fetching, and waits for active work before closing', async () => {
    const events: string[] = [];
    const active = deferred();
    const worker: DrainingWorker = {
      pause: vi.fn(async (doNotWaitActive) => {
        events.push(`pause:${String(doNotWaitActive)}`);
        await active.promise;
      }),
      close: vi.fn(async (force) => { events.push(`close:${String(force)}`); }),
      cancelAllJobs: vi.fn(),
    };
    const readiness: WorkerReadiness = {
      close: vi.fn(async () => { events.push('readiness:close'); }),
    };
    const lifecycle = new WorkerLifecycle({ worker, readiness, drainTimeoutMs: 1_000 });

    const shutdown = lifecycle.shutdown('SIGTERM');
    expect(lifecycle.shutdown('SIGINT')).toBe(shutdown);
    expect(lifecycle.state).toBe('draining');
    expect(events).toEqual(['readiness:close', 'pause:false']);
    expect(worker.close).not.toHaveBeenCalled();

    active.resolve();
    await expect(shutdown).resolves.toEqual({ forced: false, reason: 'drained' });

    expect(events).toEqual(['readiness:close', 'pause:false', 'close:false']);
    expect(worker.pause).toHaveBeenCalledTimes(1);
    expect(worker.cancelAllJobs).not.toHaveBeenCalled();
    expect(lifecycle.state).toBe('closed');
  });

  it('cancels active processors and force-closes when the drain deadline expires', async () => {
    vi.useFakeTimers();
    const worker: DrainingWorker = {
      pause: vi.fn(() => new Promise<void>(() => {})),
      close: vi.fn(async () => {}),
      cancelAllJobs: vi.fn(),
    };
    const readiness: WorkerReadiness = { close: vi.fn(async () => {}) };
    const lifecycle = new WorkerLifecycle({ worker, readiness, drainTimeoutMs: 250 });

    const shutdown = lifecycle.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(249);
    expect(worker.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(shutdown).resolves.toEqual({ forced: true, reason: 'timeout' });

    expect(worker.pause).toHaveBeenCalledWith(false);
    expect(worker.cancelAllJobs).toHaveBeenCalledWith('worker draining after SIGTERM');
    expect(worker.close).toHaveBeenCalledWith(true);
    expect(lifecycle.state).toBe('closed');
  });

  it('force-closes when BullMQ cannot establish the pause boundary', async () => {
    const errors: Array<[string, unknown]> = [];
    const pauseError = new Error('pause failed');
    const worker: DrainingWorker = {
      pause: vi.fn(async () => { throw pauseError; }),
      close: vi.fn(async () => {}),
      cancelAllJobs: vi.fn(),
    };
    const readiness: WorkerReadiness = { close: vi.fn(async () => {}) };
    const lifecycle = new WorkerLifecycle({
      worker,
      readiness,
      drainTimeoutMs: 1_000,
      onError: (phase, error) => { errors.push([phase, error]); },
    });

    await expect(lifecycle.shutdown('SIGINT'))
      .resolves.toEqual({ forced: true, reason: 'pause-error' });

    expect(errors).toEqual([['pause', pauseError]]);
    expect(worker.cancelAllJobs).toHaveBeenCalledOnce();
    expect(worker.close).toHaveBeenCalledWith(true);
  });

  it('does not hang forever when an in-flight readiness heartbeat cannot settle', async () => {
    vi.useFakeTimers();
    const worker: DrainingWorker = {
      pause: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      cancelAllJobs: vi.fn(),
    };
    const readiness: WorkerReadiness = {
      close: vi.fn(() => new Promise<void>(() => {})),
    };
    const lifecycle = new WorkerLifecycle({ worker, readiness, drainTimeoutMs: 100 });

    const shutdown = lifecycle.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(100);
    await expect(shutdown).resolves.toEqual({ forced: true, reason: 'timeout' });

    expect(worker.close).toHaveBeenCalledWith(true);
    expect(lifecycle.state).toBe('closed');
  });

  it('still force-closes when cancelling active processors throws', async () => {
    const cancelError = new Error('cancel failed');
    const errors: Array<[string, unknown]> = [];
    const worker: DrainingWorker = {
      pause: vi.fn(async () => { throw new Error('pause failed'); }),
      close: vi.fn(async () => {}),
      cancelAllJobs: vi.fn(() => { throw cancelError; }),
    };
    const readiness: WorkerReadiness = { close: vi.fn(async () => {}) };
    const lifecycle = new WorkerLifecycle({
      worker,
      readiness,
      drainTimeoutMs: 100,
      onError: (phase, error) => { errors.push([phase, error]); },
    });

    await expect(lifecycle.shutdown('SIGTERM'))
      .resolves.toEqual({ forced: true, reason: 'pause-error' });

    expect(errors.map(([phase]) => phase)).toEqual(['pause', 'cancel']);
    expect(errors[1]?.[1]).toBe(cancelError);
    expect(worker.close).toHaveBeenCalledWith(true);
  });

  it('validates the hard drain timeout', () => {
    const worker: DrainingWorker = {
      pause: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      cancelAllJobs: vi.fn(),
    };
    const readiness: WorkerReadiness = { close: vi.fn(async () => {}) };

    expect(() => new WorkerLifecycle({ worker, readiness, drainTimeoutMs: 0 }))
      .toThrow('worker drain timeout');
  });
});

describe('WorkerJobLifetime', () => {
  it('marks only its own wall deadline as a timeout', async () => {
    vi.useFakeTimers();
    const lifetime = new WorkerJobLifetime(250);

    await vi.advanceTimersByTimeAsync(249);
    expect(lifetime.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(lifetime.signal.aborted).toBe(true);
    expect(lifetime.deadlineExceeded).toBe(true);
    expect((lifetime.signal.reason as Error).message).toContain('wall-clock deadline');
    lifetime.close();
  });

  it('forwards BullMQ cancellation without misclassifying it as a timeout', async () => {
    vi.useFakeTimers();
    const workerController = new AbortController();
    const lifetime = new WorkerJobLifetime(250, workerController.signal);
    const reason = new Error('worker is draining');

    workerController.abort(reason);
    expect(lifetime.signal.aborted).toBe(true);
    expect(lifetime.signal.reason).toBe(reason);
    expect(lifetime.deadlineExceeded).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(lifetime.deadlineExceeded).toBe(false);
    lifetime.close();
  });

  it('stops observing the external signal after close', () => {
    const workerController = new AbortController();
    const lifetime = new WorkerJobLifetime(250, workerController.signal);

    lifetime.close();
    lifetime.close();
    workerController.abort(new Error('late abort'));

    expect(lifetime.signal.aborted).toBe(false);
  });
});
