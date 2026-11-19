import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { getTheme } from '../src/theme.js';
import { renderFormattedText } from '../src/utils/format-message.js';

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

test('a full 3-column table renders aligned header and rows with a coloured header', () => {
  const md = '| Name | Value | Note |\n| :--- | ----: | :---: |\n| a | **1** | ok |';
  const node = renderFormattedText(md);
  const output = textOf(node);
  const found = elements(node);

  // Header cells are bold with the accent colour.
  const headerCells = found.filter((e) => e.props.bold === true && e.props.color === theme.accent);
  assert.ok(headerCells.some((e) => textOf(e).includes('Name')));
  assert.ok(headerCells.some((e) => textOf(e).includes('Value')));
  assert.ok(headerCells.some((e) => textOf(e).includes('Note')));

  // A dim separator line is emitted and the raw separator markup is consumed.
  assert.ok(found.some((e) => e.props.color === theme.dim && /─{2,}/.test(textOf(e))));
  assert.ok(!output.includes(':---'));
  assert.ok(!output.includes('----:'));

  // Body text and inline bold inside a cell both survive.
  assert.ok(output.includes('a'));
  assert.ok(output.includes('ok'));
  assert.ok(found.some((e) => e.props.bold === true && textOf(e) === '1'));
});

test('a partial table (no separator yet) renders as plain text and does not throw', () => {
  const md = '| Name | Value |\n| a | 1 |';
  let node: React.ReactNode;
  assert.doesNotThrow(() => {
    node = renderFormattedText(md);
  });
  // @ts-expect-error assigned inside doesNotThrow
  const output = textOf(node);
  assert.ok(output.includes('| Name | Value |'));
  assert.ok(output.includes('| a | 1 |'));
});

test('alignment markers affect padding (left / right / center)', () => {
  const md = [
    '| L | R | C |',
    '| :--- | ---: | :---: |',
    '| aaaa | b | x |',
    '| a | bbbb | mmmm |',
  ].join('\n');
  const found = elements(renderFormattedText(md));

  // Right-aligned 'b' gets leading spaces to reach the column width of 4.
  assert.ok(found.some((e) => /^ +b$/.test(textOf(e))), 'right alignment should pad on the left');
  // Left-aligned 'a' gets trailing spaces.
  assert.ok(found.some((e) => /^a +$/.test(textOf(e))), 'left alignment should pad on the right');
  // Center-aligned 'x' gets padding on both sides.
  assert.ok(found.some((e) => /^ +x +$/.test(textOf(e))), 'center alignment should pad on both sides');
});

test('inline code and links inside table cells still render', () => {
  const md = '| Code | Link |\n| --- | --- |\n| `x` | [docs](https://example.com) |';
  const node = renderFormattedText(md);
  const found = elements(node);
  assert.ok(found.some((e) => e.props.backgroundColor === theme.surfaceAlt && textOf(e).includes('x')));
  const label = found.find((e) => e.props.underline === true);
  assert.ok(label);
  assert.equal(textOf(label), 'docs');
  assert.ok(textOf(node).includes('https://example.com'));
});

test('complex cells (<br>, nested pipes) degrade gracefully without throwing', () => {
  const md = '| A | B |\n| --- | --- |\n| one<br>two | `a|b` |';
  let output = '';
  assert.doesNotThrow(() => {
    output = textOf(renderFormattedText(md));
  });
  assert.ok(output.includes('one'));
  assert.ok(output.includes('two'));
  assert.ok(output.includes('a|b'));
});

test('a malformed table header never throws and keeps its text visible', () => {
  const md = '| a | b |\n| :--- | not-a-separator |\n| c | d |';
  let output = '';
  assert.doesNotThrow(() => {
    output = textOf(renderFormattedText(md));
  });
  assert.ok(output.includes('not-a-separator'));
  assert.ok(output.includes('| a | b |'));
});

test('passing a column budget clamps wide tables to the terminal width', () => {
  const md = [
    '| Column one | Column two | Column three |',
    '| :--- | :--- | :--- |',
    '| a very long cell value here | another long cell value | a third long value |',
  ].join('\n');

  const unconstrained = textOf(renderFormattedText(md));
  const constrained = textOf(renderFormattedText(md, 20));
  const widthOf = (text: string) => Math.max(0, ...text.split('\n').map((line) => line.length));

  assert.ok(widthOf(unconstrained) > 20, 'without a budget the table is naturally wide');
  assert.ok(widthOf(constrained) <= 20, `clamped table is ${widthOf(constrained)} columns wide`);
  // Row structure (header, divider, body) survives the clamp.
  assert.ok(constrained.split('\n').length >= 3);
  assert.ok(constrained.includes('│'), 'the clamped table still has column borders');
});
