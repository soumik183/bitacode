/** The palette names a user can select. Order drives the settings cycle. */
export const THEME_NAMES = [
  'black',
  'midnight',
  'dark',
  'light',
  'sand',
  'moss',
  'high-contrast',
] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

/**
 * Every palette exposes the same 15 semantic colour keys. Values are hex
 * strings (`#rrggbb`) so they can be handed straight to Ink or converted to
 * ANSI with `utils/session-exit-format.ts`.
 */
export type Theme = {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  borderFocus: string;
  text: string;
  userText: string;
  userBorder: string;
  placeholder: string;
  muted: string;
  dim: string;
  error: string;
  accent: string;
  success: string;
  info: string;
};
