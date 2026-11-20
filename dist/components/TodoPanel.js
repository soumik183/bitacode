import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
const STATUS_ICON = {
    completed: '✓',
    in_progress: '▸',
    pending: '○',
    cancelled: '✕',
};
/** Short priority chip: high tasks read as urgent without shouting. */
const PRIORITY_CHIP = {
    high: { label: 'P1', key: 'error' },
    medium: { label: 'P2', key: 'info' },
    low: { label: 'P3', key: 'dim' },
};
/** Status → semantic palette key, resolved from the active palette at render. */
const STATUS_COLOR_KEY = {
    completed: 'success',
    in_progress: 'info',
    pending: 'dim',
    cancelled: 'dim',
};
/** Collapse whitespace and trim, without losing the end of long items. */
function oneLine(text) {
    return text.replace(/\s+/g, ' ').trim();
}
/**
 * Fit one task into `max` characters. The task description itself matters more
 * than the trailing priority marker, so only shorten when it truly overflows.
 */
export function truncateTodo(text, max) {
    const singleLine = oneLine(text);
    const limit = Math.max(1, max);
    if (singleLine.length <= limit)
        return singleLine;
    if (limit <= 1)
        return '…';
    return `${singleLine.slice(0, limit - 1)}…`;
}
/**
 * Pick the slice of todos to show. The list is windowed around the item that
 * is actually in progress (falling back to the first unfinished item), so the
 * live task is always visible instead of the panel being pinned to the top and
 * hiding progress behind a "+N" counter.
 */
export function visibleTodoWindow(todos, maxVisible) {
    const limit = Math.max(1, maxVisible);
    if (todos.length <= limit)
        return { start: 0, items: todos };
    const anchorStatus = 'in_progress';
    let anchor = todos.findIndex((todo) => todo.status === anchorStatus);
    if (anchor === -1) {
        anchor = todos.findIndex((todo) => todo.status === 'pending');
    }
    if (anchor === -1)
        anchor = todos.length - 1;
    const half = Math.floor(limit / 2);
    let start = Math.max(0, anchor - half);
    start = Math.min(start, todos.length - limit);
    return { start, items: todos.slice(start, start + limit) };
}
/**
 * Live task panel. Updates whenever the agent calls todo_write, so checkmarks
 * and the progress bar move in real time.
 */
export const TodoPanel = ({ todos, columns, maxVisible = 5 }) => {
    const theme = useTheme();
    if (todos.length === 0)
        return null;
    const total = todos.length;
    const done = todos.filter((todo) => todo.status === 'completed').length;
    const { start, items: visible } = visibleTodoWindow(todos, maxVisible);
    const hiddenAbove = start;
    const hiddenBelow = Math.max(0, total - start - visible.length);
    const safeColumns = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
    // The bar is a luxury: under ~40 columns it truncates the count, so hide it
    // and let the numeric percentage carry the same information.
    const showBar = safeColumns >= 40;
    const barWidth = safeColumns >= 80 ? 10 : 6;
    const filled = total > 0 ? Math.round((done / total) * barWidth) : 0;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    // Gutter bar (2) + priority chip (3) + icon + space, plus the panel's own
    // paddingX(2) on both sides. A tiny terminal cannot afford a fixed floor, so
    // clamp all the way down to 1 instead of overflowing the frame.
    const reserved = 2 + 3 + 1 + 1 + (hiddenAbove + hiddenBelow > 0 ? 2 : 0);
    const contentWidth = Math.max(1, safeColumns - 4 - reserved);
    const active = visible.find((todo) => todo.status === 'in_progress');
    return (_jsxs(Box, { flexDirection: "column", paddingX: 2, marginBottom: 1, children: [_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", children: [_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.accent, bold: true, children: "\u25A4 " }), _jsx(Text, { color: theme.text, bold: true, children: "Tasks" }), _jsx(Text, { color: theme.dim, children: `  ${done}/${total} done` }), showBar ? (_jsxs(_Fragment, { children: [_jsx(Text, { color: theme.dim, children: '  ' }), _jsx(Text, { color: filled > 0 ? theme.success : theme.border, children: '▰'.repeat(filled) }), _jsx(Text, { color: theme.border, children: '▱'.repeat(Math.max(0, barWidth - filled)) })] })) : null] }), _jsx(Text, { color: percent === 100 ? theme.success : theme.dim, children: `${percent}%` })] }), hiddenAbove > 0 && (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `  ↑ ${hiddenAbove} more` })), visible.map((todo, index) => {
                const dimmed = todo.status === 'completed' || todo.status === 'cancelled';
                const running = todo.status === 'in_progress';
                const chip = PRIORITY_CHIP[todo.priority] ?? PRIORITY_CHIP.low;
                return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: running ? theme.accent : theme.border, children: running ? '▌' : ' ' }), _jsx(Text, { color: theme[chip.key], children: `${chip.label} ` }), _jsx(Text, { color: theme[STATUS_COLOR_KEY[todo.status]], children: `${STATUS_ICON[todo.status]} ` }), _jsx(Text, { color: dimmed ? theme.dim : running ? theme.text : theme.muted, bold: running, strikethrough: todo.status === 'completed', wrap: "truncate-end", children: truncateTodo(todo.content, contentWidth) })] }, `${todo.id}-${start + index}`));
            }), hiddenBelow > 0 && (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `  ↓ ${hiddenBelow} more` })), active ? (_jsxs(Text, { color: theme.dim, wrap: "truncate-end", children: ['  ', _jsx(Text, { color: theme.info, children: active.id }), _jsx(Text, { color: theme.dim, children: " in progress" })] })) : null] }));
};
/**
 * Exact row count for a given list, matching what this component renders:
 * header + one row per visible task + an "↑ N more" row when tasks are hidden
 * above + a "↓ N more" row when tasks are hidden below + one caption row while
 * a task is in progress, plus the bottom margin.
 *
 * App uses this to budget the live area, so the panel and the transcript always
 * agree and the composer never gets pushed off-screen.
 */
export function todoPanelRows(todos, maxVisible) {
    if (todos.length === 0)
        return 0;
    const { start, items } = visibleTodoWindow(todos, maxVisible);
    const hiddenAbove = start > 0 ? 1 : 0;
    const hiddenBelow = todos.length > start + items.length ? 1 : 0;
    // header + tasks + overflow markers + the "in progress" caption + margin
    const activeRow = items.some((todo) => todo.status === 'in_progress') ? 1 : 0;
    return 1 + items.length + hiddenAbove + hiddenBelow + activeRow + 1;
}
