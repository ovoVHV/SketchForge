#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3210/arduino/';
const RANGE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const HEALTH_LEVELS = [1, 5, 10, 20, 40, 80, 160, 320];
const STATIC_LEVELS = [1, 5, 10, 20, 40, 80];
const RANGE_LEVELS = [1, 2, 4, 8, 16, 32];

/**
 * Low-impact distribution test. It never calls /v1/compile, never sends a
 * POST, and never downloads a compiler asset in full.
 */
export async function runStaticHttpBench({
  baseUrl = process.env.AF_BASE_URL ?? DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Node 20 fetch is required');
  const base = normalizeBaseUrl(baseUrl);
  const endpoints = {
    health: new URL('healthz', base),
    app: new URL('app.js', base),
    range: new URL('avr/v4/tools/cc1plus.wasm', base),
  };
  const results = [];

  for (const [name, levels, request] of [
    ['healthz', HEALTH_LEVELS, (url) => requestEndpoint(fetchImpl, url)],
    ['app.js', STATIC_LEVELS, (url) => requestEndpoint(fetchImpl, url)],
    ['avr-range', RANGE_LEVELS, (url) => requestRange(fetchImpl, url)],
  ]) {
    let baselineP95 = null;
    for (const concurrency of levels) {
      const level = await runLevel({ name, concurrency, url: endpoints[name === 'healthz' ? 'health' : name === 'app.js' ? 'app' : 'range'], request });
      results.push(level);
      log(formatLevel(level));
      if (level.errors.length > 0) {
        throw new Error(`${name} failed at concurrency ${concurrency}: ${level.errors[0]}`);
      }
      if (baselineP95 === null) baselineP95 = level.p95Ms;
      if (concurrency > 1 && isClearlyDegraded(level.p95Ms, baselineP95)) {
        throw new Error(`${name} p95 latency degraded at concurrency ${concurrency}`);
      }
    }
  }

  return Object.freeze({ baseUrl: base.href, results: Object.freeze(results) });
}

async function runLevel({ name, concurrency, url, request }) {
  const startedAt = performance.now();
  const settled = await Promise.allSettled(
    Array.from({ length: concurrency }, () => request(url)),
  );
  const samples = settled
    .filter((item) => item.status === 'fulfilled')
    .map((item) => item.value);
  const errors = settled
    .filter((item) => item.status === 'rejected')
    .map((item) => errorMessage(item.reason));
  const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  return Object.freeze({
    name,
    concurrency,
    completed: samples.length,
    errors: Object.freeze(errors),
    elapsedMs: round(performance.now() - startedAt),
    minMs: round(latencies[0] ?? 0),
    p95Ms: round(percentile(latencies, 0.95)),
    maxMs: round(latencies.at(-1) ?? 0),
    bytes: samples.reduce((total, sample) => total + sample.bytes, 0),
  });
}

async function requestEndpoint(fetchImpl, url) {
  const startedAt = performance.now();
  const response = await fetchWithTimeout(fetchImpl, url);
  if (!response.ok) throw new Error(`${response.status} ${url.pathname}`);
  const bytes = (await response.arrayBuffer()).byteLength;
  return { latencyMs: performance.now() - startedAt, bytes };
}

async function requestRange(fetchImpl, url) {
  const startedAt = performance.now();
  const response = await fetchWithTimeout(fetchImpl, url, {
    headers: { Range: `bytes=0-${RANGE_BYTES - 1}` },
  });
  if (response.status !== 206) throw new Error(`expected 206, got ${response.status}`);
  const bytes = (await response.arrayBuffer()).byteLength;
  if (bytes <= 0 || bytes > RANGE_BYTES) throw new Error(`invalid range size ${bytes}`);
  const contentRange = response.headers.get('content-range') ?? '';
  if (!contentRange.startsWith('bytes 0-')) throw new Error('missing Content-Range response');
  return { latencyMs: performance.now() - startedAt, bytes };
}

async function fetchWithTimeout(fetchImpl, url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('base URL must use HTTP(S)');
  if (url.username || url.password) throw new Error('base URL must not contain credentials');
  if (url.search || url.hash) throw new Error('base URL must not contain query or hash');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

function isClearlyDegraded(p95Ms, baselineP95) {
  return p95Ms > Math.max(5_000, baselineP95 * 8 + 1_000);
}

function formatLevel(level) {
  const status = level.errors.length === 0 ? 'ok' : 'failed';
  return `${status} ${level.name} concurrency=${level.concurrency} completed=${level.completed}/${level.concurrency} p95=${level.p95Ms}ms max=${level.maxMs}ms bytes=${level.bytes}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runStaticHttpBench().then(
    () => {},
    (error) => {
      console.error(`Static HTTP benchmark stopped: ${errorMessage(error)}`);
      process.exitCode = 1;
    },
  );
}
