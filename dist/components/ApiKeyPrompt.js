import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { LeftBar } from './LeftBar.js';
import { PromptInput } from './PromptInput.js';
import { HintLine } from './Dialog.js';
import { useTheme } from '../theme.js';
/**
 * Where to create a key, per provider. Best-effort by name, so an unknown
 * provider shows no link instead of a wrong one.
 */
export function providerKeyUrl(providerName) {
    const name = providerName.toLowerCase();
    if (name.includes('openrouter'))
        return 'openrouter.ai/keys';
    if (name.includes('anthropic') || name.includes('claude'))
        return 'console.anthropic.com/settings/keys';
    if (name.includes('openai'))
        return 'platform.openai.com/api-keys';
    if (name.includes('groq'))
        return 'console.groq.com/keys';
    if (name.includes('google') || name.includes('gemini'))
        return 'aistudio.google.com/apikey';
    if (name.includes('mistral'))
        return 'console.mistral.ai/api-keys';
    if (name.includes('xai') || name.includes('grok'))
        return 'console.x.ai';
    if (name.includes('deepseek'))
        return 'platform.deepseek.com/api_keys';
    if (name.includes('together'))
        return 'api.together.ai/settings/api-keys';
    if (name.includes('fireworks'))
        return 'fireworks.ai/account/api-keys';
    if (name.includes('cerebras'))
        return 'cloud.cerebras.ai';
    return undefined;
}
export const ApiKeyPrompt = ({ providerName, path, error, busy, columns, compact = false, embedded = false, onSubmit, }) => {
    const theme = useTheme();
    const [value, setValue] = useState('');
    const { stdout } = useStdout();
    // Leave room for the bar, the "› " prefix and the panel gutter. Clamp to at
    // least 1 so a tiny terminal never gets an input wider than the screen.
    const raw = columns ?? stdout?.columns ?? 80;
    const cols = Number.isFinite(raw) ? raw : 80;
    const width = Math.max(1, Math.floor(cols) - 8);
    const keyUrl = providerKeyUrl(providerName);
    return (_jsxs(LeftBar, { color: theme.accent, marginTop: 0, marginBottom: 0, children: [!embedded && (_jsxs(Text, { color: theme.text, bold: true, wrap: "truncate-end", children: [_jsx(Text, { color: theme.accent, children: "\u26BF " }), "API key for ", providerName] })), _jsxs(Text, { color: theme.dim, wrap: "truncate-middle", children: [busy ? 'saving to ' : 'stored in ', _jsx(Text, { color: theme.muted, children: path })] }), keyUrl ? (_jsxs(Text, { color: theme.dim, wrap: "truncate-end", children: ['create one at ', _jsx(Text, { color: theme.info, children: keyUrl })] })) : null, _jsxs(Box, { marginTop: compact ? 0 : 1, children: [_jsx(Text, { color: theme.accent, children: "\u203A " }), _jsx(PromptInput, { value: value, onChange: setValue, onSubmit: onSubmit, isDisabled: busy, placeholder: busy ? 'Checking key…' : 'Paste API key…', mask: true, width: width })] }), error && (_jsxs(Text, { color: theme.error, wrap: "truncate-end", children: [_jsx(Text, { color: theme.error, children: "\u2717 " }), error] })), !embedded && (_jsx(Box, { marginTop: compact ? 0 : 1, children: busy ? (_jsx(Text, { color: theme.muted, wrap: "truncate-end", children: "Checking key and fetching models\u2026" })) : (_jsx(HintLine, { compact: compact, hint: "enter save \u00B7 esc cancel" })) }))] }));
};
