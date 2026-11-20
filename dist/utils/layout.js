/**
 * Responsive layout rules.
 *
 * Terminals range from a phone-sized split (40x15) to a wide desktop
 * (200x60). Rather than a pile of inline `Math.min` calls scattered through
 * App, the breakpoints live here so they stay consistent and testable.
 */
/**
 * Turn a terminal dimension into a finite positive integer. A resize burst can
 * briefly report 0/undefined/NaN (especially under zoom); letting those through
 * would poison every downstream width/height with NaN and tear the frame.
 */
export function finiteDim(value, fallback) {
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}
export function resolveLayout(columns, rows) {
    const cols = finiteDim(columns, 1);
    const lines = finiteDim(rows, 1);
    const size = cols < 60 || lines < 20 ? 'compact' : cols < 100 ? 'regular' : 'wide';
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
        dense: lines < 10,
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
export function frameRows(terminalRows) {
    const rows = finiteDim(terminalRows, 1);
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
export function composerTextWidth(inputWidth, showSubmitHint) {
    return finiteDim(Math.floor(inputWidth) - 5 - (showSubmitHint ? 2 : 0), 1);
}
/**
 * Clamp a selection index into a list that may have just shrunk (for example
 * after deleting a session). Returns 0 for an empty list.
 */
export function clampIndex(index, length) {
    if (!Number.isFinite(index))
        return 0;
    return Math.max(0, Math.min(Math.floor(index), Math.max(0, length - 1)));
}
/**
 * Rows the composer card occupies: one text row plus its vertical padding.
 * Kept here so the layout budget and the rendered card can never disagree —
 * the old fixed `5` under-counted the padded card by a row, which is what
 * pushed the live area onto the input on short terminals.
 */
export function composerBlockRows(textRows, dense) {
    return finiteDim(textRows, 1) + (dense ? 0 : 2);
}
/** Rows the status footer occupies: one line plus its bottom margin. */
export function footerBlockRows(dense) {
    return dense ? 1 : 2;
}
/**
 * Total fixed chrome below the transcript: composer card, activity strip,
 * footer and the single breathing gap above the composer.
 */
export function fixedChromeRows(options = {}) {
    const dense = options.dense ?? false;
    return (composerBlockRows(options.composerRows ?? 1, dense)
        + finiteDim(options.status ?? 0, 0)
        + footerBlockRows(dense)
        + 1);
}
/**
 * Split the frame between the scrolling transcript and the fixed live area.
 *
 * The transcript gets whatever is left after the live panels and the fixed
 * chrome (rule, composer card, footer, gaps). It is recomputed on every render
 * so the split follows todos appearing and disappearing automatically, and it
 * is clamped so the transcript is never squeezed away entirely.
 */
export function splitLiveArea(frameHeight, chrome) {
    const h = finiteDim(frameHeight, 1);
    const dense = chrome.dense ?? false;
    const status = Math.max(0, finiteDim(chrome.status, 0));
    // The composer card is budgeted with its real padding. The activity strip is
    // counted in `live` below, not here, so it is never double-counted.
    const fixed = fixedChromeRows({ composerRows: 1, status: 0, dense });
    const panelSum = finiteDim(chrome.todos, 0) +
        finiteDim(chrome.thinking, 0) +
        finiteDim(chrome.help, 0) +
        finiteDim(chrome.streaming, 0);
    // A multi-line composer grows downward, so its extra rows come out of the
    // transcript budget instead of being clipped by it. One transcript row is
    // always kept, and the live column never claims more than it can have.
    const maxLive = Math.max(0, h - fixed - 1);
    const growthBudget = Math.max(0, maxLive - panelSum - status);
    const composerGrowth = Math.min(Math.max(0, finiteDim(chrome.composer, 0)), growthBudget);
    const live = Math.min(maxLive, Math.max(0, panelSum) + status + composerGrowth);
    const transcriptRows = Math.max(1, h - fixed - live);
    return { transcriptRows, liveRows: live };
}
/**
 * Blank rows needed to make the transcript a solid block of exactly
 * `viewportRows`.
 *
 * The window is sliced from measured rows, and measurement can lag by a frame
 * (a card just archived, a resize, a fold). When the slice is shorter than the
 * viewport, the difference used to be left unpainted, so rows from the previous
 * frame could survive underneath the transcript and appear below the composer.
 * Padding the region removes that class of glitch entirely.
 */
export function transcriptFillerRows(viewportRows, usedRows) {
    const viewport = Math.max(0, Math.floor(Number.isFinite(viewportRows) ? viewportRows : 0));
    const used = Math.max(0, Math.floor(Number.isFinite(usedRows) ? usedRows : 0));
    return Math.max(0, viewport - used);
}
