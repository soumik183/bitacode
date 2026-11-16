import React from 'react';
import { Box, Text } from 'ink';
import { Select } from '@inkjs/ui';
import { LeftBar } from './LeftBar.js';
import { theme } from '../theme.js';
import type { ApprovalRequest, ApprovalResponse } from '../utils/approval.js';

export interface ApprovalPromptProps {
  request: ApprovalRequest;
  onRespond: (response: ApprovalResponse) => void;
}

/**
 * Interactive approval prompt rendered inline.
 */
export const ApprovalPrompt: React.FC<ApprovalPromptProps> = ({ request, onRespond }) => {
  const sessionApprovalLabel = request.sessionScopeKey
    ? 'Approve this operation for session'
    : `Approve all "${request.type}" for session`;

  const items = [
    { label: 'Approve once', value: 'approve_once' as const },
    { label: sessionApprovalLabel, value: 'approve_session' as const },
    { label: 'Reject', value: 'reject' as const },
  ];

  return (
    <LeftBar color={theme.border} marginTop={1} marginBottom={1}>
      <Text color={theme.text} bold>Approval Required</Text>
      <Text color={theme.muted}>{request.description}</Text>
      {request.detail && (
        <Text color={theme.dim}>{request.detail.length > 200 ? request.detail.slice(0, 200) + '...' : request.detail}</Text>
      )}
      <Box marginTop={1}>
        <Select
          options={items.map((item) => ({ value: item.value, label: item.label }))}
          onChange={(value) => onRespond(value as ApprovalResponse)}
        />
      </Box>
    </LeftBar>
  );
};
