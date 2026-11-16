import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { ConfigureComponent, type Config } from '../src/config.js';
import { settle, waitFor, waitForFrame } from './helpers/wait.js';

test('first-run wizard saves the chosen provider/model and reports it back', async () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalBitacodeKey = process.env.BITACODE_API_KEY;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-first-run-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-first-run-home-'));

  try {
    process.chdir(cwd);
    process.env.HOME = home;
    delete process.env.OPENAI_API_KEY;
    delete process.env.BITACODE_API_KEY;

    let completed: Config | null = null;
    const { lastFrame, stdin } = render(
      <ConfigureComponent firstRun onComplete={(config) => { completed = config; }} />
    );

    await waitForFrame(lastFrame, (frame) => /Welcome to Bitacode/.test(frame));
    await settle(50);

    stdin.write('\r'); // first model
    await waitForFrame(lastFrame, (frame) => /API Key/.test(frame));
    await settle(50);

    stdin.write('test-key');
    const typedFrame = await waitForFrame(lastFrame, (frame) => /\*{8}/.test(frame));
    assert.match(typedFrame, /\*{8}/, 'API key input did not receive the whole test key');
    await settle(50);
    stdin.write('\r');
    await waitFor(() => completed !== null);

    assert.ok(completed);
    assert.equal(completed!.provider, 'openai');
    assert.ok(completed!.model);
    assert.equal(completed!.apiKey, 'test-key');
    assert.ok(fs.existsSync(path.join(home, '.config', 'bitacode', 'bitacode.jsonc')));
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalBitacodeKey === undefined) delete process.env.BITACODE_API_KEY;
    else process.env.BITACODE_API_KEY = originalBitacodeKey;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
