import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  saveSubAgentRun,
  loadSubAgentRun,
  releaseSubAgentRun,
  listSubAgentRuns,
} from '../src/utils/subagent-store.js';
import {
  subagentControlTool,
  runSubAgentFollowUp,
  isSubAgentRunning,
  listRunningSubAgentIds,
  abortSubAgentRun,
  type SubAgentProgressEvent,
} from '../src/sub-agent.js';

let originalHomedir: typeof os.homedir;
let tempHome: string;

test.beforeEach(() => {
  originalHomedir = os.homedir;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-subagent-control-'));
  (os as any).homedir = () => tempHome;
});

test.afterEach(() => {
  (os as any).homedir = originalHomedir;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function makeClient(seen: Array<Array<{ role: string; content?: unknown }>>): any {
  return {
    chat: {
      completions: {
        create: async (params: any) => {
          seen.push(params.messages.map((message: any) => ({ ...message })));
          return (async function* () {
            yield { choices: [{ delta: { content: 'continued answer' } }] };
            yield { choices: [{ delta: {} }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } };
          })();
        },
      },
    },
  };
}

async function seed(id: string): Promise<void> {
  await saveSubAgentRun({
    sessionId: 'session-1',
    id,
    task: 'original task',
    label: 'Task 1/1',
    agentType: 'Review',
    status: 'done',
    startedAt: 1000,
    endedAt: 2000,
    messages: [
      { role: 'system', content: 'You are a sub-agent.' },
      { role: 'user', content: 'original task' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: '{"file_path":"src/a.ts"}' } }],
      },
      { role: 'tool', content: 'file content', tool_call_id: 'call-1', name: 'read_file' },
      { role: 'assistant', content: 'original answer' },
    ],
  });
}

test('subagent_control schema exposes every control action', () => {
  const props: any = subagentControlTool.function.parameters.properties;
  assert.equal(subagentControlTool.function.name, 'subagent_control');
  assert.deepEqual(props.action.enum, ['list', 'status', 'prompt', 'release', 'abort']);
  assert.ok(props.id && props.prompt);
});

test('prompt continues a saved child with full prior context and links the new run', async () => {
  await seed('sub-agent-parent1');
  const seen: Array<Array<{ role: string; content?: unknown }>> = [];
  const events: SubAgentProgressEvent[] = [];
  const result = await runSubAgentFollowUp(
    makeClient(seen), 'gpt-4o-mini', 'session-1', 'sub-agent-parent1', 'now fix the bug',
    { onProgress: (event) => events.push(event) },
  );
  assert.equal(result?.response, 'continued answer');
  const messages = seen[0];
  assert.ok(messages.some((m) => m.content === 'You are a sub-agent.'), 'system prompt preserved');
  assert.ok(messages.some((m) => m.content === 'original task'), 'original task preserved');
  assert.ok(messages.some((m) => m.role === 'tool' && m.content === 'file content'), 'tool result preserved');
  assert.equal(messages[messages.length - 1].content, 'now fix the bug', 'new prompt is the last turn');

  const runs = await listSubAgentRuns('session-1');
  assert.equal(runs.length, 2, 'original preserved plus a new child');
  const child = runs.find((run) => run.id !== 'sub-agent-parent1');
  assert.equal(child?.parentId, 'sub-agent-parent1');
  assert.ok(events.some((event) => event.subAgentStatus === 'start' && event.subAgentTranscriptId));
});

test('release marks a run closed and the registry reports running children', async () => {
  await seed('sub-agent-release1');
  assert.equal(await releaseSubAgentRun('session-1', 'sub-agent-release1'), true);
  const record = await loadSubAgentRun('session-1', 'sub-agent-release1');
  assert.equal(record?.released, true, 'released flag persisted');
  assert.equal((await listSubAgentRuns('session-1'))[0].released, true, 'release visible in summaries');

  assert.equal(isSubAgentRunning('no-such-child'), false);
  assert.deepEqual(listRunningSubAgentIds(), []);
  assert.equal(abortSubAgentRun('no-such-child'), false);
});

test('invalid ids are rejected without throwing', async () => {
  const result = await runSubAgentFollowUp(makeClient([]), 'm', 'session-1', '../bad', 'x');
  assert.equal(result, null);
});
