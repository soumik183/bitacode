import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearToolFilter,
  getAllTools,
  handleToolCall,
  isToolAllowed,
  setToolFilter,
} from '../src/tools/index.js';

test('an allowlist hides every other tool from the model', () => {
  setToolFilter({ allow: ['read_file'] });
  try {
    const names = getAllTools().map((tool) => tool.function.name);
    assert.deepEqual(names, ['read_file']);
    assert.equal(isToolAllowed('bash'), false);
    assert.equal(isToolAllowed('read_file'), true);
  } finally {
    clearToolFilter();
  }
});

test('a denylist hides a tool and the dispatcher refuses it', async () => {
  setToolFilter({ deny: ['bash'] });
  try {
    assert.equal(isToolAllowed('bash'), false);
    const result = await handleToolCall('bash', { command: 'echo hi' });
    assert.match(result, /disabled for this run/);
  } finally {
    clearToolFilter();
  }
  assert.equal(isToolAllowed('bash'), true);
});
