import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverThemeFiles, validateTheme, type ThemeFile } from '../src/theme/discovery.js';
import {
  DEFAULT_KEYBINDS,
  formatKeybind,
  parseKeybinds,
  resolveKeybind,
  type KeyAction,
} from '../src/utils/keybinds.js';

const VALID_THEME = JSON.stringify({ name: 'Ocean', background: '#0b0f19', foreground: '#e6edf3' });

function withTempHome<T>(run: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-theme-discovery-'));
  try {
    return run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function configThemeDir(home: string): string {
  const dir = path.join(home, '.config', 'bitacode', 'themes');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function unwrap<T>(result: { ok: boolean; value?: T; error?: string }): T {
  assert.equal(result.ok, true, result.error);
  return result.value as T;
}

function byName(files: ThemeFile[]): Map<string, ThemeFile> {
  return new Map(files.map((file) => [file.name, file]));
}

test('discovers a valid .json theme from the XDG root', () => {
  withTempHome((home) => {
    const dir = configThemeDir(home);
    fs.writeFileSync(path.join(dir, 'ocean.json'), VALID_THEME);

    const files = unwrap<ThemeFile[]>(discoverThemeFiles({ home }));
    assert.equal(files.length, 1);
    assert.equal(files[0]!.name, 'ocean');
    assert.equal(files[0]!.path, path.join(dir, 'ocean.json'));
    assert.equal(files[0]!.raw.background, '#0b0f19');
  });
});

test('discovers .jsonc themes with comments and trailing commas', () => {
  withTempHome((home) => {
    const dir = path.join(home, '.bitacode', 'themes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'solar.jsonc'),
      '{\n  // user palette\n  "background": "#100", /* dark */\n  "accent": "#f0a",\n}\n'
    );

    const files = unwrap<ThemeFile[]>(discoverThemeFiles({ home }));
    assert.equal(files.length, 1);
    assert.equal(files[0]!.name, 'solar');
    assert.equal(files[0]!.raw.background, '#100');
    assert.equal(files[0]!.raw.accent, '#f0a');
  });
});

test('scans extraDirs and deduplicates repeated roots', () => {
  withTempHome((home) => {
    const dir = configThemeDir(home);
    fs.writeFileSync(path.join(dir, 'one.json'), VALID_THEME);
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-theme-extra-'));
    try {
      fs.writeFileSync(path.join(extra, 'two.jsonc'), '{ "fg": "#fff" }\n');
      const files = unwrap<ThemeFile[]>(discoverThemeFiles({ home, extraDirs: [extra, dir, extra] }));
      assert.deepEqual(
        files.map((file) => file.name).sort(),
        ['one', 'two']
      );
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });
});

test('ignores dotfiles and files without a JSON extension', () => {
  withTempHome((home) => {
    const dir = configThemeDir(home);
    fs.writeFileSync(path.join(dir, 'good.json'), VALID_THEME);
    fs.writeFileSync(path.join(dir, '.hidden.json'), VALID_THEME);
    fs.writeFileSync(path.join(dir, 'notes.txt'), VALID_THEME);
    fs.writeFileSync(path.join(dir, 'README'), VALID_THEME);

    const files = unwrap<ThemeFile[]>(discoverThemeFiles({ home }));
    assert.deepEqual(files.map((file) => file.name), ['good']);
  });
});

test('skips symlinks escaping the root but allows internal symlinks', () => {
  withTempHome((home) => {
    const dir = configThemeDir(home);
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nested', 'real.json'), VALID_THEME);
    fs.writeFileSync(path.join(dir, 'plain.json'), VALID_THEME);
    fs.symlinkSync(path.join(dir, 'nested', 'real.json'), path.join(dir, 'inside.json'));

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-theme-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'evil.json'), VALID_THEME);
      fs.symlinkSync(path.join(outside, 'evil.json'), path.join(dir, 'outside.json'));

      const found = byName(unwrap<ThemeFile[]>(discoverThemeFiles({ home })));
      assert.ok(found.has('inside'), 'internal symlink should be followed');
      assert.equal(found.get('inside')?.raw.background, '#0b0f19');
      assert.ok(found.has('plain'));
      assert.equal(found.has('real'), false, 'nested files are not scanned directly');
      assert.equal(found.has('outside'), false, 'external symlink must be skipped');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('skips malformed, non-object and oversized theme files', () => {
  withTempHome((home) => {
    const dir = configThemeDir(home);
    fs.writeFileSync(path.join(dir, 'good.json'), VALID_THEME);
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope');
    fs.writeFileSync(path.join(dir, 'array.json'), '["background", "#fff"]');
    fs.writeFileSync(path.join(dir, 'huge.json'), `{"background":"${'x'.repeat(256 * 1024)}"}`);

    const files = unwrap<ThemeFile[]>(discoverThemeFiles({ home }));
    assert.deepEqual(files.map((file) => file.name), ['good']);
  });
});

test('caps discovery at 100 files', () => {
  withTempHome((home) => {
    const dir = configThemeDir(home);
    for (let i = 0; i < 105; i += 1) {
      fs.writeFileSync(path.join(dir, `t${String(i).padStart(3, '0')}.json`), VALID_THEME);
    }
    const files = unwrap<ThemeFile[]>(discoverThemeFiles({ home }));
    assert.equal(files.length, 100);
  });
});

test('validateTheme accepts any recognised colour key with a string value', () => {
  for (const raw of [
    { background: '#000' },
    { foreground: 'white' },
    { primary: 'ansi:4' },
    { accent: '#abc', text: 42 },
    { bg: '#111' },
    { fg: '#222' },
    { surface: '#333', border: '#444', info: 7, name: 'x' },
  ]) {
    assert.deepEqual(validateTheme(raw), { ok: true }, JSON.stringify(raw));
  }
});

test('validateTheme rejects non-objects and records without a string colour key', () => {
  for (const raw of [
    null,
    undefined,
    'theme',
    42,
    [],
    {},
    { name: 'Ocean' },
    { background: 123, foreground: null },
    { text: { hex: '#fff' } },
  ]) {
    const result = validateTheme(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(typeof result.error, 'string');
  }
});

test('DEFAULT_KEYBINDS covers every action with a valid key', () => {
  const actions: KeyAction[] = [
    'newSession', 'sessions', 'model', 'provider', 'help', 'settings', 'subagents',
    'clearInput', 'clearTranscript', 'thinking', 'retry', 'copyLast', 'editLast', 'search',
  ];
  assert.deepEqual(Object.keys(DEFAULT_KEYBINDS).sort(), actions.sort());
  for (const action of actions) {
    assert.match(DEFAULT_KEYBINDS[action], /^(ctrl|alt|shift)\+[a-z0-9]+$|^[a-z0-9]+$|^(tab|esc|enter|space|up|down|left|right|pageup|pagedown|home|end)$/);
  }
  assert.throws(() => {
    (DEFAULT_KEYBINDS as Record<string, string>).model = 'ctrl+z';
  }, TypeError);
});

test('parseKeybinds returns the defaults for garbage input', () => {
  for (const garbage of [undefined, null, 42, 'ctrl+n', [], ['newSession'], new Date()]) {
    assert.deepEqual(parseKeybinds(garbage), DEFAULT_KEYBINDS);
  }
  assert.deepEqual(parseKeybinds({}), DEFAULT_KEYBINDS);
  assert.notEqual(parseKeybinds({}), DEFAULT_KEYBINDS, 'result must be a fresh object');
});

test('parseKeybinds normalizes valid keys and ignores invalid values', () => {
  const parsed = parseKeybinds({
    newSession: '  Ctrl+N ',
    model: 'ALT + M',
    thinking: ' tab ',
    sessions: 'ctrl+shift+up',
    provider: 42,
    help: 'this-key-is-far-too-long-to-be-valid',
    copyLast: '',
    madeUpAction: 'n',
  });
  assert.equal(parsed.newSession, 'ctrl+n');
  assert.equal(parsed.model, 'alt+m');
  assert.equal(parsed.thinking, 'tab');
  assert.equal(parsed.sessions, DEFAULT_KEYBINDS.sessions);
  assert.equal(parsed.provider, DEFAULT_KEYBINDS.provider);
  assert.equal(parsed.help, DEFAULT_KEYBINDS.help);
  assert.equal(parsed.copyLast, DEFAULT_KEYBINDS.copyLast);
  assert.equal(Object.keys(parsed).length, Object.keys(DEFAULT_KEYBINDS).length);
});

test('parseKeybinds resolves duplicate key assignments first-wins', () => {
  const parsed = parseKeybinds({
    newSession: 'ctrl+n',
    sessions: 'CTRL+N',
    retry: 'ctrl+r',
    model: 'ctrl+r',
  });
  assert.equal(parsed.newSession, 'ctrl+n');
  assert.equal(parsed.sessions, DEFAULT_KEYBINDS.sessions);
  assert.equal(parsed.retry, 'ctrl+r');
  assert.equal(parsed.model, DEFAULT_KEYBINDS.model);
});

test('resolveKeybind falls back for unknown actions and bad maps', () => {
  assert.equal(resolveKeybind(DEFAULT_KEYBINDS, 'model'), DEFAULT_KEYBINDS.model);
  assert.equal(resolveKeybind({ ...DEFAULT_KEYBINDS, model: 'alt+m' }, 'model'), 'alt+m');
  assert.equal(resolveKeybind({ ...DEFAULT_KEYBINDS, model: 'BAD KEY' }, 'model'), DEFAULT_KEYBINDS.model);
  assert.equal(resolveKeybind({} as Record<KeyAction, string>, 'model'), DEFAULT_KEYBINDS.model);
  assert.equal(resolveKeybind({} as Record<KeyAction, string>, 'nope' as KeyAction), DEFAULT_KEYBINDS.newSession);
});

test('formatKeybind renders human-readable modifier and named keys', () => {
  assert.equal(formatKeybind('ctrl+r'), 'Ctrl+R');
  assert.equal(formatKeybind('alt+x'), 'Alt+X');
  assert.equal(formatKeybind('shift+up'), 'Shift+Up');
  assert.equal(formatKeybind('tab'), 'Tab');
  assert.equal(formatKeybind('esc'), 'Esc');
  assert.equal(formatKeybind('pagedown'), 'PageDown');
  assert.equal(formatKeybind('  Ctrl + N '), 'Ctrl+N');
  assert.equal(formatKeybind(''), '');
  assert.equal(formatKeybind(42 as unknown as string), '');
});
