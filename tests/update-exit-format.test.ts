import test from 'node:test';
import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import { formatUpdateExit } from '../src/utils/update-exit-format.js';
import { themes } from '../src/theme.js';

test('update exit card shows the delta, scope and a reopen instruction', () => {
  const card = stripAnsi(formatUpdateExit(
    { from: '0.1.25', to: '0.1.26', scope: 'global' },
    themes.black,
  ));
  assert.match(card, /U P D A T E\s+I N S T A L L E D/);
  assert.match(card, /0\.1\.25/);
  assert.match(card, /0\.1\.26/);
  assert.match(card, /global/);
  assert.match(card, /Reopen bitacode to use v0\.1\.26/);
  assert.match(card, /still has v0\.1\.25/);
});

test('update exit card handles an unknown previous version', () => {
  const card = stripAnsi(formatUpdateExit(
    { from: '', to: '1.0.0', scope: 'local' },
    themes.dark,
  ));
  assert.match(card, /v1\.0\.0/);
  assert.match(card, /\(local\)/);
  assert.doesNotMatch(card, /→/, 'no empty from-version arrow');
  assert.match(card, /old build/);
});

test('update exit card is empty without a target version', () => {
  assert.equal(formatUpdateExit({ from: '1.0.0', to: '', scope: 'global' }, themes.black), '');
});
