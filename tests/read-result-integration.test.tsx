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
  assert.match(frame, /lines 1-2/);
  assert.doesNotMatch(frame, /[╭╮╰╯│]/, 'no bordered box');
  assert.doesNotMatch(frame, /more line\(s\)/, 'raw tool payload is not printed');
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
