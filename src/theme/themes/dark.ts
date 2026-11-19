import type { Theme } from '../types.js';

/** The historical flat-dark palette, kept for users who prefer it. */
const dark: Theme = {
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

export default dark;
