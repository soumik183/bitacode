import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { formatDuration } from '../utils/duration.js';
/** Fixed slice used only when no terminal width is known. */
const FALLBACK_PREVIEW_CHARS = 240;
/** How many reasoning lines the collapsed preview keeps before the "more" note. */
const PREVIEW_LINE_BUDGET = 1;
/** Characters that fit on one archive line, allowing for the indent and ellipsis. */
export function archivePreviewChars(columns) {
    if (!columns || columns <= 0)
        return FALLBACK_PREVIEW_CHARS;
    // Never exceed the screen: an old 40-column floor wrapped long thought lines
    // into a dozen rows on narrow/zoomed terminals.
    return Math.max(1, Math.floor(columns) - 6);
}
/**
 * Record of a completed reasoning phase. The collapsed view keeps the first
 * few lines of thought intact — one line per row — instead of flattening them
 * into a single unreadable string. Clicking expands every line in place.
 */
export const ThinkingArchive = ({ text, elapsedMs, columns, expanded = false, }) => {
    const theme = useTheme();
    const reasoning = text.trim();
    if (!reasoning)
        return null;
    // Keep the original line structure: no `/\s+/g` flattening.
    const lines = reasoning.split('\n').map((line) => line.trimEnd());
    const lineCap = archivePreviewChars(columns);
    const shownLines = expanded ? lines : lines.slice(0, PREVIEW_LINE_BUDGET);
    const hiddenLines = lines.length - shownLines.length;
    return (_jsxs(Box, { flexDirection: "column", paddingX: 2, marginBottom: 1, children: [_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.muted, children: expanded ? '▾ ' : '▸ ' }), _jsx(Text, { color: theme.muted, children: "Thought" }), _jsx(Text, { color: theme.dim, children: `  ${formatDuration(elapsedMs)} · ${reasoning.length} char${reasoning.length === 1 ? '' : 's'}` })] }), shownLines.map((line, index) => {
                // Bound each collapsed line to one row so the card can't grow the frame.
                // Expanded keeps every line verbatim; only the collapsed preview clips.
                const clipped = !expanded && line.length > lineCap
                    ? `${line.slice(0, lineCap).trimEnd()}…`
                    : line;
                return (_jsx(Text, { color: theme.muted, wrap: expanded ? 'wrap' : 'truncate-end', children: clipped || ' ' }, index));
            }), hiddenLines > 0 && (_jsx(Text, { color: theme.dim, children: `… ${hiddenLines} more line${hiddenLines === 1 ? '' : 's'} · click to expand` }))] }));
};
