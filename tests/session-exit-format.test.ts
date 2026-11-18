import test from 'node:test';
import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import { formatSessionExit, RESUME_PACKAGE } from '../src/utils/session-exit-format.js';
import { themes } from '../src/theme.js';

test('exit card shows a ready-to-copy resume command with the session id', () => {
  const id = '01a1eea3-a81c-7789-ad39-d30ace0b2e24';
  const plain = stripAnsi(formatSessionExit(id, themes.sand));
  assert.match(plain, new RegExp(`${RESUME_PACKAGE} --session ${id}`));
  assert.match(plain, /Resume this conversation/);
  assert.match(plain, /S E S S I O N {3}S A V E D/, 'display type is distinct from the chat wordmark');
});

test('exit card uses the active palette and disables cleanly', () => {
  const id = 'abc12345';
  const sand = formatSessionExit(id, themes.sand);
  const dark = formatSessionExit(id, themes.dark);
  assert.ok(sand.includes('\x1b[38;2;58;46;37m'), 'sand ink foreground');
  assert.ok(dark.includes('\x1b[38;2;245;245;245m'), 'dark foreground');
  assert.ok(sand.includes('\x1b[1m'), 'premium bold accents');
  assert.ok(stripAnsi(sand).endsWith('\n'), 'leaves a trailing newline after the alternate screen');
  assert.equal(formatSessionExit('  ', themes.sand), '', 'no id means no stale resume hint');
});
