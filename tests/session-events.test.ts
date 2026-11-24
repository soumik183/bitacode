/**
 * Tests for session-events.ts — append-only events, snapshots and claims.
 *
 * Every test uses its own temporary data directory, so the real session store
 * and the real XDG locations are never touched.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  appendEvent,
  claimExecution,
  claimedSessions,
  eventsDir,
  readEvents,
  readSnapshot,
  releaseExecution,
  writeSnapshot,
  type SessionEvent,
} from '../src/utils/session-events.js';

async function tempDataDir(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bitacode-events-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function expectError(result: { ok: boolean }, pattern?: RegExp): void {
  assert.equal(result.ok, false);
  if (pattern && !result.ok) assert.match(result.error, pattern);
}

test('eventsDir composes the events directory from dataDir', async (t) => {
  const dir = await tempDataDir(t);
  assert.equal(eventsDir({ dataDir: dir }), path.join(dir, 'events'));
  assert.equal(eventsDir({ dataDir: path.join(dir, 'custom') }), path.join(dir, 'custom', 'events'));
});

test('appendEvent allocates increasing seq values and readEvents returns them in order', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };

  const first = await appendEvent({ sessionId: 's1', type: 'user', data: { text: 'hello' } }, options);
  assert.ok(first.ok);
  assert.equal(first.value.seq, 1);
  assert.equal(first.value.sessionId, 's1');
  assert.equal(first.value.type, 'user');
  assert.deepEqual(first.value.data, { text: 'hello' });
  assert.ok(!Number.isNaN(Date.parse(first.value.at)));

  const second = await appendEvent({
    sessionId: 's1',
    type: 'assistant',
    at: '2026-01-02T03:04:05.000Z',
    data: { text: 'hi' },
  }, options);
  assert.ok(second.ok);
  assert.equal(second.value.seq, 2);
  assert.equal(second.value.at, '2026-01-02T03:04:05.000Z');

  const read = await readEvents('s1', options);
  assert.ok(read.ok);
  assert.deepEqual(read.value.map((event: SessionEvent) => event.seq), [1, 2]);
  assert.deepEqual(read.value.map((event: SessionEvent) => event.type), ['user', 'assistant']);
});

test('readEvents applies after exclusively and returns an empty list past the end', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };
  for (let i = 0; i < 3; i++) {
    const result = await appendEvent({ sessionId: 's1', type: 'note', data: { i } }, options);
    assert.ok(result.ok);
  }

  const afterOne = await readEvents('s1', { dataDir, after: 1 });
  assert.ok(afterOne.ok);
  assert.deepEqual(afterOne.value.map((event) => event.seq), [2, 3]);

  const pastEnd = await readEvents('s1', { dataDir, after: 99 });
  assert.ok(pastEnd.ok);
  assert.deepEqual(pastEnd.value, []);
});

test('a torn final line is skipped without discarding valid history', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };
  assert.ok((await appendEvent({ sessionId: 's1', type: 'user', data: { n: 1 } }, options)).ok);
  assert.ok((await appendEvent({ sessionId: 's1', type: 'note', data: { n: 2 } }, options)).ok);

  const file = path.join(eventsDir(options), 's1.jsonl');
  await fs.appendFile(file, '{"seq":3,"sessionId":"s1","type":"note","data":{"n":3\n');

  const third = await appendEvent({ sessionId: 's1', type: 'note', data: { n: 4 } }, options);
  assert.ok(third.ok);
  assert.equal(third.value.seq, 3);

  const read = await readEvents('s1', options);
  assert.ok(read.ok);
  assert.deepEqual(read.value.map((event) => event.data), [{ n: 1 }, { n: 2 }, { n: 4 }]);
  const raw = await fs.readFile(file, 'utf8');
  assert.match(raw, /\{"n":3\n/); // the torn bytes were not rewritten
});

test('readEvents skips malformed lines and sorts out-of-order seq values', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };
  await fs.mkdir(eventsDir(options), { recursive: true });
  const lines = [
    'not json at all',
    JSON.stringify({ seq: 5, sessionId: 's1', type: 'note', at: 'now', data: { n: 5 } }),
    JSON.stringify({ seq: 2, sessionId: 's1', type: 'note', at: 'now', data: { n: 2 } }),
    JSON.stringify({ seq: 1, sessionId: 'other', type: 'note', at: 'now', data: {} }),
    JSON.stringify({ seq: 'x', sessionId: 's1', type: 'note', at: 'now', data: {} }),
    '',
  ];
  await fs.writeFile(path.join(eventsDir(options), 's1.jsonl'), `${lines.join('\n')}\n`);

  const read = await readEvents('s1', options);
  assert.ok(read.ok);
  assert.deepEqual(read.value.map((event) => event.seq), [2, 5]);

  const appended = await appendEvent({ sessionId: 's1', type: 'note', data: { n: 6 } }, options);
  assert.ok(appended.ok);
  assert.equal(appended.value.seq, 6);
});

test('concurrent appends to one session receive unique, gap-free seq values', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };
  const count = 30;
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) => appendEvent(
      { sessionId: 'concurrent', type: 'note', data: { i } },
      options,
    )),
  );
  assert.ok(results.every((result) => result.ok));
  const seqs = results.map((result) => (result.ok ? result.value.seq : -1));
  assert.equal(new Set(seqs).size, count);
  assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i + 1));

  const read = await readEvents('concurrent', options);
  assert.ok(read.ok);
  assert.equal(read.value.length, count);
});

test('invalid session ids are rejected by every API without creating files', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };
  const invalid = ['', '../escape', 'a/b', 'has space', 'dot.name', 'x'.repeat(81), 42];

  for (const sessionId of invalid) {
    const id = sessionId as string;
    expectError(await appendEvent({ sessionId: id, type: 'note', data: {} }, options), /Invalid sessionId/);
    expectError(await readEvents(id, options), /Invalid sessionId/);
    expectError(await writeSnapshot(id, {}, options), /Invalid sessionId/);
    expectError(await readSnapshot(id, options), /Invalid sessionId/);
    expectError(await claimExecution(id, 'owner', options), /Invalid sessionId/);
    expectError(await releaseExecution(id, 'owner', options), /Invalid sessionId/);
  }
  await assert.rejects(fs.stat(eventsDir(options)), { code: 'ENOENT' });
});

test('invalid owner ids are rejected by claim and release', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };
  for (const owner of ['', '../root', 'bad owner', 'y'.repeat(81)]) {
    expectError(await claimExecution('s1', owner, options), /Invalid owner/);
    expectError(await releaseExecution('s1', owner, options), /Invalid owner/);
  }
});

test('invalid event types and timestamps are rejected', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };
  expectError(await appendEvent({ sessionId: 's1', type: 'bogus' as never, data: {} }, options), /Invalid event type/);
  expectError(await appendEvent({ sessionId: 's1', type: 'note', at: 5 as never, data: {} }, options), /Invalid event time/);
  expectError(await appendEvent({ sessionId: 's1', type: 'note', at: '', data: {} }, options), /Invalid event time/);
  expectError(await appendEvent(null as never, options), /Invalid event/);
});

test('oversized and circular events are rejected without writing a line', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };
  expectError(await appendEvent(
    { sessionId: 'big', type: 'note', data: { text: 'x'.repeat(1024 * 1024) } },
    options,
  ), /size limit/i);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expectError(await appendEvent({ sessionId: 'circular', type: 'note', data: circular }, options));

  const read = await readEvents('big', options);
  assert.ok(read.ok);
  assert.deepEqual(read.value, []);
});

test('snapshots round-trip nested data with private permissions', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };
  const snapshot = { messages: [{ role: 'user', content: 'hello' }], count: 2 };
  assert.equal((await writeSnapshot('s1', snapshot, options)).ok, true);

  const read = await readSnapshot('s1', options);
  assert.ok(read.ok);
  assert.deepEqual(read.value, snapshot);

  const stat = await fs.stat(path.join(eventsDir(options), 's1.snapshot.json'));
  assert.equal(stat.mode & 0o777, 0o600);
});

test('missing snapshots read as undefined and corrupt snapshots fail with an error', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };

  assert.deepEqual(await readSnapshot('missing', options), { ok: true, value: undefined });

  await fs.mkdir(eventsDir(options), { recursive: true });
  await fs.writeFile(path.join(eventsDir(options), 's1.snapshot.json'), '{ not json', { mode: 0o600 });
  expectError(await readSnapshot('s1', options), /Corrupt snapshot/);
});

test('claimExecution conflicts with another owner and is idempotent for the same owner', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };
  assert.equal((await claimExecution('s1', 'owner-a', options)).ok, true);

  expectError(await claimExecution('s1', 'owner-b', options), /owner-a/);

  const before = await claimedSessions(options);
  assert.ok(before.ok);
  assert.equal(before.value.length, 1);
  assert.equal(before.value[0].sessionId, 's1');
  assert.equal(before.value[0].owner, 'owner-a');
  assert.ok(!Number.isNaN(Date.parse(before.value[0].claimedAt)));

  assert.equal((await claimExecution('s1', 'owner-a', options)).ok, true);
  const after = await claimedSessions(options);
  assert.ok(after.ok);
  assert.deepEqual(after.value, before.value);
});

test('releaseExecution only removes a claim when the owner matches', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };
  assert.equal((await claimExecution('s2', 'alice', options)).ok, true);
  expectError(await releaseExecution('s2', 'bob', options), /not "bob"/);

  const stillClaimed = await claimedSessions(options);
  assert.ok(stillClaimed.ok);
  assert.equal(stillClaimed.value.length, 1);

  assert.equal((await releaseExecution('s2', 'alice', options)).ok, true);
  const released = await claimedSessions(options);
  assert.ok(released.ok);
  assert.deepEqual(released.value, []);

  assert.equal((await releaseExecution('s2', 'alice', options)).ok, true);
});

test('claims persist on disk and claimedSessions returns defensive copies', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };
  assert.equal((await claimExecution('persist', 'worker-1', options)).ok, true);

  const raw = JSON.parse(await fs.readFile(path.join(eventsDir(options), 'claims.json'), 'utf8')) as {
    persist: { owner: string; claimedAt: string };
  };
  assert.equal(raw.persist.owner, 'worker-1');
  assert.ok(!Number.isNaN(Date.parse(raw.persist.claimedAt)));

  const first = await claimedSessions(options);
  assert.ok(first.ok);
  first.value[0].owner = 'tampered';
  first.value.pop();

  const second = await claimedSessions(options);
  assert.ok(second.ok);
  assert.equal(second.value.length, 1);
  assert.equal(second.value[0].owner, 'worker-1');
});

test('concurrent claims elect exactly one owner', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => claimExecution('race', `owner-${i}`, options)),
  );
  assert.equal(results.filter((result) => result.ok).length, 1);
  const list = await claimedSessions(options);
  assert.ok(list.ok);
  assert.equal(list.value.length, 1);
  assert.match(list.value[0].owner, /^owner-\d+$/);
});

test('readEvents returns defensive copies of event data', async (t) => {
  const dataDir = await tempDataDir(t);
  const options = { dataDir };
  const appended = await appendEvent(
    { sessionId: 's1', type: 'note', data: { nested: { n: 1 } } },
    options,
  );
  assert.ok(appended.ok);
  (appended.value.data as { nested: { n: number } }).nested.n = 99;

  const first = await readEvents('s1', options);
  assert.ok(first.ok);
  (first.value[0].data as { nested: { n: number } }).nested.n = 42;

  const second = await readEvents('s1', options);
  assert.ok(second.ok);
  assert.deepEqual(second.value[0].data, { nested: { n: 1 } });
});
