import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installStableRenderer } from '../src/utils/stable-render.js';

function fakeStdout() {
  const stdout = new EventEmitter() as any;
  stdout.writes = [] as string[];
  stdout.write = (chunk: any) => { stdout.writes.push(String(chunk)); return true; };
  installStableRenderer(stdout);
  return stdout;
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;
const repaint = (lines: string) => `\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G${lines}\n`;

test('Ink repaints are rewritten to home + overwrite, with no erase-all', () => {
  const stdout = fakeStdout();
  stdout.write(repaint('AAA\nBBB'));
  const out = stdout.writes[0];
  assert.ok(out.startsWith('\x1b[H'), 'repaint starts at home');
  assert.ok(!out.includes('\x1b[1A'), 'no erase-and-move-up sequence');
  assert.equal(count(out, '\x1b[K'), 2, 'one erase-end-line per row');
  assert.ok(out.includes('AAA\x1b[K\nBBB\x1b[K'));
});

test('a shorter frame clears rows left by a taller one', () => {
  const stdout = fakeStdout();
  stdout.write(repaint('1\n2\n3\n4\n5'));
  stdout.writes.length = 0;
  stdout.write(repaint('A\nB'));
  const out = stdout.writes[0];
  assert.equal(count(out, '\x1b[K'), 5, 'all five previous rows are overwritten');
  assert.ok(out.includes('A\x1b[K\nB\x1b[K\n\x1b[K\n\x1b[K\n\x1b[K'));
});

test('non-Ink writes pass through untouched', () => {
  const stdout = fakeStdout();
  for (const chunk of ['\x1b[?1049h', '\x1b]11;#000000\x07', '\x1b[?1000h\x1b[?1006h', 'plain log line\n']) {
    stdout.write(chunk);
  }
  assert.deepEqual(stdout.writes, [
    '\x1b[?1049h',
    '\x1b]11;#000000\x07',
    '\x1b[?1000h\x1b[?1006h',
    'plain log line\n',
  ]);
});

test('a bare clear passes through without fabricating frame rows', () => {
  const stdout = fakeStdout();
  stdout.write('\x1b[2K\x1b[1A\x1b[2K\x1b[G');
  assert.equal(stdout.writes[0], '\x1b[2K\x1b[1A\x1b[2K\x1b[G');
});

test('a zoom-out clamps painted rows to the live terminal height', () => {
  const stdout = fakeStdout();
  stdout.rows = 24;
  stdout.write(repaint(Array.from({ length: 23 }, (_, i) => `old${i}`).join('\n')));
  stdout.rows = 10;
  stdout.writes.length = 0;
  stdout.write(repaint('A\nB\nC'));
  const out = stdout.writes[0];
  const writtenLines = out.slice('\x1b[H'.length).split('\n').slice(0, -1);
  assert.ok(writtenLines.length <= 10, `wrote ${writtenLines.length} rows, expected <= 10`);
  assert.ok(count(out, '\x1b[K') <= 10, 'erases no more than the visible rows');
  assert.ok(!out.includes('\x1b[1A'), 'no erase-and-move-up sequence');
  assert.ok(out.includes('A\x1b[K\nB\x1b[K\nC\x1b[K'), 'new rows still painted');
});
