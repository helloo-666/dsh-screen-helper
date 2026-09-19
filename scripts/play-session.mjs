/**
 * Live play session — drive the real desktop to test the plugin end-to-end.
 * Stays in observe + reversible-mutate territory; nothing destructive.
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
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'play' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('=== 1. 当前窗口 ===');
const wins = await call('window.list-visible');
for (const w of wins.data?.windows ?? []) if (w.title) console.log(`  - ${w.title}`);

console.log('');
console.log('=== 2. 整屏 OCR（看有什么可玩的）===');
const rec = await call('screen.recognize', ['--target', 'virtual-screen']);
const items = rec.data?.items ?? [];
console.log(`  识别到 ${items.length} 个词。`);
// 看看有哪些"能点"的应用名
const apps = items.map((i) => i.text).filter((t) => /哔哩|Chrome|记事本|计算器|文件|设置|Steam|网易|抖音/.test(t));
console.log('  屏幕上出现的相关词:', [...new Set(apps)].join(' / '));

