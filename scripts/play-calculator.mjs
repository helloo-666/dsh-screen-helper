/**
 * Real demonstration: drive Windows Calculator entirely through the plugin.
 *
 * Flow: launch -> wait -> locate each button by OCR -> click it -> verify the
 * result by reading the display. Nothing is destructive and the window is
 * closed at the end.
 */
import { Config, apply } from '../lib/index.js';
import { spawn } from 'node:child_process';

const CLI = process.env.SAH_CLI ?? 'ScreenAutomationHelper.exe';

const reg = new Map();
const ctx = {
  tools: { register(t) { reg.set(t.name, t); return () => {}; } },
  approval: { async request() { return 'allowed-once'; } },
};
apply(ctx, { ...Config({ approval: 'always' }), cliPath: CLI });
const tool = reg.get('screen_automation');
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'calc' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Click a calculator button by finding its label on screen. */
async function press(label) {
  const found = await call('screen.find', ['--text', label, '--target', 'foreground']);
  const m = found.data?.matches ?? [];
  if (!found.data?.found || !m.length) {
    console.log(`    「${label}」未找到`);
    return false;
  }
  // Prefer the smallest matching box: the button itself, not a longer line.
  const best = m.reduce((a, b) => {
    const areaA = (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]);
    const areaB = (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]);
    return areaB < areaA ? b : a;
  });
  const [cx, cy] = best.center;
  await call('mouse.click', ['--point', `${cx},${cy}`, '--button', 'left']);
  await sleep(280);
  return true;
}

/** Read the calculator's result area through OCR. */
async function readDisplay() {
  const rec = await call('screen.recognize', ['--target', 'foreground', '--text-only']);
  return String(rec.data?.text ?? '');
}

console.log('=== 1. 启动计算器 ===');
const child = spawn('calc.exe', [], { detached: true, stdio: 'ignore', shell: false });
child.unref();
await sleep(3500);

const fg = await call('window.foreground');
console.log(`前台: "${fg.data?.title}"  pid=${fg.data?.process_id}`);

if (!/计算器|Calculator/i.test(String(fg.data?.title ?? ''))) {
  console.log('计算器未成为前台窗口，改为激活它');
  await call('window.activate', ['--title', '计算器']);
  await sleep(1200);
  const fg2 = await call('window.foreground');
  console.log(`现在前台: "${fg2.data?.title}"`);
}

console.log('');
console.log('=== 2. 看看计算器上有什么 ===');
const initial = await readDisplay();
console.log(`OCR: "${initial.replace(/\n/g, ' ').slice(0, 160)}"`);

console.log('');
console.log('=== 3. 按 7 + 8 =  (期望 15) ===');
for (const k of ['7', '+', '8', '=']) {
  const ok = await press(k);
  const cur = await readDisplay();
  const tail = cur.replace(/\n/g, ' ').trim().slice(0, 60);
  console.log(`  按下「${k}」 ${ok ? '✓' : '✗'}  屏幕: "${tail}"`);
}

console.log('');
console.log('=== 4. 最终结果 ===');
const final = await readDisplay();
console.log(`OCR: "${final.replace(/\n/g, ' ').slice(0, 200)}"`);
console.log(`包含 15: ${final.includes('15') ? '✅ 计算正确' : '⚠️ 未识别到 15'}`);

console.log('');
console.log('=== 5. 关闭计算器（不保存任何东西）===');
await call('window.activate', ['--title', '计算器']);
await sleep(600);
await call('keyboard.hotkey', ['alt', 'f4']);
await sleep(900);
const after = await call('window.foreground');
console.log(`  关闭后前台: "${after.data?.title}"`);

