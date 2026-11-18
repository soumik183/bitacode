import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { annotateDiff, displayFilePath, type DiffLine } from '../utils/file-diff.js';
import { detectLanguage, safeHighlight, type HighlightLanguage } from '../utils/code-highlight.js';
import { TokenText } from './CodeBlock.js';

export interface DiffViewProps {
  header: string;
  diff: string;
  filePath?: string;
  operation?: 'Edited' | 'Wrote';
  /** Override syntax language; inferred from filePath by default. */
  language?: HighlightLanguage | string;
  /** Hard cap on rendered diff rows (used by the live streaming preview). */
  maxRows?: number;
}

const MAX_VISIBLE_LINES = 24;

function lineColor(line: DiffLine): string {
  if (line.kind === 'add') return theme.success;
  if (line.kind === 'remove') return theme.error;
  if (line.kind === 'context') return theme.muted;
  if (line.kind === 'hunk') return theme.info;
  return theme.dim;
}

/**
 * Compact, colour-coded unified diff for edit_file/write_file results.
 * Green additions, red removals and file line numbers in a bordered card.
 */
export const DiffView: React.FC<DiffViewProps> = ({ header, diff, filePath, operation, language: languageOverride, maxRows }) => {
  const lines = annotateDiff(diff);
  const additions = lines.filter((line) => line.kind === 'add').length;
  const removals = lines.filter((line) => line.kind === 'remove').length;
  const visibleLimit = Math.max(1, Math.min(MAX_VISIBLE_LINES, Math.floor(Number.isFinite(maxRows) ? maxRows! : MAX_VISIBLE_LINES)));
  const shown = lines.slice(0, visibleLimit);
  const hidden = lines.length - shown.length;
  const language = languageOverride ?? detectLanguage(filePath);
  // Highlight once per diff, not per render. Syntax colours sit on top of the
  // green/red line tint: uncoloured tokens inherit `baseColor` below.
  const tokens = React.useMemo(
    () => shown.map((line) => safeHighlight(line.text, language)[0] ?? [{ text: line.text }]),
    [diff, language]
  );
  const gutter = Math.max(2, ...shown.map((line) => (line.number == null ? 0 : String(line.number).length)));
  const summary = header
    .replace(/^Successfully (edited|wrote) /i, (_, verb: string) => (verb.toLowerCase() === 'edited' ? 'Edited ' : 'Wrote '))
    .replace(/\.$/, '');
  const path = filePath ? displayFilePath(filePath) : '';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      marginY={1}
      width="100%"
    >
      <Text wrap="truncate-end">
        <Text color={theme.success}>✓ </Text>
        <Text color={theme.text} bold>{operation ?? summary}</Text>
        {path && <Text color={theme.muted}>{`  ${path}`}</Text>}
        {additions > 0 && <Text color={theme.success}>{`  +${additions}`}</Text>}
        {removals > 0 && <Text color={theme.error}>{`  -${removals}`}</Text>}
      </Text>

      {shown.map((line, index) => {
        const color = lineColor(line);
        if (line.kind === 'hunk') {
          return (
            <Text key={index} color={color} wrap="truncate-end">
              {`${' '.repeat(gutter)}  ${line.text}`}
            </Text>
          );
        }
        if (line.number == null) {
          return (
            <Text key={index} color={color} wrap="truncate-end">
              {`${' '.repeat(gutter)}  ${line.text}`}
            </Text>
          );
        }
        const sign = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
        return (
          <Text key={index} wrap="truncate-end">
            <Text color={color}>{String(line.number).padStart(gutter)}</Text>
            <Text color={theme.dim}>{'  '}</Text>
            <Text color={color}>{`${sign} `}</Text>
            <TokenText tokens={tokens[index] ?? [{ text: line.text }]} baseColor={color} />
          </Text>
        );
      })}

      {hidden > 0 && (
        <Text color={theme.dim}>{`${' '.repeat(gutter)}  … ${hidden} more line${hidden === 1 ? '' : 's'}`}</Text>
      )}
    </Box>
  );
};
