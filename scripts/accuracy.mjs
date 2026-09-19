/**
 * Measure the accuracy of mouse.move against the requested point.
 *
 * A systematic offset here matters: `screen.find` returns a coordinate and
 * `mouse.click --point` consumes one, so an error that grows with distance
 * would make "find then click" unreliable.
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
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'acc' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);

const points = [
  [100, 100], [300, 300], [500, 500], [800, 400],
  [960, 540], [1200, 700], [1500, 900], [1800, 1000],
];

console.log('请求坐标      实测坐标      偏差(dx,dy)   距离');
console.log('-'.repeat(52));

let maxErr = 0;
for (const [x, y] of points) {
  await call('mouse.move', ['--point', `${x},${y}`, '--duration', '0.25']);
  // Small settle delay: the OS may coalesce the final pointer update.
  await new Promise((r) => setTimeout(r, 220));
  const p = await call('mouse.position');
  const dx = p.data.x - x;
  const dy = p.data.y - y;
  const dist = Math.round(Math.hypot(dx, dy) * 10) / 10;
  maxErr = Math.max(maxErr, dist);
  console.log(
    `(${String(x).padStart(4)},${String(y).padStart(4)})  ` +
    `(${String(p.data.x).padStart(4)},${String(p.data.y).padStart(4)})  ` +
    `(${String(dx).padStart(4)},${String(dy).padStart(4)})   ${dist}`,
  );
}

console.log('');
console.log(`最大偏差: ${maxErr} px`);

// Does a longer duration help? Some drivers drop the last interpolation step.
console.log('');
console.log('=== 加长 duration 是否改善 ===');
for (const dur of ['0.05', '0.5', '1.0']) {
  await call('mouse.move', ['--point', '300,300', '--duration', dur]);
  await new Promise((r) => setTimeout(r, 300));
  const p = await call('mouse.position');
  console.log(`  duration=${dur}: 实测 (${p.data.x}, ${p.data.y})  偏差=(${p.data.x - 300}, ${p.data.y - 300})`);
}

// Restore.
await call('mouse.move', ['--point', '960,540']);

