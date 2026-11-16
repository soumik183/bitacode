import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { Select } from '@inkjs/ui';
import { LeftBar } from './LeftBar.js';
import { theme } from '../theme.js';
/**
 * Interactive approval prompt rendered inline.
 */
export const ApprovalPrompt = ({ request, onRespond }) => {
    const sessionApprovalLabel = request.sessionScopeKey
        ? 'Approve this operation for session'
        : `Approve all "${request.type}" for session`;
    const items = [
        { label: 'Approve once', value: 'approve_once' },
        { label: sessionApprovalLabel, value: 'approve_session' },
        { label: 'Reject', value: 'reject' },
    ];
    return (_jsxs(LeftBar, { color: theme.border, marginTop: 1, marginBottom: 1, children: [_jsx(Text, { color: theme.text, bold: true, children: "Approval Required" }), _jsx(Text, { color: theme.muted, children: request.description }), request.detail && (_jsx(Text, { color: theme.dim, children: request.detail.length > 200 ? request.detail.slice(0, 200) + '...' : request.detail })), _jsx(Box, { marginTop: 1, children: _jsx(Select, { options: items.map((item) => ({ value: item.value, label: item.label })), onChange: (value) => onRespond(value) }) })] }));
};
