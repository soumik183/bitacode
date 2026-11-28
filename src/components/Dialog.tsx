import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';

/**
 * Floating dialog chrome.
 *
 * Ink has no cross-platform overlay, so a dialog is a fixed-width card placed at
 * the top of the live region by its parent (horizontally centred, vertically
 * upper). Keeping that geometry in one component means every picker, prompt and
 * future screen — providers, models, settings, MCP, skills — shares the same
 * frame instead of drifting into a dozen ad-hoc layouts.
 *
 * Anatomy (every dialog, without exception):
 *
 *   ╭────────────────────────────────────────╮
 *   │ ◈ Title                        1/7     │  ← accent glyph + title, badge
 *   │ ─────────────────────────────────────  │  ← hairline rule
 *   │   Interface                            │  ← section caption
 *   │ › Label · description           meta   │  ← row: pointer, text, value
 *   │ ─────────────────────────────────────  │
 *   │  ↑↓ move · enter select · esc close    │  ← keys in accent, rest dim
 *   ╰────────────────────────────────────────╯
 */

export interface DialogProps {
  title: string;
  /** Right-aligned caption in the title row (count, provider, …). */
  badge?: string;
  /** One-row keyboard legend under the frame. */
  hint?: string;
  /** Terminal columns, used to clamp the card so it never overflows. */
  columns: number;
  /** Short terminals drop borders and rules so every option still fits. */
  compact?: boolean;
  /** Optional accent glyph rendered just before the title. */
  accentGlyph?: string;
  /** Card corner style: rounded (default) or square. Ignored when compact. */
  borderStyle?: 'round' | 'square';
  children: React.ReactNode;
}

/**
 * Outer width of a dialog at this terminal width.
 *
 * Cards cap at 72 columns on normal terminals and 84 on wide ones; on narrow
 * screens they use the space minus a 2-column breathing margin, and never
 * exceed the terminal itself (a too-wide Ink box wraps and breaks the frame).
 */
export function dialogWidth(columns: number): number {
  const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  const preferred = cols >= 96 ? 84 : Math.max(24, Math.min(cols - 4, 72));
  return Math.max(1, Math.min(cols, preferred));
}

/** Usable content width inside the frame (borders + 1-column padding). */
export function dialogInnerWidth(columns: number): number {
  return Math.max(1, dialogWidth(columns) - 4);
}

/** Hairline that spans exactly the content box of an already-clamped card. */
const rule = (cardWidth: number): string => '─'.repeat(Math.max(1, cardWidth - 4));

/**
 * Split a hint into key/action pairs so keys can carry the accent colour. A
 * hint is `enter select · esc close` — the first word of each segment is the
 * key, everything after it is the action.
 */
export function splitHint(hint: string): Array<{ key: string; action: string }> {
  return hint
    .split('·')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const space = segment.indexOf(' ');
      if (space === -1) return { key: segment, action: '' };
      return { key: segment.slice(0, space), action: segment.slice(space + 1).trim() };
    });
}

/** `enter save · esc cancel` with the key names painted in the accent colour. */
export const HintLine: React.FC<{ hint: string; compact?: boolean }> = ({ hint, compact }) => {
  const theme = useTheme();
  const parts = splitHint(hint);
  if (parts.length === 0) return null;
  return (
    <Text wrap="truncate-end">
      {parts.map((part, index) => (
        <Text key={`${part.key}-${index}`}>
          {index > 0 ? <Text color={theme.dim}>{'  ·  '}</Text> : null}
          <Text color={theme.accent} bold={!compact}>{part.key}</Text>
          {part.action ? <Text color={theme.dim}>{` ${part.action}`}</Text> : null}
        </Text>
      ))}
    </Text>
  );
};

export const Dialog: React.FC<DialogProps> = ({
  title,
  badge,
  hint,
  columns,
  compact = false,
  accentGlyph,
  borderStyle = 'round',
  children,
}) => {
  const theme = useTheme();
  const heading = accentGlyph ? `${accentGlyph} ${title}` : title;
  const width = dialogWidth(columns);

  if (compact) {
    return (
      <Box flexDirection="column" width={width} flexShrink={0} overflow="hidden">
        <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
          <Box flexShrink={1} minWidth={1}>
            <Text color={theme.accent} bold wrap="truncate-end">
              {heading}
            </Text>
          </Box>
          {badge && width >= 30 ? (
            <Box flexShrink={0} marginLeft={1}>
              <Text color={theme.dim} wrap="truncate-end">{badge}</Text>
            </Box>
          ) : null}
        </Box>
        <Box flexDirection="column" flexShrink={1} overflow="hidden">{children}</Box>
        {hint ? <HintLine hint={hint} compact /> : null}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      overflow="hidden"
      borderStyle={borderStyle === 'square' ? 'single' : 'round'}
      borderColor={theme.border}
      backgroundColor={theme.surface}
      paddingX={1}
    >
      <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
        <Box flexShrink={1} minWidth={1}>
          <Text color={theme.accent} bold wrap="truncate-end">
            {heading}
          </Text>
        </Box>
        {badge ? (
          <Box flexShrink={0} marginLeft={1}>
            <Text color={theme.muted} wrap="truncate-end">{` ${badge} `}</Text>
          </Box>
        ) : null}
      </Box>
      <Text color={theme.border} wrap="truncate-end">{rule(width)}</Text>
      <Box flexDirection="column" flexShrink={1} overflow="hidden">
        {children}
      </Box>
      {hint ? (
        <>
          <Text color={theme.border} wrap="truncate-end">{rule(width)}</Text>
          <HintLine hint={hint} />
        </>
      ) : null}
    </Box>
  );
};

export interface DialogItem {
  id: string;
  label: string;
  description?: string;
  /** Right-aligned metadata (model context, on/off, …). */
  meta?: string;
  color?: string;
  bold?: boolean;
  /** Optional palette preview: an accent glyph painted on that palette's bg. */
  swatch?: { accent: string; bg: string };
  /** Optional group heading rendered when the group changes. */
  section?: string;
  /** Marks the row that is currently in effect (model, theme, …). */
  active?: boolean;
}

export interface DialogListProps {
  items: DialogItem[];
  selected: number;
  /** Rows shown at once before the list windows around the selection. */
  maxVisible?: number;
  /** Shown when there are no items. */
  empty?: string;
  /** Drop section headings and the counter on short terminals. */
  compact?: boolean;
}

const MAX_VISIBLE = 8;

/**
 * Selectable list for dialogs.
 *
 * No timers and no internal state: it renders the same frame as the keypress
 * that moved the cursor, which keeps Ink's diff small while holding an arrow
 * key. Section headings, a right-aligned value column and a position chip make
 * long dialogs readable at a glance.
 */
export const DialogList: React.FC<DialogListProps> = ({
  items,
  selected,
  maxVisible,
  empty = 'Nothing to show.',
  compact = false,
}) => {
  const theme = useTheme();
  if (items.length === 0) {
    return <Text color={theme.muted} wrap="truncate-end">{empty}</Text>;
  }

  const windowSize = Math.max(3, Math.min(MAX_VISIBLE, maxVisible ?? MAX_VISIBLE));
  const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), items.length - windowSize));
  const visible = items.slice(start, start + windowSize);
  const hiddenAbove = start;
  const hiddenBelow = Math.max(0, items.length - start - visible.length);

  return (
    <Box flexDirection="column">
      {hiddenAbove > 0 && !compact ? (
        <Text color={theme.dim} wrap="truncate-end">{`  ↑ ${hiddenAbove} more`}</Text>
      ) : null}
      {visible.map((item, index) => {
        const itemIndex = start + index;
        const active = itemIndex === selected;
        const previous = itemIndex > 0 ? items[itemIndex - 1] : undefined;
        const showSection = !compact && Boolean(item.section) && item.section !== previous?.section;
        return (
          <Box key={item.id} flexDirection="column">
            {showSection ? (
              <Box marginTop={itemIndex > 0 ? 0 : 0}>
                <Text color={theme.dim} bold wrap="truncate-end">{`  ${item.section}`}</Text>
              </Box>
            ) : null}
            <Box
              flexDirection="row"
              justifyContent="space-between"
              width="100%"
              backgroundColor={active ? theme.surfaceAlt : undefined}
              overflow="hidden"
            >
              <Box flexShrink={1} minWidth={1} flexDirection="row">
                <Text color={active ? theme.accent : theme.dim}>{active ? '› ' : '  '}</Text>
                {item.swatch ? (
                  <Box flexShrink={0} marginRight={1}>
                    <Text color={item.swatch.accent} backgroundColor={item.swatch.bg}>■</Text>
                  </Box>
                ) : null}
                <Box flexShrink={1} minWidth={1}>
                  <Text
                    color={item.color ?? (active ? theme.text : theme.muted)}
                    bold={active || item.bold}
                    wrap="truncate-end"
                  >
                    {item.label}
                    {item.description ? (
                      <Text color={theme.dim}>{` · ${item.description}`}</Text>
                    ) : null}
                  </Text>
                </Box>
              </Box>
              {item.meta || item.active ? (
                <Box flexShrink={0} marginLeft={1}>
                  {item.meta ? (
                    <Text color={active ? theme.accent : theme.dim} wrap="truncate-end">{item.meta}</Text>
                  ) : null}
                  {item.active ? (
                    <Text color={theme.success} wrap="truncate-end">{item.meta ? ' ✓' : '✓'}</Text>
                  ) : null}
                </Box>
              ) : null}
            </Box>
          </Box>
        );
      })}
      {hiddenBelow > 0 && !compact ? (
        <Text color={theme.dim} wrap="truncate-end">{`  ↓ ${hiddenBelow} more`}</Text>
      ) : null}
      {!compact && items.length > windowSize ? (
        <Text color={theme.dim} wrap="truncate-end">
          {`  ${selected + 1}/${items.length}`}
        </Text>
      ) : null}
    </Box>
  );
};

export default Dialog;
