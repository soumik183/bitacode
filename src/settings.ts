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

function isThemeName(value: unknown): value is 'dark' | 'light' | 'high-contrast' {
  return value === 'dark' || value === 'light' || value === 'high-contrast';
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
  theme?: 'dark' | 'light' | 'high-contrast';
  /** Segments shown in the status line, in display order. */
  statusLine?: StatusLineItem[];
}

export const DEFAULT_SETTINGS: UiSettings = {
  animations: true,
  mouseClicks: true,
  variant: DEFAULT_VARIANT,
  approvalMode: 'manual',
  compactThreshold: COMPACT_THRESHOLD_DEFAULT,
  theme: 'dark',
  statusLine: [...STATUS_LINE_ITEMS],
};

function getSettingsPath(): string {
  const home = os.homedir();
  const dir =
    process.platform === 'win32'
      ? path.join(home, 'AppData', 'Local', 'bitacode')
      : path.join(home, '.config', 'bitacode');
  return path.join(dir, 'settings.json');
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
      theme: isThemeName(parsed.theme) ? parsed.theme : 'dark',
      statusLine: Array.isArray(parsed.statusLine)
        ? parsed.statusLine.filter((item) => STATUS_LINE_ITEMS.includes(item))
        : [...STATUS_LINE_ITEMS],
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
