/**
 * Final state check: leave nothing running and nothing moved.
 */
import { Config, apply } from '../lib/index.js';

const CLI = process.env.SAH_CLI ?? 'ScreenAutomationHelper.exe';

const reg = new Map();
const ctx = {
  tools: { register(t) { reg.set(t.name, t); return () => {}; } },
  approval: { async request() { return 'allowed-once'; } },
};
apply(ctx, { ...Config({ approval: 'always' }), cliPath: CLI });
const tool = reg.get('screen_automation');
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'final' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);

console.log('=== 当前可见窗口 ===');
const wins = await call('window.list-visible');
const titles = (wins.data?.windows ?? []).map((w) => w.title).filter(Boolean);
for (const t of titles) console.log(`  - ${t}`);

console.log('');
console.log('=== 我开的程序是否都已关闭 ===');
const mine = titles.filter((t) => /计算器|Calculator|Notepad|记事本/i.test(t));
console.log(mine.length === 0 ? '  ✅ 都关了' : `  ❌ 还在: ${mine.join(', ')}`);

console.log('');
console.log('=== 光标位置 ===');
const pos = await call('mouse.position');
console.log(`  (${pos.data?.x}, ${pos.data?.y})`);

console.log('');
console.log('=== 剪贴板（应为你原来的内容）===');
const cb = await call('clipboard.read');
console.log(`  "${String(cb.data?.text ?? '').slice(0, 40)}"`);

console.log('');
console.log('=== 是否有残留的屏幕任务目标 ===');
const fs = await import('node:fs');
const statePath = 'C:\\Users\\Hello\\Xiaozs\\ScreenAutomationHelper\\agent_screen_task.json';
if (fs.existsSync(statePath)) {
  const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  console.log(`  状态文件存在, 绑定目标: "${st?.target?.title ?? st?.title ?? '?'}"`);
  console.log(`  (这是插件留下的，下次调用 task.begin 会覆盖它)`);
} else {
  console.log('  无');
}

