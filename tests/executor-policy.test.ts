import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { executeToolCalls, type ToolExecutionContext } from '../src/agentic-loop/executor.js';
import type { AgentEvent } from '../src/agentic-loop.js';
import { registerDynamicHandler, unregisterDynamicHandler } from '../src/tools/index.js';
import { setAllowedPathRoots } from '../src/utils/path-validation.js';
import { setDangerouslySkipPermissions } from '../src/utils/approval.js';
import { clearReadState } from '../src/utils/read-state.js';
import { parseRuleSet } from '../src/utils/permission-rules.js';

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionId: `executor-policy-${Math.random().toString(36).slice(2)}`,
    requestDefaults: {},
    client: {} as any,
    model: 'test-model',
    ...overrides,
  };
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

function collect() {
  const events: AgentEvent[] = [];
  return { events, onEvent: (event: AgentEvent) => { events.push(event); } };
}

async function sandbox<T>(fn: (dir: string, rel: (name: string) => string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitacode-executor-'));
  const savedData = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(dir, 'data');
  await setAllowedPathRoots([dir]);
  setDangerouslySkipPermissions(true);
  try {
    return await fn(dir, (name: string) => path.relative(process.cwd(), path.join(dir, name)));
  } finally {
    setDangerouslySkipPermissions(false);
    if (savedData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedData;
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('the write barrier applies writes in declaration order', async () => {
  await sandbox(async (dir, rel) => {
    const messages: any[] = [];
    const { onEvent } = collect();
    const target = rel('order.txt');
    const calls = [
      call('w1', 'write_file', { file_path: target, content: 'first' }),
      call('w2', 'write_file', { file_path: target, content: 'second' }),
    ];

    const result = await executeToolCalls(calls, messages, onEvent, makeContext());
    assert.deepEqual(result, { completed: true, shouldAbort: false });
    assert.equal(await fsp.readFile(path.join(dir, 'order.txt'), 'utf8'), 'second');
    assert.deepEqual(messages.map((message) => message.tool_call_id), ['w1', 'w2']);
    assert.match(messages[0].content, /first|Wrote|wrote/);
  });
});

test('read dedupe returns a stub the second time a file is read', async () => {
  await sandbox(async (dir, rel) => {
    const file = path.join(dir, 'dedupe.ts');
    await fsp.writeFile(file, 'export const a = 1;\n');
    const target = rel('dedupe.ts');
    const context = makeContext();

    const first: any[] = [];
    await executeToolCalls([call('r1', 'read_file', { file_path: target })], first, collect().onEvent, context);
    assert.match(first[0].content, /export const a = 1/);

    const second: any[] = [];
    await executeToolCalls([call('r2', 'read_file', { file_path: target })], second, collect().onEvent, context);
    assert.match(second[0].content, /File unchanged since your last read/);

    const forced: any[] = [];
    await executeToolCalls([call('r3', 'read_file', { file_path: target, full: true })], forced, collect().onEvent, context);
    assert.match(forced[0].content, /export const a = 1/, 'full: true bypasses the stub');
  });
});

test('the read guard refuses to edit a file that was never read', async () => {
  await sandbox(async (dir, rel) => {
    const file = path.join(dir, 'guard.txt');
    await fsp.writeFile(file, 'original\n');
    const target = file;
    const context = makeContext({
      policy: { guardUnreadEdits: true, cwd: dir },
    });
    clearReadState(context.sessionId);

    const blocked: any[] = [];
    await executeToolCalls(
      [call('e1', 'edit_file', { file_path: target, old_string: 'original', new_string: 'changed' })],
      blocked,
      collect().onEvent,
      context,
    );
    assert.match(blocked[0].content, /refusing to modify/);
    assert.equal(await fsp.readFile(file, 'utf8'), 'original\n');

    await executeToolCalls([call('r1', 'read_file', { file_path: target })], [], collect().onEvent, context);
    const allowed: any[] = [];
    await executeToolCalls(
      [call('e2', 'edit_file', { file_path: target, old_string: 'original', new_string: 'changed' })],
      allowed,
      collect().onEvent,
      context,
    );
    assert.doesNotMatch(allowed[0].content, /refusing to modify/);
    assert.equal(await fsp.readFile(file, 'utf8'), 'changed\n');
  });
});

test('a deny rule blocks the call before it can run', async () => {
  await sandbox(async (dir) => {
    const messages: any[] = [];
    const context = makeContext({
      policy: { permissionRules: parseRuleSet({ deny: ['bash(cat *)'] }), cwd: dir },
    });
    await executeToolCalls([call('b1', 'bash', { command: 'cat /etc/hostname' })], messages, collect().onEvent, context);
    assert.match(messages[0].content, /blocked by permission rule "bash\(cat \*\)"/);
  });
});

test('a blocking PreToolUse hook stops the call with the hook reason', async () => {
  await sandbox(async (dir) => {
    const messages: any[] = [];
    const context = makeContext({
      policy: {
        cwd: dir,
        hooks: [{ event: 'PreToolUse', command: 'exit 2', timeoutMs: 5_000, source: 'test' }],
      },
    });
    await executeToolCalls([call('x1', 'bash', { command: 'echo hi' })], messages, collect().onEvent, context);
    assert.match(messages[0].content, /blocked by a PreToolUse hook/);
  });
});

test('oversized tool output spills to disk instead of filling the context', async () => {
  await sandbox(async (dir) => {
    const name = 'executor-spill-handler';
    registerDynamicHandler(name, async () => `head\n${'y'.repeat(40_000)}\ntail\n`);
    try {
      const messages: any[] = [];
      const context = makeContext({ policy: { cwd: dir, spillToolResults: true } });
      await executeToolCalls([call('s1', name, {})], messages, collect().onEvent, context);
      assert.match(messages[0].content, /full output saved/);
      assert.ok(messages[0].content.length < 40_000, 'the message is a preview, not the payload');
    } finally {
      unregisterDynamicHandler(name);
    }
  });
});

test('postcondition notes are appended to mutating results', async () => {
  await sandbox(async (dir, rel) => {
    const messages: any[] = [];
    const context = makeContext({ policy: { cwd: dir, verifyPostconditions: true } });
    await executeToolCalls(
      [call('v1', 'write_file', { file_path: path.join(dir, 'verified.txt'), content: 'hello there, content line\n' })],
      messages,
      collect().onEvent,
      context,
    );
    assert.match(messages[0].content, /\[postcondition\] verified:/);
  });
});

test('unreadable tool output from a dynamic handler is reported, not thrown', async () => {
  await sandbox(async () => {
    const name = 'executor-throwing-handler';
    registerDynamicHandler(name, async () => {
      throw new Error('handler exploded');
    });
    try {
      const messages: any[] = [];
      await executeToolCalls([call('t1', name, {})], messages, collect().onEvent, makeContext());
      assert.match(messages[0].content, /^Error: handler exploded/);
    } finally {
      unregisterDynamicHandler(name);
    }
  });
});
