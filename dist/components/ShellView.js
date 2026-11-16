import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
/** How many output lines a collapsed shell card shows before the click hint. */
export const SHELL_PREVIEW_LINES = 4;
/**
 * Terminal-style card for bash output. It stays compact by default so a long
 * command does not flood the transcript; clicking the card expands the full
 * output in place and clicking again folds it back.
 */
export const ShellView = ({ command, output, isError, status, expanded = false, }) => {
    const lines = output.replace(/\n+$/, '').split('\n');
    const hasOutput = output.trim().length > 0;
    const shown = expanded || !hasOutput ? lines : lines.slice(0, SHELL_PREVIEW_LINES);
    const hidden = hasOutput ? Math.max(0, lines.length - shown.length) : 0;
    const commandLine = command.replace(/\s+/g, ' ').trim();
    const hint = expanded ? 'click to collapse' : 'click to expand';
    const borderColor = isError ? theme.error : theme.border;
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: borderColor, paddingX: 1, marginY: 1, width: "100%", children: [_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: isError ? theme.error : theme.success, children: isError ? '✗ ' : '✓ ' }), _jsx(Text, { color: theme.muted, bold: true, children: "Shell" }), status && _jsx(Text, { color: isError ? theme.error : theme.dim, children: `  ${status}` }), _jsx(Text, { color: theme.dim, children: `  ${hint}` })] }), _jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.accent, children: "\u276F " }), _jsx(Text, { color: theme.text, bold: true, children: commandLine || 'bash' })] }), !hasOutput ? (_jsx(Text, { color: theme.dim, children: '  (no output)' })) : (_jsx(Text, { color: isError ? theme.error : theme.muted, wrap: expanded ? 'wrap' : 'truncate-end', children: shown.join('\n') })), hidden > 0 && (_jsx(Text, { color: theme.dim, children: `  … ${hidden} more line${hidden === 1 ? '' : 's'}` }))] }));
};
