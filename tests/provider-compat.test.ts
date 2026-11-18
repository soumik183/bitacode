import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiKey } from '../src/config.js';
import { handleApiError, type RetryState } from '../src/agentic-loop/errors.js';
import {
  getAllProviders,
  getModelDetails,
  getModelPricing,
  getProvider,
  getProviderApiKeyEnvVars,
  getRequestDefaultParams,
} from '../src/providers/index.js';
import { getRuntimeConfig, resetRuntimeConfigForTests } from '../src/runtime-config.js';

const KEY_ENV_VARS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
  'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'OPENROUTER_API_KEY',
  'BITACODE_API_KEY', 'BITACODE_CUSTOM_HEADERS',
];

// getRuntimeConfig() returns the shared default object when no cache exists.
// Replacing (not mutating) its `providers` keeps the original safe to restore.
const originalProviders = getRuntimeConfig().providers;

function setRuntimeProviders(providers: Record<string, unknown>): void {
  getRuntimeConfig().providers = providers as any;
}

test.afterEach(() => {
  for (const key of KEY_ENV_VARS) delete process.env[key];
  resetRuntimeConfigForTests();
  getRuntimeConfig().providers = originalProviders;
});

function freshState(): RetryState {
  return { repairCount: 0, contextCount: 0, truncateCount: 0, continueCount: 0, retriggerCount: 0 };
}

// Sleep is stubbed so no test waits on a real backoff timer.
function classify(error: unknown) {
  return handleApiError(
    error, [], new Set(), undefined, freshState(), 1, () => {},
    undefined, undefined, undefined, undefined, undefined, async () => {}
  );
}

test('registry skips malformed providers and normalizes valid ones', () => {
  setRuntimeProviders({
    '': { models: { phantom: {} } },
    'no-models': { name: 'No Models', models: {} },
    'bad-url': { baseURL: 'not a url', models: { m1: { name: 'M1' } } },
    custom: {
      name: 'Custom',
      baseURL: 'https://api.example.com/v1/',
      defaultParams: { temperature: 0.2 },
      models: {
        c1: { name: 'C1', contextWindow: 1234, inputPricePerMillion: 1, outputPricePerMillion: 2 },
      },
    },
    ' openai ': { models: { 'gpt-custom': { name: 'Custom GPT' } } },
    broken: null,
  });

  const ids = getAllProviders().map((provider) => provider.id);
  assert.ok(!ids.includes(''), 'empty provider id must be skipped');
  assert.ok(!ids.includes('no-models'), 'provider with no models must be skipped');
  assert.ok(!ids.includes('broken'), 'non-object provider must be skipped');
  assert.ok(ids.includes('bad-url'), 'provider with an invalid URL is usable after normalization');
  assert.equal(getProvider('bad-url')?.baseURL, undefined, 'invalid baseURL must be dropped');

  const custom = getProvider('custom')!;
  assert.equal(custom.name, 'Custom');
  assert.equal(custom.baseURL, 'https://api.example.com/v1/');
  assert.deepEqual(custom.defaultParams, { temperature: 0.2 });
  assert.equal(getModelDetails('custom', 'c1')?.contextWindow, 1234);
  assert.equal(getModelPricing('custom', 'c1')?.inputPerToken, 1 / 1_000_000);

  assert.ok(getProvider('openai')?.models.some((m) => m.id === 'gpt-custom'), 'trimmed id merges into openai');
  assert.equal(new Set(ids).size, ids.length, 'provider ids must be unique');
});

test('registry output order is deterministic and keeps built-in priority', () => {
  setRuntimeProviders({ zulu: { models: { z1: {} } }, alpha: { models: { a1: {} } } });
  const ids = getAllProviders().map((provider) => provider.id);
  assert.deepEqual(ids, ['openai', 'anthropic', 'google', 'openrouter', 'alpha', 'zulu']);
  assert.deepEqual(getAllProviders().map((provider) => provider.id), ids);
});

test('unknown providers and models return safe empty values', () => {
  setRuntimeProviders({});
  assert.equal(getProvider('does-not-exist'), undefined);
  assert.equal(getModelDetails('does-not-exist', 'x'), undefined);
  assert.equal(getModelDetails('openai', 'nope'), undefined);
  assert.equal(getModelPricing('does-not-exist', 'x'), undefined);
  assert.deepEqual(getRequestDefaultParams('does-not-exist', 'x'), {});
});

test('request defaults keep provider-scoped params only on matching providers', () => {
  setRuntimeProviders({
    openai: {
      defaultParams: { extra_body: { bad: true }, reasoning: { effort: 'high' }, temperature: 0.1 },
      models: { 'gpt-5.4': { defaultParams: { top_p: 0.9, generationConfig: { x: 1 } } } },
    },
    openrouter: {
      defaultParams: { extra_body: { reasoning: { enabled: true } }, reasoning: { effort: 'medium' } },
      models: { 'openai/gpt-4o': {} },
    },
  });

  const openai = getRequestDefaultParams('openai', 'gpt-5.4');
  assert.equal('extra_body' in openai, false);
  assert.equal('reasoning' in openai, false);
  assert.equal('generationConfig' in openai, false);
  assert.equal(openai.temperature, 0.1);
  assert.equal(openai.top_p, 0.9);

  const router = getRequestDefaultParams('openrouter', 'openai/gpt-4o');
  assert.deepEqual(router.extra_body, { reasoning: { enabled: true } });
  assert.deepEqual(router.reasoning, { effort: 'medium' });
});

test('getProviderApiKeyEnvVars includes canonical var and aliases', () => {
  setRuntimeProviders({});
  assert.deepEqual(getProviderApiKeyEnvVars('openrouter'), ['OPENROUTER_API_KEY']);
  assert.deepEqual(getProviderApiKeyEnvVars('google'), [
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
  ]);
  assert.deepEqual(getProviderApiKeyEnvVars('does-not-exist'), []);
});

test('classification: auth message on status 400 is non-retryable and redacted', async () => {
  const result = await classify({ status: 400, message: 'invalid_api_key provided sk-secret123' });
  assert.equal(result.handled, false);
  assert.match(result.errorMessage || '', /API key|Authentication/i);
  assert.doesNotMatch(result.errorMessage || '', /invalid_api_key|sk-secret123/);
});

test('classification: proxy auth status 403 is non-retryable', async () => {
  const result = await classify({ status: 403, message: 'permission_denied' });
  assert.equal(result.handled, false);
  assert.match(result.errorMessage || '', /API key|Authentication/i);
});

test('classification: quota/resource-exhausted messages back off, even without 429', async () => {
  const result = await classify({ status: 400, message: 'RESOURCE_EXHAUSTED: quota exceeded' });
  assert.equal(result.handled, true);
  assert.equal(result.shouldAbort, false);
  assert.equal(result.silentRetry, true);
});

test('classification: 403 with a quota message is treated as rate limiting', async () => {
  const result = await classify({ status: 403, message: 'RATE_LIMIT: too many requests' });
  assert.equal(result.handled, true);
  assert.equal(result.silentRetry, true);
});

test('classification: context-length messages trigger compaction path', async () => {
  const result = await classify({ status: 400, message: 'maximum context length exceeded' });
  assert.equal(result.handled, true);
  assert.equal(result.silentRetry, true);
});

test('classification: network error codes are retryable', async () => {
  const result = await classify({ code: 'ECONNREFUSED', message: 'connect failed' });
  assert.equal(result.handled, true);
  assert.equal(result.silentRetry, true);
});

test('resolveApiKey picks provider-specific vars, aliases, then generic', () => {
  setRuntimeProviders({});

  process.env.OPENROUTER_API_KEY = 'router-key';
  assert.equal(resolveApiKey({ provider: 'openrouter', apiKey: undefined }), 'router-key');

  process.env.GOOGLE_API_KEY = 'google-alias';
  assert.equal(resolveApiKey({ provider: 'google', apiKey: undefined }), 'google-alias');

  process.env.GEMINI_API_KEY = 'gemini-primary';
  assert.equal(resolveApiKey({ provider: 'google', apiKey: undefined }), 'gemini-primary');

  process.env.BITACODE_API_KEY = 'generic-key';
  assert.equal(resolveApiKey({ provider: 'openrouter', apiKey: undefined }), 'router-key', 'provider var beats generic');
  assert.equal(resolveApiKey({ provider: 'unknown-provider', apiKey: undefined }), 'generic-key');
});
