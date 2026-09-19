/**
 * Capture a real "model-driven" action sequence as stills, then we combine them
 * into a GIF. Each shot is a real full-screen capture taken AFTER the action, so
 * the cursor's real position (and any visible change) is in the frame.
 */
import { Config, apply } from '../lib/index.js';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

const CLI = process.env.SAH_CLI ?? 'ScreenAutomationHelper.exe';
const DOCS = new URL('../docs/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const fs = await import('node:fs');

const reg = new Map();
const ctx = {
  tools: { register(t) { reg.set(t.name, t); return () => {}; } },
  approval: { async request() { return 'allowed-once'; } },
};
apply(ctx, { ...Config({ approval: 'always', cliPath: CLI }) });
const tool = reg.get('screen_automation');
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'gif' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shot = async (name) => {
  const out = `${DOCS}\\${name}.png`;
  const r = await call('screen.capture', ['--target', 'virtual-screen', '--output', out]);
  return out;
};

console.log('1. base');
shot('seq0');
await sleep(400);

console.log('2. find a stable DSH tab token box');
let m = null;
for (const q of ['新会话', '对话', '任务', '轨迹']) {
  const fe = await call('find_exact', ['--text', q, '--target', 'virtual-screen']);
  m = fe.data?.matches?.[0];
  if (m) { console.log(`  找到 "${q}"`); break; }
}
shot('seq1');
await sleep(400);

if (m) {
  const [cx, cy] = m.center;
  console.log(`3. move cursor to (${cx},${cy})`);
  await call('mouse.move', ['--point', `${cx},${cy}`, '--duration', '0.6']);
  await sleep(700);
  shot('seq2');
  console.log('4. click');
  await call('mouse.click', ['--point', `${cx},${cy}`, '--button', 'left']);
  await sleep(900);
  shot('seq3');
} else {
  console.log('  未找到稳定目标，跳过移动/点击帧');
}

console.log('5. move back + reset');
await call('mouse.move', ['--point', '960,540', '--duration', '0.4']);
await sleep(500);
shot('seq4');
console.log('done; frames in docs/');
