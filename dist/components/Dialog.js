import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
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
const rule = (columns) => '─'.repeat(Math.max(1, dialogWidth(columns) - 2));
export const Dialog = ({ title, badge, hint, columns, compact = false, children }) => {
    const width = dialogWidth(columns);
    const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
    if (compact) {
        return (_jsxs(Box, { flexDirection: "column", width: width, flexShrink: 0, overflow: "hidden", children: [_jsx(Box, { flexDirection: "row", overflow: "hidden", children: _jsx(Box, { flexShrink: 1, minWidth: 1, children: _jsx(Text, { color: theme.accent, bold: true, wrap: "truncate-end", children: title }) }) }), _jsx(Box, { flexDirection: "column", flexShrink: 1, overflow: "hidden", children: children }), hint ? _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: hint }) : null] }));
    }
    return (_jsxs(Box, { flexDirection: "column", width: width, flexShrink: 0, overflow: "hidden", borderStyle: "round", borderColor: theme.border, backgroundColor: theme.surface, paddingX: 1, children: [_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", overflow: "hidden", children: [_jsx(Box, { flexShrink: 1, minWidth: 1, children: _jsx(Text, { color: theme.accent, bold: true, wrap: "truncate-end", children: title }) }), badge ? (_jsx(Box, { flexShrink: 0, marginLeft: 1, children: _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: badge }) })) : null] }), _jsx(Text, { color: theme.border, wrap: "truncate-end", children: rule(cols) }), _jsx(Box, { flexDirection: "column", flexShrink: 1, overflow: "hidden", children: children }), hint ? _jsx(Text, { color: theme.border, wrap: "truncate-end", children: rule(cols) }) : null, hint ? (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: hint })) : null] }));
};
const MAX_VISIBLE = 8;
/**
 * Selectable list for dialogs.
 *
 * No timers and no internal state: it renders the same frame as the keypress
 * that moved the cursor, which keeps Ink's diff small while holding an arrow
 * key. Section headings make the settings/model dialogs readable at a glance.
 */
export const DialogList = ({ items, selected, maxVisible, empty = 'Nothing to show.', compact = false, }) => {
    if (items.length === 0) {
        return _jsx(Text, { color: theme.muted, wrap: "truncate-end", children: empty });
    }
    const windowSize = Math.max(3, Math.min(MAX_VISIBLE, maxVisible ?? MAX_VISIBLE));
    const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), items.length - windowSize));
    const visible = items.slice(start, start + windowSize);
    return (_jsxs(Box, { flexDirection: "column", children: [visible.map((item, index) => {
                const itemIndex = start + index;
                const active = itemIndex === selected;
                const previous = itemIndex > 0 ? items[itemIndex - 1] : undefined;
                const showSection = !compact && Boolean(item.section) && item.section !== previous?.section;
                return (_jsxs(Box, { flexDirection: "column", children: [showSection ? (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: item.section })) : null, _jsxs(Box, { flexDirection: "row", overflow: "hidden", children: [_jsx(Text, { color: active ? theme.accent : theme.dim, children: active ? '› ' : '  ' }), _jsx(Box, { flexGrow: 1, flexShrink: 1, minWidth: 1, children: _jsxs(Text, { color: item.color ?? (active ? theme.text : theme.muted), bold: active || item.bold, wrap: "truncate-end", children: [item.label, item.description ? (_jsx(Text, { color: theme.dim, children: `  ${item.description}` })) : null] }) }), item.meta ? (_jsx(Box, { flexShrink: 0, marginLeft: 1, children: _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: item.meta }) })) : null] })] }, item.id));
            }), !compact && items.length > windowSize ? (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `${selected + 1}/${items.length}` })) : null] }));
};
export default Dialog;
