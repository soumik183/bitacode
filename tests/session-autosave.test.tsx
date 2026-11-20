/**
 * Sessions must be on disk before the first turn ends and must survive a turn
 * that fails mid-flight. These tests drive the real App against a fake SSE
 * provider and read the session store afterwards.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/App.js';
import { listSessions, loadSession } from '../src/sessions.js';
import { settle, waitForFrame } from './helpers/wait.js';

interface Sandbox {
  home: string;
  restore: () => void;
}

function makeSandbox(prefix: string, port?: number): Sandbox {
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalBase = process.env.BITACODE_BASE_URL;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HOME = home;
  process.env.OPENAI_API_KEY = 'test-key';
  if (port) process.env.BITACODE_BASE_URL = `http://127.0.0.1:${port}/v1`;
  fs.mkdirSync(path.join(home, '.config', 'bitacode'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config', 'bitacode', 'bitacode.jsonc'),
    JSON.stringify({
      providers: {
        openai: {
          apiKey: 'test-key',
          ...(port ? { baseURL: `http://127.0.0.1:${port}/v1` } : {}),
          models: { 'gpt-4o-mini': {} },
        },
      },
      mcp: { servers: {} },
    })
  );
  process.chdir(home);
  return {
    home,
    restore: () => {
      process.chdir(originalCwd);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalBase === undefined) delete process.env.BITACODE_BASE_URL;
      else process.env.BITACODE_BASE_URL = originalBase;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function sessionFiles(home: string): string[] {
  const dir = path.join(home, '.local', 'share', 'bitacode', 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith('.json'));
}

test('a fresh session is registered on disk before the first turn', async () => {
  const sandbox = makeSandbox('bitacode-autosave-boot-');
  const app = render(<App />);
  try {
    await waitForFrame(app.lastFrame, (frame) => frame.includes('Build anything…'));
    await settle(300);
    const files = sessionFiles(sandbox.home);
    assert.equal(files.length, 1, 'the new session exists immediately');
    const id = files[0]!.replace(/\.json$/, '');
    const loaded = await loadSession(id);
    assert.ok(loaded, 'the registered session is loadable');
    assert.equal(loaded.id, id);
  } finally {
    app.unmount();
    app.cleanup();
    sandbox.restore();
  }
});

test('a finished turn is saved with a readable title and can be re-opened', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({
      id: 'c1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'saved answer' }, finish_reason: null }],
    });
    send({
      id: 'c2',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const sandbox = makeSandbox('bitacode-autosave-turn-', port);

  const app = render(<App />);
  try {
    await waitForFrame(app.lastFrame, (frame) => frame.includes('Build anything…'));
    await settle(400);
    app.stdin.write('save me 42');
    await waitForFrame(app.lastFrame, (frame) => frame.includes('save me 42'));
    await settle(150);
    app.stdin.write('\r');

    // Autosave fires ~0.7 s after the transcript settles; poll rather than
    // sleeping a fixed amount so a slow CI box is not flaky.
    const deadline = Date.now() + 5_000;
    let saved: Awaited<ReturnType<typeof loadSession>> = null;
    while (Date.now() < deadline) {
      const files = sessionFiles(sandbox.home);
      if (files.length > 0) {
        const candidate = await loadSession(files[0]!.replace(/\.json$/, ''));
        const text = JSON.stringify(candidate?.completionMessages ?? []);
        if (text.includes('save me 42') && text.includes('saved answer')) {
          saved = candidate;
          break;
        }
      }
      await settle(100);
    }

    assert.ok(saved, 'the finished turn reached disk');
    assert.equal(saved.title, 'save me 42');
    const conversation = saved.completionMessages.filter((m) => m.role !== 'system');
    assert.deepEqual(
      conversation.map((m) => m.role),
      ['user', 'assistant']
    );

    const [summary] = await listSessions();
    assert.equal(summary.id, saved.id);
    assert.equal(summary.title, 'save me 42');
    assert.equal(summary.messageCount, 2, 'system prompt is not a user message');
  } finally {
    app.unmount();
    app.cleanup();
    sandbox.restore();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
