export const theme = {
    // Page canvas. Pure black keeps the terminal's natural contrast; the
    // composer surface stays a lighter charcoal so it reads as separate.
    bg: '#000000',
    // Input surface is intentionally lighter than the chat so it reads as a
    // separate composer.
    surface: '#1e1e1e',
    surfaceAlt: '#181818',
    border: '#2f2f2f',
    borderFocus: '#8a8a8a',
    text: '#f5f5f5',
    userText: '#ffffff',
    userBorder: '#b5b5b5',
    placeholder: '#a3a3a3',
    muted: '#9a9a9a',
    dim: '#6f6f6f',
    error: '#f87171',
    accent: '#4f8cff',
    success: '#4ade80',
    info: '#60a5fa',
};
export const THEME_NAMES = ['dark', 'light', 'high-contrast'];
/** Dark, optimised for typical dark terminals (the historical palette). */
const dark = theme;
/** Light, with dark foregrounds so text stays readable on white. */
const light = {
    bg: '#ffffff',
    surface: '#f3f4f6',
    surfaceAlt: '#e5e7eb',
    border: '#cbd5e1',
    borderFocus: '#1d4ed8',
    text: '#111827',
    userText: '#0b3d91',
    userBorder: '#1d4ed8',
    placeholder: '#6b7280',
    muted: '#4b5563',
    dim: '#6b7280',
    error: '#b91c1c',
    accent: '#1d4ed8',
    success: '#15803d',
    info: '#1d4ed8',
};
/** Pure black/white with bright accents for maximum terminal contrast. */
const highContrast = {
    bg: '#000000',
    surface: '#000000',
    surfaceAlt: '#000000',
    border: '#ffffff',
    borderFocus: '#ffff00',
    text: '#ffffff',
    userText: '#ffff00',
    userBorder: '#ffff00',
    placeholder: '#ffff00',
    muted: '#ffffff',
    dim: '#ffffff',
    error: '#ff5555',
    accent: '#00ffff',
    success: '#00ff00',
    info: '#00ffff',
};
export const themes = {
    dark,
    light,
    'high-contrast': highContrast,
};
/** Resolve a settings value to a palette; unknown/missing names fall back to dark. */
export function getTheme(name) {
    return typeof name === 'string' && THEME_NAMES.includes(name)
        ? themes[name]
        : themes.dark;
}
