import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { formatTokenCount } from '../utils/cost-tracker.js';
import { STATUS_LINE_ITEMS } from '../settings.js';
// Bouncing equaliser: shifts one bar per frame so it reads as AI activity.
const WAVE = '▁▂▃▄▅▆▇█▇▆▅▄▃▂▁';
const WAVE_WIDTH = 10;
const LEVELS = '▁▂▃▄▅▆▇█';
/** Blend two theme colours; falls back to the nearer slot for named colours. */
function mixColor(from, to, t) {
    const parse = (color) => {
        const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(String(color ?? '').trim());
        if (!match)
            return null;
        const hex = match[1].length === 3
            ? match[1].split('').map((ch) => ch + ch).join('')
            : match[1];
        return [
            parseInt(hex.slice(0, 2), 16),
            parseInt(hex.slice(2, 4), 16),
            parseInt(hex.slice(4, 6), 16),
        ];
    };
    const a = parse(from);
    const b = parse(to);
    if (!a || !b)
        return t < 0.5 ? from : to;
    return `#${a.map((value, i) => Math.round(value + (b[i] - value) * t).toString(16).padStart(2, '0')).join('')}`;
}
/** Low → high bars ramp from the theme's info slot to its accent slot. */
function levelColors(theme) {
    return Array.from({ length: LEVELS.length }, (_, index) => mixColor(theme.info, theme.accent, index / Math.max(1, LEVELS.length - 1)));
}
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
export const UsageDisplay = ({ usage, totalCost, modelLabel, variantLabel, variantColor, folder, branch, contextTokens, contextWindow, busy, tool, frame, compact = false, gutter = 2, dense = false, segments = STATUS_LINE_ITEMS, tps = null, }) => {
    const theme = useTheme();
    const bars = levelColors(theme);
    // Prefer the real window + token count so the number and percentage always
    // agree; older events only carry a precomputed percentage, so fall back to it.
    const windowSize = contextWindow ?? 0;
    const usedTokens = contextTokens ?? 0;
    const context = windowSize > 0 && usage
        ? `${formatTokenCount(usedTokens)} (${Math.min(100, (usedTokens / windowSize) * 100).toFixed(0)}%)`
        : usage
            ? `${usage.contextPercent.toFixed(0)}%`
            : '0%';
    const show = (segment) => segments.includes(segment);
    // One combined row per side keeps the footer a single line; a segment is
    // joined only when it is enabled so hidden items leave no stray separators.
    const rightParts = [];
    if (show('model')) {
        // "Provider / Model": dim the provider, brighten the model. This reads as a
        // hierarchy instead of one flat grey string.
        const split = modelLabel.indexOf(' / ');
        if (split > 0) {
            rightParts.push(_jsxs(Text, { children: [_jsx(Text, { color: theme.dim, children: modelLabel.slice(0, split) }), _jsx(Text, { color: theme.border, children: ' / ' }), _jsx(Text, { color: theme.text, children: modelLabel.slice(split + 3) })] }, "model"));
        }
        else {
            rightParts.push(_jsx(Text, { color: theme.muted, children: modelLabel }, "model"));
        }
    }
    if (!compact && show('variant')) {
        rightParts.push(_jsx(Text, { color: theme.dim, children: " \u00B7 " }, "variant-sep"));
        rightParts.push(_jsx(Text, { color: variantColor, children: variantLabel }, "variant"));
    }
    if (show('context')) {
        if (rightParts.length > 0)
            rightParts.push(_jsx(Text, { color: theme.dim, children: " \u00B7 " }, "ctx-sep"));
        rightParts.push(_jsx(Text, { color: theme.dim, children: context }, "ctx"));
    }
    if (!compact && show('cost') && totalCost > 0) {
        rightParts.push(_jsx(Text, { color: theme.dim, children: rightParts.length > 0 ? ` · $${totalCost.toFixed(2)}` : `$${totalCost.toFixed(2)}` }, "cost"));
    }
    return (_jsxs(Box, { flexDirection: "row", width: "100%", backgroundColor: theme.bg, justifyContent: "space-between", paddingX: gutter, marginBottom: dense ? 0 : 1, flexShrink: 0, children: [_jsx(Box, { flexShrink: 1, minWidth: 0, overflow: "hidden", flexDirection: "row", children: show('tool') && busy ? (_jsxs(_Fragment, { children: [wave(frame)
                            .split('')
                            .map((bar, index) => (_jsx(Text, { color: bars[LEVELS.indexOf(bar)] ?? theme.accent, bold: true, children: bar }, index))), tool && (_jsxs(_Fragment, { children: [_jsx(Text, { children: '  ' }), _jsx(Shimmer, { text: `running ${tool}`, frame: frame })] })), !tool && tps && (_jsxs(_Fragment, { children: [_jsx(Text, { children: '  ' }), _jsx(Text, { color: theme.muted, children: tps })] }))] })) : show('folder') ? (_jsxs(Text, { wrap: "truncate-end", children: [_jsx(Text, { color: theme.info, children: '~/' }), _jsx(Text, { color: theme.muted, children: folder }), branch ? _jsx(Text, { color: theme.accent, children: `:${branch}` }) : null] })) : null }), _jsx(Box, { flexShrink: 1, minWidth: 0, children: _jsx(Text, { wrap: "truncate-end", children: rightParts }) })] }));
};
