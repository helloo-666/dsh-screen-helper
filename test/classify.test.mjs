/** Unit tests for risk classification and CLI helpers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSafeArgs,
  classify,
  findExact,
  isDestructive,
  resolveCliPath,
  tryParseJson,
} from '../lib/cli.js';

test('classifies pure bookkeeping reads as read', () => {
  for (const path of [
    ['status'],
    ['capabilities'],
    ['health'],
    ['workflow', 'list'],
    ['runs', 'list'],
    ['latest'],
  ]) {
    assert.equal(classify(path), 'read', `${path.join(' ')} should be read`);
  }
});

test('classifies screen and UI observation as observe', () => {
  for (const path of [
    ['screen', 'capture'],
    ['screen', 'recognize'],
    ['ui', 'tree'],
    ['clipboard', 'read'],
  ]) {
    assert.equal(classify(path), 'observe', `${path.join(' ')} should be observe`);
  }
});

test('classifies input synthesis as mutate', () => {
  for (const path of [
    ['mouse', 'click'],
    ['keyboard', 'write'],
    ['keyboard', 'hotkey'],
    ['mouse', 'drag'],
    ['task', 'begin'],
    ['clipboard', 'write'],
  ]) {
    assert.equal(classify(path), 'mutate', `${path.join(' ')} should be mutate`);
  }
});

test('an unknown subcommand fails safe to mutate', () => {
  // A future CLI version adding a destructive command must not be silently
  // allowed just because this table predates it.
  assert.equal(classify(['some', 'future', 'command']), 'mutate');
  assert.equal(classify(['rm']), 'mutate');
});

test('longest-prefix matching keeps runs list readable', () => {
  assert.equal(classify(['runs', 'list']), 'read');
  assert.equal(classify(['runs', 'pause']), 'mutate');
});

test('flags destructive families', () => {
  assert.equal(isDestructive(['workflow', 'remove']), true);
  assert.equal(isDestructive(['workflow', 'install']), true);
  assert.equal(isDestructive(['clipboard', 'write']), true);
  assert.equal(isDestructive(['workflow', 'list']), false);
  assert.equal(isDestructive(['mouse', 'click']), false);
});

test('rejects NUL bytes in arguments', () => {
  assert.throws(() => assertSafeArgs(['ok', 'bad\0arg']), /NUL/);
  assert.doesNotThrow(() => assertSafeArgs(['--point', '10,20']));
});

test('accepts shell metacharacters as ordinary argument text', () => {
  // Because we spawn without a shell these are inert; the assertion documents
  // that they are deliberately NOT rejected here.
  assert.doesNotThrow(() => assertSafeArgs(['--text', 'a; rm -rf /']));
  assert.doesNotThrow(() => assertSafeArgs(['--text', '$(whoami)']));
});

test('parses JSON envelopes and ignores plain text', () => {
  assert.deepEqual(tryParseJson('{"ok":true}'), { ok: true });
  assert.deepEqual(tryParseJson('  [1,2]  '), [1, 2]);
  assert.equal(tryParseJson('usage: something'), undefined);
  assert.equal(tryParseJson(''), undefined);
});

test('resolveCliPath prefers an explicit configured path', () => {
  assert.equal(resolveCliPath('D:\\SAH\\x.exe'), 'D:\\SAH\\x.exe');
  assert.equal(resolveCliPath('   '), 'ScreenAutomationHelper.exe');
});

const ITEMS = [
  { text: '发消息或创建任务，@文件', confidence: 0.98, box: [518, 872, 805, 893], center: [661, 882] },
  { text: '文件', confidence: 0.99, box: [519, 874, 545, 890], center: [532, 882] },
  { text: '编辑', confidence: 0.97, box: [100, 100, 140, 120], center: [120, 110] },
];

test('findExact returns exact token box, not the enclosing line', () => {
  // Both the long line and the token contain "文件"; the exact token must rank
  // first and carry its own (small) box, not the line's big box.
  const r = findExact(ITEMS, '文件');
  assert.equal(r.count, 2);
  assert.equal(r.matches[0].text, '文件');
  // The precise token box, not the whole line box [518,872,805,893].
  assert.deepEqual(r.matches[0].box, [519, 874, 545, 890]);
});

test('findExact ranks an exact token above a containing token', () => {
  // Both "文件" (exact) and the long line (contains) match; exact must win.
  const r = findExact(ITEMS, '文件');
  assert.equal(r.matches[0].text, '文件');
  assert.notEqual(r.matches[0].text, '发消息或创建任务，@文件或对话');
});

test('findExact sorts by confidence within the same match rank', () => {
  const items = [
    { text: '保存', confidence: 0.5, box: [1, 1, 2, 2], center: [1, 1] },
    { text: '保存', confidence: 0.9, box: [3, 3, 4, 4], center: [3, 3] },
  ];
  const r = findExact(items, '保存');
  assert.equal(r.matches[0].confidence, 0.9);
});

test('findExact returns nothing for an empty query or empty items', () => {
  assert.equal(findExact(ITEMS, '   ').count, 0);
  assert.equal(findExact([], '文件').count, 0);
  assert.equal(findExact(null, '文件').count, 0);
});
