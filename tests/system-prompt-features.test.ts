import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSystemPrompt } from '../src/system-prompt.js';

test('system prompt guides use of the bundled feature tools', async () => {
  const prompt = await generateSystemPrompt();

  for (const tool of ['undo', 'read_image', 'go_to_definition', 'find_references', 'diagnostics', 'plan', 'read_subagent']) {
    assert.match(prompt, new RegExp(`\\b${tool}\\b`));
  }

  assert.match(prompt, /in plan mode, present the plan/);
});

test('system prompt stays under the word budget', async () => {
  // Skill discovery reads the real home directory, so the catalog size depends
  // on what happens to be installed. Pin a clean home + cwd to measure the
  // prompt itself rather than this machine's skill collection.
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-prompt-'));
  try {
    process.env.HOME = sandbox;
    process.chdir(sandbox);
    const prompt = await generateSystemPrompt();
    const words = prompt.trim().split(/\s+/).length;
    assert.ok(words < 2100, `prompt is ${words} words (expected < 2100)`);
  } finally {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
