import {
  createAvrWorkerActionRequest,
  createAvrWorkerControlRequest,
  createAvrWorkerInitRequest,
  validateAvrWorkerResponse,
} from './action-protocol.js';

let sequence = 0;

export function createAvrBrowserWorkerLauncher({
  WorkerClass = globalThis.Worker,
  timeoutMs = 30_000,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10 * 60_000) {
    throw new TypeError('AVR Worker timeout is invalid');
  }
  return Object.freeze({
    openActionSession(input) {
      return openActionSession({ ...input, WorkerClass, timeoutMs });
    },
  });
}

/** Open one disposable, Action-only AVR Worker session. */
export function openAvrBrowserActionSession(input = {}) {
  return createAvrBrowserWorkerLauncher().openActionSession(input);
}

async function openActionSession({ assetsBase, signal, WorkerClass, timeoutMs }) {
  if (typeof WorkerClass !== 'function') throw workerError('worker_unavailable', 'AVR browser Worker is unavailable');
  if (signal !== undefined && !isAbortSignal(signal)) throw new TypeError('AVR Worker signal is invalid');
  if (signal?.aborted) throw workerError('aborted', 'AVR Worker session was aborted');

  let worker;
  try {
    worker = new WorkerClass(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch (error) {
    throw workerError('worker_create', errorMessage(error));
  }
  if (!worker || typeof worker.addEventListener !== 'function' || typeof worker.postMessage !== 'function') {
    try { worker?.terminate?.(); } catch { /* Best-effort cleanup. */ }
    throw workerError('worker_create', 'AVR Worker does not implement the Action transport');
  }

  let state = 'opening';
  let pending;
  let closePromise;
  let sessionAbortListener;

  const terminate = () => {
    if (state === 'closed') return;
    state = 'closed';
    signal?.removeEventListener?.('abort', sessionAbortListener);
    try { worker.terminate?.(); } catch { /* Best-effort cleanup. */ }
  };

  const clearPending = () => {
    const operation = pending;
    if (!operation) return undefined;
    pending = undefined;
    clearTimeout(operation.timeout);
    operation.signal?.removeEventListener?.('abort', operation.abortListener);
    return operation;
  };

  const failSession = (error) => {
    const operation = clearPending();
    terminate();
    operation?.reject(error);
  };

  const send = (message, expectedType, context = {}, transfer = [], requestSignal) => {
    if (state === 'closed') return Promise.reject(workerError('session_closed', 'AVR Worker session is closed'));
    if (pending) return Promise.reject(workerError('worker_protocol', 'AVR Worker requests must be sequential'));
    if (requestSignal !== undefined && !isAbortSignal(requestSignal)) {
      return Promise.reject(new TypeError('AVR Worker Action signal is invalid'));
    }
    if (requestSignal?.aborted) {
      terminate();
      return Promise.reject(workerError('aborted', 'AVR Worker Action was aborted'));
    }
    return new Promise((resolve, reject) => {
      const abortListener = () => {
        if (pending?.id !== message.id) return;
        failSession(workerError('aborted', 'AVR Worker Action was aborted'));
      };
      const timeout = setTimeout(() => {
        if (pending?.id !== message.id) return;
        failSession(workerError('timeout', `AVR Worker ${message.type} request exceeded ${timeoutMs} ms`));
      }, timeoutMs);
      pending = {
        id: message.id,
        expectedType,
        context,
        resolve,
        reject,
        timeout,
        signal: requestSignal,
        abortListener,
      };
      requestSignal?.addEventListener?.('abort', abortListener, { once: true });
      try {
        worker.postMessage(message, transfer);
      } catch (error) {
        failSession(workerError('worker_post', errorMessage(error)));
      }
    });
  };

  worker.addEventListener('message', (event) => {
    const operation = pending;
    if (!operation) {
      failSession(workerError('worker_protocol', 'AVR Worker sent an unsolicited response'));
      return;
    }
    let response;
    try {
      response = validateAvrWorkerResponse(event.data, {
        expectedType: operation.expectedType,
        id: operation.id,
        action: operation.context.action,
      });
    } catch (error) {
      failSession(workerError('worker_protocol', errorMessage(error)));
      return;
    }
    clearPending();
    if (!response.ok) {
      if (response.type === 'action-result') {
        operation.resolve({
          ok: false,
          status: 'error',
          ...response.error,
        });
      } else {
        operation.reject(workerError(response.error.code, response.error.message, response.error.reason));
      }
      return;
    }
    operation.resolve(response.type === 'action-result' ? response.result : undefined);
  });
  worker.addEventListener('error', (event) => {
    failSession(workerError('worker_error', event?.message || 'AVR Worker failed'));
  });

  const init = createAvrWorkerInitRequest({ id: ++sequence, assetsBase });
  try {
    await send(init, 'init-result', {}, [], signal);
  } catch (error) {
    terminate();
    throw error;
  }
  if (signal?.aborted) {
    terminate();
    throw workerError('aborted', 'AVR Worker session was aborted');
  }
  state = 'open';
  if (signal) {
    sessionAbortListener = () => failSession(workerError('aborted', 'AVR Worker session was aborted'));
    signal.addEventListener('abort', sessionAbortListener, { once: true });
  }

  const runAction = async (action, context = {}) => {
    if (state !== 'open') throw workerError('session_closed', 'AVR Worker session is closed');
    const inputs = [];
    for (const declaration of action?.inputs ?? []) {
      const value = Object.hasOwn(context, 'inputs')
        ? context.inputs[inputs.length]?.bytes
        : await context.readFile?.(declaration.path);
      const path = Object.hasOwn(context, 'inputs')
        ? context.inputs[inputs.length]?.path
        : declaration.path;
      inputs.push({ path, bytes: value });
    }
    const request = createAvrWorkerActionRequest({ id: ++sequence, action, inputs });
    return send(
      request,
      'action-result',
      { action: request.action },
      request.inputs.map((inputFile) => inputFile.bytes.buffer),
      context.signal,
    );
  };

  const close = () => {
    if (closePromise) return closePromise;
    if (state === 'closed') return Promise.resolve();
    if (pending) {
      failSession(workerError('session_closed', 'AVR Worker session was closed'));
      return Promise.resolve();
    }
    state = 'closing';
    const request = createAvrWorkerControlRequest('close', ++sequence);
    closePromise = send(request, 'close-result').finally(terminate);
    return closePromise;
  };

  return Object.freeze({
    runAction,
    executeAction: runAction,
    close,
    cancel() { failSession(workerError('aborted', 'AVR Worker session was cancelled')); },
    get closed() { return state === 'closed'; },
  });
}

function isAbortSignal(value) {
  return value && typeof value === 'object' && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function' && typeof value.removeEventListener === 'function';
}

function workerError(code, message, reason = code === 'timeout' ? 'timeout' : 'internal') {
  const error = new Error(message);
  error.code = code;
  error.reason = reason;
  return error;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
