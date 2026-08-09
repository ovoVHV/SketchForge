import { describe, expect, it } from 'vitest';
import { isRedisUnavailableError } from '../src/redis.js';

describe('isRedisUnavailableError', () => {
  it('recognizes fast-fail Redis connection errors without hiding unrelated bugs', () => {
    expect(isRedisUnavailableError(new Error('Command timed out'))).toBe(true);
    expect(isRedisUnavailableError(new Error('Connection is closed.'))).toBe(true);
    expect(isRedisUnavailableError(Object.assign(new Error('attempts exhausted'), {
      name: 'MaxRetriesPerRequestError',
    }))).toBe(true);
    expect(isRedisUnavailableError(new TypeError('cannot read property x'))).toBe(false);
  });
});
