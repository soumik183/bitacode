import test from 'node:test';
import assert from 'node:assert/strict';
import { nextThinkingExpansion } from '../src/utils/thinking-expansion.js';
import { thinkingBlockHeight } from '../src/components/ThinkingBlock.js';

test('thinking expands automatically when reasoning starts', () => {
  const result = nextThinkingExpansion({ active: true, wasActive: false, pinned: false, expanded: false });
  assert.deepEqual(result, { expanded: true, pinned: false });
});

test('thinking collapses to the plain header when reasoning ends', () => {
  const result = nextThinkingExpansion({ active: false, wasActive: true, pinned: false, expanded: true });
  assert.deepEqual(result, { expanded: false, pinned: false });
});

test('a manual toggle wins when reasoning ends', () => {
  const result = nextThinkingExpansion({ active: false, wasActive: true, pinned: true, expanded: true });
  assert.deepEqual(result, { expanded: true, pinned: true });
});

test('a new reasoning phase clears a stale manual pin', () => {
  const result = nextThinkingExpansion({ active: true, wasActive: false, pinned: true, expanded: false });
  assert.deepEqual(result, { expanded: true, pinned: false });
});

test('nothing changes while the phase state is stable', () => {
  const expandedResult = nextThinkingExpansion({ active: true, wasActive: true, pinned: true, expanded: false });
  assert.deepEqual(expandedResult, { expanded: false, pinned: true });

  const idleResult = nextThinkingExpansion({ active: false, wasActive: false, pinned: false, expanded: true });
  assert.deepEqual(idleResult, { expanded: true, pinned: false });
});

test('expanded thinking height counts the clipped preview rows', () => {
  // 40 short lines clip to the 8-row budget. The component renders header +
  // marginTop + 8 content rows + overflow note + marginBottom = 12 rows. The
  // old estimate ignored the content rows and returned 4, so the live area
  // under-reserved and clicks missed the top of the expanded block.
  const text = Array.from({ length: 40 }, (_, i) => `line ${i} with some content here`).join('\n');
  assert.equal(thinkingBlockHeight(text, true, 80, 24), 12);
});

test('thinking height tracks collapsed, short and empty blocks', () => {
  assert.equal(thinkingBlockHeight('a short thought', false, 80, 24), 2);
  // One short line: header + marginTop + 1 content row + marginBottom.
  assert.equal(thinkingBlockHeight('a short thought', true, 80, 24), 4);
  // The component returns null for whitespace-only text, so it takes no rows.
  assert.equal(thinkingBlockHeight('   ', true, 80, 24), 0);
});
