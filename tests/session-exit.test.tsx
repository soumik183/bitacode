import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { App } from '../src/App.js';
import { settle, waitForFrame } from './helpers/wait.js';

test('ctrl+c saves the session and prints a resume card after Ink exits', async () => {
  const originalHome = process.env.HOME;
  const originalKey = process.env.OPENAI_API_KEY;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-exit-'));
  process.env.HOME = home;
  process.env.OPENAI_API_KEY = 'test-key';
  fs.mkdirSync(path.join(home, '.config', 'bitacode'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config', 'bitacode', 'bitacode.jsonc'),
    JSON.stringify({
      providers: { openai: { apiKey: 'test-key', models: { 'gpt-4o-mini': {} } } },
      mcp: { servers: {} },
    })
  );

  const app = render(<App />);
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));
    await settle(400);
    app.stdin.write('999');
    await waitForFrame(app.lastFrame, (f) => f.includes('999'));
    await settle(200);
    app.stdin.write('\r');
    await settle(200);
    app.stdin.write('\x03'); // ctrl+c

    const deadline = Date.now() + 4000;
    let card = '';
    while (Date.now() < deadline) {
      card = app.stdout.frames.map((frame) => stripAnsi(frame)).find((frame) => frame.includes('S E S S I O N')) ?? '';
      if (card) break;
      await settle(30);
    }
    assert.ok(card, 'a resume card was printed after exit');
    assert.match(card, /npx bitacode@latest --session [0-9a-z]+/, 'card contains a resumable id');

    const sessionDir = path.join(home, '.local', 'share', 'bitacode', 'sessions');
    const saved = fs.readdirSync(sessionDir);
    assert.equal(saved.length, 1, 'the live session was saved on ctrl+c');
    const id = saved[0]!.replace(/\.json$/, '');
    assert.match(card, new RegExp(`--session ${id}\\b`));
  } finally {
    app.unmount();
    app.cleanup();
    process.env.HOME = originalHome;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
