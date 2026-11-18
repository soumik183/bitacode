import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { annotateDiff, displayFilePath } from '../utils/file-diff.js';
import { detectLanguage, safeHighlight } from '../utils/code-highlight.js';
import { TokenText } from './CodeBlock.js';
const MAX_VISIBLE_LINES = 24;
function lineColor(line) {
    if (line.kind === 'add')
        return theme.success;
    if (line.kind === 'remove')
        return theme.error;
    if (line.kind === 'context')
        return theme.muted;
    if (line.kind === 'hunk')
        return theme.info;
    return theme.dim;
}
/**
 * Compact, colour-coded unified diff for edit_file/write_file results.
 * Green additions, red removals and file line numbers in a bordered card.
 */
export const DiffView = ({ header, diff, filePath, operation, language: languageOverride, maxRows }) => {
    const lines = annotateDiff(diff);
    const additions = lines.filter((line) => line.kind === 'add').length;
    const removals = lines.filter((line) => line.kind === 'remove').length;
    const visibleLimit = Math.max(1, Math.min(MAX_VISIBLE_LINES, Math.floor(Number.isFinite(maxRows) ? maxRows : MAX_VISIBLE_LINES)));
    const shown = lines.slice(0, visibleLimit);
    const hidden = lines.length - shown.length;
    const language = languageOverride ?? detectLanguage(filePath);
    // Highlight once per diff, not per render. Syntax colours sit on top of the
    // green/red line tint: uncoloured tokens inherit `baseColor` below.
    const tokens = React.useMemo(() => shown.map((line) => safeHighlight(line.text, language)[0] ?? [{ text: line.text }]), [diff, language]);
    const gutter = Math.max(2, ...shown.map((line) => (line.number == null ? 0 : String(line.number).length)));
    const summary = header
        .replace(/^Successfully (edited|wrote) /i, (_, verb) => (verb.toLowerCase() === 'edited' ? 'Edited ' : 'Wrote '))
        .replace(/\.$/, '');
    const path = filePath ? displayFilePath(filePath) : '';
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: theme.border, paddingX: 1, marginY: 1, width: "100%", children: [_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.success, children: "\u2713 " }), _jsx(Text, { color: theme.text, bold: true, children: operation ?? summary }), path && _jsx(Text, { color: theme.muted, children: `  ${path}` }), additions > 0 && _jsx(Text, { color: theme.success, children: `  +${additions}` }), removals > 0 && _jsx(Text, { color: theme.error, children: `  -${removals}` })] }), shown.map((line, index) => {
                const color = lineColor(line);
                if (line.kind === 'hunk') {
                    return (_jsx(Text, { color: color, wrap: "truncate-end", children: `${' '.repeat(gutter)}  ${line.text}` }, index));
                }
                if (line.number == null) {
                    return (_jsx(Text, { color: color, wrap: "truncate-end", children: `${' '.repeat(gutter)}  ${line.text}` }, index));
                }
                const sign = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
                return (_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: color, children: String(line.number).padStart(gutter) }), _jsx(Text, { color: theme.dim, children: '  ' }), _jsx(Text, { color: color, children: `${sign} ` }), _jsx(TokenText, { tokens: tokens[index] ?? [{ text: line.text }], baseColor: color })] }, index));
            }), hidden > 0 && (_jsx(Text, { color: theme.dim, children: `${' '.repeat(gutter)}  … ${hidden} more line${hidden === 1 ? '' : 's'}` }))] }));
};
