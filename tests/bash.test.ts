import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runBash } from '../src/tools/bash.js';
import { clearApprovalHandler, clearSessionApprovals, setApprovalHandler, setApprovalMode } from '../src/utils/approval.js';

const posixOnly = process.platform === 'win32' ? { skip: 'requires a POSIX shell' } : {};

test.afterEach(() => {
  clearApprovalHandler();
  clearSessionApprovals();
  setApprovalMode('manual');
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

test('bash blocks a dangerous command even in yolo mode', posixOnly, async () => {
  setApprovalMode('yolo');

  const result = await runBash('rm -rf /');

  assert.match(result, /blocked for safety/);
});

test('bash rejects a path outside the allowed roots in auto mode', posixOnly, async () => {
  setApprovalMode('auto');

  const result = await runBash('cat /etc/passwd');

  assert.match(result, /outside the allowed working directory/);
});

test('bash honors a valid cwd parameter', posixOnly, async () => {
  const subdir = path.join(process.cwd(), 'src');

  const result = await runBash('pwd', 5_000, undefined, undefined, subdir);

  assert.equal(result.trim(), fs.realpathSync(subdir));
});

test('bash rejects a cwd outside the allowed roots', posixOnly, async () => {
  const result = await runBash('pwd', 5_000, undefined, undefined, '/etc');

  assert.match(result, /Invalid working directory/);
});
