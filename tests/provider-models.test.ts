import test from 'node:test';
import assert from 'node:assert/strict';
import type { OpenAI } from 'openai';
import { formatContextWindow, listProviderModels } from '../src/utils/provider-models.js';

function fakeClient(models: unknown[] | (() => never)): OpenAI {
  return {
    models: {
      list: async () => {
        if (typeof models === 'function') models();
        return { data: models };
      },
    },
  } as unknown as OpenAI;
}

test('listProviderModels maps live models, hides non-chat families and dedupes', async () => {
  const client = fakeClient([
    { id: 'gpt-5.4' },
    { id: 'text-embedding-3-small' },
    { id: 'gpt-5.4', name: 'duplicate' },
    { id: 'acme/chat', name: 'Acme Chat', context_window: 200_000 },
    { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B Instruct' },
  ]);

  const result = await listProviderModels(client, 'openai', { useCache: false });

  assert.equal(result.error, null);
  assert.equal(result.authError, false);
  const ids = result.items.map((item) => item.id);
  for (const remoteId of ['acme/chat', 'gpt-5.4', 'meta-llama/llama-3.1-70b-instruct']) {
    assert.ok(ids.includes(remoteId), `${remoteId} is listed`);
  }
  assert.ok(!ids.includes('text-embedding-3-small'), 'non-chat families are hidden');
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.equal(result.items.find((item) => item.id === 'gpt-5.4')?.label, 'GPT-5.4');
  assert.equal(result.items.find((item) => item.id === 'acme/chat')?.description, '200k ctx');
});

test('listProviderModels flags rejected keys, including 400 responses', async () => {
  const client = fakeClient(() => {
    throw Object.assign(new Error('Please pass a valid API key'), { status: 400 });
  });

  const result = await listProviderModels(client, 'google', { useCache: false });

  assert.equal(result.authError, true);
  assert.match(result.error ?? '', /valid API key/);
  // The picker still needs something to show, so the built-in list is kept.
  assert.ok(result.items.length > 0);
});

test('formatContextWindow keeps compact labels', () => {
  assert.equal(formatContextWindow(1_048_576), '1M ctx');
  assert.equal(formatContextWindow(200_000), '200k ctx');
  assert.equal(formatContextWindow(0), undefined);
});
