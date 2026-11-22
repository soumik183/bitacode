import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import type { ReadSummary } from '../utils/file-diff.js';

export interface ReadSummaryViewProps {
  summary: ReadSummary;
  error?: string;
}

/** One-line transcript summary for a file read: no box, no code. */
export const ReadSummaryView: React.FC<ReadSummaryViewProps> = ({ summary, error }) => {
  const theme = useTheme();
  const path = summary?.filePath || 'file';
  const meta = error
    ? error
    : summary?.empty
      ? 'empty'
      : typeof summary?.total === 'number'
        ? `${summary.total} lines`
        : summary?.range
          ? summary.range
          : 'empty';
  const highlight = !error && !summary?.empty && (Boolean(summary?.range) || typeof summary?.total === 'number');

  return (
    <Box paddingX={2} marginBottom={1} overflow="hidden">
      <Text wrap="truncate-end">
        <Text color={theme.info}>{'▤ '}</Text>
        <Text color={theme.text}>{path}</Text>
        <Text color={theme.dim}>{' · '}</Text>
        <Text color={error ? theme.error : highlight ? theme.accent : theme.dim}>{meta}</Text>
      </Text>
    </Box>
  );
};

export default ReadSummaryView;
