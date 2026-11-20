import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSession,
  exportSession,
  forkSession,
  listSessions,
  loadSession,
  renameSession,
  saveSession,
  setSessionPinned,
  type SubAgentActivity,
} from '../src/sessions.js';

let originalHome: string | undefined;
let tempHome: string;
let sessionsDir: string;

test.beforeEach(() => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-session-enhancements-'));
  process.env.HOME = tempHome;
  sessionsDir = path.join(tempHome, '.local', 'share', 'bitacode', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
});

test.afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function rawFile(id: string): string {
  return fs.readFileSync(path.join(sessionsDir, `${id}.json`), 'utf8');
}

/* ------------------------------- fork ------------------------------- */

test('forkSession creates a new saved session and never mutates the original', async () => {
  const original = createSession('gpt-test', 'test-provider');
  original.variant = 'high';
  original.title = 'Original chat';
  original.createdAt = '2020-01-01T00:00:00.000Z';
  original.completionMessages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ] as any;
  original.todos = [{ id: 't1', content: 'task', status: 'pending', priority: 'high' }];
  const activities: SubAgentActivity[] = [
    { id: 'a1', task: 'work', status: 'done', startedAt: 1, endedAt: 2 },
  ];
  original.subAgentActivities = activities;
  await saveSession(original);

  const before = rawFile(original.id);
  const fork = await forkSession(original.id, 'Forked chat');
  assert.ok(fork);
  assert.notEqual(fork!.id, original.id, 'fork gets a new id');
  assert.equal(fork!.title, 'Forked chat');
  assert.equal(fork!.provider, original.provider);
  assert.equal(fork!.model, original.model);
  assert.equal(fork!.variant, 'high');
  assert.deepEqual(fork!.todos, original.todos);
  assert.deepEqual(fork!.subAgentActivities, activities);
  assert.equal(fork!.completionMessages.length, 3);
  assert.notEqual(fork!.createdAt, original.createdAt, 'fork gets fresh timestamps');

  // The fork was persisted under its own id and the source file is untouched.
  assert.ok(fs.existsSync(path.join(sessionsDir, `${fork!.id}.json`)));
  assert.equal(rawFile(original.id), before, 'original file is byte-for-byte unchanged');
  const reloadedFork = await loadSession(fork!.id);
  assert.ok(reloadedFork);
  assert.equal(reloadedFork!.title, 'Forked chat');
});

test('forkSession truncates messages with uptoMessageIndex (exclusive) without touching the source', async () => {
  const original = createSession('m', 'p');
  original.completionMessages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: 'four' },
  ] as any;
  await saveSession(original);
  const before = rawFile(original.id);

  const fork = await forkSession(original.id, undefined, 2);
  assert.ok(fork);
  assert.deepEqual(fork!.completionMessages.map((m) => m.role), ['system', 'user']);
  assert.equal(fork!.title, original.title, 'no title given keeps the source title');

  const source = await loadSession(original.id);
  assert.equal(source!.completionMessages.length, 5, 'source history is intact');
  assert.equal(rawFile(original.id), before);

  // Invalid bounds mean "no truncation".
  const full = await forkSession(original.id, undefined, Number.NaN);
  assert.equal(full!.completionMessages.length, 5);
  assert.equal((await forkSession('does-not-exist')), null);
});

/* ------------------------------ rename ------------------------------ */

test('renameSession persists a new title and reports missing ids', async () => {
  const session = createSession('m', 'p');
  await saveSession(session);

  assert.equal(await renameSession(session.id, '  My new title  '), true);
  assert.equal((await loadSession(session.id))!.title, 'My new title');
  assert.equal(
    (await listSessions()).find((s) => s.id === session.id)!.title,
    'My new title'
  );

  assert.equal(await renameSession('deadbeef', 'nope'), false);
});

/* -------------------------------- pin -------------------------------- */

test('setSessionPinned round-trips and older files load without a pin', async () => {
  const session = createSession('m', 'p');
  await saveSession(session);

  // Simulate an old file with no pinned field.
  const filePath = path.join(sessionsDir, `${session.id}.json`);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  delete raw.pinned;
  fs.writeFileSync(filePath, JSON.stringify(raw));
  assert.equal((await loadSession(session.id))!.pinned, undefined);

  assert.equal(await setSessionPinned(session.id, true), true);
  assert.equal((await loadSession(session.id))!.pinned, true);
  assert.equal((await listSessions()).find((s) => s.id === session.id)!.pinned, true);

  assert.equal(await setSessionPinned(session.id, false), true);
  assert.equal((await loadSession(session.id))!.pinned, false);

  // A corrupt pin value is ignored rather than trusted.
  const corrupt = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  corrupt.pinned = 'yes';
  fs.writeFileSync(filePath, JSON.stringify(corrupt));
  assert.equal((await loadSession(session.id))!.pinned, undefined);

  assert.equal(await setSessionPinned('deadbeef', true), false);
});

/* ------------------------------ export ------------------------------ */

async function seededSession() {
  const session = createSession('m', 'p');
  session.title = 'Export me';
  session.completionMessages = [
    { role: 'system', content: 'SECRET-SYSTEM-PROMPT' },
    { role: 'user', content: 'hello project' },
    {
      role: 'assistant',
      content: 'hi there',
      reasoning: 'CHAIN-OF-THOUGHT-SECRET',
    } as any,
  ];
  await saveSession(session);
  return session;
}

test('exportSession renders a readable markdown transcript with no secrets', async () => {
  const session = await seededSession();
  const md = await exportSession(session.id, 'md');
  assert.ok(md);
  assert.match(md!, /^# Export me/);
  assert.match(md!, /ID:/);
  assert.match(md!, /Route: p\/m/);
  assert.match(md!, /hello project/);
  assert.match(md!, /hi there/);
  assert.ok(!md!.includes('SECRET-SYSTEM-PROMPT'));
  assert.ok(!md!.includes('CHAIN-OF-THOUGHT-SECRET'));
});

test('exportSession renders a plain-text transcript with a metadata header', async () => {
  const session = await seededSession();
  const txt = await exportSession(session.id, 'txt');
  assert.ok(txt);
  assert.match(txt!, /^Session: Export me/);
  assert.match(txt!, /ID:/);
  assert.match(txt!, /\[User\]/);
  assert.match(txt!, /hello project/);
  assert.ok(!txt!.includes('SECRET-SYSTEM-PROMPT'));
  assert.ok(!txt!.includes('CHAIN-OF-THOUGHT-SECRET'));
});

test('exportSession emits structured, secret-free JSON', async () => {
  const session = await seededSession();
  const json = await exportSession(session.id, 'json');
  assert.ok(json);
  const parsed = JSON.parse(json!);
  assert.equal(parsed.metadata.id, session.id);
  assert.equal(parsed.metadata.title, 'Export me');
  assert.equal(parsed.metadata.messageCount, 2, 'system prompt is excluded');
  assert.deepEqual(parsed.messages.map((m: any) => m.role), ['user', 'assistant']);
  assert.ok(!json!.includes('SECRET-SYSTEM-PROMPT'));
  assert.ok(!json!.includes('CHAIN-OF-THOUGHT-SECRET'));
});

test('exportSession returns null for a missing session', async () => {
  assert.equal(await exportSession('deadbeef', 'md'), null);
});
