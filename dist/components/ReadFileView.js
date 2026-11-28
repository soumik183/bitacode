import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { displayFilePath } from '../utils/file-diff.js';
import { detectLanguage, safeHighlight } from '../utils/code-highlight.js';
import { TokenText } from './CodeBlock.js';
/** Lines shown by a collapsed read card. */
export const READ_PREVIEW_LINES = 10;
const DEFAULT_MAX_LINES = READ_PREVIEW_LINES;
/** Ceiling for an expanded read card, so one big file cannot own the screen. */
export const READ_EXPANDED_MAX_LINES = 200;
/**
 * Bordered preview for read_file results.
 *
 * The card shows a bounded slice of the file with real line numbers instead of
 * dumping it into the transcript. When the slice is partial the header says how
 * many lines exist and the footer offers the click-to-expand affordance, so the
 * card's height is always explained by what it prints.
 */
export const ReadFileView = ({ filePath, sections, maxLines, language: languageOverride, expanded = false, }) => {
    const theme = useTheme();
    const limit = Math.max(1, expanded ? READ_EXPANDED_MAX_LINES : maxLines ?? DEFAULT_MAX_LINES);
    const totalLines = sections.reduce((total, section) => total + section.lines.length, 0);
    let budget = limit;
    const rendered = sections.map((section) => {
        const visible = section.lines.slice(0, Math.max(0, budget));
        budget -= visible.length;
        return { ...section, visible };
    });
    const hidden = Math.max(0, totalLines - Math.min(totalLines, limit));
    const lastNumber = rendered.reduce((max, section) => Math.max(max, section.startLine + section.visible.length), 1);
    const firstNumber = sections[0]?.startLine ?? 1;
    const gutter = Math.max(2, String(lastNumber).length);
    const path = filePath ? displayFilePath(filePath) : 'file';
    const showSectionHeaders = sections.length > 1;
    const language = languageOverride ?? detectLanguage(filePath);
    const codeText = rendered.flatMap((section) => section.visible).join('\n');
    const rows = React.useMemo(() => safeHighlight(codeText, language, { palette: theme }), [codeText, language, theme]);
    let row = 0;
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: theme.border, paddingX: 1, marginY: 1, width: "100%", children: [_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", overflow: "hidden", children: [_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.info, children: "\u25A4 " }), _jsx(Text, { color: theme.text, bold: true, children: "Read" }), _jsx(Text, { color: theme.muted, children: `  ${path}` })] }), _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: totalLines === 0
                            ? 'empty'
                            : `lines ${firstNumber}–${Math.max(firstNumber, lastNumber - 1)} · ${totalLines} total` })] }), totalLines === 0 && sections.every((section) => !section.note) && (_jsx(Text, { color: theme.dim, children: '  (empty file)' })), rendered.map((section, sectionIndex) => (_jsxs(React.Fragment, { children: [showSectionHeaders && (_jsxs(Text, { color: theme.info, children: ['  ', `[lines ${section.startLine}-${section.endLine}]`] })), section.visible.map((line, index) => {
                        const tokens = rows[row++] ?? [{ text: line }];
                        return (_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.dim, children: String(section.startLine + index).padStart(gutter) }), _jsx(Text, { color: theme.border, children: '  │ ' }), _jsx(TokenText, { tokens: tokens, baseColor: theme.muted })] }, index));
                    }), section.note && (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `${' '.repeat(gutter)}  ${section.note}` }))] }, sectionIndex))), hidden > 0 ? (_jsxs(Text, { color: theme.dim, wrap: "truncate-end", children: [`${' '.repeat(gutter)}  … ${hidden} more line${hidden === 1 ? '' : 's'}`, expanded ? ' (preview truncated) · click to collapse' : ' · click to expand'] })) : expanded ? (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: '  click to collapse' })) : null] }));
};
