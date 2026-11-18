/**
 * Transcript scroll arithmetic.
 *
 * `userScroll` counts rows above the bottom of the visible viewport:
 * 0 means pinned to the newest output. Keeping the maths in one place makes
 * the clamp behaviour testable and keeps the render, the wheel handler and the
 * keyboard handler from drifting apart.
 */
/** Largest scroll offset that still shows content, given the last measurement. */
export function maxScrollOffset(transcriptRows, viewportRows) {
    return Math.max(0, transcriptRows - Math.max(0, viewportRows));
}
/** Clamp a requested offset into the valid range. */
export function clampScroll(offset, maxOffset) {
    // NaN has no meaningful clamp target; ±Infinity must land on the far edge
    // (Math.round preserves infinities, so the min/max below clamps them).
    if (Number.isNaN(offset))
        return 0;
    return Math.max(0, Math.min(Math.round(offset), Math.max(0, maxOffset)));
}
/** Offset to hand to `marginTop`, rendered as a negative value. */
export function scrollMarginTop(offset, maxOffset) {
    const hidden = maxOffset - clampScroll(offset, maxOffset);
    // `-0` renders the same as `0` but breaks strict comparisons downstream.
    return hidden > 0 ? -hidden : 0;
}
/**
 * Where the view should sit after the transcript grew or shrank by `delta`
 * rows. A user parked at the bottom (offset 0) stays pinned there so new
 * output is always visible; anyone scrolled up keeps the same content on
 * screen instead of being dragged along.
 */
export function scrollAfterGrowth(offset, delta, maxOffset) {
    if (offset <= 0)
        return 0;
    return clampScroll(offset + delta, maxOffset);
}
/**
 * Visible slice of the transcript.
 *
 * Ink's negative `marginTop` does not scroll predictably: it over-scrolls and
 * snaps, so the view lags or skips rows. Rendering only the visible window
 * from measured row heights is exact at every offset.
 *
 * `offset` counts rows scrolled up from the bottom (0 = newest row visible).
 * Returns the first/last visible row indexes; `first` is inclusive and `last`
 * is exclusive.
 */
export function visibleRowWindow(transcriptRows, viewportRows, offset) {
    const total = Math.max(0, Math.floor(transcriptRows));
    const height = Math.max(0, Math.floor(viewportRows));
    const maxOffset = maxScrollOffset(total, height);
    const clamped = clampScroll(offset, maxOffset);
    const last = Math.max(0, total - clamped);
    const first = Math.max(0, last - height);
    return {
        first,
        last,
        hiddenAbove: first,
        hiddenBelow: Math.max(0, total - last),
    };
}
/**
 * Map the visible row window onto a list of measured items, returning the
 * items that intersect it plus the row offset to trim from the first item.
 * One tall item (a diff, a long reply) can span the whole viewport, so it can
 * be only partially visible. `trimTop` is the count of that item's top rows to
 * HIDE — the renderer must pull the item UP by `trimTop` (negative margin) so
 * those rows are clipped. A positive-height spacer instead pushes the item
 * down and paints blank rows, which is what breaks scrolling into tall items.
 */
export function sliceItemsToWindow(items, first, last) {
    const out = [];
    let cursor = 0;
    let trimTop = 0;
    for (const item of items) {
        const itemEnd = cursor + Math.max(0, item.rows);
        if (itemEnd <= first) {
            cursor = itemEnd;
            continue;
        }
        if (cursor >= last)
            break;
        if (out.length === 0) {
            trimTop = Math.max(0, first - cursor);
        }
        out.push(item);
        cursor = itemEnd;
    }
    return { items: out, trimTop };
}
