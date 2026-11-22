import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { annotateDiff, displayFilePath } from '../utils/file-diff.js';
/** Safety ceiling for a collapsed diff; kept as the public export for callers. */
export const DIFF_PREVIEW_LINES = 2000;
/** @deprecated Expansion now shows the whole diff; kept for API compatibility. */
export const DIFF_EXPANDED_MAX_LINES = DIFF_PREVIEW_LINES;
function lineColor(kind, palette) {
    if (kind === 'add')
        return palette.success;
    if (kind === 'remove')
        return palette.error;
    if (kind === 'context')
        return palette.text;
    if (kind === 'hunk')
        return palette.info;
    return palette.dim;
}
function gutterNumbers(kind, number, gutter) {
    const blank = ' '.repeat(gutter);
    const value = number == null ? '' : String(number).padStart(gutter);
    if (kind === 'add')
        return { old: blank, next: value };
    if (kind === 'remove')
        return { old: value, next: blank };
    if (kind === 'context')
        return { old: value, next: value };
    return { old: blank, next: blank };
}
const signFor = (kind) => kind === 'add' ? '+' : kind === 'remove' ? '-' : ' ';
/**
 * Professional unified-diff card: two line-number gutters, a continuous side
 * rule, and one flat colour per row (red removals, green additions). All lines
 * render by default; only a generous ceiling clips an unusually large patch.
 */
export const DiffView = ({ header, diff, filePath, operation, maxRows, expanded = false, entries, }) => {
    const theme = useTheme();
    const files = React.useMemo(() => {
        const source = entries && entries.length > 0
            ? entries.map((entry) => ({
                label: entry.filePath ? displayFilePath(entry.filePath) : entry.header,
                lines: annotateDiff(entry.diff),
            }))
            : [{ label: filePath ? displayFilePath(filePath) : '', lines: annotateDiff(diff) }];
        return source;
    }, [entries, diff, filePath]);
    const allLines = files.flatMap((file) => file.lines);
    const additions = allLines.filter((line) => line.kind === 'add').length;
    const removals = allLines.filter((line) => line.kind === 'remove').length;
    const totalLines = allLines.length;
    // Gutter width comes from every line, never just the visible slice, so the
    // layout cannot shift when the card is toggled.
    const gutter = Math.max(2, ...allLines.map((line) => String(line.number ?? 0).length));
    const blank = ' '.repeat(gutter);
    const limit = Number.isFinite(maxRows)
        ? Math.max(0, Math.floor(maxRows))
        : expanded
            ? Infinity
            : DIFF_PREVIEW_LINES;
    let remaining = limit;
    const renderedFiles = files.map((file) => {
        const visible = file.lines.slice(0, Math.max(0, remaining));
        remaining -= visible.length;
        return { ...file, visible };
    });
    const shownCount = renderedFiles.reduce((total, file) => total + file.visible.length, 0);
    const hidden = Math.max(0, totalLines - shownCount);
    const toggleAvailable = maxRows == null && totalLines > DIFF_PREVIEW_LINES;
    const title = header
        .replace(/^Successfully\s+(edited|wrote)\b/i, (_, verb) => verb.charAt(0).toUpperCase() + verb.slice(1).toLowerCase())
        .replace(/^Applied\s+patch\s+to\b/i, 'Applied')
        .replace(/\.$/, '') || operation || 'Diff';
    const paths = files.length > 1
        ? entries
            .map((entry) => entry.filePath && displayFilePath(entry.filePath))
            .filter((path) => Boolean(path))
            .join(', ')
        : filePath
            ? displayFilePath(filePath)
            : '';
    const showPaths = paths && !title.includes(paths);
    // One row = `[old#] [new#] │ [sign] [content]`. Every row uses the same
    // columns, including hunk/meta/per-file/footer rows, so the side rule is
    // unbroken and the gutters stay aligned.
    const row = (key, oldNum, newNum, sign, color, content) => (_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.dim, children: oldNum }), _jsx(Text, { color: theme.dim, children: ' ' }), _jsx(Text, { color: theme.dim, children: newNum }), _jsx(Text, { color: theme.border, children: ' │ ' }), _jsx(Text, { color: color, children: sign }), _jsx(Text, { color: color, children: ' ' }), _jsx(Text, { color: color, children: content })] }, key));
    let key = 0;
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: theme.border, paddingX: 1, marginY: 1, width: "100%", overflow: "hidden", children: [_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.success, children: "\u2713 " }), _jsx(Text, { color: theme.text, bold: true, children: title }), showPaths && _jsx(Text, { color: theme.muted, children: `  ${paths}` }), additions > 0 && _jsx(Text, { color: theme.success, children: `  +${additions}` }), removals > 0 && _jsx(Text, { color: theme.error, children: `  -${removals}` }), expanded && toggleAvailable && _jsx(Text, { color: theme.dim, children: '  click to collapse' })] }), totalLines === 0 && row('empty', blank, blank, ' ', theme.dim, 'No textual changes.'), renderedFiles.map((file, fileIndex) => (_jsxs(React.Fragment, { children: [files.length > 1 && row(`file-${fileIndex}`, blank, blank, ' ', theme.info, `▸ ${file.label}`), file.visible.map((diffLine) => {
                        const numbers = gutterNumbers(diffLine.kind, diffLine.number, gutter);
                        return row(`line-${key++}`, numbers.old, numbers.next, signFor(diffLine.kind), lineColor(diffLine.kind, theme), diffLine.text);
                    })] }, fileIndex))), hidden > 0 && row('truncated', blank, blank, ' ', theme.dim, `… ${hidden} more line${hidden === 1 ? '' : 's'} (diff truncated)${!expanded && toggleAvailable ? ' · click to expand' : ''}`)] }));
};
