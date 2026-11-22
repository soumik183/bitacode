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
import { computeUnifiedDiff, MAX_TOOL_DIFF_LINES } from '../src/utils/unified-diff.js';

// Matches createTwoFilesPatch output as normalised by computeUnifiedDiff.
const editResult = [
  'Successfully edited src/app.ts: 1 replacement(s) made.',
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

  const lines = annotateDiff(parsed.diff).filter((line) => line.kind !== 'meta');
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

test('single-file diffs keep a full >80-line rewrite intact in one entry', () => {
  const before = Array.from({ length: 120 }, (_, i) => `old ${i}`).join('\n');
  const after = Array.from({ length: 120 }, (_, i) => `new ${i}`).join('\n');
  const result = `Successfully edited big.txt: 120 replacement(s) made.\n${computeUnifiedDiff(before, after, 'big.txt')}`;

  const parsed = parseFileMutationDiff('edit_file', JSON.stringify({ file_path: 'big.txt' }), result)!;
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.filePath, 'big.txt');
  assert.equal(parsed.diff, parsed.entries[0]!.diff);
  assert.doesNotMatch(parsed.diff, /diff truncated/);
  assert.match(parsed.diff, /-old 119/);
  assert.match(parsed.diff, /\+new 119/);
  assert.ok(annotateDiff(parsed.diff).filter((line) => line.kind === 'add').length > 80);
});

test('multiedit results become one entry per file with their own header', () => {
  const result = [
    'Successfully edited 2 file(s):',
    '--- a.ts (1 replacement(s))',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1 +1 @@',
    '-one',
    '+ONE',
    '',
    '--- b.ts (2 replacement(s))',
    '--- a/b.ts',
    '+++ b/b.ts',
    '@@ -1,2 +1,2 @@',
    '-two',
    '-three',
    '+TWO',
    '+THREE',
  ].join('\n');

  const parsed = parseFileMutationDiff('multiedit', '{}', result)!;
  assert.equal(parsed.header, 'Successfully edited 2 file(s):');
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0]!.filePath, 'a.ts');
  assert.equal(parsed.entries[0]!.header, '--- a.ts (1 replacement(s))');
  assert.match(parsed.entries[0]!.diff, /\+ONE/);
  assert.equal(parsed.entries[1]!.filePath, 'b.ts');
  assert.match(parsed.entries[1]!.diff, /\+THREE/);
  assert.doesNotMatch(parsed.entries[0]!.diff, /\+TWO/);
  assert.match(parsed.diff, /\+ONE/);
  assert.match(parsed.diff, /\+TWO/);

  const alias = parseFileMutationDiff('multi_edit', '{}', result)!;
  assert.equal(alias.entries.length, 2);
});

test('apply_patch results with real diffs become one entry per file', () => {
  const result = [
    'Applied patch to 2 file(s):',
    '--- a.txt (+1/-1)',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-one',
    '+ONE',
    '',
    '--- b.txt (+1/-1) (deleted)',
    '--- a/b.txt',
    '+++ /dev/null',
    '@@ -1 +1,0 @@',
    '-two',
  ].join('\n');

  const parsed = parseFileMutationDiff('apply_patch', '{}', result)!;
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0]!.filePath, 'a.txt');
  assert.equal(parsed.entries[0]!.header, '--- a.txt (+1/-1)');
  assert.match(parsed.entries[0]!.diff, /\+ONE/);
  assert.equal(parsed.entries[1]!.filePath, 'b.txt');
  assert.match(parsed.entries[1]!.diff, /-two/);
});

test('apply_patch results without a diff body stay unparsed', () => {
  const legacy = 'Applied patch to 1 file(s):\n  a.txt: +1/-1';
  assert.equal(parseFileMutationDiff('apply_patch', '{}', legacy), null);
});

test('annotateDiff marks git/file headers as meta and resets numbers per hunk', () => {
  const diff = [
    'diff --git a/one.ts b/one.ts',
    '--- a/one.ts',
    '+++ b/one.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/two.ts b/two.ts',
    '--- a/two.ts',
    '+++ b/two.ts',
    '@@ -1 +1 @@',
    '-foo',
    '+bar',
  ].join('\n');

  assert.deepEqual(
    annotateDiff(diff).map((line) => [line.kind, line.number]),
    [
      ['meta', undefined],
      ['meta', undefined],
      ['meta', undefined],
      ['hunk', undefined],
      ['remove', 1],
      ['add', 1],
      ['meta', undefined],
      ['meta', undefined],
      ['meta', undefined],
      ['hunk', undefined],
      ['remove', 1],
      ['add', 1],
    ]
  );
});

test('diff ceiling stays generous', () => {
  assert.ok(MAX_TOOL_DIFF_LINES >= 2000);
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

test('read_lines parses two sections and infers the total from a file-end note', () => {
  const parsed = parseFileReadResult(
    'read_lines',
    JSON.stringify({ file_path: 'src/tool/index.ts', from: 30, to: 900, ranges: '30-35, 895-900' }),
    '[lines 30-35]\nline30\nline31\nline32\nline33\nline34\nline35'
      + '\n[lines 895-900]\nline895\nline896\nline897\nline898\nline899'
      + '\n... (file ends at line 899)'
  );
  assert.ok(parsed);
  assert.equal(parsed.filePath, 'src/tool/index.ts');
  assert.equal(parsed.totalLines, 899);
  assert.deepEqual(parsed.sections, [
    {
      startLine: 30,
      endLine: 35,
      lines: ['line30', 'line31', 'line32', 'line33', 'line34', 'line35'],
    },
    {
      startLine: 895,
      endLine: 900,
      lines: ['line895', 'line896', 'line897', 'line898', 'line899'],
      note: '... (file ends at line 899)',
    },
  ]);
});

test('read_lines keeps generic error and cancel detection', () => {
  assert.equal(parseFileReadResult('read_lines', '{}', 'Error: cannot read nope.ts'), null);
  assert.equal(parseFileReadResult('read_lines', '{}', 'Operation cancelled: rejected'), null);
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
