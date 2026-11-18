import test from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import { sanitizeMessagesForProvider } from '../src/utils/message-sanitize.js';
import { compactIfNeeded } from '../src/utils/compactor.js';
import { runAgenticLoop } from '../src/agentic-loop.js';
import { runSubAgent } from '../src/sub-agent.js';

function isProviderSafe(message: any): boolean {
  return !('reasoning' in message)
    && !('subAgentActivities' in message)
    && !Object.keys(message).some((key) => /^bitacode/i.test(key));
}

test('sanitizer removes UI-only fields from every role but keeps provider fields', () => {
  const extraContent = { reasoning: { format: 'text' } };
  const input: any[] = [
    { role: 'system', content: 'sys', reasoning: 'sys thought', bitacodeTag: 'x' },
    { role: 'user', content: 'hi', subAgentActivities: [], bitacodeMeta: 1 },
    {
      role: 'assistant',
      content: 'answer',
      reasoning: 'secret chain of thought',
      bitacodeTrace: { a: 1 },
      tool_calls: [{
        id: 'c1',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
        extra_content: extraContent,
      }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'ok', reasoning: 'tool thought' },
  ];

  const result = sanitizeMessagesForProvider(input as any);

  assert.equal(result.length, 4);
  assert.ok(result.every((m: any) => isProviderSafe(m)));
  const assistant = result[2] as any;
  assert.equal(assistant.content, 'answer');
  assert.equal(assistant.tool_calls[0].id, 'c1');
  assert.equal(assistant.tool_calls[0].function.name, 'read_file');
  assert.equal(assistant.tool_calls[0].function.arguments, '{}');
  assert.deepEqual(assistant.tool_calls[0].extra_content, extraContent);
  assert.equal((result[3] as any).tool_call_id, 'c1');
  // Input is not mutated in place.
  assert.ok('reasoning' in (input[2] as any));
});

test('sanitizer coerces tool message content to a string', () => {
  const result = sanitizeMessagesForProvider([
    { role: 'tool', tool_call_id: 'a', content: [{ type: 'text', text: 'hello' }] },
    { role: 'tool', tool_call_id: 'b', content: 42 },
    { role: 'tool', tool_call_id: 'c', content: null },
  ] as any) as any[];

  assert.deepEqual(result.map((m) => m.content), ['hello', '42', '']);
  assert.ok(result.every((m) => typeof m.content === 'string'));
});

test('sanitizer drops malformed, invalid-role and empty messages', () => {
  const result = sanitizeMessagesForProvider([
    null,
    undefined,
    42,
    'not a message',
    [],
    { role: 'wizard', content: 'bad role' },
    { content: 'no role' },
    { role: 'tool', content: 'orphan result without tool_call_id' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: '   ' },
    { role: 'user', content: 'keep me' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 't', arguments: '{}' } }] },
  ] as any) as any[];

  assert.deepEqual(result.map((m) => m.content), ['keep me', '']);
  assert.equal(result[1].tool_calls.length, 1);
});

test('sanitizer returns the original array by identity when nothing changes', () => {
  const clean = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo', tool_calls: [] },
  ] as any;
  assert.equal(sanitizeMessagesForProvider(clean), clean);
});

test('main loop never sends UI fields to the provider', async () => {
  let payload: any = null;
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          payload = request;
          // Abort-like error makes the loop return immediately without retries.
          throw new Error('Operation aborted');
        },
      },
    },
  } as unknown as OpenAI;

  const messages: any[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'previous answer', reasoning: 'secret', bitacodeMeta: 'x' },
  ];

  await runAgenticLoop(client, 'test-model', messages, 'hello', () => {});

  assert.ok(payload, 'the loop must have attempted a create call');
  assert.ok(payload.messages.every(isProviderSafe), 'no UI field reached the main create call');
});

test('compactor never sends UI fields to the provider', async () => {
  let payload: any = null;
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          payload = request;
          return { choices: [{ message: { content: '<state_snapshot>summary</state_snapshot>' } }] };
        },
      },
    },
  } as unknown as OpenAI;

  const messages: any[] = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 8; i++) {
    messages.push(i % 2 === 0
      ? { role: 'user', content: `msg-${i}`, bitacodeUi: true }
      : { role: 'assistant', content: `reply-${i}`, reasoning: 'secret', subAgentActivities: [] });
  }

  await compactIfNeeded(client, 'test-model', messages as any, 1);

  assert.ok(payload, 'compaction must have attempted a create call');
  assert.ok(payload.messages.every(isProviderSafe), 'no UI field reached the compaction create call');
});

test('sub-agent never sends UI fields to the provider', async () => {
  const payloads: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: any) => {
          payloads.push(request);
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                choices: [{ delta: { content: 'done' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              };
            },
          };
        },
      },
    },
  } as unknown as OpenAI;

  const result = await runSubAgent(client, 'test-model', 'do the thing', 1);

  assert.match(result.response, /done/);
  assert.ok(payloads.length > 0);
  assert.ok(
    payloads.every((payload) => payload.messages.every(isProviderSafe)),
    'no UI field reached the sub-agent create call'
  );
});
