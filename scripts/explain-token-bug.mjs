/**
 * Demonstrates the approval-token bug and its fix side by side.
 *
 * The buggy comparison mirrors the original code: it tested for `'approved'`,
 * a string that does not exist in dsh's vocabulary, so even a user clicking
 * "allow" produced a denial. This script runs both predicates over the same
 * real outcome set to show exactly what each one decided.
 */

// The vocabulary dsh actually normalizes to (dsh-user-approval, OUTCOMES).
const REAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];

// What a user clicking "allow" / "deny" in the UI actually produces.
const USER_CLICKS = [
  ['用户点「允许」', 'allowed-once'],
  ['用户点「拒绝」', 'rejected'],
  ['用户取消', 'cancelled'],
  ['没有应答器', 'unavailable'],
];

// The original, broken predicate.
const buggy = (d) => d === 'approved';
// The corrected predicate.
const fixed = (d) => d === 'allowed-once';

const pad = (s, n) => String(s).padEnd(n);
const cjk = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)));

console.log('令牌词汇表（dsh 实际返回的）: ' + REAL_OUTCOMES.join(' | '));
console.log('');
console.log(cjk('用户操作', 16) + cjk('实际令牌', 16) + cjk('旧代码判断', 14) + cjk('结果', 10) + '新代码判断');
console.log('-'.repeat(78));

for (const [label, token] of USER_CLICKS) {
  const oldVerdict = buggy(token) ? '放行' : '拒绝';
  const newVerdict = fixed(token) ? '放行' : '拒绝';
  const oldMark = oldVerdict === '放行' ? '✅' : '⛔';
  const newMark = newVerdict === '放行' ? '✅' : '⛔';
  // Correct behaviour: only `allowed-once` should ever be a grant.
  const shouldGrant = token === 'allowed-once';
  const oldRight = (oldVerdict === '放行') === shouldGrant;
  const newRight = (newVerdict === '放行') === shouldGrant;
  console.log(
    cjk(label, 16) + cjk(token, 16) +
    cjk(`${oldMark} ${oldVerdict}`, 14) +
    cjk(oldRight ? '正确' : '❌ 错误', 10) +
    `${newMark} ${newVerdict} ${newRight ? '正确' : '❌ 错误'}`,
  );
}

console.log('');
console.log('结论: 旧代码在所有情况下都拒绝 —— 用户点「允许」也进不去。');
console.log('      新代码只在真实授权令牌下放行，其余一律拒绝。');
console.log('');
console.log('=== 关键点：为什么"看起来对"的判断反而全错 ===');
console.log('旧代码问的是「结果是不是 approved？」');
console.log('但 dsh 的词汇表里压根没有 approved 这个词，');
console.log('所以答案永远是「不是」→ 永远拒绝。');
console.log('');
console.log('正确的问法是「结果是不是那个唯一的授权词 allowed-once？」');
console.log('这样即使 dsh 未来新增令牌，未知值也会落到「拒绝」侧 —— 保持 fail-closed。');
