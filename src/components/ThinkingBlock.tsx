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

/** How many content rows the expanded panel may use at this terminal size. */
function previewRowBudget(rows: number): number {
  return Math.max(2, Math.min(8, rows - 14));
}

function previewMaxChars(columns: number, rows: number): number {
  return Math.max(200, Math.min(1600, Math.max(20, columns - 8) * previewRowBudget(rows)));
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
  rows: number
): number {
  const hasText = text.trim().length > 0;
  // The component renders nothing at all without reasoning text.
  if (!hasText) return 0;
  // Collapsed: header + bottom margin.
  if (!expanded) return 2;
  const width = Math.max(1, columns - 6);
  const { shown, hiddenChars } = clipToPreview(
    text,
    width,
    previewRowBudget(rows),
    previewMaxChars(columns, rows)
  );
  // Count the wrapped rows clipToPreview kept, plus its overflow note. The
  // content rows were omitted before, so a long thought under-reserved up to
  // `budget` rows and clicks missed the top of the expanded block.
  const contentRows =
    shown.split('\n').reduce(
      (total, line) => total + Math.max(1, Math.ceil(Math.max(1, line.length) / width)),
      0
    ) + (hiddenChars > 0 ? 1 : 0);
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
  rows,
  elapsedMs = 0,
}) => {
  const theme = useTheme();
  const hasText = text.trim().length > 0;
  // No provider reasoning means nothing to show. Rendering an empty header
  // here would claim the model is thinking when it sent no reasoning at all.
  if (!hasText) return null;
  const dots = active ? (animate ? '.'.repeat((frame % 3) + 1).padEnd(3) : '...') : '';
  const label = active ? 'Thinking' : 'Thought';

  const maxChars = previewMaxChars(columns, rows);
  const contentWidth = Math.max(1, columns - 6);
  const { shown, hiddenChars } = clipToPreview(text, contentWidth, previewRowBudget(rows), maxChars);

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

      {expanded && hasText && (
        <Box paddingLeft={2} marginTop={1}>
          <Text color={theme.muted} wrap="wrap">
            {shown}
            {hiddenChars > 0 ? `\n… ${hiddenChars} more characters` : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
};
