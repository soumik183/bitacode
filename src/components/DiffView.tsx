import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import type { Theme } from '../theme.js';
import { annotateDiff, displayFilePath, type DiffLine } from '../utils/file-diff.js';
import { diffWords, type WordSegment } from '../utils/word-diff.js';

export interface DiffViewProps {
  header: string;
  diff: string;
  filePath?: string;
  operation?: 'Edited' | 'Wrote' | 'Applied';
  /** Kept for compatibility; diff rows are intentionally monochrome per row. */
  language?: string;
  /** Hard cap on rendered diff rows (used by the live streaming preview). */
  maxRows?: number;
  /** Expanded cards show the whole change instead of the safety ceiling. */
  expanded?: boolean;
  /** Per-file diffs; when present these are rendered under their own headers. */
  entries?: Array<{ filePath?: string; header: string; diff: string }>;
  /** Bold the words that actually changed inside paired remove/add rows. */
  wordHighlight?: boolean;
}

/** Safety ceiling for a collapsed diff; kept as the public export for callers. */
export const DIFF_PREVIEW_LINES = 2000;
/** @deprecated Expansion now shows the whole diff; kept for API compatibility. */
export const DIFF_EXPANDED_MAX_LINES = DIFF_PREVIEW_LINES;

function lineColor(kind: DiffLine['kind'], palette: Theme): string {
  if (kind === 'add') return palette.success;
  if (kind === 'remove') return palette.error;
  if (kind === 'context') return palette.text;
  if (kind === 'hunk') return palette.info;
  return palette.dim;
}

function gutterNumbers(kind: DiffLine['kind'], number: number | undefined, gutter: number) {
  const blank = ' '.repeat(gutter);
  const value = number == null ? '' : String(number).padStart(gutter);
  if (kind === 'add') return { old: blank, next: value };
  if (kind === 'remove') return { old: value, next: blank };
  if (kind === 'context') return { old: value, next: value };
  return { old: blank, next: blank };
}

const signFor = (kind: DiffLine['kind']): string =>
  kind === 'add' ? '+' : kind === 'remove' ? '-' : ' ';

/**
 * Pair each run of removed rows with the following run of added rows (by
 * position in the run) and remember which words changed on each side. Rows
 * that are not part of such a pair keep their plain, single-colour rendering.
 */
function highlightChangedWords(lines: DiffLine[]): Map<DiffLine, WordSegment[]> {
  const highlights = new Map<DiffLine, WordSegment[]>();
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.kind !== 'remove') {
      index++;
      continue;
    }
    const removeStart = index;
    while (index < lines.length && lines[index]!.kind === 'remove') index++;
    const removeEnd = index;
    const addStart = index;
    while (index < lines.length && lines[index]!.kind === 'add') index++;
    const pairs = Math.min(removeEnd - removeStart, index - addStart);
    for (let offset = 0; offset < pairs; offset++) {
      const removed = lines[removeStart + offset]!;
      const added = lines[addStart + offset]!;
      const { old, new: next } = diffWords(removed.text, added.text);
      if (old.length > 0) highlights.set(removed, old);
      if (next.length > 0) highlights.set(added, next);
    }
  }
  return highlights;
}

/** Nested Text nodes keep the row's colour; only changed words get bold. */
function renderWordSegments(segments: WordSegment[]): React.ReactNode {
  return segments.map((segment, index) => (
    <Text key={index} bold={segment.changed}>{segment.text}</Text>
  ));
}

/**
 * Professional unified-diff card: two line-number gutters, a continuous side
 * rule, and one flat colour per row (red removals, green additions) with bold
 * on the words that changed between paired remove/add rows. All lines render
 * by default; only a generous ceiling clips an unusually large patch.
 */
export const DiffView: React.FC<DiffViewProps> = ({
  header,
  diff,
  filePath,
  operation,
  maxRows,
  expanded = false,
  entries,
  wordHighlight = true,
}) => {
  const theme = useTheme();
  const files = React.useMemo(() => {
    const source = entries && entries.length > 0
      ? entries.map((entry) => ({
          label: entry.filePath ? displayFilePath(entry.filePath) : entry.header,
          lines: annotateDiff(entry.diff),
        }))
      : [{ label: filePath ? displayFilePath(filePath) : '', lines: annotateDiff(diff) }];
    return source;
  }, [entries, diff, filePath]);

  const allLines = files.flatMap((file) => file.lines);
  const additions = allLines.filter((line) => line.kind === 'add').length;
  const removals = allLines.filter((line) => line.kind === 'remove').length;
  const totalLines = allLines.length;
  // Gutter width comes from every line, never just the visible slice, so the
  // layout cannot shift when the card is toggled.
  const gutter = Math.max(2, ...allLines.map((line) => String(line.number ?? 0).length));
  const blank = ' '.repeat(gutter);

  const limit = Number.isFinite(maxRows)
    ? Math.max(0, Math.floor(maxRows!))
    : expanded
      ? Infinity
      : DIFF_PREVIEW_LINES;
  let remaining = limit;
  const renderedFiles = files.map((file) => {
    const visible = file.lines.slice(0, Math.max(0, remaining));
    remaining -= visible.length;
    return {
      ...file,
      visible,
      highlights: wordHighlight ? highlightChangedWords(visible) : new Map<DiffLine, WordSegment[]>(),
    };
  });
  const shownCount = renderedFiles.reduce((total, file) => total + file.visible.length, 0);
  const hidden = Math.max(0, totalLines - shownCount);
  const toggleAvailable = maxRows == null && totalLines > DIFF_PREVIEW_LINES;

  const title = header
    .replace(/^Successfully\s+(edited|wrote)\b/i, (_, verb: string) => verb.charAt(0).toUpperCase() + verb.slice(1).toLowerCase())
    .replace(/^Applied\s+patch\s+to\b/i, 'Applied')
    .replace(/\.$/, '') || operation || 'Diff';
  const paths = files.length > 1
    ? entries!
        .map((entry) => entry.filePath && displayFilePath(entry.filePath))
        .filter((path): path is string => Boolean(path))
        .join(', ')
    : filePath
      ? displayFilePath(filePath)
      : '';
  const showPaths = paths && !title.includes(paths);

  // One row = `[old#] [new#] │ [sign] [content]`. Every row uses the same
  // columns, including hunk/meta/per-file/footer rows, so the side rule is
  // unbroken and the gutters stay aligned.
  const row = (key: string, oldNum: string, newNum: string, sign: string, color: string, content: React.ReactNode) => (
    <Text key={key} wrap="truncate-end">
      <Text color={theme.dim}>{oldNum}</Text>
      <Text color={theme.dim}>{' '}</Text>
      <Text color={theme.dim}>{newNum}</Text>
      <Text color={theme.border}>{' │ '}</Text>
      <Text color={color}>{sign}</Text>
      <Text color={color}>{' '}</Text>
      <Text color={color}>{content}</Text>
    </Text>
  );

  let key = 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      marginY={1}
      width="100%"
      overflow="hidden"
    >
      <Text wrap="truncate-end">
        <Text color={theme.success}>✓ </Text>
        <Text color={theme.text} bold>{title}</Text>
        {showPaths && <Text color={theme.muted}>{`  ${paths}`}</Text>}
        {additions > 0 && <Text color={theme.success}>{`  +${additions}`}</Text>}
        {removals > 0 && <Text color={theme.error}>{`  -${removals}`}</Text>}
        {expanded && toggleAvailable && <Text color={theme.dim}>{'  click to collapse'}</Text>}
      </Text>

      {totalLines === 0 && row('empty', blank, blank, ' ', theme.dim, 'No textual changes.')}

      {renderedFiles.map((file, fileIndex) => (
        <React.Fragment key={fileIndex}>
          {files.length > 1 && row(`file-${fileIndex}`, blank, blank, ' ', theme.info, `▸ ${file.label}`)}
          {file.visible.map((diffLine) => {
            const numbers = gutterNumbers(diffLine.kind, diffLine.number, gutter);
            const segments = file.highlights.get(diffLine);
            return row(
              `line-${key++}`,
              numbers.old,
              numbers.next,
              signFor(diffLine.kind),
              lineColor(diffLine.kind, theme),
              segments && segments.length > 0 ? renderWordSegments(segments) : diffLine.text
            );
          })}
        </React.Fragment>
      ))}

      {hidden > 0 && row(
        'truncated',
        blank,
        blank,
        ' ',
        theme.dim,
        `… ${hidden} more line${hidden === 1 ? '' : 's'} (diff truncated)${!expanded && toggleAvailable ? ' · click to expand' : ''}`
      )}
    </Box>
  );
};
