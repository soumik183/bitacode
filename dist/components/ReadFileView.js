import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { displayFilePath } from '../utils/file-diff.js';
const DEFAULT_MAX_LINES = 10;
/**
 * Bordered preview for read_file results. Shows the project-relative path and
 * line numbers without dumping an entire file into the scrollback.
 */
export const ReadFileView = ({ filePath, sections, maxLines }) => {
    const limit = Math.max(1, maxLines ?? DEFAULT_MAX_LINES);
    const totalLines = sections.reduce((total, section) => total + section.lines.length, 0);
    let budget = limit;
    const rendered = sections.map((section) => {
        const visible = section.lines.slice(0, Math.max(0, budget));
        budget -= visible.length;
        return { ...section, visible };
    });
    const hidden = Math.max(0, totalLines - Math.min(totalLines, limit));
    const lastNumber = rendered.reduce((max, section) => Math.max(max, section.startLine + section.visible.length), 1);
    const gutter = Math.max(2, String(lastNumber).length);
    const path = filePath ? displayFilePath(filePath) : 'file';
    const showSectionHeaders = sections.length > 1;
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: theme.border, paddingX: 1, marginY: 1, width: "100%", children: [_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.info, children: "\u25A4 " }), _jsx(Text, { color: theme.text, bold: true, children: "Read" }), _jsx(Text, { color: theme.muted, children: `  ${path}` })] }), totalLines === 0 && sections.every((section) => !section.note) && (_jsx(Text, { color: theme.dim, children: '  (empty file)' })), rendered.map((section, sectionIndex) => (_jsxs(React.Fragment, { children: [showSectionHeaders && (_jsxs(Text, { color: theme.info, children: ['  ', `[lines ${section.startLine}-${section.endLine}]`] })), section.visible.map((line, index) => (_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.dim, children: String(section.startLine + index).padStart(gutter) }), _jsx(Text, { color: theme.dim, children: '  │ ' }), _jsx(Text, { color: theme.muted, children: line })] }, index))), section.note && _jsx(Text, { color: theme.dim, children: `${' '.repeat(gutter)}  ${section.note}` })] }, sectionIndex))), hidden > 0 && (_jsx(Text, { color: theme.dim, children: `${' '.repeat(gutter)}  … ${hidden} more line${hidden === 1 ? '' : 's'}` }))] }));
};
