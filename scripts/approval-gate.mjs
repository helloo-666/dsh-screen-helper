/**
 * Proves the approval seam behaves correctly against the live screen:
 * under `mutating`, a rejected action must NOT reach the CLI, and a read-tier
 * action must not prompt at all.
 *
 * The cursor is read before and after the rejected click, so a leaked
 * execution would be observable rather than merely asserted.
 */
import { Config, apply } from '../lib/index.js';

const CLI = process.env.SAH_CLI ?? 'ScreenAutomationHelper.exe';

const reg = new Map();
let answer = 'rejected';
let prompts = [];
const ctx = {
  tools: { register(t) { reg.set(t.name, t); return () => {}; } },
  approval: {
    async request(req) {
      prompts.push(req);
      return answer;
    },
  },
};
apply(ctx, { ...Config({ approval: 'mutating' }), cliPath: CLI });
const tool = reg.get('screen_automation');
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'gate' };
const call = (action, args) => tool.execute({ action, args }, exec);

/** Read the cursor, tolerating the fact that `mouse.position` is itself mutating. */
async function cursor() {
  const r = await call('mouse.position', []);
  return r.executed && r.data ? { x: r.data.x, y: r.data.y } : null;
}

// Park the cursor at a known spot (approval is always granted for this step).
answer = 'allowed-once';
await call('mouse.move', ['--point', '600,600']);
const parked = await cursor();
console.log(`鍏夋爣鍋滃湪 (${parked.x}, ${parked.y})`);
console.log('');

// --- Case 1: user rejects -------------------------------------------------
answer = 'rejected';
prompts = [];
const denied = await call('mouse.move', ['--point', '100,100']);
console.log('銆愭嫆缁濄€憁ouse.move -> (100,100)');
console.log(`  executed=${denied.executed}  blockedReason=${denied.blockedReason}`);
console.log(`  璇㈤棶娆℃暟=${prompts.length}  璇㈤棶鐨勫伐鍏?${prompts[0]?.toolName}`);
console.log(`  璇㈤棶鐞嗙敱=${prompts[0]?.reason}`);
// Both the click and the verification read are denied, so the cursor cannot be
// read back while rejecting. Re-allow reads to observe the real position.
answer = 'allowed-once';
prompts = [];
const afterDeny = await cursor();
console.log(`  鍏夋爣瀹為檯浣嶇疆=(${afterDeny.x}, ${afterDeny.y})  <-- 蹇呴』浠嶆槸 600,600`);
const blockedOk = afterDeny.x === 600 && afterDeny.y === 600;
console.log(`  鎷︽埅鎴愬姛=${blockedOk}`);
console.log('');

// --- Case 2: user approves ------------------------------------------------
prompts = [];
const allowed = await call('mouse.move', ['--point', '100,100']);
const afterAllow = await cursor();
console.log('銆愬悓鎰忋€憁ouse.move -> (100,100)');
console.log(`  executed=${allowed.executed}  exit=${allowed.exitCode}  璇㈤棶娆℃暟=${prompts.length}`);
console.log(`  鍏夋爣瀹為檯浣嶇疆=(${afterAllow.x}, ${afterAllow.y})  <-- 搴旇鏄?100,100`);
const allowedOk = afterAllow.x === 100 && afterAllow.y === 100;
console.log(`  鏀捐鎴愬姛=${allowedOk}`);
console.log('');

// --- Case 3: read tier must never prompt ----------------------------------
prompts = [];
const read = await call('status', []);
console.log('銆愬彧璇汇€憇tatus');
console.log(`  executed=${read.executed}  璇㈤棶娆℃暟=${prompts.length}  <-- 蹇呴』鏄?0`);
console.log(`  鎵撴壈鐢ㄦ埛=${prompts.length !== 0 ? '鏄?(閿欒!)' : '鍚?(姝ｇ‘)'}`);
console.log('');

// --- Case 4: failure modes must all deny ----------------------------------
for (const [label, impl] of [
  ['鏃犲簲绛斿櫒', null],
  ['搴旂瓟鍣ㄦ姏寮傚父', async () => { throw new Error('boom'); }],
  ['杩斿洖鍨冨溇鍊?, async () => 'yes-please'],
]) {
  if (impl === null) delete ctx.approval;
  else ctx.approval = { async request() { return impl(); } };
  await call('mouse.move', ['--point', '700,700']);
  const r = await call('mouse.move', ['--point', '123,123']);
  // Re-compose a working answerer to observe where the cursor really is.
  ctx.approval = { async request() { return 'allowed-once'; } };
  const pos = await cursor();
  const leaked = pos.x === 123 && pos.y === 123;
  console.log(`銆愬け璐ユā寮忋€?{label}: executed=${r.executed} 娉勬紡=${leaked ? '鏄?(閿欒!)' : '鍚?(姝ｇ‘)'}`);
}

// Restore the cursor.
ctx.approval = { async request() { return 'allowed-once'; } };
await call('mouse.move', ['--point', '960,540']);
const fin = await cursor();
console.log('');
console.log(`鍏夋爣宸插浣嶅埌 (${fin.x}, ${fin.y})`);

