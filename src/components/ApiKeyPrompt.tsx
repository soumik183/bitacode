import React, { useState } from 'react';
import { Box, Text } from 'ink';
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
        />
      </Box>
      {error && <Text color={theme.error}>{error}</Text>}
      <Text color={theme.dim}>
        {busy ? 'Checking key and fetching models…' : 'enter save · esc cancel'}
      </Text>
    </LeftBar>
  );
};
