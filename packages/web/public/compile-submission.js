export function validCancellationHandle(value) {
  return Boolean(
    value
    && typeof value.requestId === 'string'
    && typeof value.url === 'string'
    && /^\/(?:[^/?#]+\/)*v1\/compile\/[^/?#]+\/requests\/[^/?#]+$/.test(value.url)
    && typeof value.token === 'string'
    && value.token.length >= 32
    && value.token.length <= 128
  );
}

export function validateCompileAcceptance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('响应必须是 JSON 对象');
  }
  if (typeof value.jobId !== 'string' || !value.jobId) {
    throw new Error('响应缺少作业 ID');
  }
  if (typeof value.stream !== 'string' || !value.stream) {
    throw new Error('响应缺少事件流地址');
  }
  if (value.cancellation != null && !validCancellationHandle(value.cancellation)) {
    throw new Error('响应包含无效的取消句柄');
  }
  return value;
}

/** Commit the remote handle before observing a cancellation requested during POST. */
export async function commitCompileAcceptance({
  accepted,
  isCancellationRequested,
  commit,
  cancelAccepted,
  abandonAccepted,
}) {
  const value = validateCompileAcceptance(accepted);
  // Persist the accepted handle before returning control to the caller.  The
  // commit hook may be asynchronous (IndexedDB in the normal browser path);
  // treating it as fire-and-forget creates a refresh window in which the POST
  // has been accepted but no recovery record exists yet.
  await commit(value);
  if (!isCancellationRequested()) return 'accepted';
  if (validCancellationHandle(value.cancellation)) {
    await cancelAccepted(value.cancellation);
    return 'cancelled-remotely';
  }
  abandonAccepted();
  return 'cancelled-locally';
}
