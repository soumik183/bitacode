import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSession,
  deleteSession,
  ensureSystemPromptAtTop,
  hasConversationMessages,
  listSessions,
  loadSession,
  sanitizeCompletionMessages,
  saveSession,
} from '../src/sessions.js';
import { clearTodos, getTodosForSession, setTodosForSession, type TodoItem } from '../src/tools/todo.js';

let originalHome: string | undefined;
let tempHome: string;
let sessionsDir: string;

test.beforeEach(() => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-sessions-test-'));
  process.env.HOME = tempHome;
  sessionsDir = path.join(tempHome, '.local', 'share', 'bitacode', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
});

test.afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test('ensureSystemPromptAtTop prepends a system prompt when missing', () => {
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there' },
  ] as const;

  const result = ensureSystemPromptAtTop([...messages], 'You are Bitacode');

  assert.equal(result[0]?.role, 'system');
  assert.equal((result[0] as any).content, 'You are Bitacode');
  assert.equal(result[1]?.role, 'user');
  assert.equal(result[2]?.role, 'assistant');
});

test('ensureSystemPromptAtTop moves the first system prompt to the top and refreshes it', () => {
  const result = ensureSystemPromptAtTop(
    [
      { role: 'user', content: 'Earlier user message' },
      { role: 'system', content: 'Old prompt' },
      { role: 'assistant', content: 'Response' },
    ],
    'New prompt'
  );

  assert.equal(result[0]?.role, 'system');
  assert.equal((result[0] as any).content, 'New prompt');
  assert.equal(result[1]?.role, 'user');
  assert.equal(result[2]?.role, 'assistant');
  assert.equal(result.filter((message) => message.role === 'system').length, 1);
});

test('invalid session ids are rejected safely', async () => {
  const loaded = await loadSession('../not-a-session');
  const deleted = await deleteSession('../not-a-session');

  assert.equal(loaded, null);
  assert.equal(deleted, false);
});

test('hasConversationMessages only hides the empty-chat splash once a turn exists', () => {
  assert.equal(hasConversationMessages([{ role: 'system', content: 'prompt' }] as any), false);
  assert.equal(
    hasConversationMessages([
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'hello' },
    ] as any),
    true
  );
});

test('sanitizeCompletionMessages repairs tool-call gaps and orphans', () => {
  const result = sanitizeCompletionMessages([
    { role: 'system', content: 'You are Bitacode' },
    { role: 'user', content: 'read and edit' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"file_path":"a.txt"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'orphan', content: 'not requested' },
    { role: 'user', content: 'next turn' },
    { role: 'assistant', content: '   ' },
  ] as any);

  assert.deepEqual(
    result.map((message) => message.role),
    ['system', 'user', 'assistant', 'tool', 'user']
  );
  assert.equal((result[3] as any).tool_call_id, 'call_read');
  assert.match((result[3] as any).content, /missing from the saved session/i);
});

test('sanitizeCompletionMessages leaves a valid history intact', () => {
  const messages = [
    { role: 'system', content: 'You are Bitacode' },
    { role: 'user', content: 'read a.txt' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"file_path":"a.txt"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_read', content: 'hello' },
    { role: 'assistant', content: 'It says hello.' },
  ] as any;

  assert.deepEqual(sanitizeCompletionMessages(messages), messages);
});

/* --------------------------- session deletion --------------------------- */

test('deleteSession removes the file and listSessions/loadSession reflect it', async () => {
  const session = createSession('model', 'provider');
  session.title = 'To delete';
  await saveSession(session);

  const filePath = path.join(sessionsDir, `${session.id}.json`);
  assert.ok(fs.existsSync(filePath));
  assert.equal((await listSessions()).some((s) => s.id === session.id), true);

  assert.equal(await deleteSession(session.id), true);
  assert.ok(!fs.existsSync(filePath));
  assert.equal(await loadSession(session.id), null);
  assert.equal((await listSessions()).some((s) => s.id === session.id), false);
});

test('deleteSession purges the deleted session in-memory todo state', async () => {
  const session = createSession('model', 'provider');
  await saveSession(session);
  const todos: TodoItem[] = [{ id: 't1', content: 'task', status: 'pending', priority: 'high' }];
  setTodosForSession(session.id, todos);
  assert.deepEqual(getTodosForSession(session.id), todos);

  assert.equal(await deleteSession(session.id), true);
  assert.deepEqual(getTodosForSession(session.id), []);
});

test('deleting one session leaves other sessions intact (active vs inactive id)', async () => {
  const active = createSession('m', 'p');
  active.title = 'active';
  await saveSession(active);
  const inactive = createSession('m', 'p');
  inactive.title = 'inactive';
  await saveSession(inactive);

  assert.equal(await deleteSession(active.id), true);
  assert.equal(await loadSession(active.id), null);
  assert.ok(await loadSession(inactive.id), 'the other session must survive');

  assert.equal(await deleteSession(inactive.id), true);
  assert.equal(await loadSession(inactive.id), null);
  assert.deepEqual(await listSessions(), []);
});

test('deleting a non-existent session returns false without throwing', async () => {
  assert.equal(await deleteSession('deadbeef'), false);
});

test('invalid and traversal session ids are rejected without throwing', async () => {
  const badIds = [
    '../not-a-session',
    '..',
    '/etc/passwd',
    'foo/bar/baz',
    'C:\\windows\\x',
    '....',
    'valid-id!',
    '1234567',
    '../sessions/victim',
  ];
  for (const id of badIds) {
    assert.equal(await deleteSession(id), false, `id ${JSON.stringify(id)} should be rejected`);
  }
});

test('a crafted id cannot delete a file outside the sessions directory', async () => {
  const outside = path.join(tempHome, 'outside.json');
  fs.writeFileSync(outside, 'keep me');
  for (const id of ['outside', '..outside', 'outside.json', 'a/b']) {
    assert.equal(await deleteSession(id), false, `id ${id} must not escape the sessions dir`);
  }
  assert.ok(fs.existsSync(outside));
});

test('deleteSession does not throw on filesystem errors (directory named <id>.json)', async () => {
  const id = 'dirtest1';
  const dirPath = path.join(sessionsDir, `${id}.json`);
  fs.mkdirSync(dirPath, { recursive: true });

  assert.equal(await deleteSession(id), false);
  assert.ok(fs.existsSync(dirPath));
});

test('every listed session can be deleted, even when the stored id differs from the filename', async () => {
  const first = createSession('m', 'p');
  first.title = 'First';
  await saveSession(first);
  const second = createSession('m', 'p');
  second.title = 'Second';
  await saveSession(second);

  // A file whose internal `id` does not match its filename. listSessions must
  // expose the filename id so the UI can delete exactly what it lists.
  const filenameId = 'abcd1234';
  fs.writeFileSync(
    path.join(sessionsDir, `${filenameId}.json`),
    JSON.stringify({ ...createSession('m', 'p'), id: 'different-id' })
  );

  const listed = await listSessions();
  assert.equal(listed.length, 3);
  assert.ok(
    listed.some((s) => s.id === filenameId),
    'listed id must come from the filename so it can be deleted'
  );

  for (const summary of listed) {
    assert.equal(await deleteSession(summary.id), true, `could not delete listed session ${summary.id}`);
  }
  assert.deepEqual(await listSessions(), []);
});

test('corrupt session files are skipped and do not break deletion of valid sessions', async () => {
  const valid = createSession('m', 'p');
  await saveSession(valid);
  fs.writeFileSync(path.join(sessionsDir, 'corrupt1.json'), '{not json');

  assert.deepEqual((await listSessions()).map((s) => s.id), [valid.id]);
  assert.equal(await deleteSession(valid.id), true);
  assert.deepEqual(await listSessions(), []);
});
