import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Text, useInput } from 'ink';
import { stripMouseReports } from '../utils/mouse.js';
import { useTheme } from '../theme.js';
// Display columns without a dependency: CJK/emoji take two, combining/zero-width take none.
const WIDE = /[\u{1100}-\u{115F}\u{2329}-\u{232A}\u{2E80}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE10}-\u{FE19}\u{FE30}-\u{FE6F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const ZERO = /[\u0300-\u036F\u200B-\u200F\uFEFF]/;
const charWidth = (ch) => ZERO.test(ch) || ch === '\uFE0F' ? 0 : WIDE.test(ch) ? 2 : 1;
/**
 * Single-line prompt input.
 *
 * Owned by us instead of @inkjs/ui so control keys (ctrl+a, ctrl+d, …) never
 * get inserted as text, and so the cursor is drawn in our own palette.
 */
export const PromptInput = ({ value, onChange, onSubmit, placeholder = '', isDisabled = false, mask = false, width, }) => {
    const theme = useTheme();
    // Cursor is a code-point index, not a UTF-16 offset: arrows and backspace
    // must land on whole glyphs (emoji are two UTF-16 units, CJK are two columns).
    const points = Array.from(value);
    const [cursor, setCursor] = useState(points.length);
    const offset = Math.min(cursor, points.length);
    // Start index of the whitespace-delimited word before `at` (code points).
    // Like readline's word-rubout, trailing whitespace is eaten with the word.
    const wordStartBefore = (at) => {
        let i = at;
        while (i > 0 && /\s/.test(points[i - 1]))
            i--;
        while (i > 0 && !/\s/.test(points[i - 1]))
            i--;
        return i;
    };
    useInput((input, key) => {
        if (key.return) {
            onSubmit(value);
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
        if (key.ctrl || key.meta) {
            switch (input.toLowerCase()) {
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
            if (offset === 0)
                return;
            onChange(points.slice(0, offset - 1).join('') + points.slice(offset).join(''));
            setCursor(offset - 1);
            return;
        }
        // Ignore every other control/modifier key: they are never text.
        if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow)
            return;
        // Mouse reports arrive as text (Ink strips the leading ESC); never insert them.
        const text = stripMouseReports(input).replace(/[\r\n\t]+/g, ' ');
        if (!text)
            return;
        onChange(points.slice(0, offset).join('') + text + points.slice(offset).join(''));
        setCursor(offset + Array.from(text).length);
    }, { isActive: !isDisabled });
    if (!value) {
        return (_jsx(Text, { color: theme.placeholder, wrap: "truncate-end", children: placeholder }));
    }
    // Mask keeps one star per glyph (not per UTF-16 unit), so display and the
    // value share a code-point index and the cursor lands on the right column.
    const display = mask ? '*'.repeat(points.length) : value;
    const chars = Array.from(display);
    const cursorAt = offset;
    // Slice to a window of at most `width` columns that always contains the cursor.
    // Without a width, `wrap="truncate-end"` below keeps the value on one row.
    const widths = chars.map(charWidth);
    let start = 0;
    let end = chars.length;
    if (width && width > 0) {
        const limit = Math.max(1, Math.floor(width));
        let budget = limit - (widths[cursorAt] ?? 1);
        let i = cursorAt;
        while (i > 0) {
            const w = widths[i - 1];
            if (w > budget)
                break;
            budget -= w;
            i--;
        }
        start = i;
        end = start;
        let used = 0;
        while (end < chars.length && used + widths[end] <= limit) {
            used += widths[end];
            end++;
        }
        // A single wide glyph can outgrow a very small window; still show the cursor.
        end = Math.max(end, Math.min(chars.length, cursorAt + 1));
    }
    const shown = chars.slice(start, end);
    const rel = cursorAt - start;
    const before = shown.slice(0, rel).join('');
    const at = shown[rel] ?? ' ';
    const after = shown.slice(rel + 1).join('');
    return (_jsxs(Text, { color: theme.text, wrap: "truncate-end", children: [before, _jsx(Text, { inverse: true, children: at }), after] }));
};
