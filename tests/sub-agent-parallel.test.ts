import test from 'node:test';
import assert from 'node:assert/strict';
import {
  subAgentTool,
  runSubAgent,
  runParallel,
  type SubAgentProgressEvent,
} from '../src/sub-agent.js';
import { getAllTools } from '../src/tools/index.js';

/** Minimal OpenAI-shaped client that answers from its own message history. */
function makeClient(options: { withToolCall?: boolean } = {}): { client: any; calls: string[] } {
  const calls: string[] = [];
  const client = {
    chat: {
      completions: {
        create: async (params: any) => {
          const task: string = params.messages.find((m: any) => m.role === 'user')?.content ?? '';
          calls.push(task);
          const isFirstForTask = options.withToolCall && calls.filter((c) => c === task).length === 1;
          return (async function* () {
            if (isFirstForTask) {
              yield {
                choices: [{ delta: { tool_calls: [{
                  index: 0, id: `call-${calls.length}`, type: 'function',
                  function: { name: 'todo_read', arguments: '{}' },
                }] } }],
              };
            } else {
              yield { choices: [{ delta: { content: `answer: ${task}` } }] };
            }
            yield {
              choices: [{ delta: {} }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          })();
        },
      },
    },
  };
  return { client, calls };
}

test('sub_agent schema exposes tasks and keeps task; children cannot nest sub_agent', () => {
  const props: any = subAgentTool.function.parameters.properties;
  assert.ok(props.task, 'legacy task parameter preserved');
  assert.equal(props.tasks.type, 'array');
  assert.equal(props.tasks.items.type, 'string');
  assert.ok(!getAllTools().some((t: any) => t.function?.name === 'sub_agent'));
});

test('runParallel runs every task and returns ordered results with stable ids', async () => {
  const seen: string[] = [];
  const results = await runParallel(['a', 'b', 'c'], async (task, _index, id) => {
    seen.push(`${id}:${task}`);
    return task.toUpperCase();
  });
  assert.equal(seen.length, 3);
  assert.deepEqual(results.map((r) => r.id), ['sa-1', 'sa-2', 'sa-3']);
  assert.deepEqual(results.map((r) => r.value), ['A', 'B', 'C']);
  assert.ok(results.every((r) => r.status === 'fulfilled'));
});

test('runParallel respects the concurrency cap', async () => {
  let active = 0;
  let maxActive = 0;
  await runParallel(
    ['1', '2', '3', '4', '5'],
    async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    },
    2,
  );
  assert.equal(maxActive, 2);
});

test('runParallel clamps the cap to the max of 5', async () => {
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 8 }, (_, i) => String(i));
  await runParallel(
    tasks,
    async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    },
    99,
  );
  assert.equal(maxActive, 5);
});

test('runParallel keeps going when one task rejects (allSettled)', async () => {
  const results = await runParallel(['ok', 'bad', 'ok2'], async (task) => {
    if (task === 'bad') throw new Error('boom');
    return task;
  });
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].status, 'fulfilled');
  assert.match(String(results[1].reason), /boom/);
});

test('runParallel stops launching tasks after abort', async () => {
  const controller = new AbortController();
  const started: string[] = [];
  const results = await runParallel(
    ['a', 'b', 'c', 'd'],
    async (task) => {
      started.push(task);
      if (task === 'a') controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      return task;
    },
    1,
    controller.signal,
  );
  assert.deepEqual(started, ['a']);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'skipped', 'skipped', 'skipped']);
});

test('single task still works and emits legacy tool progress events', async () => {
  const { client } = makeClient({ withToolCall: true });
  const events: SubAgentProgressEvent[] = [];
  const result = await runSubAgent(client, 'test-model', 'solo task', 500, {}, (e) => events.push(e));

  assert.match(result.response, /answer: solo task/);
  assert.equal(result.usage.inputTokens, 20);
  assert.equal(result.usage.outputTokens, 10);

  const legacy = events.filter((e) => e.tool === 'todo_read');
  assert.ok(legacy.some((e) => e.status === 'running' && e.iteration === 0));
  assert.ok(legacy.some((e) => e.status === 'done'));
  assert.ok(legacy.every((e) => e.subAgentId === 'sa-1'));

  const starts = events.filter((e) => e.subAgentStatus === 'start');
  const dones = events.filter((e) => e.subAgentStatus === 'done');
  assert.equal(starts.length, 1);
  assert.equal(dones.length, 1);
  assert.equal(starts[0].subAgentId, 'sa-1');
  assert.equal(starts[0].subAgentTask, 'solo task');
  assert.equal(starts[0].subAgentLabel, 'Task 1/1');
});

test('tasks array fans out with two start and two done events with distinct ids', async () => {
  const { client } = makeClient();
  const events: SubAgentProgressEvent[] = [];
  const result = await runSubAgent(
    client, 'test-model', ['task A', 'task B'], 500, {}, (e) => events.push(e),
  );

  const starts = events.filter((e) => e.subAgentStatus === 'start');
  const dones = events.filter((e) => e.subAgentStatus === 'done');
  assert.equal(starts.length, 2);
  assert.equal(dones.length, 2);
  // Children run concurrently, so event arrival order is not deterministic —
  // compare sets of ids instead of relying on sa-1 arriving before sa-2.
  assert.deepEqual(new Set(starts.map((e) => e.subAgentId)), new Set(['sa-1', 'sa-2']));
  assert.deepEqual(new Set(dones.map((e) => e.subAgentId)), new Set(['sa-1', 'sa-2']));
  assert.equal(new Set(starts.map((e) => e.subAgentId)).size, 2);
  assert.deepEqual(new Set(starts.map((e) => e.subAgentLabel)), new Set(['Task 1/2', 'Task 2/2']));

  assert.match(result.response, /Task 1 \(sa-1\): task A/);
  assert.match(result.response, /Task 2 \(sa-2\): task B/);
  assert.match(result.response, /answer: task A/);
  assert.match(result.response, /answer: task B/);
  assert.equal(result.usage.inputTokens, 20);
  assert.equal(result.usage.totalTokens, 30);
  assert.equal(result.usage.estimatedCost, 0);
});
