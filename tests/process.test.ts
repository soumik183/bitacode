import test from 'node:test';
import assert from 'node:assert/strict';
import { startProcess, pollProcess, writeProcessStdin, stopProcess } from '../src/tools/process.js';
import { setApprovalHandler } from '../src/utils/approval.js';

setApprovalHandler(async () => 'approve_once');

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function extractId(result: string): string {
  const match = result.match(/proc-\d+/);
  assert.ok(match, `no process id in: ${result}`);
  return match[0];
}

// The status line echoes the command, which may itself contain the words we
// are looking for (e.g. 'one'/'two'). Assert against the output section only.
function outputOf(result: string): string {
  const out = result.split('output:\n')[1] ?? '';
  return out === '(no new output)' ? '' : out;
}

// Child startup time varies by platform; poll until the expected output (or
// exit status) appears instead of relying on a single fixed sleep. Accumulate
// every chunk seen so output that arrived in an earlier poll is not lost.
async function pollUntil(
  id: string,
  done: (result: string, output: string) => boolean,
  timeoutMs = 2000,
): Promise<{ result: string; output: string }> {
  const deadline = Date.now() + timeoutMs;
  let output = '';
  let result = '';
  do {
    result = pollProcess(id);
    output += outputOf(result);
    if (done(result, output)) break;
    await delay(25);
  } while (Date.now() < deadline);
  return { result, output };
}

test('startProcess keeps a child alive and pollProcess returns its output and exit code', async () => {
  // `echo` is a shell builtin — avoids depending on slow `node` startup when
  // the full suite runs many test files in parallel on a constrained device.
  const started = await startProcess('echo hello');
  assert.match(started, /Started process proc-\d+/);
  const id = extractId(started);

  const { result, output } = await pollUntil(id, (r) => /exited \(code 0/.test(r), 10000);
  assert.match(output, /hello/);
  assert.match(result, /exited \(code 0/);
});

test('pollProcess returns only output produced since the last poll', async () => {
  // `cat` echoes only what we write, so output timing is fully controlled —
  // no reliance on child startup time or setTimeout scheduling.
  const started = await startProcess('cat');
  const id = extractId(started);

  try {
    await writeProcessStdin(id, 'one\n');
    const first = await pollUntil(id, (_r, out) => /one/.test(out), 3000);
    assert.match(first.output, /one/);
    assert.match(first.result, /running/);

    await writeProcessStdin(id, 'two\n');
    const second = await pollUntil(id, (_r, out) => /two/.test(out), 3000);
    assert.match(second.output, /two/);
    assert.doesNotMatch(second.output, /one/, 'a poll returns only new output');
  } finally {
    stopProcess(id);
  }
});

test('writeProcessStdin writes to a running process', async () => {
  const started = await startProcess('cat');
  const id = extractId(started);

  try {
    assert.match(writeProcessStdin(id, 'ping\n'), /Wrote 5 chars/);
    const { output } = await pollUntil(id, (_r, out) => /ping/.test(out), 1000);
    assert.match(output, /ping/);
  } finally {
    stopProcess(id);
  }
});

test('stopProcess stops a process and removes it from the map', async () => {
  const started = await startProcess('node -e "setInterval(() => {}, 1000)"');
  const id = extractId(started);
  assert.match(stopProcess(id), /Sent stop signal/);
  assert.match(stopProcess(id), /unknown process id/);
});

test('startProcess honours approval rejection for non-safe commands', async () => {
  setApprovalHandler(async () => 'reject');
  try {
    const result = await startProcess('node -e "console.log(\'nope\')"');
    assert.match(result, /cancelled by user/i);
  } finally {
    setApprovalHandler(async () => 'approve_once');
  }
});

test('process tools report unknown ids clearly', () => {
  assert.match(pollProcess('proc-missing'), /unknown process id/i);
  assert.match(writeProcessStdin('proc-missing', 'x'), /unknown process id/i);
  assert.match(stopProcess('proc-missing'), /unknown process id/i);
});

// ── Regression: the process tools share bash's gate ─────────────────────────
// `start_process` used to check a command prefix only, then spawn through a
// shell, so `cat /etc/hostname` ran with no approval and no path check.

test('startProcess refuses paths outside the working directory', async () => {
  const result = await startProcess('cat /etc/hostname');
  assert.match(result, /blocked/i);
  assert.match(result, /outside the allowed working directory/i);
});

test('startProcess refuses a command word that points outside the sandbox', async () => {
  const result = await startProcess('/usr/bin/env');
  assert.match(result, /blocked|outside/i);
});

test('startProcess hard-blocks dangerous commands even with approval', async () => {
  const result = await startProcess('mkfs.ext4 /dev/sda');
  assert.match(result, /blocked for safety/i);
});

test('startProcess validates its cwd like bash does', async () => {
  const result = await startProcess('sleep 0.1', undefined, '/etc');
  assert.match(result, /Invalid working directory|outside/i);
});
