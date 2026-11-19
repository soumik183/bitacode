import dark from './themes/dark.js';
import type { Theme } from './types.js';

export { THEME_NAMES } from './types.js';
export type { Theme, ThemeName } from './types.js';
export { themes, getTheme } from './palettes.js';
export { ThemeProvider, useTheme } from './context.js';
export type { ThemeProviderProps } from './context.js';

/**
 * Compatibility export: the historical `theme` object used to be the flat
 * dark palette (mutated in place on theme changes). It is now the immutable
 * dark palette; new code should use `useTheme()`.
 */
export const theme: Theme = dark;
