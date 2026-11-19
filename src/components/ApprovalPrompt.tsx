import React, { useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { Select } from '@inkjs/ui';
import { LeftBar } from './LeftBar.js';
import { useTheme } from '../theme.js';
import type { ApprovalRequest, ApprovalResponse } from '../utils/approval.js';

export interface ApprovalPromptProps {
  request: ApprovalRequest;
  /** Terminal columns, used to keep option labels inside the screen. */
  columns?: number;
  /** Short terminals drop the decorative margins so no option is clipped. */
  compact?: boolean;
  /** Rows the modal may use. App passes the full terminal height. */
  rows?: number;
  /** Rendered inside a Dialog that already supplies the title and hint. */
  embedded?: boolean;
  onRespond: (response: ApprovalResponse) => void;
}

const OPTIONS = [
  { label: 'Approve once', value: 'approve_once' },
  { label: 'Approve session', value: 'approve_session' },
  { label: 'Reject', value: 'reject' },
] as const;

/** Cut a label to a display-column budget (approval options must stay one row). */
function fit(text: string, max: number): string {
  const limit = Math.max(1, Math.floor(Number.isFinite(max) ? max : 80));
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= limit) return single;
  if (limit === 1) return '…';
  return `${single.slice(0, limit - 1)}…`;
}

/**
 * Interactive approval prompt. Select owns arrows/enter; this component owns
 * the 1/2/3 and Esc shortcuts. App ignores every key while approval is pending.
 */
export const ApprovalPrompt: React.FC<ApprovalPromptProps> = ({
  request, columns = 80, compact = false, rows = 24, embedded = false, onRespond,
}) => {
  const theme = useTheme();
  // A digit and Enter can arrive in one burst; settle at most once per prompt.
  const settledRef = useRef(false);
  const respond = useCallback((response: ApprovalResponse) => {
    if (settledRef.current) return;
    settledRef.current = true;
    onRespond(response);
  }, [onRespond]);

  const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  const height = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
  const showNumbers = cols >= 28;
  // LeftBar gutter (2) + Select pointer/padding (2) + the "1. " number prefix.
  const labelWidth = Math.max(1, cols - 4 - (showNumbers ? 3 : 0));
  const showHint = !embedded && height >= 5;
  // Header + three options + hint are fixed; the remainder is the detail budget.
  const detailRows = Math.max(
    0,
    Math.min(compact ? 1 : 2, height - 1 - OPTIONS.length - (showHint ? 1 : 0))
  );
  const detailWidth = Math.max(1, cols - 2);
  const description = request.description.replace(/\s+/g, ' ').trim();
  const details = String(request.detail ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  // One row cannot hold both: prefer the command/path being approved on narrow
  // screens, and combine description + detail when there is room.
  const detailLines = detailRows === 1
    ? [cols < 32 ? (details[0] ?? description) : [description, details[0]].filter(Boolean).join(': ')]
    : [description, ...details];
  const shownDetail = detailLines.slice(0, detailRows).map((line) => fit(line, detailWidth));
  if (detailRows > 0 && detailLines.length > detailRows) {
    shownDetail[detailRows - 1] = fit(`${shownDetail[detailRows - 1]}…`, detailWidth);
  }
  // Keep the hint on one row even on phone-width terminals.
  const hint = cols >= 32
    ? '↑↓/1-3 · enter · esc reject'
    : cols >= 24
      ? '↑↓ · enter · esc reject'
      : '↑↓ · enter · esc';

  useInput((input, key) => {
    if (/^[1-3]$/.test(input)) {
      respond(OPTIONS[Number(input) - 1].value);
      return;
    }
    if (key.escape) respond('reject');
  });

  return (
    <LeftBar color={theme.accent}>
      <Box flexDirection="column">
        {!embedded && (
          <Text color={theme.text} bold wrap="truncate-end">
            {showHint ? 'Approval Required' : `Approval Required · ${hint}`}
          </Text>
        )}
        {shownDetail.map((line, index) => (
          <Text key={index} color={index === 0 ? theme.muted : theme.dim} wrap="truncate-end">
            {line}
          </Text>
        ))}
        <Select
          options={OPTIONS.map((option, index) => ({
            value: option.value,
            label: `${showNumbers ? `${index + 1}. ` : ''}${fit(option.label, labelWidth)}`,
          }))}
          onChange={(value) => respond(value as ApprovalResponse)}
        />
        {showHint && (
          <Text color={theme.dim} wrap="truncate-end">{hint}</Text>
        )}
      </Box>
    </LeftBar>
  );
};
