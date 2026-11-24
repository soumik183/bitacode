import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { displayFilePath, type FileReadDisplay } from '../utils/file-diff.js';
import { detectLanguage, safeHighlight, type HighlightLanguage } from '../utils/code-highlight.js';
import { TokenText } from './CodeBlock.js';

export interface ReadFileViewProps extends FileReadDisplay {
  maxLines?: number;
  /** Override syntax language; inferred by filePath by default. */
  language?: HighlightLanguage | string;
  /** Expanded cards show far more of the file before clipping. */
  expanded?: boolean;
}

/** Lines shown by a collapsed read card. */
export const READ_PREVIEW_LINES = 10;
const DEFAULT_MAX_LINES = READ_PREVIEW_LINES;
/** Ceiling for an expanded read card, so one big file cannot own the screen. */
export const READ_EXPANDED_MAX_LINES = 200;

/**
 * Bordered preview for read_file results.
 *
 * The card shows a bounded slice of the file with real line numbers instead of
 * dumping it into the transcript. When the slice is partial the header says how
 * many lines exist and the footer offers the click-to-expand affordance, so the
 * card's height is always explained by what it prints.
 */
export const ReadFileView: React.FC<ReadFileViewProps> = ({
  filePath,
  sections,
  maxLines,
  language: languageOverride,
  expanded = false,
}) => {
  const theme = useTheme();
  const limit = Math.max(1, expanded ? READ_EXPANDED_MAX_LINES : maxLines ?? DEFAULT_MAX_LINES);
  const totalLines = sections.reduce((total, section) => total + section.lines.length, 0);
  let budget = limit;
  const rendered = sections.map((section) => {
    const visible = section.lines.slice(0, Math.max(0, budget));
    budget -= visible.length;
    return { ...section, visible };
  });
  const hidden = Math.max(0, totalLines - Math.min(totalLines, limit));
  const lastNumber = rendered.reduce(
    (max, section) => Math.max(max, section.startLine + section.visible.length),
    1
  );
  const firstNumber = sections[0]?.startLine ?? 1;
  const gutter = Math.max(2, String(lastNumber).length);
  const path = filePath ? displayFilePath(filePath) : 'file';
  const showSectionHeaders = sections.length > 1;
  const language = languageOverride ?? detectLanguage(filePath);
  const codeText = rendered.flatMap((section) => section.visible).join('\n');
  const rows = React.useMemo(() => safeHighlight(codeText, language, { palette: theme }), [codeText, language, theme]);
  let row = 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      marginY={1}
      width="100%"
    >
      <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
        <Text wrap="truncate-end">
          <Text color={theme.info}>▤ </Text>
          <Text color={theme.text} bold>Read</Text>
          <Text color={theme.muted}>{`  ${path}`}</Text>
        </Text>
        <Text color={theme.dim} wrap="truncate-end">
          {totalLines === 0
            ? 'empty'
            : `lines ${firstNumber}–${Math.max(firstNumber, lastNumber - 1)} · ${totalLines} total`}
        </Text>
      </Box>

      {totalLines === 0 && sections.every((section) => !section.note) && (
        <Text color={theme.dim}>{'  (empty file)'}</Text>
      )}
      {rendered.map((section, sectionIndex) => (
        <React.Fragment key={sectionIndex}>
          {showSectionHeaders && (
            <Text color={theme.info}>{'  '}{`[lines ${section.startLine}-${section.endLine}]`}</Text>
          )}
          {section.visible.map((line, index) => {
            const tokens = rows[row++] ?? [{ text: line }];
            return (
              <Text key={index} wrap="truncate-end">
                <Text color={theme.dim}>{String(section.startLine + index).padStart(gutter)}</Text>
                <Text color={theme.border}>{'  │ '}</Text>
                <TokenText tokens={tokens} baseColor={theme.muted} />
              </Text>
            );
          })}
          {section.note && (
            <Text color={theme.dim} wrap="truncate-end">{`${' '.repeat(gutter)}  ${section.note}`}</Text>
          )}
        </React.Fragment>
      ))}
      {hidden > 0 ? (
        <Text color={theme.dim} wrap="truncate-end">
          {`${' '.repeat(gutter)}  … ${hidden} more line${hidden === 1 ? '' : 's'}`}
          {expanded ? ' (preview truncated) · click to collapse' : ' · click to expand'}
        </Text>
      ) : expanded ? (
        <Text color={theme.dim} wrap="truncate-end">{'  click to collapse'}</Text>
      ) : null}
    </Box>
  );
};
