import { THEME_NAMES, type Theme, type ThemeName } from './types.js';
import black from './themes/black.js';
import sand from './themes/sand.js';
import dark from './themes/dark.js';
import light from './themes/light.js';
import highContrast from './themes/high-contrast.js';

/** The immutable set of palettes, keyed by the name shown in Settings. */
export const themes: Record<ThemeName, Theme> = {
  black,
  sand,
  dark,
  light,
  'high-contrast': highContrast,
};

/**
 * Resolve a settings value to a palette. Unknown/missing names fall back to
 * premium black (the product default); explicit names resolve exactly.
 */
export function getTheme(name?: string): Theme {
  return typeof name === 'string' && (THEME_NAMES as readonly string[]).includes(name)
    ? themes[name as ThemeName]
    : themes.black;
}
