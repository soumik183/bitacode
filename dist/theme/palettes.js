import { THEME_NAMES } from './types.js';
import black from './themes/black.js';
import midnight from './themes/midnight.js';
import moss from './themes/moss.js';
import sand from './themes/sand.js';
import dark from './themes/dark.js';
import light from './themes/light.js';
import highContrast from './themes/high-contrast.js';
/**
 * Text in code blocks and dialogs paints on `surface`/`surfaceAlt` rather than
 * `bg`. These AA-checked copies keep those roles readable there; the source
 * theme modules stay untouched.
 */
const lightAudited = { ...light, success: '#147b3b' };
const sandAudited = {
    ...sand,
    accent: '#8d5428',
    success: '#466b38',
    info: '#2d6a75',
};
/** The immutable set of palettes, keyed by the name shown in Settings. */
export const themes = {
    black,
    midnight,
    dark,
    light: lightAudited,
    sand: sandAudited,
    moss,
    'high-contrast': highContrast,
    // Replaced at startup when a valid user theme file is discovered.
    custom: dark,
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
    custom: 'user theme',
};
/**
 * Resolve a settings value to a palette. Unknown/missing names fall back to
 * premium black (the product default); explicit names resolve exactly.
 */
export function getTheme(name) {
    // `in` also finds inherited members ("toString", "constructor", "__proto__"),
    // which are not palettes. Only own registrations count as custom themes.
    if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(customThemes, name)) {
        return customThemes[name];
    }
    return typeof name === 'string' && THEME_NAMES.includes(name)
        ? themes[name]
        : themes.black;
}
/** User-supplied palettes, registered at startup from JSON/JSONC files. */
export const customThemes = {};
/**
 * Incremented on every successful registration. Consumers (notably
 * ThemeProvider) can include this live binding in a memo key so a palette
 * registered after the first render still repaints. `getTheme()` itself stays
 * a pure lookup.
 */
export let customThemeVersion = 0;
const THEME_KEYS = [
    'bg', 'surface', 'surfaceAlt', 'border', 'borderFocus', 'text', 'userText',
    'userBorder', 'placeholder', 'muted', 'dim', 'error', 'accent', 'success', 'info',
];
const HEX = /^#[0-9a-fA-F]{6}$/;
/**
 * Validate and register a theme. Returns false for malformed palettes instead
 * of throwing — a broken user theme must never break startup.
 */
export function registerCustomTheme(name, raw) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name) || !raw || typeof raw !== 'object')
        return false;
    const record = raw;
    if (!THEME_KEYS.every((key) => typeof record[key] === 'string' && HEX.test(String(record[key])))) {
        return false;
    }
    const palette = {};
    for (const key of THEME_KEYS)
        palette[key] = String(record[key]);
    customThemes[name] = palette;
    customThemeVersion += 1;
    return true;
}
