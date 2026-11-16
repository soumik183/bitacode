import test from 'node:test';
import assert from 'node:assert/strict';
import { nextThinkingExpansion } from '../src/utils/thinking-expansion.js';

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
