/**
 * Regression for the "thinking at the bottom" layout bug: a live thought must
 * stream directly under the user message that caused it, not at the foot of
 * the screen with a gap above it. Drives a real SSE response through App.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { App } from '../src/App.js';
import { settle, waitForFrame } from './helpers/wait.js';

test('live thinking renders directly after the user message', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({
      id: 'c1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { reasoning_content: 'step one think' }, finish_reason: null }],
    });
    setTimeout(() => {
      send({
        id: 'c2',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'final answer' }, finish_reason: null }],
      });
      send({
        id: 'c3',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.end();
    }, 400);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const originalHome = process.env.HOME;
  const originalBase = process.env.BITACODE_BASE_URL;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-stream-'));
  process.env.HOME = home;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.BITACODE_BASE_URL = `http://127.0.0.1:${port}/v1`;
  fs.mkdirSync(path.join(home, '.config', 'bitacode'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config', 'bitacode', 'bitacode.jsonc'),
    JSON.stringify({
      providers: {
        openai: { apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}/v1`, models: { 'gpt-4o-mini': {} } },
      },
      mcp: { servers: {} },
    })
  );

  const app = render(<App />);
  try {
    await waitForFrame(app.lastFrame, (f) => f.includes('Build anything…'));
    // Ink registers useInput handlers in an effect; give it a beat before typing.
    await settle(400);
    app.stdin.write('999');
    await waitForFrame(app.lastFrame, (f) => f.includes('999'));
    await settle(250);
    app.stdin.write('\r');
    const frame = stripAnsi(await waitForFrame(app.lastFrame, (f) => f.includes('Thinking')));
    const lines = frame.split('\n');
    const userRow = lines.findIndex((line) => line.includes('999'));
    const thinkRow = lines.findIndex((line) => line.includes('Thinking'));
    assert.ok(userRow >= 0, 'user message rendered');
    assert.ok(thinkRow >= 0, 'thinking rendered');
    assert.ok(thinkRow > userRow, 'thinking comes after the user message');
    assert.ok(thinkRow - userRow <= 4, 'thinking is adjacent, not pinned to the bottom');
  } finally {
    app.unmount();
    app.cleanup();
    server.close();
    process.env.HOME = originalHome;
    if (originalBase === undefined) delete process.env.BITACODE_BASE_URL;
    else process.env.BITACODE_BASE_URL = originalBase;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
