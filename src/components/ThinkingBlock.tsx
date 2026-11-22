import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { formatDuration } from '../utils/duration.js';

export interface ThinkingBlockProps {
  text: string;
  expanded: boolean;
  active: boolean;
  animate: boolean;
  frame: number;
  columns: number;
  rows: number;
  elapsedMs?: number;
}

/**
 * Clip reasoning so it occupies at most `maxRows` wrapped rows.
 * The character cap alone is not enough: many short lines can still overflow
 * the budget and blow out the layout, so rows are the real unit of measure.
 */
export function clipToPreview(
  text: string,
  width: number,
  maxRows: number,
  maxChars: number
): { shown: string; hiddenChars: number } {
  const preview = text.trim();
  const charsLimited = preview.length > maxChars ? preview.slice(0, maxChars) : preview;
  const lines = charsLimited.split('\n');
  const kept: string[] = [];
  let rowsUsed = 0;

  for (const line of lines) {
    const lineRows = Math.max(1, Math.ceil(Math.max(1, line.length) / width));
    if (rowsUsed + lineRows > maxRows) {
      // Use whatever space is left on the current row for a partial line.
      const remaining = maxRows - rowsUsed;
      if (remaining > 0) {
        const capacity = remaining * width;
        kept.push(line.slice(0, capacity));
        rowsUsed += remaining;
      }
      break;
    }
    kept.push(line);
    rowsUsed += lineRows;
  }

  const shown = kept.join('\n');
  return { shown, hiddenChars: preview.length - shown.length };
}

/**
 * Upper bound on the rows the thinking block occupies, including its bottom
 * margin. Used by App to size the live area and to hit-test clicks.
 * Wrapped rows cannot be known exactly before layout, so this estimate is
 * deliberately conservative; App refines it with a real measurement.
 */
export function thinkingBlockHeight(
  text: string,
  expanded: boolean,
  columns: number,
  _rows: number
): number {
  const hasText = text.trim().length > 0;
  // The component renders nothing at all without reasoning text.
  if (!hasText) return 0;
  const width = Math.max(1, columns - 6);
  // Collapsed: header + the first reasoning line + bottom margin.
  if (!expanded) {
    const first = text.trim().split('\n')[0] ?? '';
    const firstRows = Math.max(1, Math.ceil(Math.max(1, first.length) / width));
    return 1 + firstRows + 1;
  }
  // Expanded: every line is shown, so count all wrapped rows.
  const contentRows = text.trim().split('\n').reduce(
    (total, line) => total + Math.max(1, Math.ceil(Math.max(1, line.length) / width)),
    0
  );
  // header + marginTop(1) + content + marginBottom(1)
  return 1 + 1 + contentRows + 1;
}

/**
 * Live reasoning preview.
 *
 * While the model is thinking the block is expanded automatically so the
 * reasoning streams in visibly, with animated dots on the header. Once
 * thinking ends it collapses to a plain "Thought · 3s" line (no animation).
 * A left click on the header (or ctrl+t) toggles it.
 */
export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({
  text,
  expanded,
  active,
  animate,
  frame,
  columns,
  rows: _rows,
  elapsedMs = 0,
}) => {
  const theme = useTheme();
  const hasText = text.trim().length > 0;
  // No provider reasoning means nothing to show. Rendering an empty header
  // here would claim the model is thinking when it sent no reasoning at all.
  if (!hasText) return null;
  const dots = active ? (animate ? '.'.repeat((frame % 3) + 1).padEnd(3) : '...') : '';
  const label = active ? 'Thinking' : 'Thought';

  const contentWidth = Math.max(1, columns - 6);
  const lines = text.trim().split('\n');
  const firstLine = lines[0] ?? '';
  const shownFirst = firstLine.length > contentWidth
    ? `${firstLine.slice(0, Math.max(1, contentWidth - 1))}…`
    : firstLine;

  const hint = hasText
    ? `${expanded ? 'click to collapse' : 'click to expand'} · ctrl+t`
    : '';

  return (
    <Box flexDirection="column" paddingX={2} marginBottom={1}>
      <Text wrap="truncate-end">
        <Text color={expanded ? theme.muted : theme.dim}>{expanded ? '▾ ' : '▸ '}</Text>
        <Text color={active ? theme.text : theme.muted} bold={active}>
          {label}
        </Text>
        {active && <Text color={theme.accent}>{dots}</Text>}
        {elapsedMs > 0 && <Text color={theme.dim}>{` · ${formatDuration(elapsedMs)}`}</Text>}
        {hint && <Text color={theme.dim}>{`  ${hint}`}</Text>}
      </Text>

      {!expanded && hasText && (
        <Box paddingLeft={2}>
          <Text color={theme.dim} wrap="truncate-end">{shownFirst}</Text>
        </Box>
      )}

      {expanded && hasText && (
        <Box paddingLeft={2} marginTop={1}>
          <Text color={theme.muted} wrap="wrap">{text.trim()}</Text>
        </Box>
      )}
    </Box>
  );
};
