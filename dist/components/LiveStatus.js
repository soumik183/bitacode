import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
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
            // "Reading file", "Searching files" and "Delegating sub-agents" already
            // carry their object; "Working file" or "Building bash" would be noise,
            // so those two phases stay bare.
            if (label === 'Working' || label === 'Building')
                return label;
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
    const tps = props.tps ? ` · ${props.tps}` : '';
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
    const candidates = liveStatusCandidates({ activity, tool, elapsedMs, tps, hint });
    const fitted = candidates.find((entry) => entry.length <= width) ?? candidates[candidates.length - 1];
    const text = fitted.length <= width ? fitted : `${fitted.slice(0, Math.max(1, width - 1))}…`;
    return (_jsx(Box, { height: 1, flexShrink: 0, paddingX: gutter, overflow: "hidden", children: _jsxs(Text, { wrap: "truncate-end", children: [_jsxs(Text, { color: color, children: [spinnerGlyph(frame, animate), " "] }), _jsx(Text, { color: activity === 'tool' ? theme.muted : theme.muted, wrap: "truncate-end", children: text.slice(0, Math.max(1, width - 2)) })] }) }));
};
export default LiveStatus;
