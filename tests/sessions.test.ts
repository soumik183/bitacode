import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  countConversationMessages,
  createSession,
  deleteSession,
  formatSessionAge,
  generateTitle,
  isValidSessionId,
  titleFromText,
  ensureSystemPromptAtTop,
  hasConversationMessages,
  listSessions,
  loadSession,
  sanitizeCompletionMessages,
  saveSession,
  type SubAgentActivity,
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

test('assistant reasoning survives save and load for replay', async () => {
  const session = createSession('model', 'provider');
  session.completionMessages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer', reasoning: 'secret chain of thought' } as any,
  ];
  await saveSession(session);

  const loaded = await loadSession(session.id);
  assert.ok(loaded);
  const assistant = loaded!.completionMessages.find((m) => m.role === 'assistant') as any;
  assert.equal(assistant.reasoning, 'secret chain of thought');
  assert.equal(assistant.content, 'answer');
});

test('concurrent saves of one session never collide over a temp file', async () => {
  const session = createSession('model', 'provider');
  session.completionMessages = [{ role: 'user', content: 'hello' }];
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => {
      const copy: typeof session = { ...session, title: `title ${i}` };
      return saveSession(copy);
    })
  );
  const loaded = await loadSession(session.id);
  assert.ok(loaded, 'the session is readable after a save burst');
  const leftovers = fs.readdirSync(sessionsDir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no temp files survive a save burst');
});

test('sanitizeCompletionMessages keeps reasoning on tool-call assistant messages', () => {
  const result = sanitizeCompletionMessages([
    {
      role: 'assistant',
      content: '',
      reasoning: 'tool thought',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ] as any);
  assert.equal((result[0] as any).reasoning, 'tool thought');
  assert.equal(result[1]?.role, 'tool');
});

test('loaded sessions drop UI-only message fields but keep reasoning for replay', async () => {
  const session = createSession('model', 'provider');
  session.completionMessages = [
    { role: 'system', content: 'sys', bitacodeFoo: 'bar' } as any,
    { role: 'user', content: 'question', subAgentActivities: [{ id: 'a' }] } as any,
    {
      role: 'assistant',
      content: 'answer',
      reasoning: 'thought to replay',
      bitacodeTrace: 'x',
    } as any,
  ];
  await saveSession(session);

  const loaded = await loadSession(session.id);
  assert.ok(loaded);
  const messages = loaded!.completionMessages as any[];
  assert.ok(messages.every((m) => !('subAgentActivities' in m) && !Object.keys(m).some((k) => /^bitacode/i.test(k))));
  assert.equal(messages[2].reasoning, 'thought to replay');
  assert.equal(messages[2].content, 'answer');
});

test('sanitizeCompletionMessages validates tool_call structures and dedupes ids', () => {
  const result = sanitizeCompletionMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'bash' } },
        { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } },
        { id: '', type: 'function', function: { name: 'bash', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: '', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ] as any);

  const assistant = result[2] as any;
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].id, 'c1');
  assert.equal(assistant.tool_calls[0].function.arguments, '{}');
  assert.equal(result[3].role, 'tool');
  assert.equal((result[3] as any).tool_call_id, 'c1');
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

/* ----------------------- sub-agent activity ----------------------- */

test('sub-agent activities round-trip through save and load', async () => {
  const session = createSession('m', 'p');
  const activities: SubAgentActivity[] = [
    { id: 'a1', task: 'explore src', status: 'start', startedAt: 1000 },
    {
      id: 'a2',
      task: 'run tests',
      status: 'done',
      toolCalls: 3,
      summary: 'all green',
      startedAt: 1000,
      endedAt: 2500,
    },
    { id: 'a3', task: 'build', status: 'error', summary: 'tsc failed', startedAt: 1100, endedAt: 1200 },
  ];
  session.subAgentActivities = activities;
  await saveSession(session);

  const loaded = await loadSession(session.id);
  assert.ok(loaded);
  assert.deepEqual(loaded!.subAgentActivities, activities);
});

test('malformed sub-agent activities are dropped, valid ones kept', async () => {
  const session = createSession('m', 'p');
  const valid: SubAgentActivity = {
    id: 'good',
    task: 'work',
    status: 'done',
    toolCalls: 2,
    summary: 'ok',
    startedAt: 100,
    endedAt: 200,
  };
  // Write raw JSON so malformed entries survive the save step.
  const filePath = path.join(sessionsDir, `${session.id}.json`);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      ...session,
      subAgentActivities: [
        null,
        42,
        'nope',
        {},
        { id: '', task: 'empty id', status: 'start', startedAt: 1 },
        { id: 'x', task: '', status: 'start', startedAt: 1 },
        { id: 'x', task: 'bad status', status: 'running', startedAt: 1 },
        { id: 'x', task: 'bad time', status: 'start', startedAt: 'now' },
        { id: 'x', task: 'neg calls', status: 'start', startedAt: 1, toolCalls: -1 },
        { id: 'x', task: 'float calls', status: 'start', startedAt: 1, toolCalls: 1.5 },
        { id: 'x', task: 'bad ended', status: 'start', startedAt: 1, endedAt: 'later' },
        valid,
      ],
    })
  );

  const loaded = await loadSession(session.id);
  assert.ok(loaded);
  assert.deepEqual(loaded!.subAgentActivities, [valid]);
});

test('old sessions without subAgentActivities load with undefined', async () => {
  const session = createSession('m', 'p');
  await saveSession(session);

  const raw = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${session.id}.json`), 'utf8'));
  assert.equal('subAgentActivities' in raw, false);

  const loaded = await loadSession(session.id);
  assert.ok(loaded);
  assert.equal(loaded!.subAgentActivities, undefined);
});

test('invalid subAgentActivities value loads as undefined', async () => {
  const session = createSession('m', 'p');
  fs.writeFileSync(
    path.join(sessionsDir, `${session.id}.json`),
    JSON.stringify({ ...session, subAgentActivities: 'not an array' })
  );

  const loaded = await loadSession(session.id);
  assert.ok(loaded);
  assert.equal(loaded!.subAgentActivities, undefined);
});

test('sub-agent activities are capped at 50 entries', async () => {
  const session = createSession('m', 'p');
  const many: SubAgentActivity[] = Array.from({ length: 60 }, (_, i) => ({
    id: `a${i}`,
    task: `task ${i}`,
    status: 'done' as const,
    startedAt: i,
  }));
  session.subAgentActivities = many;
  await saveSession(session);

  const loaded = await loadSession(session.id);
  assert.ok(loaded);
  assert.equal(loaded!.subAgentActivities!.length, 50);
  assert.deepEqual(
    loaded!.subAgentActivities!.map((a) => a.id),
    many.slice(0, 50).map((a) => a.id)
  );
});

test('deleteSession removes a session that has sub-agent activities', async () => {
  const session = createSession('m', 'p');
  session.subAgentActivities = [{ id: 'a1', task: 'work', status: 'done', startedAt: 1 }];
  await saveSession(session);

  const filePath = path.join(sessionsDir, `${session.id}.json`);
  assert.ok(fs.existsSync(filePath));
  assert.equal(await deleteSession(session.id), true);
  assert.ok(!fs.existsSync(filePath));
  assert.equal(await loadSession(session.id), null);
});

// ─── Session titles, counts and ids ──────────────────────────────────────

test('titles ignore harness wrappers, collapse lines and stay short', () => {
  const messages = [
    { role: 'system', content: 'You are Bitacode.' },
    {
      role: 'user',
      content: '<system-reminder>context</system-reminder>\n\nfix the   login\nbug please',
    },
  ] as any;
  assert.equal(generateTitle(messages), 'fix the login bug please');
  assert.equal(titleFromText('```ts\nconst x = 1\n```\nName this session'), 'Name this session');
  assert.equal(titleFromText('   ...   '), '', 'punctuation-only text has no title');
  assert.equal(generateTitle([{ role: 'system', content: 'sys' }] as any, 'Untitled · today'), 'Untitled · today');
  const long = generateTitle([{ role: 'user', content: 'word '.repeat(40) }] as any);
  assert.ok(long.length <= 60, `title is ${long.length} chars`);
  assert.ok(long.endsWith('…'));
  // Only whole words are kept before the ellipsis.
  assert.ok(!/\sw$/.test(long), 'title never cuts mid-word');
});

test('message counts exclude the system prompt', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ] as any;
  assert.equal(countConversationMessages(messages), 2);
});

test('listing repairs blank titles and reports real message counts', async () => {
  const session = createSession('m', 'p');
  session.title = '';
  session.completionMessages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'rename the config key' },
    { role: 'assistant', content: 'done' },
  ] as any;
  await saveSession(session);

  const [summary] = await listSessions();
  assert.equal(summary.id, session.id);
  assert.equal(summary.title, 'rename the config key');
  assert.equal(summary.messageCount, 2, 'system prompt is not counted');
});

test('session age is human and monotonic', () => {
  const now = Date.parse('2026-01-02T12:00:00.000Z');
  const at = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(formatSessionAge(at(5_000), now), 'just now');
  assert.equal(formatSessionAge(at(12 * 60_000), now), '12m ago');
  assert.equal(formatSessionAge(at(3 * 3_600_000), now), '3h ago');
  assert.equal(formatSessionAge(at(2 * 86_400_000), now), '2d ago');
  assert.equal(formatSessionAge('not a date', now), 'unknown');
});

test('runtime tags are never accepted as session ids', () => {
  assert.equal(isValidSessionId(createSession('m', 'p').id), true, 'generated ids are loadable');
  assert.equal(isValidSessionId('headless-lz9k'), false, 'headless run tags are not session ids');
  assert.equal(isValidSessionId('../escape'), false);
});
