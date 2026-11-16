import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { LeftBar } from './LeftBar.js';
import { PromptInput } from './PromptInput.js';
import { theme } from '../theme.js';
export const ApiKeyPrompt = ({ providerName, path, error, busy, onSubmit, }) => {
    const [value, setValue] = useState('');
    const { stdout } = useStdout();
    // Leave room for the bar, the "› " prefix and the panel gutter.
    const width = Math.max(8, (stdout?.columns || 80) - 8);
    return (_jsxs(LeftBar, { color: theme.accent, marginTop: 1, marginBottom: 1, children: [_jsxs(Text, { color: theme.text, bold: true, children: ["API key for ", providerName] }), _jsx(Text, { color: theme.dim, wrap: "truncate-middle", children: path }), _jsxs(Box, { marginTop: 1, children: [_jsx(Text, { color: theme.accent, children: "\u203A " }), _jsx(PromptInput, { value: value, onChange: setValue, onSubmit: onSubmit, isDisabled: busy, placeholder: busy ? 'Checking key…' : 'Paste API key…', mask: true, width: width })] }), error && _jsx(Text, { color: theme.error, children: error }), _jsx(Text, { color: theme.dim, children: busy ? 'Checking key and fetching models…' : 'enter save · esc cancel' })] }));
};
