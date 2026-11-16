import test from 'node:test';
import assert from 'node:assert/strict';
import { frameRows, resolveLayout, splitLiveArea } from '../src/utils/layout.js';

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
    assert.ok(layout.inputWidth >= 16, `min width at ${columns}x${rows}`);
    assert.ok(layout.inputWidth <= Math.max(columns, 16), `does not exceed screen at ${columns}x${rows}`);
  }
});

test('composer is capped so it does not stretch on ultrawide terminals', () => {
  const layout = resolveLayout(300, 60);
  assert.ok(layout.inputWidth <= 110);
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
  assert.equal(frameRows(4), 4);
  assert.equal(frameRows(0), 1);
  // Ink repaints the whole screen when the committed output height reaches the
  // terminal height (`lastOutputHeight >= stdout.rows`). Staying strictly
  // below keeps every update on the incremental diff path.
  const inkWouldClear = (outputHeight: number, rows: number) => outputHeight >= rows;
  for (const rows of [5, 10, 24, 60, 200]) {
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
  // Fixed chrome is composer + footer + gap (5 rows) now that the horizontal
  // rule between chat and composer has been removed.
  assert.equal(split.transcriptRows, 23 - 5 - 10);
});
