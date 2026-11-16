import test from 'node:test';
import assert from 'node:assert/strict';
import { getLeftMousePress, getWheelDelta, hasLeftMousePress, isClickOnThinkingBlock, isMouseReport, stripMouseReports } from '../src/utils/mouse.js';

test('mouse reports are recognized with or without the leading escape', () => {
  assert.equal(isMouseReport('\x1b[<0;86;28M'), true);
  assert.equal(isMouseReport('[<0;86;28M'), true);
  assert.equal(isMouseReport('[<0;86;28m'), true);
  assert.equal(isMouseReport('[<0;1;1M[<64;2;2M'), true);
  assert.equal(isMouseReport('hello'), false);
});

test('stripMouseReports removes clicks, wheel and releases from text', () => {
  assert.equal(stripMouseReports('hello[<0;5;5M'), 'hello');
  assert.equal(stripMouseReports('\x1b[<64;5;5M'), '');
  assert.equal(stripMouseReports('[<0;5;5m'), '');
});

test('only a left button press counts as a click', () => {
  assert.equal(hasLeftMousePress('[<0;10;4M'), true);
  assert.equal(hasLeftMousePress('[<0;10;4m'), false);
  assert.equal(hasLeftMousePress('[<64;10;4M'), false);
  assert.equal(hasLeftMousePress('[<32;10;4M'), false);
});

test('left mouse presses expose terminal coordinates', () => {
  assert.deepEqual(getLeftMousePress('\x1b[<0;86;28M'), { x: 86, y: 28 });
  assert.deepEqual(getLeftMousePress('[<0;5;7M[<0;6;8M'), { x: 5, y: 7 });
  assert.equal(getLeftMousePress('[<64;5;7M'), null);
  assert.equal(getLeftMousePress('[<0;5;7m'), null);
});

test('mouse wheel reports return a net direction', () => {
  assert.equal(getWheelDelta('[<64;10;4M'), -1);
  assert.equal(getWheelDelta('[<65;10;4M'), 1);
  assert.equal(getWheelDelta('[<64;10;4M[<65;10;4M'), 0);
  assert.equal(getWheelDelta('[<0;10;4M'), 0);
});

test('thinking clicks only hit the block above the input and footer', () => {
  // rows=30: input rows 27-29, footer 29-30 -> thinking bottom is 25.
  assert.equal(isClickOnThinkingBlock(24, 30, 2), true);   // collapsed: header + margin
  assert.equal(isClickOnThinkingBlock(25, 30, 2), true);
  assert.equal(isClickOnThinkingBlock(23, 30, 2), false);  // outside above
  assert.equal(isClickOnThinkingBlock(26, 30, 2), false);  // inside input area
  assert.equal(isClickOnThinkingBlock(30, 30, 2), false);
});
