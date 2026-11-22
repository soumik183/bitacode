import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { getTheme, themes } from '../src/theme.js';
import { renderFormattedText, normalizeTranscriptText, wrapPlainText } from '../src/utils/format-message.js';

/** Pure helpers default to the active palette (black). */
const theme = getTheme();

type AnyElement = React.ReactElement<Record<string, unknown>>;

/** Flatten every React element in a rendered node tree (ordered, depth-first). */
function elements(node: React.ReactNode): AnyElement[] {
  const found: AnyElement[] = [];
  const walk = (value: React.ReactNode): void => {
    if (value === null || value === undefined || typeof value === 'boolean') return;
    if (typeof value === 'string' || typeof value === 'number') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (React.isValidElement(value)) {
      found.push(value as AnyElement);
      walk(value.props.children as React.ReactNode);
    }
  };
  walk(node);
  return found;
}

/** All visible text (including the '\n' separators the renderer emits). */
function textOf(node: React.ReactNode): string {
  let out = '';
  const walk = (value: React.ReactNode): void => {
    if (value === null || value === undefined || typeof value === 'boolean') return;
    if (typeof value === 'string' || typeof value === 'number') {
      out += String(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (React.isValidElement(value)) walk(value.props.children as React.ReactNode);
  };
  walk(node);
  return out;
}

test('headings are bold and coloured per level, with the # markers stripped', () => {
  const node = renderFormattedText('# Title\n## Subtitle\n#### Deep');
  const bold = elements(node).filter((element) => element.props.bold === true);
  assert.ok(bold.length >= 3);
  assert.equal(bold[0].props.color, theme.accent);
  assert.equal(bold[1].props.color, theme.info);
  assert.equal(bold[2].props.color, theme.muted);
  assert.ok(textOf(node).includes('Title'));
  assert.ok(!textOf(node).includes('# Title'));
});

test('bold, italic and bold-italic still work', () => {
  const node = renderFormattedText('**b** *i* ***bi***');
  const found = elements(node);
  assert.ok(found.some((e) => e.props.bold === true && textOf(e) === 'b'));
  assert.ok(found.some((e) => e.props.italic === true && textOf(e) === 'i'));
  assert.ok(found.some((e) => e.props.bold === true && e.props.italic === true && textOf(e) === 'bi'));
});

test('inline code uses a distinct background and stays on one line', () => {
  const node = renderFormattedText('run `const x = 1` now');
  const code = elements(node).find((e) => e.props.backgroundColor === theme.surfaceAlt);
  assert.ok(code);
  assert.equal(code.props.color, theme.success);
  assert.ok(textOf(code).includes('const x = 1'));
  assert.ok(!textOf(node).includes('\n'));
});

test('links colour the label and keep the url dim', () => {
  const node = renderFormattedText('see [docs](https://example.com) here');
  const label = elements(node).find((e) => e.props.underline === true);
  assert.ok(label);
  assert.equal(textOf(label), 'docs');
  assert.equal(label.props.color, theme.accent);
  assert.ok(textOf(node).includes('https://example.com'));
});

test('bare urls are coloured', () => {
  const node = renderFormattedText('visit https://example.com/x today');
  assert.ok(elements(node).some((e) => e.props.color === theme.info && textOf(e) === 'https://example.com/x'));
});

const YELLOW = '#facc15';
const GREEN = theme.success;

test('unordered and ordered lists use yellow, bold markers', () => {
  const node = renderFormattedText('- first\n1. second');
  const found = elements(node);
  assert.ok(found.some((e) => e.props.color === YELLOW && e.props.bold === true && textOf(e) === '• '));
  assert.ok(found.some((e) => e.props.color === YELLOW && e.props.bold === true && textOf(e) === '1. '));
  assert.ok(textOf(node).includes('first'));
  assert.ok(textOf(node).includes('second'));
});

test('nested list markers are yellow+bold and indentation strictly increases (capped)', () => {
  const node = renderFormattedText('- top\n  - child\n    - grandchild');
  const found = elements(node);
  const markers = found.filter((e) => e.props.color === YELLOW && e.props.bold === true && textOf(e) === '• ');
  assert.equal(markers.length, 3);
  // The indentation element that precedes each marker grows: '', 2, 4 spaces.
  const widths = ['', '  ', '    '].map((ws) => found.findIndex((e) => textOf(e) === ws && e.props.color === theme.muted));
  assert.ok(widths[0] >= 0 && widths[1] > widths[0] && widths[2] > widths[1]);

  // A maliciously deep indent is capped so text cannot be pushed off screen.
  const deep = renderFormattedText(`${' '.repeat(200)}- deep`);
  const indents = elements(deep).filter((e) => e.props.color === theme.muted && /^ +$/.test(textOf(e)));
  assert.ok(indents.every((e) => textOf(e).length <= 12));
  assert.ok(textOf(deep).includes('deep'));
});

test('task list checkboxes are yellow (unchecked) and green (checked), bold', () => {
  const node = renderFormattedText('- [ ] todo\n- [x] done\n- [X] DONE');
  const found = elements(node);
  const unchecked = found.filter((e) => textOf(e).startsWith('☐') && e.props.color === YELLOW && e.props.bold === true);
  const checked = found.filter((e) => textOf(e).startsWith('☑') && e.props.color === GREEN && e.props.bold === true);
  assert.equal(unchecked.length, 1);
  assert.equal(checked.length, 2);
  assert.ok(textOf(node).includes('todo'));
  assert.ok(textOf(node).includes('done'));
});

test('strikethrough is rendered with the strikethrough style', () => {
  const node = renderFormattedText('~~gone~~ but kept');
  assert.ok(elements(node).some((e) => e.props.strikethrough === true && textOf(e) === 'gone'));
  assert.ok(textOf(node).includes('kept'));
});

test('horizontal rules render as a single dim divider', () => {
  const node = renderFormattedText('above\n---\nbelow');
  const found = elements(node);
  assert.ok(found.some((e) => e.props.color === theme.dim && /─{3,}/.test(textOf(e))));
  assert.equal(textOf(node).split('\n').length, 3);
});

test('malformed/unclosed markdown keeps literal text and never throws', () => {
  assert.doesNotThrow(() => {
    const node = renderFormattedText('**[bold [link](url ~~strike\n> quote\n- [x] task\n```ts\nunclosed');
    const output = textOf(node);
    for (const word of ['bold', 'link', 'strike', 'quote', 'task', 'unclosed']) {
      assert.ok(output.includes(word), `missing ${word}`);
    }
  });
});

test('a large table produces at most ~20 output rows', () => {
  const row = '| a | b |';
  const input = [row, '| --- | --- |', ...Array.from({ length: 40 }, () => row)].join('\n');
  const outputRows = textOf(renderFormattedText(input)).split('\n').length;
  assert.ok(outputRows <= 21, `output rows: ${outputRows}`);
});

test('output rows stay globally bounded for a very large input', () => {
  const output = textOf(renderFormattedText('line\n'.repeat(10_000)));
  assert.ok(output.split('\n').length <= 201, `output rows: ${output.split('\n').length}`);
});

test('blockquotes use a coloured bar and italic text', () => {
  const node = renderFormattedText('> quoted *words*');
  const found = elements(node);
  assert.ok(found.some((e) => textOf(e) === '│ ' && e.props.color === theme.accent));
  assert.ok(found.some((e) => e.props.italic === true && textOf(e) === 'words'));
});

test('fenced code blocks are highlighted and bounded without growing the frame', () => {
  const code = Array.from({ length: 50 }, (_, i) => `const x${i} = ${i};`).join('\n');
  const input = '```ts\n' + code + '\n```';
  const node = renderFormattedText(input);
  const output = textOf(node);

  const inputRows = input.split('\n').length;
  const outputRows = output.split('\n').length;
  assert.ok(outputRows <= 15, `output rows: ${outputRows}`);
  assert.ok(outputRows < inputRows);
  assert.match(output, /more lines/);
  assert.ok(elements(node).some((e) => e.props.color === theme.accent && textOf(e) === 'const'));
});

test('a small fenced block keeps the same number of rows', () => {
  const input = '```js\nconst a = 1;\n```';
  const output = textOf(renderFormattedText(input));
  assert.equal(output.split('\n').length, input.split('\n').length);
});

test('unclosed / malformed markdown does not throw and still shows text', () => {
  assert.doesNotThrow(() => {
    const node = renderFormattedText('**unclosed *and [link(no url\n```lang\nno closing fence');
    assert.ok(textOf(node).includes('unclosed'));
  });
  assert.doesNotThrow(() => renderFormattedText(''));
  assert.equal(textOf(renderFormattedText('')), '');
});

test('long input is capped so rendering stays cheap', () => {
  const node = renderFormattedText('x'.repeat(120_000));
  assert.ok(textOf(node).length <= 50_000);
});

test('plain prose gets word-boundary line breaks at the terminal width', () => {
  const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
  const wrapped = wrapPlainText(text, 20);
  assert.ok(wrapped.includes('\n'), 'long normal text is broken into rows');
  for (const line of wrapped.split('\n')) {
    assert.ok(line.length <= 20, `row "${line}" exceeds 20 columns`);
  }
  assert.equal(wrapPlainText('short text', 80), 'short text');
  assert.equal(wrapPlainText('para one\n\npara two', 80), 'para one\n\npara two');
  // No width (legacy callers) keeps the text untouched.
  assert.equal(wrapPlainText(text, 0), text);
});

test('normalizeTranscriptText trims the ends but keeps paragraph breaks', () => {
  // Blank lines carry markdown structure (tables, fenced blocks, paragraphs),
  // so they are preserved; only runs of three or more collapse to one break.
  assert.equal(normalizeTranscriptText('  a\n\n\nb  '), 'a\n\nb');
  assert.equal(normalizeTranscriptText('a\n\n\n\n\nb'), 'a\n\nb');
  assert.equal(normalizeTranscriptText('   '), '');
});

test('an explicit palette paints headings, code and dividers', () => {
  const light = themes.light;
  const node = renderFormattedText('# Title\n`x`\n---', 0, light);
  const found = elements(node);
  assert.ok(found.some((e) => e.props.bold === true && e.props.color === light.accent && textOf(e) === 'Title'));
  assert.ok(found.some((e) => e.props.backgroundColor === light.surfaceAlt));
  assert.ok(found.some((e) => e.props.color === light.dim && /─{3,}/.test(textOf(e))));
});

test('underscore emphasis, escapes, images and mixed emphasis are formatted', () => {
  const node = renderFormattedText('__bold__ and _italic_ and **bold *nested* text** and \\*literal\\* and ![alt](x.png)', 80, theme);
  const text = textOf(node);
  assert.match(text, /bold and italic and bold nested text and \*literal\* and 🖼 alt/);
  assert.doesNotMatch(text, /\\\*/, 'escape markers are consumed');
  const found = elements(node);
  assert.ok(found.some((e) => e.props.bold === true && textOf(e) === 'bold'), '__bold__ is bold');
  assert.ok(found.some((e) => e.props.italic === true && textOf(e) === 'italic'), '_italic_ is italic');
  assert.ok(found.some((e) => e.props.italic === true && textOf(e) === 'nested'), 'mixed emphasis works');
});

test('a table with a long preamble still renders boxed when formatted as a whole', () => {
  const preamble = Array.from({ length: 18 }, (_, i) => `intro line ${i}`).join('\n');
  const text = `${preamble}\n\n| name | value |\n| --- | --- |\n| alpha | 1 |`;
  const node = renderFormattedText(text, 80, theme);
  const found = elements(node);
  assert.ok(found.some((e) => /name/.test(textOf(e))), 'table header is rendered');
  assert.ok(found.some((e) => /─{2,}/.test(textOf(e))), 'table divider is drawn');
});

test('the highlight memo does not leak colours across palettes', () => {
  const code = '```ts\nconst x = 1;\n```';
  const paintsWith = (palette: typeof theme): boolean =>
    elements(renderFormattedText(code, 0, palette)).some(
      (e) => e.props.color === palette.accent && textOf(e) === 'const'
    );

  assert.ok(paintsWith(theme), 'default palette paints its own keyword colour');
  assert.ok(paintsWith(themes.light), 'a second palette paints its own keyword colour');
  assert.ok(paintsWith(theme), 'switching back still paints the first palette correctly');
});
