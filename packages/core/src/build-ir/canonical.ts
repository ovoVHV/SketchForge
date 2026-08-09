import type { JsonValue, Sha256 } from './types.js';

/** A deterministic JSON representation used by IR and action cache keys. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot contain a non-finite number');
    return JSON.stringify(value);
  }
  if (value === undefined) throw new TypeError('canonical JSON cannot contain undefined');
  if (typeof value !== 'object') throw new TypeError(`canonical JSON cannot contain ${typeof value}`);

  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;

  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort(compareText);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export function hashJson(value: JsonValue): Sha256 {
  return sha256Hex(canonicalJson(value));
}

/**
 * SHA-256 without a Node or Emscripten dependency.  Keeping this here lets
 * native, browser and WASM planners calculate identical keys.
 */
export function sha256Hex(input: string | Uint8Array): Sha256 {
  const bytes = typeof input === 'string' ? utf8(input) : input;
  const bitLength = bytes.length * 8;
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  padded[padded.length - 8] = (high >>> 24) & 0xff;
  padded[padded.length - 7] = (high >>> 16) & 0xff;
  padded[padded.length - 6] = (high >>> 8) & 0xff;
  padded[padded.length - 5] = high & 0xff;
  padded[padded.length - 4] = (low >>> 24) & 0xff;
  padded[padded.length - 3] = (low >>> 16) & 0xff;
  padded[padded.length - 2] = (low >>> 8) & 0xff;
  padded[padded.length - 1] = low & 0xff;

  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(64);
    for (let i = 0; i < 16; i++) {
      const at = offset + (i * 4);
      words[i] = ((padded[at]! << 24) | (padded[at + 1]! << 16)
        | (padded[at + 2]! << 8) | padded[at + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15]!;
      const y = words[i - 2]!;
      const s0 = (rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10)) >>> 0;
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0;
    }

    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const s1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + s1 + ch + SHA256_K[i]! + words[i]!) >>> 0;
      const s0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return h.map((part) => part.toString(16).padStart(8, '0')).join('');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function utf8(value: string): Uint8Array {
  const result: number[] = [];
  for (let index = 0; index < value.length; index++) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint < 0xdc00) {
      if (index + 1 < value.length) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + next - 0xdc00;
          index++;
        } else codePoint = 0xfffd;
      } else codePoint = 0xfffd;
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) codePoint = 0xfffd;
    if (codePoint <= 0x7f) result.push(codePoint);
    else if (codePoint <= 0x7ff) result.push(
      0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f),
    );
    else if (codePoint <= 0xffff) result.push(
      0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f),
    );
    else result.push(
      0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f),
      0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f),
    );
  }
  return Uint8Array.from(result);
}

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
