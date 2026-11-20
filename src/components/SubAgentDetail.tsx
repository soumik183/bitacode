/**
 * SubAgentDetail — full transcript inspector for ONE sub-agent run.
 *
 * Owns its own keyboard input: the orchestrator disables App's global useInput
 * while this card is open, so arrow/page/s/esc all land here. The outer box is
 * pinned to the exact row budget handed in by the parent; only the body scrolls.
 */
import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme, type Theme } from '../theme.js';
import type { SubAgentMessage, SubAgentRunRecord } from '../utils/subagent-store.js';
import { renderFormattedText } from '../utils/format-message.js';
import { dialogWidth, dialogInnerWidth, HintLine } from './Dialog.js';
import { LeftBar } from './LeftBar.js';
import { scrollbarGeometry, scrollbarLines, SCROLLBAR_THUMB } from '../utils/scrollbar.js';

export interface SubAgentDetailProps {
  record: SubAgentRunRecord;
  columns: number;
  /** Exact rows available for the whole detail body (including its border). */
  height: number;
  /** Called on Escape. */
  onBack: () => void;
}

interface Block {
  key: string;
  /** Rows this block occupies, including its trailing one-row gap. */
  rows: number;
  node: React.ReactNode;
}

const STATUS: Record<SubAgentRunRecord['status'], { icon: string; label: string; color: keyof Theme }> = {
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
function estimateRows(text: string, width: number): number {
  const w = Math.max(1, Math.floor(width));
  return String(text ?? '')
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / w)), 0);
}

function compactTokens(n: number | undefined): string {
  if (!n || !Number.isFinite(n) || n <= 0) return '';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** First few key/value pairs of a tool call's JSON argument blob. */
function parseArguments(raw?: string): Array<[string, string]> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>).slice(0, MAX_ARGS).map(([key, value]) => {
      let text: string;
      if (typeof value === 'string') text = value;
      else {
        try {
          text = JSON.stringify(value) ?? String(value);
        } catch {
          text = String(value);
        }
      }
      return [key, text.replace(/\s+/g, ' ').trim()] as [string, string];
    });
  } catch {
    // A truncated argument blob is common while a run is still streaming.
    return [];
  }
}

function isPathKey(key: string): boolean {
  return key === 'path' || key === 'file_path' || key === 'filePath' || key === 'filename';
}

interface BuildArgs {
  messages: SubAgentMessage[];
  theme: Theme;
  innerWidth: number;
  systemExpanded: boolean;
}

/**
 * Turn the transcript into row-budgeted blocks. Each block renders as a fixed
 * number of single-row <Text> lines (plus one gap row) so the estimate used for
 * scrolling matches what Ink actually paints.
 */
function buildBlocks({ messages, theme, innerWidth, systemExpanded }: BuildArgs): Block[] {
  const blocks: Block[] = [];
  const matched = new Set<number>();

  const push = (key: string, nodeRows: number, node: React.ReactNode): void => {
    blocks.push({ key, rows: nodeRows + GAP, node });
  };

  const findResultStart = (callId: string | undefined, after: number): number => {
    if (callId) {
      const direct = messages.findIndex(
        (msg, index) =>
          !matched.has(index) && msg.role === 'tool' && msg.tool_call_id === callId
      );
      if (direct >= 0) return direct;
    }
    // Fallback: the next tool message that no call has claimed yet.
    return messages.findIndex(
      (msg, index) => index > after && !matched.has(index) && msg.role === 'tool'
    );
  };

  const resultNode = (
    msg: SubAgentMessage,
    standalone: boolean
  ): { rows: number; node: React.ReactNode } => {
    const lines = msg.content.replace(/\n+$/, '').split('\n');
    const shown = lines.slice(0, MAX_RESULT_LINES);
    const hidden = Math.max(0, lines.length - shown.length);
    const isError = /^\s*Error:/i.test(msg.content);
    const prefix = standalone ? '▸ ' : isError ? '✗ ' : '✓ ';
    const label = standalone ? `${msg.name ? `${msg.name} ` : ''}result` : 'result';
    const nodeRows = 1 + shown.length + (hidden > 0 ? 1 : 0);
    return {
      rows: nodeRows,
      node: (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={isError ? theme.error : theme.success}>{prefix}</Text>
            <Text color={theme.dim}>{label}</Text>
          </Text>
          {shown.map((line, index) => (
            <Text key={index} color={isError ? theme.error : theme.muted} wrap="truncate-end">
              {line}
            </Text>
          ))}
          {hidden > 0 ? (
            <Text color={theme.dim} wrap="truncate-end">{`  … ${hidden} more lines`}</Text>
          ) : null}
        </Box>
      ),
    };
  };

  messages.forEach((msg, index) => {
    if (msg.role === 'system') {
      if (!systemExpanded) {
        push(`sys-${index}`, 1, (
          <Text color={theme.dim} wrap="truncate-end">
            {`▸ System prompt · ${msg.content.length} chars — press s to expand`}
          </Text>
        ));
      } else {
        push(`sys-${index}`, 1 + estimateRows(msg.content, innerWidth), (
          <Box flexDirection="column">
            <Text color={theme.dim} wrap="truncate-end">▾ System prompt</Text>
            <Text color={theme.dim}>{msg.content}</Text>
          </Box>
        ));
      }
      return;
    }

    if (msg.role === 'user') {
      push(`user-${index}`, 1 + estimateRows(msg.content, innerWidth), (
        <Box flexDirection="column">
          <Text color={theme.accent} bold wrap="truncate-end">You</Text>
          <Text>{renderFormattedText(msg.content, innerWidth, theme)}</Text>
        </Box>
      ));
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
        if (resultMsg) matched.add(resultIndex);

        const result = resultMsg ? resultNode(resultMsg, false) : null;
        const nodeRows = 1 + args.length + (result ? result.rows : 0);
        push(`call-${index}-${callIndex}`, nodeRows, (
          <LeftBar color={theme.info}>
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={theme.info}>◆ </Text>
                <Text color={theme.text} bold>{name}</Text>
                {callId ? <Text color={theme.dim}>{`  ${callId.slice(0, 8)}`}</Text> : null}
              </Text>
              {args.map(([key, value], argIndex) => {
                const cap = isPathKey(key) ? MAX_ARG_CHARS * 2 : MAX_ARG_CHARS;
                const shown = value.length > cap ? `${value.slice(0, cap - 1)}…` : value;
                return (
                  <Text key={argIndex} wrap="truncate-end">
                    <Text color={theme.dim}>{`  ${key}: `}</Text>
                    <Text color={isPathKey(key) ? theme.accent : theme.muted}>{shown}</Text>
                  </Text>
                );
              })}
              {result ? result.node : null}
            </Box>
          </LeftBar>
        ));
      });

      if (msg.content && msg.content.trim()) {
        push(`assistant-${index}`, estimateRows(msg.content, innerWidth), (
          <Text>{renderFormattedText(msg.content, innerWidth, theme)}</Text>
        ));
      }
      return;
    }

    if (msg.role === 'tool') {
      if (matched.has(index)) return;
      const result = resultNode(msg, true);
      push(`tool-${index}`, result.rows, result.node);
    }
  });

  return blocks;
}

export const SubAgentDetail: React.FC<SubAgentDetailProps> = ({ record, columns, height, onBack }) => {
  const theme = useTheme();
  const [scrollTop, setScrollTop] = React.useState(0);
  const [systemExpanded, setSystemExpanded] = React.useState(false);

  const cardWidth = dialogWidth(columns);
  const innerWidth = dialogInnerWidth(columns);
  const bodyWidth = Math.max(1, innerWidth - 1); // 1 column for the scrollbar rail
  const totalHeight = Math.max(1, Math.floor(height));
  // Borders (2) + header (2) + two rules + hint row.
  const bodyRows = Math.max(1, totalHeight - 7);

  const blocks = React.useMemo(
    () => buildBlocks({
      messages: record.messages ?? [],
      theme,
      innerWidth: bodyWidth,
      systemExpanded,
    }),
    [record, theme, bodyWidth, systemExpanded]
  );
  const totalRows = blocks.reduce((sum, block) => sum + block.rows, 0);
  const maxScrollTop = Math.max(0, totalRows - bodyRows);
  const top = Math.min(scrollTop, maxScrollTop);

  React.useEffect(() => {
    if (scrollTop > maxScrollTop) setScrollTop(maxScrollTop);
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
  const visible: Array<{ block: Block; offset: number }> = [];
  for (const block of blocks) {
    const end = cursor + block.rows;
    if (end <= top) {
      cursor = end;
      continue;
    }
    if (cursor >= top + bodyRows) break;
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
  const meta = [ `${record.messageCount} msgs`, duration, tokens ? `${tokens} tok` : '', cost ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Box
      flexDirection="column"
      width={cardWidth}
      height={totalHeight}
      flexShrink={0}
      overflow="hidden"
      borderStyle="round"
      borderColor={theme.border}
      backgroundColor={theme.surface}
      paddingX={1}
    >
      {/* summary header — exactly 2 rows */}
      <Box flexDirection="column" flexShrink={0}>
        <Box flexDirection="row" overflow="hidden">
          <Text color={theme[status.color]} bold wrap="truncate-end">{`${status.icon} ${status.label} `}</Text>
          {record.agentType ? (
            <Text color={theme.accent} wrap="truncate-end">{`[${record.agentType}] `}</Text>
          ) : null}
          <Box flexShrink={1} minWidth={1}>
            <Text color={theme.text} wrap="truncate-end">{record.task}</Text>
          </Box>
        </Box>
        <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
          <Box flexShrink={1} minWidth={1}>
            <Text color={theme.error} wrap="truncate-end">{record.error ?? ''}</Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}>
            <Text color={theme.muted} wrap="truncate-end">{meta}</Text>
          </Box>
        </Box>
      </Box>

      <Text color={theme.border} wrap="truncate-end">{rule}</Text>

      {/* scrollable body */}
      <Box flexDirection="row" height={bodyRows} flexShrink={0} overflow="hidden">
        <Box flexDirection="column" width={bodyWidth} flexShrink={0} overflow="hidden">
          {visible.length === 0 ? (
            <Text color={theme.dim} wrap="truncate-end">No transcript recorded.</Text>
          ) : (
            visible.map(({ block, offset }, index) => (
              <Box
                key={block.key}
                flexDirection="column"
                flexShrink={0}
                marginTop={index === 0 ? -(top - offset) : 0}
                marginBottom={GAP}
              >
                {block.node}
              </Box>
            ))
          )}
        </Box>
        {rail ? (
          <Box flexDirection="column" width={1} flexShrink={0} overflow="hidden">
            {railLines.map((line, rowIndex) => (
              <Text key={rowIndex} color={line === SCROLLBAR_THUMB ? theme.accent : theme.border}>
                {line}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>

      <Text color={theme.border} wrap="truncate-end">{rule}</Text>

      <Box flexShrink={0}>
        <HintLine hint="↑↓ scroll · pgup/pgdn page · s system · esc back" />
      </Box>
    </Box>
  );
};

export default SubAgentDetail;
