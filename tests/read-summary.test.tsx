import test from 'node:test';
import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import {
  describeRead,
  parseFileReadResult,
  type FileReadDisplay,
  type ReadSummary,
} from '../src/utils/file-diff.js';

// Ink only emits colour escapes when the renderer believes colour is enabled.
process.env.FORCE_COLOR = '3';
const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { ThemeProvider, themes } = await import('../src/theme.js');
const { ReadSummaryView } = await import('../src/components/ReadSummaryView.js');

/** Same truecolor escape Ink writes for a hex prop: \x1b[38;2;r;g;bm. */
function rgb(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

function summaryFrame(summary: ReadSummary, error?: string): string {
  const view = render(
    React.createElement(
      ThemeProvider,
      { name: 'dark' },
      React.createElement(ReadSummaryView, { summary, error })
    )
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}

const args = (filePath: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ file_path: filePath, ...extra });

test('a whole normal read sets totalLines to the line count', () => {
  const result = 'line one\nline two\nline three';
  const parsed = parseFileReadResult('read_file', args('src/a.ts'), result);
  assert.ok(parsed);
  assert.equal(parsed.totalLines, 3);
  assert.deepEqual(describeRead(parsed), { filePath: 'src/a.ts', total: 3 });
});

test('a partial read computes the total and describes its actual range', () => {
  const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
  const result = `${body}\n... (5 more line(s); use offset=10 to continue)`;
  const parsed = parseFileReadResult('read_file', args('src/a.ts'), result);
  assert.ok(parsed);
  assert.equal(parsed.totalLines, 15);
  assert.deepEqual(describeRead(parsed), { filePath: 'src/a.ts', range: '1-10' });

  const offset = parseFileReadResult(
    'read_file',
    args('src/a.ts', { offset: 9 }),
    'one\ntwo\n... (5 more line(s); use offset=11 to continue)'
  );
  assert.equal(offset?.totalLines, 16);
  assert.deepEqual(describeRead(offset!), { filePath: 'src/a.ts', range: '10-11' });
});

test('a range read describes its range and a full range yields the total', () => {
  const lines = Array.from({ length: 59 }, (_, i) => `content ${i + 10}`);
  const parsed = parseFileReadResult(
    'read_file',
    args('src/tools/index.ts', { ranges: '10-68' }),
    `[lines 10-68]\n${lines.join('\n')}`
  );
  assert.ok(parsed);
  assert.equal(parsed.totalLines, undefined);
  assert.deepEqual(describeRead(parsed), { filePath: 'src/tools/index.ts', range: '10-68' });

  const fullLines = Array.from({ length: 899 }, (_, i) => `content ${i + 1}`);
  const full = parseFileReadResult(
    'read_file',
    args('src/tools/index.ts', { ranges: '1-900' }),
    `[lines 1-900]\n${fullLines.join('\n')}\n... (file ends at line 899)`
  );
  assert.ok(full);
  assert.equal(full.totalLines, 899);
  assert.deepEqual(describeRead(full), { filePath: 'src/tools/index.ts', total: 899 });
});

test('error, empty and malformed inputs never throw', () => {
  assert.equal(parseFileReadResult('read_file', '{}', 'Error: cannot read nope.ts'), null);
  assert.equal(
    parseFileReadResult('read_file', '{}', '(no lines read: offset 999 is past the end)'),
    null
  );

  const emptyFile = parseFileReadResult('read_file', args('src/empty.ts'), '');
  assert.deepEqual(describeRead(emptyFile!), { filePath: 'src/empty.ts', empty: true });
  assert.deepEqual(
    describeRead({ sections: [{ startLine: 1, endLine: 1, lines: [], note: '(empty file)' }] }),
    { filePath: 'file', empty: true }
  );
  const noLines = parseFileReadResult(
    'read_file',
    args('src/tools/index.ts', { ranges: '5-6' }),
    '[lines 5-6]\n(no lines: file has 899 line(s))'
  );
  assert.equal(noLines?.totalLines, 899);
  assert.deepEqual(describeRead(noLines!), { filePath: 'src/tools/index.ts', empty: true });

  assert.deepEqual(describeRead({} as FileReadDisplay), { filePath: 'file', empty: true });
  assert.deepEqual(describeRead({ filePath: undefined, sections: undefined as never }), {
    filePath: 'file',
    empty: true,
  });
});

test('ReadSummaryView renders one clean row with the path and meta', () => {
  const rangeFrame = summaryFrame({ filePath: 'src/tools/index.ts', range: '10-68' });
  const rangeText = stripAnsi(rangeFrame);
  assert.match(rangeText, /src\/tools\/index\.ts/);
  assert.match(rangeText, /lines 10-68/);
  assert.match(rangeText, /▤/);
  assert.doesNotMatch(rangeText, /[╭│╰]/);
  assert.equal(rangeText.trim().split('\n').length, 1);

  const totalText = stripAnsi(summaryFrame({ filePath: 'src/tools/index.ts', total: 899 }));
  assert.match(totalText, /899 lines/);
  const emptyText = stripAnsi(summaryFrame({ filePath: 'src/tools/index.ts', empty: true }));
  assert.match(emptyText, /empty/);
});

test('ReadSummaryView shows an error message in the error colour', () => {
  const frame = summaryFrame({ filePath: 'src/tools/index.ts' }, 'read failed');
  assert.match(stripAnsi(frame), /read failed/);
  assert.ok(frame.includes(rgb(themes.dark.error)), 'error text uses theme.error');
});
