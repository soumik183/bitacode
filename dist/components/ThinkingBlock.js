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
/**
 * Upper bound on the rows the thinking block occupies, including its bottom
 * margin. Used by App to size the live area and to hit-test clicks.
 * Wrapped rows cannot be known exactly before layout, so this estimate is
 * deliberately conservative; App refines it with a real measurement.
 */
export function thinkingBlockHeight(text, expanded, columns, _rows) {
    const hasText = text.trim().length > 0;
    // The component renders nothing at all without reasoning text.
    if (!hasText)
        return 0;
    const width = Math.max(1, columns - 6);
    // Collapsed: header + the first reasoning line + bottom margin.
    if (!expanded) {
        const first = text.trim().split('\n')[0] ?? '';
        const firstRows = Math.max(1, Math.ceil(Math.max(1, first.length) / width));
        return 1 + firstRows + 1;
    }
    // Expanded: every line is shown, so count all wrapped rows.
    const contentRows = text.trim().split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(Math.max(1, line.length) / width)), 0);
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
export const ThinkingBlock = ({ text, expanded, active, animate, frame, columns, rows: _rows, elapsedMs = 0, }) => {
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
    const hint = hasText
        ? `${expanded ? 'click to collapse' : 'click to expand'} · ctrl+t`
        : '';
    return (_jsxs(Box, { flexDirection: "column", paddingX: 2, marginBottom: 1, children: [_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: expanded ? theme.muted : theme.dim, children: expanded ? '▾ ' : '▸ ' }), _jsx(Text, { color: active ? theme.text : theme.muted, bold: active, children: label }), active && _jsx(Text, { color: theme.accent, children: dots }), elapsedMs > 0 && _jsx(Text, { color: theme.dim, children: ` · ${formatDuration(elapsedMs)}` }), hint && _jsx(Text, { color: theme.dim, children: `  ${hint}` })] }), !expanded && hasText && (_jsx(Box, { paddingLeft: 2, children: _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: shownFirst }) })), expanded && hasText && (_jsx(Box, { paddingLeft: 2, marginTop: 1, children: _jsx(Text, { color: theme.muted, wrap: "wrap", children: text.trim() }) }))] }));
};
