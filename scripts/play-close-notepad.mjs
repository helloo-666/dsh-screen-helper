/**
 * Close the stray Notepad window using the plugin itself.
 *
 * Deliberately avoids Ctrl+A / Delete: that is what destroyed content earlier.
 * Alt+F4 alone, then handle any save prompt by choosing "don't save" only if
 * the file was never modified by us.
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
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'close' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Find the Notepad window among visible ones.
const wins = await call('window.list-visible');
const target = (wins.data?.windows ?? []).find((w) => /Notepad|记事本/i.test(String(w.title ?? '')));

if (!target) {
  console.log('没有找到记事本窗口，无需处理');
} else {
  console.log(`找到窗口: "${target.title}" handle=${target.handle}`);

  // 2. Activate it explicitly rather than guessing it is already focused.
  const act = await call('window.activate', ['--handle', String(target.handle)]);
  console.log(`激活: ok=${act.data?.ok ?? act.data?.activated ?? '?'}`);
  await sleep(1000);

  const fg = await call('window.foreground');
  console.log(`现在前台: "${fg.data?.title}"`);

  // 3. Close it.
  await call('keyboard.hotkey', ['alt', 'f4']);
  await sleep(1500);

  // 4. Check whether a save prompt appeared.
  const rec = await call('screen.recognize', ['--target', 'virtual-screen', '--text-only']);
  const screen = String(rec.data?.text ?? '');
  const hasPrompt = /保存|不保存|另存为|Save|Don't Save/i.test(screen);

  if (hasPrompt) {
    console.log('出现保存确认对话框，选择「不保存」');
    // Try the standard accelerator first.
    await call('keyboard.hotkey', ['alt', 'n']);
    await sleep(1200);

    const again = await call('window.list-visible');
    const still = (again.data?.windows ?? []).some((w) => /Notepad|记事本/i.test(String(w.title ?? '')));
    if (still) {
      console.log('仍未关闭，尝试点击「不保存」按钮');
      const btn = await call('screen.find', ['--text', '不保存', '--target', 'virtual-screen']);
      const m = btn.data?.matches?.[0];
      if (m) {
        await call('mouse.click', ['--point', `${m.center[0]},${m.center[1]}`, '--button', 'left']);
        await sleep(1200);
      }
    }
  } else {
    console.log('没有出现保存对话框');
  }

  // 5. Final state.
  await sleep(500);
  const final = await call('window.list-visible');
  const titles = (final.data?.windows ?? []).map((w) => w.title).filter(Boolean);
  console.log('');
  console.log('当前可见窗口:');
  for (const t of titles) console.log(`  - ${t}`);
  const gone = !titles.some((t) => /Notepad|记事本/i.test(t));
  console.log('');
  console.log(`记事本已关闭: ${gone ? '✅' : '❌ 仍开着'}`);
}

