import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, fuzzyMatch, fuzzyFilter, highlightMatches } from '../src/utils/fuzzy.js';

test('subsequence matching with indices', () => {
  const result = fuzzyScore('gf', 'get_file');
  assert.ok(result);
  assert.deepEqual(result.indices, [0, 4]);
});

test('exact substring scores higher than loose subsequence', () => {
  const direct = fuzzyScore('get', 'get_file');
  const loose = fuzzyScore('gtf', 'get_file');
  assert.ok(direct && loose);
  assert.ok(direct.score > loose.score);
});

test('prefix and word boundary bonuses', () => {
  const atStart = fuzzyScore('read', 'read_file')!;
  const inMiddle = fuzzyScore('read', 'xread_file')!;
  assert.ok(atStart.score > inMiddle.score);
});

test('query longer than text fails', () => {
  assert.equal(fuzzyScore('abcdef', 'abc'), null);
});

test('empty query matches everything with zero score', () => {
  const result = fuzzyMatch('', 'anything');
  assert.equal(result?.score, 0);
});

test('extended operators: prefix, suffix, exact, negate', () => {
  assert.ok(fuzzyMatch('^get', 'get_file'));
  assert.equal(fuzzyMatch('^file', 'get_file'), null);
  assert.ok(fuzzyMatch('file$', 'get_file'));
  assert.equal(fuzzyMatch('file$', 'file_name'), null);
  assert.ok(fuzzyMatch("'et_fi", 'get_file'));
  assert.equal(fuzzyMatch("'xyz", 'get_file'), null);
  assert.equal(fuzzyMatch('!test', 'get_file_test'), null);
  assert.ok(fuzzyMatch('!test', 'get_file'));
});

test('multiple terms are ANDed', () => {
  assert.ok(fuzzyMatch('get file', 'get_file'));
  assert.equal(fuzzyMatch('get missing', 'get_file'), null);
});

test('fuzzyFilter ranks and preserves original order on ties', () => {
  const items = ['git_status', 'get_file', 'get_status'];
  const ranked = fuzzyFilter(items, 'get', { getText: (item) => item });
  assert.equal(ranked[0].item, 'get_file');
  const tied = fuzzyFilter(['b', 'a'], '', { getText: (item) => item });
  assert.deepEqual(tied.map((entry) => entry.item), ['b', 'a']);
});

test('alias fallback scores lower than label match', () => {
  const items = [{ label: 'alpha', keywords: 'zeta' }, { label: 'zeta', keywords: 'alpha' }];
  const ranked = fuzzyFilter(items, 'zeta', {
    getText: (item) => item.label,
    getAlias: (item) => item.keywords,
  });
  assert.equal(ranked[0].item.label, 'zeta');
});

test('limit and malformed getters are handled', () => {
  const ranked = fuzzyFilter(['a', 'ab', 'abc'], 'a', { getText: (item) => item, limit: 1 });
  assert.equal(ranked.length, 1);
  const broken = fuzzyFilter([1, 2], 'a', { getText: () => { throw new Error('bad'); } });
  assert.equal(broken.length, 0);
});

test('highlightMatches marks matched characters', () => {
  assert.equal(highlightMatches('get_file', [0, 4]), '[g]et_[f]ile');
});
