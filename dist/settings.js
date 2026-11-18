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
function isApprovalMode(value) {
    return value === 'manual' || value === 'auto' || value === 'yolo';
}
export const DEFAULT_SETTINGS = {
    animations: true,
    mouseClicks: true,
    variant: DEFAULT_VARIANT,
    approvalMode: 'manual',
};
function getSettingsPath() {
    const home = os.homedir();
    const dir = process.platform === 'win32'
        ? path.join(home, 'AppData', 'Local', 'bitacode')
        : path.join(home, '.config', 'bitacode');
    return path.join(dir, 'settings.json');
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
        };
    }
    catch {
        return { ...DEFAULT_SETTINGS };
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
