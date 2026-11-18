import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

/**
 * Floating dialog chrome.
 *
 * Ink has no cross-platform overlay, so a dialog is a fixed-width card placed
 * at the top of the live region by its parent (horizontally centred, vertically
 * upper). Keeping that geometry in one component means every picker, prompt
 * and future screen — providers, models, settings, MCP, skills — shares the
 * same thin brown frame instead of drifting into a dozen ad-hoc layouts.
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

const rule = (columns: number): string => '─'.repeat(Math.max(1, dialogWidth(columns) - 2));

export const Dialog: React.FC<DialogProps> = ({ title, badge, hint, columns, compact = false, children }) => {
  const width = dialogWidth(columns);
  const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;

  if (compact) {
    return (
      <Box flexDirection="column" width={width} flexShrink={0} overflow="hidden">
        <Box flexDirection="row" overflow="hidden">
          <Box flexShrink={1} minWidth={1}>
            <Text color={theme.accent} bold wrap="truncate-end">
              {title}
            </Text>
          </Box>
        </Box>
        <Box flexDirection="column" flexShrink={1} overflow="hidden">{children}</Box>
        {hint ? <Text color={theme.dim} wrap="truncate-end">{hint}</Text> : null}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      overflow="hidden"
      borderStyle="round"
      borderColor={theme.border}
      backgroundColor={theme.surface}
      paddingX={1}
    >
      <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
        <Box flexShrink={1} minWidth={1}>
          <Text color={theme.accent} bold wrap="truncate-end">
            {title}
          </Text>
        </Box>
        {badge ? (
          <Box flexShrink={0} marginLeft={1}>
            <Text color={theme.dim} wrap="truncate-end">{badge}</Text>
          </Box>
        ) : null}
      </Box>
      <Text color={theme.border} wrap="truncate-end">{rule(cols)}</Text>
      <Box flexDirection="column" flexShrink={1} overflow="hidden">
        {children}
      </Box>
      {hint ? <Text color={theme.border} wrap="truncate-end">{rule(cols)}</Text> : null}
      {hint ? (
        <Text color={theme.dim} wrap="truncate-end">{hint}</Text>
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
  /** Optional group heading rendered when the group changes. */
  section?: string;
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
 * key. Section headings make the settings/model dialogs readable at a glance.
 */
export const DialogList: React.FC<DialogListProps> = ({
  items,
  selected,
  maxVisible,
  empty = 'Nothing to show.',
  compact = false,
}) => {
  if (items.length === 0) {
    return <Text color={theme.muted} wrap="truncate-end">{empty}</Text>;
  }

  const windowSize = Math.max(3, Math.min(MAX_VISIBLE, maxVisible ?? MAX_VISIBLE));
  const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), items.length - windowSize));
  const visible = items.slice(start, start + windowSize);

  return (
    <Box flexDirection="column">
      {visible.map((item, index) => {
        const itemIndex = start + index;
        const active = itemIndex === selected;
        const previous = itemIndex > 0 ? items[itemIndex - 1] : undefined;
        const showSection = !compact && Boolean(item.section) && item.section !== previous?.section;
        return (
          <Box key={item.id} flexDirection="column">
            {showSection ? (
              <Text color={theme.dim} wrap="truncate-end">{item.section}</Text>
            ) : null}
            <Box flexDirection="row" overflow="hidden">
              <Text color={active ? theme.accent : theme.dim}>{active ? '› ' : '  '}</Text>
              <Box flexGrow={1} flexShrink={1} minWidth={1}>
                <Text
                  color={item.color ?? (active ? theme.text : theme.muted)}
                  bold={active || item.bold}
                  wrap="truncate-end"
                >
                  {item.label}
                  {item.description ? (
                    <Text color={theme.dim}>{`  ${item.description}`}</Text>
                  ) : null}
                </Text>
              </Box>
              {item.meta ? (
                <Box flexShrink={0} marginLeft={1}>
                  <Text color={theme.dim} wrap="truncate-end">{item.meta}</Text>
                </Box>
              ) : null}
            </Box>
          </Box>
        );
      })}
      {!compact && items.length > windowSize ? (
        <Text color={theme.dim} wrap="truncate-end">
          {`${selected + 1}/${items.length}`}
        </Text>
      ) : null}
    </Box>
  );
};

export default Dialog;
