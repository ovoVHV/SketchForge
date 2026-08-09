import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { describe, expect, it } from 'vitest';
import { setStaticHeaders } from '../src/static-headers.js';

describe('browser compiler static headers', () => {
  it('marks versioned AVR and content-addressed ESP32 assets immutable', () => {
    const headers = new Map<string, string>();
    const setHeaders = setStaticHeaders('C:/app/public');
    const reply = {
      header(name: string, value: string) { headers.set(name, value); },
    };

    setHeaders(reply as never, 'C:/app/public/avr/v4/tools/cc1plus.wasm');
    expect(headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');

    headers.clear();
    setHeaders(reply as never, 'C:/app/public/esp32/v2/clang/bundle.js');
    expect(headers.size).toBe(0);

    headers.clear();
    setHeaders(reply as never, 'C:/app/public/esp32/v2/runtime/packs/sdk/chunks/link-000-deadbeefcafebabe.bin');
    expect(headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');

    headers.clear();
    setHeaders(reply as never, 'C:/app/public/esp32/v3/xtensa/packs/esp32s3-sdk/chunks/link-000-deadbeefcafebabe.bin');
    expect(headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');

    headers.clear();
    setHeaders(reply as never, 'C:/app/public/esp32/v3/xtensa/packs/esp32s3-sdk/chunks/link-000-deadbeefcafebabe.bin.gz');
    expect(headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');

    headers.clear();
    setHeaders(
      reply as never,
      `C:/app/public/esp32/v2/toolchains/riscv32-esp-elf-wasm/${'a'.repeat(64)}/chunks/llvm-deadbeefcafebabe.bin.gz`,
    );
    expect(headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');

    headers.clear();
    setHeaders(
      reply as never,
      'C:/app/public/esp32/v2/toolchains/riscv32-esp-elf-wasm/latest/chunks/llvm-deadbeefcafebabe.bin.gz',
    );
    expect(headers.size).toBe(0);

    headers.clear();
    setHeaders(reply as never, 'C:/app/public/esp32/v2/runtime/runtime.json');
    expect(headers.size).toBe(0);

    headers.clear();
    setHeaders(reply as never, 'C:/app/public/esp32/v2/runtime/packs/sdk/toolchain.json');
    expect(headers.size).toBe(0);

    headers.clear();
    setHeaders(reply as never, 'C:/app/public/browser-avr.js');
    expect(headers.size).toBe(0);
  });

  it('preserves the immutable header through the Fastify static response', async () => {
    const app = Fastify();
    const publicRoot = fileURLToPath(new URL('../../web/public/', import.meta.url));
    await app.register(fastifyStatic, { root: publicRoot, setHeaders: setStaticHeaders(publicRoot) });

    try {
      const response = await app.inject({ method: 'GET', url: '/avr/v4/worker.js' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');

      const c3Bundle = await app.inject({ method: 'GET', url: '/esp32/v2/clang/bundle.js' });
      expect(c3Bundle.statusCode).toBe(200);
      expect(c3Bundle.headers['cache-control']).not.toContain('immutable');
    } finally {
      await app.close();
    }
  });
});
