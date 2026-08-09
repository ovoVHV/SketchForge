/**
 * 库系统端到端验证 —— 用本机真实的第三方库，不用玩具 fixture。
 *   npx tsx scripts/smoke-libraries.ts
 *
 * 重点验证 L1 库对象缓存和依赖解析：
 *   · Adafruit SSD1306 → Adafruit GFX Library → Adafruit BusIO 的传递依赖
 *   · 1.0 目录布局（源码在根目录，**不能递归**否则会卷进 examples/）
 *   · `depends` 用显示名而非文件夹名
 *   · L1 缓存跨 sketch 复用（第二个用同一个库的 sketch 应该快一个数量级）
 */

import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  BoardRegistry, CompileService, LocalExecutor, LibraryRegistry,
  detectLocalToolchain, FileL0Cache,
} from '../packages/core/src/index.js';
import type { CompileRequest, CompileResult } from '../packages/core/src/index.js';

const tc = detectLocalToolchain();
const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
const libs = LibraryRegistry.fromDirectories(tc.librariesDirs);

console.log('库目录：');
tc.librariesDirs.forEach((d) => console.log(`  ${d}`));
console.log(`共索引到 ${libs.list().length} 个库\n`);

// 每次跑用独立缓存，并且**开跑前清空** —— 否则上一轮残留的 L0 缓存会让
// "冷编译"那一步直接命中，timings.libraries 根本不会产生，测的就不是真实冷路径了。
const cacheDir = join(tc.cacheDir, 'smoke-libs');
rmSync(cacheDir, { recursive: true, force: true });
const svc = new CompileService({
  boards,
  toolchain: { ...tc, cacheDir },
  executor: new LocalExecutor(),
  cache: new FileL0Cache(join(cacheDir, 'l0')),
  libraries: libs,
});

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const mk = (content: string, libraries?: Array<{ name: string }>): CompileRequest => ({
  board: 'arduino:avr:uno',
  files: [{ name: 'main.ino', content }],
  ...(libraries ? { libraries } : {}),
});

async function run(label: string, req: CompileRequest): Promise<{ r: CompileResult; ms: number }> {
  const t = Date.now();
  const r = await svc.compile(req);
  const ms = Date.now() - t;
  const tag = r.status === 'success' ? '✓' : '✗';
  console.log(`  ${tag} ${label}  ${ms} ms` +
    (r.status === 'success'
      ? `  Flash ${r.memory?.flashUsed}  缓存=${r.cached}` +
        (r.timings.libraries !== undefined ? `  [库 ${r.timings.libraries}ms]` : '')
      : `  ${r.reason}: ${r.message}`));
  if (r.status === 'error') {
    r.diagnostics.slice(0, 4).forEach((d) => console.log(`      ${d.file}:${d.line} ${d.message}`));
  }
  return { r, ms };
}

(async () => {
  // ---------------------------------------------------------------------
  console.log('── 1. 依赖解析（不编译，只看解析结果）──');
  const res = libs.resolve(['Adafruit SSD1306'], 'avr');
  const names = res.libraries.map((l) => l.manifest.name);
  console.log(`  解析链：${names.join(' → ')}`);
  check('传递依赖被展开（SSD1306 → GFX → BusIO）',
    names.includes('Adafruit SSD1306') && names.includes('Adafruit GFX Library') && names.includes('Adafruit BusIO'));
  check('依赖顺序正确：被依赖的在前（链接器从左向右解析符号）',
    names.indexOf('Adafruit BusIO') < names.indexOf('Adafruit GFX Library') &&
    names.indexOf('Adafruit GFX Library') < names.indexOf('Adafruit SSD1306'));
  check('无解析错误', res.errors.length === 0, res.errors.join('; '));

  const gfx = libs.get('Adafruit GFX Library');
  check('1.0 布局被正确识别', gfx?.layout === '1.0', `layout=${gfx?.layout}`);
  check('1.0 布局未把 examples/ 卷进源文件',
    !!gfx && gfx.sources.every((s) => !/[\\/]examples[\\/]/.test(s)),
    `${gfx?.sources.length} 个源文件`);

  // ---------------------------------------------------------------------
  console.log('\n── 2. 未知库要报错，不能静默忽略 ──');
  const bad = await run('引用不存在的库', mk('void setup(){}\nvoid loop(){}', [{ name: 'No Such Library' }]));
  check('未知库被拒绝', bad.r.status === 'error' && bad.r.reason === 'invalid_request');

  // ---------------------------------------------------------------------
  console.log('\n── 3. 显式声明库 + 传递依赖，真编译 ──');
  const OLED = `#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 display(128, 64, &Wire, -1);

void setup() {
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.clearDisplay();
  showText("hello");
}

void loop() {}

void showText(const char* s) {
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(s);
  display.display();
}
`;
  const cold = await run('SSD1306 首次（冷，要编 3 个库）', mk(OLED, [{ name: 'Adafruit SSD1306' }]));
  check('带依赖链的库编译成功', cold.r.status === 'success',
    cold.r.status === 'error' ? cold.r.message.slice(0, 200) : '');

  // ---------------------------------------------------------------------
  console.log('\n── 4. L1 库缓存跨 sketch 复用（核心成本机制）──');
  const OLED2 = OLED.replace('hello', 'world').replace('0, 0', '0, 8');
  const warm = await run('改代码后重编（库应命中 L1）', mk(OLED2, [{ name: 'Adafruit SSD1306' }]));
  check('第二次编译成功', warm.r.status === 'success');
  check('库编译耗时降到近零（L1 命中）',
    (warm.r.status === 'success' ? warm.r.timings.libraries ?? 999 : 999) < 200,
    `${warm.r.status === 'success' ? warm.r.timings.libraries : '?'} ms`);
  check('整体明显快于冷编译', warm.ms < cold.ms, `${cold.ms} → ${warm.ms} ms`);

  // ---------------------------------------------------------------------
  console.log('\n── 5. 从 #include 自动探测（手写代码不必显式声明）──');
  const auto = await run('只写 #include，不声明 libraries', mk(OLED2));
  check('自动探测后编译成功', auto.r.status === 'success');
  check('与显式声明命中同一份 L0 缓存（缓存键用解析后的库集合）',
    auto.r.status === 'success' && auto.r.cached === true, `cached=${auto.r.status === 'success' ? auto.r.cached : '-'}`);

  // ---------------------------------------------------------------------
  console.log('\n── 6. 另一个库：NeoPixel（验证 L1 按库隔离）──');
  const NEO = `#include <Adafruit_NeoPixel.h>
Adafruit_NeoPixel strip(16, 6, NEO_GRB + NEO_KHZ800);

void setup() { strip.begin(); strip.show(); }
void loop() { rainbow(); }
void rainbow() {
  for (int i = 0; i < 16; i++) strip.setPixelColor(i, strip.Color(255, 0, 0));
  strip.show();
  delay(50);
}
`;
  const neo = await run('NeoPixel 首次', mk(NEO));
  check('NeoPixel 编译成功', neo.r.status === 'success',
    neo.r.status === 'error' ? neo.r.message.slice(0, 200) : '');

  // ---------------------------------------------------------------------
  console.log('\n── 7. 库路径不得泄漏到诊断里 ──');
  const errSrc = OLED.replace('display.clearDisplay();', 'display.noSuchMethod();');
  const errRes = await run('库调用写错', mk(errSrc, [{ name: 'Adafruit SSD1306' }]));
  const blob = JSON.stringify(errRes.r);
  const leaked = /[A-Za-z]:\\Users|\/home\//.test(blob);
  check('诊断中无服务端绝对路径', !leaked);
  check('错误定位到用户代码行', errRes.r.diagnostics.some((d) => d.file === 'main.ino' && d.line > 1));

  console.log(`\n────────────────────────────────`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('✗ 脚本异常:', e); process.exit(1); });
