import { describe, expect, it, vi } from 'vitest';
import { singleFlight } from '../src/cache/singleflight.js';

describe('singleFlight', () => {
  it('相同键的并发调用只执行一次', async () => {
    let release!: (value: number) => void;
    const task = vi.fn(() => new Promise<number>((resolve) => { release = resolve; }));

    const first = singleFlight('same-key', task);
    const second = singleFlight('same-key', task);
    expect(task).toHaveBeenCalledTimes(1);

    release(42);
    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
  });

  it('失败后允许重试', async () => {
    await expect(singleFlight('retry-key', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(singleFlight('retry-key', async () => 'ok')).resolves.toBe('ok');
  });
});
