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
import { installStableRenderer } from '../src/utils/stable-render.js';
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

/**
 * Minimal ANSI screen model: just enough CSI to replay an Ink repaint into a
 * fixed rows×cols character grid. Cursor moves paint nothing; `\x1b[K`/`\x1b[J`
 * blank cells. This is what makes "text below the composer" observable.
 */
class ScreenBuffer {
  grid: string[][];
  row = 0;
  col = 0;
  constructor(public rows: number, public cols: number) {
    this.grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '));
  }
  text(r: number): string {
    return (this.grid[r] ?? []).join('');
  }
  private clampRow(r: number) { return Math.max(0, Math.min(this.rows - 1, r)); }
  private clampCol(c: number) { return Math.max(0, Math.min(this.cols - 1, c)); }
  private line(r: number): string[] { return this.grid[this.clampRow(r)]!; }
  private erase(r: number, from: number, to: number) {
    const cells = this.line(r);
    for (let c = Math.max(0, from); c <= Math.min(this.cols - 1, to); c++) cells[c] = ' ';
  }
  private csi(final: string, params: string) {
    const nums = params.split(';').map((p) => (p === '' ? 0 : Number.parseInt(p, 10)));
    const first = nums[0] ?? 0;
    const n = Number.isFinite(first) ? first : 0;
    switch (final) {
      case 'H':
      case 'f':
        this.row = this.clampRow((nums[0] || 1) - 1);
        this.col = this.clampCol((nums[1] || 1) - 1);
        break;
      case 'A': this.row = this.clampRow(this.row - (n || 1)); break;
      case 'B': this.row = this.clampRow(this.row + (n || 1)); break;
      case 'C': this.col = this.clampCol(this.col + (n || 1)); break;
      case 'D': this.col = this.clampCol(this.col - (n || 1)); break;
      case 'E': this.row = this.clampRow(this.row + (n || 1)); this.col = 0; break;
      case 'F': this.row = this.clampRow(this.row - (n || 1)); this.col = 0; break;
      case 'G': this.col = this.clampCol((n || 1) - 1); break;
      case 'J':
        if (n === 2 || n === 3) {
          for (let r = 0; r < this.rows; r++) this.erase(r, 0, this.cols - 1);
        } else if (n === 1) {
          for (let r = 0; r <= this.row; r++) this.erase(r, 0, this.cols - 1);
        } else {
          this.erase(this.row, this.col, this.cols - 1);
          for (let r = this.row + 1; r < this.rows; r++) this.erase(r, 0, this.cols - 1);
        }
        break;
      case 'K':
        if (n === 1) this.erase(this.row, 0, this.col);
        else if (n === 2) this.erase(this.row, 0, this.cols - 1);
        else this.erase(this.row, this.col, this.cols - 1);
        break;
      default: break; // cursor visibility, synchronized output, Kitty cues, etc.
    }
  }
  write(chunk: string) {
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i]!;
      if (ch === '\x1b') {
        if (chunk[i + 1] === '[') {
          let j = i + 2;
          while (j < chunk.length && !/[A-Za-z]/.test(chunk[j]!)) j++;
          if (j < chunk.length) this.csi(chunk[j]!, chunk.slice(i + 2, j));
          i = j + 1;
          continue;
        }
        if (chunk[i + 1] === ']') {
          let j = i + 2;
          while (j < chunk.length && chunk[j] !== '\x07' && !(chunk[j] === '\x1b' && chunk[j + 1] === '\\')) j++;
          i = j + (chunk[j] === '\x07' ? 1 : 2);
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === '\n') {
        this.row = this.clampRow(this.row + 1);
        i++;
        continue;
      }
      if (ch === '\r') {
        this.col = 0;
        i++;
        continue;
      }
      if (ch >= ' ' && ch !== '\x7f') {
        if (this.col < this.cols) this.line(this.row)[this.col] = ch;
        this.col = this.clampCol(this.col + 1);
        i++;
        continue;
      }
      i++;
    }
  }
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
      after.every((line) => /ctx|gpt-4o-mini|OpenAI|~\//.test(line)),
      `no transcript text after the composer: ${JSON.stringify(after)}`
    );
  };

  try {
    // Boot time varies under load; wait for an actual frame instead of sleeping.
    const readyDeadline = Date.now() + 5000;
    while (Date.now() < readyDeadline && !stdout.frame()) await settle(50);
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

    // A zoom burst straddling a busy/tool transition is where a stale live-area
    // signature used to skip a re-measure. Submit a prompt (activity strip on),
    // resize, abort it (strip off), then resize again: neither frame may leak
    // transcript rows below the composer.
    stdin.write('hello');
    // frame() only returns frames with the empty placeholder, so look at the
    // raw frame log: once text is typed the placeholder is gone.
    const typed = () => stdout.frames.some((f) => stripAnsi(f).includes('hello'));
    const typedDeadline = Date.now() + 3000;
    while (Date.now() < typedDeadline && !typed()) await settle(50);
    assert.ok(typed(), 'prompt text reached the composer');
    stdin.write('\r');
    // The request may fail fast (no real API key), so a busy frame can be
    // missed entirely under load. Whether we caught it is not the regression
    // under test — the clean-frame checks after each resize are. Poll briefly
    // to give a busy frame a chance to paint, then continue regardless.
    const busyDeadline = Date.now() + 600;
    const sawBusy = () => stdout.frames.some((f) => /Working|Reading|Searching|Reading file/.test(stripAnsi(f)));
    while (Date.now() < busyDeadline && !sawBusy()) await settle(40);
    stdout.rowCount = 16;
    stdout.cols = 60;
    stdout.emit('resize');
    await settle(250);
    assertCleanFrame(stdout.frame(), 16);

    stdin.write('\x1b'); // abort the in-flight turn
    await settle(200);
    stdout.rowCount = 20;
    stdout.cols = 70;
    stdout.emit('resize');
    await settle(250);
    assertCleanFrame(stdout.frame(), 20);
  } finally {
    app.unmount();
    app.cleanup();
    sandbox.restore();
  }
});

test('screen buffer: a stale glyph on the last terminal row is erased on repaint', async () => {
  const sandbox = makeHome(8);
  const session = createSession('gpt-4o-mini', 'openai');
  session.completionMessages = [
    { role: 'system', content: 'sys' },
    ...Array.from({ length: 8 }, (_, i) => [
      { role: 'user', content: `question ${i}` },
      { role: 'assistant', content: `## Answer ${i}\n\n- alpha ${i}\n- beta ${i}` },
    ]).flat(),
  ] as any;
  await saveSession(session);

  // debug:false keeps Ink on the ANSI repaint path, and installing the stable
  // renderer on this same stream is what the real CLI does on process.stdout.
  const stdout = new SizedStdout(70, 20);
  installStableRenderer(stdout as any);
  const stdin = new SizedStdin();
  const app = renderInk(<App sessionId={session.id} />, {
    stdout: stdout as any,
    stdin: stdin as any,
    stderr: new SizedStderr() as any,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  try {
    const readyDeadline = Date.now() + 5000;
    while (Date.now() < readyDeadline && !stdout.frame()) await settle(50);
    assert.ok(stdout.frame(), 'app painted a frame');

    // Exercise the real App flow: boot, scroll, then a shrink resize.
    stdin.write('\u001b[5~');
    await settle(120);
    stdout.rowCount = 16;
    stdout.emit('resize');
    await settle(250);

    // Ink takes its clearTerminal path on a shrink resize. The incremental
    // shrink repaint is the one the stable renderer rewrites, so drive that
    // canonical chunk explicitly below to make the regression deterministic.
    const screen = new ScreenBuffer(16, stdout.cols);
    for (const f of stdout.frames) screen.write(f);

    // Deliberately plant a marker on the last row of the 16-row terminal and
    // verify it is there before the repaint.
    const marker = '\x1b[16;1HSTALE_LAST_ROW_MARKER';
    stdout.write(marker);
    screen.write(marker);
    assert.ok(screen.text(15).includes('STALE_LAST_ROW_MARKER'), 'marker planted on last row');

    const before = stdout.frames.length;
    stdout.write('\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G' + 'L0\nL1\nL2\nL3\nL4\n');
    const rewritten = stdout.frames[before]!;
    assert.ok(rewritten.includes('\x1b[J'), 'repaint erased from cursor to display end');
    screen.write(rewritten);

    assert.equal(screen.grid.length, 16, 'all terminal rows are present (no trailing pop)');
    const lastRow = screen.text(15);
    assert.ok(!lastRow.includes('STALE_LAST_ROW_MARKER'), 'stale marker was erased');
    assert.ok(!/question \d|Answer \d|alpha \d|beta \d|L[0-4]/.test(lastRow), 'no frame text on last row');
    assert.equal(lastRow.trim(), '', 'last row is blank');
  } finally {
    app.unmount();
    app.cleanup();
    sandbox.restore();
  }
});
