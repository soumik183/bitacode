import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  pruneSession,
} from '../src/sessions.js';

function userTurns(count: number): ReturnType<typeof createSession>['completionMessages'] {
  const messages: ReturnType<typeof createSession>['completionMessages'] = [
    { role: 'system', content: 'system prompt' } as never,
  ];
  for (let index = 0; index < count; index++) {
    messages.push({ role: 'user', content: `question ${index} `.repeat(40) } as never);
    messages.push({ role: 'assistant', content: `answer ${index} `.repeat(40) } as never);
  }
  return messages;
}

test('pruneSession keeps the system prompt and the last N turns', () => {
  const session = createSession('gpt-test', 'openai');
  session.completionMessages = userTurns(6);

  const pruned = pruneSession(session, { keepTurns: 2 });
  const roles = pruned.completionMessages.map((message) => message.role);
  const users = pruned.completionMessages.filter((message) => message.role === 'user');

  // The leading system prompt survives, and only the last two user turns remain.
  assert.equal(roles[0], 'system');
  assert.equal(users.length, 2);
});

test('pruneSession strips the oldest turns until it fits the byte budget', () => {
  const session = createSession('gpt-test', 'openai');
  session.completionMessages = userTurns(5);

  const pruned = pruneSession(session, { maxBytes: 2000 });
  const size = JSON.stringify(pruned.completionMessages).length;
  assert.ok(size <= 2000, `pruned size ${size} exceeds budget`);
  assert.ok(pruned.completionMessages.length < session.completionMessages.length, 'some turns were dropped');
  // The most recent turn must survive.
  const last = pruned.completionMessages[pruned.completionMessages.length - 1] as { content?: string };
  assert.match(String(last.content ?? ''), /answer 4/);
});
