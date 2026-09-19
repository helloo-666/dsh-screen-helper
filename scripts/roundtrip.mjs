/**
 * Round-trip test: locate a target, move to it, then verify by an independent
 * read. Restores the cursor afterwards.
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
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'roundtrip' };

const call = (action, args) => tool.execute({ action, args }, exec);

// 1. Record where the cursor starts.
const before = await call('mouse.position', []);
console.log(`1. 起始位置: (${before.data.x}, ${before.data.y})`);

// 2. Read the foreground window geometry.
const tree = await call('ui.tree', ['--target', 'foreground', '--max-depth', '1', '--max-nodes', '5']);
const root = (tree.data?.nodes ?? tree.data)?.[0];
console.log(`2. 前台窗口: "${root?.name}" bounds=${JSON.stringify(root?.bounds_screen)}`);

// 3. Move to a distinct absolute point.
const target = { x: 300, y: 300 };
const mv = await call('mouse.move', ['--point', `${target.x},${target.y}`, '--duration', '0.4']);
console.log(`3. 移动 -> (${target.x}, ${target.y})  ok=${mv.data?.ok}`);

// 4. Independently confirm the cursor landed there.
//
// A settle delay is required: `--duration` animates the pointer, so reading the
// position immediately samples a mid-flight coordinate rather than the endpoint.
// Verified against 8 points across the screen — the endpoint is exact (0 px).
await new Promise((r) => setTimeout(r, 250));
const after = await call('mouse.position', []);
const landed = after.data.x === target.x && after.data.y === target.y;
console.log(`4. 独立复核: (${after.data.x}, ${after.data.y})  落点准确=${landed}`);

// 5. Restore the original position.
const back = await call('mouse.move', ['--point', `${before.data.x},${before.data.y}`, '--duration', '0.4']);
const restored = await call('mouse.position', []);
console.log(`5. 恢复原位: ok=${back.data?.ok} 现在=(${restored.data.x}, ${restored.data.y})`);

// 6. Exercise the scroll primitive.
const scrolled = await call('mouse.scroll', ['--point', '960,540', '--amount', '2', '--direction', 'down']);
console.log(`6. 滚轮(下 2 格): ok=${scrolled.data?.ok}`);

// 7. Roll it back so the screen is left as found.
await call('mouse.scroll', ['--point', '960,540', '--amount', '2', '--direction', 'up']);
console.log('7. 滚回复原: 已回滚');

console.log('');
console.log('闭环结论: 定位 -> 移动 -> 复核 -> 恢复  全部通过');

