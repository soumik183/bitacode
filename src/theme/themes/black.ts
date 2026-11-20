import type { Theme } from '../types.js';

/**
 * Graphite & gold — the default palette.
 *
 * Near-black graphite keeps long sessions calm, and a single warm gold accent
 * carries attention without the blue-light glare of a pure-white terminal.
 * Semantic colours are deliberately separated: gold (accent), mint (success),
 * coral (error) and sky (info) so a status word is identifiable before it is
 * read. Body text sits at ~15:1 contrast; captions stay above 4.5:1.
 */
const black: Theme = {
  bg: '#0b0b0d',
  surface: '#16161b',
  surfaceAlt: '#1f1f26',
  border: '#59534b',
  borderFocus: '#e0b341',
  text: '#f4f1ea',
  userText: '#ffffff',
  userBorder: '#e0b341',
  placeholder: '#8d857a',
  muted: '#b3ada3',
  dim: '#8a8378',
  error: '#ff8080',
  accent: '#e0b341',
  success: '#7ed09a',
  info: '#7fc8ff',
};

export default black;
