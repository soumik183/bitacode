import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { stripMouseReports } from '../utils/mouse.js';
import { useTheme } from '../theme.js';
import type { MentionCandidate, MentionCollectionResult } from '../utils/mention-candidates.js';

export interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  isDisabled?: boolean;
  mask?: boolean;
  /** Visible columns. Text soft-wraps at this width and the box grows in rows. */
  width?: number;
  /** How many wrapped rows the composer may grow to before it scrolls. */
  maxRows?: number;
  /** Reports the rendered row count so the layout can reserve the right space. */
  onRowsChange?: (rows: number) => void;
  /**
   * Called for a multi-line or very large paste. Returns the text to insert:
   * the caller may store the body on disk and return a one-line marker.
   */
  onPaste?: (text: string) => Promise<string> | string;
  /**
   * Called for Tab while the caret is inside an `@token`. Returns the completed
   * value and caret, or null to let the keystroke fall through.
   */
  onCompleteMention?: (value: string, cursor: number) => Promise<{ value: string; cursor: number } | null>;
  /**
   * Supplies candidates for the `@token` under the cursor. When provided, a
   * popup opens on `@`, filters as the token grows, and Enter inserts the
   * selected label (a relative path for files, a name for skills).
   */
  onMentionCandidates?: (token: string) => Promise<MentionCollectionResult>;
}

// Display columns without a dependency: CJK/emoji take two, combining/zero-width take none.
const WIDE = /[\u{1100}-\u{115F}\u{2329}-\u{232A}\u{2E80}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE10}-\u{FE19}\u{FE30}-\u{FE6F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const ZERO = /[\u0300-\u036F\u200B-\u200F\uFEFF]/;
export const DEFAULT_MAX_ROWS = 6;

export const charWidth = (ch: string): number =>
  ZERO.test(ch) || ch === '\uFE0F' ? 0 : WIDE.test(ch) ? 2 : 1;

/** A visual row: a half-open range of code-point indices in `points`. */
export interface PromptLine {
  start: number;
  end: number;
}

/**
 * Split a value into visual rows: hard breaks at "\n" and soft wraps at
 * `width` display columns. Always returns at least one line so an empty
 * composer still occupies one row.
 */
export function wrapPromptLines(points: string[], width: number): PromptLine[] {
  const limit = Math.max(1, Math.floor(width) || 1);
  if (points.length === 0) return [{ start: 0, end: 0 }];

  const lines: PromptLine[] = [];
  let start = 0;
  let used = 0;
  let i = 0;

  while (i < points.length) {
    const ch = points[i];
    if (ch === '\n') {
      lines.push({ start, end: i });
      start = i + 1;
      used = 0;
      i++;
      continue;
    }
    const w = charWidth(ch);
    // Wrap before this glyph when it would overflow and the row is not empty.
    if (used + w > limit && i > start) {
      lines.push({ start, end: i });
      start = i;
      used = 0;
      continue;
    }
    used += w;
    i++;
  }

  lines.push({ start, end: points.length });
  return lines;
}

/** Index of the visible row that contains `cursor` (or the row it ends on). */
export function lineIndexForCursor(lines: PromptLine[], cursor: number): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (cursor >= line.start && cursor < line.end) return i;
    if (cursor === line.end) {
      // The cursor sits at the end of a full row: prefer the next row when the
      // value continues (word-wrap boundary), otherwise stay on this one.
      const next = lines[i + 1];
      if (next && next.start === cursor) return i + 1;
      return i;
    }
  }
  return Math.max(0, lines.length - 1);
}

/** Display column of `cursor` measured from the start of its row. */
function columnInLine(points: string[], line: PromptLine, cursor: number): number {
  const stop = Math.max(line.start, Math.min(cursor, line.end));
  let column = 0;
  for (let i = line.start; i < stop; i++) column += charWidth(points[i]);
  return column;
}

/** Code-point index in `line` closest to display `column` without exceeding it. */
function indexAtColumn(points: string[], line: PromptLine, column: number): number {
  let used = 0;
  for (let i = line.start; i < line.end; i++) {
    const w = charWidth(points[i]);
    if (used + w > column) return i;
    used += w;
  }
  return line.end;
}

/**
 * Move the caret one visual row up/down while keeping its display column.
 * Returns the same index when the caret is already on the first/last row.
 */
export function moveCursorVertically(
  points: string[],
  lines: PromptLine[],
  cursor: number,
  delta: number
): number {
  const current = lineIndexForCursor(lines, cursor);
  const target = current + delta;
  if (target < 0 || target >= lines.length) return cursor;
  const column = columnInLine(points, lines[current], cursor);
  return indexAtColumn(points, lines[target], column);
}

/**
 * The `@token` the caret sits in, or null. Mirrors utils/mentions.ts but stays
 * local so the component has no filesystem dependency.
 */
export function findMentionInValue(value: string, cursor: number): { token: string; start: number } | null {
  const position = Math.min(cursor, value.length);
  for (let index = position - 1; index >= 0; index--) {
    const char = value[index];
    if (char === '@') {
      if (index === 0 || /\s/.test(value[index - 1] ?? '')) {
        return { token: value.slice(index + 1, position), start: index };
      }
      return null;
    }
    if (/\s/.test(char ?? '')) return null;
  }
  return null;
}

/**
 * Composer input.
 *
 * Owned by us instead of @inkjs/ui so control keys (ctrl+a, ctrl+d, …) never
 * get inserted as text, and so the cursor is drawn in our own palette.
 *
 * The field soft-wraps at `width` and grows one row per visual line (up to
 * `maxRows`, then it scrolls), so multi-line prompts stay readable. `enter`
 * submits; `shift+enter`, `alt+enter` and `ctrl+j` insert a newline.
 */
export const PromptInput: React.FC<PromptInputProps> = ({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  isDisabled = false,
  mask = false,
  width,
  maxRows = DEFAULT_MAX_ROWS,
  onRowsChange,
  onPaste,
  onCompleteMention,
  onMentionCandidates,
}) => {
  const theme = useTheme();
  // Cursor is a code-point index, not a UTF-16 offset: arrows and backspace
  // must land on whole glyphs (emoji are two UTF-16 units, CJK are two columns).
  const points = useMemo(() => Array.from(value), [value]);
  const [cursor, setCursor] = useState(points.length);
  const offset = Math.min(cursor, points.length);
  // Columns the text may occupy before soft-wrapping.
  const displayWidth = Math.max(1, Math.floor(width && width > 0 ? width : 10_000));

  // `@` suggestion popup. The token is derived from the live value/caret; the
  // candidate list is loaded asynchronously by the caller and can fail without
  // ever blocking typing.
  const mention = useMemo(() => findMentionInValue(value, offset), [value, offset]);
  const mentionToken = mention?.token;
  const [suggestion, setSuggestion] = useState<{
    token: string;
    candidates: MentionCandidate[];
    error?: string;
    index: number;
  } | null>(null);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);

  useEffect(() => {
    if (!onMentionCandidates || mentionToken === undefined) {
      setSuggestion(null);
      setDismissedToken(null);
      return;
    }
    if (dismissedToken === mentionToken) return;
    let cancelled = false;
    void Promise.resolve(onMentionCandidates(mentionToken))
      .then((result) => {
        if (cancelled) return;
        setSuggestion({ token: mentionToken, candidates: result.candidates, error: result.error, index: 0 });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setSuggestion({ token: mentionToken, candidates: [], error: `Could not load suggestions: ${message}`, index: 0 });
      });
    return () => { cancelled = true; };
  }, [mentionToken, onMentionCandidates, dismissedToken]);

  const suggestionOpen = Boolean(suggestion && (suggestion.candidates.length > 0 || suggestion.error));
  // Ink keeps one input listener per render; async candidate updates can leave
  // the handler holding an older closure, so read the popup state through refs.
  const suggestionRef = useRef(suggestion);
  suggestionRef.current = suggestion;
  const mentionRef = useRef(mention);
  mentionRef.current = mention;

  const acceptMention = (candidate: MentionCandidate): void => {
    const activeMention = mentionRef.current;
    if (!activeMention) return;
    const before = points.slice(0, activeMention.start).join('');
    const after = points.slice(offset).join('');
    const next = `${before}${candidate.label}${after}`;
    onChange(next);
    setCursor(Array.from(before + candidate.label).length);
    setSuggestion(null);
    setDismissedToken(null);
  };

  // Start index of the whitespace-delimited word before `at` (code points).
  // Like readline's word-rubout, trailing whitespace is eaten with the word.
  const wordStartBefore = (at: number): number => {
    let i = at;
    while (i > 0 && /\s/.test(points[i - 1])) i--;
    while (i > 0 && !/\s/.test(points[i - 1])) i--;
    return i;
  };

  useInput(
    (input, key) => {
      const currentSuggestion = suggestionRef.current;
      const popupIsOpen = Boolean(currentSuggestion && (currentSuggestion.candidates.length > 0 || currentSuggestion.error));
      // enter submits; the modifier variants insert a line break instead.
      if (key.return) {
        if (key.shift || key.meta || key.ctrl) {
          onChange(points.slice(0, offset).join('') + '\n' + points.slice(offset).join(''));
          setCursor(offset + 1);
          return;
        }
        // Enter accepts the highlighted @ candidate instead of submitting.
        if (popupIsOpen && currentSuggestion) {
          const candidate = currentSuggestion.candidates[
            Math.min(currentSuggestion.index, currentSuggestion.candidates.length - 1)
          ];
          if (candidate) {
            acceptMention(candidate);
            return;
          }
        }
        onSubmit(value);
        return;
      }
      if (key.escape && popupIsOpen) {
        setSuggestion(null);
        if (mentionRef.current) setDismissedToken(mentionRef.current.token);
        return;
      }
      if (key.leftArrow) {
        setCursor(Math.max(0, offset - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(points.length, offset + 1));
        return;
      }
      // Alt+Backspace/Delete (Ink reports Alt as meta) deletes one whole word.
      // Keep it ahead of the single-glyph backspace branch below.
      if ((key.backspace || key.delete) && key.meta) {
        const start = wordStartBefore(offset);
        onChange(points.slice(0, start).join('') + points.slice(offset).join(''));
        setCursor(start);
        return;
      }
      // Editing shortcuts run before the modifier guard so they never fall
      // through as text. Ink delivers ctrl/alt+letter as the bare letter.
      if (key.ctrl && (key.upArrow || key.downArrow)) {
        // ctrl+arrow is reserved for transcript scrolling by App.
        return;
      }
      if (key.ctrl || key.meta) {
        switch (input.toLowerCase()) {
          case 'j': {
            // ctrl+j is a line feed in most terminals: treat it as newline.
            onChange(points.slice(0, offset).join('') + '\n' + points.slice(offset).join(''));
            setCursor(offset + 1);
            return;
          }
          case 'a':
            setCursor(0);
            return;
          case 'e':
            setCursor(points.length);
            return;
          case 'u':
            onChange('');
            setCursor(0);
            return;
          case 'w': {
            const start = wordStartBefore(offset);
            onChange(points.slice(0, start).join('') + points.slice(offset).join(''));
            setCursor(start);
            return;
          }
          case 'd':
            if (offset < points.length) {
              onChange(points.slice(0, offset).join('') + points.slice(offset + 1).join(''));
            }
            return;
          case 'k':
            if (offset < points.length) {
              onChange(points.slice(0, offset).join(''));
            }
            return;
          default:
            return;
        }
      }
      if (key.backspace || key.delete) {
        if (offset === 0) return;
        onChange(points.slice(0, offset - 1).join('') + points.slice(offset).join(''));
        setCursor(offset - 1);
        return;
      }
      // Up/down: walk prompt history on a single-row draft, otherwise move the
      // caret between wrapped rows. App skips transcript scrolling for them.
      if (key.upArrow || key.downArrow) {
        if (popupIsOpen && currentSuggestion && currentSuggestion.candidates.length > 0) {
          const delta = key.upArrow ? -1 : 1;
          setSuggestion((prev) => prev
            ? { ...prev, index: (prev.index + delta + prev.candidates.length) % prev.candidates.length }
            : prev);
          return;
        }
        // Prompt history and slash-palette navigation are owned by App, which
        // can see both the draft and the palette. Keeping them out of this
        // handler prevents Up from silently replacing an open `/` draft.
        const rows = wrapPromptLines(points, displayWidth);
        const next = moveCursorVertically(points, rows, offset, key.upArrow ? -1 : 1);
        if (next !== offset) setCursor(next);
        return;
      }
      // Tab completes an @mention when the caret is inside one; otherwise it is
      // left to App (which toggles plan/build mode).
      if (key.tab && !key.shift) {
        if (popupIsOpen && currentSuggestion) {
          const candidate = currentSuggestion.candidates[
            Math.min(currentSuggestion.index, currentSuggestion.candidates.length - 1)
          ];
          if (candidate) {
            acceptMention(candidate);
            return;
          }
        }
        if (onCompleteMention && mention) {
          void Promise.resolve(onCompleteMention(value, offset)).then((result) => {
            if (!result) return;
            onChange(result.value);
            setCursor(result.cursor);
          });
          return;
        }
      }
      // Ignore every other control/modifier key: they are never text.
      if (key.ctrl || key.meta || key.escape || key.tab) return;

      // Mouse reports arrive as text (Ink strips the leading ESC); never insert them.
      // Pasted text may contain real newlines: keep them so multi-line prompts
      // pasted from elsewhere stay multi-line, but normalise CRLF and drop tabs.
      const text = stripMouseReports(input).replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
      if (!text) return;
      // A big or multi-line paste goes through the caller, which may spill it to
      // disk and hand back a one-line marker instead of hundreds of rows.
      if (onPaste && (text.includes('\n') || text.length >= 2_000)) {
        const before = points.slice(0, offset).join('');
        const after = points.slice(offset).join('');
        void Promise.resolve(onPaste(text)).then((replacement) => {
          const inserted = typeof replacement === 'string' ? replacement : text;
          const next = `${before}${inserted}${after}`;
          onChange(next);
          setCursor(Array.from(before + inserted).length);
        });
        return;
      }
      onChange(points.slice(0, offset).join('') + text + points.slice(offset).join(''));
      setCursor(offset + Array.from(text).length);
    },
    { isActive: !isDisabled }
  );

  // Mask keeps one star per glyph (not per UTF-16 unit), so display and the
  // value share a code-point index and the cursor lands on the right column.
  const display = mask ? '*'.repeat(points.length) : value;
  const displayPoints = useMemo(() => Array.from(display), [display]);

  const lines = wrapPromptLines(displayPoints, displayWidth);
  const cursorLine = lineIndexForCursor(lines, offset);
  const visibleRows = Math.max(1, Math.min(lines.length, Math.max(1, Math.floor(maxRows))));

  // Keep the caret row inside the window, like a scrolling text area.
  let firstRow = 0;
  if (lines.length > visibleRows) {
    firstRow = Math.min(
      Math.max(0, cursorLine - visibleRows + 1),
      lines.length - visibleRows
    );
    if (cursorLine < firstRow) firstRow = cursorLine;
  }
  const windowLines = lines.slice(firstRow, firstRow + visibleRows);

  const rows = Math.max(1, windowLines.length);

  // Suggestion popup geometry. Its rows are included in the reported height so
  // the surrounding layout reserves space instead of clipping the card.
  const MAX_POPUP_ITEMS = 4;
  const popupVisible = suggestionOpen && Boolean(suggestion);
  const selected = suggestion ? Math.min(suggestion.index, Math.max(0, suggestion.candidates.length - 1)) : 0;
  const popupStart = suggestion && suggestion.candidates.length > MAX_POPUP_ITEMS
    ? Math.max(0, Math.min(selected - 1, suggestion.candidates.length - MAX_POPUP_ITEMS))
    : 0;
  const visibleCandidates = suggestion?.candidates.slice(popupStart, popupStart + MAX_POPUP_ITEMS) ?? [];
  // Skills are collected first, files/directories after. Insert one heading at
  // each group boundary and count those rows so Ink reserves space for them.
  const candidateGroup = (candidate: MentionCandidate): 'skill' | 'file' =>
    candidate.kind === 'skill' ? 'skill' : 'file';
  const startsGroup = (index: number): boolean =>
    index === 0 ||
    candidateGroup(visibleCandidates[index - 1]) !== candidateGroup(visibleCandidates[index]);
  const headingRows = visibleCandidates.reduce(
    (count, _candidate, index) => count + (startsGroup(index) ? 1 : 0),
    0,
  );
  const skillCount = suggestion?.candidates.filter((candidate) => candidate.kind === 'skill').length ?? 0;
  const fileCount = (suggestion?.candidates.length ?? 0) - skillCount;
  const hiddenAbove = popupStart;
  const hiddenBelow = suggestion ? Math.max(0, suggestion.candidates.length - popupStart - visibleCandidates.length) : 0;
  const popupRows = popupVisible
    ? 4 + visibleCandidates.length + headingRows +
      (hiddenAbove > 0 ? 1 : 0) + (hiddenBelow > 0 ? 1 : 0) + (suggestion?.error ? 1 : 0)
    : 0;
  const totalRows = rows + popupRows;
  const reportedRows = useRef(0);
  useEffect(() => {
    if (reportedRows.current === totalRows) return;
    reportedRows.current = totalRows;
    onRowsChange?.(totalRows);
  }, [totalRows, onRowsChange]);

  const popupWidth = Math.max(24, Math.min(displayWidth > 1000 ? 64 : displayWidth, 64));
  const rule = '─'.repeat(Math.max(1, popupWidth - 4));
  const kindIcon: Record<MentionCandidate['kind'], string> = {
    file: '▤', directory: '▸', skill: '◈',
  };
  const kindColor: Record<MentionCandidate['kind'], keyof typeof theme> = {
    file: 'muted', directory: 'info', skill: 'accent',
  };

  const fieldNode = !value ? (
    <Text color={theme.placeholder} wrap="truncate-end">{placeholder}</Text>
  ) : (
    <Text color={theme.text} wrap="truncate-end">
      {windowLines.map((line, index) => {
        const text = displayPoints.slice(line.start, line.end).join('');
        const newline = index > 0 ? '\n' : null;
        if (firstRow + index !== cursorLine) {
          return <React.Fragment key={index}>{newline}{text || ' '}</React.Fragment>;
        }
        const rel = Math.max(0, Math.min(offset - line.start, Array.from(text).length));
        const shown = Array.from(text);
        return (
          <React.Fragment key={index}>
            {newline}
            {shown.slice(0, rel).join('')}
            <Text inverse>{shown[rel] ?? ' '}</Text>
            {shown.slice(rel + 1).join('')}
          </React.Fragment>
        );
      })}
    </Text>
  );

  const popupNode = popupVisible && suggestion ? (
    <Box
      flexDirection="column"
      width={popupWidth}
      flexShrink={0}
      borderStyle="round"
      borderColor={theme.border}
      backgroundColor={theme.surface}
      paddingX={1}
      marginBottom={1}
    >
      <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
        <Text color={theme.accent} bold wrap="truncate-end">{'◈ Reference'}</Text>
        <Text color={theme.dim} wrap="truncate-end">
          {`${Math.min(selected + 1, suggestion.candidates.length)}/${suggestion.candidates.length} · enter insert · esc close`}
        </Text>
      </Box>
      <Text color={theme.border} wrap="truncate-end">{rule}</Text>
      {hiddenAbove > 0 ? <Text color={theme.dim}>{`  ↑ ${hiddenAbove} more`}</Text> : null}
      {visibleCandidates.map((candidate, index) => {
        const active = popupStart + index === selected;
        const group = candidateGroup(candidate);
        return (
          <React.Fragment key={candidate.id}>
            {startsGroup(index) ? (
              <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
                <Text color={theme.dim} bold wrap="truncate-end">
                  {group === 'skill' ? 'Skills' : 'Files'}
                </Text>
                <Text color={theme.dim} wrap="truncate-end">
                  {` ${group === 'skill' ? skillCount : fileCount}`}
                </Text>
              </Box>
            ) : null}
            <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
              <Box flexShrink={1} minWidth={1} flexDirection="row">
                <Text color={active ? theme.accent : theme.dim}>{active ? '› ' : '  '}</Text>
                <Text color={theme[kindColor[candidate.kind]]}>{`${kindIcon[candidate.kind]} `}</Text>
                <Text color={active ? theme.accent : theme.text} bold={active} wrap="truncate-end">
                  {candidate.label}
                </Text>
              </Box>
              {candidate.detail ? (
                <Box flexShrink={0} marginLeft={1}>
                  <Text color={theme.dim} wrap="truncate-end">
                    {candidate.source ? `${candidate.source} · ${candidate.detail}` : candidate.detail}
                  </Text>
                </Box>
              ) : null}
            </Box>
          </React.Fragment>
        );
      })}
      {hiddenBelow > 0 ? <Text color={theme.dim}>{`  ↓ ${hiddenBelow} more`}</Text> : null}
      {suggestion.error ? (
        <Text color={theme.error} wrap="truncate-end">{`⚠ ${suggestion.error}`}</Text>
      ) : null}
    </Box>
  ) : null;

  // A fragment (not a Box) keeps the field's full-width layout: a wrapping Box
  // would measure the Text at its content width and truncate multi-row drafts.
  return (
    <>
      {popupNode}
      {fieldNode}
    </>
  );
};
