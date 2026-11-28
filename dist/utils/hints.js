/**
 * Contextual key hints — a lazygit-style, single-line footer strip.
 *
 * The strip only lists keys that are valid *right now*: a modal or picker
 * narrows it to navigation keys, a running turn switches it to abort/scroll
 * (plus a queue cue), and the idle composer advertises discovery shortcuts.
 * Bad input, malformed keybind overrides and absurd widths degrade to a short
 * readable line instead of throwing or wrapping.
 */
/** Actions that may be remapped through the `keybinds` option. */
const DEFAULT_KEYS = Object.freeze({
    send: 'Enter',
    commands: '/',
    files: '@',
    mode: 'Tab',
    help: '?',
    abort: 'Esc',
    scroll: '↑/↓',
    queue: 'Tab',
    close: 'Esc',
    move: '↑/↓',
    select: 'Enter',
    choose: '1-9',
});
const LABELS = Object.freeze({
    send: 'send',
    commands: 'commands',
    files: 'files',
    mode: 'mode',
    help: 'help',
    abort: 'abort',
    scroll: 'scroll',
    queue: 'queue',
    close: 'close',
    move: 'move',
    select: 'select',
    choose: 'choose',
});
const KEY_TOKEN = /^(ctrl|alt|shift)\+[a-z0-9]+$|^[a-z0-9]+$|^(tab|esc|enter|space|up|down|left|right|pageup|pagedown|home|end)$/;
const KEY_LABELS = Object.freeze({
    ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', tab: 'Tab', esc: 'Esc', enter: 'Enter',
    space: 'Space', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
    pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End',
});
const DEFAULT_WIDTH = 100;
const MAX_QUEUE = 99;
function widthOf(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return DEFAULT_WIDTH;
    return Math.max(1, Math.floor(value));
}
function queueOf(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1)
        return 0;
    return Math.min(MAX_QUEUE, Math.floor(value));
}
/** Cut to `max` cells, reserving the last one for the ellipsis marker. */
function clip(value, max) {
    if (max <= 0)
        return '';
    const clean = value.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
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
function keyFor(action, keybinds) {
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
    return DEFAULT_KEYS[action];
}
function pair(action, keybinds, label) {
    return `${keyFor(action, keybinds)} ${label ?? LABELS[action]}`;
}
function actionsFor(ctx, queue) {
    const rawDialog = ctx?.dialog;
    const rawPicker = ctx?.picker;
    const dialog = typeof rawDialog === 'string' && rawDialog.trim().length > 0;
    const picker = typeof rawPicker === 'string' && rawPicker.trim().length > 0;
    const searching = ctx?.searchActive === true;
    const running = ctx?.busy === true || ctx?.streaming === true;
    const compact = ctx?.compact === true;
    if (dialog || picker) {
        return compact ? ['close', 'select'] : ['close', 'move', 'select', 'choose'];
    }
    if (searching) {
        return compact ? ['close', 'select'] : ['close', 'move', 'select'];
    }
    if (running) {
        const actions = ['abort'];
        if (!compact)
            actions.push('scroll');
        if (queue > 0)
            actions.push('queue');
        return actions;
    }
    return compact
        ? ['send', 'commands', 'files']
        : ['send', 'commands', 'files', 'mode', 'help'];
}
/** Fit the ordered pairs into one line, dropping the lowest priority first. */
function fit(badge, pairs, width) {
    if (pairs.length === 0)
        return clip(badge, width) || '…';
    let best = '';
    for (let count = pairs.length; count >= 1; count--) {
        const dropped = count < pairs.length;
        const line = `${badge}${pairs.slice(0, count).join(' · ')}${dropped ? ' …' : ''}`;
        if (line.length <= width) {
            best = line;
            break;
        }
    }
    // Even the highest-priority pair is too long: show as much of it as fits.
    if (!best)
        best = clip(`${badge}${pairs[0]}`, width);
    return best || '…';
}
/**
 * Format the hint strip for the current app context.
 *
 * Keybind overrides are keyed by hint action (`send`, `commands`, `files`,
 * `mode`, `help`, `abort`, `scroll`, `queue`, `close`, `move`, `select`,
 * `choose`) and accept the same tokens as `settings.keybindings`. Invalid
 * overrides are ignored. The result is always a single non-empty line no
 * longer than `width` (default 100), with `…` marking dropped pairs.
 */
export function formatHints(ctx, options) {
    let width = DEFAULT_WIDTH;
    try {
        width = widthOf(options?.width);
        const keybinds = options?.keybinds;
        const badge = ctx?.planMode === true ? '[PLAN] ' : '';
        const queue = queueOf(ctx?.queueCount);
        const actions = actionsFor(ctx, queue);
        const pairs = actions.map((action) => action === 'queue' ? pair(action, keybinds, `queue ${queue}`) : pair(action, keybinds));
        return fit(badge, pairs, width);
    }
    catch {
        return clip('? help', width) || '…';
    }
}
