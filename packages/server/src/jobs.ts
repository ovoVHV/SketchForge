/**
 * 编译作业管理：并发闸门 + 事件缓冲 + SSE 订阅。
 *
 * 为什么要有作业和事件缓冲，而不是"POST 进来直接流式返回"：
 *   1. 前端拿到 job_id 后才去连 SSE，这中间编译可能已经开始甚至结束了。
 *      没有缓冲的话这些事件就丢了，前端永远等不到 done。
 *   2. 有了作业队列才能做并发闸门和背压 —— 公网产品必须能在过载时
 *      明确拒绝（429），而不是把请求无限堆进内存。
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { cpus } from 'node:os';
import { Buffer } from 'node:buffer';
import type { CompileEvent, CompileRequest, CompileResult, CompileService } from '@arduinofast/core';

export interface JobRecord {
  id: string;
  createdAt: number;
  finishedAt?: number;
  /** 与分布式 gateway 的 BullMQ 状态对齐，供轮询恢复 SSE 断流后的作业。 */
  state: 'waiting' | 'active' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  /** 已产生的事件，供迟到的订阅者回放 */
  events: CompileEvent[];
  /** 事件缓冲估算字节数，用于限制固件结果占用内存 */
  eventBytes: number;
  /** 本作业占用的调度槽数。ESP32 可配置为高于 AVR */
  slots: number;
  done: boolean;
  result?: CompileResult;
  subscribers: Set<(e: CompileEvent) => void>;
  cancellation: {
    requestId: string;
    token: string;
  };
}

export interface JobManagerOptions {
  /** 同时执行的编译数上限 */
  maxConcurrent?: number;
  /** 排队上限，超过直接拒绝（背压） */
  maxQueued?: number;
  /** 作业记录保留时长(ms)，到点清理 */
  ttlMs?: number;
  /** 最多保留多少个作业记录（运行中的作业不受此限制） */
  maxRetainedJobs?: number;
  /** 已完成作业事件缓冲的总字节上限 */
  maxRetainedBytes?: number;
  /** 单个作业最多缓冲多少事件字节；done 事件始终保留 */
  maxEventBytes?: number;
  /** 作业完成后的最短保留时间，给浏览器留下连接 SSE 的窗口 */
  minRetentionMs?: number;
  /** 按请求估算需要占用多少编译槽 */
  estimateSlots?: (req: CompileRequest) => number;
  /** 队头等待超过该时长后停止回填小任务，避免大任务永久饥饿 */
  maxBackfillWaitMs?: number;
}

interface Waiter {
  slots: number;
  enqueuedAt: number;
  jobId?: string;
  resolve: (acquired: boolean) => void;
}

interface JobControl {
  controller: AbortController;
  waiter?: Waiter;
  terminalResult?: CompileResult;
  emit: (event: CompileEvent) => void;
}

export interface JobCancelResult {
  cancelled: boolean;
  jobCancelled: boolean;
  state: JobRecord['state'];
  remainingConsumers: 0;
}

export class QueueFullError extends Error {
  constructor() {
    super('编译队列已满，请稍后重试');
    this.name = 'QueueFullError';
  }
}

export class QueueClosedError extends Error {
  constructor() {
    super('编译服务正在排空，请稍后重试');
    this.name = 'QueueClosedError';
  }
}

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly controls = new Map<string, JobControl>();
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly ttlMs: number;
  private readonly maxRetainedJobs: number;
  private readonly maxRetainedBytes: number;
  private readonly maxEventBytes: number;
  private readonly minRetentionMs: number;
  private readonly estimateSlots: (req: CompileRequest) => number;
  private readonly maxBackfillWaitMs: number;

  private running = 0;
  private runningSlots = 0;
  private readonly waiting: Waiter[] = [];
  private accepting = true;
  private readonly idleWaiters = new Set<() => void>();

  constructor(
    private readonly service: CompileService,
    opts: JobManagerOptions = {},
  ) {
    this.maxConcurrent = opts.maxConcurrent ?? Math.max(1, cpus().length - 1);
    this.maxQueued = opts.maxQueued ?? 64;
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxRetainedJobs = opts.maxRetainedJobs ?? 256;
    this.maxRetainedBytes = opts.maxRetainedBytes ?? 128 * 1024 * 1024;
    this.maxEventBytes = opts.maxEventBytes ?? 8 * 1024 * 1024;
    this.minRetentionMs = opts.minRetentionMs ?? 5_000;
    this.estimateSlots = opts.estimateSlots ?? (() => 1);
    this.maxBackfillWaitMs = opts.maxBackfillWaitMs ?? 5_000;

    setInterval(() => this.sweep(), 60_000).unref();
  }

  /** Prefer the shared CK Action Graph for every supported service. */
  private async compileRequest(
    request: CompileRequest,
    emit: (event: CompileEvent) => void,
    signal: AbortSignal,
  ): Promise<CompileResult> {
    const candidate = this.service as CompileService & {
      planActionGraph?: (request: CompileRequest) => Promise<import('@arduinofast/core').BuildIR>;
      compileBuildIR?: (
        ir: import('@arduinofast/core').BuildIR,
        emit: (event: CompileEvent) => void,
        options?: import('@arduinofast/core').BuildExecutionOptions,
      ) => Promise<CompileResult>;
    };
    const planner = typeof candidate.planActionGraph === 'function'
      ? candidate.planActionGraph.bind(candidate)
      : undefined;
    if (planner && typeof candidate.compileBuildIR === 'function') {
      try {
        if (signal.aborted) return this.cancelledResult();
        const ir = await planner(request);
        if (signal.aborted) return this.cancelledResult();
        return candidate.compileBuildIR(ir, emit, { signal });
      } catch (error) {
        if (signal.aborted) return this.cancelledResult();
        if (error instanceof TypeError) {
          const result: CompileResult = {
            status: 'error',
            reason: 'invalid_request',
            message: error.message,
            diagnostics: [],
            timings: {},
          };
          emit({ event: 'done', result });
          return result;
        }
        throw error;
      }
    }
    return this.service.compile(request, emit, { signal });
  }

  get stats() {
    return {
      running: this.running,
      runningSlots: this.runningSlots,
      capacitySlots: this.maxConcurrent,
      queued: this.waiting.length,
      jobs: this.jobs.size,
      retainedBytes: this.retainedBytes(),
      accepting: this.accepting,
    };
  }

  /** 创建作业并立即开始排队执行。队列满时抛 QueueFullError */
  submit(req: CompileRequest): JobRecord {
    if (!this.accepting) throw new QueueClosedError();
    this.pruneCompleted();
    if (this.waiting.length >= this.maxQueued) throw new QueueFullError();

    const slots = this.slotsFor(req);
    const id = randomUUID();
    const requestId = randomUUID();
    const token = randomBytes(32).toString('base64url');

    const job: JobRecord = {
      id,
      createdAt: Date.now(),
      state: 'waiting',
      events: [],
      eventBytes: 0,
      slots,
      done: false,
      subscribers: new Set(),
      cancellation: { requestId, token },
    };
    this.jobs.set(job.id, job);

    const control: JobControl = {
      controller: new AbortController(),
      emit: () => {},
    };
    this.controls.set(job.id, control);

    const emit = (incoming: CompileEvent) => {
      if (job.done || control.terminalResult) return;
      const e = incoming.event === 'done'
        && control.controller.signal.aborted
        && !(incoming.result.status === 'error' && incoming.result.reason === 'cancelled')
        ? { event: 'done' as const, result: this.cancelledResult(job.createdAt) }
        : incoming;
      if (e.event === 'done') control.terminalResult = e.result;
      const bytes = Buffer.byteLength(JSON.stringify(e), 'utf8');
      if (e.event === 'done' && job.eventBytes + bytes > this.maxEventBytes) {
        // 最终结果包含完整诊断和固件。内存紧张时优先保留它，丢弃可重建的进度事件。
        job.events.length = 0;
        job.eventBytes = 0;
      }
      if (e.event === 'done' || job.eventBytes + bytes <= this.maxEventBytes) {
        job.events.push(e);
        job.eventBytes += bytes;
      }
      for (const s of job.subscribers) {
        try { s(e); } catch { /* 订阅者断开，忽略 */ }
      }
    };
    control.emit = emit;

    // 立刻推一个 queued 事件，前端能显示排队状态
    if (this.waiting.length > 0 || this.runningSlots + slots > this.maxConcurrent) {
      emit({ event: 'progress', stage: 'queued', percent: 0, detail: `队列中，前面还有 ${this.waiting.length} 个` });
    }

    void this.acquire(slots, job.id).then(async (acquired) => {
      if (!acquired) return;
      job.state = control.controller.signal.aborted ? 'cancelling' : 'active';
      try {
        let result = await this.compileRequest(req, emit, control.controller.signal);
        if (control.controller.signal.aborted && !(result.status === 'error' && result.reason === 'cancelled')) {
          result = this.cancelledResult(job.createdAt);
        }
        job.result = result;
        if (!control.terminalResult) emit({ event: 'done', result });
        job.state = result.status === 'error' && result.reason === 'cancelled'
          ? 'cancelled'
          : 'completed';
      } catch (err) {
        const result: CompileResult = control.controller.signal.aborted
          ? this.cancelledResult(job.createdAt)
          : {
              status: 'error',
              reason: 'internal',
              message: String((err as Error)?.message ?? err),
              diagnostics: [],
              timings: {},
            };
        job.result = result;
        job.state = control.controller.signal.aborted ? 'cancelled' : 'failed';
        if (!control.terminalResult) emit({ event: 'done', result });
      } finally {
        this.release(slots);
        this.finishJob(job);
      }
    });

    return job;
  }

  /** 让库试编译等控制面任务与普通编译共用同一套容量闸门。 */
  async withCapacity<T>(req: CompileRequest, task: () => Promise<T>): Promise<T> {
    if (!this.accepting) throw new QueueClosedError();
    if (this.waiting.length >= this.maxQueued) throw new QueueFullError();
    const slots = this.slotsFor(req);
    await this.acquire(slots);
    try {
      return await task();
    } finally {
      this.release(slots);
    }
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  cancel(id: string, requestId: string, token: string): JobCancelResult | null {
    const job = this.jobs.get(id);
    const control = this.controls.get(id);
    if (!job || !control || !this.matchesCancellation(job, requestId, token)) return null;
    if (job.done || control.terminalResult) {
      return {
        cancelled: false,
        jobCancelled: false,
        state: job.state,
        remainingConsumers: 0,
      };
    }

    if (job.state === 'waiting' && control.waiter) {
      const index = this.waiting.indexOf(control.waiter);
      if (index >= 0) this.waiting.splice(index, 1);
      const waiter = control.waiter;
      control.waiter = undefined;
      waiter.resolve(false);

      const result = this.cancelledResult(job.createdAt);
      job.result = result;
      job.state = 'cancelled';
      control.emit({ event: 'done', result });
      this.finishJob(job);
      this.drain();
      this.notifyIdle();
      return {
        cancelled: true,
        jobCancelled: true,
        state: job.state,
        remainingConsumers: 0,
      };
    }

    job.state = 'cancelling';
    control.controller.abort();
    return {
      cancelled: true,
      jobCancelled: true,
      state: job.state,
      remainingConsumers: 0,
    };
  }

  /** 订阅：先回放已缓冲的事件，再接收后续事件。返回退订函数 */
  subscribe(job: JobRecord, onEvent: (e: CompileEvent) => void): () => void {
    for (const e of job.events) onEvent(e);
    if (job.done) return () => {};
    job.subscribers.add(onEvent);
    return () => job.subscribers.delete(onEvent);
  }

  stopAccepting(): void {
    this.accepting = false;
    this.notifyIdle();
  }

  /** 停止接单后等待运行中和排队中的任务完成。超时返回 false。 */
  waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.running === 0 && this.waiting.length === 0) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        resolve(idle);
      };
      const onIdle = () => finish(true);
      this.idleWaiters.add(onIdle);
      timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      timer.unref();
    });
  }

  private slotsFor(req: CompileRequest): number {
    const estimated = Math.ceil(this.estimateSlots(req));
    return Math.max(1, Math.min(this.maxConcurrent, Number.isFinite(estimated) ? estimated : 1));
  }

  private acquire(slots: number, jobId?: string): Promise<boolean> {
    if (this.waiting.length === 0 && this.runningSlots + slots <= this.maxConcurrent) {
      this.running++;
      this.runningSlots += slots;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = { slots, enqueuedAt: Date.now(), resolve, ...(jobId ? { jobId } : {}) };
      this.waiting.push(waiter);
      const control = jobId ? this.controls.get(jobId) : undefined;
      if (control) control.waiter = waiter;
      this.drain();
    });
  }

  private release(slots: number): void {
    this.running--;
    this.runningSlots -= slots;
    this.drain();
    this.notifyIdle();
  }

  private notifyIdle(): void {
    if (this.running !== 0 || this.waiting.length !== 0) return;
    for (const resolve of [...this.idleWaiters]) resolve();
  }

  /** 在不超过槽位上限的前提下回填小作业，避免大作业造成队头阻塞。 */
  private drain(): void {
    for (;;) {
      const available = this.maxConcurrent - this.runningSlots;
      const head = this.waiting[0];
      if (
        head &&
        head.slots > available &&
        Date.now() - head.enqueuedAt >= this.maxBackfillWaitMs
      ) {
        // 队头已经等得够久：暂时留空闲槽，等在跑的任务释放后优先启动它。
        return;
      }
      const index = this.waiting.findIndex((w) => w.slots <= available);
      if (index < 0) return;
      const [next] = this.waiting.splice(index, 1);
      if (!next) return;
      this.running++;
      this.runningSlots += next.slots;
      const control = next.jobId ? this.controls.get(next.jobId) : undefined;
      if (control) {
        control.waiter = undefined;
      }
      next.resolve(true);
    }
  }

  private cancelledResult(startedAt = Date.now()): CompileResult {
    return {
      status: 'error',
      reason: 'cancelled',
      message: 'compile was cancelled',
      diagnostics: [],
      timings: { total: Math.max(0, Date.now() - startedAt) },
    };
  }

  private matchesCancellation(job: JobRecord, requestId: string, token: string): boolean {
    if (requestId !== job.cancellation.requestId) return false;
    const expected = Buffer.from(job.cancellation.token, 'utf8');
    const actual = Buffer.from(token, 'utf8');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private finishJob(job: JobRecord): void {
    if (job.done) return;
    job.done = true;
    job.finishedAt = Date.now();
    for (const subscriber of job.subscribers) {
      try { (subscriber as { close?: () => void }).close?.(); } catch { /* ignored */ }
    }
    this.pruneCompleted();
    const timer = setTimeout(() => this.pruneCompleted(), this.minRetentionMs + 1);
    timer.unref();
  }

  private deleteJob(id: string): void {
    this.jobs.delete(id);
    this.controls.delete(id);
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      if (job.done && (job.finishedAt ?? job.createdAt) < cutoff) this.deleteJob(id);
    }
    this.pruneCompleted();
  }

  private retainedBytes(): number {
    let total = 0;
    for (const job of this.jobs.values()) total += job.eventBytes;
    return total;
  }

  private pruneCompleted(): void {
    const eligibleBefore = Date.now() - this.minRetentionMs;
    const candidates = [...this.jobs.values()]
      .filter((job) => job.done && job.subscribers.size === 0 && (job.finishedAt ?? 0) <= eligibleBefore)
      .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));

    let retainedBytes = this.retainedBytes();
    for (const job of candidates) {
      if (this.jobs.size <= this.maxRetainedJobs && retainedBytes <= this.maxRetainedBytes) break;
      if (this.jobs.has(job.id)) {
        this.deleteJob(job.id);
        retainedBytes -= job.eventBytes;
      }
    }
  }
}
