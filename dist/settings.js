/**
 * User UI settings — persisted outside the project so they carry across repos.
 *
 * Kept deliberately small: these are preferences, not agent configuration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from './utils/logger.js';
import { DEFAULT_VARIANT, VARIANTS } from './variants.js';
import { THEME_NAMES } from './theme/types.js';
function isApprovalMode(value) {
    return value === 'manual' || value === 'acceptEdits' || value === 'auto' || value === 'yolo';
}
/** Bounds and default for the fraction of context that triggers compaction. */
export const COMPACT_THRESHOLD_MIN = 0.5;
export const COMPACT_THRESHOLD_MAX = 0.95;
export const COMPACT_THRESHOLD_DEFAULT = 0.9;
/** Status-line segments, in their canonical display order. */
export const STATUS_LINE_ITEMS = ['folder', 'model', 'variant', 'cost', 'context', 'tool'];
function isCompactThreshold(value) {
    return (typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= COMPACT_THRESHOLD_MIN &&
        value <= COMPACT_THRESHOLD_MAX);
}
function isThemeName(value) {
    return typeof value === 'string' && THEME_NAMES.includes(value);
}
export const DEFAULT_SETTINGS = {
    animations: true,
    mouseClicks: true,
    variant: DEFAULT_VARIANT,
    approvalMode: 'manual',
    compactThreshold: COMPACT_THRESHOLD_DEFAULT,
    theme: 'black',
    statusLine: [...STATUS_LINE_ITEMS],
    permissions: { allow: [], ask: [], deny: [] },
    autoverify: false,
    outputStyle: 'default',
    guardUnreadEdits: true,
    spillToolResults: true,
    toolGroups: [],
    keybindings: {},
    themePath: '',
    goalMode: false,
    vcsSnapshots: false,
    sessionEventLog: false,
};
function getSettingsPath() {
    const home = os.homedir();
    const dir = process.platform === 'win32'
        ? path.join(home, 'AppData', 'Local', 'bitacode')
        : path.join(home, '.config', 'bitacode');
    return path.join(dir, 'settings.json');
}
function normalizeStringList(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
}
const VALID_TOOL_GROUPS = new Set(['core', 'files', 'web', 'process', 'agents', 'all']);
const VALID_KEY_ACTIONS = new Set([
    'newSession', 'sessions', 'model', 'provider', 'help', 'settings', 'subagents',
    'clearInput', 'clearTranscript', 'thinking', 'retry', 'copyLast', 'editLast', 'search',
]);
const KEY_PATTERN = /^(?:(?:ctrl|alt|shift)\+[a-z0-9]+|[a-z0-9]+|tab|esc|enter|space|up|down|left|right|pageup|pagedown|home|end)$/;
function normalizeToolGroups(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .filter((entry) => typeof entry === 'string' && VALID_TOOL_GROUPS.has(entry.toLowerCase()))
        .map((entry) => entry.toLowerCase());
}
function normalizeKeybindings(value) {
    const input = value && typeof value === 'object' ? value : {};
    const result = {};
    const used = new Set();
    for (const [action, key] of Object.entries(input)) {
        if (!VALID_KEY_ACTIONS.has(action) || typeof key !== 'string')
            continue;
        const normalized = key.toLowerCase().trim().slice(0, 24);
        if (!KEY_PATTERN.test(normalized) || used.has(normalized))
            continue;
        used.add(normalized);
        result[action] = normalized;
    }
    return result;
}
function normalizePermissions(value) {
    const input = (value && typeof value === 'object' ? value : {});
    return {
        allow: normalizeStringList(input.allow),
        ask: normalizeStringList(input.ask),
        deny: normalizeStringList(input.deny),
    };
}
export function loadSettings() {
    try {
        const parsed = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
        return {
            animations: parsed.animations !== false,
            mouseClicks: parsed.mouseClicks !== false,
            variant: VARIANTS.some((item) => item.id === parsed.variant)
                ? parsed.variant
                : DEFAULT_VARIANT,
            approvalMode: isApprovalMode(parsed.approvalMode) ? parsed.approvalMode : 'manual',
            compactThreshold: isCompactThreshold(parsed.compactThreshold)
                ? parsed.compactThreshold
                : COMPACT_THRESHOLD_DEFAULT,
            theme: isThemeName(parsed.theme) ? parsed.theme : DEFAULT_SETTINGS.theme,
            statusLine: Array.isArray(parsed.statusLine)
                ? parsed.statusLine.filter((item) => STATUS_LINE_ITEMS.includes(item))
                : [...STATUS_LINE_ITEMS],
            permissions: normalizePermissions(parsed.permissions),
            autoverify: parsed.autoverify === true,
            outputStyle: typeof parsed.outputStyle === 'string' && parsed.outputStyle.trim().length > 0
                ? parsed.outputStyle.trim()
                : 'default',
            guardUnreadEdits: parsed.guardUnreadEdits !== false,
            spillToolResults: parsed.spillToolResults !== false,
            toolGroups: normalizeToolGroups(parsed.toolGroups),
            keybindings: normalizeKeybindings(parsed.keybindings),
            themePath: typeof parsed.themePath === 'string' && parsed.themePath.length <= 512 ? parsed.themePath : '',
            goalMode: parsed.goalMode === true,
            vcsSnapshots: parsed.vcsSnapshots === true,
            sessionEventLog: parsed.sessionEventLog === true,
        };
    }
    catch {
        return { ...DEFAULT_SETTINGS, statusLine: [...STATUS_LINE_ITEMS] };
    }
}
export function saveSettings(settings) {
    try {
        const filePath = getSettingsPath();
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
    }
    catch (err) {
        logger.warn('Failed to save UI settings', { error: err.message });
    }
}
