import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import chalk from 'chalk';
import { getTheme } from '../src/theme.js';
import { CodeBlock } from '../src/components/CodeBlock.js';
import { DiffView } from '../src/components/DiffView.js';
import { ReadFileView } from '../src/components/ReadFileView.js';
import { ShellView } from '../src/components/ShellView.js';
import { parseFileReadResult } from '../src/utils/file-diff.js';
import { addToolResultView } from '../src/utils/tool-result-view.js';

const plain = (frame: string | undefined): string => stripAnsi(frame ?? '');

test('CodeBlock renders a header, line numbers and a bounded row budget', () => {
  const code = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
  const frame = plain(
    render(
      <CodeBlock
        code={code}
        language="ts"
        filename="src/a.ts"
        showHeader
        showLineNumbers
        maxRows={3}
        columns={40}
      />
    ).lastFrame()
  );

  assert.match(frame, /src\/a\.ts/);
  assert.match(frame, /line 0/);
  assert.match(frame, /… 17 more lines/);
  assert.doesNotMatch(frame, /line 3/);
  const rows = frame.split('\n').filter((line) => line.trim().length > 0).length;
  assert.ok(rows <= 7, `box grew to ${rows} content rows`);
});

test('CodeBlock preserves code text verbatim', () => {
  const code = 'const value = 1;';
  const frame = render(<CodeBlock code={code} language="ts" />).lastFrame() ?? '';
  assert.match(plain(frame), /const value = 1;/);
});

test('CodeBlock never crashes the UI on malformed input', () => {
  const broken = render(<CodeBlock code={null as unknown as string} language="ts" />).lastFrame() ?? '';
  assert.match(plain(broken), /╭/, 'a plain bordered box is rendered instead of throwing');

  const objectish = render(<CodeBlock code={{} as unknown as string} language="ts" />).lastFrame() ?? '';
  assert.match(plain(objectish), /\[object Object\]/);
});

test('DiffView keeps +/- colouring with two number columns and an explicit language', () => {
  const diff = '@@ -1 +1 @@\n-const old = 1\n+const new = 2';
  const frame = plain(render(<DiffView header="Edited a.ts" diff={diff} filePath="a.ts" />).lastFrame());

  assert.match(frame, /Edited a\.ts/);
  assert.match(frame, /- const old = 1/);
  assert.match(frame, /\+ const new = 2/);

  // An explicit language is accepted for compatibility but cannot recolor a diff line.
  const styled = plain(render(<DiffView header="Edited a.ts" diff={diff} filePath="a.ts" language="ts" />).lastFrame());
  assert.match(styled, /\+ const new = 2/);
});

test('DiffView paints every content token in one row colour (raw ANSI)', () => {
  const palette = getTheme();
  const ansi = (hex: string): string => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `\u001b[38;2;${r};${g};${b}m`;
  };
  const contentOf = (row: string): string => (row.split(' │ ')[1] ?? row).split('\u001b[39m')[0] ?? '';

  // `const` (keyword) and the string literals would normally pick up the gold
  // accent token colour; a diff row must stay uniformly red or green instead.
  const diff = '@@ -1 +1 @@\n-const old = "before"\n+const next = "after"';
  const level = (chalk as unknown as { level: number }).level;
  (chalk as unknown as { level: number }).level = 3;
  let raw = '';
  try {
    raw = render(<DiffView header="Edited a.ts" diff={diff} filePath="a.ts" language="ts" />).lastFrame() ?? '';
  } finally {
    (chalk as unknown as { level: number }).level = level;
  }

  const rows = raw.split('\n');
  const removal = rows.find((row) => row.includes('old = "before"')) ?? '';
  const addition = rows.find((row) => row.includes('next = "after"')) ?? '';
  assert.ok(removal && addition, 'both diff rows rendered');

  assert.equal(contentOf(removal), `${ansi(palette.error)}- const old = "before"`);
  assert.equal(contentOf(addition), `${ansi(palette.success)}+ const next = "after"`);
  // No syntax token (notably the gold/accent one) leaks into a diff line.
  assert.ok(!removal.includes(ansi(palette.accent)), 'no accent token in a removal row');
  assert.ok(!addition.includes(ansi(palette.accent)), 'no accent token in an addition row');
});

test('ReadFileView combines line numbers with highlighted code', () => {
  const parsed = parseFileReadResult(
    'read_file',
    JSON.stringify({ file_path: 'src/a.ts' }),
    'const a = 1\nreturn a'
  )!;
  const frame = plain(render(<ReadFileView {...parsed} />).lastFrame());
  assert.match(frame, /1\s+│ const a = 1/);
  assert.match(frame, /2\s+│ return a/);

  // An explicit language must not change the rendered text.
  const styled = plain(render(<ReadFileView {...parsed} language="ts" />).lastFrame());
  assert.match(styled, /1\s+│ const a = 1/);
});

test('ShellView highlights the command without changing its text', () => {
  const frame = plain(
    render(<ShellView command={'echo "hi" && cd /tmp'} output="done" isError={false} />).lastFrame()
  );
  assert.match(frame, /❯ echo "hi" && cd \/tmp/);
  assert.match(frame, /done/);
});

test('tool results with code get a bounded code box; short results stay one-line', () => {
  const codeNodes: React.ReactNode[] = [];
  addToolResultView(
    (node) => codeNodes.push(node),
    'webfetch',
    JSON.stringify({ url: 'https://example.com' }),
    '{\n  "a": 1,\n  "b": 2\n}'
  );
  assert.equal(codeNodes.length, 1);
  const codeFrame = plain(render(codeNodes[0]).lastFrame());
  assert.match(codeFrame, /╭/);
  assert.match(codeFrame, /"a": 1/);

  const shortNodes: React.ReactNode[] = [];
  addToolResultView((node) => shortNodes.push(node), 'glob', JSON.stringify({ pattern: '*.ts' }), 'a.ts');
  assert.equal(shortNodes.length, 1);
  assert.match(plain(render(shortNodes[0]).lastFrame()), /a\.ts/);
});
