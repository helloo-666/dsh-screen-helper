/**
 * Close the stray Notepad window — corrected API usage.
 *
 * The two-command contract is: `window.select` binds a target by title/handle,
 * then `window.activate` acts on that bound target (`--target`, not `--handle`).
 * Passing `--handle` to `activate` is silently ignored, which is why the window
 * never came forward last time.
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
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'close2' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wins = await call('window.list-visible');
const target = (wins.data?.windows ?? []).find((w) => /Notepad|记事本/i.test(String(w.title ?? '')));

if (!target) {
  console.log('没有记事本窗口');
} else {
  console.log(`目标: "${target.title}"  handle=${target.handle}`);

  // 1. Bind the target explicitly.
  const sel = await call('window.select', ['--handle', String(target.handle)]);
  console.log(`select: ${JSON.stringify(sel.data).slice(0, 160)}`);

  // 2. Activate the bound target (no --handle here).
  const act = await call('window.activate', ['--target', 'selected']);
  console.log(`activate: ${JSON.stringify(act.data).slice(0, 160)}`);
  await sleep(1200);

  const fg = await call('window.foreground');
  console.log(`前台: "${fg.data?.title}"  pid=${fg.data?.process_id}`);

  if (String(fg.data?.process_id) === String(target.process_id)) {
    // 3. Close it.
    await call('keyboard.hotkey', ['alt', 'f4']);
    await sleep(1500);

    // 4. Handle the save prompt if one appears.
    const rec = await call('screen.recognize', ['--target', 'virtual-screen', '--text-only']);
    const screen = String(rec.data?.text ?? '');
    if (/保存|不保存|另存为|Don't Save/i.test(screen)) {
      console.log('出现保存对话框 -> 选择「不保存」');
      const btn = await call('screen.find', ['--text', '不保存', '--target', 'virtual-screen']);
      const m = btn.data?.matches?.[0];
      if (m) {
        await call('mouse.click', ['--point', `${m.center[0]},${m.center[1]}`, '--button', 'left']);
        await sleep(1500);
      } else {
        await call('keyboard.hotkey', ['alt', 'n']);
        await sleep(1500);
      }
    } else {
      console.log('无保存对话框');
    }
  } else {
    console.log('激活未生效，跳过关闭以避免误伤其它窗口');
  }

  // 5. Verify.
  await sleep(600);
  const final = await call('window.list-visible');
  const titles = (final.data?.windows ?? []).map((w) => w.title).filter(Boolean);
  console.log('');
  console.log('当前可见窗口:');
  for (const t of titles) console.log(`  - ${t}`);
  console.log('');
  console.log(`记事本已关闭: ${titles.some((t) => /Notepad|记事本/i.test(t)) ? '❌ 仍开着' : '✅ 已关闭'}`);
}

