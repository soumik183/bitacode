import test from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_BUDGET, isOverBudget } from '../src/headless.js';

test('budget cap only triggers for a positive exceeded cap', () => {
  assert.equal(EXIT_BUDGET, 5);
  assert.equal(isOverBudget(0.5, 1), false);
  assert.equal(isOverBudget(1, 1), false);
  assert.equal(isOverBudget(1.0001, 1), true);
  assert.equal(isOverBudget(9, undefined), false);
  assert.equal(isOverBudget(9, 0), false);
  assert.equal(isOverBudget(9, Number.NaN), false);
});
