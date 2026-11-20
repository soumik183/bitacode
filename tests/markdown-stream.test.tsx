/**
 * Markdown arrives formatted *while* a reply streams.
 *
 * The streamed text used to be flushed one line at a time, so a table never saw
 * its separator row and a heading could arrive split in two. This drives a real
 * SSE reply through App and checks the frame shows rendered markdown.
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

test('tables, headings and bold render as the reply streams', async () => {
  const chunks = [
    '## Results\n\n',
    'Some **bold** conclusion.\n\n',
    '| name | value |\n',
    '| --- | --- |\n',
    '| alpha | 1 |\n',
    '| beta | 2 |\n',
  ];
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    chunks.forEach((content, index) => {
      setTimeout(() => {
        send({
          id: `c${index}`,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        });
      }, 60 + index * 120);
    });
    setTimeout(() => {
      send({
        id: 'end',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.end();
    }, 60 + chunks.length * 120 + 60);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalBase = process.env.BITACODE_BASE_URL;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-md-stream-'));
  process.env.HOME = home;
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.BITACODE_BASE_URL = `http://127.0.0.1:${port}/v1`;
  fs.mkdirSync(path.join(home, '.config', 'bitacode'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config', 'bitacode', 'bitacode.jsonc'),
    JSON.stringify({
      providers: {
        openai: {
          apiKey: 'test-key',
          baseURL: `http://127.0.0.1:${port}/v1`,
          models: { 'gpt-4o-mini': {} },
        },
      },
      mcp: { servers: {} },
    })
  );
  fs.writeFileSync(
    path.join(home, '.config', 'bitacode', 'settings.json'),
    JSON.stringify({ animations: false, variant: 'none' })
  );
  process.chdir(home);

  const app = render(<App />);
  try {
    await waitForFrame(app.lastFrame, (frame) => frame.includes('Build anything…'));
    await settle(400);
    app.stdin.write('show me a table');
    await waitForFrame(app.lastFrame, (frame) => frame.includes('show me a table'));
    await settle(150);
    app.stdin.write('\r');

    // Sample while the reply is still arriving: the live tail must show
    // formatted markdown, not a blank area that only fills in at the end.
    const deadline = Date.now() + 4_000;
    let last = '';
    let sawLiveHeading = false;
    let sawLiveTable = false;
    while (Date.now() < deadline) {
      last = stripAnsi(app.lastFrame() ?? '');
      const streamingLive = last.includes('▍') && last.includes('Working');
      if (streamingLive && last.includes('Results')) sawLiveHeading = true;
      if (streamingLive && last.includes('│ name')) sawLiveTable = true;
      if (last.includes('Done') || (!last.includes('▍') && last.includes('├'))) break;
      await settle(40);
    }

    assert.ok(sawLiveHeading, 'the heading is visible while the reply streams');
    assert.ok(sawLiveTable, 'the table is boxed while the reply streams');

    assert.match(last, /Results/, 'the heading is rendered');
    assert.doesNotMatch(last, /^## /m, 'no raw heading marker');
    assert.match(last, /Some bold conclusion\./, 'bold markers are consumed');
    assert.match(last, /│ name\s+│ value │/, 'the table header is boxed');
    assert.match(last, /├─+┼─+┤/, 'the table divider is drawn');
    assert.doesNotMatch(last, /\|\s*---/, 'the separator row is never printed raw');
  } finally {
    app.unmount();
    app.cleanup();
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalBase === undefined) delete process.env.BITACODE_BASE_URL;
    else process.env.BITACODE_BASE_URL = originalBase;
    fs.rmSync(home, { recursive: true, force: true });
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
