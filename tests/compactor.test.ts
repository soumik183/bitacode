import test from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import { compactIfNeeded } from '../src/utils/compactor.js';

test('compactIfNeeded forwards request defaults to compaction request', async () => {
  let captured: Record<string, unknown> | null = null;

  const client = {
    chat: {
      completions: {
        create: async (payload: Record<string, unknown>) => {
          captured = payload;
          return {
            choices: [
              {
                message: {
                  content: '<state_snapshot>summary</state_snapshot>',
                },
              },
            ],
          };
        },
      },
    },
  } as unknown as OpenAI;

  const messages = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: 'four' },
    { role: 'user', content: 'five' },
    { role: 'assistant', content: 'six' },
  ] satisfies OpenAI.Chat.Completions.ChatCompletionMessageParam[];

  await compactIfNeeded(client, 'test-model', messages, 10, { top_p: 0.2, temperature: 0.7 });

  assert.ok(captured);
  const request = captured as Record<string, unknown>;
  assert.equal(request.top_p, 0.2);
  assert.equal(request.temperature, 0.1);
});

// ── Regression: compaction must never emit an orphan tool message ────────────
// Cutting the tail by message count used to split an assistant message from its
// tool results, which providers reject with 400 (and old code then emptied the
// whole history).

function stubClient(summary = '<state_snapshot>summary</state_snapshot>'): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: summary } }] }),
      },
    },
  } as unknown as OpenAI;
}

function roles(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): string {
  return messages.map((message) => message.role).join(',');
}

test('compaction keeps every tool result attached to its assistant message', async () => {
  const calls = [1, 2, 3, 4, 5].map((n) => ({
    id: `call-${n}`,
    type: 'function' as const,
    function: { name: 'read_file', arguments: '{}' },
  }));
  const messages = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'do five reads' },
    { role: 'assistant', content: null, tool_calls: calls },
    ...calls.map((call) => ({ role: 'tool' as const, tool_call_id: call.id, content: 'ok' })),
    { role: 'user', content: 'thanks' },
  ] satisfies OpenAI.Chat.Completions.ChatCompletionMessageParam[];

  const compacted = await compactIfNeeded(
    stubClient(),
    'test-model',
    messages,
    10 // tiny window: compaction always runs
  );

  const toolIds = new Set(
    compacted
      .filter((message: any) => message.role === 'assistant')
      .flatMap((message: any) => (message.tool_calls ?? []).map((call: any) => call.id))
  );
  for (const message of compacted as any[]) {
    if (message.role !== 'tool') continue;
    assert.ok(
      toolIds.has(message.tool_call_id),
      `tool result ${message.tool_call_id} has no assistant message (roles: ${roles(compacted)})`
    );
  }
  assert.match(roles(compacted), /^system,system/);
  assert.ok(compacted.length >= 3, 'compaction must keep a usable conversation');
});

test('compaction drops a skill tool message whose parent assistant message is gone', async () => {
  const messages = [
    { role: 'system', content: 'system prompt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'skill-call',
          type: 'function' as const,
          function: { name: 'skill', arguments: '{"name":"x"}' },
        },
      ],
    },
    { role: 'tool' as const, tool_call_id: 'skill-call', content: '<skill_content name="x">rules</skill_content>' },
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: 'four' },
    { role: 'user', content: 'five' },
  ] satisfies OpenAI.Chat.Completions.ChatCompletionMessageParam[];

  const compacted = await compactIfNeeded(stubClient(), 'test-model', messages, 10);
  const orphan = (compacted as any[]).find(
    (message) => message.role === 'tool' && !(message.tool_call_id && message.tool_call_id.startsWith('skill-call'))
  );
  assert.equal(orphan, undefined);
  for (const message of compacted as any[]) {
    if (message.role === 'tool') {
      assert.ok(
        (compacted as any[]).some(
          (other) => other.role === 'assistant' && (other.tool_calls ?? []).some((call: any) => call.id === message.tool_call_id)
        ),
        `orphan tool message ${message.tool_call_id}`
      );
    }
  }
});

test('an empty history is never returned as a "compacted" result', async () => {
  const messages = [{ role: 'system', content: 'system prompt' }] satisfies OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  const compacted = await compactIfNeeded(stubClient(''), 'test-model', messages, 10);
  assert.equal(compacted, messages, 'returns the input by identity, so callers know nothing changed');
});
