import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { formatDuration } from '../utils/duration.js';

export interface ThinkingArchiveProps {
  text: string;
  elapsedMs: number;
  /** Terminal width, so the preview can use the full row instead of a fixed cut. */
  columns?: number;
}

/** Fixed slice used only when no terminal width is known. */
const FALLBACK_PREVIEW_CHARS = 240;

/** Characters that fit on one archive line, allowing for the indent and ellipsis. */
export function archivePreviewChars(columns?: number): number {
  if (!columns || columns <= 0) return FALLBACK_PREVIEW_CHARS;
  return Math.max(40, columns - 6);
}

/**
 * One-line record of a completed reasoning phase. Printed before the response
 * or tool result that followed it, so scrollback stays in chronological order.
 * The preview fills the available width rather than being cut at a fixed 240
 * characters, which used to truncate the useful part of long thoughts.
 */
export const ThinkingArchive: React.FC<ThinkingArchiveProps> = ({ text, elapsedMs, columns }) => {
  const reasoning = text.trim();
  if (!reasoning) return null;

  const singleLine = reasoning.replace(/\s+/g, ' ');
  const limit = archivePreviewChars(columns);
  const preview = singleLine.length > limit ? singleLine.slice(0, limit).trimEnd() : singleLine;
  const cutoff = singleLine.length > limit;

  return (
    <Box flexDirection="column" paddingX={2} marginBottom={1}>
      <Text wrap="truncate-end">
        <Text color={theme.dim}>▸ </Text>
        <Text color={theme.muted}>Thought</Text>
        <Text color={theme.dim}>
          {`  ${formatDuration(elapsedMs)} · ${reasoning.length} char${reasoning.length === 1 ? '' : 's'}`}
        </Text>
      </Text>
      <Text color={theme.dim} wrap="truncate-end">
        {preview}
        {cutoff ? '…' : ''}
      </Text>
    </Box>
  );
};
