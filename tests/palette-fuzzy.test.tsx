import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ThemeProvider } from '../src/theme.js';
import { Palette, SLASH_COMMANDS, type PaletteItem, type PaletteProps } from '../src/components/Palette.js';
import { fuzzyFilter } from '../src/utils/fuzzy.js';

function renderPalette(props: PaletteProps): string {
  const view = render(
    <ThemeProvider name="black">
      <Palette {...props} />
    </ThemeProvider>
  );
  const text = stripAnsi(view.lastFrame() ?? '');
  view.unmount();
  return text;
}

/** Mirrors the wiring the slash palette uses: name first, description + keywords as alias. */
function filterCommands(needle: string) {
  return fuzzyFilter(SLASH_COMMANDS, needle, {
    getText: (cmd) => cmd.name,
    getAlias: (cmd) => `${cmd.description} ${cmd.keywords ?? ''}`,
  });
}

test('cfg finds /settings through its "config" keyword', () => {
  const ranked = filterCommands('cfg');
  assert.deepEqual(ranked.map((entry) => entry.item.name), ['/settings'], 'alias-only match');
  assert.deepEqual(ranked[0].indices, [], 'alias hits carry no label indices to highlight');
});

test('an empty query keeps every command in curated order', () => {
  const ranked = filterCommands('');
  assert.deepEqual(ranked.map((entry) => entry.item.name), SLASH_COMMANDS.map((cmd) => cmd.name));
});

test('ranked results feed the count line and highlighting without throwing', () => {
  const results = filterCommands('cfg');
  const items: PaletteItem[] = results.map(({ item, indices }) => ({
    id: item.name,
    label: item.name,
    description: item.description,
    section: item.category,
    matchIndices: indices,
  }));
  const text = renderPalette({ items, selected: 0, query: 'cfg', emptyLabel: 'All commands', columns: 80 });
  assert.match(text, /1 match for "cfg"/);
  assert.match(text, /\/settings/);

  // A stale index set must never drop label characters or throw.
  const stale = renderPalette({
    items: [{ id: '/model', label: '/model', matchIndices: [3, 999, -1] }],
    selected: 0,
    query: 'mod',
    columns: 80,
  });
  assert.match(stale, /\/model/);
});
