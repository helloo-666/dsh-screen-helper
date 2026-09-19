/**
 * End-to-end check against the real ScreenAutomationHelper executable.
 *
 * Skipped (not failed) when the helper is not installed, so the suite stays
 * green on a machine that only wants to build the plugin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { runCli } from '../lib/cli.js';

const CLI = process.env.SAH_CLI ?? 'D:\\ScreenAutomationHelper\\ScreenAutomationHelper.exe';
const available = existsSync(CLI);

test('reads helper status as JSON', { skip: !available }, async () => {
  const out = await runCli({
    cliPath: CLI,
    invocation: { path: ['status'] },
    timeoutMs: 60_000,
  });
  assert.equal(out.ok, true, out.ok ? '' : out.message);
  assert.equal(typeof out.json, 'object');
  assert.ok(out.json, 'expected a JSON envelope');
});

test('reports a usage error instead of throwing', { skip: !available }, async () => {
  const out = await runCli({
    cliPath: CLI,
    invocation: { path: ['definitely-not-a-command'] },
    timeoutMs: 60_000,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NONZERO_EXIT');
  assert.equal(out.exitCode, 2);
});

test('reports a spawn failure for a missing executable', async () => {
  const out = await runCli({
    cliPath: 'D:\\does\\not\\exist\\nope.exe',
    invocation: { path: ['status'] },
    timeoutMs: 10_000,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'SPAWN_FAILED');
});

test('honors the timeout budget', { skip: !available }, async () => {
  // 1 ms is far below process startup, so this must trip the timer.
  const out = await runCli({
    cliPath: CLI,
    invocation: { path: ['status'] },
    timeoutMs: 1,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'TIMEOUT');
});

test('passes metacharacters through as literal argv', { skip: !available }, async () => {
  // If this were shell-interpreted the process would fail differently; the
  // helper should simply reject the unknown subcommand (exit 2).
  const out = await runCli({
    cliPath: CLI,
    invocation: { path: ['echo; rm -rf /'] },
    timeoutMs: 60_000,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NONZERO_EXIT');
});
