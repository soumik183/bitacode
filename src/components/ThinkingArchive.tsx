import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { formatDuration } from '../utils/duration.js';

export interface ThinkingArchiveProps {
  text: string;
  elapsedMs: number;
  /** Terminal width, so the preview can use the full row instead of a fixed cut. */
  columns?: number;
  /** Full reasoning is shown when the user clicks the archived block. */
  expanded?: boolean;
}

/** Fixed slice used only when no terminal width is known. */
const FALLBACK_PREVIEW_CHARS = 240;

/** How many reasoning lines the collapsed preview keeps before the "more" note. */
const PREVIEW_LINE_BUDGET = 6;

/** Characters that fit on one archive line, allowing for the indent and ellipsis. */
export function archivePreviewChars(columns?: number): number {
  if (!columns || columns <= 0) return FALLBACK_PREVIEW_CHARS;
  // Never exceed the screen: an old 40-column floor wrapped long thought lines
  // into a dozen rows on narrow/zoomed terminals.
  return Math.max(1, Math.floor(columns) - 6);
}

/**
 * Record of a completed reasoning phase. The collapsed view keeps the first
 * few lines of thought intact — one line per row — instead of flattening them
 * into a single unreadable string. Clicking expands every line in place.
 */
export const ThinkingArchive: React.FC<ThinkingArchiveProps> = ({
  text,
  elapsedMs,
  columns,
  expanded = false,
}) => {
  const theme = useTheme();
  const reasoning = text.trim();
  if (!reasoning) return null;

  // Keep the original line structure: no `/\s+/g` flattening.
  const lines = reasoning.split('\n').map((line) => line.trimEnd());
  const lineCap = archivePreviewChars(columns);
  const shownLines = expanded ? lines : lines.slice(0, PREVIEW_LINE_BUDGET);
  const hiddenLines = lines.length - shownLines.length;
  const hint = expanded ? 'click to collapse' : 'click to expand';

  return (
    <Box flexDirection="column" paddingX={2} marginBottom={1}>
      <Text wrap="truncate-end">
        <Text color={theme.muted}>{expanded ? '▾ ' : '▸ '}</Text>
        <Text color={theme.muted}>Thought</Text>
        <Text color={theme.dim}>
          {`  ${formatDuration(elapsedMs)} · ${reasoning.length} char${reasoning.length === 1 ? '' : 's'}`}
        </Text>
        <Text color={theme.dim}>{`  ${hint}`}</Text>
      </Text>
      {shownLines.map((line, index) => {
        // Bound each collapsed line to one row so the card can't grow the frame.
        const clipped = !expanded && line.length > lineCap
          ? `${line.slice(0, lineCap).trimEnd()}…`
          : line;
        return (
          <Text key={index} color={theme.muted} wrap={expanded ? 'wrap' : 'truncate-end'}>
            {clipped || ' '}
          </Text>
        );
      })}
      {hiddenLines > 0 && (
        <Text color={theme.dim}>
          {`… ${hiddenLines} more line${hiddenLines === 1 ? '' : 's'} · click to expand`}
        </Text>
      )}
    </Box>
  );
};
