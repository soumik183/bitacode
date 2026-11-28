/**
 * Post-exit update card.
 *
 * Printed straight to stdout after Ink unmounts, like the session card: the
 * running process is still the old build, so once npm has installed the new
 * version the honest thing to do is close the UI and say so. Kept pure (no
 * stdout access) so the exact bytes can be tested.
 */

import type { Theme } from '../theme.js';

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function rgb(hex: string): string {
  const value = hex.replace('#', '');
  const n = Number.parseInt(value, 16);
  if (!Number.isFinite(n) || value.length !== 6) return '';
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

/** Letter-spaced display type, matching the session card's treatment. */
const BANNER = 'U P D A T E   I N S T A L L E D';

function clean(value: string): string {
  return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
}

export type UpdateExitScope = 'global' | 'local';

export interface UpdateExitInfo {
  from: string;
  to: string;
  scope: UpdateExitScope;
}

/**
 * The card shown after a successful update. `from` may be empty (or equal to
 * `to`) when the previous version is unknown; the line then just states the
 * installed version.
 */
export function formatUpdateExit(info: UpdateExitInfo, palette: Theme): string {
  const from = clean(info.from);
  const to = clean(info.to);
  if (!to) return '';

  const rule = '─'.repeat(Math.max(24, Math.min(72, BANNER.length + 6)));
  const accent = rgb(palette.accent);
  const border = rgb(palette.border);
  const text = rgb(palette.text);
  const dim = rgb(palette.dim);
  const success = rgb(palette.success);

  const version = from && from !== to
    ? `${dim}v${from}${RESET} ${border}→${RESET} ${text}${BOLD}v${to}${RESET}`
    : `${text}${BOLD}v${to}${RESET}`;
  const runningNote = from && from !== to
    ? `This running session still has v${from}.`
    : 'This running session still has the old build.';

  return [
    '',
    `  ${accent}${BOLD}${BANNER}${RESET}`,
    `  ${border}${rule}${RESET}`,
    `  ${dim}Installed${RESET} ${version} ${dim}(${info.scope})${RESET}`,
    '',
    `  ${success}${BOLD}Reopen bitacode to use v${to}.${RESET}`,
    `  ${dim}${runningNote}${RESET}`,
    '',
    `  ${border}${rule}${RESET}`,
    '',
  ].join('\n');
}
