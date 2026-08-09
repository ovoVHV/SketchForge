/**
 * 把固件 JSON 内联进演示页模板，产出可独立分发的单文件 HTML。
 *   node scripts/build-demo-page.mjs
 *
 * 页面必须自包含：不引任何外部脚本/字体/图片。
 * 一方面 Artifact 的 CSP 会拦掉外部主机，另一方面这页本来就该能离线跑。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const tpl = readFileSync(join(root, 'packages/web/demo.template.html'), 'utf8');
const fw = readFileSync(join(root, 'packages/web/demo-firmware.json'), 'utf8');

if (!tpl.includes('/*__FIRMWARE__*/{}')) {
  console.error('模板里找不到固件占位符 /*__FIRMWARE__*/{}');
  process.exit(1);
}

const out = tpl.replace('/*__FIRMWARE__*/{}', fw);
const dest = join(root, 'packages/web/demo.html');
writeFileSync(dest, out, 'utf8');

console.log(`✓ ${dest}  ${(out.length / 1024).toFixed(0)} KB`);
console.log(`  内联固件 ${Object.keys(JSON.parse(fw)).length} 份`);
