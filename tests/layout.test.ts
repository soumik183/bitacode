import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampIndex,
  composerBlockRows,
  composerTextWidth,
  finiteDim,
  fixedChromeRows,
  footerBlockRows,
  frameRows,
  resolveLayout,
  splitLiveArea,
} from '../src/utils/layout.js';

test('classifies compact, regular and wide terminals', () => {
  assert.equal(resolveLayout(40, 15).size, 'compact');
  assert.equal(resolveLayout(80, 24).size, 'regular');
  assert.equal(resolveLayout(160, 50).size, 'wide');
  // Short height also compacts, even on a wide terminal.
  assert.equal(resolveLayout(160, 18).size, 'compact');
});

test('composer never touches the screen edges', () => {
  for (const [columns, rows] of [[40, 15], [80, 24], [200, 60], [1, 1]] as const) {
    const layout = resolveLayout(columns, rows);
    assert.ok(layout.inputWidth >= 1, `min width at ${columns}x${rows}`);
    assert.ok(layout.inputWidth <= columns, `does not exceed screen at ${columns}x${rows}`);
  }
});

test('composer fits a tiny terminal instead of overflowing with a 16-column floor', () => {
  for (const columns of [1, 4, 8, 10, 12, 15]) {
    const layout = resolveLayout(columns, 10);
    assert.ok(layout.inputWidth <= Math.max(1, columns - 2 * layout.gutter), `fits at ${columns} columns`);
    assert.ok(layout.inputWidth >= 1, `still usable at ${columns} columns`);
  }
  assert.equal(resolveLayout(8, 10).showSubmitHint, false);
  assert.equal(composerTextWidth(resolveLayout(8, 10).inputWidth, false), 1);
});

test('composer is capped so it does not stretch on ultrawide terminals', () => {
  const layout = resolveLayout(300, 60);
  assert.ok(layout.inputWidth <= 110);
});

test('composer text width reserves padding, accent bar and submit hint', () => {
  // outer paddingLeft (1) + accent bar (2) + inner paddingRight (2) = 5.
  assert.equal(composerTextWidth(80, true), 73);
  assert.equal(composerTextWidth(80, false), 75);
  assert.equal(composerTextWidth(4, true), 1, 'never returns zero or a negative width');
});

test('todo rows always leave room for transcript and composer', () => {
  for (const rows of [12, 15, 20, 24, 40, 80]) {
    const layout = resolveLayout(80, rows);
    // header + tasks + composer + footer must fit.
    assert.ok(layout.visibleTodos + 14 <= rows || layout.visibleTodos === 1, `rows=${rows}`);
    assert.ok(layout.visibleTodos >= 1);
  }
});

test('palette window shrinks on short terminals', () => {
  assert.ok(resolveLayout(80, 15).paletteWindow <= resolveLayout(80, 40).paletteWindow);
  assert.ok(resolveLayout(80, 15).paletteWindow >= 3);
});

test('footer and hint drop on narrow terminals', () => {
  assert.equal(resolveLayout(40, 15).showFullFooter, false);
  assert.equal(resolveLayout(80, 24).showFullFooter, true);
  assert.equal(resolveLayout(30, 15).showSubmitHint, false);
  assert.equal(resolveLayout(80, 24).showSubmitHint, true);
});

test('narrow screens use a tighter gutter', () => {
  assert.equal(resolveLayout(40, 15).gutter, 1);
  assert.equal(resolveLayout(80, 24).gutter, 2);
});

test('frame stays one row below the terminal to avoid full repaints', () => {
  assert.equal(frameRows(24), 23);
  assert.equal(frameRows(1), 1);
  assert.equal(frameRows(2), 1);
  assert.equal(frameRows(3), 2);
  assert.equal(frameRows(4), 3);
  assert.equal(frameRows(0), 1);
  // Ink repaints the whole screen when the committed output height reaches the
  // terminal height (`lastOutputHeight >= stdout.rows`). Staying strictly
  // below keeps every update on the incremental diff path, even on 4-row terms.
  const inkWouldClear = (outputHeight: number, rows: number) => outputHeight >= rows;
  for (const rows of [2, 3, 4, 5, 10, 24, 60, 200]) {
    assert.ok(frameRows(rows) < rows, `frameRows(${rows}) must stay below the terminal height`);
    assert.equal(inkWouldClear(frameRows(rows), rows), false, `frame at ${rows} must not clear`);
  }
});

test('transcript shrinks when panels appear and grows when they go away', () => {
  const base = { todos: 0, thinking: 0, help: 0, streaming: 0 };
  const withTodos = splitLiveArea(23, { ...base, todos: 7 });
  const noTodos = splitLiveArea(23, base);

  assert.ok(withTodos.transcriptRows < noTodos.transcriptRows);
  // Removing the panel gives the space straight back to the transcript.
  assert.equal(noTodos.transcriptRows - withTodos.transcriptRows, 7);
});

test('transcript never collapses to zero on a tiny frame', () => {
  const squeezed = splitLiveArea(5, { todos: 30, thinking: 20, help: 10, streaming: 5 });
  assert.equal(squeezed.transcriptRows, 1);
});

test('live rows sum every panel that is present', () => {
  const split = splitLiveArea(23, { todos: 3, thinking: 5, help: 0, streaming: 2 });
  assert.equal(split.liveRows, 10);
  // Fixed chrome is the padded composer card (3), the footer (2) and the gap
  // above the composer (1). Budgeting only 5 was the row the live area used to
  // steal from the input.
  assert.equal(fixedChromeRows(), 6);
  assert.equal(split.transcriptRows, 23 - 6 - 10);
});

test('the activity strip gets its own row so it cannot overlay the composer', () => {
  const idle = splitLiveArea(23, { todos: 0, thinking: 0, help: 0, streaming: 0 });
  const busy = splitLiveArea(23, { todos: 0, thinking: 0, help: 0, streaming: 0, status: 1 });
  assert.equal(busy.liveRows, idle.liveRows + 1);
  assert.equal(busy.transcriptRows, idle.transcriptRows - 1);
});

test('a dense terminal spends no rows on composer padding or footer margin', () => {
  assert.equal(composerBlockRows(1, true), 1);
  assert.equal(composerBlockRows(1, false), 3);
  assert.equal(footerBlockRows(true), 1);
  assert.equal(footerBlockRows(false), 2);
  const denseSplit = splitLiveArea(12, { todos: 0, thinking: 0, help: 0, streaming: 0, dense: true });
  const roomySplit = splitLiveArea(12, { todos: 0, thinking: 0, help: 0, streaming: 0 });
  assert.equal(denseSplit.transcriptRows, roomySplit.transcriptRows + 3);
});

test('clampIndex keeps a picker selection inside a list that just shrank', () => {
  assert.equal(clampIndex(5, 3), 2, 'selection past the end clamps to the last row');
  assert.equal(clampIndex(2, 3), 2, 'a valid selection is unchanged');
  assert.equal(clampIndex(-1, 3), 0);
  assert.equal(clampIndex(5, 0), 0, 'an empty list has no selection');
  assert.equal(clampIndex(Number.NaN, 3), 0);
});

// ─── Resize/zoom safety: no dimension may ever become 0/undefined/NaN ───
test('finiteDim turns transient resize values into a positive integer', () => {
  assert.equal(finiteDim(40, 80), 40);
  assert.equal(finiteDim(40.9, 80), 40, 'floors fractional columns');
  assert.equal(finiteDim(0, 80), 80, '0 falls back to the previous size');
  assert.equal(finiteDim(-5, 80), 80);
  assert.equal(finiteDim(Number.NaN, 80), 80);
  assert.equal(finiteDim(undefined, 80), 80);
  assert.equal(finiteDim(1, 80), 1, 'never returns zero');
});

test('layout helpers never emit NaN/0 dimensions during a resize burst', () => {
  const bad = [0, -1, Number.NaN, undefined] as const;
  for (const value of bad) {
    const layout = resolveLayout(value as number, 24);
    assert.ok(Number.isFinite(layout.inputWidth) && layout.inputWidth >= 1, `inputWidth at ${value}`);
    assert.ok(Number.isFinite(layout.paletteWindow) && layout.paletteWindow >= 1);
    assert.ok(Number.isFinite(layout.visibleTodos) && layout.visibleTodos >= 1);
    assert.ok(Number.isFinite(layout.gutter) && layout.gutter >= 1);

    const frame = frameRows(value as number);
    assert.ok(Number.isFinite(frame) && frame >= 1, `frameRows at ${value}`);

    const text = composerTextWidth(value as number, true);
    assert.ok(Number.isFinite(text) && text >= 1, `composerTextWidth at ${value}`);

    const split = splitLiveArea(value as number, {
      todos: value as number,
      thinking: 0,
      help: 0,
      streaming: 0,
    });
    assert.ok(Number.isFinite(split.transcriptRows) && split.transcriptRows >= 1);
    assert.ok(Number.isFinite(split.liveRows) && split.liveRows >= 0);
  }
});

test('dense chrome only kicks in on very short terminals', () => {
  assert.equal(resolveLayout(80, 8).dense, true);
  assert.equal(resolveLayout(80, 9).dense, true);
  assert.equal(resolveLayout(80, 10).dense, false);
  assert.equal(resolveLayout(80, 24).dense, false);
});

test('every layout field stays finite across a grid of zoom sizes', () => {
  for (const columns of [1, 4, 8, 20, 30, 40, 80, 200, 400]) {
    for (const rows of [1, 4, 6, 8, 10, 24, 60, 200]) {
      const layout = resolveLayout(columns, rows);
      for (const [key, value] of Object.entries(layout)) {
        if (typeof value === 'number') {
          assert.ok(Number.isFinite(value) && value >= 1, `${key} at ${columns}x${rows}: ${value}`);
        }
      }
      assert.ok(layout.inputWidth <= columns, `composer fits ${columns}x${rows}`);
      assert.ok(frameRows(rows) <= Math.max(1, rows - 1));
    }
  }
});
