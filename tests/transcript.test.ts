import test from 'node:test';
import assert from 'node:assert/strict';
import { itemAtViewportRow } from '../src/utils/transcript.js';

const items = [
  { id: 'a', rows: 2 },
  { id: 'b', rows: 3 },
  { id: 'c', rows: 1 },
];

test('transcript clicks map viewport rows back to their item', () => {
  assert.equal(itemAtViewportRow(items, 0, 1, 0), null); // top padding
  assert.equal(itemAtViewportRow(items, 1, 1, 0), 'a');
  assert.equal(itemAtViewportRow(items, 2, 1, 0), 'a');
  assert.equal(itemAtViewportRow(items, 3, 1, 0), 'b');
  assert.equal(itemAtViewportRow(items, 5, 1, 0), 'b');
  assert.equal(itemAtViewportRow(items, 6, 1, 0), 'c');
  assert.equal(itemAtViewportRow(items, 7, 1, 0), null);
});

test('transcript clicks ignore the row trimmed from the first item', () => {
  assert.equal(itemAtViewportRow(items, 2, 1, 2), null);
  assert.equal(itemAtViewportRow(items, 3, 1, 2), 'a');
});
