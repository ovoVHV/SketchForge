/**
 * 全板卡矩阵冒烟：每块板都真编一次同一段代码。
 *   npx tsx scripts/smoke-boards.ts
 *
 * 新增板卡最容易错的地方不是编译参数，而是那些**只对某块板成立**的细节：
 * C3 的 target 与 mcu 分叉、S3 没有 40MHz 的 bootloader、
 * bootloader 偏移 ESP32 是 0x1000 而 S3/C3 是 0x0。
 * 所以这里逐板断言这些，而不是只看"编过了没"。
 */

import { join } from 'node:path';
import {
  BoardRegistry, CompileService, LocalExecutor, LibraryRegistry,
  detectLocalToolchain, FileL0Cache,
} from '../packages/core/src/index.js';
import type { CompileRequest } from '../packages/core/src/index.js';

const tc = detectLocalToolchain();
const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
const libs = LibraryRegistry.fromDirectories(tc.librariesDirs);

const cacheDir = join(tc.cacheDir, 'smoke-boards');
const svc = new CompileService({
  boards, toolchain: { ...tc, cacheDir }, executor: new LocalExecutor(),
  cache: new FileL0Cache(join(cacheDir, 'l0')), libraries: libs,
});

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`    ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const SALT = Date.now() % 100000;

/** 只用各板都有的 API，避免把"板子不支持某函数"误判成接入失败 */
const SKETCH = `int n = ${SALT};
void setup() {
  Serial.begin(9600);
}
void loop() {
  tick();
}
void tick() {
  n++;
  Serial.println(n);
  delay(100);
}
`;

/** 每块板期望的 bootloader 偏移 —— ESP32 是 0x1000，S3/C3 是 0x0 */
const EXPECTED_BOOT_ADDR: Record<string, string> = {
  'esp32:esp32:esp32': '0x1000',
  'esp32:esp32:esp32s3': '0x0',
  'esp32:esp32:esp32c3': '0x0',
};

(async () => {
  for (const b of boards.list()) {
    console.log(`\n═══ ${b.fqbn}  ${b.name} ═══`);
    const req: CompileRequest = { board: b.fqbn, files: [{ name: 'main.ino', content: SKETCH }] };
    const t = Date.now();
    const r = await svc.compile(req);
    const ms = Date.now() - t;

    if (r.status !== 'success') {
      check('编译成功', false, `${r.reason}: ${r.message.slice(0, 300)}`);
      r.diagnostics.slice(0, 3).forEach((d) => console.log(`      ${d.file}:${d.line} ${d.message}`));
      continue;
    }
    check('编译成功', true,
      `${ms} ms  Flash ${r.memory?.flashUsed}/${r.memory?.flashTotal}  ` +
      `[core ${r.timings.core ?? '-'} / pch ${r.timings.pch ?? '-'} / 编译 ${r.timings.compile} / 链接 ${r.timings.link ?? '-'}]`);

    if (b.arch === 'esp32') {
      check('产出 firmware.bin @0x10000', r.artifacts[0]?.offset === '0x10000');
      check('产出三片静态分片', r.staticArtifacts.length === 3,
        r.staticArtifacts.map((a) => `${a.offset}:${a.name}`).join(' '));
      const bootAddr = r.staticArtifacts.find((a) => a.name === 'bootloader.bin')?.offset;
      check(`bootloader 偏移 = ${EXPECTED_BOOT_ADDR[b.fqbn]}`,
        bootAddr === EXPECTED_BOOT_ADDR[b.fqbn], `实际 ${bootAddr}`);
      check('PCH 生效（sketch 编译 < 2s）', (r.timings.compile ?? 1e9) < 2000,
        `${r.timings.compile} ms`);
    } else {
      check('产出 firmware.hex（AVR 无烧录偏移）',
        r.artifacts[0]?.name === 'firmware.hex' && r.artifacts[0]?.offset === null);
    }
    check('有内存占用统计', !!r.memory?.flashTotal);
  }

  console.log(`\n────────────────────────────────`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项（${boards.list().length} 块板）`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('✗', e); process.exit(1); });
