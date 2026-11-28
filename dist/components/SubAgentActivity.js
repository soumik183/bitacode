import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { displayWidth } from '../utils/format-message.js';
import { LeftBar } from './LeftBar.js';
export const SUB_AGENT_MAX_VISIBLE = 3;
const STATUS_ICON = {
    start: '⠹',
    done: '✓',
    error: '✗',
};
/** Status → semantic palette key, resolved from the active palette at render. */
const STATUS_COLOR_KEY = {
    start: 'info',
    done: 'success',
    error: 'error',
};
/** Upsert one child's state from a synthetic sub_agent_iteration event. */
export function upsertSubAgentActivity(list, event, now = Date.now()) {
    const id = event.subAgentId;
    if (!id)
        return list;
    const tool = event.subAgentTool;
    const finished = event.subAgentStatus === 'done' || event.subAgentStatus === 'error';
    const index = list.findIndex((item) => item.id === id);
    const existing = list[index];
    const next = existing
        ? {
            ...existing,
            status: event.subAgentStatus ?? existing.status,
            task: event.subAgentTask?.trim() ? event.subAgentTask : existing.task,
            toolCalls: tool?.status === 'running' ? (existing.toolCalls ?? 0) + 1 : existing.toolCalls,
            summary: finished && tool ? tool.tool : existing.summary,
            endedAt: finished ? now : existing.endedAt,
            agentType: event.subAgentType?.trim() ? event.subAgentType : existing.agentType,
        }
        : {
            id,
            task: event.subAgentTask || event.subAgentLabel || 'sub-agent task',
            status: event.subAgentStatus ?? 'start',
            toolCalls: tool?.status === 'running' ? 1 : 0,
            summary: finished && tool ? tool.tool : undefined,
            startedAt: now,
            endedAt: finished ? now : undefined,
            agentType: event.subAgentType?.trim() ? event.subAgentType : undefined,
        };
    if (!existing)
        return [...list, next];
    const copy = list.slice();
    copy[index] = next;
    return copy;
}
/** One-line summary for the replay card flushed into scrollback. */
export function subAgentActivitySummary(list) {
    const done = list.filter((item) => item.status === 'done').length;
    const error = list.filter((item) => item.status === 'error').length;
    const running = list.length - done - error;
    const parts = [];
    if (done)
        parts.push(`${done} done`);
    if (error)
        parts.push(`${error} error${error === 1 ? '' : 's'}`);
    if (running)
        parts.push(`${running} running`);
    const count = list.length;
    return `${count} sub-agent${count === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}
/** Rows the panel occupies, matching the render below (header + items). */
export function subAgentActivityRows(list) {
    if (list.length === 0)
        return 0;
    return 1 + Math.min(list.length, SUB_AGENT_MAX_VISIBLE);
}
function truncate(text, max) {
    const one = text.replace(/\s+/g, ' ').trim();
    if (one.length <= max)
        return one;
    if (max <= 1)
        return '…';
    return `${one.slice(0, max - 1)}…`;
}
/** Cut the status tail to an exact display-column budget. */
function fitTail(text, max) {
    if (max <= 0)
        return '';
    if (displayWidth(text) <= max)
        return text;
    const limit = Math.max(1, Math.floor(max) - 1);
    let used = 0;
    let out = '';
    for (const ch of text) {
        const width = displayWidth(ch);
        if (used + width > limit)
            break;
        used += width;
        out += ch;
    }
    return `${out}…`;
}
function shortId(id) {
    return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}
function elapsed(item, now) {
    const ms = Math.max(0, (item.endedAt ?? now) - item.startedAt);
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
export const SubAgentActivity = ({ activities, columns, now }) => {
    const theme = useTheme();
    if (activities.length === 0)
        return null;
    const visible = activities.slice(-SUB_AGENT_MAX_VISIBLE);
    const nowMs = now ?? Date.now();
    const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
    // Exact fixed costs per item row: outer padding (4), LeftBar bar + gap (2),
    // status icon + space, id + space, optional badge, and the status tail.
    const fixedOverhead = 6;
    const minTaskWidth = 8;
    return (_jsx(Box, { paddingX: 2, children: _jsx(LeftBar, { color: theme.info, children: _jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", overflow: "hidden", children: [_jsxs(Box, { flexDirection: "row", flexShrink: 1, minWidth: 1, children: [_jsx(Text, { color: theme.muted, bold: true, children: "Sub-agents" }), _jsx(Text, { color: theme.accent, backgroundColor: theme.surface, children: ` ${activities.length} ` })] }), _jsx(Box, { flexShrink: 0, marginLeft: 1, children: _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: "^g all" }) })] }), visible.map((item) => {
                        const badge = item.agentType ? `[${item.agentType}] ` : '';
                        const icon = `${STATUS_ICON[item.status]} `;
                        const id = `${shortId(item.id)} `;
                        const usedWithoutTail = fixedOverhead + displayWidth(icon) + displayWidth(id) + displayWidth(badge);
                        const tail = fitTail(`  ${item.toolCalls ?? 0} tools · ${elapsed(item, nowMs)}`, Math.max(0, cols - usedWithoutTail - minTaskWidth));
                        // Derive the task field from what was actually painted, not from a
                        // guessed 34-column reservation that overflowed narrow screens.
                        const rowTaskWidth = Math.max(1, cols - usedWithoutTail - displayWidth(tail));
                        return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: theme[STATUS_COLOR_KEY[item.status]], children: icon }), _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: id }), badge ? _jsx(Text, { color: theme.accent, wrap: "truncate-end", children: badge }) : null, _jsx(Text, { color: theme.text, wrap: "truncate-end", children: truncate(item.task, rowTaskWidth) }), _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: tail })] }, item.id));
                    })] }) }) }));
};
