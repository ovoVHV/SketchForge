import type { FastifyReply } from 'fastify';

export const GATEWAY_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "manifest-src 'self'",
].join('; ');

/** Security defaults shared by HTML, API, SSE, and static compiler responses. */
export function setGatewaySecurityHeaders(reply: Pick<FastifyReply, 'header'>): void {
  reply.header('Content-Security-Policy', GATEWAY_CONTENT_SECURITY_POLICY);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), serial=(self)');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Origin-Agent-Cluster', '?1');
}
