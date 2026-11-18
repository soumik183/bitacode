import React, { useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { LeftBar } from './LeftBar.js';
import { PromptInput } from './PromptInput.js';
import { theme } from '../theme.js';

export interface ApiKeyPromptProps {
  providerName: string;
  path: string;
  error: string | null;
  busy: boolean;
  /** Terminal columns, used to clamp the input so it cannot overflow the screen. */
  columns?: number;
  /** Short terminals drop the decorative margins so the input is not clipped. */
  compact?: boolean;
  onSubmit: (value: string) => void;
}

export const ApiKeyPrompt: React.FC<ApiKeyPromptProps> = ({
  providerName,
  path,
  error,
  busy,
  columns,
  compact = false,
  onSubmit,
}) => {
  const [value, setValue] = useState('');
  const { stdout } = useStdout();
  // Leave room for the bar, the "› " prefix and the panel gutter. Clamp to at
  // least 1 so a tiny terminal never gets an input wider than the screen.
  const raw = columns ?? stdout?.columns ?? 80;
  const cols = Number.isFinite(raw) ? raw : 80;
  const width = Math.max(1, Math.floor(cols) - 8);

  return (
    <LeftBar color={theme.accent} marginTop={compact ? 0 : 1} marginBottom={compact ? 0 : 1}>
      <Text color={theme.text} bold wrap="truncate-end">API key for {providerName}</Text>
      <Text color={theme.dim} wrap="truncate-middle">{path}</Text>
      <Box marginTop={compact ? 0 : 1}>
        <Text color={theme.accent}>› </Text>
        <PromptInput
          value={value}
          onChange={setValue}
          onSubmit={onSubmit}
          isDisabled={busy}
          placeholder={busy ? 'Checking key…' : 'Paste API key…'}
          mask
          width={width}
        />
      </Box>
      {error && <Text color={theme.error} wrap="truncate-end">{error}</Text>}
      <Text color={theme.dim} wrap="truncate-end">
        {busy ? 'Checking key and fetching models…' : 'enter save · esc cancel'}
      </Text>
    </LeftBar>
  );
};
