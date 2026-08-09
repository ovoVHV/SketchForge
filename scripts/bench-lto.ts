/**
 * LTO 开/关 的实测对比：迭代速度 vs 产物体积。
 *   npx tsx scripts/bench-lto.ts
 *
 * 开发平台的核心指标是延迟，而链接是热路径里最大的一块，
 * 所以这个权衡必须用真实数字来定，不能拍脑袋。
 */

import { join } from 'node:path';
import {
  BoardRegistry, CompileService, LocalExecutor, detectLocalToolchain,
  FileL0Cache, type BoardDefinition, type CompileRequest,
} from '../packages/core/src/index.js';

const ROUNDS = 5;

// 只用 core API（库支持是 P2），但规模接近真实图形化平台生成的代码：
// 多个函数、Serial、String、浮点、数组
const SKETCH = `int pos = 0;
int samples[16];
String label = "sensor";

void setup() {
  Serial.begin(9600);
  pinMode(LED_BUILTIN, OUTPUT);
  for (int i = 0; i < 16; i++) samples[i] = 0;
}

void loop() {
  sweep();
  collect();
  report();
}

void sweep() {
  for (pos = 0; pos <= 180; pos += 1) { analogWrite(9, pos); delay(15); }
  for (pos = 180; pos >= 0; pos -= 1) { analogWrite(9, pos); delay(15); }
}

void collect() {
  for (int i = 0; i < 16; i++) samples[i] = analogRead(A0);
}

float average() {
  long sum = 0;
  for (int i = 0; i < 16; i++) sum += samples[i];
  return sum / 16.0;
}

void report() {
  Serial.print(label);
  Serial.print("=");
  Serial.println(average(), 2);
  digitalWrite(LED_BUILTIN, pos > 90 ? HIGH : LOW);
}
`;

const tc = detectLocalToolchain();
if (!tc.avr) { console.error('未找到 AVR 工具链'); process.exit(1); }

const baseBoards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
const uno = baseBoards.get('arduino:avr:uno')!;

async function bench(label: string, lto: boolean) {
  const def: BoardDefinition = { ...uno, build: { ...uno.build, lto } };
  const reg = new BoardRegistry();
  reg.add(def);

  // 每次用独立缓存目录，避免 L0/core 缓存互相干扰
  const cacheDir = join(tc.cacheDir, `bench-${lto ? 'lto' : 'nolto'}`);
  const svc = new CompileService({
    boards: reg,
    toolchain: { ...tc, cacheDir },
    executor: new LocalExecutor(),
    cache: new FileL0Cache(join(cacheDir, 'l0')),
  });

  const mk = (n: number): CompileRequest => ({
    board: 'arduino:avr:uno',
    // 每轮改一个常量，保证不命中 L0 缓存，测的是真实热路径
    files: [{ name: 'main.ino', content: SKETCH.replace('delay(15)', `delay(${15 + n})`) }],
  });

  // 预热：把 core.a 建起来
  await svc.compile(mk(0));

  const samples: number[] = [];
  let flash = 0, ram = 0, link = 0, compile = 0;
  for (let i = 1; i <= ROUNDS; i++) {
    const t = Date.now();
    const r = await svc.compile(mk(i));
    const ms = Date.now() - t;
    if (r.status !== 'success') { console.error(`${label} 第 ${i} 轮失败:`, r.message); process.exit(1); }
    samples.push(ms);
    flash = r.memory!.flashUsed;
    ram = r.memory!.ramUsed;
    link += r.timings.link ?? 0;
    compile += r.timings.compile ?? 0;
  }

  samples.sort((a, b) => a - b);
  return {
    label,
    median: samples[Math.floor(samples.length / 2)]!,
    min: samples[0]!,
    max: samples[samples.length - 1]!,
    avgLink: Math.round(link / ROUNDS),
    avgCompile: Math.round(compile / ROUNDS),
    flash, ram,
  };
}

(async () => {
  console.log(`每档 ${ROUNDS} 轮，每轮源码都有变化（不命中 L0 缓存），测真实热路径\n`);
  const on = await bench('LTO 开启（Arduino 默认）', true);
  const off = await bench('LTO 关闭', false);

  const fmt = (r: Awaited<ReturnType<typeof bench>>) =>
    `${r.label.padEnd(24)} 中位 ${String(r.median).padStart(5)} ms   ` +
    `[编译 ${String(r.avgCompile).padStart(4)} / 链接 ${String(r.avgLink).padStart(4)}]   ` +
    `Flash ${r.flash}  RAM ${r.ram}`;

  console.log(fmt(on));
  console.log(fmt(off));

  const speedup = (((on.median - off.median) / on.median) * 100).toFixed(0);
  const bloat = off.flash - on.flash;
  const bloatPct = ((bloat / on.flash) * 100).toFixed(1);
  console.log(`\n关掉 LTO：延迟 ${speedup}% ↓   Flash +${bloat} 字节 (+${bloatPct}%)`);
  console.log(`Uno 总 Flash 32256 字节，多占 ${((bloat / 32256) * 100).toFixed(2)} 个百分点`);
})();
