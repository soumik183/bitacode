import test from 'node:test';
import assert from 'node:assert/strict';
import { computeUnifiedDiff, MAX_TOOL_DIFF_LINES } from '../src/utils/unified-diff.js';

const lines = (count: number, prefix: string): string =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n');

test('a small edit shows far more than three lines of context', () => {
  const before = lines(30, 'line');
  const after = before.replace('line 15', 'LINE 15');
  const diff = computeUnifiedDiff(before, after, 'f.txt');

  assert.match(diff, / line 5/);
  assert.match(diff, / line 25/);
  assert.match(diff, /\+LINE 15/);
});

test('an 80+ line rewrite is preserved intact', () => {
  const before = lines(120, 'old');
  const after = lines(120, 'new');
  const diff = computeUnifiedDiff(before, after, 'f.txt');

  assert.doesNotMatch(diff, /diff truncated/);
  assert.match(diff, /-old 120/);
  assert.match(diff, /\+new 120/);
  assert.ok(diff.split('\n').length > 80);
});

test('only an extreme diff hits the safety ceiling, with an explicit marker', () => {
  assert.ok(MAX_TOOL_DIFF_LINES >= 2000);
  const before = lines(MAX_TOOL_DIFF_LINES + 20, 'old');
  const after = lines(MAX_TOOL_DIFF_LINES + 20, 'new');
  const diff = computeUnifiedDiff(before, after, 'f.txt');

  assert.match(diff, /\(diff truncated\)/);
});
