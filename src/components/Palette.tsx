import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';

export type SlashCategory = 'Session' | 'Model' | 'Workspace' | 'Tools' | 'App';

export interface SlashCommand {
  name: string;
  description: string;
  category: SlashCategory;
  /** Extra words the filter should match (aliases, synonyms). */
  keywords?: string;
  /** Small right-aligned hint, e.g. the current model or a keyboard glyph. */
  hint?: string;
}

/**
 * Slash commands, grouped by intent.
 *
 * Order inside a category is by how often it is used, not alphabetical: the
 * first screen of the palette should be the commands a session actually needs.
 * Categories give the list a spine, so a two-line `/` menu still reads as a
 * structured menu instead of a random list.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'Keys, hints and all commands', category: 'App', keywords: 'shortcuts keys' },
  { name: '/new', description: 'Start a fresh session', category: 'Session', keywords: 'reset clear' },
  { name: '/session', description: 'Open a saved session', category: 'Session', keywords: 'resume history' },
  { name: '/find', description: 'Search the transcript', category: 'Session', keywords: 'grep lookup' },
  { name: '/subagents', description: 'Browse and inspect child agents', category: 'Session', keywords: 'agents children transcripts' },
  { name: '/review', description: 'Delegate a code review to a sub-agent', category: 'Tools', keywords: 'audit findings review' },
  { name: '/github', description: 'Open the Bitacode repository in your browser', category: 'App', keywords: 'repo source code' },
  { name: '/bug', description: 'Open the GitHub bug report form', category: 'App', keywords: 'issue report bug' },

  { name: '/model', description: 'Switch model', category: 'Model', keywords: 'llm ai model' },
  { name: '/variant', description: 'Reasoning effort', category: 'Model', keywords: 'thinking effort' },
  { name: '/provider', description: 'Switch provider or add a key', category: 'Model', keywords: 'api key openai anthropic' },

  { name: '/theme', description: 'Choose a colour theme', category: 'App', keywords: 'colour palette dark light' },
  { name: '/settings', description: 'Preferences and status line', category: 'App', keywords: 'config options' },

  { name: '/memory', description: 'Saved facts about you and the repo', category: 'Workspace', keywords: 'remember forget notes' },
  { name: '/checkpoint', description: 'Working notes carried across compaction', category: 'Workspace', keywords: 'scratchpad plan' },
  { name: '/rewind', description: 'Undo the last turn', category: 'Workspace', keywords: 'undo revert back' },
  { name: '/undo', description: 'Undo the last file change', category: 'Workspace', keywords: 'revert edit' },
  { name: '/trust', description: 'Trust this project', category: 'Workspace', keywords: 'permissions hooks commands' },
  { name: '/permissions', description: 'Show permission rules', category: 'Workspace', keywords: 'allow deny ask' },
  { name: '/verify', description: 'Run typecheck, lint and tests', category: 'Tools', keywords: 'checks test build' },
  { name: '/doctor', description: 'Diagnose configuration', category: 'Tools', keywords: 'debug health' },
  { name: '/image', description: 'Attach an image path', category: 'Tools', keywords: 'screenshot vision' },
  { name: '/update', description: 'Update Bitacode from npm', category: 'App', keywords: 'upgrade version' },
  { name: '/quit', description: 'Exit Bitacode', category: 'App', keywords: 'exit close' },
];

export interface PaletteItem {
  id: string;
  label: string;
  description?: string;
  color?: string;
  bold?: boolean;
  /** Optional model metadata carried through the picker for persistence. */
  contextWindow?: number;
  /** Optional group heading, rendered when it changes. */
  section?: string;
  /** Right-aligned hint for this row. */
  meta?: string;
}

export interface PaletteProps {
  title?: string;
  items: PaletteItem[];
  selected: number;
  hint?: string;
  maxVisible?: number;
  /** The typed filter, used to highlight the matched part of each label. */
  query?: string;
  /** Terminal columns; very narrow screens drop descriptions to keep names whole. */
  columns?: number;
}

const MAX_VISIBLE = 7;

/** Split a label into matched / unmatched runs so the match can be emphasised. */
export function highlightMatch(label: string, query?: string): Array<{ text: string; match: boolean }> {
  const needle = (query ?? '').trim();
  if (!needle) return [{ text: label, match: false }];
  const index = label.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return [{ text: label, match: false }];
  const before = label.slice(0, index);
  const hit = label.slice(index, index + needle.length);
  const after = label.slice(index + needle.length);
  const parts: Array<{ text: string; match: boolean }> = [];
  if (before) parts.push({ text: before, match: false });
  parts.push({ text: hit, match: true });
  if (after) parts.push({ text: after, match: false });
  return parts;
}

/** `↑↓ move · enter run · esc close` with keys in the accent colour. */
export const PaletteHint: React.FC<{ hint?: string }> = ({ hint }) => {
  const theme = useTheme();
  const parts = (hint ?? '↑↓ move · enter run · esc close')
    .split('·')
    .map((segment) => segment.trim())
    .filter(Boolean);
  return (
    <Text wrap="truncate-end">
      {parts.map((part, index) => {
        const space = part.indexOf(' ');
        const key = space === -1 ? part : part.slice(0, space);
        const action = space === -1 ? '' : part.slice(space + 1);
        return (
          <Text key={`${key}-${index}`}>
            {index > 0 ? <Text color={theme.dim}>{'  ·  '}</Text> : null}
            <Text color={theme.accent}>{key}</Text>
            {action ? <Text color={theme.dim}>{` ${action}`}</Text> : null}
          </Text>
        );
      })}
    </Text>
  );
};

/**
 * Selectable list used for slash commands, models and variants.
 *
 * Deliberately cheap: no timers, no internal state, no measurement. It renders
 * on the same frame as the keypress that moved the cursor, so holding an arrow
 * key stays smooth on a phone. Sections, a right-aligned hint column and a
 * windowed "N more" marker keep long lists legible.
 */
export const Palette: React.FC<PaletteProps> = ({
  title,
  items,
  selected,
  hint,
  maxVisible,
  query,
  columns,
}) => {
  const theme = useTheme();
  if (items.length === 0) return null;
  // A name like /session is not worth abbreviating: drop the prose instead.
  // The card loses 4 columns to borders/padding, so require that much more room.
  const showDescriptions = (Number.isFinite(columns) ? Number(columns) : 80) >= 48;

  const window = Math.max(3, Math.min(MAX_VISIBLE, maxVisible ?? MAX_VISIBLE));
  const start = Math.max(0, Math.min(selected - Math.floor(window / 2), items.length - window));
  const visible = items.slice(start, start + window);
  const hiddenAbove = start;
  const hiddenBelow = Math.max(0, items.length - start - visible.length);

  return (
    <Box
      flexDirection="column"
      width="100%"
      flexShrink={0}
      borderStyle="round"
      borderColor={theme.border}
      backgroundColor={theme.surface}
      paddingX={1}
      marginBottom={1}
      overflow="hidden"
    >
      {(title || items.length > window) && (
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.dim} wrap="truncate-end">{title ?? 'Matches'}</Text>
          <Text color={theme.dim}>{`${selected + 1}/${items.length}`}</Text>
        </Box>
      )}
      {hiddenAbove > 0 && (
        <Text color={theme.dim} wrap="truncate-end">{`  ↑ ${hiddenAbove} more`}</Text>
      )}
      {visible.map((item, i) => {
        const index = start + i;
        const active = index === selected;
        const previous = index > 0 ? items[index - 1] : undefined;
        const showSection = Boolean(item.section) && item.section !== previous?.section;
        const labelColor = item.color ?? (active ? theme.text : theme.muted);
        return (
          <Box key={item.id} flexDirection="column">
            {showSection ? (
              <Text color={theme.dim} wrap="truncate-end">{`  ${item.section}`}</Text>
            ) : null}
            <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
              <Box flexDirection="row" flexShrink={1} minWidth={1}>
                <Box flexShrink={0}>
                  <Text color={active ? theme.accent : theme.dim}>{active ? '› ' : '  '}</Text>
                </Box>
                {/* The command name must stay whole: the description gives way first. */}
                <Box flexShrink={0}>
                  <Text color={labelColor} bold={active || item.bold} wrap="truncate-end">
                    {highlightMatch(item.label, query).map((part, partIndex) => (
                      <Text
                        key={partIndex}
                        color={part.match ? theme.accent : labelColor}
                        bold={part.match || active || item.bold}
                      >
                        {part.text}
                      </Text>
                    ))}
                  </Text>
                </Box>
                {item.description && showDescriptions && (
                  <Box flexShrink={1} minWidth={0} overflow="hidden">
                    <Text color={theme.dim} wrap="truncate-end">{`  ${item.description}`}</Text>
                  </Box>
                )}
              </Box>
              {item.meta ? (
                <Box flexShrink={0} marginLeft={1}>
                  <Text color={active ? theme.muted : theme.dim} wrap="truncate-end">{item.meta}</Text>
                </Box>
              ) : null}
            </Box>
          </Box>
        );
      })}
      {hiddenBelow > 0 && (
        <Text color={theme.dim} wrap="truncate-end">{`  ↓ ${hiddenBelow} more`}</Text>
      )}
      <PaletteHint hint={hint} />
    </Box>
  );
};
