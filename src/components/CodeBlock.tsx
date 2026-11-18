import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import {
  safeHighlight,
  MAX_HIGHLIGHT_CHARS,
  type HighlightLanguage,
  type HighlightToken,
} from '../utils/code-highlight.js';

export interface CodeBlockProps {
  code: string;
  /** A path or hint; see detectLanguage. */
  language?: HighlightLanguage | string;
  /** Filename shown in the optional header. */
  filename?: string;
  showHeader?: boolean;
  showLineNumbers?: boolean;
  /** Hard cap on code rows (header and truncation marker are extra). */
  maxRows?: number;
  /** Total width; lines are truncated to fit and never wrap. */
  columns?: number;
  borderColor?: string;
  marginY?: number;
  startLine?: number;
}

/** Render a highlighted line. Uncoloured tokens inherit `baseColor`. */
export const TokenText: React.FC<{
  tokens: HighlightToken[];
  baseColor?: string;
  baseBold?: boolean;
}> = ({ tokens, baseColor, baseBold }) => (
  <>
    {tokens.map((token, index) => (
      <Text key={index} color={token.color ?? baseColor} bold={token.bold ?? baseBold} dimColor={token.dim}>
        {token.text}
      </Text>
    ))}
  </>
);

const DEFAULT_MAX_ROWS = 12;

/**
 * Reusable highlighted code box. Tokens are memoized per (code, language) and
 * every row uses `wrap="truncate-end"`, so long or numerous lines can never
 * grow the surrounding frame.
 */
export const CodeBlock: React.FC<CodeBlockProps> = ({
  code,
  language,
  filename,
  showHeader = false,
  showLineNumbers = false,
  maxRows = DEFAULT_MAX_ROWS,
  columns,
  borderColor = theme.border,
  marginY = 1,
  startLine = 1,
}) => {
  const lines = React.useMemo(
    () => safeHighlight(code, language, { maxChars: MAX_HIGHLIGHT_CHARS }),
    [code, language]
  );

  const budget = Math.max(1, Math.floor(maxRows));
  const shown = lines.slice(0, budget);
  const hidden = Math.max(0, lines.length - shown.length);
  const lastNumber = Math.max(startLine, startLine + lines.length - 1);
  const gutterWidth = showLineNumbers ? String(lastNumber).length : 0;
  const label = filename || (language && language !== 'text' ? String(language) : 'code');

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginY={marginY}
      width={columns}
      overflow="hidden"
    >
      {showHeader && (
        <Text wrap="truncate-end">
          <Text color={theme.info}>▤ </Text>
          <Text color={theme.text} bold>{label}</Text>
          {language && language !== 'text' && <Text color={theme.dim}>{`  ${language}`}</Text>}
        </Text>
      )}

      {shown.map((tokens, index) => (
        <Text key={index} wrap="truncate-end">
          {showLineNumbers && (
            <>
              <Text color={theme.dim}>{String(startLine + index).padStart(gutterWidth)}</Text>
              <Text color={theme.dim}>{' │ '}</Text>
            </>
          )}
          <TokenText tokens={tokens} baseColor={theme.text} />
        </Text>
      ))}

      {hidden > 0 && (
        <Text color={theme.dim} wrap="truncate-end">
          {`${' '.repeat(gutterWidth ? gutterWidth + 3 : 0)}… ${hidden} more line${hidden === 1 ? '' : 's'}`}
        </Text>
      )}
    </Box>
  );
};
