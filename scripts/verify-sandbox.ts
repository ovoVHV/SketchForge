/**
 * 沙箱逃逸验证 —— **上线前必须跑，且必须全绿**。
 *
 *   AF_BASE=http://127.0.0.1:3100 npx tsx scripts/verify-sandbox.ts
 *
 * 每一条都对应方案里识别出的一类真实威胁，用真实攻击载荷去撞沙箱。
 * 「代码写完」不等于「隔离生效」—— 这个脚本就是这句话的兑现方式。
 */

const BASE = process.env.AF_BASE ?? 'http://127.0.0.1:3100';
const BOARD = process.env.AF_BOARD ?? 'arduino:avr:uno';

interface Result {
  status: string;
  reason?: string;
  message?: string;
  diagnostics?: Array<{ message: string; line: number }>;
  artifacts?: Array<{ base64?: string; size: number }>;
}

async function compile(content: string): Promise<Result> {
  const res = await fetch(`${BASE}/v1/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ board: BOARD, files: [{ name: 'main.ino', content }] }),
  });
  if (res.status !== 202) return { status: 'error', reason: `http_${res.status}` };

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
      if (ev.event === 'done') return ev.result as Result;
    }
  }
  return { status: 'error', reason: 'no_done_event' };
}

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

/** 产物里是否混入了不该出现的内容（.incbin 外泄的判据） */
function artifactContains(r: Result, needle: string): boolean {
  const b64 = r.artifacts?.[0]?.base64;
  if (!b64) return false;
  return Buffer.from(b64, 'base64').toString('utf8').includes(needle);
}

(async () => {
  console.log('── 0. 沙箱自检状态 ──');
  const health = (await (await fetch(`${BASE}/healthz`)).json()) as any;
  console.log(`  执行器 ${health.sandbox.name} / 声明 ${health.sandbox.isolation} / 实测 verified=${health.sandbox.verified}`);
  check('隔离等级为 namespace', health.sandbox.isolation === 'namespace');
  check('启动自检已通过（实测而非声明）', health.sandbox.verified === true);
  if (!health.sandbox.verified) {
    console.log('\n沙箱未生效，后续逃逸测试没有意义。');
    process.exit(1);
  }

  console.log('\n── 1. .incbin 任意文件读取（最高危）──');
  const r1 = await compile('void setup(){ asm(".incbin \\"/etc/passwd\\""); }\nvoid loop(){}');
  check('被拒绝，未产出固件', r1.status === 'error', `reason=${r1.reason}`);

  console.log('\n── 2. 宏拼接绕过预检 → 只剩文件系统隔离这道防线 ──');
  // 预检是绊线不是边界：.incbin 被拆成两段字符串，正则扫不到。
  // 这条测的是 bwrap 的 mount namespace 本身。
  const r2 = await compile(
    '#define A ".inc"\n#define B "bin"\n' +
    'void setup(){ asm(A B " \\"/etc/passwd\\""); }\nvoid loop(){}',
  );
  check('绕过预检后仍未成功外泄', r2.status === 'error' || !artifactContains(r2, 'root:'),
    `status=${r2.status}`);

  console.log('\n── 3. 编译期文件系统探测 ──');
  const r3 = await compile(
    '#if __has_include("/etc/shadow")\n#error SHADOW_VISIBLE\n#endif\n' +
    'void setup(){}\nvoid loop(){}',
  );
  const sawShadow = JSON.stringify(r3).includes('SHADOW_VISIBLE');
  check('/etc/shadow 在沙箱内不可见', !sawShadow);

  console.log('\n── 4. 内存炸弹（模板递归）──');
  const r4 = await compile(
    'template<int N> struct B { static const long v = B<N-1>::v + B<N-1>::v; };\n' +
    'template<> struct B<0> { static const long v = 1; };\n' +
    'void setup(){ volatile long x = B<40000>::v; (void)x; }\nvoid loop(){}',
  );
  check('被资源限额拦下', r4.status === 'error', `reason=${r4.reason}`);
  const alive4 = (await (await fetch(`${BASE}/healthz`)).json()) as any;
  check('服务仍存活', alive4.ok === true);

  console.log('\n── 5. 输出炸弹 ──');
  const r5 = await compile(
    '#define R1(x) x x x x x x x x x x\n#define R2(x) R1(R1(x))\n#define R3(x) R2(R2(x))\n' +
    'void setup(){ R3(int a = notdefined;) }\nvoid loop(){}',
  );
  check('被截断/拦下，未拖垮服务', r5.status === 'error', `reason=${r5.reason}`);
  const alive5 = (await (await fetch(`${BASE}/healthz`)).json()) as any;
  check('服务仍存活', alive5.ok === true);

  console.log('\n── 6. 路径泄漏 ──');
  const r6 = await compile('void setup(){ undefined_symbol_here(); }\nvoid loop(){}');
  const blob = JSON.stringify(r6);
  const leaks = ['/opt/avr', '/var/afcache', '/var/afwork', '/usr/lib/gcc', '/app/']
    .filter((p) => blob.includes(p));
  check('错误信息中无服务端绝对路径', leaks.length === 0, leaks.length ? `泄漏: ${leaks.join(', ')}` : '');

  console.log('\n── 7. 正常编译仍然可用（沙箱不能把功能也一起隔离掉）──');
  const r7 = await compile(
    'void setup(){ pinMode(LED_BUILTIN, OUTPUT); Serial.begin(9600); }\n' +
    'void loop(){ blink(); }\nvoid blink(){ digitalWrite(LED_BUILTIN, HIGH); delay(100); }',
  );
  check('沙箱内编译成功', r7.status === 'success', r7.status === 'success' ? `${r7.artifacts?.[0]?.size} 字节` : r7.message ?? '');

  console.log('\n────────────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) { console.log('✗ 沙箱验证未通过，禁止上线'); process.exit(1); }
  console.log('✓ 沙箱验证通过');
})().catch((e) => { console.error('✗ 脚本异常:', e.message); process.exit(1); });
