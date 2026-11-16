import test from 'node:test';
import assert from 'node:assert/strict';
import { getAllProviders, getProvider } from '../src/providers/index.js';

test('OpenRouter is a built-in OpenAI-compatible provider', () => {
  const provider = getProvider('openrouter');
  assert.ok(provider, 'OpenRouter provider is registered');
  assert.equal(provider.baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(provider.apiKeyEnvVar, 'OPENROUTER_API_KEY');
  assert.ok(provider.models.length > 0);
  assert.ok(provider.models.every((model) => model.id.includes('/')));
});

test('the provider registry keeps built-ins unique', () => {
  const ids = getAllProviders().map((provider) => provider.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const expected of ['openai', 'anthropic', 'google', 'openrouter']) {
    assert.ok(ids.includes(expected), `missing built-in provider: ${expected}`);
  }
});
