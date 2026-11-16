import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Text, useInput } from 'ink';
import { stripMouseReports } from '../utils/mouse.js';
import { theme } from '../theme.js';
/**
 * Single-line prompt input.
 *
 * Owned by us instead of @inkjs/ui so control keys (ctrl+a, ctrl+d, …) never
 * get inserted as text, and so the cursor is drawn in our own palette.
 */
export const PromptInput = ({ value, onChange, onSubmit, placeholder = '', isDisabled = false, mask = false, }) => {
    const [cursor, setCursor] = useState(value.length);
    const offset = Math.min(cursor, value.length);
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
            setCursor(Math.min(value.length, offset + 1));
            return;
        }
        if (key.backspace || key.delete) {
            if (offset === 0)
                return;
            onChange(value.slice(0, offset - 1) + value.slice(offset));
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
        onChange(value.slice(0, offset) + text + value.slice(offset));
        setCursor(offset + text.length);
    }, { isActive: !isDisabled });
    if (!value) {
        return _jsx(Text, { color: theme.placeholder, children: placeholder });
    }
    const display = mask ? '*'.repeat(value.length) : value;
    const before = display.slice(0, offset);
    const at = display[offset] ?? ' ';
    const after = display.slice(offset + 1);
    return (_jsxs(Text, { color: theme.text, children: [before, _jsx(Text, { inverse: true, children: at }), after] }));
};
