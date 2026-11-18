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
} as const;

/** Every palette exposes exactly the colour keys the dark theme defines. */
export type Theme = { [K in keyof typeof theme]: string };

export const THEME_NAMES = ['black', 'sand', 'dark', 'light', 'high-contrast'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

/**
 * Premium black — the default palette. Near-black canvas, warm gold accents
 * and soft ivory ink; quiet enough for long sessions but distinct from the
 * old flat-dark palette (which stays available as `dark`).
 */
const black: Theme = {
  bg: '#050505',
  surface: '#111111',
  surfaceAlt: '#1a1a1a',
  border: '#33302b',
  borderFocus: '#c9a227',
  text: '#f2efe9',
  userText: '#ffffff',
  userBorder: '#c9a227',
  placeholder: '#7d756a',
  muted: '#a8a29a',
  dim: '#726c63',
  error: '#ff6b6b',
  accent: '#d4af37',
  success: '#7bc47f',
  info: '#c9a227',
};

/** Dark, optimised for typical dark terminals (the historical palette). */
const dark: Theme = theme;

/**
 * Warm sand — the default palette. A paper-light canvas with thin brown
 * borders and muted ink, so dialogs and chat read like a notebook page
 * instead of a black terminal. Kept deliberately low-saturation so syntax
 * colours never fight the chrome.
 */
const sand: Theme = {
  bg: '#faf5ed',
  surface: '#f4ebdd',
  surfaceAlt: '#ecdfcc',
  border: '#dcc6a8',
  borderFocus: '#a9764a',
  text: '#3a2e25',
  userText: '#5a4635',
  userBorder: '#b98d63',
  placeholder: '#8f7a66',
  muted: '#6d5b4b',
  dim: '#8a7663',
  error: '#a4452e',
  accent: '#a9764a',
  success: '#5d7a4a',
  info: '#8a6a4a',
};

/** Light, with dark foregrounds so text stays readable on white. */
const light: Theme = {
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
const highContrast: Theme = {
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

export const themes: Record<ThemeName, Theme> = {
  black,
  sand,
  dark,
  light,
  'high-contrast': highContrast,
};

/**
 * Resolve a settings value to a palette. Unknown/missing names fall back to
 * premium black (the product default); explicit names still resolve exactly
 * as before.
 */
export function getTheme(name?: string): Theme {
  return typeof name === 'string' && (THEME_NAMES as readonly string[]).includes(name)
    ? themes[name as ThemeName]
    : themes.black;
}
