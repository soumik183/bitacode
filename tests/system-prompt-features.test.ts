import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSystemPrompt } from '../src/system-prompt.js';

test('system prompt guides use of the bundled feature tools', async () => {
  const prompt = await generateSystemPrompt();

  for (const tool of ['undo', 'read_image', 'go_to_definition', 'find_references', 'diagnostics', 'plan', 'read_subagent']) {
    assert.match(prompt, new RegExp(`\\b${tool}\\b`));
  }

  assert.match(prompt, /in plan mode, present the plan/);
});

test('system prompt stays under the word budget', async () => {
  const prompt = await generateSystemPrompt();
  const words = prompt.trim().split(/\s+/).length;
  assert.ok(words < 2100, `prompt is ${words} words (expected < 2100)`);
});
