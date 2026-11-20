import type { Theme } from '../types.js';

/**
 * Midnight — deep navy for night sessions.
 *
 * Navy reads as "focus" and keeps the eye calm longer than pure black, while a
 * soft violet accent adds hierarchy without the alertness of red or the glare of
 * cyan headlines. Every semantic colour is spaced far apart so status text is
 * distinguishable at a glance.
 */
const midnight: Theme = {
  bg: '#080d1a',
  surface: '#111a2e',
  surfaceAlt: '#17223c',
  border: '#465a83',
  borderFocus: '#a78bfa',
  text: '#e8eefc',
  userText: '#ffffff',
  userBorder: '#a78bfa',
  placeholder: '#8e9ab5',
  muted: '#b9c4dc',
  dim: '#8d99b6',
  error: '#ff8a9b',
  accent: '#a78bfa',
  success: '#5ee2b0',
  info: '#67d8f5',
};

export default midnight;
