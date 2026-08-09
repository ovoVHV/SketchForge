import { describe, expect, it, vi } from 'vitest';

import {
  commitCompileAcceptance,
  validCancellationHandle,
  validateCompileAcceptance,
} from '../public/compile-submission.js';

const cancellation = {
  requestId: 'request-1',
  url: '/v1/compile/job-1/requests/request-1',
  token: 'a'.repeat(32),
};

const accepted = {
  jobId: 'job-1',
  stream: '/v1/compile/job-1/events',
  cancellation,
};

describe('remote compile submission', () => {
  it('validates the request-scoped cancellation handle', () => {
    expect(validCancellationHandle(cancellation)).toBe(true);
    expect(validCancellationHandle({
      ...cancellation,
      url: '/arduino/v1/compile/job-1/requests/request-1',
    })).toBe(true);
    expect(validCancellationHandle({ ...cancellation, url: 'https://attacker.invalid/cancel' })).toBe(false);
    expect(() => validateCompileAcceptance({ ...accepted, cancellation: { token: 'short' } }))
      .toThrow(/无效的取消句柄/);
  });

  it('commits a late POST response before immediately cancelling its remote request', async () => {
    const events: string[] = [];
    let cancellationRequested = false;
    let resolveResponse!: (value: typeof accepted) => void;
    const responseArrived = new Promise<typeof accepted>((resolve) => { resolveResponse = resolve; });
    const cancelAccepted = vi.fn(async () => { events.push('delete'); });
    const settling = responseArrived.then((value) => commitCompileAcceptance({
      accepted: value,
      isCancellationRequested: () => cancellationRequested,
      commit: () => { events.push('commit'); },
      cancelAccepted,
      abandonAccepted: () => { events.push('abandon'); },
    }));

    cancellationRequested = true;
    resolveResponse(accepted);

    await expect(settling).resolves.toBe('cancelled-remotely');
    expect(events).toEqual(['commit', 'delete']);
    expect(cancelAccepted).toHaveBeenCalledOnce();
    expect(cancelAccepted).toHaveBeenCalledWith(cancellation);
  });

  it('does not expose an accepted handle until its durable commit finishes', async () => {
    const gate = deferred();
    const events: string[] = [];
    let settled = false;
    const committing = commitCompileAcceptance({
      accepted,
      isCancellationRequested: () => false,
      commit: async () => {
        events.push('commit-start');
        await gate.promise;
        events.push('commit-done');
      },
      cancelAccepted: vi.fn(),
      abandonAccepted: vi.fn(),
    });
    void committing.then(() => { settled = true; });

    await vi.waitFor(() => expect(events).toEqual(['commit-start']));
    expect(settled).toBe(false);
    gate.resolve();
    await expect(committing).resolves.toBe('accepted');
    expect(events).toEqual(['commit-start', 'commit-done']);
  });

  it('abandons a cancelled response that has no server cancellation handle', async () => {
    const abandonAccepted = vi.fn();
    await expect(commitCompileAcceptance({
      accepted: { jobId: 'job-1', stream: '/v1/compile/job-1/events' },
      isCancellationRequested: () => true,
      commit: vi.fn(),
      cancelAccepted: vi.fn(),
      abandonAccepted,
    })).resolves.toBe('cancelled-locally');
    expect(abandonAccepted).toHaveBeenCalledOnce();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}
