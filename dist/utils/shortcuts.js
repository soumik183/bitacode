/**
 * `?` shortcut panel data and renderer.
 *
 * The catalogue mirrors the keyboard table in README.md and is grouped by
 * task. Rendering is pure and bounded: every line fits the requested width,
 * the panel never exceeds 40 rows, and malformed widths/keybind overrides are
 * ignored rather than thrown.
 */
const DEFS = [
    {
        title: 'Basics',
        items: [
            { keys: 'n', label: 'New session', action: 'newSession' },
            { keys: 's', label: 'Open sessions', action: 'sessions' },
            { keys: 'q', label: 'Quit session' },
            { keys: 'Ctrl+C', label: 'Save and exit' },
            { keys: 'm', label: 'Switch model', action: 'model' },
            { keys: 'p', label: 'Switch provider', action: 'provider' },
            { keys: 'v', label: 'Set reasoning variant' },
            { keys: 'h or /', label: 'Help · shortcuts', action: 'help' },
            { keys: ',', label: 'Open settings', action: 'settings' },
            { keys: '! + command', label: 'Run a shell command locally' },
            { keys: 'k / l', label: 'Clear input / clear transcript' },
        ],
    },
    {
        title: 'Navigation',
        items: [
            { keys: '↑/↓', label: 'Scroll transcript' },
            { keys: 'PgUp/PgDn', label: 'Scroll a page' },
            { keys: 'Home/End', label: 'Jump to start or end' },
            { keys: 'Shift+↑/↓', label: 'Scroll three rows' },
            { keys: 'Ctrl+E', label: 'Expand / collapse all cards' },
            { keys: 'Ctrl+Y', label: 'Copy the last visible card' },
            { keys: '@', label: 'File and skill picker' },
            { keys: '/find', label: 'Search transcript', context: 'composer', action: 'search' },
        ],
    },
    {
        title: 'Agent',
        items: [
            { keys: 'g', label: 'Open the sub-agent list', action: 'subagents' },
            { keys: 'Tab', label: 'Plan ↔ build mode' },
            { keys: 'Ctrl+R', label: 'Retry the last prompt', action: 'retry' },
            { keys: 't', label: 'Toggle thinking', action: 'thinking' },
            { keys: 'Ctrl+T', label: 'Toggle thinking', action: 'thinking' },
            { keys: 'Esc', label: 'Abort the turn or close a prompt' },
            { keys: '1-9', label: 'Answer an ask prompt', context: 'ask prompt' },
        ],
    },
    {
        title: 'Edit',
        items: [
            { keys: 'a', label: 'Start of line' },
            { keys: 'e', label: 'End of line' },
            { keys: 'u', label: 'Clear line' },
            { keys: 'w', label: 'Delete word' },
            { keys: 'd', label: 'Delete char' },
            { keys: 'k', label: 'Delete to end' },
            { keys: 'Ctrl/Alt+←/→', label: 'Move by word' },
            { keys: 'Ctrl+↑', label: 'Edit the last message', action: 'editLast' },
        ],
    },
];
/** Public, stable catalogue (titles in display order). */
export const SHORTCUT_GROUPS = Object.freeze(DEFS.map((group) => ({
    title: group.title,
    items: group.items.map(({ keys, label, context }) => ({ keys, label, context })),
})));
const OVERRIDE_ACTION = new Map(DEFS.flatMap((group) => group.items)
    .filter((item) => typeof item.action === 'string')
    .map((item) => [item.label, item.action]));
const KEY_TOKEN = /^(ctrl|alt|shift)\+[a-z0-9]+$|^[a-z0-9]+$|^(tab|esc|enter|space|up|down|left|right|pageup|pagedown|home|end)$/;
const KEY_LABELS = Object.freeze({
    ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', tab: 'Tab', esc: 'Esc', enter: 'Enter',
    space: 'Space', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
    pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End',
});
const DEFAULT_WIDTH = 100;
const MAX_LINES = 40;
const MAX_KEY_COLUMN = 14;
function widthOf(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return DEFAULT_WIDTH;
    return Math.max(1, Math.floor(value));
}
/** Cut a line to `max` cells, reserving the last one for the ellipsis marker. */
function clip(value, max) {
    if (max <= 0)
        return '';
    const clean = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    if (!clean)
        return '';
    return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
/** `ctrl+h` → `Ctrl+H`, mirroring `utils/keybinds.ts` without its config loader. */
function displayKey(token) {
    return token.split('+').map((part) => {
        const known = KEY_LABELS[part];
        if (known)
            return known;
        return part.length === 1
            ? part.toUpperCase()
            : part.charAt(0).toUpperCase() + part.slice(1);
    }).join('+');
}
function overriddenKeys(item, keybinds) {
    const action = OVERRIDE_ACTION.get(item.label);
    if (!action)
        return item.keys;
    let custom;
    try {
        custom = keybinds == null ? undefined : keybinds[action];
    }
    catch {
        custom = undefined;
    }
    if (typeof custom === 'string') {
        const token = custom.trim().toLowerCase().replace(/\s*\+\s*/g, '+');
        if (token && token.length <= 24 && KEY_TOKEN.test(token))
            return displayKey(token);
    }
    return item.keys;
}
/**
 * Render the shortcut panel as pre-clipped lines.
 *
 * `keybinds` uses the same action ids as `settings.keybindings` (for example
 * `{ help: 'ctrl+h', model: 'ctrl+m' }`). Unknown or malformed entries are
 * ignored. Lines are padded into a small key column, cut with `…` at the
 * requested width, and the panel is capped at 40 lines with a count marker.
 */
export function renderShortcutPanel(width, keybinds) {
    let cols = DEFAULT_WIDTH;
    try {
        cols = widthOf(width);
        const groups = Array.from(SHORTCUT_GROUPS);
        let keyWidth = 0;
        for (const group of groups) {
            for (const item of group.items) {
                keyWidth = Math.max(keyWidth, overriddenKeys(item, keybinds).length);
            }
        }
        keyWidth = Math.min(MAX_KEY_COLUMN, keyWidth);
        const lines = [];
        for (let index = 0; index < groups.length; index++) {
            const group = groups[index];
            lines.push(group.title);
            for (const item of group.items) {
                const keys = overriddenKeys(item, keybinds);
                const pad = Math.max(0, keyWidth - keys.length);
                const detail = typeof item.context === 'string' && item.context
                    ? ` (${item.context})`
                    : '';
                lines.push(`  ${keys}${' '.repeat(pad)}  ${item.label}${detail}`);
            }
        }
        if (lines.length > MAX_LINES) {
            const hidden = lines.length - MAX_LINES + 1;
            return [...lines.slice(0, MAX_LINES - 1), clip(`… ${hidden} more`, cols)];
        }
        return lines.map((line) => clip(line, cols));
    }
    catch {
        return [clip('? help', cols)];
    }
}
