/**
 * The transcript must be a solid block that ends above the composer.
 *
 * A regression here looks like text bleeding under the input: the live area
 * painted over the composer, or a shorter frame leaving rows of the previous
 * one visible below it. These checks use a real sized stdout so the frame is
 * the same string a terminal would receive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render as renderInk } from 'ink';
import stripAnsi from 'strip-ansi';
import { App } from '../src/App.js';
import { createSession, saveSession } from '../src/sessions.js';
import { settle } from './helpers/wait.js';

class SizedStdout extends EventEmitter {
  frames: string[] = [];
  isTTY = true;
  constructor(public cols: number, public rowCount: number) {
    super();
  }
  get columns() { return this.cols; }
  get rows() { return this.rowCount; }
  write = (chunk: string | Uint8Array): boolean => {
    this.frames.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  /** Latest frame that shows the composer (raw control writes skipped). */
  frame(): string {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = stripAnsi(this.frames[i] ?? '');
      if (frame.includes('Build anything')) return frame;
    }
    return '';
  }
}

class SizedStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read() {
    const value = this.data;
    this.data = null;
    return value;
  }
  write = (data: string) => {
    this.data = data;
    this.emit('readable');
  };
}

class SizedStderr extends EventEmitter {
  write = (): boolean => true;
}

function makeHome(messages: number): { home: string; restore: () => void } {
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalKey = process.env.OPENAI_API_KEY;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-solid-'));
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
  fs.writeFileSync(
    path.join(home, '.config', 'bitacode', 'settings.json'),
    JSON.stringify({ animations: false, variant: 'none', mouseClicks: false })
  );
  fs.writeFileSync(
    path.join(home, '.config', 'bitacode', 'trusted.json'),
    JSON.stringify({ [home]: true })
  );
  process.chdir(home);
  return {
    home,
    restore: () => {
      process.chdir(originalCwd);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test('scrolling and resizing never paint transcript text below the composer', async () => {
  const sandbox = makeHome(12);
  const session = createSession('gpt-4o-mini', 'openai');
  session.completionMessages = [
    { role: 'system', content: 'sys' },
    ...Array.from({ length: 12 }, (_, i) => [
      { role: 'user', content: `question ${i}` },
      {
        role: 'assistant',
        content: `## Answer ${i}\n\n- alpha ${i}\n- beta ${i}\n\nSome **bold** text ${i}.\n\n| a | b |\n| --- | --- |\n| x${i} | y${i} |`,
      },
    ]).flat(),
  ] as any;
  await saveSession(session);

  const stdout = new SizedStdout(70, 20);
  const stdin = new SizedStdin();
  const app = renderInk(<App sessionId={session.id} />, {
    stdout: stdout as any,
    stdin: stdin as any,
    stderr: new SizedStderr() as any,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  const assertCleanFrame = (frame: string, rows: number) => {
    const lines = frame.split('\n');
    // Trailing empty strings are frame padding, not painted rows.
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    assert.ok(lines.length <= rows - 1, `frame is ${lines.length} rows on a ${rows}-row terminal`);
    const composerAt = lines.findIndex((line) => line.includes('Build anything'));
    assert.ok(composerAt > 0, 'composer is visible');
    // Nothing but the footer may follow the composer.
    const after = lines.slice(composerAt + 1).filter((line) => line.trim() !== '');
    assert.ok(
      after.every((line) => /ctx|gpt-4o-mini|OpenAI|📁/.test(line)),
      `no transcript text after the composer: ${JSON.stringify(after)}`
    );
  };

  try {
    await settle(800);
    assertCleanFrame(stdout.frame(), 20);

    // Scroll up into the history.
    for (let i = 0; i < 4; i++) {
      stdin.write('\u001b[5~');
      await settle(90);
    }
    assertCleanFrame(stdout.frame(), 20);

    // A resize (Android keyboards change the row count) must not leave stale
    // rows from the taller frame under the composer.
    stdout.rowCount = 14;
    stdout.emit('resize');
    await settle(250);
    assertCleanFrame(stdout.frame(), 14);
  } finally {
    app.unmount();
    app.cleanup();
    sandbox.restore();
  }
});
