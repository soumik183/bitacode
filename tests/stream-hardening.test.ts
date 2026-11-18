import test from 'node:test';
import assert from 'node:assert/strict';
import { processStream } from '../src/agentic-loop/stream.js';

async function* streamOf(chunks: any[]) {
  for (const chunk of chunks) yield chunk;
}

async function* throwingStream(chunks: any[], error: Error) {
  for (const chunk of chunks) yield chunk;
  throw error;
}

const NOOP = () => {};

test('alternate reasoning field names are emitted once when duplicated', async () => {
  const events: any[] = [];
  const result = await processStream(
    streamOf([
      {
        choices: [{
          delta: {
            reasoning_content: 'think',
            reasoning: 'think',
            reasoning_text: 'think',
            additional_kwargs: { reasoning_content: 'think' },
            delta: { reasoning_content: 'think' },
          },
        }],
      },
    ]),
    [], 'model', undefined, (e) => events.push(e)
  );

  const reasoning = events.filter((e) => e.type === 'reasoning_delta');
  assert.equal(reasoning.length, 1, 'same text under several names emits one event');
  assert.equal(reasoning[0].content, 'think');
  assert.equal(result.assistantMessage.reasoning, 'think');
});

test('tool calls arrive as an object map with prefixed ids and JSON fragments', async () => {
  const result = await processStream(
    streamOf([
      {
        choices: [{
          delta: {
            tool_calls: {
              '0': { id: 'functions.search:0', function: { name: 'search', arguments: '{"q":' } },
              '1': { id: 'call_calc_9', function: { name: 'calc', arguments: '{"x":1}' } },
            },
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"snow"}' } }],
          },
        }],
      },
    ]),
    [], 'model', undefined, NOOP
  );

  assert.equal(result.hasToolCalls, true);
  const [first, second] = result.assistantMessage.tool_calls;
  assert.equal(first.id, 'functions.search:0');
  assert.equal(first.function.name, 'search');
  assert.equal(first.function.arguments, '{"q":"snow"}');
  assert.equal(second.id, 'call_calc_9');
  assert.equal(second.function.arguments, '{"x":1}');
});

test('a chunk with no choices is ignored and a throwing stream returns partial content with one error', async () => {
  const events: any[] = [];
  const result = await processStream(
    throwingStream(
      [
        { choices: [{ delta: { content: 'partial' } }] },
        {}, // usage-only / malformed chunk with no choices
      ],
      new Error('connection reset')
    ),
    [], 'model', undefined, (e) => events.push(e)
  );

  assert.equal(result.assistantMessage.content, 'partial');
  const errors = events.filter((e) => e.type === 'error' && e.transient);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /connection reset/);
  assert.ok(events.some((e) => e.type === 'usage'), 'usage still emitted for partial result');
});

test('usage in variant shapes is accepted and last non-empty wins', async () => {
  const result = await processStream(
    streamOf([
      { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { choices: [{ delta: {} }], 'x-usage': { input_tokens: 99, output_tokens: 98 } },
      { choices: [{ delta: {} }], usage_metadata: { promptTokenCount: 12, candidatesTokenCount: 5, cachedContentTokenCount: 3 } },
    ]),
    [], 'model', undefined, NOOP
  );

  assert.equal(result.usage.inputTokens, 12, 'last non-empty usage wins');
  assert.equal(result.usage.outputTokens, 5);
});

test('streamed content is capped and emitted only up to the cap', async () => {
  const events: any[] = [];
  const result = await processStream(
    streamOf([
      { choices: [{ delta: { content: 'x'.repeat(1_000_100) } }] },
    ]),
    [], 'model', undefined, (e) => events.push(e)
  );

  assert.equal(result.assistantMessage.content.length, 1_000_000);
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.content).join('');
  assert.equal(text.length, 1_000_000);
});
