import test from 'node:test';
import assert from 'node:assert/strict';
import { SHORTCUT_GROUPS, renderShortcutPanel } from '../src/utils/shortcuts.js';

const items = () => SHORTCUT_GROUPS.flatMap((group) => group.items);
const flat = (lines: string[]): string => lines.join('\n');

test('catalogue has the four documented groups in display order', () => {
  assert.deepEqual(
    SHORTCUT_GROUPS.map((group) => group.title),
    ['Basics', 'Navigation', 'Agent', 'Edit'],
  );
  assert.ok(SHORTCUT_GROUPS.every((group) => group.items.length > 0));
});

test('every shortcut item is well formed', () => {
  for (const group of SHORTCUT_GROUPS) {
    assert.equal(typeof group.title, 'string');
    assert.ok(group.title.length > 0);
    for (const item of group.items) {
      assert.equal(typeof item.keys, 'string');
      assert.equal(typeof item.label, 'string');
      assert.ok(item.keys.length > 0 && item.label.length > 0);
      assert.doesNotMatch(item.keys, /[\r\n]/);
      assert.ok(item.context === undefined || typeof item.context === 'string');
    }
  }
});

test('catalogue covers the README keyboard shortcuts', () => {
  const keys = items().map((item) => item.keys);
  const labels = items().map((item) => item.label);
  for (const key of ['n', 's', 'q', 'm', 'p', 'v', 't', 'k / l', 'Tab', 'Esc', '@', '↑/↓', 'Ctrl+C', 'Ctrl+R', 'Ctrl+T']) {
    assert.ok(keys.includes(key), `missing key ${key}`);
  }
  for (const label of ['New session', 'Open sessions', 'Switch model', 'Save and exit', 'Scroll transcript', 'Abort the turn or close a prompt']) {
    assert.ok(labels.includes(label), `missing label ${label}`);
  }
});

test('panel renders titles and rows, including optional context', () => {
  const lines = renderShortcutPanel(100);
  assert.equal(lines.length <= 40, true);
  for (const group of SHORTCUT_GROUPS) assert.ok(lines.includes(group.title));
  assert.ok(lines.some((line) => line.includes('New session')));
  assert.ok(lines.some((line) => line.includes('(ask prompt)')));
  assert.ok(lines.some((line) => line.includes('(composer)')));
  assert.equal(lines.every((line) => !line.includes('\n')), true);
});

test('all rendered lines fit the requested width', () => {
  for (const width of [12, 20, 40, 60, 100, 200]) {
    const lines = renderShortcutPanel(width);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.ok(line.length <= width, `"${line}" longer than ${width}`);
    }
  }
});

test('narrow panels clip long rows with an ellipsis', () => {
  const lines = renderShortcutPanel(12);
  assert.ok(lines.some((line) => line.endsWith('…')));
  assert.ok(lines.every((line) => line.length <= 12));
  assert.match(flat(renderShortcutPanel(14)), /…/);
});

test('keybind overrides replace the advertised keys', () => {
  const lines = renderShortcutPanel(100, {
    help: 'ctrl+h',
    model: 'ctrl+m',
    provider: 'ctrl+p',
    settings: 'ctrl+o',
    subagents: 'ctrl+g',
    search: 'ctrl+f',
  });
  const text = flat(lines);
  assert.match(text, /Ctrl\+H\s+Help · shortcuts/);
  assert.match(text, /Ctrl\+M\s+Switch model/);
  assert.match(text, /Ctrl\+P\s+Switch provider/);
  assert.match(text, /Ctrl\+O\s+Open settings/);
  assert.match(text, /Ctrl\+G\s+Open the sub-agent list/);
  assert.match(text, /Ctrl\+F\s+Search transcript/);
  assert.doesNotMatch(text, /^\s*m\s+Switch model/m);
});

test('malformed keybind overrides are ignored', () => {
  const lines = renderShortcutPanel(100, {
    help: 42,
    model: null,
    settings: '',
    provider: 'bad key!',
    subagents: {},
  } as unknown as Record<string, string>);
  const text = flat(lines);
  assert.match(text, /h or \/\s+Help · shortcuts/);
  assert.match(text, /^\s*m\s+Switch model/m);
  assert.match(text, /^\s*p\s+Switch provider/m);
  assert.match(text, /^\s*,\s+Open settings/m);
  assert.match(text, /^\s*g\s+Open the sub-agent list/m);
});

test('malformed widths and keybind maps never throw', () => {
  const hostile = new Proxy({}, { get() { throw new Error('bad keybind'); } }) as Record<string, string>;
  for (const width of [Number.NaN, Number.POSITIVE_INFINITY, -20, 0, undefined as unknown as number]) {
    const lines = renderShortcutPanel(width, hostile);
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => line.length <= 100));
  }
  const tiny = renderShortcutPanel(1);
  assert.ok(tiny.length > 0);
  assert.ok(tiny.every((line) => line.length <= 1));
  assert.ok(renderShortcutPanel(-1, null as unknown as Record<string, string>).length > 0);
});

test('unknown override actions do not change the panel', () => {
  const before = renderShortcutPanel(100);
  const after = renderShortcutPanel(100, { nonexistent: 'ctrl+z' } as unknown as Record<string, string>);
  assert.deepEqual(after, before);
});

test('panel is capped at 40 lines with a hidden-count marker', () => {
  const group = SHORTCUT_GROUPS[0];
  const originalLength = group.items.length;
  try {
    for (let index = 0; index < 60; index++) {
      group.items.push({ keys: `x${index}`, label: `Extra shortcut ${index}` });
    }
    const lines = renderShortcutPanel(100);
    assert.equal(lines.length, 40);
    assert.match(lines[39], /… \d+ more/);
    assert.ok(lines.every((line) => line.length <= 100));
  } finally {
    group.items.splice(originalLength);
  }
  assert.equal(renderShortcutPanel(100).length > 0, true);
});
