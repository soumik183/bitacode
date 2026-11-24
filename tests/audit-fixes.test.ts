/** Focused regression tests for the read-only audit fixes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import {
  themes,
  getTheme,
  registerCustomTheme,
  ThemeProvider,
  useTheme,
  type Theme,
} from '../src/theme.js';
import { customThemeVersion } from '../src/theme/palettes.js';
import { auditTheme } from '../src/theme/contrast.js';
import { discoverThemeFiles } from '../src/theme/discovery.js';
import {
  installStableRenderer,
  installTerminalRestore,
  terminalRestoreSequence,
} from '../src/utils/stable-render.js';
import { estimateDecodeTokens, createDecodeSpeedTracker } from '../src/utils/decode-speed.js';
import { getWheelDelta, isClickOnThinkingBlock } from '../src/utils/mouse.js';
import { formatDuration } from '../src/utils/duration.js';
import { detectTerminalProfile } from '../src/utils/terminal.js';

test('inherited Object keys are never mistaken for custom palettes', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(getTheme(name), themes.black, `${name} must fall back to black`);
  }
});

test('the built-in audits pass on bg, surface and surfaceAlt', () => {
  for (const [name, palette] of Object.entries(themes)) {
    const audit = auditTheme(palette);
    assert.ok(audit.ok, `${name}: ${JSON.stringify(audit.issues)}`);
  }
  // This colour is fine on bg/surface but too light on surfaceAlt.
  const failing = { ...themes.light, success: '#15803d' };
  const audit = auditTheme(failing);
  assert.equal(audit.ok, false);
  assert.ok(audit.issues.some((issue) => issue.pair === 'success on surfaceAlt'));
});

test('theme files with a UTF-8 BOM are discovered', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-theme-bom-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.config', 'bitacode', 'themes');
  fs.mkdirSync(dir, { recursive: true });
  const palette = { ...themes.black };
  fs.writeFileSync(path.join(dir, 'a.json'), `\ufeff${JSON.stringify(palette)}`);
  fs.writeFileSync(path.join(dir, 'b.jsonc'), `\ufeff${JSON.stringify(palette)}\n// note\n`);
  const result = discoverThemeFiles({ home });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.map((file) => file.name), ['a', 'b']);
  assert.equal(result.value[0].raw.text, themes.black.text);
  assert.equal(result.value[1].raw.text, themes.black.text);
});

test('custom-theme registration bumps a version and repaints an existing provider', () => {
  const before = customThemeVersion;
  const palette: Theme = { ...themes.black, accent: '#123456' };

  let seen: Theme | null = null;
  const Probe = () => {
    seen = useTheme();
    return React.createElement(Text, null, 'x');
  };
  const tree = () => React.createElement(
    ThemeProvider,
    { name: 'custom' },
    React.createElement(Probe)
  );
  const view = render(tree());
  assert.equal(seen, themes.custom, 'custom starts on the placeholder palette');

  assert.equal(registerCustomTheme('custom', palette), true);
  assert.equal(customThemeVersion, before + 1);
  view.rerender(tree());
  assert.equal(seen, palette, 'the provider resolves the newly registered palette');
  view.unmount();
});

function fakeStdout() {
  const stdout = new EventEmitter() as any;
  stdout.writes = [] as string[];
  stdout.write = (chunk: any) => { stdout.writes.push(String(chunk)); return true; };
  installStableRenderer(stdout);
  return stdout;
}
const repaint = (lines: string) => `\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G${lines}\n`;
const erases = (text: string) => text.split('\x1b[K').length - 1;

test('an ESC[2J echoed inside output does not reset repaint padding', () => {
  const stdout = fakeStdout();
  stdout.rows = 20;
  stdout.write(repaint(Array.from({ length: 15 }, (_, i) => `L${i}`).join('\n')));
  stdout.writes.length = 0;

  stdout.write('tool output: \x1b[2J is just text\n');
  stdout.write(repaint('A\nB'));
  assert.equal(erases(stdout.writes[1]), 15, 'padding survives an echoed clear');

  stdout.write('\x1b[H\x1b[2J');
  stdout.write(repaint('A\nB'));
  assert.equal(erases(stdout.writes[3]), 2, 'a real home-then-clear resets padding');
});

test('painted-row bookkeeping is isolated per stream', () => {
  const tall = fakeStdout();
  const short = fakeStdout();
  tall.rows = 30;
  short.rows = 10;
  tall.write(repaint(Array.from({ length: 25 }, (_, i) => `A${i}`).join('\n')));
  short.write(repaint('B1\nB2'));
  tall.writes.length = 0;
  short.writes.length = 0;
  tall.write(repaint('x'));
  short.write(repaint('x'));
  assert.equal(erases(tall.writes[0]), 25);
  assert.equal(erases(short.writes[0]), 2);
});

test('terminal restore handlers are keyed by stream and emitter', () => {
  const emitterA = new EventEmitter();
  const emitterB = new EventEmitter();
  const writesA: string[] = [];
  const writesB: string[] = [];
  const stdoutA = { write: (chunk: string) => { writesA.push(chunk); return true; } } as any;
  const stdoutB = { write: (chunk: string) => { writesB.push(chunk); return true; } } as any;

  const disposeA = installTerminalRestore(stdoutA, emitterA as any);
  const disposeB = installTerminalRestore(stdoutB, emitterB as any);
  assert.notEqual(disposeA, disposeB, 'a second install does not no-op');
  assert.equal(installTerminalRestore(stdoutA, emitterA as any), disposeA, 'same pair is idempotent');
  emitterA.emit('SIGTERM');
  emitterB.emit('SIGTERM');
  assert.deepEqual(writesA, [terminalRestoreSequence()]);
  assert.deepEqual(writesB, [terminalRestoreSequence()]);
  disposeA();
  disposeB();
});

test('decode tokens count graphemes, not every non-ASCII code point', () => {
  assert.equal(estimateDecodeTokens('abcd'), 1);
  assert.equal(estimateDecodeTokens('你好'), 2);
  assert.equal(estimateDecodeTokens('👍🏽'), 1, 'skin tone is one grapheme');
  assert.equal(estimateDecodeTokens('👩‍💻'), 1, 'ZWJ sequence is one grapheme');
  assert.equal(estimateDecodeTokens('e\u0301'), 0.25, 'combining mark is ignored');

  const tracker = createDecodeSpeedTracker(0);
  tracker.add('\ud83d', 1); // high surrogate alone
  assert.equal(tracker.add('\ude80', 2).tokens, 1, 'a split surrogate pair counts once');
});

test('horizontal wheel buttons do not scroll vertically', () => {
  assert.equal(getWheelDelta('[<64;1;1M'), -1);
  assert.equal(getWheelDelta('[<65;1;1M'), 1);
  assert.equal(getWheelDelta('[<66;1;1M'), 0);
  assert.equal(getWheelDelta('[<67;1;1M'), 0);
  assert.equal(getWheelDelta('[<66;1;1M[<67;1;1M[<64;1;1M'), -1);
});

test('thinking-click geometry follows the dense chrome budget', () => {
  assert.equal(isClickOnThinkingBlock(24, 30, 2), true);
  assert.equal(isClickOnThinkingBlock(25, 30, 2), true);
  assert.equal(isClickOnThinkingBlock(23, 30, 2), false);
  assert.equal(isClickOnThinkingBlock(26, 30, 2), false);
  assert.equal(isClickOnThinkingBlock(6, 9, 2), true, 'dense chrome is 2 rows');
  assert.equal(isClickOnThinkingBlock(8, 9, 2), false);
});

test('duration rounds once and guards non-finite input', () => {
  assert.equal(formatDuration(Number.NaN), '<1s');
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), '<1s');
  assert.equal(formatDuration(-10), '<1s');
  assert.equal(formatDuration(999), '<1s');
  assert.equal(formatDuration(1000), '1s');
  assert.equal(formatDuration(59_999), '1m 0s');
  assert.equal(formatDuration(61_000), '1m 1s');
});

test('CI only degrades an interactive TTY when it is not a TTY', () => {
  const env = { TERM: 'xterm-256color', CI: '1' };
  assert.equal(detectTerminalProfile({ env, isTTY: true }).dumb, false);
  assert.equal(detectTerminalProfile({ env, isTTY: false }).dumb, true);
  assert.equal(detectTerminalProfile({ env: { TERM: 'dumb' }, isTTY: true }).dumb, true);
  assert.equal(detectTerminalProfile({ env: { TERM: 'xterm-256color' } }).animations, true);
});
