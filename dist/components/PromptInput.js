import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { stripMouseReports } from '../utils/mouse.js';
import { splitPathTokens } from '../utils/path-highlight.js';
import { useTheme } from '../theme.js';
// Display columns without a dependency: CJK/emoji take two, combining/zero-width take none.
const WIDE = /[\u{1100}-\u{115F}\u{2329}-\u{232A}\u{2E80}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE10}-\u{FE19}\u{FE30}-\u{FE6F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const ZERO = /[\u0300-\u036F\u200B-\u200F\uFEFF]/;
export const DEFAULT_MAX_ROWS = 6;
export const charWidth = (ch) => ZERO.test(ch) || ch === '\uFE0F' ? 0 : WIDE.test(ch) ? 2 : 1;
/**
 * Split a value into visual rows: hard breaks at "\n" and soft wraps at
 * `width` display columns. Always returns at least one line so an empty
 * composer still occupies one row.
 */
export function wrapPromptLines(points, width) {
    const limit = Math.max(1, Math.floor(width) || 1);
    if (points.length === 0)
        return [{ start: 0, end: 0 }];
    const lines = [];
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
export function lineIndexForCursor(lines, cursor) {
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (cursor >= line.start && cursor < line.end)
            return i;
        if (cursor === line.end) {
            // The cursor sits at the end of a full row: prefer the next row when the
            // value continues (word-wrap boundary), otherwise stay on this one.
            const next = lines[i + 1];
            if (next && next.start === cursor)
                return i + 1;
            return i;
        }
    }
    return Math.max(0, lines.length - 1);
}
/** Display column of `cursor` measured from the start of its row. */
function columnInLine(points, line, cursor) {
    const stop = Math.max(line.start, Math.min(cursor, line.end));
    let column = 0;
    for (let i = line.start; i < stop; i++)
        column += charWidth(points[i]);
    return column;
}
/** Code-point index in `line` closest to display `column` without exceeding it. */
function indexAtColumn(points, line, column) {
    let used = 0;
    for (let i = line.start; i < line.end; i++) {
        const w = charWidth(points[i]);
        if (used + w > column)
            return i;
        used += w;
    }
    return line.end;
}
/**
 * Move the caret one visual row up/down while keeping its display column.
 * Returns the same index when the caret is already on the first/last row.
 */
export function moveCursorVertically(points, lines, cursor, delta) {
    const current = lineIndexForCursor(lines, cursor);
    const target = current + delta;
    if (target < 0 || target >= lines.length)
        return cursor;
    const column = columnInLine(points, lines[current], cursor);
    return indexAtColumn(points, lines[target], column);
}
/**
 * The `@token` the caret sits in, or null. Mirrors utils/mentions.ts but stays
 * local so the component has no filesystem dependency.
 */
export function findMentionInValue(value, cursor) {
    const position = Math.min(cursor, value.length);
    for (let index = position - 1; index >= 0; index--) {
        const char = value[index];
        if (char === '@') {
            if (index === 0 || /\s/.test(value[index - 1] ?? '')) {
                return { token: value.slice(index + 1, position), start: index };
            }
            return null;
        }
        if (/\s/.test(char ?? ''))
            return null;
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
export const PromptInput = ({ value, onChange, onSubmit, placeholder = '', isDisabled = false, mask = false, width, maxRows = DEFAULT_MAX_ROWS, onRowsChange, onPaste, onCompleteMention, onMentionCandidates, caretRequest, }) => {
    const theme = useTheme();
    // Cursor is a code-point index, not a UTF-16 offset: arrows and backspace
    // must land on whole glyphs (emoji are two UTF-16 units, CJK are two columns).
    const points = useMemo(() => Array.from(value), [value]);
    const [cursor, setCursor] = useState(points.length);
    const offset = Math.min(cursor, points.length);
    // Ink keeps one input listener per render, so an async state update (mention
    // candidates, paste, history) can leave the handler holding an older value.
    // Edits go through refs and update them synchronously; the caret can never
    // point past the text it is editing or submit a stale draft.
    const valueRef = useRef(value);
    valueRef.current = value;
    const pointsRef = useRef(points);
    pointsRef.current = points;
    const offsetRef = useRef(offset);
    offsetRef.current = offset;
    useEffect(() => {
        if (cursor > points.length)
            setCursor(points.length);
    }, [cursor, points.length]);
    // A left click in the composer asks the host to move the caret to a column
    // on its current visual row. Map the column through code points so emoji and
    // CJK never get split, and keep the index inside that row.
    useEffect(() => {
        if (!caretRequest)
            return;
        const chars = pointsRef.current;
        let rowStart = offsetRef.current;
        while (rowStart > 0 && chars[rowStart - 1] !== '\n')
            rowStart--;
        let rowEnd = rowStart;
        while (rowEnd < chars.length && chars[rowEnd] !== '\n')
            rowEnd++;
        const next = rowStart + Math.max(0, Math.min(caretRequest.col, rowEnd - rowStart));
        offsetRef.current = next;
        setCursor(next);
    }, [caretRequest?.nonce]);
    // Columns the text may occupy before soft-wrapping.
    const displayWidth = Math.max(1, Math.floor(width && width > 0 ? width : 10_000));
    // `@` suggestion popup. The token is derived from the live value/caret; the
    // candidate list is loaded asynchronously by the caller and can fail without
    // ever blocking typing.
    const mention = useMemo(() => findMentionInValue(value, offset), [value, offset]);
    const mentionToken = mention?.token;
    const [suggestion, setSuggestion] = useState(null);
    const [dismissedToken, setDismissedToken] = useState(null);
    useEffect(() => {
        if (!onMentionCandidates || mentionToken === undefined) {
            setSuggestion(null);
            setDismissedToken(null);
            return;
        }
        if (dismissedToken === mentionToken)
            return;
        let cancelled = false;
        void Promise.resolve(onMentionCandidates(mentionToken))
            .then((result) => {
            if (cancelled)
                return;
            setSuggestion({ token: mentionToken, candidates: result.candidates, error: result.error, index: 0 });
        })
            .catch((err) => {
            if (cancelled)
                return;
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
    /** Single edit path: splice code points, then move the caret with the text. */
    const applyEdit = (start, end, insert) => {
        const chars = pointsRef.current;
        const from = Math.max(0, Math.min(start, chars.length));
        const to = Math.max(from, Math.min(end, chars.length));
        const head = chars.slice(0, from).join('');
        const next = `${head}${insert}${chars.slice(to).join('')}`;
        const nextCursor = Array.from(`${head}${insert}`).length;
        valueRef.current = next;
        pointsRef.current = Array.from(next);
        offsetRef.current = nextCursor;
        onChange(next);
        setCursor(nextCursor);
    };
    /** Newline that keeps the current line's indentation (lists, code, nested prose). */
    const newlineWithIndent = () => {
        const chars = pointsRef.current;
        let lineStart = offsetRef.current;
        while (lineStart > 0 && chars[lineStart - 1] !== '\n')
            lineStart--;
        const indent = chars.slice(lineStart).join('').match(/^\s*/)?.[0] ?? '';
        return `\n${indent}`;
    };
    const acceptMention = (candidate) => {
        // Recompute the token from the live text: the ref may be newer than the
        // render that produced `mention` when candidates arrived asynchronously.
        const activeMention = findMentionInValue(valueRef.current, offsetRef.current);
        if (!activeMention)
            return;
        // A trailing space closes the file token so the highlighter keeps colouring
        // only the path while subsequent typing stays plain text.
        applyEdit(activeMention.start, offsetRef.current, `${candidate.label} `);
        setSuggestion(null);
        setDismissedToken(null);
    };
    // Start index of the whitespace-delimited word before `at` (code points).
    // Like readline's word-rubout, trailing whitespace is eaten with the word.
    const wordStartBefore = (at) => {
        const chars = pointsRef.current;
        let i = at;
        while (i > 0 && /\s/.test(chars[i - 1] ?? ''))
            i--;
        while (i > 0 && !/\s/.test(chars[i - 1] ?? ''))
            i--;
        return i;
    };
    useInput((input, key) => {
        const currentSuggestion = suggestionRef.current;
        const popupIsOpen = Boolean(currentSuggestion && (currentSuggestion.candidates.length > 0 || currentSuggestion.error));
        // enter submits; the modifier variants insert a line break instead.
        if (key.return) {
            if (key.shift || key.meta || key.ctrl) {
                const at = offsetRef.current;
                applyEdit(at, at, newlineWithIndent());
                return;
            }
            // Enter accepts the highlighted @ candidate instead of submitting.
            if (popupIsOpen && currentSuggestion) {
                const candidate = currentSuggestion.candidates[Math.min(currentSuggestion.index, currentSuggestion.candidates.length - 1)];
                if (candidate) {
                    acceptMention(candidate);
                    return;
                }
            }
            onSubmit(valueRef.current);
            return;
        }
        if (key.escape && popupIsOpen) {
            setSuggestion(null);
            if (mentionRef.current)
                setDismissedToken(mentionRef.current.token);
            return;
        }
        if (key.leftArrow || key.rightArrow) {
            const at = offsetRef.current;
            const chars = pointsRef.current;
            if (key.ctrl || key.meta) {
                // Word-wise navigation; App reserves only ctrl+up/down for scrolling.
                let next = at;
                if (key.leftArrow) {
                    while (next > 0 && /\s/.test(chars[next - 1] ?? ''))
                        next--;
                    while (next > 0 && !/\s/.test(chars[next - 1] ?? ''))
                        next--;
                }
                else {
                    while (next < chars.length && !/\s/.test(chars[next] ?? ''))
                        next++;
                    while (next < chars.length && /\s/.test(chars[next] ?? ''))
                        next++;
                }
                offsetRef.current = next;
                setCursor(next);
            }
            else {
                const next = key.leftArrow ? Math.max(0, at - 1) : Math.min(chars.length, at + 1);
                offsetRef.current = next;
                setCursor(next);
            }
            return;
        }
        // Alt/Ctrl+Backspace deletes one whole word, ahead of the single-glyph
        // branch below. Ink reports Alt as `meta`.
        if ((key.backspace || key.delete) && (key.meta || key.ctrl)) {
            const at = offsetRef.current;
            applyEdit(wordStartBefore(at), at, '');
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
                    const at = offsetRef.current;
                    applyEdit(at, at, newlineWithIndent());
                    return;
                }
                case 'a':
                    offsetRef.current = 0;
                    setCursor(0);
                    return;
                case 'e': {
                    const end = pointsRef.current.length;
                    offsetRef.current = end;
                    setCursor(end);
                    return;
                }
                case 'u':
                    applyEdit(0, pointsRef.current.length, '');
                    return;
                case 'w': {
                    const at = offsetRef.current;
                    applyEdit(wordStartBefore(at), at, '');
                    return;
                }
                case 'd': {
                    const at = offsetRef.current;
                    if (at < pointsRef.current.length)
                        applyEdit(at, at + 1, '');
                    return;
                }
                case 'k':
                    applyEdit(offsetRef.current, pointsRef.current.length, '');
                    return;
                default:
                    return;
            }
        }
        if (key.backspace || key.delete) {
            const at = offsetRef.current;
            if (at === 0)
                return;
            applyEdit(at - 1, at, '');
            return;
        }
        // Home/End jump to the first/last candidate while the @ popup is open.
        // Skills are last, so End is the quick route to them in a long list.
        if (popupIsOpen && currentSuggestion && currentSuggestion.candidates.length > 0 &&
            (key.home || key.end || key.pageUp || key.pageDown)) {
            const count = currentSuggestion.candidates.length;
            const page = Math.max(1, MAX_POPUP_ITEMS - 3);
            setSuggestion((prev) => {
                if (!prev)
                    return prev;
                let index = prev.index;
                if (key.home)
                    index = 0;
                else if (key.end)
                    index = count - 1;
                else if (key.pageUp)
                    index = Math.max(0, index - page);
                else
                    index = Math.min(count - 1, index + page);
                return { ...prev, index };
            });
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
            const chars = pointsRef.current;
            const at = offsetRef.current;
            const rows = wrapPromptLines(chars, displayWidth);
            const next = moveCursorVertically(chars, rows, at, key.upArrow ? -1 : 1);
            if (next !== at) {
                offsetRef.current = next;
                setCursor(next);
            }
            return;
        }
        // Tab completes an @mention when the caret is inside one; otherwise it is
        // left to App (which toggles plan/build mode).
        if (key.tab && !key.shift) {
            if (popupIsOpen && currentSuggestion) {
                const candidate = currentSuggestion.candidates[Math.min(currentSuggestion.index, currentSuggestion.candidates.length - 1)];
                if (candidate) {
                    acceptMention(candidate);
                    return;
                }
            }
            const liveMention = findMentionInValue(valueRef.current, offsetRef.current);
            if (onCompleteMention && liveMention) {
                void Promise.resolve(onCompleteMention(valueRef.current, offsetRef.current)).then((result) => {
                    if (!result)
                        return;
                    valueRef.current = result.value;
                    pointsRef.current = Array.from(result.value);
                    offsetRef.current = result.cursor;
                    onChange(result.value);
                    setCursor(result.cursor);
                });
                return;
            }
        }
        // Ignore every other control/modifier key: they are never text.
        if (key.ctrl || key.meta || key.escape || key.tab)
            return;
        // Mouse reports arrive as text (Ink strips the leading ESC); never insert them.
        // Pasted text may contain real newlines: keep them so multi-line prompts
        // pasted from elsewhere stay multi-line, but normalise CRLF and drop tabs.
        const text = stripMouseReports(input).replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
        if (!text)
            return;
        // A big or multi-line paste goes through the caller, which may spill it to
        // disk and hand back a one-line marker instead of hundreds of rows.
        if (onPaste && (text.includes('\n') || text.length >= 2_000)) {
            const at = offsetRef.current;
            void Promise.resolve(onPaste(text)).then((replacement) => {
                const inserted = typeof replacement === 'string' ? replacement : text;
                applyEdit(at, at, inserted);
            });
            return;
        }
        const at = offsetRef.current;
        applyEdit(at, at, text);
    }, { isActive: !isDisabled });
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
        firstRow = Math.min(Math.max(0, cursorLine - visibleRows + 1), lines.length - visibleRows);
        if (cursorLine < firstRow)
            firstRow = cursorLine;
    }
    const windowLines = lines.slice(firstRow, firstRow + visibleRows);
    const rows = Math.max(1, windowLines.length);
    // Suggestion popup geometry. Its rows are included in the reported height so
    // the surrounding layout reserves space instead of clipping the card.
    // Files first, then skills. Both groups stay visible at once (the collector
    // caps files and skills), so a skill title is never hidden below the fold.
    const MAX_POPUP_ITEMS = 10;
    const popupVisible = suggestionOpen && Boolean(suggestion);
    const selected = suggestion ? Math.min(suggestion.index, Math.max(0, suggestion.candidates.length - 1)) : 0;
    const popupStart = suggestion && suggestion.candidates.length > MAX_POPUP_ITEMS
        ? Math.max(0, Math.min(selected - 1, suggestion.candidates.length - MAX_POPUP_ITEMS))
        : 0;
    const visibleCandidates = suggestion?.candidates.slice(popupStart, popupStart + MAX_POPUP_ITEMS) ?? [];
    // Skills are collected first, files/directories after. Insert one heading at
    // each group boundary and count those rows so Ink reserves space for them.
    const candidateGroup = (candidate) => candidate.kind === 'skill' ? 'skill' : 'file';
    const startsGroup = (index) => index === 0 ||
        candidateGroup(visibleCandidates[index - 1]) !== candidateGroup(visibleCandidates[index]);
    const headingRows = visibleCandidates.reduce((count, _candidate, index) => count + (startsGroup(index) ? 1 : 0), 0);
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
        if (reportedRows.current === totalRows)
            return;
        reportedRows.current = totalRows;
        onRowsChange?.(totalRows);
    }, [totalRows, onRowsChange]);
    const popupWidth = Math.max(24, Math.min(displayWidth > 1000 ? 64 : displayWidth, 64));
    const rule = '─'.repeat(Math.max(1, popupWidth - 4));
    const kindIcon = {
        file: '▤', directory: '▸', skill: '◈',
    };
    const kindColor = {
        file: 'muted', directory: 'info', skill: 'accent',
    };
    // Render one visual row: text spans keep their path colour, and the caret is
    // a separate inverse cell to the RIGHT of the text, never painted onto a
    // character. Only when a row is completely full does it fall back to the
    // last cell, so the composer never grows past its width budget.
    const renderFieldRow = (text, rel) => {
        const spans = splitPathTokens(text || ' ');
        const total = spans.reduce((sum, span) => sum + Array.from(span.text).length, 0);
        const caretAtEnd = rel !== null && rel >= total;
        let consumed = 0;
        const nodes = spans.map((span, index) => {
            const points = Array.from(span.text);
            const spanStart = consumed;
            consumed += points.length;
            const color = span.path ? theme.accent : theme.text;
            if (rel === null || rel < spanStart || rel >= spanStart + points.length) {
                return _jsx(Text, { color: color, children: span.text }, index);
            }
            const local = rel - spanStart;
            return (_jsxs(Text, { color: color, children: [points.slice(0, local).join(''), _jsx(Text, { inverse: true, children: points[local] ?? ' ' }), points.slice(local + 1).join('')] }, index));
        });
        if (caretAtEnd) {
            const used = Array.from(text).reduce((sum, ch) => sum + charWidth(ch), 0);
            // Append only when the row has a spare column; a completely full row
            // stays within budget and simply shows no separate caret cell.
            if (used < displayWidth) {
                nodes.push(_jsx(Text, { inverse: true, children: '▏' }, "caret"));
            }
        }
        return nodes;
    };
    const fieldNode = !value ? (_jsx(Text, { color: theme.placeholder, wrap: "truncate-end", children: placeholder })) : (_jsx(Text, { color: theme.text, wrap: "truncate-end", children: windowLines.map((line, index) => {
            const text = displayPoints.slice(line.start, line.end).join('');
            const newline = index > 0 ? '\n' : null;
            const rel = firstRow + index === cursorLine
                ? Math.max(0, Math.min(offset - line.start, Array.from(text).length))
                : null;
            return (_jsxs(React.Fragment, { children: [newline, renderFieldRow(text, rel)] }, index));
        }) }));
    const popupNode = popupVisible && suggestion ? (_jsxs(Box, { flexDirection: "column", width: popupWidth, flexShrink: 0, borderStyle: "round", borderColor: theme.border, backgroundColor: theme.surface, paddingX: 1, marginBottom: 1, children: [_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", overflow: "hidden", children: [_jsx(Text, { color: theme.accent, bold: true, wrap: "truncate-end", children: '◈ Reference' }), _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `${Math.min(selected + 1, suggestion.candidates.length)}/${suggestion.candidates.length} · ↑↓ move · end skills · enter · esc` })] }), _jsx(Text, { color: theme.border, wrap: "truncate-end", children: rule }), hiddenAbove > 0 ? _jsx(Text, { color: theme.dim, children: `  ↑ ${hiddenAbove} more` }) : null, visibleCandidates.map((candidate, index) => {
                const active = popupStart + index === selected;
                const group = candidateGroup(candidate);
                return (_jsxs(React.Fragment, { children: [startsGroup(index) ? (_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", overflow: "hidden", children: [_jsx(Text, { color: theme.dim, bold: true, wrap: "truncate-end", children: group === 'skill' ? 'Skills' : 'Files' }), _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: ` ${group === 'skill' ? skillCount : fileCount}` })] })) : null, _jsxs(Box, { flexDirection: "row", justifyContent: "space-between", overflow: "hidden", children: [_jsxs(Box, { flexShrink: 0, flexDirection: "row", children: [_jsx(Text, { color: active ? theme.accent : theme.dim, children: active ? '› ' : '  ' }), _jsx(Text, { color: theme[kindColor[candidate.kind]], children: `${kindIcon[candidate.kind]} ` }), _jsx(Text, { color: active ? theme.accent : theme.text, bold: active || candidate.kind === 'skill', children: candidate.label })] }), candidate.detail ? (_jsx(Box, { flexShrink: 1, minWidth: 0, marginLeft: 2, overflow: "hidden", children: _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: candidate.source ? `${candidate.source} · ${candidate.detail}` : candidate.detail }) })) : null] })] }, candidate.id));
            }), hiddenBelow > 0 ? _jsx(Text, { color: theme.dim, children: `  ↓ ${hiddenBelow} more` }) : null, suggestion.error ? (_jsx(Text, { color: theme.error, wrap: "truncate-end", children: `⚠ ${suggestion.error}` })) : null] })) : null;
    // A fragment (not a Box) keeps the field's full-width layout: a wrapping Box
    // would measure the Text at its content width and truncate multi-row drafts.
    return (_jsxs(_Fragment, { children: [popupNode, fieldNode] }));
};
