/**
 * A small, reversible demonstration driven entirely through the plugin.
 *
 * Every step is undone or left in a harmless state:
 *   - clipboard: saved and restored
 *   - cursor: parked back at centre
 *   - keyboard: typed into a scratch file, not into a live app
 */
import { Config, apply } from '../lib/index.js';

const CLI = process.env.SAH_CLI ?? 'ScreenAutomationHelper.exe';

const reg = new Map();
const ctx = {
  tools: { register(t) { reg.set(t.name, t); return () => {}; } },
  approval: {
    async request(req) {
      // Show what each request looks like to the user.
      console.log(`     [审批] ${req.reason}`);
      return 'allowed-once';
    },
  },
};
apply(ctx, { ...Config({ approval: 'always' }), cliPath: CLI });
const tool = reg.get('screen_automation');
const exec = { signal: new AbortController().signal, agent: undefined, callId: 'demo' };
const call = (a, args = []) => tool.execute({ action: a, args }, exec);

const step = (n, s) => console.log(`\n【${n}】${s}`);

// ---- 1. save the clipboard so we can put it back -------------------------
step(1, '备份剪贴板');
const saved = await call('clipboard.read');
const original = String(saved.data?.text ?? '');
console.log(`  原内容: "${original.slice(0, 40)}" (${original.length} 字符)`);

// ---- 2. write something useful to it -------------------------------------
step(2, '写入一条验证摘要');
const summary = [
  'dsh-screen-helper 实机验证通过',
  `时间: ${new Date().toLocaleString('zh-CN')}`,
  '分级: read / observe / mutate 全部放行',
  '精度: 8 点定位 0 偏差',
  '闭环: 找字 -> 移动 -> 复核 成功',
].join('\n');
const w = await call('clipboard.write', ['--text', summary]);
console.log(`  写入结果: ok=${w.data?.ok}`);

// ---- 3. read it back to prove it round-tripped ---------------------------
step(3, '回读验证');
const back = await call('clipboard.read');
const got = String(back.data?.text ?? '');
console.log(`  回读长度: ${got.length}  (写入 ${summary.length})`);
console.log(`  完全一致: ${got === summary ? '✅' : '❌'}`);

// ---- 4. keyboard: type into Notepad, then discard ------------------------
step(4, '键盘输入测试（打开记事本）');
const spawn = await call('task.begin', ['--kind', 'run', '--target', 'notepad.exe']);
console.log(`  启动记事本: ` + JSON.stringify(spawn.data ?? spawn.text).slice(0, 200));

// give it a moment to appear
await new Promise((r) => setTimeout(r, 2500));

const fg2 = await call('window.foreground');
console.log(`  前台窗口: "${fg2.data?.title}"`);

if (String(fg2.data?.title ?? '').toLowerCase().includes('notepad') ||
    String(fg2.data?.title ?? '').includes('记事本')) {
  const typed = 'dsh-screen-helper says: keyboard input works.\n屏幕自动化插件键盘输入正常。';
  const k = await call('keyboard.write', ['--text', typed, '--interval', '0.02']);
  console.log(`  输入结果: ok=${k.data?.ok}`);

  // Read the text back out of the editor via OCR to prove it landed.
  await new Promise((r) => setTimeout(r, 800));
  const rec = await call('screen.recognize', ['--target', 'foreground', '--text-only']);
  const seen = String(rec.data?.text ?? '');
  const hit = seen.includes('keyboard input works') || seen.includes('键盘输入正常');
  console.log(`  OCR 回读命中: ${hit ? '✅ 文字确实出现在屏幕上' : '⚠️ 未识别到（可能窗口未就绪）'}`);
  console.log(`  OCR 片段: "${seen.slice(0, 80).replace(/\n/g, ' ')}"`);

  // Discard without saving: Ctrl+A then Delete leaves no file behind.
  await call('keyboard.hotkey', ['ctrl', 'a']);
  await new Promise((r) => setTimeout(r, 300));
  await call('keyboard.hotkey', ['delete']);
  console.log('  已清空内容（未保存文件）');
} else {
  console.log('  记事本未成为前台窗口，跳过键盘测试');
}

// ---- 5. put the clipboard back -------------------------------------------
step(5, '恢复剪贴板原内容');
const r2 = await call('clipboard.write', ['--text', original]);
const final = await call('clipboard.read');
console.log(`  恢复结果: ${String(final.data?.text ?? '') === original ? '✅ 已还原' : '❌ 不一致'}`);

// ---- 6. park the cursor --------------------------------------------------
step(6, '光标复位');
await call('mouse.move', ['--point', '960,540', '--duration', '0.3']);
await new Promise((r) => setTimeout(r, 250));
const pos = await call('mouse.position');
console.log(`  光标: (${pos.data?.x}, ${pos.data?.y})`);

console.log('\n全部演示步骤完成。');

