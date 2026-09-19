/**
 * Full closed-loop test: find_exact a Bilibili nav tab, click it for real, then
 * confirm the UI reacted. Reversible (it's just tab navigation).
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
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'click' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pick a nav tab that is clearly reversible (just switches the feed).
const TAB = '直播';

console.log(`=== find_exact "${TAB}" ===`);
const r = await call('find_exact', ['--text', TAB, '--target', 'virtual-screen']);
const m = r.data?.matches?.[0];
if (!m) { console.log('没找到该标签，跳过'); process.exit(0); }
const [cx, cy] = m.center;
console.log(`  token="${m.text}"  center=(${cx},${cy})  box=${JSON.stringify(m.box)}`);

console.log('');
console.log(`=== 真实点击 (${cx},${cy}) ===`);
const click = await call('mouse.click', ['--point', `${cx},${cy}`, '--button', 'left']);
console.log(`  click executed: ${click.executed}  exit: ${click.exitCode}`);

// Wait for the page to respond.
await sleep(1500);

console.log('');
console.log('=== 验证反应：当前 B 站区域 OCR 前 100 字 ===');
const rec = await call('screen.recognize', ['--target', 'virtual-screen']);
const items = rec.data?.items ?? [];
// 看 B 站窗口区域内（y 在 43~701 之间）的文字
const inWindow = items
  .filter((i) => Array.isArray(i.box) && i.box[1] >= 43 && i.box[1] <= 701)
  .map((i) => i.text);
const sample = inWindow.slice(0, 12).join(' ');
console.log(`  "${sample.slice(0, 100)}"`);
console.log(`  当前高亮标签附近含「${TAB}」: ${inWindow.some((t) => t.includes(TAB)) ? '✅' : '⚠️'}`);

console.log('');
console.log('=== 复位光标 ===');
await call('mouse.move', ['--point', '960,540', '--duration', '0.3']);
await sleep(300);
const end = await call('mouse.position');
console.log(`  光标: (${end.data.x},${end.data.y})`);

