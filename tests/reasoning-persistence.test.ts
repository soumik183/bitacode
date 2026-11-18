import test from 'node:test';
import assert from 'node:assert/strict';
import { processStream } from '../src/agentic-loop/stream.js';

async function* streamOf(chunks: any[]) {
  for (const chunk of chunks) yield chunk;
}

test('processStream keeps reasoning on the assistant message for replay', async () => {
  const result = await processStream(
    streamOf([
      { choices: [{ delta: { reasoning_content: 'first thought ' } }] },
      { choices: [{ delta: { reasoning: 'second thought' } }] },
      { choices: [{ delta: { content: 'answer' } }] },
    ]),
    [],
    'model',
    undefined,
    () => {}
  );

  assert.equal(result.assistantMessage.reasoning, 'first thought second thought');
  assert.equal(result.assistantMessage.content, 'answer');
});

test('processStream leaves reasoning unset when the provider sends none', async () => {
  const result = await processStream(
    streamOf([{ choices: [{ delta: { content: 'answer' } }] }]),
    [],
    'model',
    undefined,
    () => {}
  );
  assert.equal(result.assistantMessage.reasoning, undefined);
});
