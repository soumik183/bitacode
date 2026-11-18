import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
// ─── Available slash commands ───
export const SLASH_COMMANDS = [
    { name: '/help', description: 'Show all available commands' },
    { name: '/new', description: 'Start a new session' },
    { name: '/session', description: 'Open a saved session' },
    { name: '/model', description: 'Switch model' },
    { name: '/variant', description: 'Set reasoning variant' },
    { name: '/provider', description: 'Switch API provider' },
    { name: '/settings', description: 'Open settings' },
    { name: '/find', description: 'Search the transcript' },
    { name: '/image', description: 'Attach an image path' },
    { name: '/undo', description: 'Undo the last file change' },
    { name: '/update', description: 'Update Bitacode from npm' },
    { name: '/quit', description: 'Exit Bitacode' },
    { name: '/exit', description: 'Alias for /quit' },
];
const MAX_VISIBLE = 7;
/**
 * Selectable list used for slash commands, models and variants.
 * Kept tiny: no timers, so it renders on the same frame as the keypress.
 */
export const Palette = ({ title, items, selected, hint, maxVisible }) => {
    if (items.length === 0)
        return null;
    const window = Math.max(3, Math.min(MAX_VISIBLE, maxVisible ?? MAX_VISIBLE));
    const start = Math.max(0, Math.min(selected - Math.floor(window / 2), items.length - window));
    const visible = items.slice(start, start + window);
    return (_jsxs(Box, { flexDirection: "column", paddingX: 2, marginBottom: 1, children: [title && _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: title }), visible.map((item, i) => {
                const index = start + i;
                const active = index === selected;
                const labelColor = item.color ?? (active ? theme.text : theme.muted);
                return (_jsxs(Box, { children: [_jsx(Text, { color: active ? theme.accent : theme.dim, children: active ? '› ' : '  ' }), _jsx(Text, { color: labelColor, bold: active || item.bold, wrap: "truncate-end", children: item.label }), item.description && _jsxs(Text, { color: theme.dim, wrap: "truncate-end", children: ["  ", item.description] })] }, item.id));
            }), _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: hint ?? '↑↓ select · enter run · esc close' })] }));
};
