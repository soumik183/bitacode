import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSystemPrompt } from '../src/system-prompt.js';

test('system prompt gives explicit TODO-list and ask_user guidance', async () => {
  const prompt = await generateSystemPrompt();

  assert.match(prompt, /# TODO lists/);
  assert.match(prompt, /todo_write/);
  assert.match(prompt, /todo_read/);
  assert.match(prompt, /multi-step work/);

  assert.match(prompt, /# Asking questions/);
  assert.match(prompt, /ask_user/);
  assert.match(prompt, /recommended: true/);
  assert.match(prompt, /Group independent questions/);
});
