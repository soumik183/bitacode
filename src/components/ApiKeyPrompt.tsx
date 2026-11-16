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
  onSubmit: (value: string) => void;
}

export const ApiKeyPrompt: React.FC<ApiKeyPromptProps> = ({
  providerName,
  path,
  error,
  busy,
  onSubmit,
}) => {
  const [value, setValue] = useState('');
  const { stdout } = useStdout();
  // Leave room for the bar, the "› " prefix and the panel gutter.
  const width = Math.max(8, (stdout?.columns || 80) - 8);

  return (
    <LeftBar color={theme.accent} marginTop={1} marginBottom={1}>
      <Text color={theme.text} bold>API key for {providerName}</Text>
      <Text color={theme.dim} wrap="truncate-middle">{path}</Text>
      <Box marginTop={1}>
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
      {error && <Text color={theme.error}>{error}</Text>}
      <Text color={theme.dim}>
        {busy ? 'Checking key and fetching models…' : 'enter save · esc cancel'}
      </Text>
    </LeftBar>
  );
};
