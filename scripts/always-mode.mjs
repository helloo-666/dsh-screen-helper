/**
 * Verifies `approval: always` against the live screen: every tier must ask, and
 * a declined read must leave the machine untouched.
 *
 * The clipboard is the witness here — it is observable outside this process, so
 * a leaked read is detectable rather than merely asserted.
 */
import { Config, apply } from '../lib/index.js';

const CLI = process.env.SAH_CLI ?? 'ScreenAutomationHelper.exe';

const reg = new Map();
let prompts = [];
let answer = 'allowed-once';
const ctx = {
  tools: { register(t) { reg.set(t.name, t); return () => {}; } },
  approval: { async request(req) { prompts.push(req); return answer; } },
};
apply(ctx, { ...Config({ approval: 'always' }), cliPath: CLI });
const tool = reg.get('screen_automation');
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'always' };
const call = (action, args = []) => tool.execute({ action, args }, exec);

/** Prompt count accumulated while running one call. */
async function withCount(fn) {
  prompts = [];
  const r = await fn();
  return { r, n: prompts.length };
}

console.log('=== approval: always —— 每一次调用都必须询问 ===');
console.log('');

const probes = [
  ['status', [], 'read'],
  ['health', [], 'read'],
  ['screen.recognize', ['--target', 'work-area', '--text-only'], 'observe'],
  ['clipboard.read', [], 'observe'],
  ['mouse.position', [], 'mutate'],
];

for (const [action, args, tier] of probes) {
  answer = 'allowed-once';
  const { r, n } = await withCount(() => call(action, args));
  const ran = r.executed === true;
  console.log(
    `  ${action.padEnd(18)} tier=${tier.padEnd(8)} 询问=${n}  执行=${ran}  exit=${r.exitCode}`,
  );
  if (n !== 1) console.log(`    !! 期望恰好询问 1 次，实际 ${n} 次`);
  if (!ran) console.log(`    !! 已批准却未执行: ${r.blockedReason}`);
}

console.log('');
console.log('=== 拒绝时：连只读操作也必须被挡住 ===');
answer = 'rejected';
const { r: denied, n: deniedN } = await withCount(() => call('clipboard.read'));
console.log(`  clipboard.read  询问=${deniedN}  executed=${denied.executed}`);
console.log(`  blockedReason=${denied.blockedReason}`);
console.log(`  返回的数据=${JSON.stringify(denied.data)}  <-- 必须是 null`);
const noLeak = denied.data === null && denied.executed === false;
console.log(`  未泄露剪贴板内容=${noLeak}`);

console.log('');
console.log('=== 询问内容是否清楚 ===');
// Aim at a deliberately neutral spot. A click is real and irreversible, so the
// probe uses the far corner of the desktop rather than whatever window happens
// to sit mid-screen (a stray click into another app could activate a control).
answer = 'allowed-once';
const { r: clickR } = await withCount(() => call('mouse.move', ['--point', '40,1040', '--duration', '0.3']));
console.log(`  工具名: ${prompts[0]?.toolName}`);
console.log(`  理由:   ${prompts[0]?.reason}`);
console.log(`  执行:   ${clickR.executed}  exit=${clickR.exitCode}`);

console.log('');
console.log('=== 恢复光标到屏幕中央 ===');
await withCount(() => call('mouse.move', ['--point', '960,540']));
const fin = await call('mouse.position');
console.log(`  光标位置: (${fin.data?.x}, ${fin.data?.y})`);

