import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { displayFilePath, type FileReadDisplay } from '../utils/file-diff.js';
import { detectLanguage, safeHighlight, type HighlightLanguage } from '../utils/code-highlight.js';
import { TokenText } from './CodeBlock.js';

export interface ReadFileViewProps extends FileReadDisplay {
  maxLines?: number;
  /** Override syntax language; inferred from filePath by default. */
  language?: HighlightLanguage | string;
}

const DEFAULT_MAX_LINES = 10;

/**
 * Bordered preview for read_file results. Shows the project-relative path and
 * line numbers without dumping an entire file into the scrollback.
 */
export const ReadFileView: React.FC<ReadFileViewProps> = ({ filePath, sections, maxLines, language: languageOverride }) => {
  const limit = Math.max(1, maxLines ?? DEFAULT_MAX_LINES);
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
  const gutter = Math.max(2, String(lastNumber).length);
  const path = filePath ? displayFilePath(filePath) : 'file';
  const showSectionHeaders = sections.length > 1;
  const language = languageOverride ?? detectLanguage(filePath);
  const codeText = rendered.flatMap((section) => section.visible).join('\n');
  const rows = React.useMemo(() => safeHighlight(codeText, language), [codeText, language]);
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
      <Text wrap="truncate-end">
        <Text color={theme.info}>▤ </Text>
        <Text color={theme.text} bold>Read</Text>
        <Text color={theme.muted}>{`  ${path}`}</Text>
      </Text>

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
                <Text color={theme.dim}>{'  │ '}</Text>
                <TokenText tokens={tokens} baseColor={theme.muted} />
              </Text>
            );
          })}
          {section.note && <Text color={theme.dim}>{`${' '.repeat(gutter)}  ${section.note}`}</Text>}
        </React.Fragment>
      ))}
      {hidden > 0 && (
        <Text color={theme.dim}>
          {`${' '.repeat(gutter)}  … ${hidden} more line${hidden === 1 ? '' : 's'}`}
        </Text>
      )}
    </Box>
  );
};
