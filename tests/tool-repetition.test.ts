import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_IDENTICAL_CALLS,
  repetitionKey,
  shouldBlockRepetition,
} from '../src/utils/tool-repetition.js';

test('identical calls are allowed up to the threshold, then blocked', () => {
  const counts = new Map<string, number>();
  const args = { file_path: 'src/a.ts' };
  for (let i = 0; i < DEFAULT_MAX_IDENTICAL_CALLS; i++) {
    assert.equal(shouldBlockRepetition('read_file', args, counts), false, `call ${i + 1}`);
  }
  assert.equal(shouldBlockRepetition('read_file', args, counts), true, 'one past the limit is blocked');
});

test('argument order does not create a new repetition key', () => {
  assert.equal(
    repetitionKey('write_file', { content: 'x', file_path: 'a' }),
    repetitionKey('write_file', { file_path: 'a', content: 'x' }),
  );
});

test('different arguments are not treated as repeats', () => {
  const counts = new Map<string, number>();
  for (let i = 0; i < 5; i++) {
    assert.equal(shouldBlockRepetition('read_file', { file_path: `a${i}.ts` }, counts), false);
  }
});

test('polling and meta tools are exempt from the guard', () => {
  const counts = new Map<string, number>();
  for (let i = 0; i < 10; i++) {
    assert.equal(shouldBlockRepetition('poll_process', { id: 'proc-1' }, counts), false);
  }
});
