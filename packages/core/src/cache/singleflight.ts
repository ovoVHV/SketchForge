/**
 * 进程内同键任务合并。
 *
 * 单节点首次构建同一个 core / 库 / PCH 时，只允许一个调用真正执行，
 * 其余调用复用同一个 Promise。成功和失败后都会移除，失败不会永久卡死该键。
 */
const flights = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = flights.get(key);
  if (existing) return existing as Promise<T>;

  const promise = task().finally(() => {
    if (flights.get(key) === promise) flights.delete(key);
  });
  flights.set(key, promise);
  return promise;
}
