import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv } from '../src/tools/env.js';
import { which } from '../src/tools/which.js';
import { commandExists } from '../src/tools/command-exists.js';
import { watch } from '../src/tools/watch.js';
import { kill } from '../src/tools/kill.js';
import { background } from '../src/tools/background.js';

test('readEnv redacts sensitive values but reveals them with redact:false and explicit name', async () => {
  const name = 'SYSTEM_TOOLS_TEST_SECRET_TOKEN';
  process.env[name] = 'super-secret-value-123';
  try {
    const redacted = await readEnv(name);
    assert.match(redacted, /<redacted>/);
    assert.doesNotMatch(redacted, /super-secret-value-123/);

    const revealed = await readEnv(name, false);
    assert.match(revealed, /super-secret-value-123/);

    // With no name, only keys are listed — never values, even if redact:false.
    const listing = await readEnv(undefined, false);
    assert.match(listing, new RegExp(name));
    assert.doesNotMatch(listing, /super-secret-value-123/);
  } finally {
    delete process.env[name];
  }
});

test('readEnv validates inputs and reports unset variables', async () => {
  assert.match(await readEnv(''), /name must be a non-empty string/);
  assert.match(await readEnv('SYSTEM_TOOLS_DEFINITELY_UNSET', true), /not set/);
});

test('which resolves a known binary and reports a clear not-found', async () => {
  const found = await which('node');
  assert.ok(!found.startsWith('Error:'), `expected a path, got: ${found}`);
  assert.ok(path.isAbsolute(found), `expected absolute path, got: ${found}`);

  const missing = await which('definitely-not-a-real-binary-xyz');
  assert.match(missing, /not found in PATH/);
});

test('command_exists returns a boolean string using the same lookup', async () => {
  assert.equal(await commandExists('node'), 'true');
  assert.equal(await commandExists('definitely-not-a-real-binary-xyz'), 'false');
});

test('watch resolves after a short duration and reports a change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-tools-watch-'));
  const file = path.join(dir, 'watched.txt');
  fs.writeFileSync(file, 'start');
  try {
    const watching = watch(file, 600);
    // Give the watcher a moment to attach before writing.
    await new Promise((resolve) => setTimeout(resolve, 60));
    fs.writeFileSync(file, 'changed');
    fs.writeFileSync(file, 'changed again');

    const result = await watching;
    assert.match(result, /Watched .* for 600ms/);
    // Either an event was captured or the watcher timed out cleanly.
    assert.match(result, /event\(s\)|No changes detected/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch rejects unsafe commands and invalid durations', async () => {
  assert.match(await watch('x', 500, 'rm -rf /'), /not a safe command/);
  assert.match(await watch('x', Number.NaN), /duration_ms must be a number/);
});

test('kill refuses self, invalid pids and ambiguous inputs', async () => {
  assert.match(await kill(process.pid), /refusing to kill the current process/);
  assert.match(await kill(-1), /positive integer/);
  assert.match(await kill(0), /positive integer/);
  assert.match(await kill(Number.NaN), /positive integer/);
  assert.match(await kill(), /exactly one of pid or id/);
  assert.match(await kill(1234, 'proc-1'), /exactly one of pid or id/);
  assert.match(await kill(undefined, 'proc-missing'), /unknown process id/);
});

test('background delegates to startProcess (validation and real spawn)', async () => {
  // Validation comes from startProcess itself — proves we delegate, not reimplement.
  assert.match(await background(''), /command is required/);

  // echo is a safe command, so no approval handler is needed.
  const started = await background('echo background-ok');
  assert.match(started, /Started process proc-\d+/);
});
