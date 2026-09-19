/**
 * Read the current desktop through OCR and report what's there.
 * This is how a text-only model "sees" the screen.
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
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'read' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);

console.log('=== 整屏 OCR ===');
const rec = await call('screen.recognize', ['--target', 'virtual-screen', '--text-only']);
const text = String(rec.data?.text ?? '');
console.log(`识别到 ${text.length} 字符\n`);

// Split into lines and show the most informative ones.
const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 1);
console.log('--- 屏幕上出现的内容（前 40 行）---');
lines.slice(0, 40).forEach((l, i) => console.log(`${String(i + 1).padStart(3)}. ${l}`));

console.log('');
console.log('=== 可见窗口 ===');
const wins = await call('window.list-visible');
for (const w of wins.data?.windows ?? []) {
  if (w.title) console.log(`  - ${w.title}`);
}

console.log('');
console.log('=== 显示器 ===');
const mon = await call('screen.monitors');
console.log(`  数量=${mon.data?.count} 虚拟区域=${JSON.stringify(mon.data?.virtual_region)}`);
for (const m of mon.data?.monitors ?? []) {
  console.log(`  区域=${JSON.stringify(m.region)} 工作区=${JSON.stringify(m.work_area)} 主屏=${m.primary}`);
}

