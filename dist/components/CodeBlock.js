import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { safeHighlight, MAX_HIGHLIGHT_CHARS, } from '../utils/code-highlight.js';
/** Render a highlighted line. Uncoloured tokens inherit `baseColor`. */
export const TokenText = ({ tokens, baseColor, baseBold }) => (_jsx(_Fragment, { children: tokens.map((token, index) => (_jsx(Text, { color: token.color ?? baseColor, bold: token.bold ?? baseBold, dimColor: token.dim, children: token.text }, index))) }));
const DEFAULT_MAX_ROWS = 12;
/**
 * Reusable highlighted code box. Tokens are memoized per (code, language) and
 * every row uses `wrap="truncate-end"`, so long or numerous lines can never
 * grow the surrounding frame.
 */
export const CodeBlock = ({ code, language, filename, showHeader = false, showLineNumbers = false, maxRows = DEFAULT_MAX_ROWS, columns, borderColor = theme.border, marginY = 1, startLine = 1, }) => {
    const lines = React.useMemo(() => safeHighlight(code, language, { maxChars: MAX_HIGHLIGHT_CHARS }), [code, language]);
    const budget = Math.max(1, Math.floor(maxRows));
    const shown = lines.slice(0, budget);
    const hidden = Math.max(0, lines.length - shown.length);
    const lastNumber = Math.max(startLine, startLine + lines.length - 1);
    const gutterWidth = showLineNumbers ? String(lastNumber).length : 0;
    const label = filename || (language && language !== 'text' ? String(language) : 'code');
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: borderColor, paddingX: 1, marginY: marginY, width: columns, overflow: "hidden", children: [showHeader && (_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.info, children: "\u25A4 " }), _jsx(Text, { color: theme.text, bold: true, children: label }), language && language !== 'text' && _jsx(Text, { color: theme.dim, children: `  ${language}` })] })), shown.map((tokens, index) => (_jsxs(Text, { wrap: "truncate-end", children: [showLineNumbers && (_jsxs(_Fragment, { children: [_jsx(Text, { color: theme.dim, children: String(startLine + index).padStart(gutterWidth) }), _jsx(Text, { color: theme.dim, children: ' │ ' })] })), _jsx(TokenText, { tokens: tokens, baseColor: theme.text })] }, index))), hidden > 0 && (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `${' '.repeat(gutterWidth ? gutterWidth + 3 : 0)}… ${hidden} more line${hidden === 1 ? '' : 's'}` }))] }));
};
