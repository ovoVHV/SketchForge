/**
 * 【原型验证】参数外置 —— 让"只改常量"不再需要重新编译。
 *   npx tsx scripts/proto-params.ts [avr|esp32]
 *
 * ## 要验证的假设
 *
 * 图形化平台里绝大多数修改是改一个常量：引脚号、延时、阈值、颜色。
 * 程序结构没变，但现在每改一次都要走一次完整编译。
 *
 * 假设：如果把积木参数写进一张**固定布局的表**而不是内联成字面量，
 * 那么"引脚 13 改成 12"产出的固件应该与原来**除了那几个字节以外完全相同**。
 * 若成立，浏览器就能拿缓存的固件自己改那几个字节再烧 —— 服务器零参与。
 *
 * ## 三个必须证伪的点
 *   1. 优化器会不会把 `volatile const` 折叠掉？折叠了就白搭
 *   2. 两份固件是不是真的只差参数那几个字节？
 *   3. 浏览器能不能在 .bin 里可靠地定位到参数表？
 *      （不解析 ELF —— 用魔数标记搜索，简单且不依赖镜像格式）
 *
 * 任何一点不成立，这条路就走不通，早知道早省事。
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
const cacheDir = join(tc.cacheDir, 'proto-params');
rmSync(join(cacheDir, 'l0'), { recursive: true, force: true }); // 每次都真编，别命中结果缓存

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

/**
 * 生成代码。参数放进带魔数包围的结构体，方便在 .bin 里搜索定位。
 *
 * `volatile` 是关键：没有它，优化器会把常量直接折叠进指令，
 * 参数表就成了没人读的死数据，改它毫无效果。
 */
const MAGIC = 'A1F0PARM';   // 8 字节魔数，出现概率足够低
const gen = (pin: number, delayMs: number) => `
struct AfParams {
  char     magic[8];
  uint8_t  pin;
  uint8_t  _pad;
  uint16_t delayMs;
  char     magicEnd[8];
};

// volatile 阻止常量折叠；used 阻止被当作未引用而丢弃
volatile const AfParams AF_PARAMS __attribute__((used)) = {
  { 'A','1','F','0','P','A','R','M' },
  ${pin}, 0, ${delayMs},
  { 'M','R','A','P','0','F','1','A' }
};

void setup() {
  pinMode(AF_PARAMS.pin, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  blink();
}

void blink() {
  digitalWrite(AF_PARAMS.pin, HIGH);
  delay(AF_PARAMS.delayMs);
  digitalWrite(AF_PARAMS.pin, LOW);
  delay(AF_PARAMS.delayMs);
  Serial.println(AF_PARAMS.pin);
}
`;

/**
 * AVR 的产物是 Intel HEX **文本**，不是裸二进制 —— 必须先解码，
 * 否则在文本里搜二进制魔数永远搜不到（第一版就栽在这）。
 * ESP32 的 .bin 本来就是二进制，直接用。
 */
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
    for (let i = 0; i < count; i++) {
      bytes[addr + i] = parseInt(t.substr(9 + i * 2, 2), 16);
    }
    max = Math.max(max, addr + count);
  }
  const out = Buffer.alloc(max, 0xff);
  for (let i = 0; i < max; i++) out[i] = bytes[i] ?? 0xff;
  return out;
}

async function build(pin: number, delayMs: number): Promise<Buffer | null> {
  const r = await svc.compile({
    board: BOARD,
    files: [{ name: 'main.ino', content: gen(pin, delayMs) }],
  });
  if (r.status !== 'success') {
    console.error(`  编译失败 (${pin},${delayMs}): ${r.message}`);
    r.diagnostics.slice(0, 4).forEach((d) => console.error(`    ${d.file}:${d.line} ${d.message}`));
    return null;
  }
  const a = r.artifacts[0]!;
  return toBinary(a.base64!, a.name);
}

/**
 * ESP32 镜像格式（esptool elf2image 产物）：
 *
 *   偏移 0     : 魔数 0xE9
 *   偏移 1     : segment 数量
 *   偏移 2..7  : flash 模式/容量频率/入口地址
 *   偏移 8..23 : 扩展头（偏移 23 = hash_appended 标志）
 *   偏移 24..  : 各 segment：load_addr(4) length(4) data[length]
 *   末尾       : 填充 | 校验和(1) | SHA256(32，当 hash_appended=1)
 *
 * 校验和 = 0xEF 异或全体 **segment 数据**字节。
 * SHA256 覆盖「镜像开头 … 到 SHA 字段之前」。
 */
interface Esp32Layout {
  hashAppended: boolean;
  /** 各 segment 数据区间 [start, end) */
  segments: Array<[number, number]>;
  checksumOffset: number;
}

function parseEsp32Image(img: Buffer): Esp32Layout | null {
  if (img[0] !== 0xe9) return null;
  const segCount = img[1]!;
  const hashAppended = img[23] === 1;
  const segments: Array<[number, number]> = [];

  let p = 24;
  for (let i = 0; i < segCount; i++) {
    if (p + 8 > img.length) return null;
    const len = img.readUInt32LE(p + 4);
    const start = p + 8;
    const end = start + len;
    if (end > img.length) return null;
    segments.push([start, end]);
    p = end;
  }
  return { hashAppended, segments, checksumOffset: img.length - (hashAppended ? 33 : 1) };
}

/** 从零重算校验和 —— 用来验证我们对格式的理解是对的 */
function computeChecksum(img: Buffer, layout: Esp32Layout): number {
  let cs = 0xef;
  for (const [a, b] of layout.segments) {
    for (let i = a; i < b; i++) cs ^= img[i]!;
  }
  return cs;
}

/**
 * 打补丁后重算两个摘要。这段逻辑将来要原样搬到浏览器里。
 *
 * 校验和是 XOR，所以改几个字节时**不必重扫整个镜像** ——
 * 把旧字节异或出去、新字节异或进来即可，复杂度只与改动量有关。
 * SHA256 得全量重算，但 292 KB 用 SubtleCrypto 只要 1~2 ms。
 */
function patchEsp32Image(
  img: Buffer,
  original: Buffer,
  patchFrom: number,
  patchTo: number,
  layout: Esp32Layout,
): void {
  let cs = original[layout.checksumOffset]!;
  for (let i = patchFrom; i < patchTo; i++) cs ^= original[i]! ^ img[i]!;
  img[layout.checksumOffset] = cs;

  if (layout.hashAppended) {
    createHash('sha256').update(img.subarray(0, img.length - 32)).digest().copy(img, img.length - 32);
  }
}

/** 镜像是否自洽（校验和与 SHA 与自身内容匹配）—— 这才是 bootloader 关心的 */
function isSelfConsistent(img: Buffer): { ok: boolean; why: string } {
  const layout = parseEsp32Image(img);
  if (!layout) return { ok: false, why: '镜像头解析失败' };
  const cs = computeChecksum(img, layout);
  if (cs !== img[layout.checksumOffset]) {
    return { ok: false, why: `校验和不符：算出 0x${cs.toString(16)}，镜像里是 0x${img[layout.checksumOffset]!.toString(16)}` };
  }
  if (layout.hashAppended) {
    const want = createHash('sha256').update(img.subarray(0, img.length - 32)).digest();
    if (!want.equals(img.subarray(img.length - 32))) return { ok: false, why: 'SHA256 不符' };
  }
  return { ok: true, why: '' };
}

/** 逐字节比对，返回不同的位置 */
function diffBytes(a: Buffer, b: Buffer): number[] {
  const out: number[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) out.push(i);
  if (a.length !== b.length) out.push(-1);
  return out;
}

(async () => {
  console.log(`板子 ${BOARD}\n`);
  console.log('编译两份只差常量的固件…');

  const A = await build(13, 500);
  if (!A) process.exit(1);
  const B = await build(12, 250);
  if (!B) process.exit(1);

  console.log(`  固件 A (pin=13, delay=500)  ${A.length} 字节`);
  console.log(`  固件 B (pin=12, delay=250)  ${B.length} 字节\n`);

  // ---- 1. 参数表能不能在 .bin 里定位到 ----
  const magicIdxA = A.indexOf(Buffer.from(MAGIC, 'ascii'));
  const magicIdxB = B.indexOf(Buffer.from(MAGIC, 'ascii'));
  check('参数表在固件里可被魔数定位', magicIdxA >= 0 && magicIdxB >= 0,
    `A@0x${magicIdxA.toString(16)}  B@0x${magicIdxB.toString(16)}`);
  check('两份固件里参数表位置相同', magicIdxA === magicIdxB);

  if (magicIdxA < 0) {
    console.log('\n✗ 参数表被优化掉了 —— 这条路走不通。');
    process.exit(1);
  }

  // ---- 2. 参数值确实写进了固件 ----
  const pinA = A[magicIdxA + 8];
  const delayA = A.readUInt16LE(magicIdxA + 10);
  const pinB = B[magicIdxB + 8];
  const delayB = B.readUInt16LE(magicIdxB + 10);
  check('固件 A 的参数值正确', pinA === 13 && delayA === 500, `pin=${pinA} delay=${delayA}`);
  check('固件 B 的参数值正确', pinB === 12 && delayB === 250, `pin=${pinB} delay=${delayB}`);

  // ---- 3. 核心假设：除参数外完全相同 ----
  const diff = diffBytes(A, B);
  const paramRange = [magicIdxA + 8, magicIdxA + 12]; // pin, _pad, delayMs
  const outside = diff.filter((i) => i < paramRange[0]! || i >= paramRange[1]!);

  console.log(`\n  字节差异总数 ${diff.length}，其中参数区外 ${outside.length}`);
  if (outside.length > 0) {
    // 把连续的差异合并成区间，一眼看出是"散落各处"还是"几个固定字段"
    const ranges: Array<[number, number]> = [];
    for (const i of outside) {
      const last = ranges[ranges.length - 1];
      if (last && i === last[1] + 1) last[1] = i;
      else ranges.push([i, i]);
    }
    console.log('  参数区外的差异区间：');
    for (const [a, b] of ranges.slice(0, 10)) {
      const len = b - a + 1;
      const tail = A.length - 1 - b;
      console.log(
        `    0x${a.toString(16).padStart(6, '0')}–0x${b.toString(16).padStart(6, '0')}  ` +
        `${String(len).padStart(3)} 字节   距文件尾 ${tail}`,
      );
    }
    if (ranges.length > 10) console.log(`    …还有 ${ranges.length - 10} 个区间`);
  }

  check('两份固件长度一致', A.length === B.length);

  // ---- 4. 打补丁 ----
  const patched = Buffer.from(A);
  patched[magicIdxA + 8] = 12;
  patched.writeUInt16LE(250, magicIdxA + 10);

  if (ARCH === 'avr') {
    // AVR 的 hex 没有内嵌摘要，改完就完事
    check('**除参数外字节完全相同**', outside.length === 0,
      outside.length ? `还有 ${outside.length} 处差异` : '');
    check('给 A 打补丁后与 B 完全一致（浏览器可本地改参数）',
      diffBytes(patched, B).length === 0);
  } else {
    // ESP32 镜像内嵌两处摘要，先确认我们对格式的理解没错
    const layout = parseEsp32Image(A)!;
    check('镜像头解析成功', !!layout,
      layout ? `${layout.segments.length} 个 segment，hash_appended=${layout.hashAppended}` : '');
    check('原始固件自洽（验证我们对格式的理解正确）', isSelfConsistent(A).ok, isSelfConsistent(A).why);
    check('固件 B 也自洽', isSelfConsistent(B).ok, isSelfConsistent(B).why);

    // 差异分类：参数区 3 字节 + 0xb0 处 32 字节 + 尾部 33 字节
    const elfShaDiffs = outside.filter((i) => i >= 0xb0 && i < 0xd0).length;
    const tailDiffs = outside.filter((i) => i >= A.length - 33).length;
    const unexplained = outside.filter((i) => !(i >= 0xb0 && i < 0xd0) && i < A.length - 33);
    check('参数区外的差异**只**来自两处摘要，没有别的',
      unexplained.length === 0,
      `ELF标识 ${elfShaDiffs} + 尾部摘要 ${tailDiffs}${unexplained.length ? `，另有 ${unexplained.length} 处无法解释` : ''}`);

    patchEsp32Image(patched, A, magicIdxA + 8, magicIdxA + 12, layout);

    // 决定性判据：补丁后的镜像**自洽**（bootloader 只认这个），且参数值正确
    const cons = isSelfConsistent(patched);
    check('打补丁 + 重算摘要后镜像自洽（bootloader 只校验这个）', cons.ok, cons.why);
    check('补丁后参数值 = 目标值',
      patched[magicIdxA + 8] === 12 && patched.readUInt16LE(magicIdxA + 10) === 250);

    // 再做一次更严格的对照：把两边的 ELF 标识都抹平后重算，应完全一致。
    // 这证明「除了那个纯标识字段，两份固件的可执行内容真的一模一样」。
    const norm = (src: Buffer, pin: number, ms: number) => {
      const x = Buffer.from(src);
      x.fill(0, 0xb0, 0xd0);
      const l = parseEsp32Image(x)!;
      x[magicIdxA + 8] = pin;
      x.writeUInt16LE(ms, magicIdxA + 10);
      // 抹平后从零重算，不用增量
      x[l.checksumOffset] = computeChecksum(x, l);
      if (l.hashAppended) {
        createHash('sha256').update(x.subarray(0, x.length - 32)).digest().copy(x, x.length - 32);
      }
      return x;
    };
    check('抹平 ELF 标识后，A 打补丁 == B（可执行内容确实完全相同）',
      norm(A, 12, 250).equals(norm(B, 12, 250)));
  }

  console.log(`\n────────────────────────────────`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail === 0) {
    console.log('\n结论：参数外置**可行**。改常量不需要重新编译，浏览器本地打补丁即可。');
  } else {
    console.log('\n结论：当前形式**不可行**，需要调整（见上面失败项）。');
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('✗', e); process.exit(1); });
