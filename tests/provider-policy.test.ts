/**
 * Tests for the pure model-policy and retry-classification helpers.
 *
 * Every decision is deterministic here: backoff jitter is driven by an
 * injected `rng` rather than Math.random, and no network or config files are
 * involved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkModelPolicy,
  classifyFailure,
  parseProviderPolicy,
  retryDecision,
  type FailureKind,
  type ProviderPolicy,
} from '../src/utils/provider-policy.js';

const fixed = (value: number) => () => value;

test('model globs support *, ?, case-insensitivity and full-string anchoring', () => {
  const allow: ProviderPolicy = { allowedModels: ['gpt-*'] };
  assert.equal(checkModelPolicy('gpt-4o', allow).allowed, true);
  assert.equal(checkModelPolicy('gpt-4', allow).allowed, true, '* matches zero characters');
  assert.equal(checkModelPolicy('GPT-4O-MINI', allow).allowed, true);
  assert.equal(checkModelPolicy('my-gpt-4o', allow).allowed, false, 'globs are anchored');
  assert.equal(checkModelPolicy('gpt', allow).allowed, false, 'the separator is not optional');
  assert.equal(checkModelPolicy('provider/claude-3', { allowedModels: ['provider/*'] }).allowed, true);
  assert.equal(checkModelPolicy('gpt-4o', { allowedModels: ['gpt-4?'] }).allowed, true);
  assert.equal(checkModelPolicy('gpt-4', { allowedModels: ['gpt-4?'] }).allowed, false);
});

test('deniedModels wins over allowedModels', () => {
  const policy: ProviderPolicy = { allowedModels: ['*'], deniedModels: ['gpt-4*', '*o3*'] };
  const denied = checkModelPolicy('gpt-4o', policy);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? '', /deniedModels/);
  assert.equal(checkModelPolicy('openai/o3-mini', policy).allowed, false);
  assert.equal(checkModelPolicy('claude-sonnet-4', policy).allowed, true);
});

test('empty/invalid model identifiers are denied even without a policy', () => {
  for (const model of ['', '   ', 'gpt\u0000-4', 'a\nb', 'x'.repeat(600), 42, null, undefined]) {
    const verdict = checkModelPolicy(model as unknown as string, {});
    assert.equal(verdict.allowed, false);
    assert.equal(typeof verdict.reason, 'string');
  }
});

test('an absent policy allows every valid model, but a present empty allowlist fails closed', () => {
  assert.deepEqual(checkModelPolicy('gpt-4o', {}), { allowed: true });
  assert.equal(checkModelPolicy('gpt-4o', { allowedModels: [] }).allowed, false);
  assert.deepEqual(checkModelPolicy('gpt-4o', { deniedModels: [] }), { allowed: true });
});

test('invalid glob patterns are ignored without throwing or widening the policy', () => {
  const policy: ProviderPolicy = {
    allowedModels: ['', '   ', 'bad\u0000pattern', 'tiny\u007f', 42 as unknown as string, 'gpt-*'],
    deniedModels: ['', 'claude-\u0000', 'claude-*'],
  };
  assert.equal(checkModelPolicy('gpt-4o', policy).allowed, true);
  assert.equal(checkModelPolicy('claude-4', policy).allowed, false);
  assert.equal(checkModelPolicy('llama-3', policy).allowed, false, 'the allowlist is still enforced');
  assert.doesNotThrow(() => checkModelPolicy('gpt-4o', null as unknown as ProviderPolicy));
});

test('parseProviderPolicy never throws and fails closed on malformed configured policies', () => {
  for (const value of [null, 'gpt-*', 42, true, [], ['gpt-*'], Symbol('x')]) {
    assert.deepEqual(parseProviderPolicy(value), { deniedModels: ['*'] }, `unexpected shape: ${String(value)}`);
  }
  // A missing policy (undefined) or an object with no recognized fields means
  // "no policy configured" and keeps the permissive default.
  assert.deepEqual(parseProviderPolicy(undefined), {});
  assert.deepEqual(parseProviderPolicy({ unknownKey: 1 }), {});
  assert.deepEqual(parseProviderPolicy(Object.create(null)), {});
});

test('parseProviderPolicy caps lists at 200 entries and clamps maxRetries to 0..10', () => {
  const models = Array.from({ length: 250 }, (_, i) => `m${i}`);
  const policy = parseProviderPolicy({
    allowedModels: models,
    deniedModels: models,
    maxRetries: 99,
  });
  assert.equal(policy.allowedModels?.length, 200);
  assert.equal(policy.deniedModels?.length, 200);
  assert.deepEqual(policy.allowedModels?.slice(0, 2), ['m0', 'm1']);
  assert.equal(policy.maxRetries, 10);
  assert.equal(parseProviderPolicy({ maxRetries: -7 }).maxRetries, 0);
  assert.equal(parseProviderPolicy({ maxRetries: 3.9 }).maxRetries, 3);
  assert.equal(parseProviderPolicy({ maxRetries: 4 }).maxRetries, 4);
});

test('parseProviderPolicy fails closed on wrong-typed fields', () => {
  const denied = parseProviderPolicy({ allowedModels: 'gpt-*' });
  assert.deepEqual(denied.deniedModels, ['*']);
  assert.equal(checkModelPolicy('gpt-4o', denied).allowed, false);

  const deniedAgain = parseProviderPolicy({ deniedModels: 7 });
  assert.deepEqual(deniedAgain.deniedModels, ['*']);
  assert.equal(checkModelPolicy('anything', deniedAgain).allowed, false);

  const noRetries = parseProviderPolicy({ maxRetries: '4' });
  assert.equal(noRetries.maxRetries, 0);
  assert.equal(parseProviderPolicy({ maxRetries: Number.NaN }).maxRetries, 0);
});

test('classifyFailure maps status codes to every failure kind', () => {
  assert.equal(classifyFailure(new Error('slow down'), 429), 'rate_limit');
  assert.equal(classifyFailure(new Error('bad gateway'), 503), 'server');
  assert.equal(classifyFailure(new Error('timeout'), 599), 'server');
  assert.equal(classifyFailure(new Error('request timeout'), 408), 'transport');
  assert.equal(classifyFailure(new Error('conflict'), 409), 'transport');
  assert.equal(classifyFailure(new Error('too early'), 425), 'transport');
  assert.equal(classifyFailure(new Error('incomplete stream'), 400), 'incomplete_stream');
  assert.equal(classifyFailure(new Error('stream ended early'), 400), 'incomplete_stream');
  assert.equal(classifyFailure(new Error('content filter rejection'), 400), 'content_filter');
  assert.equal(classifyFailure(new Error('not found'), 404), 'permanent');
  assert.equal(classifyFailure(new Error('bad request'), 400), 'permanent');
});

test('classifyFailure reads status and keywords from thrown values', () => {
  assert.equal(classifyFailure({ statusCode: 502 }), 'server');
  assert.equal(classifyFailure({ response: { status: 429 } }), 'rate_limit');
  assert.equal(classifyFailure(Object.assign(new Error('broken'), { code: 'ECONNRESET' })), 'transport');
  assert.equal(classifyFailure({ code: 'ETIMEDOUT' }), 'transport');
  assert.equal(classifyFailure({ code: 'EAI_AGAIN' }), 'transport');
  assert.equal(classifyFailure(new Error('The operation was aborted')), 'transport');
  assert.equal(classifyFailure(new Error('network unreachable')), 'transport');
  assert.equal(classifyFailure(new Error('rate limit exceeded')), 'rate_limit');
  assert.equal(classifyFailure(new Error('content_policy violation')), 'content_filter');
  assert.equal(classifyFailure(new Error('the stream ended unexpectedly')), 'incomplete_stream');
});

test('classifyFailure is total for hostile inputs', () => {
  const throwing = Object.defineProperty({}, 'message', {
    get() {
      throw new Error('getter exploded');
    },
  });
  assert.equal(classifyFailure(throwing), 'permanent');
  assert.equal(classifyFailure(Symbol('x')), 'permanent');
  assert.equal(classifyFailure(Object.create(null), Number.NaN), 'permanent');
  assert.equal(classifyFailure(undefined, 200), 'permanent');
});

test('retry matrix: transient kinds retry, terminal kinds never do', () => {
  const cases: Array<[FailureKind, { status?: number; error?: unknown }, boolean]> = [
    ['rate_limit', { status: 429 }, true],
    ['server', { status: 503 }, true],
    ['transport', { error: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }, true],
    ['incomplete_stream', { status: 400, error: new Error('incomplete stream') }, true],
    ['content_filter', { status: 400, error: new Error('content filter') }, false],
    ['permanent', { status: 404 }, false],
  ];
  for (const [kind, input, expected] of cases) {
    const decision = retryDecision({ attempt: 1, ...input, rng: fixed(0.5) });
    assert.equal(decision.kind, kind);
    assert.equal(decision.retry, expected, kind);
    assert.equal(decision.attempt, 1);
    assert.ok(Number.isFinite(decision.delayMs) && decision.delayMs >= 0);
    if (!expected) assert.match(decision.reason ?? '', /not retryable/);
  }
});

test('jitter stays within ±20% of the exponential delay', () => {
  assert.deepEqual(retryDecision({ attempt: 1, status: 503, rng: fixed(0) }).delayMs, 800);
  assert.deepEqual(retryDecision({ attempt: 1, status: 503, rng: fixed(0.5) }).delayMs, 1_000);
  assert.deepEqual(retryDecision({ attempt: 1, status: 503, rng: fixed(1) }).delayMs, 1_200);
  assert.deepEqual(retryDecision({ attempt: 2, status: 503, rng: fixed(0) }).delayMs, 1_600);
  assert.deepEqual(retryDecision({ attempt: 2, status: 503, rng: fixed(1) }).delayMs, 2_400);
});

test('exponential backoff doubles and caps at 30 seconds', () => {
  const delays = [1, 2, 3, 4, 5].map(attempt =>
    retryDecision({ attempt, status: 503, rng: fixed(0.5) }).delayMs
  );
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000]);
  assert.equal(retryDecision({ attempt: 10, maxRetries: 10, status: 503, rng: fixed(0.5) }).delayMs, 30_000);
  assert.equal(retryDecision({ attempt: 11, maxRetries: 10, status: 503, rng: fixed(1) }).delayMs, 30_000);
});

test('retry budget stops after maxRetries + 1 failed attempts', () => {
  assert.equal(retryDecision({ attempt: 5, status: 429, rng: fixed(0.5) }).retry, true);
  const exhausted = retryDecision({ attempt: 6, status: 429, rng: fixed(0.5) });
  assert.equal(exhausted.retry, false);
  assert.equal(exhausted.delayMs, 0);
  assert.equal(exhausted.kind, 'rate_limit');
  assert.match(exhausted.reason ?? '', /budget exhausted/);
  assert.equal(retryDecision({ attempt: 2, maxRetries: 0, status: 503 }).retry, false);
  assert.equal(retryDecision({ attempt: 3, maxRetries: 99, status: 503 }).retry, true);
});

test('a larger finite retryAfterMs wins; smaller or invalid hints are ignored', () => {
  const base = { attempt: 1, status: 429 as const, rng: fixed(0.5) };
  assert.equal(retryDecision({ ...base, retryAfterMs: 5_000 }).delayMs, 5_000);
  assert.equal(retryDecision({ ...base, retryAfterMs: 45_000 }).delayMs, 45_000);
  assert.equal(retryDecision({ ...base, retryAfterMs: 100 }).delayMs, 1_000);
  assert.equal(retryDecision({ ...base, retryAfterMs: Number.NaN }).delayMs, 1_000);
  assert.equal(retryDecision({ ...base, retryAfterMs: Number.POSITIVE_INFINITY }).delayMs, 1_000);
  assert.equal(retryDecision({ attempt: 3, status: 503, retryAfterMs: 100, rng: fixed(0.5) }).delayMs, 4_000);
});

test('retryDecision never produces NaN/Infinity and never throws', () => {
  const decisions = [
    retryDecision({ attempt: Number.NaN, status: 503, rng: fixed(0.5) }),
    retryDecision({ attempt: -5, status: 503, rng: fixed(0.5) }),
    retryDecision({ attempt: 1, status: 503, baseDelayMs: Number.POSITIVE_INFINITY, rng: fixed(0.5) }),
    retryDecision({ attempt: 1, status: 503, rng: () => Number.NaN }),
    retryDecision({ attempt: 1, status: 503, rng: () => 99, retryAfterMs: Number.NaN }),
    retryDecision(null as unknown as { attempt: number }),
  ];
  for (const decision of decisions) {
    assert.ok(Number.isFinite(decision.delayMs), 'finite delay');
    assert.ok(decision.delayMs >= 0, 'non-negative delay');
    assert.ok(Number.isInteger(decision.attempt) && decision.attempt >= 1);
  }
  assert.equal(decisions[0].attempt, 1);
  assert.equal(decisions[2].delayMs, 1_000);
  assert.equal(decisions[3].delayMs, 1_000);
  assert.equal(decisions[5].retry, false);
});
