/**
 * 为静态演示页编译固件，输出成可直接内嵌的 JSON。
 *   npx tsx scripts/build-demo-firmware.ts
 *
 * 之所以能做成纯静态页：**烧录这一半完全不需要服务器**。
 * 固件在这里预先编好，浏览器只负责 Web Serial 把它写进板子。
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  BoardRegistry, CompileService, LocalExecutor, LibraryRegistry,
  detectLocalToolchain, FileL0Cache,
} from '../packages/core/src/index.js';

const tc = detectLocalToolchain();
const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
const cacheDir = join(tc.cacheDir, 'demo');
const svc = new CompileService({
  boards, toolchain: { ...tc, cacheDir }, executor: new LocalExecutor(),
  cache: new FileL0Cache(join(cacheDir, 'l0')),
  libraries: LibraryRegistry.fromDirectories(tc.librariesDirs),
});

/** 心跳灯 + 串口自报家门。用 13 号脚，Uno/Nano 上都是板载 LED */
const SKETCH = `const int LED = 13;
unsigned long beat = 0;

void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
  delay(200);
  Serial.println();
  Serial.println(F("== arduinofast =="));
  Serial.println(F("firmware flashed from a browser tab"));
  Serial.println(F("no IDE, no driver, no arduino-cli"));
  Serial.println();
}

void loop() {
  heartbeat();
}

// 双闪心跳：亮-灭-亮-灭---，比匀速闪烁更容易一眼认出"是我烧的"
void heartbeat() {
  pulse(60);
  delay(120);
  pulse(60);
  delay(760);
  beat++;
  Serial.print(F("beat "));
  Serial.print(beat);
  Serial.print(F("  uptime "));
  Serial.print(millis() / 1000);
  Serial.println(F("s"));
}

void pulse(int ms) {
  digitalWrite(LED, HIGH);
  delay(ms);
  digitalWrite(LED, LOW);
}
`;

const TARGETS = [
  { fqbn: 'arduino:avr:uno',  id: 'uno',      label: 'Arduino UNO',                   options: {}, baud: 115200 },
  { fqbn: 'arduino:avr:nano', id: 'nano-new', label: 'Arduino Nano（新 bootloader）',  options: { cpu: 'atmega328' },    baud: 115200 },
  { fqbn: 'arduino:avr:nano', id: 'nano-old', label: 'Arduino Nano（老 bootloader）',  options: { cpu: 'atmega328old' }, baud: 57600 },
];

(async () => {
  const out: Record<string, unknown> = {};
  for (const t of TARGETS) {
    process.stdout.write(`编译 ${t.label} … `);
    const r = await svc.compile({
      board: t.fqbn,
      files: [{ name: 'main.ino', content: SKETCH }],
      options: t.options,
    });
    if (r.status !== 'success') {
      console.log('失败');
      console.error(r.message);
      r.diagnostics.slice(0, 5).forEach((d) => console.error(`  ${d.file}:${d.line} ${d.message}`));
      process.exit(1);
    }
    const a = r.artifacts[0]!;
    const hex = Buffer.from(a.base64!, 'base64').toString('utf8');
    out[t.id] = {
      label: t.label,
      fqbn: t.fqbn,
      baud: t.baud,
      hex,
      bytes: r.memory?.flashUsed ?? 0,
      flashTotal: r.memory?.flashTotal ?? 0,
      ram: r.memory?.ramUsed ?? 0,
      ramTotal: r.memory?.ramTotal ?? 0,
      sha256: a.sha256,
    };
    console.log(`ok  Flash ${r.memory?.flashUsed}/${r.memory?.flashTotal}  ${r.timings.total}ms`);
  }

  const dest = join(process.cwd(), 'packages', 'web', 'demo-firmware.json');
  writeFileSync(dest, JSON.stringify(out), 'utf8');
  const size = JSON.stringify(out).length;
  console.log(`\n→ ${dest}  ${(size / 1024).toFixed(0)} KB`);
})();
