import test from 'node:test';
import assert from 'node:assert/strict';
import { themes, theme, getTheme } from '../src/theme.js';

const COLOR_KEYS = [
  'bg', 'surface', 'surfaceAlt', 'border', 'borderFocus', 'text', 'userText',
  'userBorder', 'placeholder', 'muted', 'dim', 'error', 'accent', 'success', 'info',
] as const;

test('every theme has the same complete set of hex colour keys', () => {
  const expected = [...COLOR_KEYS].sort();
  assert.deepEqual(Object.keys(themes).sort(), ['dark', 'high-contrast', 'light']);
  for (const [name, palette] of Object.entries(themes)) {
    assert.deepEqual(Object.keys(palette).sort(), expected, `${name} theme keys`);
    for (const key of COLOR_KEYS) {
      assert.match(palette[key], /^#[0-9a-f]{6}$/i, `${name}.${key}`);
    }
  }
});

test('getTheme resolves named themes and falls back to dark', () => {
  assert.equal(getTheme(), themes.dark);
  assert.equal(getTheme('dark'), themes.dark);
  assert.equal(getTheme('light'), themes.light);
  assert.equal(getTheme('high-contrast'), themes['high-contrast']);
  assert.equal(getTheme('nope'), themes.dark);
});

test('the legacy theme export is still the dark palette', () => {
  assert.equal(theme, themes.dark);
});
