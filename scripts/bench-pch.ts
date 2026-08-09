/**
 * 预编译头（PCH）对 ESP32 编译耗时的影响 —— 实测，不猜。
 *   npx tsx scripts/bench-pch.ts
 *
 * 动机：实测 ESP32 热路径里「编译单个 sketch」要 6.3 秒，而 sketch 本身
 * 只有二十来行。时间花在哪？花在 `#include <Arduino.h>` 之后展开的整个
 * ESP-IDF 头文件树上 —— SDK 的 includes 参数文件本身就有 14 KB 的搜索路径。
 * 每次编译都把这几千个头文件重新解析一遍。
 *
 * PCH 就是为这个场景发明的：把头文件树预解析一次存成 .gch，
 * 后续编译直接加载。约束是**编译参数必须完全一致**，而我们的
 * (board, options) 组合本来就是有限且可枚举的，天然契合。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectLocalToolchain, BoardRegistry } from '../packages/core/src/index.js';

const tc = detectLocalToolchain();
if (!tc.esp32) { console.error('未检测到 ESP32 工具链'); process.exit(1); }
const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
const board = boards.get('esp32:esp32:esp32')!;

const sdk = tc.esp32.sdkRootFor('esp32')!;
const bin = tc.esp32.xtensaBinDir!;
const gpp = join(bin, 'xtensa-esp32-elf-g++.exe');

const work = mkdtempSync(join(tmpdir(), 'af-pch-'));

/** 与 Esp32Toolchain 里保持一致的编译参数 */
const flags = (extra: string[] = []) => [
  '-MMD', '-c', `@${join(sdk, 'flags', 'cpp_flags')}`,
  '-w', '-Os', '-Werror=return-type',
  '-DF_CPU=240000000L', '-DARDUINO=10607', '-DARDUINO_ESP32_DEV', '-DARDUINO_ARCH_ESP32',
  '-DARDUINO_BOARD="ESP32_DEV"', '-DARDUINO_VARIANT="esp32"', '-DARDUINO_PARTITION_default',
  `@${join(sdk, 'flags', 'defines')}`,
  '-iprefix', join(sdk, 'include') + '/',
  `@${join(sdk, 'flags', 'includes')}`,
  `-I${join(sdk, 'dio_qspi', 'include')}`,
  `-I${tc.esp32!.coreDir}`,
  `-I${join(tc.esp32!.variantsDir, 'esp32')}`,
  ...extra,
];

const SKETCH = `#include <Arduino.h>
#line 1 "main.ino"
int n = 0;
void tick();
void setup() { pinMode(2, OUTPUT); Serial.begin(115200); }
void loop() { tick(); }
void tick() { digitalWrite(2, n % 2); Serial.println(n++); delay(100); }
`;

function time(label: string, fn: () => { ok: boolean; err: string }): number {
  const t = Date.now();
  const r = fn();
  const ms = Date.now() - t;
  if (!r.ok) {
    console.error(`✗ ${label} 失败：\n${r.err.slice(0, 1500)}`);
    process.exit(1);
  }
  return ms;
}

const runGpp = (args: string[]) => {
  const r = spawnSync(gpp, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, err: (r.stderr ?? '') + (r.stdout ?? '') };
};

(async () => {
  console.log(`编译器 ${gpp}`);
  console.log(`SDK    ${sdk}\n`);

  writeFileSync(join(work, 'sketch.cpp'), SKETCH, 'utf8');

  // ---- 基线：不用 PCH，连编 3 次取中位 ----
  const baseline: number[] = [];
  for (let i = 0; i < 3; i++) {
    baseline.push(time(`基线第 ${i + 1} 次`, () =>
      runGpp([...flags(), join(work, 'sketch.cpp'), '-o', join(work, `base${i}.o`)])));
  }
  baseline.sort((a, b) => a - b);
  const base = baseline[1]!;
  console.log(`基线（无 PCH）      ${baseline.map((x) => x + 'ms').join('  ')}   → 中位 ${base} ms`);

  // ---- 构建 PCH：把 Arduino.h 整棵头文件树预解析一次 ----
  const pchHeader = join(work, 'af_pch.h');
  writeFileSync(pchHeader, '#include <Arduino.h>\n', 'utf8');

  const pchMs = time('构建 PCH', () =>
    // -x c++-header 让 gcc 把它当头文件编，产出 af_pch.h.gch
    runGpp([...flags(), '-x', 'c++-header', pchHeader, '-o', join(work, 'af_pch.h.gch')]));
  const pchSize = statSync(join(work, 'af_pch.h.gch')).size;
  console.log(`构建 PCH（一次性）  ${pchMs} ms，产物 ${(pchSize / 1024 / 1024).toFixed(1)} MB`);

  // ---- 用 PCH 编译：-include 强制先加载，-I 指向 .gch 所在目录 ----
  const withPch: number[] = [];
  for (let i = 0; i < 3; i++) {
    withPch.push(time(`PCH 第 ${i + 1} 次`, () =>
      runGpp([
        `-I${work}`, '-include', 'af_pch.h',
        ...flags(), join(work, 'sketch.cpp'), '-o', join(work, `pch${i}.o`),
      ])));
  }
  withPch.sort((a, b) => a - b);
  const pch = withPch[1]!;
  console.log(`用 PCH 编译         ${withPch.map((x) => x + 'ms').join('  ')}   → 中位 ${pch} ms`);

  // ---- 校验：两种方式产出的目标文件应当等价（大小接近即可，PCH 不改变语义）----
  const s1 = statSync(join(work, 'base0.o')).size;
  const s2 = statSync(join(work, 'pch0.o')).size;

  console.log('\n════ 结论 ════');
  console.log(`目标文件大小：无 PCH ${s1} B / 用 PCH ${s2} B  ${s1 === s2 ? '（一致）' : '（有差异，需核对）'}`);
  const speedup = base / pch;
  console.log(`单次 sketch 编译：${base} ms → ${pch} ms，**提速 ${speedup.toFixed(1)}×**`);
  console.log(`PCH 构建成本 ${pchMs} ms，编译 ${Math.ceil(pchMs / Math.max(1, base - pch))} 次即回本；`);
  console.log(`(board × options) 组合有限且可枚举，可在 CI 里全部预构建`);

  rmSync(work, { recursive: true, force: true });
})();
