import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { STATUS_LINE_ITEMS } from '../settings.js';
// Bouncing equaliser: shifts one bar per frame so it reads as AI activity.
const WAVE = '▁▂▃▄▅▆▇█▇▆▅▄▃▂▁';
const WAVE_WIDTH = 10;
const LEVELS = '▁▂▃▄▅▆▇█';
// Dark → bright blue, so taller bars glow more.
const LEVEL_COLORS = [
    '#1e3a8a',
    '#1d4ed8',
    '#2563eb',
    '#3b82f6',
    '#60a5fa',
    '#93c5fd',
    '#bfdbfe',
    '#e0f2fe',
];
function wave(frame) {
    const start = frame % WAVE.length;
    return (WAVE + WAVE).slice(start, start + WAVE_WIDTH);
}
/** A moving highlight sweeps across the label, like a thinking indicator. */
const Shimmer = ({ text, frame }) => {
    const theme = useTheme();
    const span = text.length + 8;
    const head = frame % span;
    return (_jsx(_Fragment, { children: [...text].map((char, index) => {
            const distance = Math.abs(index - (head - 4));
            const color = distance <= 1 ? theme.text : distance <= 3 ? theme.muted : theme.dim;
            return (_jsx(Text, { color: color, children: char }, index));
        }) }));
};
/**
 * Footer under the prompt: folder on the left — swapped for a live activity
 * wave while the agent works — and model · variant · context on the right.
 */
export const UsageDisplay = ({ usage, totalCost, modelLabel, variantLabel, variantColor, folder, busy, tool, frame, compact = false, gutter = 2, dense = false, segments = STATUS_LINE_ITEMS, }) => {
    const theme = useTheme();
    const context = usage ? `${usage.contextPercent.toFixed(0)}%` : '0%';
    const show = (segment) => segments.includes(segment);
    // One combined row per side keeps the footer a single line; a segment is
    // joined only when it is enabled so hidden items leave no stray separators.
    const rightParts = [];
    if (show('model'))
        rightParts.push(_jsx(Text, { color: theme.muted, children: modelLabel }, "model"));
    if (!compact && show('variant')) {
        rightParts.push(_jsx(Text, { color: theme.dim, children: " \u00B7 " }, "variant-sep"));
        rightParts.push(_jsx(Text, { color: variantColor, children: variantLabel }, "variant"));
    }
    if (show('context')) {
        if (rightParts.length > 0)
            rightParts.push(_jsx(Text, { color: theme.dim, children: " \u00B7 " }, "ctx-sep"));
        rightParts.push(_jsx(Text, { color: theme.dim, children: `ctx ${context}` }, "ctx"));
    }
    if (!compact && show('cost') && totalCost > 0) {
        rightParts.push(_jsx(Text, { color: theme.dim, children: ` · $${totalCost.toFixed(2)}` }, "cost"));
    }
    return (_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", paddingX: gutter, marginBottom: dense ? 0 : 1, flexShrink: 0, children: [_jsx(Box, { flexShrink: 1, minWidth: 0, overflow: "hidden", flexDirection: "row", children: show('tool') && busy ? (_jsxs(_Fragment, { children: [wave(frame)
                            .split('')
                            .map((bar, index) => (_jsx(Text, { color: LEVEL_COLORS[LEVELS.indexOf(bar)], bold: true, children: bar }, index))), tool && (_jsxs(_Fragment, { children: [_jsx(Text, { children: '  ' }), _jsx(Shimmer, { text: `running ${tool}`, frame: frame })] }))] })) : show('folder') ? (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `📁 ${folder}` })) : null }), _jsx(Box, { flexShrink: 1, minWidth: 0, children: _jsx(Text, { wrap: "truncate-end", children: rightParts }) })] }));
};
