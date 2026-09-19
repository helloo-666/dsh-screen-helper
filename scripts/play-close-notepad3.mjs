/**
 * Close the stray Notepad — using the complete, correct contract.
 *
 * The missing link discovered by reading the CLI's own state: `task.begin`
 * persists a "confirmed screen task target" to
 *   C:\Users\Hello\Xiaozs\ScreenAutomationHelper\agent_screen_task.json
 * and `window.activate` refuses to act until that confirmed target exists
 * ("当前没有已确认的屏幕任务目标"). So the contract is:
 *
 *   task.begin (bind + persist)  ->  window.activate  ->  keyboard
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
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'close3' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wins = await call('window.list-visible');
const target = (wins.data?.windows ?? []).find((w) => /Notepad|记事本/i.test(String(w.title ?? '')));

if (!target) {
  console.log('没有记事本窗口');
} else {
  console.log(`目标: "${target.title}"  pid=${target.process_id}`);

  // 1. Bind and persist the confirmed task target.
  const begin = await call('task.begin', ['--handle', String(target.handle)]);
  console.log(`task.begin: status=${begin.data?.status}  target_id=${begin.data?.target?.target_id}`);
  console.log(`  状态文件: ${begin.data?.state_path}`);

  // 2. Activate it — now legitimate, because a confirmed target exists.
  const act = await call('window.activate');
  console.log(`window.activate: ${JSON.stringify(act.data).slice(0, 120)}`);
  await sleep(1200);

  const fg = await call('window.foreground');
  console.log(`前台: "${fg.data?.title}"  pid=${fg.data?.process_id}`);

  const isTarget = String(fg.data?.process_id) === String(target.process_id);
  console.log(`前台是我们的目标: ${isTarget ? '✅' : '❌'}`);

  if (isTarget) {
    // 3. Close.
    await call('keyboard.hotkey', ['alt', 'f4']);
    await sleep(1800);

    // 4. Save prompt?
    const rec = await call('screen.recognize', ['--target', 'virtual-screen', '--text-only']);
    const screen = String(rec.data?.text ?? '');
    if (/保存|不保存|另存为|Don't Save/i.test(screen)) {
      console.log('出现保存对话框 -> 选择「不保存」');
      const btn = await call('screen.find', ['--text', '不保存', '--target', 'virtual-screen']);
      const m = btn.data?.matches?.[0];
      if (m) {
        await call('mouse.click', ['--point', `${m.center[0]},${m.center[1]}`, '--button', 'left']);
      } else {
        await call('keyboard.hotkey', ['alt', 'n']);
      }
      await sleep(1600);
    } else {
      console.log('无保存对话框（直接关闭）');
    }
  } else {
    console.log('激活未生效，不发送关闭键以避免误伤');
  }

  // 5. Verify.
  await sleep(700);
  const final = await call('window.list-visible');
  const titles = (final.data?.windows ?? []).map((w) => w.title).filter(Boolean);
  console.log('');
  console.log('当前可见窗口:');
  for (const t of titles) console.log(`  - ${t}`);
  console.log('');
  console.log(`记事本已关闭: ${titles.some((t) => /Notepad|记事本/i.test(t)) ? '❌ 仍开着' : '✅ 已关闭'}`);
}

