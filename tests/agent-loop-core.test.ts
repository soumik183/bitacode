import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgenticLoop, type AgentEvent } from '../src/agentic-loop.js';

/** Minimal OpenAI-shaped client: chat.completions.create resolves to an async stream. */
function makeClient(create: (...args: any[]) => any): any {
  return { chat: { completions: { create } } };
}

async function* streamOf(chunks: any[]) {
  for (const chunk of chunks) yield chunk;
}

const textStream = (text: string) =>
  streamOf([{ choices: [{ delta: { content: text } }] }]);

const toolCallChunk = (calls: any[]) => ({
  choices: [{ delta: { tool_calls: calls } }],
});

test('a throwing onEvent handler does not stop the loop from completing', async () => {
  const client = makeClient(async () => textStream('hello'));

  const seen: string[] = [];
  const throwOnceThenCount = (e: AgentEvent) => {
    seen.push(e.type);
    throw new Error('UI listener exploded');
  };

  const result = await runAgenticLoop(client, 'model', [], 'ignored', throwOnceThenCount, {});

  assert.ok(seen.length > 0, 'handler was invoked at least once');
  assert.ok(seen.includes('done'), 'done event was attempted despite the throwing handler');
  assert.ok(
    result.some((m) => m.role === 'assistant' && (m.content as string)?.includes('hello')),
    'loop returned the assistant message'
  );
});

test('timeoutMs: 0 preserves the normal plain-text completion', async () => {
  const client = makeClient(async () => textStream('ok'));
  const events: AgentEvent[] = [];

  const result = await runAgenticLoop(client, 'model', [], '', (e) => events.push(e), {
    timeoutMs: 0,
  });

  assert.ok(events.some((e) => e.type === 'done'));
  assert.ok(!events.some((e) => e.type === 'error' && /timed out/i.test(e.error || '')));
  assert.ok(result.some((m) => m.role === 'assistant'));
});

test('a tiny timeout ends a stalled loop promptly with a transient error', async () => {
  const client = makeClient(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return streamOf([
      toolCallChunk([
        { index: 0, id: 'call_timeout', function: { name: 'todo_read', arguments: '{}' } },
      ]),
    ]);
  });

  const events: AgentEvent[] = [];
  const start = Date.now();
  const result = await runAgenticLoop(client, 'model', [], '', (e) => events.push(e), {
    timeoutMs: 20,
    maxIterations: 5,
  });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2000, `loop should end promptly, took ${elapsed}ms`);
  const timeout = events.find((e) => e.type === 'error' && /timed out/i.test(e.error || ''));
  assert.ok(timeout, 'timeout error event emitted');
  assert.equal(timeout!.transient, true);
  assert.ok(events.some((e) => e.type === 'done'), 'done emitted after timeout');
  assert.ok(Array.isArray(result));
});

test('duplicate tool_call ids are deduped before execution', async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls++;
    if (calls === 1) {
      return streamOf([
        toolCallChunk([
          { index: 0, id: 'dupe-id', function: { name: 'todo_read', arguments: '{}' } },
          { index: 1, id: 'dupe-id', function: { name: 'todo_read', arguments: '{}' } },
        ]),
      ]);
    }
    return textStream('done');
  });

  const events: AgentEvent[] = [];
  const result = await runAgenticLoop(client, 'model', [], '', (e) => events.push(e), {});

  const running = events.filter((e) => e.type === 'tool_call' && e.toolCall?.status === 'running');
  assert.equal(running.length, 1, 'only one tool call executed after dedupe');
  const toolResults = result.filter((m) => m.role === 'tool');
  assert.equal(toolResults.length, 1, 'only one tool result message');
});
