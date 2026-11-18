import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type ApprovalMode, type UiSettings } from '../src/settings.js';
import { getCompactThreshold } from '../src/utils/compactor.js';

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
      const custom: UiSettings = {
        ...DEFAULT_SETTINGS,
        animations: false,
        mouseClicks: false,
        variant: 'high',
        approvalMode,
      };
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
    const custom: UiSettings = {
      ...DEFAULT_SETTINGS,
      animations: false,
      mouseClicks: false,
      variant: 'high',
      approvalMode: 'auto',
    };
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

test('new UI settings round-trip through save/load', () => {
  withTempHome(() => {
    const custom: UiSettings = {
      ...DEFAULT_SETTINGS,
      compactThreshold: 0.72,
      theme: 'light',
      statusLine: ['model', 'cost'],
    };
    saveSettings(custom);
    assert.deepEqual(loadSettings(), custom);

    const highContrast: UiSettings = { ...DEFAULT_SETTINGS, theme: 'high-contrast', statusLine: [] };
    saveSettings(highContrast);
    assert.deepEqual(loadSettings(), highContrast);
  });
});

test('invalid new settings fall back to defaults without losing other fields', () => {
  withTempHome((_home, settingsPath) => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ animations: false, compactThreshold: 1.5, theme: 'solarized', statusLine: 'model' })
    );
    const loaded = loadSettings();
    assert.equal(loaded.animations, false);
    assert.equal(loaded.compactThreshold, DEFAULT_SETTINGS.compactThreshold);
    assert.equal(loaded.theme, DEFAULT_SETTINGS.theme);
    assert.deepEqual(loaded.statusLine, DEFAULT_SETTINGS.statusLine);

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ compactThreshold: 'high', theme: 42, statusLine: ['folder', 'bogus', 7] })
    );
    const loaded2 = loadSettings();
    assert.equal(loaded2.compactThreshold, DEFAULT_SETTINGS.compactThreshold);
    assert.equal(loaded2.theme, DEFAULT_SETTINGS.theme);
    assert.deepEqual(loaded2.statusLine, ['folder']);
  });
});

test('getCompactThreshold clamps to the supported 0.5–0.95 range', () => {
  assert.equal(getCompactThreshold(), 0.9);
  assert.equal(getCompactThreshold(undefined), 0.9);
  assert.equal(getCompactThreshold(0.7), 0.7);
  assert.equal(getCompactThreshold(0.5), 0.5);
  assert.equal(getCompactThreshold(0.95), 0.95);
  assert.equal(getCompactThreshold(0.1), 0.5);
  assert.equal(getCompactThreshold(0.99), 0.95);
  assert.equal(getCompactThreshold(Number.NaN), 0.9);
  assert.equal(getCompactThreshold(Infinity), 0.9);
  assert.equal(getCompactThreshold('0.8' as any), 0.9);
});
