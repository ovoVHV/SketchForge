import { describe, expect, it, vi } from 'vitest';
import type { CompileEvent, CompileRequest, CompileResult, CompileService } from '@sketchforge/core';
import { JobManager, QueueClosedError, QueueFullError } from '../src/jobs.js';

const success = (payload = ''): CompileResult => ({
  status: 'success',
  artifacts: [{ name: 'firmware.hex', offset: null, sha256: 'a'.repeat(64), size: payload.length, base64: payload }],
  staticArtifacts: [],
  diagnostics: [],
  timings: { total: 1 },
  cached: false,
});

const request = (board = 'arduino:avr:uno'): CompileRequest => ({
  board,
  files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {}\n' }],
});

function immediateService(payload = ''): CompileService {
  return {
    compile: vi.fn(async (_req: CompileRequest, emit: (event: CompileEvent) => void) => {
      const result = success(payload);
      emit({ event: 'done', result });
      return result;
    }),
  } as unknown as CompileService;
}

function deferredService() {
  const releases: Array<() => void> = [];
  const service = {
    compile: vi.fn((_req: CompileRequest, emit: (event: CompileEvent) => void) =>
      new Promise<CompileResult>((resolve) => {
        releases.push(() => {
          const result = success();
          emit({ event: 'done', result });
          resolve(result);
        });
      })),
  } as unknown as CompileService;
  return { service, releases };
}

describe('JobManager', () => {
  it('按板卡成本占用槽位，并让小作业回填空闲槽', async () => {
    const { service, releases } = deferredService();
    const jobs = new JobManager(service, {
      maxConcurrent: 3,
      estimateSlots: (req) => req.board.startsWith('esp32:') ? 2 : 1,
    });

    jobs.submit(request('esp32:esp32:esp32'));
    jobs.submit(request('esp32:esp32:esp32c3'));
    jobs.submit(request());

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(jobs.stats).toMatchObject({ running: 2, runningSlots: 3, queued: 1, capacitySlots: 3 });

    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0).forEach((release) => release());
  });

  it('队头等待超时后为大作业预留槽位，避免被小作业持续插队', async () => {
    const { service, releases } = deferredService();
    const jobs = new JobManager(service, {
      maxConcurrent: 3,
      maxBackfillWaitMs: 0,
      estimateSlots: (req) => req.board.startsWith('esp32:') ? 3 : 1,
    });

    jobs.submit(request());
    jobs.submit(request('esp32:esp32:esp32'));
    jobs.submit(request());

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(jobs.stats).toMatchObject({ running: 1, runningSlots: 1, queued: 2 });

    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(jobs.stats).toMatchObject({ running: 1, runningSlots: 3, queued: 1 });

    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
  });

  it('队列达到上限后明确拒绝新作业', async () => {
    const { service, releases } = deferredService();
    const jobs = new JobManager(service, { maxConcurrent: 1, maxQueued: 1 });

    jobs.submit(request());
    jobs.submit(request());
    expect(() => jobs.submit(request())).toThrow(QueueFullError);

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
  });

  it('控制面任务与普通编译共用容量槽', async () => {
    const { service, releases } = deferredService();
    const jobs = new JobManager(service, { maxConcurrent: 1 });
    jobs.submit(request());

    let controlStarted = false;
    const control = jobs.withCapacity(request(), async () => { controlStarted = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controlStarted).toBe(false);

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await control;
    expect(controlStarted).toBe(true);
  });

  it('停机时拒绝新作业并等待在途任务排空', async () => {
    const { service, releases } = deferredService();
    const jobs = new JobManager(service, { maxConcurrent: 1 });
    jobs.submit(request());
    jobs.submit(request());
    jobs.stopAccepting();

    expect(() => jobs.submit(request())).toThrow(QueueClosedError);
    await expect(jobs.withCapacity(request(), async () => {})).rejects.toThrow(QueueClosedError);

    const idle = jobs.waitForIdle(5_000);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await expect(idle).resolves.toBe(true);
    expect(jobs.stats).toMatchObject({ running: 0, queued: 0, accepting: false });
  });

  it('完成作业超过数量上限时淘汰最旧记录', async () => {
    const jobs = new JobManager(immediateService(), {
      maxConcurrent: 1,
      maxRetainedJobs: 2,
      minRetentionMs: 0,
    });

    const first = jobs.submit(request());
    const second = jobs.submit(request());
    const third = jobs.submit(request());
    await vi.waitFor(() => expect(third.done).toBe(true));

    expect(jobs.get(first.id)).toBeUndefined();
    expect(jobs.get(second.id)).toBeDefined();
    expect(jobs.get(third.id)).toBeDefined();
  });

  it('单作业事件超限时丢弃进度，只保留最终结果', async () => {
    const service = {
      compile: vi.fn(async (_req: CompileRequest, emit: (event: CompileEvent) => void) => {
        for (let i = 0; i < 20; i++) {
          emit({ event: 'progress', stage: 'compiling', percent: i, detail: 'x'.repeat(40) });
        }
        const result = success('y'.repeat(300));
        emit({ event: 'done', result });
        return result;
      }),
    } as unknown as CompileService;
    const jobs = new JobManager(service, { maxConcurrent: 1, maxEventBytes: 200 });
    const job = jobs.submit(request());

    await vi.waitFor(() => expect(job.done).toBe(true));
    expect(job.events).toHaveLength(1);
    expect(job.events[0]?.event).toBe('done');
  });

  it('公开与分布式 gateway 对齐的 waiting、active、completed 和 failed 状态', async () => {
    const { service, releases } = deferredService();
    const jobs = new JobManager(service, { maxConcurrent: 1 });
    const first = jobs.submit(request());
    const second = jobs.submit(request());

    expect(second.state).toBe('waiting');
    await vi.waitFor(() => expect(first.state).toBe('active'));

    releases.shift()?.();
    await vi.waitFor(() => expect(first.state).toBe('completed'));
    await vi.waitFor(() => expect(second.state).toBe('active'));
    releases.shift()?.();
    await vi.waitFor(() => expect(second.state).toBe('completed'));

    const failing = new JobManager({
      compile: vi.fn(async () => { throw new Error('worker failure'); }),
    } as unknown as CompileService, { maxConcurrent: 1 });
    const failed = failing.submit(request());
    await vi.waitFor(() => expect(failed.state).toBe('failed'));
    expect(failed.result).toMatchObject({ status: 'error', reason: 'internal' });
  });

  it('uses the native Action Graph when the service exposes it', async () => {
    const actionGraph = vi.fn(async () => ({}));
    const compileBuildIr = vi.fn(async (_ir: unknown, emit: (event: CompileEvent) => void) => {
      const result = success();
      emit({ event: 'done', result });
      return result;
    });
    const jobs = new JobManager({
      compile: vi.fn(),
      planActionGraph: actionGraph,
      compileBuildIR: compileBuildIr,
    } as unknown as CompileService);

    const job = jobs.submit(request('esp32:esp32:esp32c3'));
    await vi.waitFor(() => expect(job.done).toBe(true));
    expect(actionGraph).toHaveBeenCalledOnce();
    expect(compileBuildIr).toHaveBeenCalledOnce();
  });

  it('returns planner validation errors without invoking the legacy compiler', async () => {
    const compile = vi.fn();
    const jobs = new JobManager({
      compile,
      planActionGraph: vi.fn(async () => { throw new TypeError('missing Library Pack'); }),
      compileBuildIR: vi.fn(),
    } as unknown as CompileService);

    const job = jobs.submit(request('esp32:esp32:esp32c3'));
    await vi.waitFor(() => expect(job.done).toBe(true));
    expect(job.result).toMatchObject({
      status: 'error',
      reason: 'invalid_request',
      message: 'missing Library Pack',
    });
    expect(compile).not.toHaveBeenCalled();
  });

  it('removes a cancelled waiting job without consuming a compile slot', async () => {
    const { service, releases } = deferredService();
    const jobs = new JobManager(service, { maxConcurrent: 1 });
    const active = jobs.submit(request());
    const waiting = jobs.submit(request());
    await vi.waitFor(() => expect(active.state).toBe('active'));

    expect(jobs.cancel(
      waiting.id,
      waiting.cancellation.requestId,
      waiting.cancellation.token,
    )).toMatchObject({ cancelled: true, state: 'cancelled' });
    expect(waiting).toMatchObject({ done: true, state: 'cancelled' });
    expect(waiting.result).toMatchObject({ status: 'error', reason: 'cancelled' });
    expect(jobs.stats).toMatchObject({ running: 1, queued: 0 });

    releases.shift()?.();
    await vi.waitFor(() => expect(active.done).toBe(true));
  });

  it('aborts an active Action Graph and emits one cancelled terminal event', async () => {
    let receivedSignal: AbortSignal | undefined;
    const jobs = new JobManager({
      compile: vi.fn(),
      planActionGraph: vi.fn(async () => ({})),
      compileBuildIR: vi.fn(async (
        _ir: unknown,
        emit: (event: CompileEvent) => void,
        options: { signal?: AbortSignal } = {},
      ) => {
        receivedSignal = options.signal;
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        const result: CompileResult = {
          status: 'error', reason: 'cancelled', message: 'compile was cancelled', diagnostics: [], timings: {},
        };
        emit({ event: 'done', result });
        return result;
      }),
    } as unknown as CompileService, { maxConcurrent: 1 });
    const job = jobs.submit(request());
    await vi.waitFor(() => expect(job.state).toBe('active'));

    expect(jobs.cancel(job.id, job.cancellation.requestId, 'wrong-token')).toBeNull();
    expect(jobs.cancel(job.id, job.cancellation.requestId, job.cancellation.token)).toMatchObject({
      cancelled: true,
      state: 'cancelling',
    });
    await vi.waitFor(() => expect(job.state).toBe('cancelled'));
    expect(receivedSignal?.aborted).toBe(true);
    expect(job.events.filter((event) => event.event === 'done')).toHaveLength(1);
  });

  it('does not publish a late success after active cancellation', async () => {
    const jobs = new JobManager({
      compile: vi.fn(async (
        _request: CompileRequest,
        emit: (event: CompileEvent) => void,
        options: { signal?: AbortSignal } = {},
      ) => {
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        const result = success();
        emit({ event: 'done', result });
        return result;
      }),
    } as unknown as CompileService, { maxConcurrent: 1 });
    const job = jobs.submit(request());
    await vi.waitFor(() => expect(job.state).toBe('active'));

    jobs.cancel(job.id, job.cancellation.requestId, job.cancellation.token);

    await vi.waitFor(() => expect(job.done).toBe(true));
    expect(job).toMatchObject({
      state: 'cancelled',
      result: { status: 'error', reason: 'cancelled' },
    });
    expect(job.events.filter((event) => event.event === 'done')).toEqual([
      expect.objectContaining({ result: expect.objectContaining({ reason: 'cancelled' }) }),
    ]);
  });

});
