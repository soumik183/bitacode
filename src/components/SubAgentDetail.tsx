/**
 * SubAgentDetail — full transcript inspector for ONE sub-agent run.
 *
 * Owns its own keyboard input: the orchestrator disables App's global useInput
 * while this card is open, so arrow/page/s/r/esc all land here. The outer box is
 * pinned to the exact row budget handed in by the parent; only the body scrolls.
 */
import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme, type Theme } from '../theme.js';
import type { SubAgentMessage, SubAgentRunRecord } from '../utils/subagent-store.js';
import { renderFormattedText } from '../utils/format-message.js';
import { dialogWidth, dialogInnerWidth, HintLine } from './Dialog.js';
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

const MAX_RESULT_LINES = 8;
const MAX_ARG_CHARS = 120;
const MAX_PATH_ARG_CHARS = 240;
const GAP = 1;
const HINT = '↑↓ scroll · pgup/pgdn page · s system · r results · esc back';

/** Rough row count for plain text at a given width (used to budget the window). */
function estimateRows(text: string, width: number): number {
  const w = Math.max(1, Math.floor(width));
  return String(text ?? '')
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / w)), 0);
}

/** Fenced code and tables paint a couple of extra chrome rows per block. */
function estimateFormattedRows(text: string, width: number): number {
  const fences = (String(text ?? '').match(/^\s*(?:```|~~~)/gm) ?? []).length;
  return estimateRows(text, width) + fences * 2;
}

/** All key/value pairs of a tool call's JSON argument blob, each on one line. */
function parseArguments(raw?: string): Array<[string, string]> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
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

function isErrorResult(content: string): boolean {
  return /^\s*(?:Error:|File not found|Operation cancelled|✗)/i.test(content ?? '');
}

/** Short local clock time, without a date or AM/PM suffix. */
function localTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour12: false });
  } catch {
    return '';
  }
}

interface BuildArgs {
  messages: SubAgentMessage[];
  theme: Theme;
  innerWidth: number;
  systemExpanded: boolean;
  resultsExpanded: boolean;
}

/**
 * Turn the transcript into row-budgeted blocks. Each block renders as a fixed
 * number of single-row <Text> lines (plus one gap row) so the estimate used for
 * scrolling matches what Ink actually paints.
 */
function buildBlocks({ messages, theme, innerWidth, systemExpanded, resultsExpanded }: BuildArgs): Block[] {
  const blocks: Block[] = [];
  const matched = new Set<number>();

  // A result explicitly linked by tool_call_id belongs to that call; a call
  // without an id must never claim it through the positional fallback.
  const linkedIds = new Set<string>();
  for (const msg of messages) {
    for (const call of msg.tool_calls ?? []) {
      const id = call.id ?? msg.tool_call_id;
      if (id) linkedIds.add(id);
    }
  }

  const push = (key: string, nodeRows: number, node: React.ReactNode): void => {
    blocks.push({ key, rows: nodeRows + GAP, node });
  };

  const findResultStart = (callId: string | undefined, after: number): number => {
    if (callId) {
      const direct = messages.findIndex(
        (msg, index) =>
          index > after && !matched.has(index) && msg.role === 'tool' && msg.tool_call_id === callId
      );
      if (direct >= 0) return direct;
    }
    // Fallback: the NEXT unmatched tool message strictly after the assistant
    // message, and never one already linked to a (possibly later) call.
    return messages.findIndex(
      (msg, index) =>
        index > after &&
        !matched.has(index) &&
        msg.role === 'tool' &&
        !(msg.tool_call_id && linkedIds.has(msg.tool_call_id))
    );
  };

  const resultNode = (
    msg: SubAgentMessage,
    standalone: boolean,
    fallbackName?: string
  ): { rows: number; node: React.ReactNode } => {
    const allLines = msg.content.replace(/\n+$/, '').split('\n');
    const lines = resultsExpanded ? allLines : allLines.slice(0, MAX_RESULT_LINES);
    const hidden = Math.max(0, allLines.length - lines.length);
    const isError = isErrorResult(msg.content);
    const prefix = standalone ? '▸ ' : isError ? '✗ ' : '✓ ';
    const link = [msg.name ?? fallbackName, msg.tool_call_id ? `#${msg.tool_call_id}` : '']
      .filter(Boolean)
      .join(' ');
    const label = `result${link ? ` ← ${link}` : ''}${hidden > 0 ? ' · r full' : ''}`;
    const nodeRows = 1 + lines.length + (hidden > 0 ? 1 : 0);
    return {
      rows: nodeRows,
      node: (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={theme.info}>│ </Text>
            <Text color={isError ? theme.error : theme.success}>{prefix}</Text>
            <Text color={theme.dim}>{label}</Text>
          </Text>
          {lines.map((line, index) => (
            <Text key={index} color={isError ? theme.error : theme.muted} wrap="truncate-end">
              {`│ ${line}`}
            </Text>
          ))}
          {hidden > 0 ? (
            <Text color={theme.dim} wrap="truncate-end">{`│   … ${hidden} more lines`}</Text>
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
            <Text color={theme.dim} wrap="wrap">{msg.content}</Text>
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

        const result = resultMsg ? resultNode(resultMsg, false, name) : null;
        const nodeRows = 1 + args.length + (result ? result.rows : 0);
        push(`call-${index}-${callIndex}`, nodeRows, (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={theme.info}>│ ◆ </Text>
              <Text color={theme.text} bold>{name}</Text>
              {callId ? <Text color={theme.dim}>{`  ${callId.slice(0, 8)}`}</Text> : null}
            </Text>
            {args.map(([key, value], argIndex) => {
              const cap = isPathKey(key) ? MAX_PATH_ARG_CHARS : MAX_ARG_CHARS;
              const shown = value.length > cap ? `${value.slice(0, cap - 1)}…` : value;
              return (
                <Text key={argIndex} wrap="truncate-end">
                  <Text color={theme.info}>│ </Text>
                  <Text color={theme.dim}>{`  ${key}: `}</Text>
                  <Text color={isPathKey(key) ? theme.accent : theme.muted}>{shown}</Text>
                </Text>
              );
            })}
            {result ? result.node : null}
          </Box>
        ));
      });

      if (msg.content && msg.content.trim()) {
        push(`assistant-${index}`, estimateFormattedRows(msg.content, innerWidth), (
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
  const [resultsExpanded, setResultsExpanded] = React.useState(false);

  const totalHeight = Math.max(1, Math.floor(height));
  // Short terminals drop the border and rules: header + body + hint only.
  const compact = totalHeight < 12;
  const cardWidth = dialogWidth(columns);
  const innerWidth = compact ? Math.max(1, cardWidth - 2) : dialogInnerWidth(columns);
  const bodyWidth = Math.max(1, innerWidth - 1); // 1 column for the scrollbar rail
  // Normal: border (2) + header (2) + two rules (2) + hint (1). Compact: header + hint.
  const bodyRows = Math.max(1, totalHeight - (compact ? 2 : 7));
  const messages = record.messages ?? [];

  const rowsFor = (sys: boolean, res: boolean): number =>
    buildBlocks({ messages, theme, innerWidth: bodyWidth, systemExpanded: sys, resultsExpanded: res })
      .reduce((sum, block) => sum + block.rows, 0);

  const blocks = React.useMemo(
    () => buildBlocks({ messages, theme, innerWidth: bodyWidth, systemExpanded, resultsExpanded }),
    [record, theme, bodyWidth, systemExpanded, resultsExpanded]
  );
  const totalRows = blocks.reduce((sum, block) => sum + block.rows, 0);
  const maxScrollTop = Math.max(0, totalRows - bodyRows);
  // Snap to a block boundary: rendering a partially visible block inside a
  // fixed-height scroll box makes Ink merge rows of nested <Text> nodes (the
  // result was unreadable). Whole-block paging is predictable and never clips.
  const top = (() => {
    let offset = 0;
    for (const block of blocks) {
      if (offset + block.rows > Math.min(scrollTop, maxScrollTop)) return offset;
      offset += block.rows;
    }
    return offset;
  })();

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
      const next = !systemExpanded;
      // Clamp in this handler so collapsing a tall block cannot leave a jumpy gap.
      setScrollTop((prev) => Math.min(prev, Math.max(0, rowsFor(next, resultsExpanded) - bodyRows)));
      setSystemExpanded(next);
      return;
    }
    if (input === 'r' || input === 'R') {
      const next = !resultsExpanded;
      setScrollTop((prev) => Math.min(prev, Math.max(0, rowsFor(systemExpanded, next) - bodyRows)));
      setResultsExpanded(next);
    }
  });

  // Only render whole blocks that start inside the viewport. The first visible
  // block starts exactly at `top`, so no negative margin and no clipped child.
  let cursor = 0;
  const visible: Block[] = [];
  for (const block of blocks) {
    if (cursor >= top + bodyRows) break;
    if (cursor >= top) visible.push(block);
    cursor += block.rows;
  }

  const rail = scrollbarGeometry(totalRows, bodyRows, maxScrollTop - top);
  const railLines = scrollbarLines(rail);
  const rule = '─'.repeat(Math.max(1, innerWidth));

  const status = STATUS[record.status] ?? STATUS.error;
  const durationMs = Math.max(0, (record.endedAt ?? Date.now()) - record.startedAt);
  const duration = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
  const timeText = `${localTime(record.startedAt)}→${record.endedAt ? localTime(record.endedAt) : 'now'} ${duration}`;
  const idShort = `#${record.id.slice(-8)}`;
  const label = record.label && record.label !== record.task ? record.label : '';
  const usage = record.usage;
  const usageText = usage
    ? `in ${usage.inputTokens} / out ${usage.outputTokens} / total ${usage.totalTokens} / $${usage.estimatedCost.toFixed(2)}`
    : '';
  const borderProps = compact
    ? {}
    : { borderStyle: 'round' as const, borderColor: theme.border, paddingX: 1 };

  return (
    <Box
      flexDirection="column"
      width={cardWidth}
      height={totalHeight}
      flexShrink={0}
      overflow="hidden"
      {...borderProps}
      backgroundColor={theme.surface}
    >
      {/* summary header — 2 rows normally, 1 when compact */}
      <Box flexDirection={compact ? 'row' : 'column'} flexShrink={0} overflow="hidden">
        <Box flexDirection="row" overflow="hidden">
          <Box flexShrink={0}><Text color={theme[status.color]} bold>{`${status.icon} ${status.label}`}</Text></Box>
          {record.agentType ? (
            <Box flexShrink={0}><Text color={theme.accent}>{` [${record.agentType}]`}</Text></Box>
          ) : null}
          {label ? <Box flexShrink={0}><Text color={theme.dim}>{` ${label} ·`}</Text></Box> : null}
          <Box flexShrink={1} minWidth={1}>
            <Text color={theme.text} wrap="truncate-end">{` ${record.task}`}</Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}><Text color={theme.dim}>{idShort}</Text></Box>
          <Box flexShrink={0} marginLeft={1}><Text color={theme.muted}>{`${record.messageCount} msgs`}</Text></Box>
        </Box>
        {!compact ? (
          <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
            <Box flexDirection="row" flexShrink={1} minWidth={1} overflow="hidden">
              {record.error ? (
                <Text color={theme.error} bold wrap="truncate-end">{`✗ ${record.error}`}</Text>
              ) : null}
              <Text color={theme.muted} wrap="truncate-end">{timeText}</Text>
            </Box>
            {usageText ? (
              <Box flexShrink={0} marginLeft={1}>
                <Text color={theme.muted} wrap="truncate-end">{usageText}</Text>
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>

      {!compact ? <Text color={theme.border} wrap="truncate-end">{rule}</Text> : null}

      {/* scrollable body */}
      <Box flexDirection="row" height={bodyRows} flexShrink={0} overflow="hidden">
        <Box flexDirection="column" width={bodyWidth} height={bodyRows} flexShrink={0} overflow="hidden">
          {visible.length === 0 ? (
            <Text color={theme.dim} wrap="truncate-end">No transcript recorded.</Text>
          ) : (
            visible.map((block) => (
              <Box key={block.key} flexDirection="column" flexShrink={0}>
                {block.node}
                <Box height={GAP} flexShrink={0} />
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

      {!compact ? <Text color={theme.border} wrap="truncate-end">{rule}</Text> : null}

      <Box flexShrink={0}>
        <HintLine hint={HINT} compact={compact} />
      </Box>
    </Box>
  );
};

export default SubAgentDetail;
