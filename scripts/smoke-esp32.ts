/**
 * ESP32 端到端验证。
 *   npx tsx scripts/smoke-esp32.ts
 *
 * 关注点和 AVR 不同：ESP32 的耗时大头是**链接**（要把 141 个预编译 `.a`
 * 链进去），那是延迟的硬地板，无法按 TU 缓存。所以这里重点看
 * 冷/热路径的构成，以及静态分片是否正确产出。
 */

import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  BoardRegistry, CompileService, LocalExecutor, LibraryRegistry,
  detectLocalToolchain, describeToolchain, FileL0Cache,
} from '../packages/core/src/index.js';
import type { CompileRequest, CompileResult } from '../packages/core/src/index.js';

const tc = detectLocalToolchain();
const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
const libs = LibraryRegistry.fromDirectories(tc.librariesDirs);

console.log('工具链：\n  ' + describeToolchain(tc));
if (!tc.esp32) { console.error('\n✗ 未检测到 ESP32 工具链'); process.exit(1); }
console.log(`  SDK(esp32): ${tc.esp32.sdkRootFor('esp32') ?? '未找到'}`);
console.log(`  esptool:    ${tc.esp32.esptool}\n`);

const cacheDir = join(tc.cacheDir, 'smoke-esp32');
if (process.env.AF_KEEP_CACHE !== '1') rmSync(cacheDir, { recursive: true, force: true });

const svc = new CompileService({
  boards, toolchain: { ...tc, cacheDir }, executor: new LocalExecutor(),
  cache: new FileL0Cache(join(cacheDir, 'l0')), libraries: libs,
});

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const mk = (content: string, options?: Record<string, string>): CompileRequest => ({
  board: 'esp32:esp32:esp32',
  files: [{ name: 'main.ino', content }],
  ...(options ? { options } : {}),
});

async function run(label: string, req: CompileRequest): Promise<{ r: CompileResult; ms: number }> {
  const t = Date.now();
  const r = await svc.compile(req);
  const ms = Date.now() - t;
  console.log(`  ${r.status === 'success' ? '✓' : '✗'} ${label}  ${ms} ms` +
    (r.status === 'success'
      ? `  缓存=${r.cached}` +
        (r.timings.core !== undefined
          ? `  [core ${r.timings.core} / 编译 ${r.timings.compile} / 链接 ${r.timings.link} / 成像 ${r.timings.imaging}]`
          : '')
      : `  ${r.reason}`));
  if (r.status === 'error') {
    console.log(`      ${r.message.slice(0, 400)}`);
    r.diagnostics.slice(0, 5).forEach((d) => console.log(`      ${d.file}:${d.line} ${d.message}`));
  }
  return { r, ms };
}

// 每轮跑用不同的 salt，保证 L0 必然未命中 ——
// 否则命中缓存时根本没发生编译，timings.core 不存在，
// 那些"core 有没有被复用"的断言就失去意义了。
//
// 注意 salt 必须放进**真实代码**而不是注释：L0 归一化会剥离注释
// （注释不影响产物，这是缓存该有的行为），放注释里等于没加。
const SALT = Date.now() % 100000;

const BLINK = `// ESP32 Blink + Serial
int counter = 0;
const int buildSalt = ${SALT};

void setup() {
  pinMode(2, OUTPUT);
  Serial.begin(115200);
  Serial.println("esp32 ready");
}

void loop() {
  tick();
}

void tick() {
  digitalWrite(2, counter % 2);
  Serial.printf("tick %d\\n", counter++);
  delay(500);
}
`;

(async () => {
  console.log('════ 1. 首次编译（含 core.a 构建，57 个文件）════');
  const cold = await run('Blink 冷编译', mk(BLINK));
  check('编译成功', cold.r.status === 'success');
  if (cold.r.status !== 'success') { process.exit(1); }

  const art = cold.r.artifacts[0]!;
  const statics = cold.r.staticArtifacts;
  console.log(`     固件 ${art.name} @${art.offset}  ${art.size} 字节`);
  console.log(`     静态分片：${statics.map((a) => `${a.offset} ${a.name}(${a.size}B)`).join('  ')}`);
  if (cold.r.memory) {
    const m = cold.r.memory;
    console.log(`     Flash ${m.flashUsed}/${m.flashTotal} (${((m.flashUsed / m.flashTotal) * 100).toFixed(1)}%)  ` +
                `RAM ${m.ramUsed}/${m.ramTotal} (${((m.ramUsed / m.ramTotal) * 100).toFixed(1)}%)`);
  }

  check('固件烧到 0x10000', art.offset === '0x10000');
  check('产出三片静态分片', statics.length === 3, statics.map((a) => a.name).join(','));
  check('分片偏移正确（0x1000 / 0x8000 / 0xe000）',
    statics.map((a) => a.offset).join(',') === '0x1000,0x8000,0xe000');
  check('固件不是空的', art.size > 100_000, `${art.size} 字节`);
  check('有内存占用统计', !!cold.r.memory?.flashUsed);

  console.log('\n════ 2. 改代码后重编（core.a 已缓存 —— 真实热路径）════');
  const warm = await run('Blink 改动后', mk(BLINK.replace('500', '250')));
  check('热路径编译成功', warm.r.status === 'success');
  // PCH 生效的判据：sketch 编译降到秒级以下。参数一旦失配，
  // GCC 会静默忽略 PCH 退回全量解析（约 6~8 秒），这里能抓到。
  check('PCH 生效（sketch 编译 < 2s）',
    (warm.r.status === 'success' ? warm.r.timings.compile ?? 1e9 : 1e9) < 2000,
    `编译 ${warm.r.status === 'success' ? warm.r.timings.compile : '?'} ms`);
  check('core 命中缓存', (warm.r.status === 'success' ? warm.r.timings.core ?? 999 : 999) < 500,
    `${warm.r.status === 'success' ? warm.r.timings.core : '?'} ms`);
  // 只有当第 1 步真的建了 core.a 时，"热路径更快"才有意义。
  // 复用缓存目录跑（AF_KEEP_CACHE=1）时第 1 步本身就是热的，比较无意义。
  const coldBuiltCore = cold.r.status === 'success' && (cold.r.timings.core ?? 0) > 5000;
  if (coldBuiltCore) {
    check('明显快于冷编译', warm.ms < cold.ms, `${cold.ms} → ${warm.ms} ms`);
  } else {
    console.log(`  – 跳过「快于冷编译」：本次第 1 步已命中 core 缓存（core ${cold.r.status === 'success' ? cold.r.timings.core : '?'} ms），无可比性`);
  }
  if (warm.r.status === 'success') {
    const link = warm.r.timings.link ?? 0;
    console.log(`     链接占热路径 ${((link / warm.ms) * 100).toFixed(0)}% —— 这是 ESP32 的延迟地板`);
  }

  console.log('\n════ 3. L0 结果缓存 ════');
  const cached = await run('完全相同的源码', mk(BLINK.replace('500', '250')));
  check('命中 L0 缓存', cached.r.status === 'success' && cached.r.cached === true);
  check('缓存命中也返回静态分片',
    cached.r.status === 'success' && cached.r.staticArtifacts.length === 3);

  console.log('\n════ 4. 编译错误的行号映射 ════');
  const bad = await run('拼错函数名', mk('void setup() {\n  Serial.begin(115200);\n}\nvoid loop() {\n  digitlWrite(2, HIGH);\n}\n'));
  check('报错', bad.r.status === 'error' && bad.r.reason === 'compile_error');
  const d = bad.r.diagnostics.find((x) => x.severity === 'error');
  check('行号 = 5', d?.line === 5, `${d?.file}:${d?.line}`);
  check('无服务端绝对路径泄漏', !/[A-Za-z]:\\Users|\/home\//.test(JSON.stringify(bad.r)));

  // 下面两组是同一个问题的两面：哪些选项**真的**改变 core.a？
  // 靠 timings.core 直接断言，而不是拿墙钟时间猜。

  console.log('\n════ 5. 换分区方案：不该重建 core.a ════');
  // grep 过整个 ESP32 core，没有任何文件引用 ARDUINO_PARTITION_*，
  // 所以编译 core 时干脆不传这个宏 —— 5 种分区方案共用同一份 core.a。
  const huge = await run('huge_app 分区', mk(BLINK.replace('500', '251'), { partition_scheme: 'huge_app' }));
  check('换分区方案后编译成功', huge.r.status === 'success');
  check('core.a 被复用（分区方案不影响 core）',
    (huge.r.status === 'success' ? huge.r.timings.core ?? 1e9 : 1e9) < 1000,
    `core ${huge.r.status === 'success' ? huge.r.timings.core : '?'} ms`);
  if (huge.r.status === 'success' && cold.r.status === 'success') {
    const a = cold.r.staticArtifacts.find((x) => x.name === 'partitions.bin')!;
    const b = huge.r.staticArtifacts.find((x) => x.name === 'partitions.bin')!;
    check('分区表确实不同（选项生效）', a.sha256 !== b.sha256);
    const ba = cold.r.staticArtifacts.find((x) => x.name === 'bootloader.bin')!;
    const bb = huge.r.staticArtifacts.find((x) => x.name === 'bootloader.bin')!;
    check('bootloader 相同（只跟 flash 配置有关，与分区无关）', ba.sha256 === bb.sha256);
  }

  console.log('\n════ 6. 换 flash 模式：确实影响编译产物 ════');
  // 对照组：dio_qspi/sdkconfig.h 与 qio_qspi/ 的那份实测不同，
  // 所以 flash 模式必须留在 core 的缓存键里（与分区方案相反）。
  //
  // 这里断言的是**语义**（产出的固件不同）而不是耗时。
  // 拿 timings.core 判断"有没有重建"会依赖缓存状态：
  // 上一轮已经建过 QIO 的 core.a 时它就是命中，断言会假失败。
  const sameSrc = BLINK.replace('500', '252');
  const dio = await run('DIO 模式（基准）', mk(sameSrc, { flash_mode: 'dio' }));
  const qio = await run('QIO 模式', mk(sameSrc, { flash_mode: 'qio' }));
  check('两种模式都编译成功', dio.r.status === 'success' && qio.r.status === 'success');
  if (dio.r.status === 'success' && qio.r.status === 'success') {
    check('固件本身不同（flash 模式确实进了编译输入）',
      dio.r.artifacts[0]!.sha256 !== qio.r.artifacts[0]!.sha256);
    const a = dio.r.staticArtifacts.find((x) => x.name === 'bootloader.bin')!;
    const b = qio.r.staticArtifacts.find((x) => x.name === 'bootloader.bin')!;
    check('bootloader 随 flash 模式变化', a.sha256 !== b.sha256);
  }

  console.log(`\n────────────────────────────────`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('✗ 脚本异常:', e); process.exit(1); });
