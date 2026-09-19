/**
 * Prove `find_exact` is more precise than `screen.find`.
 *
 * Both are asked for the same query. `screen.find` returns the box of the whole
 * *line* containing the hit; `find_exact` returns the box of the matching
 * *token*. The token box is what you actually want to click.
 */
import { Config, apply } from '../lib/index.js';

const CLI = process.env.SAH_CLI ?? 'ScreenAutomationHelper.exe';

const reg = new Map();
const ctx = {
  tools: { register(t) { reg.set(t.name, t); return () => {}; } },
  approval: { async request() { return 'allowed-once'; } },
};
apply(ctx, { ...Config({ approval: 'never' }), cliPath: CLI });
const tool = reg.get('screen_automation');
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'cmp' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);

const targets = ['屏幕', '文', '对话', '文件'];

console.log('查询          screen.find 行框                    find_exact 词框');
console.log('-'.repeat(82));

for (const q of targets) {
  const line = await call('screen.find', ['--text', q, '--target', 'virtual-screen']);
  const token = await call('find_exact', ['--text', q, '--target', 'virtual-screen']);

  const lbox = line.data?.matches?.[0]?.box ?? line.data?.box ?? null;
  const tmatch = token.data?.matches?.[0];
  const tbox = tmatch?.box ?? null;

  const ls = lbox ? `[${lbox.join(',')}]` : '—';
  const ts = tbox ? `[${tbox.join(',')}]` : '—';
  console.log(`${q.padEnd(12)} ${ls.padEnd(36)} ${ts}`);
  if (lbox && tbox) {
    const lw = lbox[2] - lbox[0];
    const tw = tbox[2] - tbox[0];
    console.log(`             行框宽 ${lw}px                   词框宽 ${tw}px   ${tw < lw ? '✅ 更窄更准' : ''}`);
  }
}

