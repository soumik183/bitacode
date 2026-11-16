import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { formatDuration } from '../utils/duration.js';
/** Fixed slice used only when no terminal width is known. */
const FALLBACK_PREVIEW_CHARS = 240;
/** Characters that fit on one archive line, allowing for the indent and ellipsis. */
export function archivePreviewChars(columns) {
    if (!columns || columns <= 0)
        return FALLBACK_PREVIEW_CHARS;
    return Math.max(40, columns - 6);
}
/**
 * Record of a completed reasoning phase. Collapsed it keeps one preview line;
 * clicking it expands the full reasoning in place, and clicking again folds it
 * back.
 */
export const ThinkingArchive = ({ text, elapsedMs, columns, expanded = false, }) => {
    const reasoning = text.trim();
    if (!reasoning)
        return null;
    const singleLine = reasoning.replace(/\s+/g, ' ');
    const limit = archivePreviewChars(columns);
    const preview = singleLine.length > limit ? singleLine.slice(0, limit).trimEnd() : singleLine;
    const cutoff = singleLine.length > limit;
    const hint = expanded ? 'click to collapse' : 'click to expand';
    return (_jsxs(Box, { flexDirection: "column", paddingX: 2, marginBottom: 1, children: [_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.muted, children: expanded ? '▾ ' : '▸ ' }), _jsx(Text, { color: theme.muted, children: "Thought" }), _jsx(Text, { color: theme.dim, children: `  ${formatDuration(elapsedMs)} · ${reasoning.length} char${reasoning.length === 1 ? '' : 's'}` }), _jsx(Text, { color: theme.dim, children: `  ${hint}` })] }), expanded ? (_jsx(Text, { color: theme.muted, wrap: "wrap", children: reasoning })) : (_jsxs(Text, { color: theme.dim, wrap: "truncate-end", children: [preview, cutoff ? '…' : ''] }))] }));
};
