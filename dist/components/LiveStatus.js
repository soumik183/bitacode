import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { formatToolLabel } from '../utils/tool-display.js';
/** Braille spinner — quiet at 60 fps and legible at 1 cell. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export function spinnerGlyph(frame, animate) {
    if (!animate)
        return '◐';
    return FRAMES[Math.abs(Math.floor(frame)) % FRAMES.length];
}
export function formatElapsed(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
}
/**
 * The only activity words the strip is allowed to show.
 *
 * Keeping the vocabulary tiny and honest matters more than variety: the user
 * asked for exactly these phases, and a label that changes every few seconds
 * hides which phase the agent is actually in. So there is no rotation any
 * more — reasoning and replies both read "Working", shell/build work reads
 * "Building", and each tool gets its own verb.
 */
export const ACTIVITY_LABELS = [
    'Working',
    'Building',
    'Reading',
    'Writing',
    'Editing',
    'Searching',
    'Planning',
    'Delegating sub-agents',
];
/**
 * Tool → activity. Matching is prefix-based so new MCP or plugin tools fall
 * back to "Working" instead of showing an internal name at the user.
 */
const TOOL_ACTIVITIES = [
    { pattern: /^(read|open|view|cat)/i, label: 'Reading' },
    { pattern: /^(todo_read|todo_write|update_todo|write_todo|todo)/i, label: 'Planning' },
    { pattern: /^(edit|multi_edit|apply_patch|replace|patch)/i, label: 'Editing' },
    { pattern: /^(write|create|append|save)/i, label: 'Writing' },
    { pattern: /^(search|grep|find|glob|list|ripgrep|rg)/i, label: 'Searching' },
    { pattern: /^(sub_?agent|delegate|spawn|dispatch)/i, label: 'Delegating sub-agents' },
    { pattern: /^(bash|shell|terminal|exec|start_process|verify|build|test)/i, label: 'Building' },
];
/** The verb for a tool name, defaulting to "Working". */
export function toolVerb(tool) {
    const name = (tool ?? '').trim();
    if (!name)
        return 'Working';
    return TOOL_ACTIVITIES.find((entry) => entry.pattern.test(name))?.label ?? 'Working';
}
/** What follows the verb: the object the agent is acting on, or nothing. */
const TOOL_OBJECTS = [
    { pattern: /^(read_sub_?agent|sub_?agent)/i, object: 'sub-agents' },
    { pattern: /^read_image/i, object: 'image' },
    { pattern: /^read/i, object: 'file' },
    { pattern: /^(search_files|grep|find_symbol|find_references|search|find|glob|list_dir|list_files|rg|ripgrep)/i, object: 'files' },
    { pattern: /^(edit_file|write_file|multi_edit|apply_patch|replace|patch)/i, object: 'file' },
    { pattern: /^(write|create|append|save)/i, object: 'file' },
    { pattern: /^(todo_read|todo_write|update_todo|write_todo|todo)/i, object: 'tasks' },
    { pattern: /^plan/i, object: 'work' },
    { pattern: /^ask/i, object: 'question' },
];
/** A short, human object for the tool, so the row never shows snake_case. */
export function toolObject(tool) {
    const name = (tool ?? '').trim();
    if (!name)
        return '';
    return (TOOL_OBJECTS.find((entry) => entry.pattern.test(name))?.object
        ?? name.replace(/[_-]+/g, ' ').trim());
}
/** The leading label for an activity, without metrics. */
export function activityLabel(props) {
    switch (props.activity) {
        case 'tool': {
            const label = toolVerb(props.tool);
            if (label === 'Working' || label === 'Building') {
                // A raw tool name with no known verb would read as a bare "Working";
                // show the same friendly title as the transcript instead.
                if (label === 'Working' && props.tool?.trim()) {
                    return formatToolLabel(props.tool, undefined);
                }
                // "Working file" or "Building bash" would be noise, so bare phases stay.
                return label;
            }
            const object = toolObject(props.tool);
            if (!object || object === 'sub-agents')
                return label;
            return `${label} ${object}`;
        }
        case 'streaming':
        case 'waiting':
        case 'thinking':
        default:
            return 'Working';
    }
}
/**
 * Richest-to-leanest renderings of the status row. The strip picks the first
 * one that fits, so a narrow terminal loses the key hint before it loses the
 * throughput number, and never shows half a word.
 */
export function liveStatusCandidates(props) {
    const elapsedMs = Math.max(0, props.elapsedMs ?? 0);
    const label = activityLabel({ activity: props.activity, tool: props.tool, elapsedMs });
    const elapsed = elapsedMs >= 1000 ? ` · ${formatElapsed(elapsedMs)}` : '';
    // Throughput belongs to decode phases only; a tool phase shows the clock.
    const tps = props.activity !== 'tool' && props.tps ? ` · ${props.tps}` : '';
    const hint = props.hint ? ` · ${props.hint}` : '';
    const candidates = [
        `${label}${tps}${elapsed}${hint}`,
        `${label}${tps}${elapsed}`,
        `${label}${elapsed}`,
        label,
    ];
    return candidates.filter((entry, index) => entry && candidates.indexOf(entry) === index);
}
/** The row's text content without colour, exposed for tests. */
export function liveStatusText(props) {
    const elapsedMs = Math.max(0, props.elapsedMs ?? 0);
    const elapsed = elapsedMs >= 1000 ? ` · ${formatElapsed(elapsedMs)}` : '';
    const tps = props.tps ? ` · ${props.tps}` : '';
    const hint = props.hint ? ` · ${props.hint}` : '';
    const label = activityLabel({ activity: props.activity, tool: props.tool, elapsedMs });
    // Reasoning and replies show throughput; tool phases show only the clock.
    return `${label}${props.activity === 'tool' ? elapsed : tps + elapsed}${hint}`;
}
export const LiveStatus = ({ activity, tool, elapsedMs = 0, tps, frame = 0, animate = true, gutter = 2, hint = 'esc to interrupt', columns, }) => {
    const theme = useTheme();
    const color = activity === 'tool' ? theme.info : activity === 'thinking' ? theme.accent : theme.muted;
    // Never wrap: the lane is exactly one row, so long tool names truncate.
    const width = Math.max(1, (Number.isFinite(columns) ? Math.floor(columns) : 80) - gutter * 2 - 2);
    // The label and the live metrics matter; the key hint is the first thing to
    // go when the row is tight, instead of chopping the word "interrupt".
    // Fit against the text budget itself: slicing again after fitting used to
    // chop perfectly valid candidates.
    const budget = Math.max(1, width - 2);
    const candidates = liveStatusCandidates({ activity, tool, elapsedMs, tps, hint });
    const fitted = candidates.find((entry) => entry.length <= budget) ?? candidates[candidates.length - 1];
    const text = fitted.length <= budget ? fitted : `${fitted.slice(0, Math.max(1, budget - 1))}…`;
    // Split the label from its metrics so the phase reads first and the numbers
    // recede, rather than one flat grey line.
    const [label, ...trailing] = text.split(' · ');
    const tail = trailing.length > 0 ? ` · ${trailing.join(' · ')}` : '';
    return (_jsx(Box, { height: 1, flexShrink: 0, paddingX: gutter, overflow: "hidden", children: _jsxs(Text, { wrap: "truncate-end", children: [_jsxs(Text, { color: color, children: [spinnerGlyph(frame, animate), " "] }), _jsx(Text, { color: theme.text, bold: true, wrap: "truncate-end", children: label }), tail ? (_jsx(Text, { color: theme.dim, wrap: "truncate-end", children: tail })) : null] }) }));
};
export default LiveStatus;
