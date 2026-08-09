import { describe, expect, it } from 'vitest';

import { apiUrl, applicationUrl } from '../public/deployment-url.js';

describe('deployment URL resolution', () => {
  it('keeps root deployments on the root API namespace', () => {
    expect(apiUrl('boards', 'https://studio.example.test/app.js'))
      .toBe('https://studio.example.test/v1/boards');
  });

  it('keeps resources and APIs inside an operator path prefix', () => {
    const moduleUrl = 'https://studio.example.test/arduino/app.js';
    expect(apiUrl('/v1/projects/demo', moduleUrl))
      .toBe('https://studio.example.test/arduino/v1/projects/demo');
    expect(applicationUrl('avr/v4/worker.js', moduleUrl))
      .toBe('https://studio.example.test/arduino/avr/v4/worker.js');
  });

  it('rejects traversal outside the application prefix', () => {
    expect(() => apiUrl('../v1/boards', 'https://studio.example.test/arduino/app.js'))
      .toThrow('application path is invalid');
  });
});
