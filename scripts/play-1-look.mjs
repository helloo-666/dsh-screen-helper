/**
 * Free-form exploration: see what's on screen, then act on it.
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
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'play' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);

// What windows are open?
console.log('=== 1. 当前所有窗口 ===');
const wins = await call('window.list');
if (wins.executed && wins.data) {
  const list = wins.data.windows ?? wins.data.items ?? [];
  for (const w of list.slice(0, 15)) {
    const t = (w.title ?? w.name ?? '').slice(0, 50);
    if (t) console.log(`  ${t}`);
  }
  if (!list.length) console.log('  ' + JSON.stringify(wins.data).slice(0, 400));
} else {
  console.log('  ' + JSON.stringify(wins.data ?? wins.text).slice(0, 300));
}

console.log('');
console.log('=== 2. 前台窗口 ===');
const fg = await call('window.foreground');
console.log('  ' + JSON.stringify(fg.data).slice(0, 400));

console.log('');
console.log('=== 3. 剪贴板现状 ===');
const cb = await call('clipboard.read');
console.log(`  长度=${String(cb.data?.text ?? '').length}  内容="${String(cb.data?.text ?? '').slice(0, 60)}"`);

