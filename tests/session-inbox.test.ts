import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInbox,
  type DeliveryMode,
  type InboxResult,
  type IncomingPrompt,
  type PromptInbox,
} from '../src/utils/session-inbox.js';

function prompt(overrides: Partial<IncomingPrompt> = {}): IncomingPrompt {
  return {
    id: 'p1',
    sessionId: 's1',
    text: 'hello',
    mode: 'queue',
    enqueuedAt: 1,
    ...overrides,
  };
}

function accepted<T>(result: InboxResult<T>): T {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function rejected<T>(result: InboxResult<T>): string {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected an error result');
  return result.error;
}

test('enqueue is idempotent by (id, sessionId) and returns the first admission', () => {
  const inbox = createInbox();
  const first = accepted(inbox.enqueue(prompt()));
  const retry = accepted(inbox.enqueue(prompt({ text: 'different text', mode: 'steer', enqueuedAt: 999 })));

  assert.deepEqual(retry, first);
  assert.equal(inbox.size(), 1);
  assert.equal(inbox.pending('s1').length, 1);
});

test('the same id with a different sessionId is rejected without side effects', () => {
  const inbox = createInbox();
  accepted(inbox.enqueue(prompt({ id: 'dup', sessionId: 's1' })));

  assert.match(rejected(inbox.enqueue(prompt({ id: 'dup', sessionId: 's2' }))), /different session/);
  assert.equal(inbox.size(), 1);
  assert.deepEqual(inbox.pending('s2'), []);
  assert.equal(accepted(inbox.deliverNext('s1')).id, 'dup');
});

test('steers are delivered before queued items regardless of enqueue order', () => {
  const inbox = createInbox();
  for (const item of [
    prompt({ id: 'q1' }),
    prompt({ id: 'q2' }),
    prompt({ id: 's1', mode: 'steer' }),
    prompt({ id: 's2', mode: 'steer' }),
  ]) {
    accepted(inbox.enqueue(item));
  }

  assert.deepEqual(
    [1, 2, 3, 4].map(() => accepted(inbox.deliverNext('s1')).id),
    ['s1', 's2', 'q1', 'q2'],
  );
});

test('queue fallback: queued items are delivered in enqueue order when no steer is eligible', () => {
  const inbox = createInbox();
  accepted(inbox.enqueue(prompt({ id: 'q1', enqueuedAt: 10 })));
  accepted(inbox.enqueue(prompt({ id: 'q2', enqueuedAt: 2 })));
  accepted(inbox.enqueue(prompt({ id: 'q3', enqueuedAt: 30 })));

  assert.deepEqual(inbox.pending('s1').map((item) => item.id), ['q1', 'q2', 'q3']);
  assert.deepEqual(
    [1, 2, 3].map(() => accepted(inbox.deliverNext('s1')).id),
    ['q1', 'q2', 'q3'],
  );
  assert.match(rejected(inbox.deliverNext('s1')), /No deliverable prompt/);
});

test('a control item blocks everything enqueued after it, then the boundary advances', () => {
  const inbox = createInbox();
  accepted(inbox.enqueue(prompt({ id: 'before' })));
  accepted(inbox.enqueue(prompt({ id: 'control', control: true })));
  accepted(inbox.enqueue(prompt({ id: 'after-steer', mode: 'steer' })));
  accepted(inbox.enqueue(prompt({ id: 'after-queue' })));

  // Even the steer after the control is ineligible until the control is delivered.
  assert.equal(accepted(inbox.deliverNext('s1')).id, 'before');
  assert.equal(accepted(inbox.deliverNext('s1')).id, 'control');
  assert.equal(accepted(inbox.deliverNext('s1')).id, 'after-steer');
  assert.equal(accepted(inbox.deliverNext('s1')).id, 'after-queue');
});

test('the oldest pending control item is the boundary when several are queued', () => {
  const inbox = createInbox();
  accepted(inbox.enqueue(prompt({ id: 'c1', control: true })));
  accepted(inbox.enqueue(prompt({ id: 's1', mode: 'steer' })));
  accepted(inbox.enqueue(prompt({ id: 'c2', control: true })));
  accepted(inbox.enqueue(prompt({ id: 'q1' })));

  assert.deepEqual(
    [1, 2, 3, 4].map(() => accepted(inbox.deliverNext('s1')).id),
    ['c1', 's1', 'c2', 'q1'],
  );
});

test('allowSteer=false ignores steers and delivers only queued prompts', () => {
  const inbox = createInbox();
  accepted(inbox.enqueue(prompt({ id: 's1', mode: 'steer' })));
  accepted(inbox.enqueue(prompt({ id: 'q1' })));

  assert.equal(accepted(inbox.deliverNext('s1', { allowSteer: false })).id, 'q1');
  assert.match(rejected(inbox.deliverNext('s1', { allowSteer: false })), /No deliverable prompt/);
  assert.deepEqual(inbox.pending('s1').map((item) => item.id), ['s1']);
  // Turning steering back on still delivers the untouched steer.
  assert.equal(accepted(inbox.deliverNext('s1', { allowSteer: true })).id, 's1');
});

test('allowSteer=false cannot cross a control boundary that is itself a steer', () => {
  const inbox = createInbox();
  accepted(inbox.enqueue(prompt({ id: 'control', mode: 'steer', control: true })));
  accepted(inbox.enqueue(prompt({ id: 'after' })));

  assert.match(rejected(inbox.deliverNext('s1', { allowSteer: false })), /No deliverable prompt/);
  assert.equal(accepted(inbox.deliverNext('s1')).id, 'control');
});

test('invalid inputs return typed errors instead of throwing', () => {
  const inbox = createInbox({ maxTextChars: 5 });
  assert.match(rejected(inbox.enqueue(prompt({ id: '' }))), /non-empty string/);
  assert.match(rejected(inbox.enqueue(prompt({ id: '   ' }))), /non-empty string/);
  assert.match(rejected(inbox.enqueue(prompt({ id: 'x'.repeat(129) }))), /128 characters/);
  assert.match(rejected(inbox.enqueue(prompt({ sessionId: ' ' }))), /sessionId/);
  assert.match(rejected(inbox.enqueue(prompt({ text: '' }))), /text/);
  assert.match(rejected(inbox.enqueue(prompt({ text: '123456' }))), /exceeds 5 characters/);
  assert.match(rejected(inbox.enqueue(prompt({ mode: 'later' as unknown as DeliveryMode }))), /mode/);
  assert.match(rejected(inbox.enqueue(null as unknown as IncomingPrompt)), /prompt object/);
  assert.match(rejected(inbox.deliverNext('')), /sessionId/);
  assert.equal(inbox.size(), 0);
});

test('item and text caps are enforced, and duplicates still succeed when full', () => {
  const inbox = createInbox({ maxItems: 2, maxTextChars: 3 });
  accepted(inbox.enqueue(prompt({ id: 'a', text: 'abc' })));
  accepted(inbox.enqueue(prompt({ id: 'b', text: 'xy' })));

  assert.match(rejected(inbox.enqueue(prompt({ id: 'c', text: 'z' }))), /full \(2 items\)/);
  assert.match(rejected(inbox.enqueue(prompt({ id: 'd', text: 'toolong' }))), /exceeds 3 characters/);
  assert.deepEqual(accepted(inbox.enqueue(prompt({ id: 'a', text: 'other' }))), prompt({ id: 'a', text: 'abc' }));
  assert.equal(inbox.size(), 2);

  assert.equal(inbox.ack('s1', 'a'), true);
  assert.equal(accepted(inbox.enqueue(prompt({ id: 'c', text: 'z' }))).id, 'c');
  assert.equal(inbox.size(), 2);
});

test('invalid createInbox options fall back to documented defaults', () => {
  const inbox = createInbox({ maxItems: 0, maxTextChars: -1 });
  const long = 'x'.repeat(20_000);
  assert.equal(accepted(inbox.enqueue(prompt({ id: 'long', text: long }))).text, long);
  assert.equal(rejected(inbox.enqueue(prompt({ id: 'too-long', text: `${long}x` }))).includes('20000'), true);
});

test('callers cannot mutate internal state through inputs or returned copies', () => {
  const inbox = createInbox();
  const input = prompt({ control: false });
  const admitted = accepted(inbox.enqueue(input));

  input.id = 'changed';
  input.text = 'mutated input';
  input.mode = 'steer';
  admitted.text = 'mutated result';

  const listed = inbox.pending('s1');
  assert.deepEqual(listed, [prompt({ control: false })]);
  listed[0].text = 'mutated list';
  listed.push(prompt({ id: 'ghost', sessionId: 's1' }));
  assert.equal(inbox.size(), 1);
  assert.deepEqual(inbox.pending('s1'), [prompt({ control: false })]);

  const delivered = accepted(inbox.deliverNext('s1'));
  delivered.text = 'mutated delivery';
  assert.equal(accepted(inbox.enqueue(prompt({ id: 'next' }))).sessionId, 's1');
  assert.equal(inbox.pending('s1')[0].text, 'hello');
});

test('ack, clear and size are session-scoped and idempotent', () => {
  const inbox: PromptInbox = createInbox();
  accepted(inbox.enqueue(prompt({ id: 'a' })));
  accepted(inbox.enqueue(prompt({ id: 'b' })));
  accepted(inbox.enqueue(prompt({ id: 'c', sessionId: 's2' })));

  assert.equal(inbox.size(), 3);
  assert.equal(inbox.ack('s2', 'a'), false, 'cross-session ack is refused');
  assert.equal(inbox.ack('s1', 'a'), true);
  assert.equal(inbox.ack('s1', 'a'), false);
  assert.equal(inbox.size(), 2);

  inbox.clear('s1');
  assert.equal(inbox.size(), 1);
  assert.deepEqual(inbox.pending('s1'), []);
  assert.deepEqual(inbox.pending('s2').map((item) => item.id), ['c']);
  inbox.clear('unknown');
  assert.equal(inbox.size(), 1);
});

test('a retry after delivery or ack returns the original item without re-admitting it', () => {
  const inbox = createInbox();
  const original = accepted(inbox.enqueue(prompt({ id: 'delivered' })));
  const acked = accepted(inbox.enqueue(prompt({ id: 'acked' })));
  assert.equal(accepted(inbox.deliverNext('s1')).id, 'delivered');
  assert.equal(inbox.ack('s1', 'acked'), true);

  assert.deepEqual(accepted(inbox.enqueue(prompt({ id: 'delivered', text: 'again' }))), original);
  assert.deepEqual(accepted(inbox.enqueue(prompt({ id: 'acked', text: 'again' }))), acked);
  assert.equal(inbox.size(), 0);
  assert.match(rejected(inbox.deliverNext('s1')), /No deliverable prompt/);
});

test('enqueuedAt is preserved when valid and repaired when not', () => {
  const inbox = createInbox();
  assert.equal(accepted(inbox.enqueue(prompt({ enqueuedAt: 123.5 }))).enqueuedAt, 123.5);
  const repaired = accepted(inbox.enqueue(prompt({ id: 'bad-ts', enqueuedAt: Number.NaN })));
  assert.ok(Number.isFinite(repaired.enqueuedAt));
  assert.ok(repaired.enqueuedAt > 0);
  assert.match(rejected(inbox.deliverNext('missing')), /No deliverable prompt/);
});
