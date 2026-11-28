import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
/**
 * Outer width of a dialog at this terminal width.
 *
 * Cards cap at 72 columns on normal terminals and 84 on wide ones; on narrow
 * screens they use the space minus a 2-column breathing margin, and never
 * exceed the terminal itself (a too-wide Ink box wraps and breaks the frame).
 */
export function dialogWidth(columns) {
    const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
    const preferred = cols >= 96 ? 84 : Math.max(24, Math.min(cols - 4, 72));
    return Math.max(1, Math.min(cols, preferred));
}
/** Usable content width inside the frame (borders + 1-column padding). */
export function dialogInnerWidth(columns) {
    return Math.max(1, dialogWidth(columns) - 4);
}
/** Hairline that spans exactly the content box of an already-clamped card. */
const rule = (cardWidth) => '─'.repeat(Math.max(1, cardWidth - 4));
/**
 * Split a hint into key/action pairs so keys can carry the accent colour. A
 * hint is `enter select · esc close` — the first word of each segment is the
 * key, everything after it is the action.
 */
export function splitHint(hint) {
    return hint
        .split('·')
        .map((segment) => segment.trim())
        .filter(Boolean)
        .map((segment) => {
        const space = segment.indexOf(' ');
        if (space === -1)
            return { key: segment, action: '' };
        return { key: segment.slice(0, space), action: segment.slice(space + 1).trim() };
    });
}
/** `enter save · esc cancel` with the key names painted in the accent colour. */
export const HintLine = ({ hint, compact }) => {
    const theme = useTheme();
    const parts = splitHint(hint);
    if (parts.length === 0)
        return null;
    return (_jsx(Text, { wrap: "truncate-end", children: parts.map((part, index) => (_jsxs(Text, { children: [index > 0 ? _jsx(Text, { color: theme.dim, children: '  ·  ' }) : null, _jsx(Text, { color: theme.accent, bold: !compact, children: part.key }), part.action ? _jsx(Text, { color: theme.dim, children: ` ${part.action}` }) : null] }, `${part.key}-${index}`))) }));
};
export const Dialog = ({ title, badge, hint, columns, compact = false, accentGlyph, borderStyle = 'round', children, }) => {
    const theme = useTheme();
    const heading = accentGlyph ? `${accentGlyph} ${title}` : title;
    const width = dialogWidth(columns);
    if (compact) {
        return (_jsxs(Box, { flexDirection: "column", width: width, flexShrink: 0, overflow: "hidden", children: [_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", overflow: "hidden", children: [_jsx(Box, { flexShrink: 1, minWidth: 1, children: _jsx(Text, { color: theme.accent, bold: true, wrap: "truncate-end", children: heading }) }), badge && width >= 30 ? (_jsx(Box, { flexShrink: 0, marginLeft: 1, children: _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: badge }) })) : null] }), _jsx(Box, { flexDirection: "column", flexShrink: 1, overflow: "hidden", children: children }), hint ? _jsx(HintLine, { hint: hint, compact: true }) : null] }));
    }
    return (_jsxs(Box, { flexDirection: "column", width: width, flexShrink: 0, overflow: "hidden", borderStyle: borderStyle === 'square' ? 'single' : 'round', borderColor: theme.border, backgroundColor: theme.surface, paddingX: 1, children: [_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", overflow: "hidden", children: [_jsx(Box, { flexShrink: 1, minWidth: 1, children: _jsx(Text, { color: theme.accent, bold: true, wrap: "truncate-end", children: heading }) }), badge ? (_jsx(Box, { flexShrink: 0, marginLeft: 1, children: _jsx(Text, { color: theme.muted, wrap: "truncate-end", children: ` ${badge} ` }) })) : null] }), _jsx(Text, { color: theme.border, wrap: "truncate-end", children: rule(width) }), _jsx(Box, { flexDirection: "column", flexShrink: 1, overflow: "hidden", children: children }), hint ? (_jsxs(_Fragment, { children: [_jsx(Text, { color: theme.border, wrap: "truncate-end", children: rule(width) }), _jsx(HintLine, { hint: hint })] })) : null] }));
};
const MAX_VISIBLE = 8;
/**
 * Selectable list for dialogs.
 *
 * No timers and no internal state: it renders the same frame as the keypress
 * that moved the cursor, which keeps Ink's diff small while holding an arrow
 * key. Section headings, a right-aligned value column and a position chip make
 * long dialogs readable at a glance.
 */
export const DialogList = ({ items, selected, maxVisible, empty = 'Nothing to show.', compact = false, }) => {
    const theme = useTheme();
    if (items.length === 0) {
        return _jsx(Text, { color: theme.muted, wrap: "truncate-end", children: empty });
    }
    const windowSize = Math.max(3, Math.min(MAX_VISIBLE, maxVisible ?? MAX_VISIBLE));
    const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), items.length - windowSize));
    const visible = items.slice(start, start + windowSize);
    const hiddenAbove = start;
    const hiddenBelow = Math.max(0, items.length - start - visible.length);
    return (_jsxs(Box, { flexDirection: "column", children: [hiddenAbove > 0 && !compact ? (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `  ↑ ${hiddenAbove} more` })) : null, visible.map((item, index) => {
                const itemIndex = start + index;
                const active = itemIndex === selected;
                const previous = itemIndex > 0 ? items[itemIndex - 1] : undefined;
                const showSection = !compact && Boolean(item.section) && item.section !== previous?.section;
                return (_jsxs(Box, { flexDirection: "column", children: [showSection ? (_jsx(Box, { marginTop: itemIndex > 0 ? 0 : 0, children: _jsx(Text, { color: theme.dim, bold: true, wrap: "truncate-end", children: `  ${item.section}` }) })) : null, _jsxs(Box, { flexDirection: "row", justifyContent: "space-between", width: "100%", backgroundColor: active ? theme.surfaceAlt : undefined, overflow: "hidden", children: [_jsxs(Box, { flexShrink: 1, minWidth: 1, flexDirection: "row", children: [_jsx(Text, { color: active ? theme.accent : theme.dim, children: active ? '› ' : '  ' }), item.swatch ? (_jsx(Box, { flexShrink: 0, marginRight: 1, children: _jsx(Text, { color: item.swatch.accent, backgroundColor: item.swatch.bg, children: "\u25A0" }) })) : null, _jsx(Box, { flexShrink: 1, minWidth: 1, children: _jsxs(Text, { color: item.color ?? (active ? theme.text : theme.muted), bold: active || item.bold, wrap: "truncate-end", children: [item.label, item.description ? (_jsx(Text, { color: theme.dim, children: ` · ${item.description}` })) : null] }) })] }), item.meta || item.active ? (_jsxs(Box, { flexShrink: 0, marginLeft: 1, children: [item.meta ? (_jsx(Text, { color: active ? theme.accent : theme.dim, wrap: "truncate-end", children: item.meta })) : null, item.active ? (_jsx(Text, { color: theme.success, wrap: "truncate-end", children: item.meta ? ' ✓' : '✓' })) : null] })) : null] })] }, item.id));
            }), hiddenBelow > 0 && !compact ? (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `  ↓ ${hiddenBelow} more` })) : null, !compact && items.length > windowSize ? (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `  ${selected + 1}/${items.length}` })) : null] }));
};
export default Dialog;
