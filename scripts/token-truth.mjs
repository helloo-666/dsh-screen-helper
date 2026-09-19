/**
 * Ground truth for the approval token: drives the REAL approval service
 * contract against the live screen, using the exact token dsh emits.
 *
 * Every case is verified by re-reading the cursor, so the verdict reflects
 * hardware state rather than a return value.
 */
import { Config, apply } from '../lib/index.js';

const CLI = process.env.SAH_CLI ?? 'ScreenAutomationHelper.exe';

function build(outcomeFn) {
  const reg = new Map();
  const ctx = {
    tools: { register(t) { reg.set(t.name, t); return () => {}; } },
    approval: { async request() { return outcomeFn(); } },
  };
  apply(ctx, { ...Config({ approval: 'always' }), cliPath: CLI });
  return reg.get('screen_automation');
}

const exec = { signal: new AbortController().signal, agent: undefined, callId: 'truth' };

async function cursorWith(tool) {
  const saved = tool;
  // `mouse.position` is mutating, so allow it explicitly for the read-back.
  const reading = build(() => 'allowed-once');
  const r = await reading.execute({ action: 'mouse.position', args: [] }, exec);
  return r.executed && r.data ? { x: r.data.x, y: r.data.y } : null;
}

console.log('=== 用真实令牌验证：授权必须真的执行 ===');
console.log('');

// Move to a known start, then try to move to a distinct target under each outcome.
const START = { x: 500, y: 500 };
const TARGET = { x: 800, y: 400 };
const TARGET_STR = `${TARGET.x},${TARGET.y}`;

for (const [label, token] of [
  ['allowed-once (授权)', 'allowed-once'],
  ['rejected (拒绝)', 'rejected'],
  ['cancelled (取消)', 'cancelled'],
  ['unavailable (无应答器)', 'unavailable'],
  ['approved (不存在的词)', 'approved'],
]) {
  // Park at START with a granted tool.
  const parker = build(() => 'allowed-once');
  await parker.execute({ action: 'mouse.move', args: ['--point', `${START.x},${START.y}`, '--duration', '0.2'] }, exec);

  // Now attempt the move under the outcome being tested.
  const tool = build(() => token);
  const r = await tool.execute(
    { action: 'mouse.move', args: ['--point', TARGET_STR, '--duration', '0.2'] },
    exec,
  );

  const pos = await cursorWith(tool);
  const moved = pos && pos.x === TARGET.x && pos.y === TARGET.y;
  const expectedGrants = token === 'allowed-once';
  const correct = moved === expectedGrants;

  console.log(`  ${label.padEnd(28)} executed=${String(r.executed).padEnd(5)} 光标=(${pos?.x},${pos?.y})  真的动了=${String(moved).padEnd(5)} ${correct ? '✅ 正确' : '❌ 错误'}`);
}

// Restore.
const restorer = build(() => 'allowed-once');
await restorer.execute({ action: 'mouse.move', args: ['--point', '960,540'] }, exec);
console.log('');
console.log('光标已复位 (960,540)');

