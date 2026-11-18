import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

// ─── Available slash commands ───
export const SLASH_COMMANDS = [
  { name: '/help', description: 'Show all available commands' },
  { name: '/new', description: 'Start a new session' },
  { name: '/session', description: 'Open a saved session' },
  { name: '/model', description: 'Switch model' },
  { name: '/variant', description: 'Set reasoning variant' },
  { name: '/provider', description: 'Switch API provider' },
  { name: '/settings', description: 'Open settings' },
  { name: '/quit', description: 'Exit Bitacode' },
  { name: '/exit', description: 'Alias for /quit' },
];

export interface PaletteItem {
  id: string;
  label: string;
  description?: string;
  color?: string;
  bold?: boolean;
  /** Optional model metadata carried through the picker for persistence. */
  contextWindow?: number;
}

export interface PaletteProps {
  title?: string;
  items: PaletteItem[];
  selected: number;
  hint?: string;
  maxVisible?: number;
}

const MAX_VISIBLE = 7;

/**
 * Selectable list used for slash commands, models and variants.
 * Kept tiny: no timers, so it renders on the same frame as the keypress.
 */
export const Palette: React.FC<PaletteProps> = ({ title, items, selected, hint, maxVisible }) => {
  if (items.length === 0) return null;

  const window = Math.max(3, Math.min(MAX_VISIBLE, maxVisible ?? MAX_VISIBLE));
  const start = Math.max(0, Math.min(selected - Math.floor(window / 2), items.length - window));
  const visible = items.slice(start, start + window);

  return (
    <Box flexDirection="column" paddingX={2} marginBottom={1}>
      {title && <Text color={theme.dim} wrap="truncate-end">{title}</Text>}
      {visible.map((item, i) => {
        const index = start + i;
        const active = index === selected;
        const labelColor = item.color ?? (active ? theme.text : theme.muted);
        return (
          <Box key={item.id}>
            <Text color={active ? theme.accent : theme.dim}>{active ? '› ' : '  '}</Text>
            <Text color={labelColor} bold={active || item.bold} wrap="truncate-end">
              {item.label}
            </Text>
            {item.description && <Text color={theme.dim} wrap="truncate-end">  {item.description}</Text>}
          </Box>
        );
      })}
      <Text color={theme.dim} wrap="truncate-end">{hint ?? '↑↓ select · enter run · esc close'}</Text>
    </Box>
  );
};
