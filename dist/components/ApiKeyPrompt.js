import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { LeftBar } from './LeftBar.js';
import { PromptInput } from './PromptInput.js';
import { useTheme } from '../theme.js';
export const ApiKeyPrompt = ({ providerName, path, error, busy, columns, compact = false, embedded = false, onSubmit, }) => {
    const theme = useTheme();
    const [value, setValue] = useState('');
    const { stdout } = useStdout();
    // Leave room for the bar, the "› " prefix and the panel gutter. Clamp to at
    // least 1 so a tiny terminal never gets an input wider than the screen.
    const raw = columns ?? stdout?.columns ?? 80;
    const cols = Number.isFinite(raw) ? raw : 80;
    const width = Math.max(1, Math.floor(cols) - 8);
    return (_jsxs(LeftBar, { color: theme.accent, marginTop: 0, marginBottom: 0, children: [!embedded && (_jsxs(Text, { color: theme.text, bold: true, wrap: "truncate-end", children: ["API key for ", providerName] })), _jsx(Text, { color: theme.dim, wrap: "truncate-middle", children: path }), _jsxs(Box, { marginTop: compact ? 0 : 1, children: [_jsx(Text, { color: theme.accent, children: "\u203A " }), _jsx(PromptInput, { value: value, onChange: setValue, onSubmit: onSubmit, isDisabled: busy, placeholder: busy ? 'Checking key…' : 'Paste API key…', mask: true, width: width })] }), error && _jsx(Text, { color: theme.error, wrap: "truncate-end", children: error }), !embedded && (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: busy ? 'Checking key and fetching models…' : 'enter save · esc cancel' }))] }));
};
