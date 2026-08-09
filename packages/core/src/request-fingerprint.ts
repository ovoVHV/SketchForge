import { createHash } from 'node:crypto';

import type { CompileRequest } from './types.js';
import { normalizeSource } from './preprocess/index.js';

const FINGERPRINT_FORMAT = 'arduinofast-compile-request-v1';
const NONDETERMINISTIC_MACRO = /\b(?:__DATE__|__TIME__|__TIMESTAMP__|__COUNTER__)\b/;

export interface CompileRequestFingerprint {
  /**
   * 只描述请求内容的稳定 SHA-256。调用方应再用 compiler bundle id
   * 做命名空间隔离，避免跨工具链或库目录复用。
   */
  baseHash: string;
  /** false 时只允许合并同时在途的相同请求，不得复用已完成的固件。 */
  resultReusable: boolean;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 为已通过结构校验的编译请求生成稳定内容指纹。
 *
 * `sessionId` 是调度提示，不影响机器码，因此不进入指纹。板卡名、文件名和
 * 源码内容保持大小写及空白语义；源码只做与预处理器一致的 BOM/换行归一化。
 */
export function fingerprintCompileRequest(request: CompileRequest): CompileRequestFingerprint {
  const files = request.files.map((file) => [
    file.name,
    normalizeSource(file.content),
  ] as const).sort((left, right) => compareText(left[0], right[0]));

  const options = Object.entries(request.options ?? {})
    .sort(([left], [right]) => compareText(left, right));

  const libraries = (request.libraries ?? [])
    .map((library) => [library.name, library.version ?? null] as const)
    .sort((left, right) =>
      compareText(left[0], right[0])
      || compareText(left[1] ?? '', right[1] ?? ''));

  const canonical = JSON.stringify({
    format: FINGERPRINT_FORMAT,
    board: request.board,
    files,
    options,
    libraries,
  });

  return {
    baseHash: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    resultReusable: !request.files.some((file) => NONDETERMINISTIC_MACRO.test(file.content)),
  };
}
