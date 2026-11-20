import type { Theme } from '../types.js';

/**
 * High contrast — accessibility first.
 *
 * Pure black canvas, pure white ink and saturated status colours for low-vision
 * use, bright sunlight and screen readers that rely on hard edges.
 */
const highContrast: Theme = {
  bg: '#000000',
  surface: '#000000',
  surfaceAlt: '#0a0a0a',
  border: '#ffffff',
  borderFocus: '#ffff00',
  text: '#ffffff',
  userText: '#00ffff',
  userBorder: '#ffff00',
  placeholder: '#c8c8c8',
  muted: '#ffffff',
  dim: '#d0d0d0',
  error: '#ff5555',
  accent: '#00ffff',
  success: '#00ff00',
  info: '#ffd400',
};

export default highContrast;
