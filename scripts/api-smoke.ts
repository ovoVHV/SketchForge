/**
 * API 契约端到端验证：POST /v1/compile → SSE 事件流。
 *   先 `npm run dev`，再 `npx tsx scripts/api-smoke.ts`
 *
 * 这个脚本刻意只用 fetch，不 import 任何 core 代码 ——
 * 它模拟的是一个**完全不认识底座内部实现**的外部前端
 * （图形化平台将来就是这个位置）。跑通说明契约立得住。
 */

const BASE = process.env.AF_BASE ?? 'http://127.0.0.1:3000';

interface SseEvent { event: string; [k: string]: unknown }

/** 提交编译并消费 SSE，直到 done */
async function compile(body: unknown): Promise<{ events: SseEvent[]; result: any }> {
  const res = await fetch(`${BASE}/v1/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status !== 202) {
    const text = await res.text();
    throw new Error(`提交失败 HTTP ${res.status}: ${text}`);
  }
  const { stream } = (await res.json()) as { jobId: string; stream: string };

  const sse = await fetch(`${BASE}${stream}`);
  if (!sse.ok || !sse.body) throw new Error(`SSE 连接失败 HTTP ${sse.status}`);

  const events: SseEvent[] = [];
  let result: any = null;
  let buffer = '';

  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 以空行分帧
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const payload = JSON.parse(dataLine.slice(6)) as SseEvent;
      events.push(payload);
      if (payload.event === 'done') result = (payload as any).result;
    }
  }
  return { events, result };
}

const sketch = (extra = '') => ({
  board: 'arduino:avr:uno',
  files: [{
    name: 'main.ino',
    content: `int n = 0;${extra}
void setup() { Serial.begin(9600); pinMode(LED_BUILTIN, OUTPUT); }
void loop() { tick(); }
void tick() { n++; digitalWrite(LED_BUILTIN, n % 2); delay(100); }
`,
  }],
});

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

(async () => {
  console.log('\n── GET /v1/boards ──');
  const boards = (await (await fetch(`${BASE}/v1/boards`)).json()) as any;
  const uno = boards.boards.find((b: any) => b.fqbn === 'arduino:avr:uno');
  check('返回了 Uno', !!uno);
  check('带引脚定义（图形化平台渲染下拉框的数据源）', uno?.pins?.length > 0);
  check('引脚带能力标签', uno?.pins?.some((p: any) => p.caps?.includes('pwm')));
  check('带编译选项枚举', uno?.options?.length > 0);
  check('带烧录协议（前端据此选 avrbro / esptool-js）', uno?.upload?.protocol === 'stk500v1');
  check('不含内部构建字段（build 不外泄）', uno?.build === undefined);

  console.log('\n── GET /v1/libraries ──');
  const libs = (await (await fetch(`${BASE}/v1/libraries`)).json()) as any;
  check('返回 libraries 数组（P1 为空）', Array.isArray(libs.libraries));

  console.log('\n── POST /v1/compile：成功路径 ──');
  const ok = await compile(sketch());
  check('拿到 done 事件', !!ok.result);
  check('编译成功', ok.result?.status === 'success');
  check('有 progress 事件', ok.events.some((e) => e.event === 'progress'));
  check('有产物', ok.result?.artifacts?.length > 0);
  check('产物带 sha256', !!ok.result?.artifacts?.[0]?.sha256);
  check('有 staticArtifacts 字段（ESP32 分片烧录用）', Array.isArray(ok.result?.staticArtifacts));
  check('有内存占用统计', !!ok.result?.memory?.flashTotal);
  console.log(`     Flash ${ok.result?.memory?.flashUsed}/${ok.result?.memory?.flashTotal}` +
              `  RAM ${ok.result?.memory?.ramUsed}/${ok.result?.memory?.ramTotal}` +
              `  耗时 ${ok.result?.timings?.total}ms  缓存=${ok.result?.cached}`);

  console.log('\n── 缓存命中 ──');
  const cached = await compile(sketch());
  check('第二次命中 L0 缓存', cached.result?.cached === true);
  check('产物哈希一致', cached.result?.artifacts?.[0]?.sha256 === ok.result?.artifacts?.[0]?.sha256);
  console.log(`     耗时 ${cached.result?.timings?.total}ms`);

  console.log('\n── POST /v1/compile：编译错误 ──');
  const bad = await compile({
    board: 'arduino:avr:uno',
    files: [{ name: 'main.ino', content: 'void setup() {}\nvoid loop() {\n  digitlWrite(13, HIGH);\n}\n' }],
  });
  check('状态为 error', bad.result?.status === 'error');
  check('reason=compile_error（用户代码错，不是平台故障）', bad.result?.reason === 'compile_error');
  check('诊断以独立 SSE 事件推送', bad.events.some((e) => e.event === 'diagnostic'));
  const d = bad.result?.diagnostics?.[0];
  check('诊断行号 = 3', d?.line === 3);
  check('诊断文件名是用户文件名', d?.file === 'main.ino');
  check('给出修正建议', !!d?.message?.includes('digitalWrite'));
  check('错误信息里没有服务端绝对路径', !/[A-Za-z]:\\|\/home\/|\/opt\//.test(JSON.stringify(bad.result)));
  console.log(`     ${d?.file}:${d?.line}:${d?.column}  ${d?.message}`);

  console.log('\n── 安全预检 ──');
  const evil = await compile({
    board: 'arduino:avr:uno',
    files: [{ name: 'main.ino', content: 'void setup(){ asm(".incbin \\"/etc/passwd\\""); }\nvoid loop(){}\n' }],
  });
  check('.incbin 被拒绝', evil.result?.reason === 'rejected');

  console.log('\n── 参数校验 ──');
  const badBoard = await compile({ board: 'nope:nope:nope', files: [{ name: 'main.ino', content: 'void setup(){}' }] });
  check('未知板子被拒', badBoard.result?.reason === 'invalid_request');
  const badName = await compile({ board: 'arduino:avr:uno', files: [{ name: '../evil.ino', content: 'void setup(){}' }] });
  check('非法文件名被拒（防 #line 注入与路径穿越）', badName.result?.reason === 'invalid_request');
  const badOpt = await compile({ ...sketch(), options: { optimize: 'bogus' } });
  check('非法选项值被拒', badOpt.result?.reason === 'invalid_request');

  console.log('\n── 选项通路（ESP32 分区方案将来走同一条路）──');
  const fast = await compile({ ...sketch(' // fast'), options: { optimize: 'fast' } });
  const size = await compile({ ...sketch(' // fast'), options: { optimize: 'size' } });
  check('optimize=fast 编译成功', fast.result?.status === 'success');
  check('optimize=size 编译成功', size.result?.status === 'success');
  check('两种优化产出不同的固件（选项确实生效）',
    fast.result?.artifacts?.[0]?.sha256 !== size.result?.artifacts?.[0]?.sha256);
  console.log(`     fast: Flash ${fast.result?.memory?.flashUsed}  |  size: Flash ${size.result?.memory?.flashUsed}`);

  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${failed.length === 0 ? '✓ 全部通过' : `✗ ${failed.length} 项失败`}  (${checks.length} 项检查)`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => { console.error('\n✗ 脚本异常:', e.message); process.exit(1); });
