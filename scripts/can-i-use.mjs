/**
 * Direct check: does the plugin actually work right now?
 *
 * Uses the REAL approval answerer semantics — an answerer that returns the true
 * grant token, exactly as dsh's service would after the user clicks "allow".
 */
import { Config, apply } from '../lib/index.js';

const CLI = process.env.SAH_CLI ?? 'ScreenAutomationHelper.exe';

// Mirror dsh's real service: it returns 'allowed-once' on an allow.
const reg = new Map();
let lastReq = null;
const ctx = {
  tools: { register(t) { reg.set(t.name, t); return () => {}; } },
  approval: {
    async request(req) {
      lastReq = req;
      return 'allowed-once';
    },
  },
};

apply(ctx, { ...Config({ approval: 'always' }), cliPath: CLI });
const tool = reg.get('screen_automation');
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'use-test' };

console.log('工具已注册:', [...reg.keys()].join(', '));
console.log('');

// 1. read tier
console.log('--- 1. status (read, 需审批) ---');
let r = await tool.execute({ action: 'status', args: [] }, exec);
console.log('  询问:', lastReq ? '是' : '否', '| executed:', r.executed, '| exit:', r.exitCode);
if (r.data) console.log('  ok=' + r.data.ok + ' status=' + (r.data.status ?? r.data.state ?? JSON.stringify(r.data).slice(0, 80)));

// 2. observe tier
console.log('--- 2. screen.monitors (observe) ---');
r = await tool.execute({ action: 'screen.monitors', args: [] }, exec);
console.log('  executed:', r.executed, '| exit:', r.exitCode, '| monitors:', r.data?.count);

// 3. the previously-broken path: a tier that must actually run after grant
console.log('--- 3. mouse.position (mutate) ---');
r = await tool.execute({ action: 'mouse.position', args: [] }, exec);
console.log('  executed:', r.executed, '| exit:', r.exitCode, '| pos:', r.data ? `(${r.data.x},${r.data.y})` : 'none');

console.log('');
console.log('=== 渲染给模型看的样子 ===');
const rendered = tool.output.render({ action: 'status', args: [] }, r);
console.log(rendered[0].text.slice(0, 300));

