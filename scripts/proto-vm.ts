/**
 * 【原型验证】设备端字节码 VM —— 让"改程序结构"也不需要重新编译。
 *   npx tsx scripts/proto-vm.ts [avr|esp32]
 *
 * ## 与参数外置（proto-params.ts）的关系
 *
 * 参数外置解决的是「同一结构、不同常量」；改一个引脚号不用重编。
 * 但用户加一个积木、改一段逻辑，结构就变了，参数外置救不了。
 *
 * VM 把这一层也吃掉：**程序本身变成数据**。
 * 固件里烧的是「运行时 + 解释器 + 一块程序区」，
 * 用户的程序编译成字节码写进程序区 —— 而字节码不过是一张更大的参数表，
 * 所以**可以完全复用参数外置那套魔数定位 + 摘要重算的补丁机制**。
 *
 * ## 本原型要回答的三个问题
 *   1. 带 VM 的固件有多大？（占掉多少 Flash）
 *   2. **两个结构完全不同的程序，能不能产出同一份固件？**
 *      —— 这是"零服务器编译"成立与否的判据
 *   3. 补丁后镜像是否自洽（能不能启动）
 */

import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  BoardRegistry, CompileService, LocalExecutor, LibraryRegistry,
  detectLocalToolchain, FileL0Cache,
} from '../packages/core/src/index.js';

const ARCH = (process.argv[2] ?? 'esp32') as 'avr' | 'esp32';
const BOARD = ARCH === 'esp32' ? 'esp32:esp32:esp32' : 'arduino:avr:uno';

const tc = detectLocalToolchain();
const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
const cacheDir = join(tc.cacheDir, 'proto-vm');
rmSync(join(cacheDir, 'l0'), { recursive: true, force: true });

const svc = new CompileService({
  boards, toolchain: { ...tc, cacheDir }, executor: new LocalExecutor(),
  cache: new FileL0Cache(join(cacheDir, 'l0')),
  libraries: LibraryRegistry.fromDirectories(tc.librariesDirs),
});

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------------------
// 极小字节码指令集 —— 够表达"闪灯 / 读传感器 / 条件 / 循环"这类积木即可
// ---------------------------------------------------------------------------

const OP = {
  HALT: 0,
  PIN_MODE: 1,      // pin, mode
  DIGITAL_WRITE: 2, // pin, value
  DELAY_MS: 3,      // u16
  SERIAL_PRINT: 4,  // reg
  DIGITAL_READ: 5,  // pin -> reg
  ANALOG_READ: 6,   // pin -> reg
  LOAD: 7,          // reg, u16
  ADD: 8,           // dst, src
  JMP: 9,           // u16 addr
  JMP_IF_ZERO: 10,  // reg, u16 addr
} as const;

/** 程序区大小。固定长度是关键 —— 变长会改变固件布局，就前功尽弃了 */
const PROGRAM_SLOTS = 256;
const MAGIC = 'A1F0PROG';

/** 生成 VM 固件的源码。注意程序区初值填 HALT，真正的程序靠补丁写入 */
const vmSource = (initialProgram: number[]) => {
  const prog = Array.from({ length: PROGRAM_SLOTS }, (_, i) => initialProgram[i] ?? 0);
  return `
// ── 设备端字节码 VM 原型 ──
// 固件只编译一次；用户程序作为字节码补丁写入下面的 AF_PROGRAM。

struct AfProgram {
  char    magic[8];
  uint8_t code[${PROGRAM_SLOTS}];
  char    magicEnd[8];
};

// volatile 阻止优化器把程序区当常量折叠掉
volatile const AfProgram AF_PROGRAM __attribute__((used)) = {
  { 'A','1','F','0','P','R','O','G' },
  { ${prog.join(',')} },
  { 'G','O','R','P','0','F','1','A' }
};

static int16_t regs[4];

static uint16_t rd16(uint16_t pc) {
  return (uint16_t)AF_PROGRAM.code[pc] | ((uint16_t)AF_PROGRAM.code[pc + 1] << 8);
}

void runProgram() {
  uint16_t pc = 0;
  uint16_t guard = 0;
  while (pc < ${PROGRAM_SLOTS} && guard++ < 4000) {
    uint8_t op = AF_PROGRAM.code[pc];
    switch (op) {
      case ${OP.HALT}: return;
      case ${OP.PIN_MODE}:
        pinMode(AF_PROGRAM.code[pc + 1], AF_PROGRAM.code[pc + 2]); pc += 3; break;
      case ${OP.DIGITAL_WRITE}:
        digitalWrite(AF_PROGRAM.code[pc + 1], AF_PROGRAM.code[pc + 2]); pc += 3; break;
      case ${OP.DELAY_MS}:
        delay(rd16(pc + 1)); pc += 3; break;
      case ${OP.SERIAL_PRINT}:
        Serial.println(regs[AF_PROGRAM.code[pc + 1] & 3]); pc += 2; break;
      case ${OP.DIGITAL_READ}:
        regs[AF_PROGRAM.code[pc + 2] & 3] = digitalRead(AF_PROGRAM.code[pc + 1]); pc += 3; break;
      case ${OP.ANALOG_READ}:
        regs[AF_PROGRAM.code[pc + 2] & 3] = analogRead(AF_PROGRAM.code[pc + 1]); pc += 3; break;
      case ${OP.LOAD}:
        regs[AF_PROGRAM.code[pc + 1] & 3] = (int16_t)rd16(pc + 2); pc += 4; break;
      case ${OP.ADD}:
        regs[AF_PROGRAM.code[pc + 1] & 3] += regs[AF_PROGRAM.code[pc + 2] & 3]; pc += 3; break;
      case ${OP.JMP}:
        pc = rd16(pc + 1); break;
      case ${OP.JMP_IF_ZERO}:
        if (regs[AF_PROGRAM.code[pc + 1] & 3] == 0) pc = rd16(pc + 2); else pc += 4;
        break;
      default: return;
    }
  }
}

void setup() {
  Serial.begin(${ARCH === 'esp32' ? 115200 : 9600});
}

void loop() {
  runProgram();
}
`;
};

// ---------------------------------------------------------------------------
// 两个**结构完全不同**的程序 —— 判据就在这里
// ---------------------------------------------------------------------------

/** 程序一：闪灯 */
const PROG_BLINK = [
  OP.PIN_MODE, 13, 1,
  OP.DIGITAL_WRITE, 13, 1,
  OP.DELAY_MS, 0xf4, 0x01,   // 500
  OP.DIGITAL_WRITE, 13, 0,
  OP.DELAY_MS, 0xf4, 0x01,
  OP.HALT,
];

/** 程序二：读模拟量、累加、串口打印、条件跳转 —— 与程序一毫无共同结构 */
const PROG_SENSOR = [
  OP.LOAD, 0, 0x00, 0x00,
  OP.ANALOG_READ, 0, 1,
  OP.ADD, 0, 1,
  OP.SERIAL_PRINT, 0,
  OP.JMP_IF_ZERO, 0, 0x00, 0x00,
  OP.DELAY_MS, 0x64, 0x00,   // 100
  OP.JMP, 0x04, 0x00,
];

// ---------------------------------------------------------------------------

function toBinary(base64: string, name: string): Buffer {
  const raw = Buffer.from(base64, 'base64');
  if (!name.endsWith('.hex')) return raw;
  const bytes: number[] = [];
  let max = 0;
  for (const line of raw.toString('utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith(':')) continue;
    const count = parseInt(t.substr(1, 2), 16);
    const addr = parseInt(t.substr(3, 4), 16);
    const type = parseInt(t.substr(7, 2), 16);
    if (type === 1) break;
    if (type !== 0) continue;
    for (let i = 0; i < count; i++) bytes[addr + i] = parseInt(t.substr(9 + i * 2, 2), 16);
    max = Math.max(max, addr + count);
  }
  const out = Buffer.alloc(max, 0xff);
  for (let i = 0; i < max; i++) out[i] = bytes[i] ?? 0xff;
  return out;
}

async function build(program: number[]) {
  const r = await svc.compile({
    board: BOARD,
    files: [{ name: 'main.ino', content: vmSource(program) }],
  });
  if (r.status !== 'success') {
    console.error(`  编译失败: ${r.message}`);
    r.diagnostics.slice(0, 5).forEach((d) => console.error(`    ${d.file}:${d.line} ${d.message}`));
    return null;
  }
  return { bin: toBinary(r.artifacts[0]!.base64!, r.artifacts[0]!.name), memory: r.memory };
}

// ---- ESP32 镜像工具（与 proto-params.ts 同一套，将来一起搬到浏览器）----
function parseEsp32Image(img: Buffer) {
  if (img[0] !== 0xe9) return null;
  const segCount = img[1]!;
  const hashAppended = img[23] === 1;
  const segments: Array<[number, number]> = [];
  let p = 24;
  for (let i = 0; i < segCount; i++) {
    if (p + 8 > img.length) return null;
    const len = img.readUInt32LE(p + 4);
    segments.push([p + 8, p + 8 + len]);
    p = p + 8 + len;
  }
  return { hashAppended, segments, checksumOffset: img.length - (hashAppended ? 33 : 1) };
}
function computeChecksum(img: Buffer, l: NonNullable<ReturnType<typeof parseEsp32Image>>) {
  let cs = 0xef;
  for (const [a, b] of l.segments) for (let i = a; i < b; i++) cs ^= img[i]!;
  return cs;
}
function isSelfConsistent(img: Buffer) {
  const l = parseEsp32Image(img);
  if (!l) return { ok: false, why: '镜像头解析失败' };
  if (computeChecksum(img, l) !== img[l.checksumOffset]) return { ok: false, why: '校验和不符' };
  if (l.hashAppended) {
    const want = createHash('sha256').update(img.subarray(0, img.length - 32)).digest();
    if (!want.equals(img.subarray(img.length - 32))) return { ok: false, why: 'SHA256 不符' };
  }
  return { ok: true, why: '' };
}

(async () => {
  console.log(`板子 ${BOARD}   程序区 ${PROGRAM_SLOTS} 字节\n`);

  console.log('编译两份固件：一份内置"闪灯"字节码，一份内置"传感器"字节码…');
  const A = await build(PROG_BLINK);
  if (!A) process.exit(1);
  const B = await build(PROG_SENSOR);
  if (!B) process.exit(1);

  console.log(`  固件 A（闪灯）    ${A.bin.length} 字节   Flash ${A.memory?.flashUsed}/${A.memory?.flashTotal}`);
  console.log(`  固件 B（传感器）  ${B.bin.length} 字节   Flash ${B.memory?.flashUsed}/${B.memory?.flashTotal}\n`);

  const idxA = A.bin.indexOf(Buffer.from(MAGIC, 'ascii'));
  const idxB = B.bin.indexOf(Buffer.from(MAGIC, 'ascii'));
  check('程序区可被魔数定位', idxA >= 0 && idxB >= 0, `A@0x${idxA.toString(16)} B@0x${idxB.toString(16)}`);
  check('两份固件里程序区位置相同', idxA === idxB);
  if (idxA < 0) process.exit(1);

  const progStart = idxA + 8;
  const progEnd = progStart + PROGRAM_SLOTS;

  // ---- 核心判据：两个结构完全不同的程序，固件差异只在程序区内 ----
  const diffs: number[] = [];
  for (let i = 0; i < Math.min(A.bin.length, B.bin.length); i++) {
    if (A.bin[i] !== B.bin[i]) diffs.push(i);
  }
  const outside = diffs.filter((i) => i < progStart || i >= progEnd);
  const digestOnly = ARCH === 'esp32'
    ? outside.every((i) => (i >= 0xb0 && i < 0xd0) || i >= A.bin.length - 33)
    : outside.length === 0;

  console.log(`  字节差异 ${diffs.length}，程序区外 ${outside.length}`);
  check('固件长度一致', A.bin.length === B.bin.length);
  check('**结构完全不同的两个程序，固件差异只在程序区（+摘要）**', digestOnly,
    ARCH === 'esp32' ? '程序区外的差异仅为两处摘要' : '');

  // ---- 用 A 的固件 + B 的字节码，打补丁 ----
  const patched = Buffer.from(A.bin);
  B.bin.copy(patched, progStart, progStart, progEnd);

  if (ARCH === 'esp32') {
    const l = parseEsp32Image(patched)!;
    // 程序区较大，直接从零重算校验和（增量也行，这里求稳）
    patched[l.checksumOffset] = computeChecksum(patched, l);
    if (l.hashAppended) {
      createHash('sha256').update(patched.subarray(0, patched.length - 32)).digest()
        .copy(patched, patched.length - 32);
    }
    const cons = isSelfConsistent(patched);
    check('补丁后镜像自洽（可启动）', cons.ok, cons.why);
  }

  check('补丁后程序区 == B 的字节码',
    patched.subarray(progStart, progEnd).equals(B.bin.subarray(progStart, progEnd)));

  // 与"直接编译 B"的等价性判定。
  //
  // ESP32 上不能直接逐字节比：`0xb0` 处的 ELF 标识本就不同（它是 ELF 的摘要，
  // 与镜像内容无关），而尾部 SHA 又覆盖了它，于是尾部必然跟着不同。
  // 所以两边都先把该标识抹平、再从零重算摘要，然后比 —— 这才是
  // "可执行内容是否真的相同"的正确判据。
  const equivalent = (() => {
    if (ARCH !== 'esp32') return patched.equals(B.bin);
    const norm = (src: Buffer) => {
      const x = Buffer.from(src);
      x.fill(0, 0xb0, 0xd0);
      const l = parseEsp32Image(x)!;
      x[l.checksumOffset] = computeChecksum(x, l);
      if (l.hashAppended) {
        createHash('sha256').update(x.subarray(0, x.length - 32)).digest().copy(x, x.length - 32);
      }
      return x;
    };
    return norm(patched).equals(norm(B.bin));
  })();
  check('抹平纯标识字段后，补丁产物 == 直接编译 B（可执行内容完全相同）', equivalent);

  console.log(`\n────────────────────────────────`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail === 0) {
    const used = A.memory?.flashUsed ?? 0;
    const total = A.memory?.flashTotal ?? 1;
    console.log(`\n结论：设备端 VM **可行**。`);
    console.log(`  · 固件占 Flash ${used}/${total}（${((used / total) * 100).toFixed(1)}%），程序区 ${PROGRAM_SLOTS} 字节`);
    console.log(`  · 换一个结构完全不同的程序 = 改程序区那 ${PROGRAM_SLOTS} 字节 + 重算摘要`);
    console.log(`  · 这一步可以完全在浏览器完成 —— **服务器零参与**`);
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('✗', e); process.exit(1); });
