import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import {
  themes,
  theme,
  getTheme,
  THEME_NAMES,
  ThemeProvider,
  useTheme,
  type Theme,
} from '../src/theme.js';

const COLOR_KEYS = [
  'bg', 'surface', 'surfaceAlt', 'border', 'borderFocus', 'text', 'userText',
  'userBorder', 'placeholder', 'muted', 'dim', 'error', 'accent', 'success', 'info',
] as const;

test('every theme has the same complete set of hex colour keys', () => {
  const expected = [...COLOR_KEYS].sort();
  assert.deepEqual(Object.keys(themes).sort(), ['black', 'dark', 'high-contrast', 'light', 'midnight', 'moss', 'sand']);
  for (const [name, palette] of Object.entries(themes)) {
    assert.deepEqual(Object.keys(palette).sort(), expected, `${name} theme keys`);
    for (const key of COLOR_KEYS) {
      assert.match(palette[key], /^#[0-9a-f]{6}$/i, `${name}.${key}`);
    }
  }
});

test('getTheme resolves named themes and falls back to black', () => {
  assert.equal(getTheme(), themes.black);
  assert.equal(getTheme('black'), themes.black);
  assert.equal(getTheme('sand'), themes.sand);
  assert.equal(getTheme('dark'), themes.dark);
  assert.equal(getTheme('light'), themes.light);
  assert.equal(getTheme('high-contrast'), themes['high-contrast']);
  assert.equal(getTheme('nope'), themes.black);
});

test('the legacy theme export is still the dark palette', () => {
  assert.equal(theme, themes.dark);
});

test('THEME_NAMES lists the selectable palettes in cycle order', () => {
  assert.deepEqual([...THEME_NAMES], ['black', 'midnight', 'dark', 'light', 'sand', 'moss', 'high-contrast']);
});

/** Reads the palette a component sees, without rendering any visible chrome. */
function probePalette(name?: string): Theme | null {
  let seen: Theme | null = null;
  const Probe = () => {
    seen = useTheme();
    return React.createElement(Text, null, 'x');
  };
  const tree = name === undefined
    ? React.createElement(Probe)
    : React.createElement(ThemeProvider, { name }, React.createElement(Probe));
  const view = render(tree);
  view.unmount();
  return seen;
}

test('useTheme falls back to the default black palette outside a provider', () => {
  assert.equal(probePalette(), themes.black);
});

test('ThemeProvider supplies the selected palette without mutating a singleton', () => {
  assert.equal(probePalette('sand'), themes.sand);
  assert.equal(probePalette('high-contrast'), themes['high-contrast']);
  assert.equal(probePalette('nope'), themes.black);
  // Resolving a palette never changes the legacy export or the shared record.
  assert.equal(theme, themes.dark);
});
