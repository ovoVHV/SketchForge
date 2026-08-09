import { describe, expect, it } from 'vitest';
import { normalizePublicBasePath, prefixPublicPath } from '../src/public-base-path.js';

describe('public response base path', () => {
  it('keeps the existing root deployment as the default', () => {
    expect(normalizePublicBasePath(undefined)).toBe('');
    expect(normalizePublicBasePath('')).toBe('');
    expect(normalizePublicBasePath('/')).toBe('');
    expect(prefixPublicPath(undefined, '/v1/compile/job/events'))
      .toBe('/v1/compile/job/events');
  });

  it('normalizes a configured subpath and prefixes public response URLs', () => {
    expect(normalizePublicBasePath(' /arduino/ ')).toBe('/arduino');
    expect(normalizePublicBasePath('/tools/arduino///')).toBe('/tools/arduino');
    expect(prefixPublicPath('/arduino', '/v1/compile/job/events'))
      .toBe('/arduino/v1/compile/job/events');
    expect(prefixPublicPath('/arduino/', '/v1/compile/job/requests/request'))
      .toBe('/arduino/v1/compile/job/requests/request');
  });

  it.each([
    'arduino',
    '//arduino',
    '/arduino//editor',
    '/arduino/./editor',
    '/arduino/../editor',
    '/arduino editor',
    '/arduino?mode=editor',
    '/arduino#editor',
    '/arduino\\editor',
  ])('rejects invalid AF_PUBLIC_BASE_PATH value %j', (value) => {
    expect(() => normalizePublicBasePath(value)).toThrow(/AF_PUBLIC_BASE_PATH/);
  });

  it('rejects a non-rooted internal response path', () => {
    expect(() => prefixPublicPath('/arduino', 'v1/compile'))
      .toThrow(/exactly one slash/);
    expect(() => prefixPublicPath('/arduino', '//example.test/v1/compile'))
      .toThrow(/exactly one slash/);
  });
});
