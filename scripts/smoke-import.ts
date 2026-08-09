/**
 * 库导入端到端验证（**需要联网**）。
 *   npx tsx scripts/smoke-import.ts
 *
 * 与单元测试的分工：
 *   · 单元测试用手工构造的恶意 tar 撞解包防护（离线、快、覆盖攻击面）
 *   · 本脚本用**真实 GitHub 仓库**验证整条流水线接得上
 */

const BASE = process.env.AF_BASE ?? 'http://127.0.0.1:3000';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

async function importLib(repoUrl: string, ref?: string) {
  const res = await fetch(`${BASE}/v1/libraries/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoUrl, ...(ref ? { ref } : {}) }),
  });
  return { http: res.status, body: (await res.json()) as any };
}

async function compile(content: string) {
  const res = await fetch(`${BASE}/v1/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ board: 'arduino:avr:uno', files: [{ name: 'main.ino', content }] }),
  });
  if (res.status !== 202) return { status: 'error', reason: `http_${res.status}` } as any;
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
      if (ev.event === 'done') return ev.result;
    }
  }
  return { status: 'error', reason: 'no_done' } as any;
}

(async () => {
  console.log('── SSRF 防线（不产生任何外发请求）──');
  for (const [url, label] of [
    ['http://169.254.169.254/latest/meta-data/', '云元数据端点'],
    ['http://127.0.0.1:6379/', '内网 Redis'],
    ['http://localhost:8080/x', 'localhost'],
    ['https://github.com.evil.com/a/b', '伪装成 GitHub 的域名'],
    ['https://evil.example.com/a/b', '任意外部主机'],
  ] as const) {
    const r = await importLib(url);
    check(`拒绝 ${label}`, r.body.status === 'error' && r.body.stage === 'fetch');
  }

  console.log('\n── 硬闸门：真实的带 platform.txt 的仓库 ──');
  const core = await importLib('https://github.com/arduino/ArduinoCore-avr');
  check('被拒绝', core.body.status === 'rejected');
  check('原因是构建系统文件（不是笼统的"不合法"）',
    core.body.rejections?.some((x: any) => x.code === 'build_system_file'),
    core.body.rejections?.[0]?.message?.slice(0, 60) ?? '');
  check('同时报出可执行文件',
    core.body.rejections?.some((x: any) => x.code === 'executable_file'));

  console.log('\n── 正常导入 ──');
  // 先清掉可能已存在的条目，否则会走"同 commit 复用"分支，
  // 测不到裁剪/试编译/报告这几步（幂等分支在后面单独测）
  const existing = (await (await fetch(`${BASE}/v1/libraries/imported`)).json()) as any;
  for (const e of existing.entries ?? []) {
    if (e.repo === 'Bounce2') {
      await fetch(`${BASE}/v1/libraries/imported/${encodeURIComponent(e.dir)}`, { method: 'DELETE' });
    }
  }

  const ok = await importLib('https://github.com/thomasfredericks/Bounce2');
  check('导入成功', ok.body.status === 'accepted', ok.body.message ?? '');
  check('锁定了完整 commit sha（不是 tag）',
    /^[0-9a-f]{40}$/.test(ok.body.library?.commit ?? ''), ok.body.library?.commit?.slice(0, 12) ?? '');
  check('做了白名单裁剪', (ok.body.stats?.removedFiles ?? 0) > 0,
    `裁掉 ${ok.body.stats?.removedFiles} 个文件`);
  check('试编译对所有目标板通过',
    Array.isArray(ok.body.trial) && ok.body.trial.length > 0 && ok.body.trial.every((t: any) => t.ok),
    (ok.body.trial ?? []).map((t: any) => `${t.board}=${t.ok}`).join(' '));
  check('产出了审核报告', ok.body.review !== undefined,
    `${ok.body.review?.findings?.length ?? 0} 项发现`);

  console.log('\n── 导入的库立刻可用 ──');
  const r = await compile(
    '#include <Bounce2.h>\n' +
    'Bounce2::Button btn = Bounce2::Button();\n' +
    'void setup(){ btn.attach(2, INPUT_PULLUP); btn.interval(25); }\n' +
    'void loop(){ btn.update(); if (btn.pressed()) digitalWrite(13, HIGH); }\n',
  );
  check('编译成功', r.status === 'success', r.status === 'success' ? `Flash ${r.memory?.flashUsed}` : r.message);
  check('自动探测到该库',
    (r.diagnostics ?? []).some((d: any) => d.message.includes('Bounce2')));

  console.log('\n── 幂等：同一 commit 再导一次应直接复用 ──');
  const again = await importLib('https://github.com/thomasfredericks/Bounce2');
  check('复用而非重新下载编译', again.body.status === 'accepted' && /复用/.test(again.body.message ?? ''));

  console.log('\n── 策展标记 ──');
  const dir = ok.body.library?.dir;
  const patch = await fetch(`${BASE}/v1/libraries/imported/${encodeURIComponent(dir)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ curation: 'featured' }),
  });
  check('可标记为 featured', patch.ok);
  const listed = (await (await fetch(`${BASE}/v1/libraries/imported`)).json()) as any;
  check('清单反映策展状态',
    listed.entries?.find((e: any) => e.dir === dir)?.curation === 'featured');

  console.log('\n────────────────────────────────');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('✗ 脚本异常:', e.message); process.exit(1); });
