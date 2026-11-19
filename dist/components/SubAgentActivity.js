import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
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
        }
        : {
            id,
            task: event.subAgentTask || event.subAgentLabel || 'sub-agent task',
            status: event.subAgentStatus ?? 'start',
            toolCalls: tool?.status === 'running' ? 1 : 0,
            summary: finished && tool ? tool.tool : undefined,
            startedAt: now,
            endedAt: finished ? now : undefined,
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
    const labelWidth = 10;
    const tailWidth = 18; // "  N tools · 1.2s"
    const taskWidth = Math.max(1, columns - 6 - labelWidth - tailWidth);
    return (_jsx(Box, { paddingX: 2, children: _jsx(LeftBar, { color: theme.info, children: _jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: theme.muted, bold: true, children: "Sub-agents" }), visible.map((item) => (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: theme[STATUS_COLOR_KEY[item.status]], children: `${STATUS_ICON[item.status]} ` }), _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `${shortId(item.id)} ` }), _jsx(Text, { color: theme.text, wrap: "truncate-end", children: truncate(item.task, taskWidth) }), _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `  ${item.toolCalls ?? 0} tools · ${elapsed(item, nowMs)}` })] }, item.id)))] }) }) }));
};
