import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scrollbarGeometry,
  scrollbarLines,
  SCROLLBAR_THUMB,
  SCROLLBAR_TRACK,
} from '../src/utils/scrollbar.js';

test('no scrollbar when everything fits', () => {
  assert.equal(scrollbarGeometry(10, 20, 0), null);
  assert.equal(scrollbarGeometry(20, 20, 0), null);
  assert.deepEqual(scrollbarLines(null), []);
});

test('thumb sits at the bottom when pinned to the newest row', () => {
  const geometry = scrollbarGeometry(100, 20, 0);
  assert.ok(geometry);
  assert.equal(geometry.height, 20);
  assert.equal(geometry.start + geometry.thumb, 20);
});

test('thumb sits at the top when scrolled fully up', () => {
  const geometry = scrollbarGeometry(100, 20, 80);
  assert.ok(geometry);
  assert.equal(geometry.start, 0);
});

test('thumb position moves monotonically with offset', () => {
  const starts = [0, 20, 40, 60, 80].map((offset) => scrollbarGeometry(100, 20, offset)!.start);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] <= starts[i - 1], `start should not decrease: ${starts.join(',')}`);
  }
});

test('thumb stays visible and inside the rail', () => {
  // Very long transcript: proportional thumb would round to 0.
  const geometry = scrollbarGeometry(10_000, 20, 0)!;
  assert.ok(geometry.thumb >= 1);
  assert.ok(geometry.start >= 0);
  assert.ok(geometry.start + geometry.thumb <= geometry.height);
});

test('rendered rail has one line per viewport row and exactly one thumb block', () => {
  const lines = scrollbarLines(scrollbarGeometry(100, 20, 0));
  assert.equal(lines.length, 20);
  const thumbs = lines.filter((line) => line === SCROLLBAR_THUMB).length;
  assert.ok(thumbs >= 1);
  assert.equal(lines.filter((line) => line === SCROLLBAR_TRACK).length, 20 - thumbs);
});

test('offset is clamped to the scrollable range', () => {
  const beyond = scrollbarGeometry(100, 20, 999);
  const exact = scrollbarGeometry(100, 20, 80);
  assert.deepEqual(beyond, exact);

  const negative = scrollbarGeometry(100, 20, -50);
  const zero = scrollbarGeometry(100, 20, 0);
  assert.deepEqual(negative, zero);
});

test('H5: the thumb never overflows the rail across the whole range', () => {
  for (const offset of [0, 1, 20, 40, 60, 79, 80]) {
    const geometry = scrollbarGeometry(100, 20, offset)!;
    assert.ok(geometry.start >= 0, `negative start at ${offset}`);
    assert.ok(geometry.start + geometry.thumb <= geometry.height, `overflow at ${offset}`);
    assert.equal(scrollbarLines(geometry).length, geometry.height);
  }
});

test('H5: non-finite offsets are clamped like the scroller', () => {
  const bottom = scrollbarGeometry(100, 20, 0)!;
  const top = scrollbarGeometry(100, 20, 80)!;
  assert.deepEqual(scrollbarGeometry(100, 20, Number.NaN), bottom);
  assert.deepEqual(scrollbarGeometry(100, 20, Number.NEGATIVE_INFINITY), bottom);
  assert.deepEqual(scrollbarGeometry(100, 20, Number.POSITIVE_INFINITY), top);
});
