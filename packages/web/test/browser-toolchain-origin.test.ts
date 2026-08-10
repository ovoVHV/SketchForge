import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_TOOLCHAIN_ORIGINS_KEY,
  LEGACY_BROWSER_TOOLCHAIN_ORIGINS_KEY,
  resolveBrowserToolchainBase,
  resolveBrowserToolchainMirrorUrl,
} from '../public/toolchain-origin.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser toolchain CDN origin resolver', () => {
  const fallback = 'https://app.example.test/avr/v3/';

  it('uses the local immutable release when an operator has not configured a CDN', () => {
    expect(resolveBrowserToolchainBase({
      id: 'arduino-avr-uno',
      fallback,
      origins: undefined,
    }).href).toBe(fallback);
  });

  it('permits a file URL only for the module fallback used by Node tests', () => {
    expect(resolveBrowserToolchainBase({
      id: 'arduino-avr-uno',
      fallback: 'file:///workspace/avr/v3/',
      origins: undefined,
    }).href).toBe('file:///workspace/avr/v3/');

    expect(() => resolveBrowserToolchainBase({
      id: 'arduino-avr-uno',
      fallback: 'file:///workspace/avr/v3/',
      origins: { 'arduino-avr-uno': 'file:///tmp/compiler/' },
    })).toThrow(/HTTPS/);
  });

  it('uses a configured HTTPS CDN release and normalizes its trailing slash', () => {
    expect(resolveBrowserToolchainBase({
      id: 'arduino-avr-uno',
      fallback,
      origins: { 'arduino-avr-uno': 'https://cdn.example.test/toolchains/avr/v3' },
    }).href).toBe('https://cdn.example.test/toolchains/avr/v3/');
  });

  it('allows an HTTP override only on the same local-development origin', () => {
    expect(resolveBrowserToolchainBase({
      id: 'arduino-avr-uno',
      fallback: 'http://127.0.0.1:3000/avr/v3/',
      pageUrl: 'http://127.0.0.1:3000/',
      origins: { 'arduino-avr-uno': 'http://127.0.0.1:3000/toolchains/avr/v3/' },
    }).href).toBe('http://127.0.0.1:3000/toolchains/avr/v3/');
  });

  it('reads the page-level configuration used by a static deployment', () => {
    vi.stubGlobal(BROWSER_TOOLCHAIN_ORIGINS_KEY, {
      'arduino-avr-uno': 'https://cdn.example.test/avr/v3/',
    });
    expect(resolveBrowserToolchainBase({ id: 'arduino-avr-uno', fallback }).href)
      .toBe('https://cdn.example.test/avr/v3/');
  });

  it('falls back to the pre-rename page-level configuration', () => {
    vi.stubGlobal(LEGACY_BROWSER_TOOLCHAIN_ORIGINS_KEY, {
      'arduino-avr-uno': 'https://legacy-cdn.example.test/avr/v3/',
    });
    expect(resolveBrowserToolchainBase({ id: 'arduino-avr-uno', fallback }).href)
      .toBe('https://legacy-cdn.example.test/avr/v3/');
  });

  it('prefers the current page-level configuration over the legacy one', () => {
    vi.stubGlobal(BROWSER_TOOLCHAIN_ORIGINS_KEY, {
      'arduino-avr-uno': 'https://current-cdn.example.test/avr/v3/',
    });
    vi.stubGlobal(LEGACY_BROWSER_TOOLCHAIN_ORIGINS_KEY, {
      'arduino-avr-uno': 'https://legacy-cdn.example.test/avr/v3/',
    });
    expect(resolveBrowserToolchainBase({ id: 'arduino-avr-uno', fallback }).href)
      .toBe('https://current-cdn.example.test/avr/v3/');
  });

  it('rejects an external HTTP origin and URL credentials', () => {
    expect(() => resolveBrowserToolchainBase({
      id: 'arduino-avr-uno',
      fallback,
      origins: { 'arduino-avr-uno': 'http://cdn.example.test/avr/v3/' },
    })).toThrow(/HTTPS/);
    expect(() => resolveBrowserToolchainBase({
      id: 'arduino-avr-uno',
      fallback,
      origins: { 'arduino-avr-uno': 'https://user:pass@cdn.example.test/avr/v3/' },
    })).toThrow(/credentials/);
  });

  it('maps one pinned data file onto a configured mirror root', () => {
    expect(resolveBrowserToolchainMirrorUrl({
      id: 'esp32-browser-data',
      fallbackRoot: 'https://app.example.test/arduino/',
      fallbackUrl: 'https://app.example.test/arduino/esp32/v2/runtime/runtime.json',
      origins: { 'esp32-browser-data': 'https://assets.example.test/arduino/' },
    }).href).toBe('https://assets.example.test/arduino/esp32/v2/runtime/runtime.json');
  });

  it('keeps mirror mapping on the application origin when no CDN is configured', () => {
    expect(resolveBrowserToolchainMirrorUrl({
      id: 'esp32-browser-data',
      fallbackRoot: 'https://app.example.test/arduino/',
      fallbackUrl: 'esp32/v5/xtensa/esp32s3.json',
      origins: undefined,
    }).href).toBe('https://app.example.test/arduino/esp32/v5/xtensa/esp32s3.json');
  });

  it('rejects mirror targets outside the application release root', () => {
    expect(() => resolveBrowserToolchainMirrorUrl({
      id: 'esp32-browser-data',
      fallbackRoot: 'https://app.example.test/arduino/',
      fallbackUrl: 'https://app.example.test/private/runtime.json',
      origins: { 'esp32-browser-data': 'https://assets.example.test/arduino/' },
    })).toThrow(/release root/);
  });
});
