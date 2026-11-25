import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  startBackgroundJob,
  getBackgroundJob,
  listBackgroundJobs,
  pollBackgroundJob,
  stopBackgroundJob,
  stopAllBackgroundJobs,
  formatTaskNotification,
  type BackgroundJob,
} from '../src/utils/background-jobs.js';

/** Poll with short waits so tests stay fast without fixed long sleeps. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise<void>((done) => setTimeout(done, 10));
  }
  return predicate();
}

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

const skipIntegration = typeof spawn === 'function' ? false : 'child_process.spawn unavailable';

/* -------------------------------------------------------------------------- */
/* validation / failure paths                                                 */
/* -------------------------------------------------------------------------- */

test('startBackgroundJob refuses empty commands and malformed options', () => {
  const empty = startBackgroundJob({ command: '   \t' });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.error, /non-empty/i);

  const missing = startBackgroundJob({} as { command: string });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /non-empty/i);

  const nonsense = startBackgroundJob(undefined as unknown as { command: string });
  assert.equal(nonsense.ok, false);
  if (!nonsense.ok) assert.match(nonsense.error, /options must be an object/i);
});

test('validate gate blocks jobs with a reason, false, or a thrown error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bitacode-bg-gate-'));
  try {
    const seen: Array<[string, string]> = [];
    const refused = startBackgroundJob({
      command: 'echo nope',
      cwd: dir,
      logPath: join(dir, 'refused.log'),
      validate(command, cwd) {
        seen.push([command, cwd]);
        return 'policy says no';
      },
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.error, /refused by validate: policy says no/);
    assert.deepEqual(seen, [['echo nope', resolve(dir)]]);
    assert.equal(existsSync(join(dir, 'refused.log')), false, 'refused jobs must not create logs');

    const falsy = startBackgroundJob({ command: 'echo nope', cwd: dir, validate: () => false });
    assert.equal(falsy.ok, false);
    if (!falsy.ok) assert.match(falsy.error, /refused by validate/i);

    const thrown = startBackgroundJob({
      command: 'echo nope',
      cwd: dir,
      validate: () => {
        throw new Error('gate exploded');
      },
    });
    assert.equal(thrown.ok, false);
    if (!thrown.ok) assert.match(thrown.error, /gate exploded/);

    const badGate = startBackgroundJob({
      command: 'echo nope',
      cwd: dir,
      validate: 'not a function' as unknown as () => boolean,
    });
    assert.equal(badGate.ok, false);
    if (!badGate.ok) assert.match(badGate.error, /validate must be a function/i);
  } finally {
    stopAllBackgroundJobs();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startBackgroundJob rejects a missing cwd and a file used as cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bitacode-bg-cwd-'));
  try {
    const missing = startBackgroundJob({ command: 'echo hi', cwd: join(dir, 'absent') });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /Invalid cwd/);

    const filePath = join(dir, 'a-file.txt');
    writeFileSync(filePath, 'not a directory');
    const wrongType = startBackgroundJob({ command: 'echo hi', cwd: filePath });
    assert.equal(wrongType.ok, false);
    if (!wrongType.ok) assert.match(wrongType.error, /Invalid cwd/);
  } finally {
    stopAllBackgroundJobs();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get/poll/stop report unknown ids', () => {
  assert.equal(getBackgroundJob('bg-does-not-exist'), undefined);
  const polled = pollBackgroundJob('bg-does-not-exist');
  assert.equal(polled.ok, false);
  if (!polled.ok) assert.match(polled.error, /Unknown background job/);
  const stopped = stopBackgroundJob('bg-does-not-exist');
  assert.equal(stopped.ok, false);
  if (!stopped.ok) assert.match(stopped.error, /Unknown background job/);
});

/* -------------------------------------------------------------------------- */
/* notification formatting                                                    */
/* -------------------------------------------------------------------------- */

test('formatTaskNotification escapes XML-significant text and stays compact', () => {
  const job: BackgroundJob = {
    id: 'bg-abc123',
    command: 'echo "<a&b>"',
    cwd: '/tmp',
    logPath: '/tmp/bg.log',
    startedAt: 1,
    endedAt: 2,
    status: 'failed',
    exitCode: 7,
    summary: 'first <tag> & "quotes"\nsecond\tline',
  };
  const text = formatTaskNotification(job);
  assert.match(text, /^<task-notification id="bg-abc123" status="failed" exit-code="7">/);
  assert.match(text, /<\/task-notification>$/);
  assert.ok(text.includes('<command>echo &quot;&lt;a&amp;b&gt;&quot;</command>'));
  assert.ok(text.includes('<summary>first &lt;tag&gt; &amp; &quot;quotes&quot; second line</summary>'));
  assert.equal(text.split('\n').length, 4);
  assert.ok(!text.includes('<tag>'));
});

test('formatTaskNotification marks a running job with an unknown exit code', () => {
  const text = formatTaskNotification({
    id: 'bg-running',
    command: 'sleep 1',
    cwd: '/tmp',
    logPath: '/tmp/bg.log',
    startedAt: 1,
    status: 'running',
    summary: "it's <still> running",
  });
  assert.match(text, /status="running" exit-code="unknown"/);
  assert.ok(text.includes('it&apos;s &lt;still&gt; running'));
});

/* -------------------------------------------------------------------------- */
/* integration (short-lived `node -e` processes)                              */
/* -------------------------------------------------------------------------- */

test('completed job logs output, summarises it and reports done', { skip: skipIntegration }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bitacode-bg-ok-'));
  t.after(() => {
    stopAllBackgroundJobs();
    rmSync(dir, { recursive: true, force: true });
  });

  const script = "process.stdout.write('hello stdout\\n'); process.stderr.write('hello stderr\\n');";
  const started = startBackgroundJob({
    command: nodeCommand(script),
    cwd: dir,
    logPath: join(dir, 'job.log'),
    summaryChars: 200,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const job = started.value;

  assert.match(job.id, /^bg-[0-9a-f]{12}$/);
  assert.equal(job.status, 'running');
  assert.equal(getBackgroundJob(job.id)?.id, job.id);
  assert.ok(listBackgroundJobs().some((item) => item.id === job.id));
  assert.ok(
    await waitFor(() => {
      const polled = pollBackgroundJob(job.id);
      return polled.ok && polled.value.status !== 'running';
    })
  );

  const finished = pollBackgroundJob(job.id);
  assert.equal(finished.ok, true);
  if (!finished.ok) return;
  assert.equal(finished.value.status, 'done');
  assert.equal(finished.value.exitCode, 0);
  assert.ok(finished.value.endedAt && finished.value.endedAt >= job.startedAt);
  assert.match(finished.value.summary ?? '', /hello stdout/);
  assert.match(finished.value.summary ?? '', /hello stderr/);

  const logged = readFileSync(job.logPath, 'utf8');
  assert.match(logged, /hello stdout/);
  assert.match(logged, /hello stderr/);

  const notification = formatTaskNotification(finished.value);
  assert.match(notification, /status="done" exit-code="0"/);
  assert.match(notification, /hello stdout/);
});

test('non-zero exit becomes a failed job with its exit code', { skip: skipIntegration }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bitacode-bg-fail-'));
  t.after(() => {
    stopAllBackgroundJobs();
    rmSync(dir, { recursive: true, force: true });
  });

  const started = startBackgroundJob({
    command: nodeCommand("process.stderr.write('boom\\n'); process.exit(3);"),
    cwd: dir,
    logPath: join(dir, 'fail.log'),
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  assert.ok(
    await waitFor(() => {
      const polled = pollBackgroundJob(started.value.id);
      return polled.ok && polled.value.status !== 'running';
    })
  );
  const failed = pollBackgroundJob(started.value.id);
  assert.ok(failed.ok);
  if (!failed.ok) return;
  assert.equal(failed.value.status, 'failed');
  assert.equal(failed.value.exitCode, 3);
  assert.match(failed.value.summary ?? '', /boom/);
  assert.match(formatTaskNotification(failed.value), /status="failed" exit-code="3"/);
});

test('log writes are hard-capped and the summary keeps only its tail', { skip: skipIntegration }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bitacode-bg-cap-'));
  t.after(() => {
    stopAllBackgroundJobs();
    rmSync(dir, { recursive: true, force: true });
  });

  const started = startBackgroundJob({
    command: nodeCommand("process.stdout.write('x'.repeat(5000));"),
    cwd: dir,
    logPath: join(dir, 'capped.log'),
    maxLogBytes: 64,
    summaryChars: 20,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  assert.ok(
    await waitFor(() => {
      const polled = pollBackgroundJob(started.value.id);
      return polled.ok && polled.value.status !== 'running';
    })
  );
  assert.ok(statSync(started.value.logPath).size <= 64, 'log exceeded maxLogBytes');
  const finished = pollBackgroundJob(started.value.id);
  assert.ok(finished.ok);
  if (!finished.ok) return;
  assert.equal(finished.value.summary, 'x'.repeat(20));
});

test('stop is idempotent and snapshots cannot mutate registry state', { skip: skipIntegration }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bitacode-bg-stop-'));
  t.after(() => {
    stopAllBackgroundJobs();
    rmSync(dir, { recursive: true, force: true });
  });

  const started = startBackgroundJob({
    command: nodeCommand('setInterval(() => {}, 1000);'),
    cwd: dir,
    logPath: join(dir, 'stop.log'),
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  const stopped = stopBackgroundJob(started.value.id);
  assert.equal(stopped.ok, true);
  if (!stopped.ok) return;
  assert.equal(stopped.value.status, 'stopped');
  assert.ok(stopped.value.endedAt);

  const snapshot = getBackgroundJob(started.value.id);
  assert.ok(snapshot);
  snapshot.status = 'failed';
  assert.equal(getBackgroundJob(started.value.id)?.status, 'stopped');

  const again = stopBackgroundJob(started.value.id);
  assert.ok(again.ok);
  if (again.ok) assert.equal(again.value.status, 'stopped');
  assert.equal(stopAllBackgroundJobs(), 0, 'stopAll is safe to call repeatedly');
});

test('default log location honours XDG_DATA_HOME with private permissions', { skip: skipIntegration }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bitacode-bg-xdg-'));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
    stopAllBackgroundJobs();
    rmSync(dir, { recursive: true, force: true });
  });

  const started = startBackgroundJob({ command: nodeCommand('') });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const job = started.value;

  assert.ok(job.logPath.startsWith(join(dir, 'bitacode', 'background')));
  assert.ok(
    await waitFor(() => {
      const polled = pollBackgroundJob(job.id);
      return polled.ok && polled.value.status !== 'running';
    })
  );
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(dir, 'bitacode', 'background')).mode & 0o777, 0o700);
    assert.equal(statSync(job.logPath).mode & 0o777, 0o600);
  }
});
