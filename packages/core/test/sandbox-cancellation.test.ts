import { describe, expect, it } from 'vitest';
import { LocalExecutor } from '../src/sandbox/local.js';
import { DEFAULT_LIMITS } from '../src/sandbox/types.js';

describe('Sandbox cancellation', () => {
  it('terminates a running local process tree without reporting a timeout', async () => {
    const controller = new AbortController();
    const execution = new LocalExecutor().exec({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      timeoutMs: 30_000,
      limits: DEFAULT_LIMITS,
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 100);
    const result = await execution;
    clearTimeout(timer);

    expect(controller.signal.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeLessThan(5_000);
    expect(result.code).not.toBe(0);
  }, 10_000);

  it('does not spawn an already cancelled command', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await new LocalExecutor().exec({
      command: 'this-command-must-not-run',
      args: [],
      cwd: process.cwd(),
      timeoutMs: 30_000,
      limits: DEFAULT_LIMITS,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ code: null, timedOut: false, durationMs: 0 });
  });
});
