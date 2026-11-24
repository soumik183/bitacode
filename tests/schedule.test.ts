/**
 * Tests for the local schedule store: parsing, persistence, validation,
 * due-ordering and catch-up run marking. No timers or execution are involved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  addSchedule,
  dueTasks,
  loadSchedule,
  markRun,
  parseInterval,
  removeSchedule,
  saveSchedule,
  scheduleStorePath,
  type ScheduleResult,
  type ScheduledTask,
} from '../src/utils/schedule.js';

async function sandbox<T>(fn: (dataDir: string) => Promise<T> | T): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bitacode-schedule-'));
  try {
    return await fn(dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function unwrap<T>(result: ScheduleResult<T>): T {
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.value;
}

function task(id: string, nextRunAt: number, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    prompt: `prompt-${id}`,
    intervalMs: 60_000,
    nextRunAt,
    createdAt: 0,
    enabled: true,
    ...overrides,
  };
}

test('parseInterval accepts s/m/h/d, case-insensitively', () => {
  assert.equal(parseInterval('30s'), 30_000);
  assert.equal(parseInterval('15m'), 900_000);
  assert.equal(parseInterval('2h'), 7_200_000);
  assert.equal(parseInterval('1d'), 86_400_000);
  assert.equal(parseInterval('15M'), 900_000);
  assert.equal(parseInterval('2H'), 7_200_000);
  assert.equal(parseInterval('1D'), 86_400_000);
});

test('parseInterval enforces the 10s..30d range', () => {
  assert.equal(parseInterval('10s'), 10_000);
  assert.equal(parseInterval('30d'), 2_592_000_000);
  assert.equal(parseInterval('9s'), undefined);
  assert.equal(parseInterval('10000ms'), undefined);
  assert.equal(parseInterval('31d'), undefined);
});

test('parseInterval rejects malformed input and never throws', () => {
  for (const value of ['', 'abc', '15', '15x', '1.5h', '-5s', '1w', '0s', '  ', null, undefined, 42, {}]) {
    assert.equal(parseInterval(value as string), undefined, `input ${String(value)} rejected`);
  }
});

test('scheduleStorePath honors XDG_DATA_HOME and an explicit dataDir', () => {
  const saved = process.env.XDG_DATA_HOME;
  try {
    process.env.XDG_DATA_HOME = '/tmp/opencode-xdg-example';
    assert.equal(scheduleStorePath(), path.join('/tmp/opencode-xdg-example', 'bitacode', 'schedule.json'));
    assert.equal(
      scheduleStorePath({ dataDir: '/custom/data' }),
      path.join('/custom/data', 'bitacode', 'schedule.json'),
    );
    delete process.env.XDG_DATA_HOME;
    assert.equal(
      scheduleStorePath(),
      path.join(os.homedir(), '.local', 'share', 'bitacode', 'schedule.json'),
    );
  } finally {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
  }
});

test('saveSchedule round-trips tasks with private permissions', async () => {
  await sandbox(async (dataDir) => {
    const tasks = [task('a', 100), task('b', 200, { lastRunAt: 50, enabled: false })];
    assert.deepEqual(unwrap(await saveSchedule(tasks, { dataDir })), undefined);

    const file = scheduleStorePath({ dataDir });
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.deepEqual(unwrap(await loadSchedule({ dataDir })), tasks);

    // Mutating the caller's array or the loaded copies cannot affect the store.
    tasks[0].prompt = 'changed';
    const loaded = unwrap(await loadSchedule({ dataDir }));
    loaded[1].enabled = true;
    assert.deepEqual(unwrap(await loadSchedule({ dataDir })), [
      task('a', 100),
      task('b', 200, { lastRunAt: 50, enabled: false }),
    ]);
  });
});

test('loadSchedule treats a missing store as an empty schedule', async () => {
  await sandbox(async (dataDir) => {
    assert.deepEqual(unwrap(await loadSchedule({ dataDir })), []);
    assert.deepEqual(unwrap(await dueTasks({ dataDir, now: 1_000_000 })), []);
    await fs.access(path.dirname(scheduleStorePath({ dataDir }))).then(
      () => assert.fail('store directory should not be created by a read'),
      () => undefined,
    );
  });
});

test('a malformed JSON store errors and is never overwritten by addSchedule', async () => {
  await sandbox(async (dataDir) => {
    const file = scheduleStorePath({ dataDir });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{not json', 'utf8');

    assert.equal((await loadSchedule({ dataDir })).ok, false);
    assert.equal((await addSchedule('hello', 10_000, { dataDir })).ok, false);
    assert.equal((await dueTasks({ dataDir })).ok, false);
    assert.equal(await fs.readFile(file, 'utf8'), '{not json');
    assert.deepEqual(await fs.readdir(path.dirname(file)), ['schedule.json'], 'no temp files left behind');
  });
});

test('a structurally corrupt store errors and stays untouched', async () => {
  await sandbox(async (dataDir) => {
    const file = scheduleStorePath({ dataDir });
    await fs.mkdir(path.dirname(file), { recursive: true });
    for (const corrupt of ['{"tasks":[]}', '[{"id":"x"}]', '[{"id":"x","prompt":"p","intervalMs":1,"nextRunAt":0,"createdAt":0,"enabled":true}]']) {
      await fs.writeFile(file, corrupt, 'utf8');
      assert.equal((await loadSchedule({ dataDir })).ok, false, corrupt);
      assert.equal((await addSchedule('hello', 10_000, { dataDir })).ok, false, corrupt);
      assert.equal(await fs.readFile(file, 'utf8'), corrupt);
    }
  });
});

test('addSchedule validates prompts and strips control characters', async () => {
  await sandbox(async (dataDir) => {
    for (const prompt of ['', '   ', '\u0000', '\u0007', 'a'.repeat(4_001)]) {
      const result = await addSchedule(prompt, 10_000, { dataDir, now: 0 });
      assert.equal(result.ok, false, `prompt ${JSON.stringify(prompt.slice(0, 8))} rejected`);
    }
    const clean = unwrap(await addSchedule('check \u0007in', 10_000, { dataDir, now: 0 }));
    assert.equal(clean.prompt, 'check in');
    assert.equal((await fs.readdir(path.dirname(scheduleStorePath({ dataDir })))).length, 1);
  });
});

test('addSchedule rejects intervals outside 10s..30d', async () => {
  await sandbox(async (dataDir) => {
    for (const interval of [0, 9_999, 2_592_000_001, Number.NaN, Number.POSITIVE_INFINITY, 15_000.5, '10000', undefined]) {
      const result = await addSchedule('hello', interval as number, { dataDir, now: 0 });
      assert.equal(result.ok, false, `interval ${String(interval)} rejected`);
    }
    assert.equal((await loadSchedule({ dataDir })).ok, true);
    assert.deepEqual(unwrap(await loadSchedule({ dataDir })), []);
  });
});

test('addSchedule creates, persists and ids tasks uniquely', async () => {
  await sandbox(async (dataDir) => {
    const first = unwrap(await addSchedule('hello', 900_000, { dataDir, now: 1_000_000 }));
    assert.equal(first.prompt, 'hello');
    assert.equal(first.intervalMs, 900_000);
    assert.equal(first.createdAt, 1_000_000);
    assert.equal(first.nextRunAt, 1_900_000);
    assert.equal(first.enabled, true);
    assert.equal(first.lastRunAt, undefined);
    assert.match(first.id, /^[a-f0-9]{12}$/);

    const second = unwrap(await addSchedule('again', 10_000, { dataDir, now: 1_000_000 }));
    assert.notEqual(second.id, first.id);
    assert.deepEqual(unwrap(await loadSchedule({ dataDir })), [first, second]);
  });
});

test('dueTasks returns enabled, due tasks sorted by nextRunAt', async () => {
  await sandbox(async (dataDir) => {
    const tasks = [
      task('late-b', 100, { createdAt: 2 }),
      task('disabled', 50, { enabled: false }),
      task('future', 200),
      task('late-a', 100, { createdAt: 1 }),
    ];
    assert.ok((await saveSchedule(tasks, { dataDir })).ok);
    assert.deepEqual(unwrap(await dueTasks({ dataDir, now: 150 })).map((entry) => entry.id), ['late-a', 'late-b']);
    assert.deepEqual(unwrap(await dueTasks({ dataDir, now: 50 })), []);
  });
});

test('dueTasks does not mutate the store and returns defensive copies', async () => {
  await sandbox(async (dataDir) => {
    assert.ok((await saveSchedule([task('a', 100), task('b', 200)], { dataDir })).ok);
    const before = unwrap(await loadSchedule({ dataDir }));

    const due = unwrap(await dueTasks({ dataDir, now: 250 }));
    due[0].prompt = 'hacked';
    due.push(task('injected', 1));

    assert.deepEqual(unwrap(await loadSchedule({ dataDir })), before);
    assert.deepEqual(unwrap(await dueTasks({ dataDir, now: 250 })).map((entry) => entry.id), ['a', 'b']);
  });
});

test('markRun skips whole intervals after downtime (no burst)', async () => {
  await sandbox(async (dataDir) => {
    assert.ok((await saveSchedule([task('job', 1_000)], { dataDir })).ok);
    const now = 1_000 + 5 * 60_000 + 1;

    const marked = unwrap(await markRun('job', { dataDir, now }));
    assert.equal(marked.nextRunAt, 1_000 + 6 * 60_000);
    assert.equal(marked.lastRunAt, now);
    assert.deepEqual(unwrap(await loadSchedule({ dataDir })), [marked]);
    assert.deepEqual(unwrap(await dueTasks({ dataDir, now })), []);
    assert.equal(unwrap(await dueTasks({ dataDir, now: marked.nextRunAt })).length, 1);

    // An exact multiple also advances past `now`, never landing on it.
    const again = unwrap(await markRun('job', { dataDir, now: marked.nextRunAt + 4 * 60_000 }));
    assert.equal(again.nextRunAt, marked.nextRunAt + 5 * 60_000);
  });
});

test('markRun rejects unknown or invalid ids without changing the store', async () => {
  await sandbox(async (dataDir) => {
    const original = [task('job', 1_000)];
    assert.ok((await saveSchedule(original, { dataDir })).ok);
    assert.equal((await markRun('missing', { dataDir, now: 2_000 })).ok, false);
    assert.equal((await markRun('', { dataDir, now: 2_000 })).ok, false);
    assert.deepEqual(unwrap(await loadSchedule({ dataDir })), original);
  });
});

test('disabling and enabling a task changes dueTasks without other writes', async () => {
  await sandbox(async (dataDir) => {
    const original = task('x', 100);
    assert.ok((await saveSchedule([original], { dataDir })).ok);
    assert.equal(unwrap(await dueTasks({ dataDir, now: 200 })).length, 1);

    assert.ok((await saveSchedule([{ ...original, enabled: false }], { dataDir })).ok);
    assert.deepEqual(unwrap(await dueTasks({ dataDir, now: 200 })), []);

    assert.ok((await saveSchedule([{ ...original, enabled: true }], { dataDir })).ok);
    assert.deepEqual(unwrap(await dueTasks({ dataDir, now: 200 })), [original]);
  });
});

test('removeSchedule deletes a task and reports true only when something was removed', async () => {
  await sandbox(async (dataDir) => {
    const tasks = [task('a', 100), task('b', 200)];
    assert.ok((await saveSchedule(tasks, { dataDir })).ok);
    assert.equal(unwrap(await removeSchedule('a', { dataDir })), true);
    assert.deepEqual(unwrap(await loadSchedule({ dataDir })), [task('b', 200)]);
    assert.equal(unwrap(await removeSchedule('a', { dataDir })), false);
    assert.equal((await removeSchedule('', { dataDir })).ok, false, 'invalid id -> error');
  });
});

test('the store is capped at 100 tasks', async () => {
  await sandbox(async (dataDir) => {
    const tasks = Array.from({ length: 100 }, (_, index) => task(`t${index}`, index + 1));
    assert.ok((await saveSchedule(tasks, { dataDir })).ok);
    const overflow = await addSchedule('one too many', 10_000, { dataDir, now: 0 });
    assert.equal(overflow.ok, false);
    assert.match(overflow.ok ? '' : overflow.error, /full/);
    assert.equal((await saveSchedule([...tasks, task('extra', 1)], { dataDir })).ok, false);
    assert.equal(unwrap(await loadSchedule({ dataDir })).length, 100);
  });
});

test('filesystem failures are returned as error results, never thrown', async () => {
  await sandbox(async (dataDir) => {
    const blocker = path.join(dataDir, 'a-file');
    await fs.writeFile(blocker, 'not a directory', 'utf8');
    const options = { dataDir: blocker };

    assert.equal((await saveSchedule([], options)).ok, false);
    assert.equal((await loadSchedule(options)).ok, false);
    assert.equal((await addSchedule('hello', 10_000, options)).ok, false);
    assert.equal((await dueTasks(options)).ok, false);
    assert.equal((await markRun('x', options)).ok, false);
    assert.equal((await removeSchedule('x', options)).ok, false);
  });
});
