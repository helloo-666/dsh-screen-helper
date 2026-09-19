/**
 * Calculator, second attempt: use the keyboard instead of hunting for buttons.
 *
 * The first attempt proved a real limitation worth recording: single-character
 * OCR is unreliable (7 -> ⑧, = -> 二), so `screen.find` is the wrong tool for
 * calculator keys. Keyboard synthesis avoids the recognition step entirely.
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
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'calc2' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('=== 启动计算器 ===');
const child = spawn('calc.exe', [], { detached: true, stdio: 'ignore', shell: false });
child.unref();
await sleep(3500);

let fg = await call('window.foreground');
console.log(`前台: "${fg.data?.title}"`);

// Type the expression directly. Calculator accepts digits and + - * / via keys.
console.log('');
console.log('=== 输入 7*6= ===');
const typed = await call('keyboard.write', ['--text', '7*6=', '--interval', '0.08']);
console.log(`  输入 ok=${typed.data?.ok}`);
await sleep(900);

const rec = await call('screen.recognize', ['--target', 'foreground', '--text-only']);
const text = String(rec.data?.text ?? '');
console.log(`  OCR: "${text.replace(/\n/g, ' ').slice(0, 200)}"`);
console.log(`  含 42: ${text.includes('42') ? '✅' : '⚠️'}`);

console.log('');
console.log('=== 再试 123+456= ===');
await call('keyboard.hotkey', ['escape']);
await sleep(500);
await call('keyboard.write', ['--text', '123+456=', '--interval', '0.08']);
await sleep(900);
const rec2 = await call('screen.recognize', ['--target', 'foreground', '--text-only']);
const t2 = String(rec2.data?.text ?? '');
console.log(`  OCR: "${t2.replace(/\n/g, ' ').slice(0, 200)}"`);
console.log(`  含 579: ${t2.includes('579') ? '✅' : '⚠️'}`);

console.log('');
console.log('=== 截个图存档 ===');
const shot = await call('screen.capture', ['--target', 'foreground', '--output', 'F:\\DSHwork\\dsh-screen-helper\\calc-proof.png']);
console.log(`  截图: ok=${shot.data?.ok} path=${shot.data?.output ?? shot.data?.path ?? '?'}`);

console.log('');
console.log('=== 关闭 ===');
await call('keyboard.hotkey', ['alt', 'f4']);
await sleep(900);
fg = await call('window.foreground');
console.log(`  关闭后前台: "${fg.data?.title}"`);

