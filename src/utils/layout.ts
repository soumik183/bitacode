/**
 * Responsive layout rules.
 *
 * Terminals range from a phone-sized split (40x15) to a wide desktop
 * (200x60). Rather than a pile of inline `Math.min` calls scattered through
 * App, the breakpoints live here so they stay consistent and testable.
 */

export type LayoutSize = 'compact' | 'regular' | 'wide';

export interface Layout {
  size: LayoutSize;
  /** Composer width, clamped so it never touches the screen edges. */
  inputWidth: number;
  /** Rows a palette/picker may use before it starts scrolling. */
  paletteWindow: number;
  /** Todo rows allowed before the panel windows around the active task. */
  visibleTodos: number;
  /** Horizontal inset for transcript and panels. */
  gutter: number;
  /** Whether the footer can show the full model · variant · ctx cluster. */
  showFullFooter: boolean;
  /** Whether the composer shows the ↵ hint on the right. */
  showSubmitHint: boolean;
}

export function resolveLayout(columns: number, rows: number): Layout {
  const cols = Math.max(1, Math.floor(columns));
  const lines = Math.max(1, Math.floor(rows));

  const size: LayoutSize = cols < 60 || lines < 20 ? 'compact' : cols < 100 ? 'regular' : 'wide';

  // Gutter shrinks on narrow screens so text keeps usable width.
  const gutter = size === 'compact' ? 1 : 2;

  // Composer: full width minus a breathing margin, with a sane cap so it does
  // not stretch absurdly on ultrawide terminals.
  const inputMax = size === 'wide' ? 110 : size === 'regular' ? 96 : cols - 2 * gutter;
  const available = Math.max(1, cols - 2 * gutter);
  // Never wider than the screen: a tiny terminal cannot afford the old 16-col floor.
  const inputWidth = Math.max(1, Math.min(available, inputMax));

  // Pickers must always leave room for the composer and footer.
  const paletteWindow = Math.max(3, Math.min(size === 'compact' ? 4 : 7, lines - 12));

  // Todo panel must never eat the whole screen; keep at least 4 rows of
  // transcript and the composer visible.
  const todoBudget = Math.max(1, lines - 14);
  const visibleTodos = Math.max(1, Math.min(size === 'compact' ? 3 : 5, todoBudget));

  return {
    size,
    inputWidth,
    paletteWindow,
    visibleTodos,
    gutter,
    showFullFooter: cols >= 72,
    showSubmitHint: cols >= 40,
  };
}

/**
 * Rows the root frame should occupy.
 *
 * Ink repaints the whole screen (a visible flash) whenever the committed
 * output reaches the terminal height: `ink.js` checks
 * `lastOutputHeight >= stdout.rows` and emits `clearTerminal`. Staying one row
 * below that threshold keeps every update on the incremental diff path, which
 * is what makes scrolling and streaming stable instead of blinking.
 */
export function frameRows(terminalRows: number): number {
  const rows = Math.max(1, Math.floor(terminalRows));
  // Stay below the terminal height even on tiny screens, otherwise Ink takes
  // its full-screen erase path and the frame blinks on every update.
  return rows > 1 ? rows - 1 : 1;
}

/**
 * Columns available to the composer text itself.
 *
 * The outer composer reserves 1 (left padding) + 2 (accent bar) + 2 (inner
 * right padding) columns, plus 2 more for the ↵ hint when it is shown.
 */
export function composerTextWidth(inputWidth: number, showSubmitHint: boolean): number {
  return Math.max(1, Math.floor(inputWidth) - 5 - (showSubmitHint ? 2 : 0));
}

/**
 * Clamp a selection index into a list that may have just shrunk (for example
 * after deleting a session). Returns 0 for an empty list.
 */
export function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(Math.floor(index), Math.max(0, length - 1)));
}

export interface ChromeHeights {
  /** Rows used by the todo panel (0 when there are no todos). */
  todos: number;
  /** Rows used by the thinking block (0 when absent). */
  thinking: number;
  /** Rows used by the inline help block. */
  help: number;
  /** Rows used by the streaming preview (0 when not streaming). */
  streaming: number;
}

/**
 * Split the frame between the scrolling transcript and the fixed live area.
 *
 * The transcript gets whatever is left after the live panels and the fixed
 * chrome (rule, composer card, footer, gaps). It is recomputed on every render
 * so the split follows todos appearing and disappearing automatically, and it
 * is clamped so the transcript is never squeezed away entirely.
 */
export function splitLiveArea(frameHeight: number, chrome: ChromeHeights): {
  transcriptRows: number;
  liveRows: number;
} {
  const fixed = 5; // composer (2) + footer (2) + gap above it
  const live = Math.max(0, chrome.todos + chrome.thinking + chrome.help + chrome.streaming);
  const transcriptRows = Math.max(1, frameHeight - fixed - live);
  return { transcriptRows, liveRows: live };
}
