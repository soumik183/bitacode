import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { formatDuration } from '../utils/duration.js';
/**
 * Clip reasoning so it occupies at most `maxRows` wrapped rows.
 * The character cap alone is not enough: many short lines can still overflow
 * the budget and blow out the layout, so rows are the real unit of measure.
 */
export function clipToPreview(text, width, maxRows, maxChars) {
    const preview = text.trim();
    const charsLimited = preview.length > maxChars ? preview.slice(0, maxChars) : preview;
    const lines = charsLimited.split('\n');
    const kept = [];
    let rowsUsed = 0;
    for (const line of lines) {
        const lineRows = Math.max(1, Math.ceil(Math.max(1, line.length) / width));
        if (rowsUsed + lineRows > maxRows) {
            // Use whatever space is left on the current row for a partial line.
            const remaining = maxRows - rowsUsed;
            if (remaining > 0) {
                const capacity = remaining * width;
                kept.push(line.slice(0, capacity));
                rowsUsed += remaining;
            }
            break;
        }
        kept.push(line);
        rowsUsed += lineRows;
    }
    const shown = kept.join('\n');
    return { shown, hiddenChars: preview.length - shown.length };
}
/** Character cap for a single expanded reasoning preview. */
const THINKING_MAX_CHARS = 4000;
/** Content rows (preview + optional hidden-chars footer) for a given terminal height. */
export function thinkingContentRows(rows) {
    const value = Number.isFinite(rows) ? Math.floor(rows) : 24;
    // header + marginTop + footer + marginBottom stay outside the content budget.
    return Math.max(1, value - 4);
}
/**
 * The exact clip both the renderer and the height estimator use. When anything
 * is hidden, one row of the budget is reserved for the "more chars" footer.
 */
export function clipThinkingForRows(text, width, rows) {
    const budget = thinkingContentRows(rows);
    const full = clipToPreview(text, width, budget, THINKING_MAX_CHARS);
    if (full.hiddenChars <= 0)
        return full;
    const fit = clipToPreview(text, width, Math.max(1, budget - 1), THINKING_MAX_CHARS);
    return { shown: fit.shown, hiddenChars: full.hiddenChars };
}
/** Wrapped rows the clipped preview actually paints (same rule as clipToPreview). */
function clippedRows(shown, width) {
    return shown.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(Math.max(1, line.length) / Math.max(1, width))), 0);
}
/**
 * Upper bound on the rows the thinking block occupies, including its bottom
 * margin. Used by App to size the live area and to hit-test clicks.
 * Wrapped rows cannot be known exactly before layout, so this estimate is
 * deliberately conservative; App refines it with a real measurement.
 */
export function thinkingBlockHeight(text, expanded, columns, rows) {
    const hasText = text.trim().length > 0;
    // The component renders nothing at all without reasoning text.
    if (!hasText)
        return 0;
    const width = Math.max(1, columns - 6);
    // Collapsed: header + one truncated preview line + bottom margin.
    if (!expanded)
        return 3;
    // Expanded: count exactly what the clipped render paints (plus its footer).
    const clip = clipThinkingForRows(text.trim(), width, rows);
    const contentRows = Math.max(1, clippedRows(clip.shown, width)) + (clip.hiddenChars > 0 ? 1 : 0);
    // header + marginTop(1) + content + marginBottom(1)
    return 1 + 1 + contentRows + 1;
}
/**
 * Live reasoning preview.
 *
 * While the model is thinking the block is expanded automatically so the
 * reasoning streams in visibly, with animated dots on the header. Once
 * thinking ends it collapses to a plain "Thought · 3s" line (no animation).
 * A left click on the header (or ctrl+t) toggles it.
 */
export const ThinkingBlock = ({ text, expanded, active, animate, frame, columns, rows, elapsedMs = 0, }) => {
    const theme = useTheme();
    const hasText = text.trim().length > 0;
    // No provider reasoning means nothing to show. Rendering an empty header
    // here would claim the model is thinking when it sent no reasoning at all.
    if (!hasText)
        return null;
    const dots = active ? (animate ? '.'.repeat((frame % 3) + 1).padEnd(3) : '...') : '';
    const label = active ? 'Thinking' : 'Thought';
    const contentWidth = Math.max(1, columns - 6);
    const lines = text.trim().split('\n');
    const firstLine = lines[0] ?? '';
    const shownFirst = firstLine.length > contentWidth
        ? `${firstLine.slice(0, Math.max(1, contentWidth - 1))}…`
        : firstLine;
    // Expanded reasoning must fit the same budget the host reserves via
    // thinkingBlockHeight; the old full-text render silently overflowed it.
    const clipped = expanded ? clipThinkingForRows(text.trim(), contentWidth, rows) : null;
    const hint = hasText
        ? `${expanded ? 'click to collapse' : 'click to expand'} · ctrl+t`
        : '';
    return (_jsxs(Box, { flexDirection: "column", paddingX: 2, marginBottom: 1, children: [_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: expanded ? theme.muted : theme.dim, children: expanded ? '▾ ' : '▸ ' }), _jsx(Text, { color: active ? theme.text : theme.muted, bold: active, children: label }), active && _jsx(Text, { color: theme.accent, children: dots }), elapsedMs > 0 && _jsx(Text, { color: theme.dim, children: ` · ${formatDuration(elapsedMs)}` }), hint && _jsx(Text, { color: theme.dim, children: `  ${hint}` })] }), !expanded && hasText && (_jsx(Box, { paddingLeft: 2, children: _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: shownFirst }) })), expanded && hasText && clipped && (_jsx(Box, { paddingLeft: 2, marginTop: 1, children: _jsx(Text, { color: theme.muted, wrap: "wrap", children: clipped.shown }) })), expanded && hasText && clipped && clipped.hiddenChars > 0 && (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `  … ${clipped.hiddenChars} more chars` }))] }));
};
