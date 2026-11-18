import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { ShellDisplay } from '../utils/shell-result.js';
import { safeHighlight } from '../utils/code-highlight.js';
import { TokenText } from './CodeBlock.js';

export interface ShellViewProps extends ShellDisplay {
  expanded?: boolean;
}

/** How many output lines a collapsed shell card shows before the click hint. */
export const SHELL_PREVIEW_LINES = 4;

/**
 * Terminal-style card for bash output. It stays compact by default so a long
 * command does not flood the transcript; clicking the card expands the full
 * output in place and clicking again folds it back.
 */
export const ShellView: React.FC<ShellViewProps> = ({
  command,
  output,
  isError,
  status,
  expanded = false,
}) => {
  const lines = output.replace(/\n+$/, '').split('\n');
  const hasOutput = output.trim().length > 0;
  const shown = expanded || !hasOutput ? lines : lines.slice(0, SHELL_PREVIEW_LINES);
  const hidden = hasOutput ? Math.max(0, lines.length - shown.length) : 0;
  const commandLine = command.replace(/\s+/g, ' ').trim();
  const commandTokens = React.useMemo(
    () => safeHighlight(commandLine || 'bash', 'bash')[0] ?? [],
    [commandLine]
  );
  const hint = expanded ? 'click to collapse' : 'click to expand';
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
      <Text wrap="truncate-end">
        <Text color={isError ? theme.error : theme.success}>{isError ? '✗ ' : '✓ '}</Text>
        <Text color={theme.muted} bold>
          Shell
        </Text>
        {status && <Text color={isError ? theme.error : theme.dim}>{`  ${status}`}</Text>}
        <Text color={theme.dim}>{`  ${hint}`}</Text>
      </Text>

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

      {hidden > 0 && (
        <Text color={theme.dim}>
          {`  … ${hidden} more line${hidden === 1 ? '' : 's'}`}
        </Text>
      )}
    </Box>
  );
};
