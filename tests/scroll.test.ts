import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampScroll,
  maxScrollOffset,
  scrollAfterGrowth,
  scrollMarginTop,
  sliceItemsToWindow,
  visibleRowWindow,
} from '../src/utils/scroll.js';

test('a short transcript cannot be scrolled', () => {
  assert.equal(maxScrollOffset(5, 24), 0);
  assert.equal(clampScroll(3, 0), 0);
  assert.equal(scrollMarginTop(3, 0), 0);
});

test('scroll offsets clamp to the transcript bounds', () => {
  const max = maxScrollOffset(100, 24);
  assert.equal(max, 76);
  assert.equal(clampScroll(-5, max), 0);
  assert.equal(clampScroll(10, max), 10);
  assert.equal(clampScroll(1000, max), 76);
  assert.equal(clampScroll(Number.NaN, max), 0);
});

test('margin shifts up by the rows hidden below', () => {
  // offset 0 = pinned to bottom = no shift.
  assert.equal(scrollMarginTop(0, 40), -40);
  // scrolled fully to the top = no shift at all.
  assert.equal(scrollMarginTop(40, 40), 0);
  // halfway.
  assert.equal(scrollMarginTop(20, 40), -20);
});

test('a user at the bottom stays pinned when new rows arrive', () => {
  assert.equal(scrollAfterGrowth(0, 12, 46), 0);
  assert.equal(scrollAfterGrowth(0, -12, 46), 0);
});

test('a scrolled-up user keeps their position plus the new rows', () => {
  // Same content stays on screen: offset grows with the document.
  assert.equal(scrollAfterGrowth(10, 5, 46), 15);
  assert.equal(scrollAfterGrowth(10, 50, 46), 46);
  assert.equal(scrollAfterGrowth(10, -20, 46), 0);
});

test('visible window shows the newest rows when pinned to the bottom', () => {
  const window = visibleRowWindow(100, 20, 0);
  assert.equal(window.last, 100);
  assert.equal(window.first, 80);
  assert.equal(window.hiddenBelow, 0);
});

test('visible window moves up by exactly the scroll offset', () => {
  const window = visibleRowWindow(100, 20, 30);
  assert.equal(window.last, 70);
  assert.equal(window.first, 50);
  assert.equal(window.hiddenAbove, 50);
  assert.equal(window.hiddenBelow, 30);
});

test('visible window clamps at the top of the transcript', () => {
  const window = visibleRowWindow(100, 20, 999);
  assert.equal(window.first, 0);
  assert.equal(window.last, 20);
  assert.equal(window.hiddenAbove, 0);
});

test('short transcripts are fully visible and never negative', () => {
  const window = visibleRowWindow(5, 20, 0);
  assert.equal(window.first, 0);
  assert.equal(window.last, 5);
  assert.equal(visibleRowWindow(0, 20, 0).last, 0);
});

test('item slicing keeps every item that intersects the window', () => {
  const items = [
    { id: 'a', rows: 3 },
    { id: 'b', rows: 5 },
    { id: 'c', rows: 2 },
    { id: 'd', rows: 4 },
  ];
  // rows: a=0-3, b=3-8, c=8-10, d=10-14
  const sliced = sliceItemsToWindow(items, 4, 9);
  assert.deepEqual(sliced.items.map((item) => item.id), ['b', 'c']);
  assert.equal(sliced.trimTop, 1);
});

test('item slicing trims inside a tall item that spans the viewport', () => {
  const items = [{ id: 'huge', rows: 100 }, { id: 'tail', rows: 2 }];
  const sliced = sliceItemsToWindow(items, 40, 60);
  assert.deepEqual(sliced.items.map((item) => item.id), ['huge']);
  assert.equal(sliced.trimTop, 40);
});

test('item slicing returns nothing for an empty window', () => {
  const items = [{ id: 'a', rows: 3 }];
  assert.deepEqual(sliceItemsToWindow(items, 5, 9), { items: [], trimTop: 0 });
});

// ---- Scroll arithmetic review: one diagnostic test per hypothesis ----------

test('H1: trimTop counts rows of the first item that must be clipped above the window', () => {
  // One 20-row item, content window [11,20): 11 rows sit above the window and
  // must be HIDDEN (the item pulled up), never replaced by blank padding.
  const sliced = sliceItemsToWindow([{ id: 'only', rows: 20 }], 11, 20);
  assert.deepEqual(sliced.items.map((item) => item.id), ['only']);
  assert.equal(sliced.trimTop, 11);
  // App renders a POSITIVE-height spacer of trimTop, so the item's first
  // visible row lands at viewport row 1 + 11 = 12 — past a 10-row viewport.
  // This is the UI break: the whole viewport goes blank. The fix belongs in
  // App.tsx (apply -trimTop as a negative margin), reported to the owner.
  assert.ok(1 + sliced.trimTop >= 10);
});

test('H2: maxUserScroll uses the full viewport but the window reserves a top pad', () => {
  const transcriptRows = 20;
  const viewportRows = 10;
  const TOP_PAD = 1;
  const maxUserScroll = maxScrollOffset(transcriptRows, viewportRows); // 10
  const window = visibleRowWindow(transcriptRows, viewportRows - TOP_PAD, maxUserScroll);
  // Off-by-one: scrolling to max leaves hiddenAbove=1, so transcript row 0 is
  // never reachable. App should pass the SAME reduced height to both calls.
  assert.equal(maxUserScroll, 10);
  assert.equal(window.first, 1);
  assert.equal(window.hiddenAbove, 1);
  const consistent = maxScrollOffset(transcriptRows, viewportRows - TOP_PAD);
  assert.equal(visibleRowWindow(transcriptRows, viewportRows - TOP_PAD, consistent).first, 0);
});

test('H3: scrollAfterGrowth keeps the rendered window anchored on growth and shrink', () => {
  const viewport = 20;
  const height = viewport - 1; // rows actually used by the content window
  const before = visibleRowWindow(100, height, 30);
  const grownOffset = scrollAfterGrowth(30, 25, maxScrollOffset(125, viewport));
  const grown = visibleRowWindow(125, height, grownOffset);
  assert.equal(grownOffset, 55);
  assert.deepEqual([grown.first, grown.last], [before.first, before.last]);

  const shrunkOffset = scrollAfterGrowth(30, -10, maxScrollOffset(90, viewport));
  const shrunk = visibleRowWindow(90, height, shrunkOffset);
  assert.deepEqual([shrunk.first, shrunk.last], [before.first, before.last]);
});

test('H4: clampScroll handles NaN, infinities, fractions and a negative max', () => {
  assert.equal(clampScroll(Number.NaN, 50), 0);
  assert.equal(clampScroll(Number.POSITIVE_INFINITY, 50), 50);
  assert.equal(clampScroll(Number.NEGATIVE_INFINITY, 50), 0);
  assert.equal(clampScroll(7.6, 50), 8);
  assert.equal(clampScroll(7.4, 50), 7);
  assert.equal(clampScroll(100, -5), 0);
});

test('H6: visibleRowWindow edge cases are stable and non-negative', () => {
  assert.deepEqual(visibleRowWindow(0, 20, 0), {
    first: 0,
    last: 0,
    hiddenAbove: 0,
    hiddenBelow: 0,
  });
  // Viewport taller than the transcript: everything visible, nothing hidden.
  assert.deepEqual(visibleRowWindow(5, 20, 99), {
    first: 0,
    last: 5,
    hiddenAbove: 0,
    hiddenBelow: 0,
  });
  // Fractional inputs floor consistently with integer inputs.
  assert.deepEqual(visibleRowWindow(100.9, 20.9, 10.6), visibleRowWindow(100, 20, 11));
  // Very large offsets clamp to the top.
  assert.equal(visibleRowWindow(100, 20, Number.MAX_SAFE_INTEGER).first, 0);
});
