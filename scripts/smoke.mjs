/**
 * Manual smoke run: drives the plugin against the real screen, the way the
 * model will once the tool is registered. Not part of `npm test` because it
 * depends on what happens to be visible on screen.
 */
import { Config, apply } from '../lib/index.js';

const CLI = process.env.SAH_CLI ?? 'ScreenAutomationHelper.exe';

const reg = new Map();
const ctx = {
  tools: { register(t) { reg.set(t.name, t); return () => {}; } },
  // Stand in for the approval service so a `mutating` run can be exercised.
  approval: { async request() { return 'allowed-once'; } },
};
apply(ctx, { ...Config({ approval: 'never' }), cliPath: CLI });
const tool = reg.get('screen_automation');
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'smoke' };

async function call(action, args) {
  return tool.execute({ action, args }, exec);
}

function show(label, r) {
  console.log(`--- ${label} [tier=${r.tier}] ---`);
  if (!r.executed) { console.log(`  NOT EXECUTED: ${r.blockedReason}`); return; }
  console.log(`  exit=${r.exitCode}`);
  const payload = r.data ?? r.text;
  console.log('  ' + JSON.stringify(payload).slice(0, 700));
  console.log('');
}

console.log('===== 1. screen.find锛氬湪灞忓箷涓婃壘鏂囧瓧 =====');
for (const term of ['鍙戦€?, '鏂颁細璇?, 'python']) {
  const r = await call('screen.find', ['--text', term, '--target', 'virtual-screen']);
  console.log(`--- find "${term}" ---`);
  if (r.executed && r.data?.ok) {
    const m = r.data.matches ?? [];
    if (m.length) {
      const coords = m.slice(0, 3).map((x) => JSON.stringify(x.center ?? x.region));
      console.log(`  鎵惧埌 ${m.length} 澶? ${coords.join(' | ')}`);
    } else {
      console.log('  鏈尮閰?);
    }
  } else {
    console.log('  ' + JSON.stringify(r.data ?? r.text).slice(0, 300));
  }
}

console.log('');
console.log('===== 2. ui.tree锛氳绐楀彛鎺т欢鏍?=====');
const tree = await call('ui.tree', ['--target', 'foreground', '--max-depth', '3', '--max-nodes', '40']);
console.log(`--- ui.tree [tier=${tree.tier}] exit=${tree.exitCode} ---`);
const nodes = tree.data?.nodes ?? tree.data?.tree ?? tree.data;
console.log('  ' + JSON.stringify(nodes).slice(0, 800));

console.log('');
console.log('===== 3. clipboard.read =====');
show('clipboard.read', await call('clipboard.read', []));

console.log('===== 4. mouse.move锛堢Щ鍔ㄥ埌灞忓箷涓績锛屽彲瑙佷絾鏃犲锛?====');
show('mouse.move', await call('mouse.move', ['--point', '960,540', '--duration', '0.3']));

console.log('===== 5. 榧犳爣褰撳墠浣嶇疆 =====');
show('mouse.position', await call('mouse.position', []));

