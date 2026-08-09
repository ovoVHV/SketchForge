import { describe, expect, it, vi } from 'vitest';

import {
  DeadlineExceededError,
  OperationCancelledError,
  interruptionReason,
  raceWithDeadline,
} from '../src/deadline.js';

describe('whole-job deadline primitives', () => {
  it('checks the absolute clock again after synchronous work returns', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
    try {
      const running = Promise.resolve().then(() => {
        clock.mockReturnValue(200);
        return 'late success';
      });
      await expect(raceWithDeadline(running, { deadlineAt: 150 }))
        .rejects.toBeInstanceOf(DeadlineExceededError);
    } finally {
      clock.mockRestore();
    }
  });

  it('preserves caller cancellation instead of relabeling it as timeout', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    const options = { signal: controller.signal, deadlineAt: Date.now() + 1_000 };

    expect(interruptionReason(options)).toBe('cancelled');
    await expect(raceWithDeadline(Promise.resolve('unused'), options))
      .rejects.toBeInstanceOf(OperationCancelledError);
  });
});
