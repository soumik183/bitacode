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
}

export const DEFAULT_SETTINGS: UiSettings = {
  animations: true,
  mouseClicks: true,
  variant: DEFAULT_VARIANT,
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
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
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
