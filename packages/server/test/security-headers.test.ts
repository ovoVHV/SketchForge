import { describe, expect, it } from 'vitest';
import {
  GATEWAY_CONTENT_SECURITY_POLICY,
  setGatewaySecurityHeaders,
} from '../src/security-headers.js';

describe('Gateway security headers', () => {
  it('locks executable code to the app origin while allowing HTTPS toolchain data', () => {
    expect(GATEWAY_CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(GATEWAY_CONTENT_SECURITY_POLICY).toContain("connect-src 'self' https:");
    expect(GATEWAY_CONTENT_SECURITY_POLICY).toContain("worker-src 'self' blob:");
    expect(GATEWAY_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(GATEWAY_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(GATEWAY_CONTENT_SECURITY_POLICY).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('sets browser hardening headers without disabling same-origin Web Serial', () => {
    const headers = new Map<string, string>();
    setGatewaySecurityHeaders({
      header(name: string, value: string) {
        headers.set(name, value);
        return this;
      },
    } as never);

    expect(headers.get('Content-Security-Policy')).toBe(GATEWAY_CONTENT_SECURITY_POLICY);
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(headers.get('Permissions-Policy')).toContain('serial=(self)');
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(headers.get('Origin-Agent-Cluster')).toBe('?1');
  });
});
