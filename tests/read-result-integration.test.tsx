import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ThemeProvider } from '../src/theme.js';
import { addToolResultView } from '../src/utils/tool-result-view.js';

/** Capture the static card the transcript renderer would flush to scrollback. */
function renderResult(toolName: string, args: unknown, result: string): string {
  const nodes: React.ReactNode[] = [];
  addToolResultView((node) => { nodes.push(node); }, toolName, JSON.stringify(args), result);
  const view = render(<ThemeProvider name="black">{nodes[0]}</ThemeProvider>);
  const frame = stripAnsi(view.lastFrame() ?? '');
  view.unmount();
  return frame;
}

test('read_file result is a clean one-line path + range, with no box', () => {
  const frame = renderResult(
    'read_file',
    { file_path: 'src/tools/index.ts' },
    'first line\nsecond line\n... (897 more line(s); use offset=2 to continue)'
  );
  assert.match(frame, /▤ src\/tools\/index\.ts/);
  assert.match(frame, /· 1-2/);
  assert.doesNotMatch(frame, /[╭╮╰╯│]/, 'no bordered box');
  assert.doesNotMatch(frame, /more line\(s\)/, 'raw tool payload is not printed');
});

test('read summary has no border, no blank row above and exactly one below', () => {
  const frame = renderResult('read_file', { file_path: 'src/a.ts' }, 'one\ntwo\nthree');
  assert.doesNotMatch(frame, /[╭╮╰╯│]/, 'no box');
  // Ink renders a bottom margin as a single empty trailing line. The old
  // marginY added a blank row above too, which read results must not have.
  const lines = frame.split('\n');
  assert.equal(lines.length, 2, `expected a content row and one blank row: ${JSON.stringify(frame)}`);
  assert.match(lines[0], /▤ src\/a\.ts · 3 lines/, 'content is the first row');
  assert.equal(lines[1], '', 'exactly one blank row below the result');
});

test('a full read reports the total line count', () => {
  const frame = renderResult('read_file', { file_path: 'src/a.ts' }, 'one\ntwo\nthree');
  assert.match(frame, /▤ src\/a\.ts · 3 lines/);
});

test('read errors keep the same clean shape', () => {
  const frame = renderResult('read_file', { file_path: 'src/missing.ts' }, 'Error: ENOENT: no such file');
  assert.match(frame, /▤ src\/missing\.ts/);
  assert.match(frame, /ENOENT/);
  assert.doesNotMatch(frame, /[╭╮╰╯]/, 'errors do not draw a box either');
});

test('read_lines result is a clean one-line summary with all requested ranges', () => {
  const body = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join('\n');
  const frame = renderResult(
    'read_lines',
    { file_path: 'src/tool/index.ts', from: 30, to: 140, ranges: '30-90, 67-140' },
    `[lines 30-90]\n${body(30, 90)}\n[lines 67-140]\n${body(67, 140)}`
  );
  assert.match(frame, /▤ src\/tool\/index\.ts · 30-90, 67-140/);
  assert.doesNotMatch(frame, /[╭╮╰╯│]/, 'no box');
  assert.doesNotMatch(frame, /\[lines /, 'raw payload is not printed');
  const lines = frame.split('\n');
  assert.equal(lines.length, 2, `one content row plus one blank row: ${JSON.stringify(frame)}`);
  assert.match(lines[0], /▤ src\/tool\/index\.ts · 30-90, 67-140/);
  assert.equal(lines[1], '', 'exactly one blank row below the result');
});
