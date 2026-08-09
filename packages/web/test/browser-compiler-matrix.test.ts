import { describe, expect, it } from 'vitest';
import { browserBoardRoute } from '../public/browser-compiler.js';

describe('browser compiler board route matrix', () => {
  it.each([
    'arduino:avr:uno',
    'arduino:avr:diecimila',
    'arduino:avr:nano',
    'esp32:esp32:esp32',
    'esp32:esp32:esp32c3',
    'esp32:esp32:esp32c6',
    'esp32:esp32:esp32s2',
    'esp32:esp32:esp32s3',
  ])('routes %s to the browser compiler', (board) => {
    expect(browserBoardRoute(board)).toEqual({
      supported: true,
      execution: 'browser',
    });
  });

  it.each([
    'arduino:avr:mega',
    'esp32:esp32:esp32c5',
    'esp32:esp32:esp32h2',
    'esp32:esp32:esp32p4',
  ])('keeps %s explicit until its browser Pack is published', (board) => {
    expect(browserBoardRoute(board)).toEqual({
      supported: false,
      execution: 'server',
      reason: 'browser_pack',
    });
  });

  it('does not classify an unrelated or malformed board as a browser-pack miss', () => {
    expect(browserBoardRoute('stm32:stm32:unknown')).toEqual({
      supported: false,
      execution: 'server',
      reason: 'board',
    });
    expect(browserBoardRoute(null)).toEqual({
      supported: false,
      execution: 'server',
      reason: 'board',
    });
  });
});
