import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecRequest, SandboxExecutor } from '@arduinofast/core';
import {
  DEFAULT_LIMITS,
  DeadlineExceededError,
  OperationCancelledError,
} from '@arduinofast/core';
import { JobDeadline, JobDeadlineExecutor } from '../src/deadline-executor.js';

const request = (): ExecRequest => ({
  command: 'compiler',
  args: [],
  cwd: '.',
  timeoutMs: 60_000,
  limits: DEFAULT_LIMITS,
});

afterEach(() => vi.useRealTimers());

describe('JobDeadline', () => {
  it('rejects a job whose queue wait consumed the absolute deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const operation = vi.fn(() => 'late success');
    const deadline = new JobDeadline(9_999);

    await expect(deadline.run(operation)).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(operation).not.toHaveBeenCalled();
    expect(deadline.timedOut).toBe(true);
    deadline.dispose();
  });

  it('aborts a running stage when the shared wall deadline arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const deadline = new JobDeadline(20_050);
    const running = deadline.run(() => new Promise<void>((resolve) => {
      deadline.signal.addEventListener('abort', () => resolve(), { once: true });
    }));
    const rejected = expect(running).rejects.toBeInstanceOf(DeadlineExceededError);

    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(deadline.reason).toBe('timeout');
    expect(deadline.signal.reason).toBeInstanceOf(DeadlineExceededError);
    deadline.dispose();
  });

  it('keeps caller cancellation distinct from a wall timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const caller = new AbortController();
    const deadline = new JobDeadline(31_000, caller.signal);
    caller.abort(new Error('consumer cancelled'));

    await expect(deadline.run(() => 'unused')).rejects.toBeInstanceOf(OperationCancelledError);
    expect(deadline.reason).toBe('cancelled');
    expect(deadline.timedOut).toBe(false);
    deadline.dispose();
  });
});

describe('JobDeadlineExecutor', () => {
  it('clamps every command to the remaining whole-job wall budget', async () => {
    const exec = vi.fn(async (req: ExecRequest) => ({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      truncated: false,
      requestedTimeout: req.timeoutMs,
    }));
    const delegate = { name: 'fake', isolationLevel: 'namespace', exec } as SandboxExecutor;
    const executor = new JobDeadlineExecutor(delegate);
    executor.begin(250);
    await executor.exec(request());
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(0);
    expect(exec.mock.calls[0]?.[0].timeoutMs).toBeLessThanOrEqual(250);
  });

  it('refuses to start another compiler after the whole-job deadline', async () => {
    const delegate = { name: 'fake', isolationLevel: 'namespace', exec: vi.fn() } as unknown as SandboxExecutor;
    const executor = new JobDeadlineExecutor(delegate);
    executor.begin(0);
    const result = await executor.exec(request());
    expect(result.timedOut).toBe(true);
    expect(delegate.exec).not.toHaveBeenCalled();
  });

  it('forwards the caller cancellation signal to the sandbox', async () => {
    const exec = vi.fn(async () => ({
      code: 0, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, truncated: false,
    }));
    const delegate = { name: 'fake', isolationLevel: 'namespace', exec } as SandboxExecutor;
    const executor = new JobDeadlineExecutor(delegate);
    const controller = new AbortController();
    await executor.exec({ ...request(), signal: controller.signal });
    expect(exec.mock.calls[0]?.[0].signal).toBe(controller.signal);
  });
});

describe('distributed worker deadline wiring', () => {
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

  it('uses the queued absolute deadline through planning, execution, and publication', () => {
    expect(source).toContain('resolveCompileJobDeadlineAt(job.data, jobTimeoutMs)');
    expect(source).toContain('executor.beginAt(deadlineAt)');
    expect(source).toMatch(/planActionGraph\(validation\.request,\s*\{\s*signal: lifetime\.signal,\s*deadlineAt,/);
    expect(source).toMatch(/compileBuildIR\(planned, publish, \{\s*signal: lifetime\.signal,\s*deadlineAt,/);
    expect(source).toContain('lifetime.run(() => artifacts.externalize(compiled))');
  });
});
