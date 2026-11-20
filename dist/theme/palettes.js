import { THEME_NAMES } from './types.js';
import black from './themes/black.js';
import midnight from './themes/midnight.js';
import moss from './themes/moss.js';
import sand from './themes/sand.js';
import dark from './themes/dark.js';
import light from './themes/light.js';
import highContrast from './themes/high-contrast.js';
/** The immutable set of palettes, keyed by the name shown in Settings. */
export const themes = {
    black,
    midnight,
    dark,
    light,
    sand,
    moss,
    'high-contrast': highContrast,
};
/** One-line character note per palette, shown in the theme picker. */
export const THEME_TAGLINES = {
    black: 'graphite · gold',
    midnight: 'navy · violet',
    dark: 'slate · blue',
    light: 'paper · ink',
    sand: 'warm · terracotta',
    moss: 'forest · olive',
    'high-contrast': 'maximum contrast',
};
/**
 * Resolve a settings value to a palette. Unknown/missing names fall back to
 * premium black (the product default); explicit names resolve exactly.
 */
export function getTheme(name) {
    return typeof name === 'string' && THEME_NAMES.includes(name)
        ? themes[name]
        : themes.black;
}
