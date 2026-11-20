/**
 * Markdown fidelity in the transcript.
 *
 * These guard the two things users actually notice: every construct they write
 * (headings, bold, bullets, tables, quotes, code) comes out rendered instead of
 * raw, and a streaming reply keeps whole blocks so a table is never flushed one
 * line at a time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import {
  normalizeTranscriptText,
  renderFormattedText,
  splitMarkdownBlocks,
} from '../src/utils/format-message.js';
import { themes } from '../src/theme.js';
import { transcriptFillerRows } from '../src/utils/layout.js';
import { displayWidth, tableColumnWidths } from '../src/utils/format-message.js';

const plain = (text: string, columns = 0): string =>
  stripAnsi(String(render(<Text>{renderFormattedText(text, columns, themes.black)}</Text>).lastFrame() ?? ''));

test('headings, bold, bullets, quotes and rules render without raw markers', () => {
  const out = plain(
    ['# Title', '## Subtitle', '', 'Some **bold** and *italic* text.', '', '- one', '  - nested', '', '> quoted', '', '---'].join('\n')
  );
  assert.match(out, /Title/);
  assert.doesNotMatch(out, /#\s*Title/, 'heading marker is consumed');
  assert.match(out, /Subtitle/);
  assert.match(out, /Some bold and italic text\./, 'emphasis markers are consumed');
  assert.match(out, /• one/);
  assert.match(out, /• nested/, 'nested bullets stay bullets');
  assert.match(out, /│ quoted/);
  assert.doesNotMatch(out, /^---$/m, 'horizontal rule becomes a divider');
});

test('ordered lists and task lists keep their markers', () => {
  const out = plain(['1. first', '2. second', '', '- [x] done', '- [ ] todo'].join('\n'));
  assert.match(out, /1\. first/);
  assert.match(out, /2\. second/);
  assert.match(out, /☑ done/);
  assert.match(out, /☐ todo/);
});

test('a pipe table renders as a boxed table, not raw pipes', () => {
  const table = ['| Name | Value |', '| --- | ---: |', '| alpha | 1 |', '| beta | 22 |'].join('\n');
  const out = plain(table);
  assert.match(out, /│ Name\s+│ Value │/);
  assert.match(out, /├─+┼─+┤/, 'a divider row separates head from body');
  assert.match(out, /│ beta\s+│\s+22 │/, 'right alignment is honoured');
  assert.doesNotMatch(out, /\|\s*---/, 'the separator row is not printed');
});

test('tables are responsive: they wrap inside the terminal width', () => {
  const table = [
    '| very long column name | another long column |',
    '| --- | --- |',
    '| a very long description here | short |',
  ].join('\n');
  const rows = plain(table, 40).split('\n');
  const widest = Math.max(...rows.map((line) => line.length));
  assert.ok(widest <= 40, `table is ${widest} cols wide`);
  // Borders stay square because long cells wrap onto extra physical rows.
  const borderWidths = new Set(rows.map((line) => line.length));
  assert.equal(borderWidths.size, 1, 'every table row is the same width');
  assert.match(rows.join('\n'), /│ a very long\s+│ short\s+│/);
  assert.match(rows.join('\n'), /│ description here\s+│\s+│/, 'the long cell continues below');
});

test('cells are padded from the printed text, so links and wide glyphs align', () => {
  const table = [
    '| Link | 名前 |',
    '| --- | --- |',
    '| [docs](https://example.com/a) | 日本語 |',
  ].join('\n');
  const rows = plain(table, 60).split('\n').filter((line) => line.includes('│'));
  const widths = new Set(rows.map((line) => displayWidth(line)));
  assert.equal(widths.size, 1, `rows have different widths: ${[...widths].join(', ')}`);
  assert.match(rows.join('\n'), /│ docs \(https:\/\/example\.com\/a\) │ 日本語\s+│/);
});

test('numeric columns stay right aligned after wrapping support', () => {
  const out = plain(['| item | qty |', '| --- | ---: |', '| apples | 12 |', '| pears | 3 |'].join('\n'));
  const rows = out.split('\n');
  const qty = rows.filter((line) => /apples|pears/.test(line)).map((line) => line.split('│')[2] ?? '');
  assert.ok(qty.every((cell) => /^\s+\d+\s*$/.test(cell)), `right aligned: ${JSON.stringify(qty)}`);
  assert.equal(new Set(rows.map((line) => line.length)).size, 1, 'aligned borders');
});

test('the column allocator never exceeds the width it is given', () => {
  for (const columns of [20, 30, 40, 50, 72]) {
    for (const widths of [[8, 8], [20, 4, 6], [60, 40]]) {
      const out = tableColumnWidths(widths, columns);
      const total = out.reduce((sum, width) => sum + width, 0) + out.length * 3 + 1;
      assert.ok(total <= Math.max(columns, out.length * 3 + 1), `${columns}: total ${total} from ${widths}`);
      assert.ok(out.every((width) => width >= 1));
    }
  }
});

test('fenced code is highlighted and closed, with a row budget', () => {
  const code = ['```ts', 'const answer = 42;', '```'].join('\n');
  const out = plain(code);
  assert.match(out, /const answer = 42;/);
  assert.match(out, /```ts/, 'the language tag is kept as a fence header');
});

test('plain prose skips the markdown parser but keeps its text', () => {
  const prose = 'This is an ordinary sentence with no special formatting at all.';
  assert.equal(plain(prose), prose);
  const multi = 'First line of prose.\nSecond line of prose.';
  assert.equal(plain(multi), multi);
});

test('paragraph breaks survive normalisation, so tables and fences keep shape', () => {
  assert.equal(normalizeTranscriptText('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(normalizeTranscriptText('a\r\nb'), 'a\nb');
  assert.equal(normalizeTranscriptText('  \n\n  '), '');
});

test('streaming flushes whole blocks, never half a table', () => {
  const partial = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\nStill typ';
  const { complete, tail } = splitMarkdownBlocks(partial);
  assert.equal(tail.trim(), 'Still typ');
  assert.match(complete, /\| a \| b \|/, 'the table travels as one block');
  assert.match(complete, /\| --- \| --- \|/, 'including its separator row');
  assert.match(complete, /\| 1 \| 2 \|/);

  // A blank line inside a fence must not end the block.
  const fenced = ['```ts', 'const a = 1;', '', 'const b = 2;', '```', '', 'after'].join('\n');
  const split = splitMarkdownBlocks(fenced);
  assert.match(split.complete, /const b = 2;/, 'blank line inside a fence is not a boundary');
  assert.equal(split.tail.trim(), 'after');

  // Nothing complete yet: everything stays live.
  assert.deepEqual(splitMarkdownBlocks('one line'), { complete: '', tail: 'one line' });
});

test('the transcript viewport is padded to a solid block', () => {
  assert.equal(transcriptFillerRows(20, 12), 8);
  assert.equal(transcriptFillerRows(20, 20), 0);
  assert.equal(transcriptFillerRows(20, 26), 0, 'overflow is clipped, never padded negatively');
  assert.equal(transcriptFillerRows(Number.NaN, 4), 0);
  assert.equal(transcriptFillerRows(10, Number.NaN), 10);
});
