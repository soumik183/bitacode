import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleApiError,
  MAX_TRANSIENT_ATTEMPTS,
  MAX_TRANSIENT_RETRIES,
  TRANSIENT_BACKOFF_MS,
  type RetryState,
} from '../src/agentic-loop/errors.js';
import type { AgentEvent } from '../src/agentic-loop.js';

const freshState = (): RetryState => ({
  repairCount: 0,
  contextCount: 0,
  truncateCount: 0,
  continueCount: 0,
  retriggerCount: 0,
  transientCount: 0,
});

const SERVER_ERROR = Object.assign(new Error('upstream exploded'), { status: 503 });
const RATE_ERROR = Object.assign(new Error('rate limit exceeded'), { status: 429 });

async function run(
  error: any,
  state: RetryState,
  iterationCount = 0,
  headers?: Record<string, string>
) {
  const delays: number[] = [];
  const events: AgentEvent[] = [];
  if (headers) (error as any).headers = headers;
  const result = await handleApiError(
    error,
    [{ role: 'user', content: 'hello' }] as any,
    new Set<string>(),
    undefined,
    state,
    iterationCount,
    (event: AgentEvent) => events.push(event),
    undefined,
    'test-model',
    undefined,
    'test-session',
    undefined,
    async (delayMs: number) => {
      delays.push(delayMs);
    },
  );
  return { result, delays, events };
}

test('transient failures back off on the 1/3/5/10/15 second schedule', async () => {
  assert.deepEqual([...TRANSIENT_BACKOFF_MS], [1_000, 3_000, 5_000, 10_000, 15_000]);
  const state = freshState();
  const delays: number[] = [];

  for (let attempt = 1; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    const outcome = await run(SERVER_ERROR, state);
    assert.equal(outcome.result.handled, true);
    assert.equal(outcome.result.silentRetry, true);
    delays.push(outcome.delays[0]);
    assert.equal(state.transientCount, attempt);
  }
  assert.deepEqual(delays, [1_000, 3_000, 5_000, 10_000, 15_000]);
});

test('the sixth failure stops the loop with a clear message', async () => {
  const state = freshState();
  for (let attempt = 1; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    await run(SERVER_ERROR, state);
  }

  const final = await run(SERVER_ERROR, state);
  assert.equal(final.result.handled, false);
  assert.equal(final.result.shouldAbort, false);
  assert.match(final.result.errorMessage ?? '', /Gave up after 6 attempts/);
  assert.deepEqual(final.delays, [], 'no further sleeping once the budget is gone');
});

test('rate limits share the same retry budget as server errors', async () => {
  const state = freshState();
  await run(RATE_ERROR, state);
  await run(SERVER_ERROR, state);
  await run(RATE_ERROR, state);
  assert.equal(state.transientCount, 3);

  for (let attempt = 3; attempt < MAX_TRANSIENT_RETRIES; attempt++) {
    await run(SERVER_ERROR, state);
  }
  const final = await run(RATE_ERROR, state);
  assert.equal(final.result.handled, false);
  assert.match(final.result.errorMessage ?? '', /Gave up after 6 attempts/);
});

test('a provider Retry-After longer than the schedule wins', async () => {
  const state = freshState();
  const outcome = await run(RATE_ERROR, state, 0, { 'retry-after': '30' });
  assert.deepEqual(outcome.delays, [30_000]);
});

test('retry progress is reported with attempt numbers', async () => {
  const state = freshState();
  const first = await run(SERVER_ERROR, state);
  assert.match(first.events[0].error ?? '', /Retrying in 1s \(attempt 1\/5\)/);

  await run(SERVER_ERROR, state);
  const third = await run(SERVER_ERROR, state);
  assert.match(third.events[0].error ?? '', /Retrying in 5s \(attempt 3\/5\)/);
  assert.equal(MAX_TRANSIENT_ATTEMPTS, 6);
});

test('an abort during the backoff wait ends the turn instead of retrying', async () => {
  const state = freshState();
  const controller = new AbortController();
  const result = await handleApiError(
    SERVER_ERROR,
    [{ role: 'user', content: 'hello' }] as any,
    new Set<string>(),
    undefined,
    state,
    0,
    () => {},
    undefined,
    'test-model',
    undefined,
    'test-session',
    controller.signal,
    async () => {
      controller.abort();
      throw new Error('Operation aborted');
    },
  );
  assert.equal(result.shouldAbort, true);
});

test('a fresh streak starts with the short delay again', async () => {
  const state = freshState();
  await run(SERVER_ERROR, state);
  await run(SERVER_ERROR, state);
  // A successful response clears the budget inside the loop; emulate that.
  state.transientCount = 0;
  const outcome = await run(SERVER_ERROR, state);
  assert.deepEqual(outcome.delays, [1_000]);
});
