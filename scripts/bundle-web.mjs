/**
 * 把 esptool-js 打包成浏览器可直接 import 的单文件。
 *
 * 为什么要打包而不是直接引 CDN：
 *   · 参考客户端刻意做成零构建、零外部依赖 —— 断网、内网部署都要能跑
 *   · 生产环境的 CSP 通常禁止外部脚本源
 * 所以在这里一次性打成 IIFE-free 的 ESM 单文件，产物进版本库。
 *
 *   node scripts/bundle-web.mjs
 */

import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'packages', 'web', 'public', 'vendor', 'esptool.js');

// esptool-js 的 Transport 需要一个 SerialPort；我们只把需要的符号导出去
const entry = `
export { ESPLoader, Transport } from 'esptool-js';
`;

const result = await build({
  stdin: {
    contents: entry,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  platform: 'browser',
  minify: true,
  outfile: OUT,
  legalComments: 'none',
  // Node 内建在浏览器里用不到，直接置空避免 esbuild 报错
  external: [],
  define: { 'process.env.NODE_ENV': '"production"' },
});

if (result.errors.length) {
  console.error(result.errors);
  process.exit(1);
}

const banner = `// 由 scripts/bundle-web.mjs 从 esptool-js 打包生成，请勿手工编辑。\n`;
const { readFileSync } = await import('node:fs');
writeFileSync(OUT, banner + readFileSync(OUT, 'utf8'), 'utf8');

const size = readFileSync(OUT).length;
console.log(`✓ ${OUT}  ${(size / 1024).toFixed(0)} KB`);
