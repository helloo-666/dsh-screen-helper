/**
 * Test find_exact by clicking a real control in the front-most app (Bilibili),
 * without changing anything — just moving the cursor onto a found label and
 * reading it back. Reversible and observable.
 */
import { Config, apply } from '../lib/index.js';

const CLI = process.env.SAH_CLI ?? 'ScreenAutomationHelper.exe';

const reg = new Map();
const ctx = {
  tools: { register(t) { reg.set(t.name, t); return () => {}; } },
  approval: { async request(req) { console.log(`  [审批] ${req.reason}`); return 'allowed-once'; } },
};
apply(ctx, { ...Config({ approval: 'always', cliPath: CLI }) });
const tool = reg.get('screen_automation');
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'bili' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('=== 1. B 站窗口信息 ===');
const wins = await call('window.list-visible');
const bili = (wins.data?.windows ?? []).find((w) => /哔哩|干杯/.test(String(w.title ?? '')));
if (!bili) { console.log('没找到 B 站窗口'); process.exit(0); }
console.log(`  标题: ${bili.title}`);
console.log(`  区域: ${JSON.stringify(bili.window_region)}`);

console.log('');
console.log('=== 2. find_exact 在 B 站区域找可点元素 ===');
// 先整屏识别，挑几个 B 站界面常见的词
const rec = await call('screen.recognize', ['--target', 'virtual-screen']);
const items = rec.data?.items ?? [];
const candidates = ['推荐', '热门', '直播', '动态', '收藏', '历史', '搜索', '首页', '放映厅', '会员'];
const found = candidates.filter((c) => items.some((i) => i.text === c || i.text.includes(c)));
console.log(`  命中候选: ${found.join(' / ') || '(无)'}`);

for (const q of found.slice(0, 4)) {
  console.log('');
  console.log(`--- find_exact "${q}" ---`);
  const r = await call('find_exact', ['--text', q, '--target', 'virtual-screen']);
  const m = r.data?.matches?.[0];
  if (!m) { console.log('  未找到 token'); continue; }
  console.log(`  token="${m.text}"  center=(${m.center[0]},${m.center[1]})  box=${JSON.stringify(m.box)}`);

  // 把光标移上去（不点击，避免触发导航），验证精确落点
  const [cx, cy] = m.center;
  await call('mouse.move', ['--point', `${cx},${cy}`, '--duration', '0.3']);
  await sleep(300);
  const pos = await call('mouse.position');
  const ok = pos.data.x === cx && pos.data.y === cy;
  console.log(`  光标移到 (${cx},${cy}) -> 实际 (${pos.data.x},${pos.data.y})  ${ok ? '✅ 精确' : '❌ 偏'}`);
}

console.log('');
console.log('=== 3. 复位光标 ===');
await call('mouse.move', ['--point', '960,540', '--duration', '0.3']);
await sleep(300);
const end = await call('mouse.position');
console.log(`  光标复位: (${end.data.x},${end.data.y})`);

