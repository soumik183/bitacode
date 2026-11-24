/**
 * Keybinding configuration for global TUI actions.
 *
 * Config values are untrusted: every entry is normalised and validated before
 * it can override a default, and a conflicting or malformed entry is ignored
 * rather than thrown. The result is always a complete action → key map.
 */

import { logger } from './logger.js';

export type KeyAction =
  | 'newSession'
  | 'sessions'
  | 'model'
  | 'provider'
  | 'help'
  | 'settings'
  | 'subagents'
  | 'clearInput'
  | 'clearTranscript'
  | 'thinking'
  | 'retry'
  | 'copyLast'
  | 'editLast'
  | 'search';

const ACTIONS: readonly KeyAction[] = [
  'newSession',
  'sessions',
  'model',
  'provider',
  'help',
  'settings',
  'subagents',
  'clearInput',
  'clearTranscript',
  'thinking',
  'retry',
  'copyLast',
  'editLast',
  'search',
];
const ACTION_SET = new Set<string>(ACTIONS);

/** Built-in bindings, mirroring the shortcuts already used by the TUI. */
export const DEFAULT_KEYBINDS: Readonly<Record<KeyAction, string>> = Object.freeze({
  newSession: 'ctrl+n',
  sessions: 'ctrl+s',
  model: 'ctrl+m',
  provider: 'ctrl+p',
  help: 'ctrl+h',
  settings: 'ctrl+o',
  subagents: 'ctrl+g',
  clearInput: 'ctrl+k',
  clearTranscript: 'ctrl+l',
  thinking: 'ctrl+t',
  retry: 'ctrl+r',
  copyLast: 'ctrl+y',
  editLast: 'ctrl+e',
  search: 'ctrl+f',
});

const KEY_PATTERN = /^(ctrl|alt|shift)\+[a-z0-9]+$|^[a-z0-9]+$|^(tab|esc|enter|space|up|down|left|right|pageup|pagedown|home|end)$/;
const MAX_KEY_LENGTH = 24;

const KEY_LABELS: Readonly<Record<string, string>> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  tab: 'Tab',
  esc: 'Esc',
  enter: 'Enter',
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Lowercase, trim and validate a key token; `null` means "not a key". */
function normalizeKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_KEY_LENGTH) return null;
  const normalized = trimmed.toLowerCase().replace(/\s*\+\s*/g, '+');
  if (!normalized || normalized.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(normalized)) return null;
  return normalized;
}

/**
 * Merge untrusted keybinding config over the defaults.
 *
 * Unknown actions, non-string or malformed keys and keys longer than 24
 * characters are ignored. Two actions claiming the same key are resolved
 * first-wins (based on property order) and logged at debug level.
 */
export function parseKeybinds(value: unknown): Record<KeyAction, string> {
  const result: Record<KeyAction, string> = { ...DEFAULT_KEYBINDS };
  if (!isPlainObject(value)) return result;

  const claimed = new Map<string, KeyAction>();
  for (const [rawAction, rawKey] of Object.entries(value)) {
    if (!ACTION_SET.has(rawAction)) {
      logger.debug('Ignoring unknown keybind action', { action: rawAction });
      continue;
    }
    const action = rawAction as KeyAction;
    const key = normalizeKey(rawKey);
    if (key === null) {
      logger.debug('Ignoring invalid keybind value', { action, value: rawKey });
      continue;
    }
    const owner = claimed.get(key);
    if (owner !== undefined) {
      logger.debug('Duplicate keybind assignment ignored', { action, key, kept: owner });
      continue;
    }
    claimed.set(key, action);
    result[action] = key;
  }
  return result;
}

/**
 * Resolve one action to its key, falling back to the built-in binding when the
 * supplied map is missing, malformed or out of date. Never throws.
 */
export function resolveKeybind(custom: Record<KeyAction, string>, action: KeyAction): string {
  const fallback = typeof action === 'string' && Object.hasOwn(DEFAULT_KEYBINDS, action)
    ? DEFAULT_KEYBINDS[action]
    : DEFAULT_KEYBINDS.newSession;
  if (!isPlainObject(custom)) return fallback;
  return normalizeKey((custom as Record<string, unknown>)[action]) ?? fallback;
}

/** Render a key token for help text: `ctrl+r` → `Ctrl+R`, `shift+up` → `Shift+Up`. */
export function formatKeybind(key: string): string {
  if (typeof key !== 'string') return '';
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > MAX_KEY_LENGTH) return '';
  const parts = trimmed.toLowerCase().replace(/\s*\+\s*/g, '+').split('+');
  return parts
    .map((part) => {
      if (!part) return '';
      const label = KEY_LABELS[part];
      if (label) return label;
      return part.length === 1
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('+');
}
