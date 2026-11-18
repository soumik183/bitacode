import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  saveSubAgentRun,
  listSubAgentRuns,
  loadSubAgentRun,
  isValidSubAgentId,
  type SubAgentRunInput,
} from '../src/utils/subagent-store.js';
import { handleToolCall, getAllTools } from '../src/tools/index.js';
import { runSubAgent } from '../src/sub-agent.js';

let originalHomedir: typeof os.homedir;
let tempHome: string;
let sessionDir: string;

function makeRecord(overrides: Partial<SubAgentRunInput> = {}): SubAgentRunInput {
  return {
    sessionId: 'main1234',
    id: 'sub-agent-abc123',
    task: 'find the bug',
    label: 'Task 1/1',
    status: 'done',
    startedAt: 1000,
    endedAt: 2000,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'find the bug' },
      { role: 'assistant', content: 'found it' },
    ],
    ...overrides,
  };
}

function makeClient(response: string): any {
  return {
    chat: {
      completions: {
        create: async () => (async function* () {
          yield { choices: [{ delta: { content: response } }] };
          yield {
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          };
        })(),
      },
    },
  };
}

test.beforeEach(() => {
  originalHomedir = os.homedir;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-subagent-test-'));
  (os as any).homedir = () => tempHome;
  sessionDir = path.join(tempHome, '.local', 'share', 'bitacode', 'subagents', 'main1234');
});

test.afterEach(() => {
  (os as any).homedir = originalHomedir;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test('save → list → load round-trip', async () => {
  assert.equal(await saveSubAgentRun(makeRecord()), true);
  const file = path.join(sessionDir, 'sub-agent-abc123.json');
  assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }

  const runs = await listSubAgentRuns('main1234');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, 'sub-agent-abc123');
  assert.equal(runs[0].task, 'find the bug');
  assert.equal(runs[0].status, 'done');
  assert.equal(runs[0].messageCount, 3);
  assert.equal((runs[0] as any).messages, undefined, 'list stays compact');

  const record = await loadSubAgentRun('main1234', 'sub-agent-abc123');
  assert.ok(record);
  assert.deepEqual(record!.messages.map((m) => m.content), ['sys', 'find the bug', 'found it']);
  assert.equal(record!.label, 'Task 1/1');
  assert.equal(record!.endedAt, 2000);
});

test('invalid ids are rejected before any path is built', async () => {
  assert.equal(isValidSubAgentId('../etc/passwd'), false);
  assert.equal(isValidSubAgentId('bad/id'), false);
  assert.equal(isValidSubAgentId('sa-1'), true);

  assert.equal(await saveSubAgentRun(makeRecord({ id: '../escape' })), false);
  assert.equal(await saveSubAgentRun(makeRecord({ sessionId: '../escape' })), false);
  assert.deepEqual(await listSubAgentRuns('../escape'), []);
  assert.equal(await loadSubAgentRun('main1234', '../escape'), null);
  assert.equal(fs.existsSync(path.join(tempHome, '.local', 'share', 'bitacode', 'escape')), false);
});

test('malformed records are skipped by list and load', async () => {
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'bad-json.json'), '{not json');
  fs.writeFileSync(path.join(sessionDir, 'bad-status.json'), JSON.stringify({
    ...makeRecord(), id: 'bad-status', status: 'nope',
  }));
  fs.writeFileSync(path.join(sessionDir, 'mismatch.json'), JSON.stringify({
    ...makeRecord(), id: 'different-id',
  }));
  assert.equal(await saveSubAgentRun(makeRecord()), true);

  const runs = await listSubAgentRuns('main1234');
  assert.deepEqual(runs.map((r) => r.id), ['sub-agent-abc123']);
  assert.equal(await loadSubAgentRun('main1234', 'bad-json'), null);
  assert.equal(await loadSubAgentRun('main1234', 'bad-status'), null);
  assert.equal(await loadSubAgentRun('main1234', 'mismatch'), null);
});

test('messages and content are capped on write', async () => {
  const messages = Array.from({ length: 150 }, (_, i) => ({
    role: 'user',
    content: `${'x'.repeat(9_000)}${i}`,
  }));
  assert.equal(await saveSubAgentRun(makeRecord({ messages })), true);

  const record = await loadSubAgentRun('main1234', 'sub-agent-abc123');
  assert.equal(record!.messages.length, 100);
  assert.equal(record!.messageCount, 100);
  assert.ok(record!.messages.every((m) => m.content.length <= 8_000));
  assert.ok(record!.messages.some((m) => m.content.endsWith('...[truncated]')));
});

test('read_subagent lists runs and reads one without throwing', async () => {
  assert.equal(await saveSubAgentRun(makeRecord()), true);

  const listed = await handleToolCall('read_subagent', {}, { sessionId: 'main1234' });
  assert.match(listed, /sub-agent-abc123/);
  assert.match(listed, /find the bug/);
  assert.match(listed, /\[done\]/);

  const one = await handleToolCall('read_subagent', { id: 'sub-agent-abc123' }, { sessionId: 'main1234' });
  assert.match(one, /TRANSCRIPT/);
  assert.match(one, /assistant: found it/);

  const meta = await handleToolCall(
    'read_subagent', { id: 'sub-agent-abc123', include_messages: false }, { sessionId: 'main1234' },
  );
  assert.doesNotMatch(meta, /TRANSCRIPT/);

  assert.match(await handleToolCall('read_subagent', { id: '../escape' }, { sessionId: 'main1234' }), /^Error:/);
  assert.match(await handleToolCall('read_subagent', {}, {}), /^Error:/);
  assert.ok(getAllTools().some((t: any) => t.function.name === 'read_subagent'));
});

test('runSubAgent persists a readable transcript', async () => {
  const result = await runSubAgent(
    makeClient('answer: ok'), 'test-model', 'do work',
    undefined, {}, undefined, undefined, undefined, undefined, undefined, 'main1234',
  );
  assert.match(result.response, /answer: ok/);

  const runs = await listSubAgentRuns('main1234');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'done');
  const record = await loadSubAgentRun('main1234', runs[0].id);
  assert.ok(record!.messages.some((m) => m.content.includes('answer: ok')));
});

test('runSubAgent result is unchanged when persistence fails', async () => {
  const brokenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-broken-'));
  (os as any).homedir = () => brokenHome;
  try {
    // A regular file where the bitacode data dir should be makes every write fail.
    fs.mkdirSync(path.join(brokenHome, '.local', 'share'), { recursive: true });
    fs.writeFileSync(path.join(brokenHome, '.local', 'share', 'bitacode'), 'not a directory');

    const result = await runSubAgent(
      makeClient('still ok'), 'test-model', 'do work',
      undefined, {}, undefined, undefined, undefined, undefined, undefined, 'main1234',
    );
    assert.match(result.response, /still ok/);
    assert.equal(result.usage.inputTokens, 4);
  } finally {
    (os as any).homedir = () => tempHome;
    fs.rmSync(brokenHome, { recursive: true, force: true });
  }
});
