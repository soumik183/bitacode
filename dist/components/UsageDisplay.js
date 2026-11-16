import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
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
export const UsageDisplay = ({ usage, totalCost, modelLabel, variantLabel, variantColor, folder, busy, tool, frame, compact = false, gutter = 2, }) => {
    const context = usage ? `${usage.contextPercent.toFixed(0)}%` : '0%';
    return (_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", paddingX: gutter, marginBottom: 1, flexShrink: 0, children: [_jsx(Box, { flexShrink: 1, flexDirection: "row", children: busy ? (_jsxs(_Fragment, { children: [wave(frame)
                            .split('')
                            .map((bar, index) => (_jsx(Text, { color: LEVEL_COLORS[LEVELS.indexOf(bar)], bold: true, children: bar }, index))), tool && (_jsxs(_Fragment, { children: [_jsx(Text, { children: '  ' }), _jsx(Shimmer, { text: `running ${tool}`, frame: frame })] }))] })) : (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: `📁 ${folder}` })) }), _jsx(Box, { flexShrink: 1, minWidth: 0, children: _jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.muted, children: modelLabel }), !compact && (_jsxs(_Fragment, { children: [_jsx(Text, { color: theme.dim, children: " \u00B7 " }), _jsx(Text, { color: variantColor, children: variantLabel })] })), _jsxs(Text, { color: theme.dim, children: [" \u00B7 ctx ", context] }), !compact && totalCost > 0 && _jsxs(Text, { color: theme.dim, children: [" \u00B7 $", totalCost.toFixed(2)] })] }) })] }));
};
