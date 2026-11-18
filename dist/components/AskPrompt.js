import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { LeftBar } from './LeftBar.js';
import { stripMouseReports } from '../utils/mouse.js';
/** Marker shown next to the agent's own recommendation. */
const RECOMMENDED_TAG = 'recommended';
/** Marker shown for a chosen option in multi-select mode. */
const CHECKED = '◉';
const UNCHECKED = '◯';
// Fixed columns an option line spends before its label: the LeftBar gutter,
// the cursor, the optional multi-select marker and the "N. " index.
const GUTTER = 2;
const CURSOR = 2;
const NUMBER = 3;
const indentFor = (multiple) => CURSOR + (multiple ? 2 : 0) + NUMBER;
function clampText(text, width) {
    const single = text.replace(/\s+/g, ' ').trim();
    if (single.length <= width)
        return single;
    if (width <= 1)
        return '…';
    return `${single.slice(0, width - 1)}…`;
}
/**
 * Interactive "the agent is asking you something" prompt.
 *
 * Design goals:
 *  - keyboard driven, no mouse required
 *  - one question at a time, so multi-question asks stay readable
 *  - options are pre-selected-able and the agent's recommendation is marked
 *  - typing is always allowed unless the question sets allow_free_text false
 *  - a progress line makes a multi-question ask feel bounded
 */
export const AskPrompt = ({ questions, columns, compact = false, onRespond }) => {
    const [index, setIndex] = useState(0);
    const [answers, setAnswers] = useState({});
    const [cursor, setCursor] = useState(0);
    // useInput closes over the render it was registered in, so a fast
    // "down then enter" sequence could commit the previously highlighted
    // option. Mirror the cursor in a ref that updates synchronously and read
    // that inside the key handler.
    const cursorRef = useRef(0);
    const moveCursor = (next) => {
        cursorRef.current = next;
        setCursor(next);
    };
    const [typing, setTyping] = useState(false);
    const [draft, setDraft] = useState('');
    // Multi-select state: option indexes chosen for the current question.
    const [picked, setPicked] = useState([]);
    // Same staleness problem as the cursor: the input handler must see the
    // selections made earlier in the same burst, not the ones from this render.
    const pickedRef = useRef([]);
    const setPickedNow = (next) => {
        pickedRef.current = next;
        setPicked(next);
    };
    const question = questions[index];
    const total = questions.length;
    const options = question?.options ?? [];
    const canType = question?.allow_free_text !== false;
    const hasOptions = options.length > 0;
    // Fit the terminal: an old 20-column floor overflowed narrow/zoomed screens.
    const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
    const width = Math.max(1, cols - 8);
    const currentAnswer = () => {
        if (question?.multiple && pickedRef.current.length > 0) {
            return pickedRef.current
                .slice()
                .sort((a, b) => a - b)
                .map((optionIndex) => options[optionIndex]?.label)
                .filter(Boolean)
                .join(', ');
        }
        if (typing || !hasOptions)
            return draft.trim();
        return options[cursorRef.current]?.label ?? '';
    };
    const commit = (value) => {
        const trimmed = value.trim();
        const next = { ...answers, [question.id ?? `q${index + 1}`]: trimmed };
        setAnswers(next);
        if (index + 1 < total) {
            // Advance to the next question and reset its own input state.
            setIndex(index + 1);
            moveCursor(0);
            setTyping(false);
            setDraft('');
            setPickedNow([]);
            return;
        }
        // Last question: hand every answer back in ask order.
        onRespond(questions.map((entry, entryIndex) => ({
            id: entry.id ?? `q${entryIndex + 1}`,
            question: entry.question,
            answer: next[entry.id ?? `q${entryIndex + 1}`] ?? '',
        })));
    };
    useInput((input, key) => {
        if (!question)
            return;
        if (key.escape) {
            // Esc declines the whole ask rather than trapping the user in it.
            onRespond(questions.map((entry, entryIndex) => ({
                id: entry.id ?? `q${entryIndex + 1}`,
                question: entry.question,
                answer: '',
            })));
            return;
        }
        if (typing) {
            if (key.return) {
                commit(draft);
                return;
            }
            if (key.backspace || key.delete) {
                setDraft((prev) => prev.slice(0, -1));
                return;
            }
            if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow)
                return;
            const text = stripMouseReports(input).replace(/[\r\n\t]+/g, ' ');
            if (text)
                setDraft((prev) => prev + text);
            return;
        }
        if (key.upArrow) {
            if (hasOptions)
                moveCursor((cursorRef.current - 1 + options.length) % options.length);
            return;
        }
        if (key.downArrow) {
            if (hasOptions)
                moveCursor((cursorRef.current + 1) % options.length);
            return;
        }
        // Tab switches between picking an option and typing a custom answer.
        if (key.tab) {
            if (canType && hasOptions) {
                setTyping(true);
                setDraft('');
            }
            return;
        }
        // A number key jumps straight to that option.
        if (hasOptions && /^[1-9]$/.test(input)) {
            const optionIndex = Number(input) - 1;
            if (optionIndex < options.length) {
                if (question.multiple) {
                    const previous = pickedRef.current;
                    setPickedNow(previous.includes(optionIndex)
                        ? previous.filter((entry) => entry !== optionIndex)
                        : [...previous, optionIndex]);
                }
                else {
                    moveCursor(optionIndex);
                    commit(options[optionIndex].label);
                }
            }
            return;
        }
        if (key.return) {
            if (question.multiple) {
                if (pickedRef.current.length > 0) {
                    commit(currentAnswer());
                }
                else if (hasOptions) {
                    setPickedNow([cursorRef.current]);
                }
                return;
            }
            commit(currentAnswer());
            return;
        }
        // Start typing when the question is free-text only, or on a printable key.
        if (canType && !hasOptions) {
            setTyping(true);
            const text = stripMouseReports(input).replace(/[\r\n\t]+/g, ' ');
            if (text)
                setDraft(text);
        }
    });
    if (!question)
        return null;
    const multiple = Boolean(question.multiple);
    const indent = indentFor(multiple);
    // Long "recommended" labels eat the whole row on narrow terminals; collapse
    // them to a single star there while keeping the word on roomy screens.
    const showRecommendedText = cols >= 48;
    const gap = compact ? 0 : 1;
    return (_jsx(LeftBar, { color: theme.accent, marginTop: gap, marginBottom: gap, children: _jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { children: [_jsx(Text, { color: theme.accent, bold: true, children: "Agent question" }), total > 1 && (_jsx(Text, { color: theme.dim, children: `  ${index + 1}/${total}` }))] }), _jsx(Text, { color: theme.text, bold: true, wrap: "truncate-end", children: question.question }), question.context && (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: clampText(question.context, width) })), hasOptions && (_jsx(Box, { flexDirection: "column", marginTop: gap, children: options.map((option, optionIndex) => {
                        const active = !typing && optionIndex === cursor;
                        const isPicked = question.multiple ? picked.includes(optionIndex) : active;
                        const recWidth = option.recommended
                            ? showRecommendedText ? RECOMMENDED_TAG.length + 2 : 2
                            : 0;
                        // Reserve only what this specific line actually draws, so long
                        // labels keep as much room as the terminal allows.
                        const labelMax = Math.max(1, cols - GUTTER - indent - recWidth);
                        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: isPicked ? theme.accent : theme.dim, children: `${active ? '❯' : ' '} ` }), multiple && (_jsx(Text, { color: isPicked ? theme.accent : theme.dim, children: `${isPicked ? CHECKED : UNCHECKED} ` })), _jsx(Text, { color: active ? theme.text : theme.muted, bold: active, children: `${optionIndex + 1}. ${clampText(option.label, labelMax)}` }), option.recommended && (_jsx(Text, { color: theme.success, children: showRecommendedText ? `  ${RECOMMENDED_TAG}` : ' ★' }))] }), active && option.description && (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `${' '.repeat(indent)}${clampText(option.description, Math.max(1, cols - GUTTER - indent))}` }))] }, `${option.label}-${optionIndex}`));
                    }) })), typing && (_jsx(Box, { marginTop: gap, children: _jsxs(Text, { children: [_jsx(Text, { color: theme.accent, children: '> ' }), _jsx(Text, { color: theme.text, children: draft }), _jsx(Text, { inverse: true, children: ' ' })] }) })), _jsx(Box, { marginTop: gap, children: _jsx(Text, { color: theme.dim, wrap: "truncate-end", children: typing
                            ? 'type your answer · enter send · esc skip'
                            : [
                                hasOptions ? '↑↓ or 1-9 pick' : 'type your answer',
                                hasOptions && canType ? 'tab type' : '',
                                question.multiple ? 'enter toggle/confirm' : 'enter send',
                                'esc skip',
                            ]
                                .filter(Boolean)
                                .join(' · ') }) })] }) }));
};
