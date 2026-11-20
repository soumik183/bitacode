import type { Theme } from '../types.js';

/**
 * Moss — a dark forest palette for long, quiet work.
 *
 * Green lowers perceived brightness and reads as "steady" rather than urgent;
 * a soft olive-lime accent keeps the interface warm, and teal/rose carry
 * success and failure so they never look like the accent itself.
 */
const moss: Theme = {
  bg: '#0c1310',
  surface: '#15201a',
  surfaceAlt: '#1c2a22',
  border: '#4a6152',
  borderFocus: '#b6d97c',
  text: '#eaf3ec',
  userText: '#ffffff',
  userBorder: '#b6d97c',
  placeholder: '#8d9c90',
  muted: '#b6c4b8',
  dim: '#8b998f',
  error: '#ff9a9a',
  accent: '#b6d97c',
  success: '#4fd6b0',
  info: '#7ecbff',
};

export default moss;
