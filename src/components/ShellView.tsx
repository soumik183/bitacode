import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import type { ShellDisplay } from '../utils/shell-result.js';
import { safeHighlight } from '../utils/code-highlight.js';
import { TokenText } from './CodeBlock.js';

export interface ShellViewProps extends ShellDisplay {
  expanded?: boolean;
}

/** How many output lines a collapsed shell card shows before the click hint. */
export const SHELL_PREVIEW_LINES = 4;
/**
 * Upper bound for an expanded card. A command that prints tens of thousands of
 * lines must not be allowed to push the composer off-screen; the remainder is
 * summarised in a trailer row.
 */
export const SHELL_EXPANDED_MAX_LINES = 120;

/**
 * Terminal-style card for bash output.
 *
 * Collapsed it shows the first few lines plus a count of what is hidden;
 * clicking expands in place, and clicking again folds it back. The height is
 * therefore fully determined by `expanded`, which keeps the transcript budget
 * honest when the card is toggled.
 */
export const ShellView: React.FC<ShellViewProps> = ({
  command,
  output,
  isError,
  status,
  expanded = false,
}) => {
  const theme = useTheme();
  const hasOutput = output.trim().length > 0;
  // An empty result is zero lines, not one blank line: the header used to claim
  // "1 line" directly above "(no output)".
  const lines = hasOutput ? output.replace(/\n+$/, '').split('\n') : [];
  const limit = expanded ? SHELL_EXPANDED_MAX_LINES : SHELL_PREVIEW_LINES;
  const shown = hasOutput ? lines.slice(0, Math.min(lines.length, limit)) : [];
  const hidden = hasOutput ? Math.max(0, lines.length - shown.length) : 0;
  const commandLine = command.replace(/\s+/g, ' ').trim();
  const commandTokens = React.useMemo(
    () => safeHighlight(commandLine || 'bash', 'bash', { palette: theme })[0] ?? [],
    [commandLine, theme]
  );
  const hint = hidden > 0 ? (expanded ? 'click to collapse' : 'click to expand') : expanded ? 'click to collapse' : '';
  const borderColor = isError ? theme.error : theme.border;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginY={1}
      width="100%"
    >
      <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
        <Text wrap="truncate-end">
          <Text color={isError ? theme.error : theme.success}>{isError ? '✗ ' : '✓ '}</Text>
          <Text color={theme.text} bold>
            Shell
          </Text>
          {status ? (
            <Text color={isError ? theme.error : theme.success}>{`  ${status}`}</Text>
          ) : null}
          <Text color={theme.dim}>
            {`  ${lines.length} line${lines.length === 1 ? '' : 's'}`}
          </Text>
        </Text>
        {hint ? (
          <Text color={theme.dim} wrap="truncate-end">{`  ${hint}`}</Text>
        ) : null}
      </Box>

      <Text wrap="truncate-end">
        <Text color={theme.accent}>❯ </Text>
        <TokenText tokens={commandTokens} baseColor={theme.text} baseBold />
      </Text>

      {!hasOutput ? (
        <Text color={theme.dim}>{'  (no output)'}</Text>
      ) : (
        <Text color={isError ? theme.error : theme.muted} wrap={expanded ? 'wrap' : 'truncate-end'}>
          {shown.join('\n')}
        </Text>
      )}

      {hidden > 0 ? (
        <Text color={theme.dim}>
          {`  … ${hidden} more line${hidden === 1 ? '' : 's'}`}
          {expanded ? ' (preview truncated)' : ''}
        </Text>
      ) : null}
    </Box>
  );
};
