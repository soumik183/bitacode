import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/settings.js';

test('settings round-trip through the user config directory', () => {
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-settings-'));
  process.env.HOME = tempHome;

  try {
    assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);

    const custom = { animations: false, mouseClicks: false, variant: 'high' };
    saveSettings(custom);
    assert.deepEqual(loadSettings(), custom);

    // A legacy expandThinking flag is ignored now that expansion follows the
    // provider, and must not leak into the loaded settings.
    saveSettings({ ...custom, expandThinking: true } as any);
    assert.equal('expandThinking' in loadSettings(), false);

    // Unknown variants fall back to the default rather than crashing.
    fs.writeFileSync(
      path.join(tempHome, '.config', 'bitacode', 'settings.json'),
      JSON.stringify({ ...custom, variant: 'nope' })
    );
    assert.equal(loadSettings().variant, DEFAULT_SETTINGS.variant);

    // A corrupt file must fall back to defaults rather than crash startup.
    fs.writeFileSync(
      path.join(tempHome, '.config', 'bitacode', 'settings.json'),
      '{not json'
    );
    assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
