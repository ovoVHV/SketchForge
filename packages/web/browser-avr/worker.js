import { createAvrBrowserActionExecutor } from './firmware-builder.js';
import {
  avrActionTransferList,
  avrWorkerFailure,
  avrWorkerSuccess,
  validateAvrWorkerActionRequest,
  validateAvrWorkerControlRequest,
  validateAvrWorkerInitRequest,
} from './action-protocol.js';

export function createAvrWorkerActionMessageHandler({
  openSession = ({ assetsBase }) => createAvrBrowserActionExecutor({ assetsBase }),
  postMessage,
} = {}) {
  if (typeof openSession !== 'function' || typeof postMessage !== 'function') {
    throw new TypeError('AVR Worker Action handler dependencies are invalid');
  }
  let state = 'new';
  let session;
  let lastId = 0;

  return async (event) => {
    const raw = event?.data;
    const id = Number.isSafeInteger(raw?.id) && raw.id > 0 ? raw.id : null;
    const type = typeof raw?.type === 'string' ? raw.type : '';
    let action;
    try {
      if (type === 'init') {
        const request = validateAvrWorkerInitRequest(raw);
        if (state !== 'new' || request.id <= lastId) throw stateError('AVR Worker cannot initialize now');
        lastId = request.id;
        state = 'opening';
        session = await openSession(request);
        if (!session || typeof session.execute !== 'function') throw new TypeError('AVR Worker opener returned an invalid executor');
        state = 'ready';
        postMessage(avrWorkerSuccess('init-result', request.id));
        return;
      }
      if (type === 'action') {
        const request = validateAvrWorkerActionRequest(raw);
        action = request.action;
        if (state !== 'ready' || request.id <= lastId) throw stateError('AVR Worker is not ready for an Action');
        lastId = request.id;
        state = 'running';
        const result = await session.execute(request.action, request.inputs);
        state = 'ready';
        const response = avrWorkerSuccess('action-result', request.id, result);
        postMessage(response, avrActionTransferList(result));
        return;
      }
      if (type === 'close' || type === 'cancel') {
        const request = validateAvrWorkerControlRequest(raw);
        if (!['ready', 'running'].includes(state) || request.id <= lastId) {
          throw stateError('AVR Worker cannot close now');
        }
        lastId = request.id;
        state = 'closing';
        await session?.close?.();
        state = 'closed';
        postMessage(avrWorkerSuccess('close-result', request.id));
        return;
      }
      throw Object.assign(new TypeError('unsupported AVR Worker request'), { code: 'invalid_request', reason: 'integrity' });
    } catch (error) {
      if (state === 'opening') state = 'closed';
      else if (state === 'running') state = 'ready';
      const responseType = type === 'init' ? 'init-result' : type === 'close' || type === 'cancel' ? 'close-result' : 'action-result';
      if (id !== null) postMessage(avrWorkerFailure(responseType, id, error, action));
    }
  };
}

function stateError(message) {
  return Object.assign(new Error(message), { code: 'invalid_state', reason: 'internal' });
}

const scope = typeof self === 'undefined' ? null : self;
if (scope?.addEventListener && scope?.postMessage) {
  const handler = createAvrWorkerActionMessageHandler({
    postMessage(message, transfer) { scope.postMessage(message, transfer); },
  });
  scope.addEventListener('message', handler);
}
