import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { executeToolCalls, type ToolExecutionContext } from '../src/agentic-loop/executor.js';
import type { AgentEvent } from '../src/agentic-loop.js';
import { registerDynamicHandler, unregisterDynamicHandler } from '../src/tools/index.js';
import { setDangerouslySkipPermissions } from '../src/utils/approval.js';
import { clearCheckpoints, listCheckpoints } from '../src/utils/checkpoint.js';

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionId: `tool-executor-test-${Math.random().toString(36).slice(2)}`,
    requestDefaults: {},
    client: {} as any,
    model: 'test-model',
    ...overrides,
  };
}

function collectEvents() {
  const events: AgentEvent[] = [];
  return { events, onEvent: (event: AgentEvent) => { events.push(event); } };
}

function toolMessages(messages: any[]): any[] {
  return messages.filter((m) => m.role === 'tool');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('malformed tool call with no function produces an error tool result and does not throw', async () => {
  const messages: any[] = [];
  const { events, onEvent } = collectEvents();
  const calls = [
    { id: 'call-bad', type: 'function' }, // no function block
    { id: 'call-ok', type: 'function', function: { name: 'todo_read', arguments: '{}' } },
  ];

  const result = await executeToolCalls(calls, messages, onEvent, makeContext());

  assert.deepEqual(result, { completed: true, shouldAbort: false });
  const results = toolMessages(messages);
  assert.equal(results.length, 2, 'one tool result per call');
  assert.equal(results[0].tool_call_id, 'call-bad');
  assert.equal(results[0].content, 'Error: malformed tool call');
  assert.match(results[1].content, /TODO List/, 'later valid call still executed');

  const errors = events.filter((e) => e.type === 'tool_result' && e.toolCall?.status === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].toolCall?.id, 'call-bad');
  assert.equal(errors[0].toolCall?.status, 'error');
  assert.equal(typeof errors[0].toolCall?.result, 'string');
});

test('non-string function fields are rejected as malformed tool calls', async () => {
  const messages: any[] = [];
  const { events, onEvent } = collectEvents();
  const calls = [
    { id: 'c1', type: 'function', function: { name: 123, arguments: '{}' } },
    { id: 'c2', type: 'function', function: { name: 'todo_read', arguments: 5 } },
    { id: 'c3', type: 'function', function: { name: '   ', arguments: '{}' } },
  ];

  const result = await executeToolCalls(calls, messages, onEvent, makeContext());

  assert.deepEqual(result, { completed: true, shouldAbort: false });
  const results = toolMessages(messages);
  assert.equal(results.length, 3);
  for (const msg of results) {
    assert.equal(msg.content, 'Error: malformed tool call');
  }
  assert.equal(events.filter((e) => e.type === 'tool_result' && e.toolCall?.status === 'error').length, 3);
});

test('arguments that is not valid JSON produces an error tool result', async () => {
  const messages: any[] = [];
  const { events, onEvent } = collectEvents();
  const calls = [
    { id: 'call-json', type: 'function', function: { name: 'todo_read', arguments: '{not json' } },
  ];

  const result = await executeToolCalls(calls, messages, onEvent, makeContext());

  assert.deepEqual(result, { completed: true, shouldAbort: false });
  const results = toolMessages(messages);
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_call_id, 'call-json');
  assert.match(results[0].content, /^Error: /);
  assert.equal(typeof results[0].content, 'string');

  const error = events.find((e) => e.type === 'tool_result' && e.toolCall?.status === 'error');
  assert.ok(error);
  assert.equal(error!.toolCall?.id, 'call-json');
  assert.equal(typeof error!.toolCall?.result, 'string');
});

test('successful call pushes one tool result and emits a done event', async () => {
  const messages: any[] = [];
  const { events, onEvent } = collectEvents();
  const calls = [
    { id: 'call-ok', type: 'function', function: { name: 'todo_read', arguments: '{}' } },
  ];

  const result = await executeToolCalls(calls, messages, onEvent, makeContext());

  assert.deepEqual(result, { completed: true, shouldAbort: false });
  const results = toolMessages(messages);
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_call_id, 'call-ok');
  assert.equal(typeof results[0].content, 'string');

  const running = events.filter((e) => e.type === 'tool_call' && e.toolCall?.status === 'running');
  assert.equal(running.length, 1);
  assert.equal(running[0].toolCall?.id, 'call-ok');
  const done = events.filter((e) => e.type === 'tool_result' && e.toolCall?.status === 'done');
  assert.equal(done.length, 1);
  assert.equal(done[0].toolCall?.id, 'call-ok');
  assert.equal(typeof done[0].toolCall?.result, 'string');
});

test('abort after one call injects stubs for the remaining pending ids', async () => {
  const controller = new AbortController();
  const handlerName = 'executor-abort-test-handler';
  registerDynamicHandler(handlerName, async () => {
    controller.abort();
    return 'first call done';
  });

  try {
    const messages: any[] = [];
    const { events, onEvent } = collectEvents();
    const calls = [
      { id: 'call-1', type: 'function', function: { name: handlerName, arguments: '{}' } },
      { id: 'call-2', type: 'function', function: { name: 'todo_read', arguments: '{}' } },
      { id: 'call-3', type: 'function', function: { name: 'todo_read', arguments: '{}' } },
    ];

    const result = await executeToolCalls(calls, messages, onEvent, makeContext({ abortSignal: controller.signal }));

    assert.deepEqual(result, { completed: false, shouldAbort: true });
    const results = toolMessages(messages);
    assert.equal(results.length, 3);
    assert.equal(results[0].content, 'first call done');
    assert.equal(results[1].tool_call_id, 'call-2');
    assert.equal(results[1].content, 'Aborted by user.');
    assert.equal(results[2].tool_call_id, 'call-3');
    assert.equal(results[2].content, 'Aborted by user.');
    // The first call finished normally; no error event should exist for it.
    assert.equal(events.filter((e) => e.type === 'tool_result' && e.toolCall?.status === 'error').length, 0);
  } finally {
    unregisterDynamicHandler(handlerName);
  }
});

test('mutating tool calls are checkpointed before they run', async () => {
  const sessionId = `executor-cp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dir = path.join(process.cwd(), 'tests', 'tmp-executor-checkpoint');
  const file = path.join(dir, `${sessionId}.txt`);
  const rel = path.relative(process.cwd(), file);

  setDangerouslySkipPermissions(true);
  try {
    const messages: any[] = [];
    const { onEvent } = collectEvents();
    const calls = [
      { id: 'cp-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ file_path: rel, content: 'hello' }) } },
    ];

    const result = await executeToolCalls(calls, messages, onEvent, makeContext({ sessionId }));

    assert.deepEqual(result, { completed: true, shouldAbort: false });
    const checkpoints = await listCheckpoints(sessionId);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].path, rel);
    assert.equal(checkpoints[0].content, null);
    assert.equal(checkpoints[0].tool, 'write_file');
    assert.equal(await fsp.readFile(file, 'utf8'), 'hello');
  } finally {
    setDangerouslySkipPermissions(false);
    await clearCheckpoints(sessionId);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('independent calls execute concurrently', async () => {
  const handlerName = 'executor-concurrent-handler';
  const gate = deferred<string>();
  const started: string[] = [];
  registerDynamicHandler(handlerName, async (args: any) => {
    started.push(args.tag);
    return await gate.promise;
  });

  try {
    const messages: any[] = [];
    const { onEvent } = collectEvents();
    const calls = [
      { id: 'a', type: 'function', function: { name: handlerName, arguments: JSON.stringify({ tag: 'a' }) } },
      { id: 'b', type: 'function', function: { name: handlerName, arguments: JSON.stringify({ tag: 'b' }) } },
    ];

    const running = executeToolCalls(calls, messages, onEvent, makeContext());
    await flush();
    // Both handlers started while neither had finished — sequential execution would stall here.
    assert.deepEqual(started.sort(), ['a', 'b']);

    gate.resolve('ok');
    assert.deepEqual(await running, { completed: true, shouldAbort: false });
  } finally {
    unregisterDynamicHandler(handlerName);
  }
});

test('tool results and events stay in original order when later calls finish first', async () => {
  const handlerName = 'executor-order-handler';
  const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
  registerDynamicHandler(handlerName, async (args: any) => gates[args.i].promise);

  try {
    const messages: any[] = [];
    const { events, onEvent } = collectEvents();
    const calls = [0, 1, 2].map((i) => ({
      id: `c${i}`,
      type: 'function',
      function: { name: handlerName, arguments: JSON.stringify({ i }) },
    }));

    const running = executeToolCalls(calls, messages, onEvent, makeContext());
    await flush();
    gates[2].resolve('two');
    gates[1].resolve('one');
    gates[0].resolve('zero');
    assert.deepEqual(await running, { completed: true, shouldAbort: false });

    const results = toolMessages(messages);
    assert.deepEqual(results.map((r) => r.tool_call_id), ['c0', 'c1', 'c2']);
    assert.deepEqual(results.map((r) => r.content), ['zero', 'one', 'two']);

    const done = events.filter((e) => e.type === 'tool_result' && e.toolCall?.status === 'done');
    assert.deepEqual(done.map((e) => e.toolCall!.id), ['c0', 'c1', 'c2']);
  } finally {
    unregisterDynamicHandler(handlerName);
  }
});

test('a failing tool produces a concise error result and does not abort later calls', async () => {
  const handlerName = 'executor-throw-handler';
  registerDynamicHandler(handlerName, async () => {
    throw new Error('boom from tool');
  });

  try {
    const messages: any[] = [];
    const { onEvent } = collectEvents();
    const calls = [
      { id: 'c-fail', type: 'function', function: { name: handlerName, arguments: '{}' } },
      { id: 'c-ok', type: 'function', function: { name: 'todo_read', arguments: '{}' } },
    ];

    const result = await executeToolCalls(calls, messages, onEvent, makeContext());
    assert.deepEqual(result, { completed: true, shouldAbort: false });
    const results = toolMessages(messages);
    assert.equal(results.length, 2);
    assert.match(results[0].content, /^Error: /);
    assert.match(results[0].content, /boom from tool/);
    assert.match(results[1].content, /TODO List/, 'a failing tool never aborts the rest');
  } finally {
    unregisterDynamicHandler(handlerName);
  }
});

test('abort stops remaining chunks and injects stubs for unlaunched calls', async () => {
  const controller = new AbortController();
  const handlerName = 'executor-abort-chunks-handler';
  const executed: string[] = [];
  registerDynamicHandler(handlerName, async (args: any) => {
    executed.push(args.tag);
    if (args.tag === 'first') controller.abort();
    return `done-${args.tag}`;
  });

  try {
    const messages: any[] = [];
    const { onEvent } = collectEvents();
    const tags = ['first', 'second', 'third', 'fourth', 'fifth']; // 5 calls -> 2 chunks of 4
    const calls = tags.map((tag) => ({
      id: tag,
      type: 'function',
      function: { name: handlerName, arguments: JSON.stringify({ tag }) },
    }));

    const result = await executeToolCalls(calls, messages, onEvent, makeContext({ abortSignal: controller.signal }));

    assert.deepEqual(result, { completed: false, shouldAbort: true });
    assert.deepEqual(executed, ['first'], 'abort before a call prevents it from launching');
    const results = toolMessages(messages);
    assert.equal(results.length, 5);
    assert.equal(results[0].tool_call_id, 'first');
    assert.equal(results[0].content, 'done-first');
    for (let i = 1; i < tags.length; i++) {
      assert.equal(results[i].tool_call_id, tags[i]);
      assert.equal(results[i].content, 'Aborted by user.');
    }
  } finally {
    unregisterDynamicHandler(handlerName);
  }
});
