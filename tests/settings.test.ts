import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type ApprovalMode, type UiSettings } from '../src/settings.js';

function withTempHome<T>(run: (home: string, settingsPath: string) => T): T {
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-settings-'));
  process.env.HOME = tempHome;

  try {
    const settingsPath = path.join(tempHome, '.config', 'bitacode', 'settings.json');
    return run(tempHome, settingsPath);
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

test('new installs default to manual approval mode', () => {
  withTempHome(() => {
    assert.equal(DEFAULT_SETTINGS.approvalMode, 'manual');
    assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
    assert.equal(loadSettings().approvalMode, 'manual');
  });
});

test('valid approval modes round-trip through save/load', () => {
  withTempHome((_home, settingsPath) => {
    for (const approvalMode of ['manual', 'auto', 'yolo'] as ApprovalMode[]) {
      const custom: UiSettings = { animations: false, mouseClicks: false, variant: 'high', approvalMode };
      saveSettings(custom);
      assert.deepEqual(loadSettings(), custom);
      assert.equal(loadSettings().approvalMode, approvalMode);
      assert.ok(fs.existsSync(settingsPath));
    }
  });
});

test('invalid or corrupt approval mode falls back to manual without losing other fields', () => {
  withTempHome((_home, settingsPath) => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ animations: false, mouseClicks: false, variant: 'high', approvalMode: 'godmode' })
    );
    const loaded = loadSettings();
    assert.equal(loaded.approvalMode, 'manual');
    assert.equal(loaded.animations, false);
    assert.equal(loaded.mouseClicks, false);
    assert.equal(loaded.variant, 'high');

    fs.writeFileSync(settingsPath, JSON.stringify({ animations: false, approvalMode: 42 }));
    assert.equal(loadSettings().approvalMode, 'manual');
  });
});

test('legacy fields still load and unknown variants fall back to defaults', () => {
  withTempHome((_home, settingsPath) => {
    const custom: UiSettings = { animations: false, mouseClicks: false, variant: 'high', approvalMode: 'auto' };
    assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);

    saveSettings(custom);
    assert.deepEqual(loadSettings(), custom);

    // A legacy expandThinking flag is ignored now that expansion follows the
    // provider, and must not leak into the loaded settings.
    saveSettings({ ...custom, expandThinking: true } as any);
    assert.equal('expandThinking' in loadSettings(), false);

    // Unknown variants fall back to the default rather than crashing.
    fs.writeFileSync(settingsPath, JSON.stringify({ ...custom, variant: 'nope' }));
    assert.equal(loadSettings().variant, DEFAULT_SETTINGS.variant);

    // A corrupt file must fall back to defaults rather than crash startup.
    fs.writeFileSync(settingsPath, '{not json');
    assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
  });
});
