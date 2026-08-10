import {
  DeadlineExceededError,
  deadlineRemainingMs,
  interruptionReason,
  raceWithDeadline,
  throwIfInterrupted,
  type DeadlineOptions,
  type ExecRequest,
  type ExecResult,
  type InterruptionReason,
  type SandboxExecutor,
} from '@sketchforge/core';

/** One abort signal and one absolute clock shared by every stage of a job. */
export class JobDeadline implements DeadlineOptions {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly externalSignal: AbortSignal | undefined;
  private readonly onExternalAbort: (() => void) | undefined;

  constructor(readonly deadlineAt: number, externalSignal?: AbortSignal) {
    const remaining = deadlineRemainingMs(deadlineAt);
    this.signal = this.controller.signal;
    this.externalSignal = externalSignal;
    this.onExternalAbort = externalSignal
      ? () => this.controller.abort(externalSignal.reason)
      : undefined;

    if (externalSignal?.aborted) this.onExternalAbort!();
    else if (this.onExternalAbort) externalSignal!.addEventListener('abort', this.onExternalAbort, { once: true });

    if (this.controller.signal.aborted) return;
    if (remaining === 0) {
      this.controller.abort(new DeadlineExceededError());
      return;
    }
    this.timer = setTimeout(
      () => this.controller.abort(new DeadlineExceededError()),
      remaining,
    );
    this.timer.unref?.();
  }

  get reason(): InterruptionReason | null {
    return interruptionReason(this);
  }

  get timedOut(): boolean {
    return this.reason === 'timeout';
  }

  remainingMs(): number {
    return deadlineRemainingMs(this.deadlineAt);
  }

  throwIfInterrupted(): void {
    throwIfInterrupted(this);
  }

  abort(reason?: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  async run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    this.throwIfInterrupted();
    const running = Promise.resolve().then(operation);
    return raceWithDeadline(running, this);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.externalSignal && this.onExternalAbort) {
      this.externalSignal.removeEventListener('abort', this.onExternalAbort);
    }
  }
}

/**
 * Enforces one wall-clock budget across every compiler/linker invocation in a
 * job. Workers intentionally run concurrency=1, so a resettable wrapper avoids
 * rebuilding and re-hashing the complete toolchain for every request.
 */
export class JobDeadlineExecutor implements SandboxExecutor {
  readonly name: string;
  readonly isolationLevel: SandboxExecutor['isolationLevel'];
  private deadline = Number.POSITIVE_INFINITY;

  constructor(private readonly delegate: SandboxExecutor) {
    this.name = `${delegate.name}+job-deadline`;
    this.isolationLevel = delegate.isolationLevel;
  }

  begin(timeoutMs: number): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new TypeError('timeoutMs must be a non-negative safe integer');
    }
    this.beginAt(Date.now() + timeoutMs);
  }

  beginAt(deadlineAt: number): void {
    deadlineRemainingMs(deadlineAt);
    this.deadline = deadlineAt;
  }

  end(): void {
    this.deadline = Number.POSITIVE_INFINITY;
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    const remaining = this.deadline === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : deadlineRemainingMs(this.deadline);
    if (remaining === 0) {
      return {
        code: null,
        signal: null,
        stdout: '',
        stderr: '[sketchforge] compile job wall-clock deadline exceeded',
        durationMs: 0,
        timedOut: true,
        truncated: false,
      };
    }
    return this.delegate.exec({
      ...request,
      timeoutMs: Math.max(1, Math.min(request.timeoutMs, remaining)),
    });
  }
}
