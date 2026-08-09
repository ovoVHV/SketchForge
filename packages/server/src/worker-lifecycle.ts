export interface DrainingWorker {
  pause(doNotWaitActive?: boolean): Promise<void>;
  close(force?: boolean): Promise<void>;
  cancelAllJobs(reason?: string): void;
}

export interface WorkerReadiness {
  close(): Promise<void>;
}

export type WorkerLifecycleState = 'running' | 'draining' | 'closed';

export interface WorkerDrainResult {
  forced: boolean;
  reason: 'drained' | 'timeout' | 'pause-error';
}

export interface WorkerLifecycleOptions {
  worker: DrainingWorker;
  readiness: WorkerReadiness;
  drainTimeoutMs: number;
  onError?: (phase: 'readiness' | 'pause' | 'cancel' | 'close', error: unknown) => void;
}

type DrainOutcome =
  | { type: 'drained' }
  | { type: 'timeout' }
  | { type: 'pause-error'; error: unknown };

function assertTimerDuration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError(`${label} must be a positive 32-bit integer`);
  }
}

/** Owns the wall deadline and BullMQ cancellation signal for one active job. */
export class WorkerJobLifetime {
  private readonly controller = new AbortController();
  private readonly deadlineTimer: NodeJS.Timeout;
  private deadlineReached = false;
  private closed = false;

  constructor(
    timeoutMs: number,
    private readonly workerSignal?: AbortSignal,
  ) {
    assertTimerDuration(timeoutMs, 'worker job timeout');
    if (workerSignal?.aborted) this.abortFromWorker();
    else workerSignal?.addEventListener('abort', this.abortFromWorker, { once: true });
    this.deadlineTimer = setTimeout(() => {
      if (this.controller.signal.aborted) return;
      this.deadlineReached = true;
      this.controller.abort(new Error('compile job wall-clock deadline exceeded'));
    }, timeoutMs);
    this.deadlineTimer.unref();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get deadlineExceeded(): boolean {
    return this.deadlineReached;
  }

  abort(reason?: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.deadlineTimer);
    this.workerSignal?.removeEventListener('abort', this.abortFromWorker);
  }

  private readonly abortFromWorker = (): void => {
    this.abort(this.workerSignal?.reason);
  };
}

function invoke(operation: () => Promise<void>): Promise<void> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

function waitForDrain(quiescence: Promise<void>, timeoutMs: number): Promise<DrainOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
    timer.unref();
    void quiescence.then(
      () => {
        clearTimeout(timer);
        resolve({ type: 'drained' });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ type: 'pause-error', error });
      },
    );
  });
}

/** Coordinates capability withdrawal, BullMQ draining, and bounded shutdown. */
export class WorkerLifecycle {
  private currentState: WorkerLifecycleState = 'running';
  private shutdownPromise?: Promise<WorkerDrainResult>;

  constructor(private readonly options: WorkerLifecycleOptions) {
    assertTimerDuration(options.drainTimeoutMs, 'worker drain timeout');
  }

  get state(): WorkerLifecycleState {
    return this.currentState;
  }

  shutdown(signal: string): Promise<WorkerDrainResult> {
    if (!this.shutdownPromise) {
      this.currentState = 'draining';
      this.shutdownPromise = this.drain(signal);
    }
    return this.shutdownPromise;
  }

  private async drain(signal: string): Promise<WorkerDrainResult> {
    // close() marks CapabilityHeartbeat closed synchronously, so no future beat
    // can re-advertise this worker while BullMQ is disconnecting its fetch loop.
    const readinessClose = invoke(() => this.options.readiness.close()).catch((error: unknown) => {
      this.options.onError?.('readiness', error);
    });
    const pause = invoke(() => this.options.worker.pause(false));
    const quiescence = Promise.all([readinessClose, pause]).then(() => undefined);
    const outcome = await waitForDrain(quiescence, this.options.drainTimeoutMs);

    try {
      if (outcome.type === 'drained') {
        await this.options.worker.close(false);
        return { forced: false, reason: 'drained' };
      }

      if (outcome.type === 'pause-error') {
        this.options.onError?.('pause', outcome.error);
      }
      try {
        this.options.worker.cancelAllJobs(`worker draining after ${signal}`);
      } catch (error) {
        this.options.onError?.('cancel', error);
      }
      await this.options.worker.close(true);
      void readinessClose;
      return {
        forced: true,
        reason: outcome.type === 'timeout' ? 'timeout' : 'pause-error',
      };
    } catch (error) {
      this.options.onError?.('close', error);
      throw error;
    } finally {
      this.currentState = 'closed';
    }
  }
}
