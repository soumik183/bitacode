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
import { THEME_NAMES, type ThemeName } from './theme/types.js';

/** How write/edit/shell operations are approved. */
export type ApprovalMode = 'manual' | 'auto' | 'yolo';

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === 'manual' || value === 'auto' || value === 'yolo';
}

/** Bounds and default for the fraction of context that triggers compaction. */
export const COMPACT_THRESHOLD_MIN = 0.5;
export const COMPACT_THRESHOLD_MAX = 0.95;
export const COMPACT_THRESHOLD_DEFAULT = 0.9;

/** Status-line segments, in their canonical display order. */
export const STATUS_LINE_ITEMS = ['folder', 'model', 'variant', 'cost', 'context', 'tool'] as const;
export type StatusLineItem = (typeof STATUS_LINE_ITEMS)[number];

function isCompactThreshold(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= COMPACT_THRESHOLD_MIN &&
    value <= COMPACT_THRESHOLD_MAX
  );
}

function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && (THEME_NAMES as readonly string[]).includes(value);
}

export interface UiSettings {
  /** Animate spinners, shimmers and thinking dots. */
  animations: boolean;
  /** Enable terminal mouse reporting; a left click toggles the thinking block. */
  mouseClicks: boolean;
  /**
   * @deprecated Thinking expansion is now driven by the provider, so this flag
   * is read for backwards compatibility and otherwise ignored.
   */
  expandThinking?: boolean;
  /** Last selected reasoning variant, so the footer survives restarts. */
  variant: string;
  /** Approval policy for write/edit/shell operations. */
  approvalMode: ApprovalMode;
  /** Fraction of the context window (0.5–0.95) that triggers compaction. */
  compactThreshold?: number;
  /** Colour palette used by the UI. */
  theme?: ThemeName;
  /** Segments shown in the status line, in display order. */
  statusLine?: StatusLineItem[];
  /**
   * Declarative permission rules. Project rules live in
   * `<repo>/.bitacode/permissions.json` and only load for trusted projects.
   */
  permissions?: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
  };
  /** Run the project's own checks (typecheck/lint/test) after a turn. */
  autoverify?: boolean;
  /**
   * Refuse to edit a file the model has not read in this session. Read dedupe and
   * this guard share one switch because they share the same bookkeeping.
   */
  guardUnreadEdits?: boolean;
  /** Inline large tool output instead of spilling it to disk. */
  spillToolResults?: boolean;
}

export const DEFAULT_SETTINGS: UiSettings = {
  animations: true,
  mouseClicks: true,
  variant: DEFAULT_VARIANT,
  approvalMode: 'manual',
  compactThreshold: COMPACT_THRESHOLD_DEFAULT,
  theme: 'black',
  statusLine: [...STATUS_LINE_ITEMS],
  permissions: { allow: [], ask: [], deny: [] },
  autoverify: false,
  guardUnreadEdits: true,
  spillToolResults: true,
};

function getSettingsPath(): string {
  const home = os.homedir();
  const dir =
    process.platform === 'win32'
      ? path.join(home, 'AppData', 'Local', 'bitacode')
      : path.join(home, '.config', 'bitacode');
  return path.join(dir, 'settings.json');
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function normalizePermissions(value: unknown): UiSettings['permissions'] {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    allow: normalizeStringList(input.allow),
    ask: normalizeStringList(input.ask),
    deny: normalizeStringList(input.deny),
  };
}

export function loadSettings(): UiSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8')) as Partial<UiSettings>;
    return {
      animations: parsed.animations !== false,
      mouseClicks: parsed.mouseClicks !== false,
      variant: VARIANTS.some((item) => item.id === parsed.variant)
        ? (parsed.variant as string)
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
      guardUnreadEdits: parsed.guardUnreadEdits !== false,
      spillToolResults: parsed.spillToolResults !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS, statusLine: [...STATUS_LINE_ITEMS] };
  }
}

export function saveSettings(settings: UiSettings): void {
  try {
    const filePath = getSettingsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (err: any) {
    logger.warn('Failed to save UI settings', { error: err.message });
  }
}
