import test from 'node:test';
import assert from 'node:assert/strict';
import { processStream } from '../src/agentic-loop/stream.js';

async function* streamOf(chunks: any[]) {
  for (const chunk of chunks) yield chunk;
}

const CAP = 100_000;

test('processStream caps accumulated reasoning at the limit', async () => {
  const result = await processStream(
    streamOf([
      { choices: [{ delta: { reasoning: 'x'.repeat(CAP + 500) } }] },
      { choices: [{ delta: { reasoning: 'more' } }] },
    ]),
    [],
    'model',
    undefined,
    () => {}
  );

  assert.equal(result.assistantMessage.reasoning?.length, CAP);
});

test('processStream emits exactly one transient error for a refusal', async () => {
  const events: any[] = [];
  await processStream(
    streamOf([
      { choices: [{ delta: { refusal: 'I cannot help with that.' } }] },
      { choices: [{ delta: { refusal: 'I cannot help with that.' } }] },
      { choices: [{ delta: { content: '' } }] },
    ]),
    [],
    'model',
    undefined,
    (e) => events.push(e)
  );

  const errors = events.filter((e) => e.type === 'error' && e.transient);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, 'I cannot help with that.');
});

test("processStream emits exactly one transient warning for finish_reason 'length'", async () => {
  const events: any[] = [];
  await processStream(
    streamOf([
      { choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]),
    [],
    'model',
    undefined,
    (e) => events.push(e)
  );

  const warnings = events.filter(
    (e) => e.type === 'error' && e.transient && /truncat/i.test(e.error || '')
  );
  assert.equal(warnings.length, 1);
});

test('processStream sanitizes malformed tool-call deltas', async () => {
  const result = await processStream(
    streamOf([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: -5,
                  id: 'call_1',
                  function: { name: 123, arguments: { bad: true } },
                  extra_content: { thought_signature: 'sig' },
                },
              ],
            },
          },
        ],
      },
    ]),
    [],
    'model',
    undefined,
    () => {}
  );

  assert.equal(result.hasToolCalls, true);
  const tc = result.assistantMessage.tool_calls[0];
  assert.ok(tc, 'tool call landed in slot 0');
  assert.equal(tc.id, 'call_1');
  assert.equal(tc.function.name, '');
  assert.equal(tc.function.arguments, '');
  assert.deepEqual(tc.extra_content, { thought_signature: 'sig' });
});

test('processStream still accumulates normal text and reasoning', async () => {
  const events: any[] = [];
  const result = await processStream(
    streamOf([
      { choices: [{ delta: { reasoning_content: 'first thought ' } }] },
      { choices: [{ delta: { reasoning: 'second thought' } }] },
      { choices: [{ delta: { content: 'answer' } }] },
    ]),
    [],
    'model',
    undefined,
    (e) => events.push(e)
  );

  assert.equal(result.assistantMessage.reasoning, 'first thought second thought');
  assert.equal(result.assistantMessage.content, 'answer');
  assert.ok(events.some((e) => e.type === 'text_delta' && e.content === 'answer'));
  assert.equal(events.filter((e) => e.type === 'reasoning_delta').length, 2);
});
