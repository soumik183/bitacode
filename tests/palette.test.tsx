import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ThemeProvider } from '../src/theme.js';
import { Palette, SLASH_COMMANDS, highlightMatch, type PaletteItem, type PaletteProps } from '../src/components/Palette.js';

function renderFrame(props: PaletteProps): { raw: string; text: string; columns: number } {
  const view = render(
    <ThemeProvider name="black">
      <Palette {...props} />
    </ThemeProvider>
  );
  const raw = view.lastFrame() ?? '';
  const columns = view.stdout.columns;
  view.unmount();
  return { raw, text: stripAnsi(raw), columns };
}

const cardWidth = (text: string): number => Math.max(...text.split('\n').map((line) => line.length));
const fitsWidth = (text: string, columns: number): boolean =>
  text.split('\n').every((line) => stripAnsi(line).length <= columns);

/** Controllable stdout so a single mount can be rendered at several widths. */
class FakeStdout extends EventEmitter {
  frames: string[] = [];
  isTTY = true;
  constructor(public cols: number) {
    super();
  }
  get columns() { return this.cols; }
  write = (chunk: string | Uint8Array): boolean => {
    this.frames.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  lastFrame(): string {
    return this.frames[this.frames.length - 1] ?? '';
  }
}

function renderAtWidth(cols: number, props: PaletteProps) {
  const stdout = new FakeStdout(cols);
  const tree = () => (
    <ThemeProvider name="black">
      <Palette {...props} />
    </ThemeProvider>
  );
  const view = inkRender(tree(), {
    stdout: stdout as any,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    text: () => stripAnsi(stdout.lastFrame()),
    resize(next: number) {
      stdout.cols = next;
      // Re-render after changing stdout.columns: this is what a real zoom/resize
      // does, and it is robust even in CI where Ink skips the 'resize' listener.
      view.rerender(tree());
      stdout.emit('resize');
    },
    unmount() {
      view.unmount();
      view.cleanup();
    },
  };
}

test('slash palette renders as a rounded card with command labels at full width', () => {
  const items: PaletteItem[] = SLASH_COMMANDS.slice(0, 6).map((command) => ({
    id: command.name,
    label: command.name,
    description: command.description,
    section: command.category,
  }));
  const { text, columns } = renderFrame({ items, selected: 0, columns: 80 });
  assert.match(text, /╭─+╮/, 'rounded top border');
  assert.match(text, /╰─+╯/, 'rounded bottom border');
  assert.match(text, /\/help/);
  assert.match(text, /\/new/);
  assert.match(text, /\/review/);
  assert.equal(cardWidth(text), columns, 'card spans the full renderer width');
  assert.ok(fitsWidth(text, columns), 'no line exceeds the live area width');
});

test('the selected row keeps its pointer and the query match is emphasised', () => {
  const items: PaletteItem[] = [{ id: '/help', label: '/help', description: 'Keys, hints and all commands' }];
  const { text } = renderFrame({ items, selected: 0, columns: 80, query: 'hel' });
  assert.match(text, /› \/help/, 'the pointer stays on the selected row');
  assert.match(text, /\/help/, 'the matched label text is present');
  assert.deepEqual(
    highlightMatch('/help', 'hel'),
    [{ text: '/', match: false }, { text: 'hel', match: true }, { text: 'p', match: false }],
    'the matched run is flagged for emphasis'
  );
});

test('long lists window with a down marker and a count row, with no extra rows', () => {
  const items: PaletteItem[] = Array.from({ length: 20 }, (_, i) => ({
    id: `cmd${i}`,
    label: `/cmd${String(i).padStart(2, '0')}`,
    description: `Command ${i}`,
  }));
  const { text } = renderFrame({ title: 'Commands', items, selected: 0, columns: 80 });
  assert.match(text, /↓ 13 more/, 'the down marker counts the hidden rows');
  assert.match(text, /1\/20/, 'the count row shows the total');
  assert.match(text, /\/cmd00/);
  assert.match(text, /\/cmd06/, 'the last visible row sits inside the 7-row window');
  assert.doesNotMatch(text, /\/cmd10/, 'rows beyond the window are not rendered');
});

test('undefined columns still spans the full renderer width', () => {
  const items: PaletteItem[] = [{ id: '/help', label: '/help', description: 'Keys, hints and all commands' }];
  const { text, columns } = renderFrame({ items, selected: 0 });
  assert.equal(cardWidth(text), columns);
  assert.ok(fitsWidth(text, columns), 'no line exceeds the live area width');
});

test('card reflows with terminal width instead of clamping (zoom/resize regression)', () => {
  // width="100%" is what makes the card reflow: there is no fixed column budget.
  // columns is used only for the <48 description threshold.
  const items: PaletteItem[] = [{ id: '/help', label: '/help', description: 'Keys, hints and all commands' }];
  const view = renderAtWidth(60, { items, selected: 0, columns: 60 });
  try {
    assert.match(view.text(), /Keys, hints/, 'descriptions show on a wide-enough terminal');
    assert.equal(cardWidth(view.text()), 60);
    assert.ok(fitsWidth(view.text(), 60), 'no line exceeds 60 columns');

    view.resize(20);
    assert.equal(cardWidth(view.text()), 20, 'card shrinks with the terminal');
    assert.ok(fitsWidth(view.text(), 20), 'no line exceeds 20 columns');
    assert.doesNotMatch(view.text(), /Keys, hints/, 'narrow terminals drop descriptions');

    view.resize(100);
    assert.equal(cardWidth(view.text()), 100, 'card grows with the terminal');
    assert.ok(fitsWidth(view.text(), 100), 'no line exceeds 100 columns');
  } finally {
    view.unmount();
  }
});

test('renders nothing for an empty item list', () => {
  const { text } = renderFrame({ items: [], selected: 0, columns: 80 });
  assert.equal(text, '');
});

test('a query shows a compact match-count line without growing the empty-query card', () => {
  const items: PaletteItem[] = SLASH_COMMANDS.slice(0, 12).map((command) => ({
    id: command.name,
    label: command.name,
    description: command.description,
    section: command.category,
  }));
  const filtered = renderFrame({ items, selected: 0, columns: 80, query: 'cfg', emptyLabel: 'All commands' });
  assert.match(filtered.text, /12 matches for "cfg"/, 'the count line reports the filtered total');
  assert.ok(fitsWidth(filtered.text, filtered.columns), 'the count line respects the width helpers');

  const plain = renderFrame({ items, selected: 0, columns: 80, emptyLabel: '' });
  const empty = renderFrame({ items, selected: 0, columns: 80, emptyLabel: 'All commands' });
  assert.match(empty.text, /All commands/, 'the empty-query label reuses the header row');
  assert.equal(empty.text.split('\n').length, plain.text.split('\n').length, 'an empty query adds no row');
  assert.doesNotMatch(empty.text, /matches for/, 'there is no count line without a query');
});
