import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleApiError,
  sleepWithAbort,
  type RetryState,
} from '../src/agentic-loop/errors.js';

function freshState(): RetryState {
  return {
    repairCount: 0,
    contextCount: 0,
    truncateCount: 0,
    continueCount: 0,
    retriggerCount: 0,
  };
}

// Positional args that are irrelevant to these tests. The injectable sleep
// keeps every backoff test instant (no real multi-second timers).
const noEvent = () => {};
const tail = [undefined, undefined, undefined, undefined] as const;

test('429 with numeric Retry-After produces a finite, clamped backoff', async () => {
  let captured = -1;
  const result = await handleApiError(
    { status: 429, message: 'rate limited', headers: { 'retry-after': '2' } },
    [],
    new Set(),
    undefined,
    freshState(),
    1,
    noEvent,
    ...tail,
    undefined,
    async (ms) => {
      captured = ms;
    }
  );

  assert.equal(result.handled, true);
  assert.equal(result.shouldAbort, false);
  assert.ok(Number.isFinite(captured), 'backoff must be a finite number');
  assert.equal(captured, 2000);
});

test('429 with an HTTP-date Retry-After does not produce NaN and stays clamped', async () => {
  let captured = -1;
  const header = new Date(Date.now() + 5000).toUTCString();
  const result = await handleApiError(
    { status: 429, message: 'rate limited', headers: { 'retry-after': header } },
    [],
    new Set(),
    undefined,
    freshState(),
    1,
    noEvent,
    ...tail,
    undefined,
    async (ms) => {
      captured = ms;
    }
  );

  assert.equal(result.handled, true);
  assert.ok(Number.isFinite(captured), 'backoff must be a finite number');
  assert.ok(captured >= 1000 && captured <= 60_000, `backoff ${captured}ms out of range`);
});

test('429 with an unparseable Retry-After falls back to 5s', async () => {
  let captured = -1;
  await handleApiError(
    { status: 429, message: 'rate limited', headers: { 'retry-after': 'not-a-date' } },
    [],
    new Set(),
    undefined,
    freshState(),
    1,
    noEvent,
    ...tail,
    undefined,
    async (ms) => {
      captured = ms;
    }
  );
  assert.equal(captured, 5000);
});

test('429 reads Retry-After from a Headers instance too', async () => {
  let captured = -1;
  await handleApiError(
    { status: 429, message: 'rate limited', headers: new Headers({ 'retry-after': '3' }) },
    [],
    new Set(),
    undefined,
    freshState(),
    1,
    noEvent,
    ...tail,
    undefined,
    async (ms) => {
      captured = ms;
    }
  );
  assert.equal(captured, 3000);
});

test('sleepWithAbort rejects immediately when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => sleepWithAbort(60_000, controller.signal),
    /Operation aborted/
  );
});

test('handleApiError surfaces shouldAbort when the backoff is interrupted', async () => {
  const result = await handleApiError(
    { status: 429, message: 'rate limited', headers: { 'retry-after': '5' } },
    [],
    new Set(),
    undefined,
    freshState(),
    1,
    noEvent,
    ...tail,
    undefined,
    async () => {
      throw new Error('Operation aborted');
    }
  );
  assert.equal(result.shouldAbort, true);
});

test('400 removes hallucinated tool calls and their results, keeping valid ones', async () => {
  const messages: any[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do it' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_good', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'call_bad', type: 'function', function: { name: 'hallucinated_tool', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_good', content: 'ok' },
    { role: 'tool', tool_call_id: 'call_bad', content: 'bad result' },
  ];

  const result = await handleApiError(
    { status: 400, message: 'invalid tool name' },
    messages,
    new Set(['read_file']),
    undefined,
    freshState(),
    1,
    noEvent
  );

  assert.equal(result.handled, true);
  const assistant = messages.find((m) => m.role === 'assistant');
  assert.deepEqual(
    assistant.tool_calls.map((tc: any) => tc.function.name),
    ['read_file']
  );
  assert.ok(
    !messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_bad'),
    'the hallucinated tool result must be removed'
  );
  assert.ok(
    messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_good'),
    'the valid tool result must survive'
  );
  assert.ok(messages.some((m) => m.role === 'system'), 'system message must survive');
  assert.ok(messages.some((m) => m.role === 'user'), 'user message must survive');
});

test('401 returns a helpful, non-retryable authentication message', async () => {
  const result = await handleApiError(
    { status: 401, message: 'Incorrect API key provided: sk-secret-value' },
    [],
    new Set(),
    undefined,
    freshState(),
    1,
    noEvent
  );

  assert.equal(result.handled, false);
  assert.match(result.errorMessage || '', /API key/i);
  assert.doesNotMatch(result.errorMessage || '', /sk-secret-value/);
});

test('404 points at model/endpoint configuration', async () => {
  const result = await handleApiError(
    { status: 404, message: 'unknown model' },
    [],
    new Set(),
    undefined,
    freshState(),
    1,
    noEvent
  );
  assert.equal(result.handled, false);
  assert.match(result.errorMessage || '', /not found/i);
});

// Instant classifier for message-based paths; sleep is always stubbed.
async function classify(error: unknown) {
  return handleApiError(
    error, [], new Set(), undefined, freshState(), 1, noEvent,
    ...tail, undefined, async () => {}
  );
}

test('authentication message on status 400 is non-retryable and never echoed', async () => {
  const result = await classify({ status: 400, message: 'invalid_api_key sk-secret-value' });
  assert.equal(result.handled, false);
  assert.match(result.errorMessage || '', /API key|Authentication/i);
  assert.doesNotMatch(result.errorMessage || '', /invalid_api_key|sk-secret-value/);
});

test('quota message without a 429 status still backs off', async () => {
  const result = await classify({ status: 400, message: 'RESOURCE_EXHAUSTED quota exceeded' });
  assert.equal(result.handled, true);
  assert.equal(result.shouldAbort, false);
  assert.equal(result.silentRetry, true);
});

test('context-length message triggers the compaction path', async () => {
  const result = await classify({ status: 400, message: 'input too long for this model' });
  assert.equal(result.handled, true);
  assert.equal(result.silentRetry, true);
});

test('network error codes are retryable', async () => {
  const result = await classify({ code: 'ETIMEDOUT', message: 'request timed out' });
  assert.equal(result.handled, true);
  assert.equal(result.silentRetry, true);
});

test('generic errors redact secrets instead of echoing the raw message', async () => {
  const result = await classify({ status: 422, message: 'bad token sk-secret-value here' });
  assert.equal(result.handled, false);
  assert.doesNotMatch(result.errorMessage || '', /sk-secret-value/);
});
