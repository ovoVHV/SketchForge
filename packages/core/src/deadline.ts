export interface DeadlineOptions {
  /** Caller cancellation. A DeadlineExceededError reason is classified as timeout. */
  signal?: AbortSignal;
  /** Absolute Unix epoch in milliseconds shared by every stage of one job. */
  deadlineAt?: number;
}

export type InterruptionReason = 'timeout' | 'cancelled';

export class DeadlineExceededError extends Error {
  constructor(message = 'compile job wall-clock deadline exceeded') {
    super(message);
    this.name = 'DeadlineExceededError';
  }
}

export class OperationCancelledError extends Error {
  constructor(message = 'compile was cancelled') {
    super(message);
    this.name = 'OperationCancelledError';
  }
}

export function isDeadlineExceededError(value: unknown): value is DeadlineExceededError {
  return value instanceof DeadlineExceededError
    || (value instanceof Error && value.name === 'DeadlineExceededError');
}

export function isOperationCancelledError(value: unknown): value is OperationCancelledError {
  return value instanceof OperationCancelledError
    || (value instanceof Error && value.name === 'OperationCancelledError');
}

export function interruptionReason(
  options: DeadlineOptions,
  now = Date.now(),
): InterruptionReason | null {
  if (options.signal?.aborted) {
    return isDeadlineExceededError(options.signal.reason) ? 'timeout' : 'cancelled';
  }
  if (options.deadlineAt !== undefined && deadlineRemainingMs(options.deadlineAt, now) === 0) {
    return 'timeout';
  }
  return null;
}

export function deadlineRemainingMs(deadlineAt: number, now = Date.now()): number {
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0) {
    throw new TypeError('deadlineAt must be a non-negative safe integer');
  }
  return Math.max(0, deadlineAt - now);
}

export function interruptionError(options: DeadlineOptions): DeadlineExceededError | OperationCancelledError {
  return interruptionReason(options) === 'timeout'
    ? new DeadlineExceededError()
    : new OperationCancelledError();
}

export function throwIfInterrupted(options: DeadlineOptions): void {
  const reason = interruptionReason(options);
  if (reason === 'timeout') throw new DeadlineExceededError();
  if (reason === 'cancelled') throw new OperationCancelledError();
}

/**
 * Bounds an asynchronous stage and checks the clock again after synchronous
 * work returns. The latter is important for in-process preprocessing, where a
 * timer cannot run while JavaScript is on the stack.
 */
export async function raceWithDeadline<T>(
  operation: PromiseLike<T>,
  options: DeadlineOptions,
): Promise<T> {
  throwIfInterrupted(options);
  if (!options.signal && options.deadlineAt === undefined) return operation;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(interruptionError(options));
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.deadlineAt !== undefined) {
      timer = setTimeout(
        () => reject(new DeadlineExceededError()),
        deadlineRemainingMs(options.deadlineAt),
      );
      timer.unref?.();
    }
  });

  try {
    const value = await Promise.race([Promise.resolve(operation), interrupted]);
    throwIfInterrupted(options);
    return value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (options.signal && onAbort) options.signal.removeEventListener('abort', onAbort);
  }
}
