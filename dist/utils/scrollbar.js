/**
 * Scrollbar geometry for the transcript viewport.
 *
 * The transcript is taller than the viewport, so only part of it is visible.
 * A one-column rail on the right edge shows where the visible window sits.
 * All the arithmetic lives here so it can be tested without a terminal.
 */
export const SCROLLBAR_TRACK = '│';
export const SCROLLBAR_THUMB = '┃';
/**
 * Compute thumb size and position.
 *
 * `offset` counts rows scrolled up from the bottom (0 = pinned to newest),
 * matching the App's `userScroll`. The thumb is proportional to how much of
 * the transcript is visible, and its position runs top (oldest) → bottom
 * (newest) as the offset decreases.
 */
export function scrollbarGeometry(transcriptRows, viewportRows, offset) {
    const height = Math.max(0, Math.floor(viewportRows));
    const total = Math.max(0, Math.floor(transcriptRows));
    // Nothing to scroll: no rail at all, so the layout stays clean.
    if (height <= 1 || total <= height)
        return null;
    const ratio = height / total;
    const thumb = Math.max(1, Math.min(height, Math.round(height * ratio)));
    const travel = height - thumb;
    const maxOffset = total - height;
    const clampedOffset = Math.max(0, Math.min(offset, maxOffset));
    // offset 0 (bottom) -> thumb at the bottom; maxOffset (top) -> thumb at top.
    const fromTop = maxOffset === 0 ? 0 : (maxOffset - clampedOffset) / maxOffset;
    const start = Math.round(fromTop * travel);
    return { height, thumb, start };
}
/** Render the rail as `height` lines of track, with the thumb overlaid. */
export function scrollbarLines(geometry) {
    if (!geometry)
        return [];
    const { height, thumb, start } = geometry;
    const lines = [];
    for (let row = 0; row < height; row++) {
        lines.push(row >= start && row < start + thumb ? SCROLLBAR_THUMB : SCROLLBAR_TRACK);
    }
    return lines;
}
