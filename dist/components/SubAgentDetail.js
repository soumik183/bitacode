import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * SubAgentDetail — full transcript inspector for ONE sub-agent run.
 *
 * Owns its own keyboard input: the orchestrator disables App's global useInput
 * while this card is open, so arrow/page/s/esc all land here. The outer box is
 * pinned to the exact row budget handed in by the parent; only the body scrolls.
 */
import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../theme.js';
import { renderFormattedText } from '../utils/format-message.js';
import { dialogWidth, dialogInnerWidth, HintLine } from './Dialog.js';
import { LeftBar } from './LeftBar.js';
import { scrollbarGeometry, scrollbarLines, SCROLLBAR_THUMB } from '../utils/scrollbar.js';
const STATUS = {
    done: { icon: '✓', label: 'done', color: 'success' },
    error: { icon: '✗', label: 'error', color: 'error' },
    aborted: { icon: '■', label: 'aborted', color: 'error' },
    iteration_limit: { icon: '⏱', label: 'iteration limit', color: 'info' },
};
const MAX_ARGS = 4;
const MAX_RESULT_LINES = 8;
const MAX_ARG_CHARS = 64;
const GAP = 1;
/** Rough row count for plain text at a given width (used to budget the window). */
function estimateRows(text, width) {
    const w = Math.max(1, Math.floor(width));
    return String(text ?? '')
        .split('\n')
        .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / w)), 0);
}
function compactTokens(n) {
    if (!n || !Number.isFinite(n) || n <= 0)
        return '';
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
/** First few key/value pairs of a tool call's JSON argument blob. */
function parseArguments(raw) {
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return [];
        return Object.entries(parsed).slice(0, MAX_ARGS).map(([key, value]) => {
            let text;
            if (typeof value === 'string')
                text = value;
            else {
                try {
                    text = JSON.stringify(value) ?? String(value);
                }
                catch {
                    text = String(value);
                }
            }
            return [key, text.replace(/\s+/g, ' ').trim()];
        });
    }
    catch {
        // A truncated argument blob is common while a run is still streaming.
        return [];
    }
}
function isPathKey(key) {
    return key === 'path' || key === 'file_path' || key === 'filePath' || key === 'filename';
}
/**
 * Turn the transcript into row-budgeted blocks. Each block renders as a fixed
 * number of single-row <Text> lines (plus one gap row) so the estimate used for
 * scrolling matches what Ink actually paints.
 */
function buildBlocks({ messages, theme, innerWidth, systemExpanded }) {
    const blocks = [];
    const matched = new Set();
    const push = (key, nodeRows, node) => {
        blocks.push({ key, rows: nodeRows + GAP, node });
    };
    const findResultStart = (callId, after) => {
        if (callId) {
            const direct = messages.findIndex((msg, index) => !matched.has(index) && msg.role === 'tool' && msg.tool_call_id === callId);
            if (direct >= 0)
                return direct;
        }
        // Fallback: the next tool message that no call has claimed yet.
        return messages.findIndex((msg, index) => index > after && !matched.has(index) && msg.role === 'tool');
    };
    const resultNode = (msg, standalone) => {
        const lines = msg.content.replace(/\n+$/, '').split('\n');
        const shown = lines.slice(0, MAX_RESULT_LINES);
        const hidden = Math.max(0, lines.length - shown.length);
        const isError = /^\s*Error:/i.test(msg.content);
        const prefix = standalone ? '▸ ' : isError ? '✗ ' : '✓ ';
        const label = standalone ? `${msg.name ? `${msg.name} ` : ''}result` : 'result';
        const nodeRows = 1 + shown.length + (hidden > 0 ? 1 : 0);
        return {
            rows: nodeRows,
            node: (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: isError ? theme.error : theme.success, children: prefix }), _jsx(Text, { color: theme.dim, children: label })] }), shown.map((line, index) => (_jsx(Text, { color: isError ? theme.error : theme.muted, wrap: "truncate-end", children: line }, index))), hidden > 0 ? (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `  … ${hidden} more lines` })) : null] })),
        };
    };
    messages.forEach((msg, index) => {
        if (msg.role === 'system') {
            if (!systemExpanded) {
                push(`sys-${index}`, 1, (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `▸ System prompt · ${msg.content.length} chars — press s to expand` })));
            }
            else {
                push(`sys-${index}`, 1 + estimateRows(msg.content, innerWidth), (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: "\u25BE System prompt" }), _jsx(Text, { color: theme.dim, children: msg.content })] })));
            }
            return;
        }
        if (msg.role === 'user') {
            push(`user-${index}`, 1 + estimateRows(msg.content, innerWidth), (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: theme.accent, bold: true, wrap: "truncate-end", children: "You" }), _jsx(Text, { children: renderFormattedText(msg.content, innerWidth, theme) })] })));
            return;
        }
        if (msg.role === 'assistant') {
            const calls = msg.tool_calls ?? [];
            calls.forEach((call, callIndex) => {
                const name = call.function?.name ?? call.type ?? 'tool';
                const args = parseArguments(call.function?.arguments);
                const callId = call.id ?? msg.tool_call_id;
                const resultIndex = findResultStart(callId, index);
                const resultMsg = resultIndex >= 0 ? messages[resultIndex] : undefined;
                if (resultMsg)
                    matched.add(resultIndex);
                const result = resultMsg ? resultNode(resultMsg, false) : null;
                const nodeRows = 1 + args.length + (result ? result.rows : 0);
                push(`call-${index}-${callIndex}`, nodeRows, (_jsx(LeftBar, { color: theme.info, children: _jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.info, children: "\u25C6 " }), _jsx(Text, { color: theme.text, bold: true, children: name }), callId ? _jsx(Text, { color: theme.dim, children: `  ${callId.slice(0, 8)}` }) : null] }), args.map(([key, value], argIndex) => {
                                const cap = isPathKey(key) ? MAX_ARG_CHARS * 2 : MAX_ARG_CHARS;
                                const shown = value.length > cap ? `${value.slice(0, cap - 1)}…` : value;
                                return (_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.dim, children: `  ${key}: ` }), _jsx(Text, { color: isPathKey(key) ? theme.accent : theme.muted, children: shown })] }, argIndex));
                            }), result ? result.node : null] }) })));
            });
            if (msg.content && msg.content.trim()) {
                push(`assistant-${index}`, estimateRows(msg.content, innerWidth), (_jsx(Text, { children: renderFormattedText(msg.content, innerWidth, theme) })));
            }
            return;
        }
        if (msg.role === 'tool') {
            if (matched.has(index))
                return;
            const result = resultNode(msg, true);
            push(`tool-${index}`, result.rows, result.node);
        }
    });
    return blocks;
}
export const SubAgentDetail = ({ record, columns, height, onBack }) => {
    const theme = useTheme();
    const [scrollTop, setScrollTop] = React.useState(0);
    const [systemExpanded, setSystemExpanded] = React.useState(false);
    const cardWidth = dialogWidth(columns);
    const innerWidth = dialogInnerWidth(columns);
    const bodyWidth = Math.max(1, innerWidth - 1); // 1 column for the scrollbar rail
    const totalHeight = Math.max(1, Math.floor(height));
    // Borders (2) + header (2) + two rules + hint row.
    const bodyRows = Math.max(1, totalHeight - 7);
    const blocks = React.useMemo(() => buildBlocks({
        messages: record.messages ?? [],
        theme,
        innerWidth: bodyWidth,
        systemExpanded,
    }), [record, theme, bodyWidth, systemExpanded]);
    const totalRows = blocks.reduce((sum, block) => sum + block.rows, 0);
    const maxScrollTop = Math.max(0, totalRows - bodyRows);
    const top = Math.min(scrollTop, maxScrollTop);
    React.useEffect(() => {
        if (scrollTop > maxScrollTop)
            setScrollTop(maxScrollTop);
    }, [scrollTop, maxScrollTop]);
    useInput((input, key) => {
        if (key.escape) {
            onBack();
            return;
        }
        if (key.upArrow || input === 'k') {
            setScrollTop((prev) => Math.max(0, Math.min(prev, maxScrollTop) - 1));
            return;
        }
        if (key.downArrow || input === 'j') {
            setScrollTop((prev) => Math.min(maxScrollTop, Math.min(prev, maxScrollTop) + 1));
            return;
        }
        if (key.pageUp) {
            setScrollTop((prev) => Math.max(0, Math.min(prev, maxScrollTop) - Math.max(1, bodyRows - 2)));
            return;
        }
        if (key.pageDown) {
            setScrollTop((prev) => Math.min(maxScrollTop, Math.min(prev, maxScrollTop) + Math.max(1, bodyRows - 2)));
            return;
        }
        if (key.home) {
            setScrollTop(0);
            return;
        }
        if (key.end) {
            setScrollTop(maxScrollTop);
            return;
        }
        if (input === 's' || input === 'S') {
            setSystemExpanded((prev) => !prev);
        }
    });
    // Row window: skip blocks fully above the viewport, pull the first partial
    // block up with a negative margin, and let Ink clip the bottom to bodyRows.
    let cursor = 0;
    const visible = [];
    for (const block of blocks) {
        const end = cursor + block.rows;
        if (end <= top) {
            cursor = end;
            continue;
        }
        if (cursor >= top + bodyRows)
            break;
        visible.push({ block, offset: cursor });
        cursor = end;
    }
    const rail = scrollbarGeometry(totalRows, bodyRows, maxScrollTop - top);
    const railLines = scrollbarLines(rail);
    const rule = '─'.repeat(Math.max(1, innerWidth));
    const status = STATUS[record.status] ?? STATUS.error;
    const durationMs = Math.max(0, (record.endedAt ?? Date.now()) - record.startedAt);
    const duration = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
    const tokens = compactTokens(record.usage?.totalTokens);
    const cost = record.usage?.estimatedCost ? `$${record.usage.estimatedCost.toFixed(2)}` : '';
    const meta = [`${record.messageCount} msgs`, duration, tokens ? `${tokens} tok` : '', cost]
        .filter(Boolean)
        .join(' · ');
    return (_jsxs(Box, { flexDirection: "column", width: cardWidth, height: totalHeight, flexShrink: 0, overflow: "hidden", borderStyle: "round", borderColor: theme.border, backgroundColor: theme.surface, paddingX: 1, children: [_jsxs(Box, { flexDirection: "column", flexShrink: 0, children: [_jsxs(Box, { flexDirection: "row", overflow: "hidden", children: [_jsx(Text, { color: theme[status.color], bold: true, wrap: "truncate-end", children: `${status.icon} ${status.label} ` }), record.agentType ? (_jsx(Text, { color: theme.accent, wrap: "truncate-end", children: `[${record.agentType}] ` })) : null, _jsx(Box, { flexShrink: 1, minWidth: 1, children: _jsx(Text, { color: theme.text, wrap: "truncate-end", children: record.task }) })] }), _jsxs(Box, { flexDirection: "row", justifyContent: "space-between", overflow: "hidden", children: [_jsx(Box, { flexShrink: 1, minWidth: 1, children: _jsx(Text, { color: theme.error, wrap: "truncate-end", children: record.error ?? '' }) }), _jsx(Box, { flexShrink: 0, marginLeft: 1, children: _jsx(Text, { color: theme.muted, wrap: "truncate-end", children: meta }) })] })] }), _jsx(Text, { color: theme.border, wrap: "truncate-end", children: rule }), _jsxs(Box, { flexDirection: "row", height: bodyRows, flexShrink: 0, overflow: "hidden", children: [_jsx(Box, { flexDirection: "column", width: bodyWidth, flexShrink: 0, overflow: "hidden", children: visible.length === 0 ? (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: "No transcript recorded." })) : (visible.map(({ block, offset }, index) => (_jsx(Box, { flexDirection: "column", flexShrink: 0, marginTop: index === 0 ? -(top - offset) : 0, marginBottom: GAP, children: block.node }, block.key)))) }), rail ? (_jsx(Box, { flexDirection: "column", width: 1, flexShrink: 0, overflow: "hidden", children: railLines.map((line, rowIndex) => (_jsx(Text, { color: line === SCROLLBAR_THUMB ? theme.accent : theme.border, children: line }, rowIndex))) })) : null] }), _jsx(Text, { color: theme.border, wrap: "truncate-end", children: rule }), _jsx(Box, { flexShrink: 0, children: _jsx(HintLine, { hint: "\u2191\u2193 scroll \u00B7 pgup/pgdn page \u00B7 s system \u00B7 esc back" }) })] }));
};
export default SubAgentDetail;
