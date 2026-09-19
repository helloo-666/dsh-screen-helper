/**
 * The end-to-end capability that matters most: find on-screen text, move to it,
 * and confirm the cursor landed inside the matched region.
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
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'find' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);

// Read what is actually on screen so we target something that exists.
const rec = await call('screen.recognize', ['--target', 'virtual-screen', '--text-only']);
const all = String(rec.data?.text ?? '');
console.log('屏幕文字长度:', all.length, '字符');
console.log('');

// Pick a handful of real fragments to search for.
const candidates = ['文件', '编辑', '查看', '窗口', '帮助', 'DSH', '插件']
  .filter((t) => all.includes(t));

console.log('=== screen.find 定位测试 ===');
for (const term of candidates.slice(0, 5)) {
  const r = await call('screen.find', ['--text', term, '--target', 'virtual-screen']);
  if (r.executed && r.data?.ok) {
    const m = r.data.matches ?? [];
    if (r.data.found && m.length) {
      const first = m[0];
      // The helper returns `box` (x1,y1,x2,y2) plus a precomputed `center`.
      // Note it matches the whole OCR *line* containing the term, not the word.
      console.log(
        `  "${term}" -> ${m.length} 处, center=${JSON.stringify(first.center)}` +
        `  命中行="${String(first.text).slice(0, 24)}"`,
      );
    } else {
      console.log(`  "${term}" -> 未找到`);
    }
  } else {
    console.log(`  "${term}" -> 失败: ${JSON.stringify(r.data ?? r.text).slice(0, 120)}`);
  }
}

// Now the real proof: find something, move there, verify the cursor is inside.
console.log('');
console.log('=== 找到 -> 移动 -> 验证落在目标内 ===');
const probe = candidates[0] ?? 'DSH';
const found = await call('screen.find', ['--text', probe, '--target', 'virtual-screen']);
const match = found.data?.matches?.[0];
if (match) {
  const box = match.box;
  const [cx, cy] = match.center;
  const before = await call('mouse.position');
  console.log(`  目标 "${probe}" 行="${String(match.text).slice(0, 30)}" 置信度=${match.confidence.toFixed(3)}`);
  console.log(`  命中框 box=${JSON.stringify(box)} 中心=(${cx},${cy})`);
  console.log(`  起始光标=(${before.data.x},${before.data.y})`);

  await call('mouse.move', ['--point', `${cx},${cy}`, '--duration', '0.3']);
  await new Promise((r) => setTimeout(r, 250));
  const after = await call('mouse.position');

  const inside = after.data.x >= box[0] && after.data.x <= box[2]
    && after.data.y >= box[1] && after.data.y <= box[3];
  console.log(`  移动后光标=(${after.data.x},${after.data.y})`);
  console.log(`  落在目标矩形内 = ${inside ? '✅ 是' : '❌ 否'}`);
} else {
  console.log(`  未能定位 "${probe}"`);
}

// Restore.
await call('mouse.move', ['--point', '960,540']);
console.log('');
console.log('光标已复位 (960,540)');

