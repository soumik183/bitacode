import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ThemeProvider } from '../src/theme.js';
import { resolveItemRows } from '../src/utils/transcript-rows.js';
import { ShellView, SHELL_EXPANDED_MAX_LINES } from '../src/components/ShellView.js';
import { ReadFileView, READ_PREVIEW_LINES } from '../src/components/ReadFileView.js';
import { DiffView, DIFF_PREVIEW_LINES } from '../src/components/DiffView.js';
import { ThinkingArchive } from '../src/components/ThinkingArchive.js';

/**
 * Fast regression suite for the expandable transcript cards.
 *
 * The reported bug: expanding a card and clicking it closed left the transcript
 * reserving the expanded height. The card itself was never the source of the
 * stale rows — it is a pure function of `expanded` — so these tests pin that
 * contract: collapsed and expanded heights differ, and collapsing returns to
 * exactly the same shape as the first collapsed render.
 */

function frame(node: React.ReactElement): string {
  const view = render(React.createElement(ThemeProvider, { name: 'black' }, node));
  const text = stripAnsi(view.lastFrame() ?? '');
  view.unmount();
  return text;
}

const rows = (text: string): number => text.split('\n').filter((line) => line.trim().length > 0).length;

const shellOutput = (count: number): string =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');

test('shell card collapses back to its exact preview height', () => {
  const output = shellOutput(30);
  const collapsed = frame(<ShellView command="ls" output={output} isError={false} />);
  const expanded = frame(<ShellView command="ls" output={output} isError={false} expanded />);
  const collapsedAgain = frame(<ShellView command="ls" output={output} isError={false} />);

  assert.match(collapsed, /click to expand/);
  assert.match(expanded, /click to collapse/);
  assert.ok(rows(expanded) > rows(collapsed), 'expanding adds rows');
  assert.equal(
    collapsedAgain,
    collapsed,
    'collapsing renders the same card, so no expanded height can leak into the layout'
  );
  // header row + command row + 4 preview lines + trailer + 2 borders
  assert.ok(rows(collapsed) <= 10, 'collapsed shell card stays compact');
});

test('expanded cards are capped and say when output was truncated', () => {
  const output = shellOutput(SHELL_EXPANDED_MAX_LINES + 40);
  const expanded = frame(<ShellView command="big" output={output} isError={false} expanded />);
  assert.match(expanded, new RegExp(`${SHELL_EXPANDED_MAX_LINES + 40} lines`), 'header shows the real total');
  assert.match(expanded, /40 more lines/);
  assert.match(expanded, /preview truncated/);
});

test('read card advertises expansion only when content is clipped', () => {
  const lines = Array.from({ length: READ_PREVIEW_LINES + 12 }, (_, i) => `const v${i} = ${i};`);
  const read = {
    filePath: '/tmp/demo.ts',
    sections: [{ lines, startLine: 1, endLine: lines.length }],
  };
  const readCollapsed = frame(<ReadFileView {...read} />);
  const readExpanded = frame(<ReadFileView {...read} expanded />);
  assert.match(readCollapsed, /click to expand/);
  assert.match(readCollapsed, new RegExp(`lines 1–${READ_PREVIEW_LINES} · ${lines.length} total`));
  assert.doesNotMatch(readExpanded, /click to expand/);
  assert.ok(rows(readExpanded) > rows(readCollapsed));
});

test('diff card renders the full patch by default with a stable, aligned gutter', () => {
  const diff = [
    '@@ -1,3 +1,4 @@',
    ' context',
    '-old line',
    '+new line',
    ...Array.from({ length: 30 }, (_, i) => `+added ${i}`),
    'plain meta row',
  ].join('\n');
  const props = { header: 'Edited demo.ts', diff, filePath: 'demo.ts', operation: 'Edited' as const };
  const collapsed = frame(<DiffView {...props} />);
  const expanded = frame(<DiffView {...props} expanded />);

  // Full by default: no preview slice, no toggle for an ordinary patch.
  assert.match(collapsed, /added 29/);
  assert.doesNotMatch(collapsed, /more lines|diff truncated|click to/);
  assert.equal(collapsed, expanded, 'collapsed and expanded are identical for a normal diff');
  assert.equal(rows(collapsed), rows(expanded));

  const internalRule = (line: string): number => {
    const left = line.indexOf('│');
    return line.indexOf('│', left + 1);
  };
  // content rows have three rules: left border, side rule, right border.
  const contentLines = (text: string) => text.split('\n').filter((line) => {
    const first = line.indexOf('│');
    const second = line.indexOf('│', first + 1);
    return second !== -1 && line.indexOf('│', second + 1) !== -1;
  });
  const columns = new Set(contentLines(collapsed).map(internalRule));
  assert.equal(columns.size, 1, 'the side rule stays in one column on every row');

  const rule = [...columns][0]!;
  const removal = contentLines(collapsed).find((line) => line.includes('- old line')) ?? '';
  const addition = contentLines(collapsed).find((line) => line.includes('+ new line')) ?? '';
  const hunk = contentLines(collapsed).find((line) => line.includes('@@')) ?? '';
  const meta = contentLines(collapsed).find((line) => line.includes('plain meta row')) ?? '';
  for (const line of [removal, addition, hunk, meta]) {
    assert.ok(line, 'all row kinds present');
    assert.equal(internalRule(line), rule, 'side rule is continuous on hunk and meta rows');
  }
  // Two distinct number columns: old for a removal, new for an addition.
  const firstDigit = (line: string) => line.slice(0, rule).search(/\d/);
  assert.ok(firstDigit(removal) >= 0 && firstDigit(addition) >= 0, 'both gutters hold a number');
  assert.notEqual(firstDigit(removal), firstDigit(addition), 'the number sits in different columns');

  // A genuine ceiling clip still draws the rule and reports the truncation.
  const huge = Array.from({ length: DIFF_PREVIEW_LINES + 2 }, (_, i) => `+line ${i}`).join('\n');
  const clipped = frame(<DiffView {...props} diff={huge} />);
  assert.match(clipped, /diff truncated/);
  const footer = contentLines(clipped).find((line) => line.includes('diff truncated')) ?? '';
  assert.ok(footer, 'footer row rendered');
  const clippedColumns = new Set(contentLines(clipped).map(internalRule));
  assert.equal(clippedColumns.size, 1, 'gutter width is stable on the clipped card too');
  assert.equal(internalRule(footer), [...clippedColumns][0], 'side rule is continuous on the footer row');
});

test('archived thought collapses back to the same preview rows', () => {
  const text = Array.from({ length: 20 }, (_, i) => `weighing option ${i + 1}`).join('\n');
  const collapsed = frame(<ThinkingArchive text={text} elapsedMs={1200} columns={80} />);
  const expanded = frame(<ThinkingArchive text={text} elapsedMs={1200} columns={80} expanded />);
  const collapsedAgain = frame(<ThinkingArchive text={text} elapsedMs={1200} columns={80} />);

  assert.match(collapsed, /click to expand/);
  assert.doesNotMatch(expanded, /click to collapse/, 'the duplicate header hint is gone');
  assert.ok(rows(expanded) > rows(collapsed), 'expanded reasoning shows more lines');
  assert.equal(collapsedAgain, collapsed, 'collapse restores the exact preview shape');
});

test('row resolution prefers the node now on screen over a stale id height', () => {
  // Expanded card measured at 30 rows, then collapsed. The collapsed node has
  // its own height (5); the id-level 30 must not win, or the transcript keeps
  // the expanded block reserved after the click.
  assert.equal(resolveItemRows({ node: 5, measured: 30, fallback: 2 }), 5);
  // Live content wins while it is streaming.
  assert.equal(resolveItemRows({ live: 9, node: 5, measured: 30, fallback: 2 }), 9);
  // Nothing measured yet: structural fallback, never zero.
  assert.equal(resolveItemRows({ fallback: 0 }), 1);
  assert.equal(resolveItemRows({ node: Number.NaN, measured: 7, fallback: 1 }), 7);
});
