import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
/**
 * Slash commands, grouped by intent.
 *
 * Order inside a category is by how often it is used, not alphabetical: the
 * first screen of the palette should be the commands a session actually needs.
 * Categories give the list a spine, so a two-line `/` menu still reads as a
 * structured menu instead of a random list.
 */
export const SLASH_COMMANDS = [
    { name: '/help', description: 'Keys, hints and all commands', category: 'App', keywords: 'shortcuts keys' },
    { name: '/new', description: 'Start a fresh session', category: 'Session', keywords: 'reset clear' },
    { name: '/session', description: 'Open a saved session', category: 'Session', keywords: 'resume history' },
    { name: '/find', description: 'Search the transcript', category: 'Session', keywords: 'grep lookup' },
    { name: '/search', description: 'Search every saved session', category: 'Session', keywords: 'all history grep' },
    { name: '/stash', description: 'Save and restore prompt drafts', category: 'Session', keywords: 'draft note restore' },
    { name: '/agent', description: 'List available agents', category: 'Tools', keywords: 'subagent persona role' },
    { name: '/subagents', description: 'Browse and inspect child agents', category: 'Session', keywords: 'agents children transcripts' },
    { name: '/review', description: 'Delegate a code review to a sub-agent', category: 'Tools', keywords: 'audit findings review' },
    { name: '/github', description: 'Open the Bitacode repository in your browser', category: 'App', keywords: 'repo source code' },
    { name: '/bug', description: 'Open the GitHub bug report form', category: 'App', keywords: 'issue report bug' },
    { name: '/model', description: 'Switch model', category: 'Model', keywords: 'llm ai model' },
    { name: '/variant', description: 'Reasoning effort', category: 'Model', keywords: 'thinking effort' },
    { name: '/provider', description: 'Switch provider or add a key', category: 'Model', keywords: 'api key openai anthropic' },
    { name: '/theme', description: 'Choose a colour theme', category: 'App', keywords: 'colour palette dark light' },
    { name: '/settings', description: 'Preferences and status line', category: 'App', keywords: 'config options' },
    { name: '/memory', description: 'Saved facts about you and the repo', category: 'Workspace', keywords: 'remember forget notes' },
    { name: '/checkpoint', description: 'Working notes carried across compaction', category: 'Workspace', keywords: 'scratchpad plan' },
    { name: '/rewind', description: 'Undo the last turn', category: 'Workspace', keywords: 'undo revert back' },
    { name: '/undo', description: 'Undo the last file change', category: 'Workspace', keywords: 'revert edit' },
    { name: '/trust', description: 'Trust this project', category: 'Workspace', keywords: 'permissions hooks commands' },
    { name: '/permissions', description: 'Show permission rules', category: 'Workspace', keywords: 'allow deny ask' },
    { name: '/verify', description: 'Run typecheck, lint and tests', category: 'Tools', keywords: 'checks test build' },
    { name: '/doctor', description: 'Diagnose configuration', category: 'Tools', keywords: 'debug health' },
    { name: '/image', description: 'Attach an image path', category: 'Tools', keywords: 'screenshot vision' },
    { name: '/update', description: 'Update Bitacode from npm', category: 'App', keywords: 'upgrade version' },
    { name: '/quit', description: 'Exit Bitacode', category: 'App', keywords: 'exit close' },
];
const MAX_VISIBLE = 7;
/** Split a label into matched / unmatched runs so the match can be emphasised. */
export function highlightMatch(label, query) {
    const needle = (query ?? '').trim();
    if (!needle)
        return [{ text: label, match: false }];
    const index = label.toLowerCase().indexOf(needle.toLowerCase());
    if (index === -1)
        return [{ text: label, match: false }];
    const before = label.slice(0, index);
    const hit = label.slice(index, index + needle.length);
    const after = label.slice(index + needle.length);
    const parts = [];
    if (before)
        parts.push({ text: before, match: false });
    parts.push({ text: hit, match: true });
    if (after)
        parts.push({ text: after, match: false });
    return parts;
}
/**
 * Turn fuzzy-match indices into contiguous matched / unmatched runs. Invalid
 * indices are ignored so a stale index set can never throw or drop a label.
 */
function labelSegments(label, indices) {
    if (!indices)
        return null;
    const matched = new Set();
    for (const index of indices) {
        if (Number.isInteger(index) && index >= 0 && index < label.length)
            matched.add(index);
    }
    if (matched.size === 0)
        return [{ text: label, match: false }];
    const parts = [];
    let text = '';
    let current = matched.has(0);
    for (let i = 0; i < label.length; i++) {
        const isMatch = matched.has(i);
        if (isMatch !== current) {
            if (text)
                parts.push({ text, match: current });
            text = '';
            current = isMatch;
        }
        text += label[i];
    }
    if (text)
        parts.push({ text, match: current });
    return parts;
}
/** `↑↓ move · enter run · esc close` with keys in the accent colour. */
export const PaletteHint = ({ hint }) => {
    const theme = useTheme();
    const parts = (hint ?? '↑↓ move · enter run · esc close')
        .split('·')
        .map((segment) => segment.trim())
        .filter(Boolean);
    return (_jsx(Text, { wrap: "truncate-end", children: parts.map((part, index) => {
            const space = part.indexOf(' ');
            const key = space === -1 ? part : part.slice(0, space);
            const action = space === -1 ? '' : part.slice(space + 1);
            return (_jsxs(Text, { children: [index > 0 ? _jsx(Text, { color: theme.dim, children: '  ·  ' }) : null, _jsx(Text, { color: theme.accent, children: key }), action ? _jsx(Text, { color: theme.dim, children: ` ${action}` }) : null] }, `${key}-${index}`));
        }) }));
};
/**
 * Selectable list used for slash commands, models and variants.
 *
 * Deliberately cheap: no timers, no internal state, no measurement. It renders
 * on the same frame as the keypress that moved the cursor, so holding an arrow
 * key stays smooth on a phone. Sections, a right-aligned hint column and a
 * windowed "N more" marker keep long lists legible.
 */
export const Palette = ({ title, items, selected, hint, maxVisible, query, emptyLabel = 'All commands', columns, }) => {
    const theme = useTheme();
    if (items.length === 0)
        return null;
    // A name like /session is not worth abbreviating: drop the prose instead.
    // The card loses 4 columns to borders/padding, so require that much more room.
    const showDescriptions = (Number.isFinite(columns) ? Number(columns) : 80) >= 48;
    const window = Math.max(3, Math.min(MAX_VISIBLE, maxVisible ?? MAX_VISIBLE));
    const start = Math.max(0, Math.min(selected - Math.floor(window / 2), items.length - window));
    const visible = items.slice(start, start + window);
    const hiddenAbove = start;
    const hiddenBelow = Math.max(0, items.length - start - visible.length);
    const needle = (query ?? '').trim();
    // One compact dim row while filtering; the empty query reuses the header
    // row below, so the palette keeps exactly the height it always had.
    const matchLine = needle
        ? `${items.length} ${items.length === 1 ? 'match' : 'matches'} for "${needle}"`
        : '';
    const hasHeader = Boolean(title || items.length > window);
    return (_jsxs(Box, { flexDirection: "column", width: "100%", flexShrink: 0, borderStyle: "round", borderColor: theme.border, backgroundColor: theme.surface, paddingX: 1, marginBottom: 1, overflow: "hidden", children: [hasHeader && (_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", children: [_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: title ?? (!needle && emptyLabel ? emptyLabel : 'Matches') }), _jsx(Text, { color: theme.dim, children: `${selected + 1}/${items.length}` })] })), matchLine && (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: matchLine })), hiddenAbove > 0 && (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `  ↑ ${hiddenAbove} more` })), visible.map((item, i) => {
                const index = start + i;
                const active = index === selected;
                const previous = index > 0 ? items[index - 1] : undefined;
                const showSection = Boolean(item.section) && item.section !== previous?.section;
                const labelColor = item.color ?? (active ? theme.text : theme.muted);
                return (_jsxs(Box, { flexDirection: "column", children: [showSection ? (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `  ${item.section}` })) : null, _jsxs(Box, { flexDirection: "row", justifyContent: "space-between", width: "100%", backgroundColor: active ? theme.surfaceAlt : undefined, overflow: "hidden", children: [_jsxs(Box, { flexDirection: "row", flexShrink: 1, minWidth: 1, children: [_jsx(Box, { flexShrink: 0, children: _jsx(Text, { color: active ? theme.accent : theme.dim, children: active ? '› ' : '  ' }) }), _jsx(Box, { flexShrink: 0, children: _jsx(Text, { color: labelColor, bold: active || item.bold, wrap: "truncate-end", children: (labelSegments(item.label, item.matchIndices) ?? highlightMatch(item.label, query))
                                                    .map((part, partIndex) => (_jsx(Text, { color: part.match ? theme.accent : labelColor, bold: part.match || active || item.bold, children: part.text }, partIndex))) }) }), item.description && showDescriptions && (_jsx(Box, { flexShrink: 1, minWidth: 0, overflow: "hidden", children: _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `  ${item.description}` }) }))] }), item.meta ? (_jsx(Box, { flexShrink: 0, marginLeft: 1, children: _jsx(Text, { color: active ? theme.muted : theme.dim, wrap: "truncate-end", children: item.meta }) })) : null] })] }, item.id));
            }), hiddenBelow > 0 && (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `  ↓ ${hiddenBelow} more` })), _jsx(PaletteHint, { hint: hint })] }));
};
