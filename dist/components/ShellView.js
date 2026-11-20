import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { safeHighlight } from '../utils/code-highlight.js';
import { TokenText } from './CodeBlock.js';
/** How many output lines a collapsed shell card shows before the click hint. */
export const SHELL_PREVIEW_LINES = 4;
/**
 * Upper bound for an expanded card. A command that prints tens of thousands of
 * lines must not be allowed to push the composer off-screen; the remainder is
 * summarised in a trailer row.
 */
export const SHELL_EXPANDED_MAX_LINES = 120;
/**
 * Terminal-style card for bash output.
 *
 * Collapsed it shows the first few lines plus a count of what is hidden;
 * clicking expands in place, and clicking again folds it back. The height is
 * therefore fully determined by `expanded`, which keeps the transcript budget
 * honest when the card is toggled.
 */
export const ShellView = ({ command, output, isError, status, expanded = false, }) => {
    const theme = useTheme();
    const lines = output.replace(/\n+$/, '').split('\n');
    const hasOutput = output.trim().length > 0;
    const limit = expanded ? SHELL_EXPANDED_MAX_LINES : SHELL_PREVIEW_LINES;
    const shown = hasOutput ? lines.slice(0, Math.min(lines.length, limit)) : [];
    const hidden = hasOutput ? Math.max(0, lines.length - shown.length) : 0;
    const commandLine = command.replace(/\s+/g, ' ').trim();
    const commandTokens = React.useMemo(() => safeHighlight(commandLine || 'bash', 'bash', { palette: theme })[0] ?? [], [commandLine, theme]);
    const hint = hidden > 0 ? (expanded ? 'click to collapse' : 'click to expand') : expanded ? 'click to collapse' : '';
    const borderColor = isError ? theme.error : theme.border;
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: borderColor, paddingX: 1, marginY: 1, width: "100%", children: [_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", overflow: "hidden", children: [_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: isError ? theme.error : theme.success, children: isError ? '✗ ' : '✓ ' }), _jsx(Text, { color: theme.text, bold: true, children: "Shell" }), status ? (_jsx(Text, { color: isError ? theme.error : theme.success, children: `  ${status}` })) : null, _jsx(Text, { color: theme.dim, children: `  ${lines.length} line${lines.length === 1 ? '' : 's'}` })] }), hint ? (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `  ${hint}` })) : null] }), _jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.accent, children: "\u276F " }), _jsx(TokenText, { tokens: commandTokens, baseColor: theme.text, baseBold: true })] }), !hasOutput ? (_jsx(Text, { color: theme.dim, children: '  (no output)' })) : (_jsx(Text, { color: isError ? theme.error : theme.muted, wrap: expanded ? 'wrap' : 'truncate-end', children: shown.join('\n') })), hidden > 0 ? (_jsxs(Text, { color: theme.dim, children: [`  … ${hidden} more line${hidden === 1 ? '' : 's'}`, expanded ? ' (preview truncated)' : ''] })) : null] }));
};
