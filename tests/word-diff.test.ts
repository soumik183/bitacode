import test from 'node:test';
import assert from 'node:assert/strict';
import { changedSegments, diffWords, type WordSegment } from '../src/utils/word-diff.js';

const join = (segments: WordSegment[]): string => segments.map((segment) => segment.text).join('');
const changedText = (segments: WordSegment[]): string =>
  segments.filter((segment) => segment.changed).map((segment) => segment.text).join('');

test('identical lines stay wholly unchanged and reconstruct exactly', () => {
  const text = 'const x = 1;';
  const { old, new: next } = diffWords(text, text);

  assert.deepEqual(old, [{ text, changed: false }]);
  assert.deepEqual(next, [{ text, changed: false }]);
  assert.equal(join(old), text);
  assert.equal(join(next), text);
  assert.equal(changedText(old), '');
});

test('a single changed word is highlighted on both sides only', () => {
  const { old, new: next } = diffWords('const x = 1;', 'const y = 1;');

  assert.equal(changedText(old), 'x');
  assert.equal(changedText(next), 'y');
  assert.deepEqual(old, [
    { text: 'const ', changed: false },
    { text: 'x', changed: true },
    { text: ' = 1;', changed: false },
  ]);
  assert.equal(join(old), 'const x = 1;');
  assert.equal(join(next), 'const y = 1;');
});

test('multiple independent changes are each isolated', () => {
  const { old, new: next } = diffWords('alpha beta gamma', 'alpha BETA delta');

  assert.equal(changedText(old), 'betagamma');
  assert.equal(changedText(next), 'BETAdelta');
  assert.equal(join(old), 'alpha beta gamma');
  assert.equal(join(next), 'alpha BETA delta');
});

test('punctuation and whitespace are tokens and survive exactly', () => {
  const punctuation = diffWords('a.b', 'a,b');
  assert.equal(changedText(punctuation.old), '.');
  assert.equal(changedText(punctuation.new), ',');

  const spacing = diffWords('a b', 'a  b');
  assert.equal(changedText(spacing.old), ' ');
  assert.equal(changedText(spacing.new), '  ');
  assert.equal(join(spacing.old), 'a b');
  assert.equal(join(spacing.new), 'a  b');
});

test('a long line by token count falls back to whole-line changed segments', () => {
  const old = Array.from({ length: 401 }, (_, i) => `w${i}`).join(' ');
  const next = old.replace('w0', 'X');
  const result = diffWords(old, next);

  assert.deepEqual(result.old, [{ text: old, changed: true }]);
  assert.deepEqual(result.new, [{ text: next, changed: true }]);
  assert.equal(join(result.old), old);
  assert.equal(join(result.new), next);
});

test('a long line by character count falls back to whole-line changed segments', () => {
  const old = 'x'.repeat(4001);
  const next = `${'x'.repeat(4000)}y`;
  const result = diffWords(old, next);

  assert.equal(result.old.length, 1);
  assert.equal(result.new.length, 1);
  assert.ok(result.old[0]!.changed && result.new[0]!.changed);
  assert.equal(join(result.old), old);
  assert.equal(join(result.new), next);
});

test('output is capped at 200 segments per side without losing text', () => {
  const old = Array.from({ length: 300 }, (_, i) => `a${i}`).join(' ');
  const next = Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? `a${i}` : `b${i}`)).join(' ');
  const result = diffWords(old, next);

  assert.ok(result.old.length <= 200, `old had ${result.old.length} segments`);
  assert.ok(result.new.length <= 200, `new had ${result.new.length} segments`);
  assert.equal(join(result.old), old);
  assert.equal(join(result.new), next);
  assert.ok(changedText(result.new).length > 0, 'real changes stay highlighted after the cap');
});

test('adjacent tokens with the same flag are merged', () => {
  const { old } = diffWords('one two three four', 'ONE two THREE four');
  for (let i = 1; i < old.length; i++) {
    assert.notEqual(old[i]!.changed, old[i - 1]!.changed, `neighbours at ${i} should be merged`);
  }
  assert.equal(changedText(old), 'onethree');
});

test('pure insertion and deletion highlight only the surviving side', () => {
  const inserted = diffWords('', 'new');
  assert.deepEqual(inserted.old, []);
  assert.deepEqual(inserted.new, [{ text: 'new', changed: true }]);

  const deleted = diffWords('gone', '');
  assert.deepEqual(deleted.old, [{ text: 'gone', changed: true }]);
  assert.deepEqual(deleted.new, []);

  const appended = diffWords('one two three four', 'one two three four five');
  assert.equal(changedText(appended.new), ' five');
  assert.equal(changedText(appended.old), '');
  assert.equal(join(appended.new), 'one two three four five');
});

test('changedSegments returns only highlighted parts, or the whole text as fallback', () => {
  const { new: next } = diffWords('let a = 1;', 'let b = 2;');
  const changed = changedSegments('let b = 2;', next);

  assert.deepEqual(changed.map((segment) => segment.text), ['b', '2']);
  assert.ok(changed.every((segment) => segment.changed));
  assert.deepEqual(changedSegments('whole line', []), [{ text: 'whole line', changed: true }]);
  assert.deepEqual(changedSegments('', []), []);
});

test('malformed input never throws and still reconstructs', () => {
  assert.doesNotThrow(() => {
    const numeric = diffWords(42 as unknown as string, null as unknown as string);
    assert.equal(join(numeric.old), '42');
    assert.equal(join(numeric.new), '');
    assert.equal(changedText(numeric.old), '42');

    const odd = diffWords(Object.create(null) as unknown as string, Symbol('x') as unknown as string);
    assert.equal(join(odd.old), '');
    assert.equal(join(odd.new), 'Symbol(x)');

    assert.deepEqual(changedSegments('abc', null as unknown as WordSegment[]), [{ text: 'abc', changed: true }]);
    assert.deepEqual(changedSegments(null as unknown as string, [{ text: 'a', changed: true }]), [{ text: 'a', changed: true }]);
  });
});

test('unicode, tabs, newlines and emoji reconstruct byte for byte', () => {
  const pairs: Array<[string, string]> = [
    ['', ''],
    ['héllo wörld', 'héllo Wörld'],
    ['a\tb\nc', 'a\tb\r\nc'],
    ['👋 hello', '👋 goodbye'],
    ['x', 'x'],
  ];
  for (const [old, next] of pairs) {
    const result = diffWords(old, next);
    assert.equal(join(result.old), old, 'old text must be reproduced exactly');
    assert.equal(join(result.new), next, 'new text must be reproduced exactly');
    assert.ok(result.old.every((segment) => segment.text.length > 0));
    assert.ok(result.new.every((segment) => segment.text.length > 0));
  }
});
