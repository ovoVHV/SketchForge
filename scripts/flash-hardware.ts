/**
 * 真机烧录验证。
 *
 *   npx tsx scripts/flash-hardware.ts COM5 arduino:avr:nano atmega328old
 *
 * 关键设计：**不重写协议**。这里给 Node 的 serialport 套了一层
 * Web Serial 兼容垫片，然后跑的是浏览器端**完全相同**的 `Stk500Flasher`
 * （直接 import packages/web/public/stk500.js）。
 * 因此这个脚本验证的是生产代码本身 —— 协议、时序、页大小、HEX 解析全都是同一份。
 * 浏览器与这里的唯一差异只剩 Web Serial 的绑定方式。
 */

import { SerialPort } from 'serialport';
// @ts-expect-error — 浏览器端的 JS 模块，无类型声明，这是刻意为之：跑的就是它
import { Stk500Flasher, parseIntelHex } from '../packages/web/public/stk500.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Web Serial 兼容垫片：把 Node serialport 包装成
 * { readable, writable, setSignals, open, close } 的形态。
 */
class WebSerialShim {
  private port: SerialPort;
  private queue: Uint8Array[] = [];
  private resolvers: Array<(v: { value?: Uint8Array; done: boolean }) => void> = [];
  private cancelled = false;

  constructor(path: string, baudRate: number) {
    this.port = new SerialPort({ path, baudRate, autoOpen: false });
    this.port.on('data', (chunk: Buffer) => {
      const arr = new Uint8Array(chunk);
      const r = this.resolvers.shift();
      if (r) r({ value: arr, done: false });
      else this.queue.push(arr);
    });
  }

  open(): Promise<void> {
    return new Promise((res, rej) => this.port.open((e) => (e ? rej(e) : res())));
  }

  close(): Promise<void> {
    this.cancelled = true;
    this.resolvers.splice(0).forEach((r) => r({ done: true }));
    return new Promise((res) => this.port.close(() => res()));
  }

  get readable() {
    const self = this;
    return {
      getReader() {
        return {
          async read(): Promise<{ value?: Uint8Array; done: boolean }> {
            if (self.cancelled) return { done: true };
            const q = self.queue.shift();
            if (q) return { value: q, done: false };
            return new Promise((res) => self.resolvers.push(res));
          },
          async cancel() { self.cancelled = true; self.resolvers.splice(0).forEach((r) => r({ done: true })); },
          releaseLock() {},
        };
      },
    };
  }

  get writable() {
    const self = this;
    return {
      getWriter() {
        return {
          write(data: Uint8Array): Promise<void> {
            return new Promise((res, rej) =>
              self.port.write(Buffer.from(data), (e) => (e ? rej(e) : self.port.drain(() => res()))),
            );
          },
          releaseLock() {},
        };
      },
    };
  }

  /** Web Serial 的 setSignals 语义：true = 置位。Node serialport 的 set() 同义 */
  setSignals(sig: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void> {
    return new Promise((res, rej) =>
      this.port.set(
        { dtr: sig.dataTerminalReady ?? false, rts: sig.requestToSend ?? false },
        (e) => (e ? rej(e) : res()),
      ),
    );
  }
}

// ---------------------------------------------------------------------------

const [portPath, fqbn = 'arduino:avr:nano', cpu = 'atmega328old'] = process.argv.slice(2);
const BASE = process.env.AF_BASE ?? 'http://127.0.0.1:3000';

if (!portPath) {
  console.error('用法: npx tsx scripts/flash-hardware.ts <COM口> [fqbn] [cpu选项]');
  console.error('可用串口:');
  SerialPort.list().then((l) => l.forEach((p) => console.error(`  ${p.path}  ${p.manufacturer ?? ''} ${p.friendlyName ?? ''}`)));
  process.exit(1);
}

/** 一段带唯一标识的 sketch —— 串口读到这个标识才能证明跑的是我们刚烧的固件 */
const STAMP = `AF-${Date.now().toString(36).toUpperCase()}`;
const SKETCH = `// 真机验证固件
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
  delay(300);
  Serial.println("BOOT ${STAMP}");
}

void loop() {
  heartbeat();
}

void heartbeat() {
  static int n = 0;
  digitalWrite(LED_BUILTIN, n % 2 ? HIGH : LOW);
  Serial.print("${STAMP} tick=");
  Serial.println(n++);
  delay(400);
}
`;

async function compile(): Promise<{ hex: string; size: number; flash: number }> {
  const res = await fetch(`${BASE}/v1/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      board: fqbn,
      files: [{ name: 'main.ino', content: SKETCH }],
      options: { cpu, optimize: 'fast' },
    }),
  });
  if (res.status !== 202) throw new Error(`提交失败 HTTP ${res.status}: ${await res.text()}`);
  const { stream } = (await res.json()) as { stream: string };

  const sse = await fetch(`${BASE}${stream}`);
  const reader = sse.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.event === 'done') {
        const r = ev.result;
        if (r.status !== 'success') {
          throw new Error(`编译失败: ${r.message}\n` + r.diagnostics.map((d: any) => `  ${d.file}:${d.line} ${d.message}`).join('\n'));
        }
        const a = r.artifacts[0];
        return { hex: Buffer.from(a.base64, 'base64').toString('utf8'), size: a.size, flash: r.memory.flashUsed };
      }
    }
  }
  throw new Error('SSE 结束但没收到 done 事件');
}

/** 烧录后打开串口监听，确认板子真的在跑我们刚烧的固件 */
async function verifyRunning(baud: number, stamp: string, timeoutMs = 12000): Promise<string[]> {
  const shim = new WebSerialShim(portPath!, baud);
  await shim.open();
  // 复位一次，确保从头开始跑
  await shim.setSignals({ dataTerminalReady: true, requestToSend: true });
  await sleep(100);
  await shim.setSignals({ dataTerminalReady: false, requestToSend: false });

  const reader = shim.readable.getReader();
  const dec = new TextDecoder();
  const lines: string[] = [];
  let text = '';
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline && lines.length < 4) {
    const timer = new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), 1000));
    const got = await Promise.race([reader.read(), timer]);
    if ('value' in got && got.value) {
      text += dec.decode(got.value, { stream: true });
      const parts = text.split(/\r?\n/);
      text = parts.pop() ?? '';
      for (const p of parts) if (p.includes(stamp)) lines.push(p.trim());
    }
  }
  await reader.cancel();
  await shim.close();
  return lines;
}

(async () => {
  const ports = await SerialPort.list();
  const info = ports.find((p) => p.path.toLowerCase() === portPath!.toLowerCase());
  console.log(`串口   ${portPath}  ${info ? `(${info.manufacturer ?? ''} ${info.friendlyName ?? ''})`.trim() : '⚠ 未在列表中'}`);
  console.log(`板子   ${fqbn}  cpu=${cpu}`);

  // 从底座取该板子的烧录参数 —— 波特率必须由板子定义驱动，不能写死
  const boards = (await (await fetch(`${BASE}/v1/boards`)).json()) as any;
  const board = boards.boards.find((b: any) => b.fqbn === fqbn);
  if (!board) throw new Error(`底座不认识板子 ${fqbn}`);
  const baud = board.upload.speedByOption?.cpu?.[cpu] ?? board.upload.speed ?? 115200;
  console.log(`烧录   ${board.upload.protocol} @ ${baud} bps  (由板子定义解析，非硬编码)`);
  console.log(`标识   ${STAMP}\n`);

  console.log('── 编译 ──');
  const { hex, size, flash } = await compile();
  const image = parseIntelHex(hex);
  console.log(`  hex ${size} 字节 → 映像 ${image.length} 字节，Flash 占用 ${flash}\n`);

  console.log('── 烧录（跑的是浏览器端同一份 Stk500Flasher）──');
  const shim = new WebSerialShim(portPath!, baud);
  await shim.open();
  try {
    const flasher = new Stk500Flasher(shim, (msg: string, pct: number) => {
      process.stdout.write(`\r  [${String(pct).padStart(3)}%] ${msg.padEnd(48)}`);
    });
    const written = await flasher.flash(hex);
    console.log(`\n  ✓ 写入 ${written} 字节\n`);
  } finally {
    await shim.close();
  }

  console.log('── 验证板子在跑新固件 ──');
  await sleep(500);
  const lines = await verifyRunning(9600, STAMP);
  if (lines.length === 0) {
    console.log('  ✗ 串口没读到标识，固件可能没生效');
    process.exit(1);
  }
  lines.forEach((l) => console.log(`  ${l}`));
  console.log(`\n✓ 真机验证通过：板子正在运行刚烧录的固件（标识 ${STAMP}）`);
})().catch((e) => { console.error(`\n✗ ${e.message}`); process.exit(1); });
