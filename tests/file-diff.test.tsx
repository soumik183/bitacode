import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { DiffView } from '../src/components/DiffView.js';
import { ReadFileView } from '../src/components/ReadFileView.js';
import {
  annotateDiff,
  displayFilePath,
  parseFileMutationDiff,
  parseFileReadResult,
} from '../src/utils/file-diff.js';

const editResult = [
  'Successfully edited src/app.ts: 1 replacement(s) made.',
  'Index: src/app.ts',
  '===================================================================',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' context',
  '-old line',
  '+new line',
  ' tail',
].join('\n');

test('edit results expose a header and a unified diff', () => {
  const parsed = parseFileMutationDiff('edit_file', '{}', editResult);
  assert.ok(parsed);
  assert.match(parsed.header, /Successfully edited/);
  assert.match(parsed.diff, /@@/);
  assert.match(parsed.diff, /\+new line/);
  assert.match(parsed.diff, /-old line/);
});

test('failed file mutations never become diffs', () => {
  assert.equal(parseFileMutationDiff('edit_file', '{}', 'Error: old_string not found'), null);
  assert.equal(parseFileMutationDiff('write_file', '{}', 'Operation cancelled: rejected'), null);
  assert.equal(parseFileMutationDiff('read_file', '{}', editResult), null);
});

test('write results without diff metadata fall back to added content', () => {
  const parsed = parseFileMutationDiff(
    'write_file',
    JSON.stringify({ content: 'one\ntwo\n' }),
    'Successfully wrote 2 lines to new.txt'
  );
  assert.ok(parsed);
  assert.equal(parsed.diff, '+one\n+two');
});

test('diff view renders green additions, red removals and a summary', () => {
  const parsed = parseFileMutationDiff('edit_file', '{}', editResult)!;
  const { lastFrame } = render(<DiffView header={parsed.header} diff={parsed.diff} />);
  const frame = lastFrame() ?? '';
  assert.match(frame, /Edited src\/app\.ts/);
  assert.match(frame, /\+1/);
  assert.match(frame, /-1/);
  assert.match(frame, /\+ new line/);
  assert.match(frame, /- old line/);
  assert.doesNotMatch(frame, /Index:/);
});

test('diff lines carry old/new line numbers and the relative file path', () => {
  const parsed = parseFileMutationDiff('edit_file', JSON.stringify({ file_path: 'src/app.ts' }), editResult)!;
  assert.equal(parsed.filePath, 'src/app.ts');
  assert.equal(parsed.operation, 'Edited');
  assert.equal(displayFilePath('src/app.ts'), 'src/app.ts');

  const lines = annotateDiff(parsed.diff);
  assert.deepEqual(
    lines.map((line) => [line.kind, line.number]),
    [
      ['hunk', undefined],
      ['context', 1],
      ['remove', 2],
      ['add', 2],
      ['context', 3],
    ]
  );
});

test('read results become a compact preview with a starting line number', () => {
  const parsed = parseFileReadResult(
    'read_file',
    JSON.stringify({ file_path: 'src/app.ts', offset: 9 }),
    'one\ntwo\n... (5 more line(s); use offset=11 to continue)'
  );
  assert.ok(parsed);
  assert.equal(parsed.filePath, 'src/app.ts');
  assert.deepEqual(parsed.sections, [
    { startLine: 10, endLine: 11, lines: ['one', 'two'], note: '… 5 more lines' },
  ]);
  assert.equal(parseFileReadResult('read_file', '{}', 'File not found: nope.ts'), null);
});

test('read results parse multiple requested ranges', () => {
  const parsed = parseFileReadResult(
    'read_file',
    JSON.stringify({ file_path: 'src/app.ts', ranges: '2-3, 90-91' }),
    '[lines 2-3]\nalpha\nbeta\n[lines 90-91]\ngamma\n... (file ends at line 90)'
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.sections, [
    { startLine: 2, endLine: 3, lines: ['alpha', 'beta'] },
    { startLine: 90, endLine: 91, lines: ['gamma'], note: '... (file ends at line 90)' },
  ]);
});

test('read view renders the file path, line numbers and a border', () => {
  const parsed = parseFileReadResult('read_file', JSON.stringify({ file_path: 'src/app.ts' }), 'alpha\nbeta')!;
  const { lastFrame } = render(<ReadFileView {...parsed} />);
  const frame = lastFrame() ?? '';
  assert.match(frame, /Read/);
  assert.match(frame, /src\/app\.ts/);
  assert.match(frame, /1\s+│ alpha/);
  assert.match(frame, /2\s+│ beta/);
  assert.match(frame, /╭/);
});
