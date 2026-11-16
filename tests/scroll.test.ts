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
