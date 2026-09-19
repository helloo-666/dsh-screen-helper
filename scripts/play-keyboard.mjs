/**
 * Keyboard demonstration that does not depend on launching an app (the helper
 * cannot start processes; `task.begin` binds to an existing window).
 *
 * Types into the DSH window's own search/input box is risky, so instead this
 * proves keyboard synthesis by typing into a window we control the lifecycle
 * of: a Notepad started by THIS script via PowerShell, then handed to the
 * helper for the actual input.
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
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'kb' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);

// Launch Notepad ourselves — the OS launches it, the helper drives the input.
console.log('=== 启动记事本 ===');
const child = spawn('notepad.exe', [], { detached: true, stdio: 'ignore', shell: false });
child.unref();
await new Promise((r) => setTimeout(r, 3000));

const fg = await call('window.foreground');
const title = String(fg.data?.title ?? '');
console.log(`前台窗口: "${title}"`);

if (title.includes('记事本') || title.toLowerCase().includes('notepad')) {
  const MARKER = 'DSH-HELPER-KEYBOARD-TEST-12345';
  const text = `${MARKER}\n屏幕自动化插件键盘输入正常。`;

  console.log('');
  console.log('=== keyboard.write 输入 ===');
  const k = await call('keyboard.write', ['--text', text, '--interval', '0.015']);
  console.log(`ok=${k.data?.ok}  executed=${k.executed}`);

  await new Promise((r) => setTimeout(r, 900));

  console.log('');
  console.log('=== OCR 回读，验证文字真的落在屏幕上 ===');
  const rec = await call('screen.recognize', ['--target', 'foreground', '--text-only']);
  const seen = String(rec.data?.text ?? '');
  const hit = seen.includes(MARKER);
  console.log(`命中标记 "${MARKER}": ${hit ? '✅' : '❌'}`);
  console.log(`OCR 内容: "${seen.slice(0, 120).replace(/\n/g, ' | ')}"`);

  console.log('');
  console.log('=== keyboard.hotkey 测试 ===');
  const hk = await call('keyboard.hotkey', ['ctrl', 'a']);
  console.log(`Ctrl+A: ok=${hk.data?.ok}`);
  await new Promise((r) => setTimeout(r, 400));

  const del = await call('keyboard.hotkey', ['delete']);
  console.log(`Delete: ok=${del.data?.ok}`);
  await new Promise((r) => setTimeout(r, 600));

  const rec2 = await call('screen.recognize', ['--target', 'foreground', '--text-only']);
  const after = String(rec2.data?.text ?? '');
  console.log(`清空后标记是否消失: ${after.includes(MARKER) ? '❌ 仍存在' : '✅ 已清空'}`);

  console.log('');
  console.log('=== 关闭记事本（不保存）===');
  // Alt+F4 then "N" for don't-save, driven by the helper itself.
  await call('keyboard.hotkey', ['alt', 'f4']);
  await new Promise((r) => setTimeout(r, 1200));
  const rec3 = await call('screen.recognize', ['--target', 'virtual-screen', '--text-only']);
  const dlg = String(rec3.data?.text ?? '');
  if (dlg.includes('保存') || dlg.includes('不保存')) {
    console.log('  出现保存确认对话框，选择「不保存」');
    await call('keyboard.hotkey', ['alt', 'n']);
    await new Promise((r) => setTimeout(r, 800));
  } else {
    console.log('  未出现对话框（可能已默认关闭）');
  }
  const fg3 = await call('window.foreground');
  console.log(`  当前前台: "${fg3.data?.title}"`);
} else {
  console.log('记事本未成为前台窗口，跳过');
}

