import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { Select } from '@inkjs/ui';
import { LeftBar } from './LeftBar.js';
import { theme } from '../theme.js';
/** Cut a label to a display-column budget (approval options must stay one row). */
function fitLabel(text, max) {
    const limit = Math.max(1, Math.floor(Number.isFinite(max) ? max : Infinity));
    const single = text.replace(/\s+/g, ' ').trim();
    if (single.length <= limit)
        return single;
    if (limit === 1)
        return '…';
    return `${single.slice(0, limit - 1)}…`;
}
/**
 * Interactive approval prompt rendered inline.
 */
export const ApprovalPrompt = ({ request, columns = 80, compact = false, onRespond }) => {
    const sessionApprovalLabel = request.sessionScopeKey
        ? 'Approve this operation for session'
        : `Approve all "${request.type}" for session`;
    // Reserve room for the select marker and the LeftBar gutter.
    const labelWidth = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 80) - 5);
    const items = [
        { label: 'Approve once', value: 'approve_once' },
        { label: sessionApprovalLabel, value: 'approve_session' },
        { label: 'Reject', value: 'reject' },
    ];
    return (_jsxs(LeftBar, { color: theme.border, marginTop: compact ? 0 : 1, marginBottom: compact ? 0 : 1, children: [_jsx(Text, { color: theme.text, bold: true, children: "Approval Required" }), _jsx(Text, { color: theme.muted, wrap: "truncate-end", children: request.description }), request.detail && (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: request.detail })), _jsx(Box, { marginTop: compact ? 0 : 1, children: _jsx(Select, { options: items.map((item) => ({ value: item.value, label: fitLabel(item.label, labelWidth) })), onChange: (value) => onRespond(value) }) })] }));
};
