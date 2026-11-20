import React, { useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { LeftBar } from './LeftBar.js';
import { PromptInput } from './PromptInput.js';
import { HintLine } from './Dialog.js';
import { useTheme } from '../theme.js';

export interface ApiKeyPromptProps {
  providerName: string;
  path: string;
  error: string | null;
  busy: boolean;
  /** Terminal columns, used to clamp the input so it cannot overflow the screen. */
  columns?: number;
  /** Short terminals drop the decorative margins so the input is not clipped. */
  compact?: boolean;
  /** Rendered inside a Dialog that already supplies the title and hint. */
  embedded?: boolean;
  onSubmit: (value: string) => void;
}

/**
 * Where to create a key, per provider. Best-effort by name, so an unknown
 * provider shows no link instead of a wrong one.
 */
export function providerKeyUrl(providerName: string): string | undefined {
  const name = providerName.toLowerCase();
  if (name.includes('openrouter')) return 'openrouter.ai/keys';
  if (name.includes('anthropic') || name.includes('claude')) return 'console.anthropic.com/settings/keys';
  if (name.includes('openai')) return 'platform.openai.com/api-keys';
  if (name.includes('groq')) return 'console.groq.com/keys';
  if (name.includes('google') || name.includes('gemini')) return 'aistudio.google.com/apikey';
  if (name.includes('mistral')) return 'console.mistral.ai/api-keys';
  if (name.includes('xai') || name.includes('grok')) return 'console.x.ai';
  if (name.includes('deepseek')) return 'platform.deepseek.com/api_keys';
  if (name.includes('together')) return 'api.together.ai/settings/api-keys';
  if (name.includes('fireworks')) return 'fireworks.ai/account/api-keys';
  if (name.includes('cerebras')) return 'cloud.cerebras.ai';
  return undefined;
}

export const ApiKeyPrompt: React.FC<ApiKeyPromptProps> = ({
  providerName,
  path,
  error,
  busy,
  columns,
  compact = false,
  embedded = false,
  onSubmit,
}) => {
  const theme = useTheme();
  const [value, setValue] = useState('');
  const { stdout } = useStdout();
  // Leave room for the bar, the "› " prefix and the panel gutter. Clamp to at
  // least 1 so a tiny terminal never gets an input wider than the screen.
  const raw = columns ?? stdout?.columns ?? 80;
  const cols = Number.isFinite(raw) ? raw : 80;
  const width = Math.max(1, Math.floor(cols) - 8);
  const keyUrl = providerKeyUrl(providerName);

  return (
    <LeftBar color={theme.accent} marginTop={0} marginBottom={0}>
      {!embedded && (
        <Text color={theme.text} bold wrap="truncate-end">
          <Text color={theme.accent}>⚿ </Text>
          API key for {providerName}
        </Text>
      )}
      <Text color={theme.dim} wrap="truncate-middle">
        {busy ? 'saving to ' : 'stored in '}
        <Text color={theme.muted}>{path}</Text>
      </Text>
      {keyUrl ? (
        <Text color={theme.dim} wrap="truncate-end">
          {'create one at '}
          <Text color={theme.info}>{keyUrl}</Text>
        </Text>
      ) : null}
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
      {error && (
        <Text color={theme.error} wrap="truncate-end">
          <Text color={theme.error}>✗ </Text>
          {error}
        </Text>
      )}
      {!embedded && (
        <Box marginTop={compact ? 0 : 1}>
          {busy ? (
            <Text color={theme.muted} wrap="truncate-end">Checking key and fetching models…</Text>
          ) : (
            <HintLine compact={compact} hint="enter save · esc cancel" />
          )}
        </Box>
      )}
    </LeftBar>
  );
};
