import test from 'node:test';
import assert from 'node:assert/strict';
import { runBash } from '../src/tools/bash.js';
import { clearApprovalHandler, clearSessionApprovals, setApprovalHandler } from '../src/utils/approval.js';

const posixOnly = process.platform === 'win32' ? { skip: 'requires a POSIX shell' } : {};

test.afterEach(() => {
  clearApprovalHandler();
  clearSessionApprovals();
});

test('bash blocks catastrophic commands before approval', async () => {
  const result = await runBash('rm -rf /');

  assert.match(result, /blocked for safety/);
});

test('bash runs safe commands without approval', posixOnly, async () => {
  const result = await runBash('pwd');

  assert.equal(result.trim(), process.cwd());
});

test('bash reports a non-zero exit code', posixOnly, async () => {
  const result = await runBash('type __bitacode_missing_command__', 5_000);

  assert.match(result, /Command exited with code/);
});

test('bash does not hang on commands that read stdin', posixOnly, async () => {
  const result = await runBash('cat', 5_000);

  assert.match(result, /completed successfully with no output/);
});

test('bash timeout stops the command and its children', posixOnly, async () => {
  setApprovalHandler(async () => 'approve_once');
  const started = performance.now();

  const result = await runBash('sleep 30', 1_000);

  assert.match(result, /timed out after 1s/);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 10_000, `timed out command should not run to completion (${Math.round(elapsed)}ms)`);
});

test('bash abort stops the command', posixOnly, async () => {
  setApprovalHandler(async () => 'approve_once');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = performance.now();

  const result = await runBash('sleep 30', 30_000, undefined, controller.signal);

  assert.match(result, /aborted by user/);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 10_000, `aborted command should stop promptly (${Math.round(elapsed)}ms)`);
});

test('bash caps huge output and says how much was dropped', posixOnly, async () => {
  setApprovalHandler(async () => 'approve_once');

  const result = await runBash('node -e "process.stdout.write(\'x\'.repeat(60000))"', 10_000);

  assert.match(result, /output truncated, 60000 chars total/);
  assert.ok(result.length < 60_000, 'result should be trimmed before it reaches the model');
});
