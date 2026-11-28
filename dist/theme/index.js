import dark from './themes/dark.js';
export { THEME_NAMES } from './types.js';
export { themes, getTheme, registerCustomTheme, customThemes } from './palettes.js';
export { ThemeProvider, useTheme } from './context.js';
/**
 * Compatibility export: the historical `theme` object used to be the flat
 * dark palette (mutated in place on theme changes). It is now the immutable
 * dark palette; new code should use `useTheme()`.
 */
export const theme = dark;
