/**
 * 端到端冒烟测试：真实调用本机 avr-gcc，验证整条流水线。
 *   npx tsx scripts/smoke.ts
 *
 * 验证点：
 *   1. 能编出 hex，体积统计正确
 *   2. core.a 缓存生效（第二次编译应快一个数量级）
 *   3. L0 缓存生效
 *   4. 编译错误的行号精确落回 .ino
 *   5. 安全预检拦截 .incbin
 */

import { join } from 'node:path';
import {
  BoardRegistry, CompileService, LocalExecutor,
  detectLocalToolchain, describeToolchain,
} from '../packages/core/src/index.js';
import type { CompileRequest, CompileResult } from '../packages/core/src/index.js';

const root = process.cwd();
const tc = detectLocalToolchain();
const boards = BoardRegistry.fromDirectory(join(root, 'boards'));

console.log('工具链：\n  ' + describeToolchain(tc));
console.log('板子：', boards.list().map((b) => b.fqbn).join(', '));
if (!tc.avr) { console.error('\n✗ 未找到 AVR 工具链，无法继续'); process.exit(1); }

const svc = new CompileService({ boards, toolchain: tc, executor: new LocalExecutor() });

const mk = (content: string): CompileRequest => ({
  board: 'arduino:avr:uno',
  files: [{ name: 'main.ino', content }],
});

function report(label: string, r: CompileResult, ms: number) {
  const tag = r.status === 'success' ? '✓' : '✗';
  console.log(`\n${tag} ${label}  (${ms} ms)`);
  if (r.status === 'success') {
    const a = r.artifacts[0]!;
    console.log(`   产物 ${a.name}  ${a.size} 字节  sha256=${a.sha256.slice(0, 12)}…  缓存=${r.cached}`);
    if (r.memory) {
      const { flashUsed, flashTotal, ramUsed, ramTotal } = r.memory;
      console.log(`   Flash ${flashUsed}/${flashTotal} (${((flashUsed / flashTotal) * 100).toFixed(1)}%)  ` +
                  `RAM ${ramUsed}/${ramTotal} (${((ramUsed / ramTotal) * 100).toFixed(1)}%)`);
    }
    console.log(`   分段耗时`, r.timings);
  } else {
    console.log(`   reason=${r.reason}  ${r.message}`);
  }
  for (const d of r.diagnostics) {
    const loc = `${d.file}:${d.line}${d.column ? ':' + d.column : ''}`;
    const flags = [d.fromGenerated && 'generated', d.unmapped && 'unmapped'].filter(Boolean).join(',');
    console.log(`   [${d.severity}] ${loc}${flags ? ` (${flags})` : ''}  ${d.message}`);
  }
}

// ---------------------------------------------------------------------------

const BLINK = `// 经典 Blink，外加一个"定义在后、调用在前"的函数
// 用来验证自动生成的函数原型确实起作用
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  blinkOnce(200);
}

void blinkOnce(int ms) {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(ms);
  digitalWrite(LED_BUILTIN, LOW);
  delay(ms);
}
`;

// 第 4 行故意拼错 digitalWrite
const TYPO = `void setup() {
  pinMode(13, OUTPUT);
}
void loop() {
  digitlWrite(13, HIGH);
}
`;

const INCBIN = `void setup() {
  asm(".incbin \\"/etc/passwd\\"");
}
void loop() {}
`;

async function timed(label: string, req: CompileRequest) {
  const t = Date.now();
  const r = await svc.compile(req);
  report(label, r, Date.now() - t);
  return r;
}

(async () => {
  console.log('\n════ 1. 首次编译（含 core.a 构建，会比较慢）════');
  const r1 = await timed('Blink 首次', mk(BLINK));

  console.log('\n════ 2. 改一个字符再编译（core.a 已缓存，测真实热路径）════');
  await timed('Blink 改动后', mk(BLINK.replace('200', '250')));

  console.log('\n════ 3. 完全相同的源码（应命中 L0 缓存）════');
  await timed('Blink 重复', mk(BLINK));

  console.log('\n════ 4. 只改注释（归一化后应仍命中 L0 缓存）════');
  await timed('Blink 改注释', mk(BLINK.replace('// 经典 Blink', '// 完全不同的注释内容')));

  console.log('\n════ 5. 拼错函数名 —— 检查行号是否精确落在第 5 行 ════');
  const r5 = await timed('拼写错误', mk(TYPO));

  console.log('\n════ 6. 安全预检 —— .incbin 必须被拦 ════');
  const r6 = await timed('.incbin 攻击', mk(INCBIN));

  // ---- 断言 ----
  console.log('\n════ 结论 ════');
  const checks: Array<[string, boolean]> = [
    ['Blink 编译成功', r1.status === 'success'],
    ['自动生成原型生效（blinkOnce 定义在后仍可调用）', r1.status === 'success'],
    ['拼写错误被捕获', r5.status === 'error' && r5.diagnostics.length > 0],
    ['错误行号 = 5', r5.diagnostics[0]?.line === 5],
    ['给出了 digitalWrite 修正建议', !!r5.diagnostics[0]?.message.includes('digitalWrite')],
    ['.incbin 被拒绝', r6.status === 'error' && r6.reason === 'rejected'],
  ];
  let allOk = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (!ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
})();
