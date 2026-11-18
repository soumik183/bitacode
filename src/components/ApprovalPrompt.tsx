import React from 'react';
import { Box, Text } from 'ink';
import { Select } from '@inkjs/ui';
import { LeftBar } from './LeftBar.js';
import { theme } from '../theme.js';
import type { ApprovalRequest, ApprovalResponse } from '../utils/approval.js';

export interface ApprovalPromptProps {
  request: ApprovalRequest;
  /** Terminal columns, used to keep option labels inside the screen. */
  columns?: number;
  /** Short terminals drop the decorative margins so no option is clipped. */
  compact?: boolean;
  onRespond: (response: ApprovalResponse) => void;
}

/** Cut a label to a display-column budget (approval options must stay one row). */
function fitLabel(text: string, max: number): string {
  const limit = Math.max(1, Math.floor(Number.isFinite(max) ? max : Infinity));
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= limit) return single;
  if (limit === 1) return '…';
  return `${single.slice(0, limit - 1)}…`;
}

/**
 * Interactive approval prompt rendered inline.
 */
export const ApprovalPrompt: React.FC<ApprovalPromptProps> = ({ request, columns = 80, compact = false, onRespond }) => {
  const sessionApprovalLabel = request.sessionScopeKey
    ? 'Approve this operation for session'
    : `Approve all "${request.type}" for session`;
  // Reserve room for the select marker and the LeftBar gutter.
  const labelWidth = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 80) - 5);

  const items = [
    { label: 'Approve once', value: 'approve_once' as const },
    { label: sessionApprovalLabel, value: 'approve_session' as const },
    { label: 'Reject', value: 'reject' as const },
  ];

  return (
    <LeftBar color={theme.border} marginTop={compact ? 0 : 1} marginBottom={compact ? 0 : 1}>
      <Text color={theme.text} bold>Approval Required</Text>
      <Text color={theme.muted} wrap="truncate-end">{request.description}</Text>
      {request.detail && (
        <Text color={theme.dim} wrap="truncate-end">{request.detail}</Text>
      )}
      <Box marginTop={compact ? 0 : 1}>
        <Select
          options={items.map((item) => ({ value: item.value, label: fitLabel(item.label, labelWidth) }))}
          onChange={(value) => onRespond(value as ApprovalResponse)}
        />
      </Box>
    </LeftBar>
  );
};
