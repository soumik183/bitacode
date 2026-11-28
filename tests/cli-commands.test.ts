import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatInstalled,
  formatInstallFailure,
  formatUpdateAvailable,
  formatUpdateNotice,
  formatUpdateUnavailable,
  formatUpToDate,
} from '../src/utils/cli-update-format.js';

test('formatUpToDate reports the current version', () => {
  assert.equal(formatUpToDate('0.1.22'), 'bitacode is up to date (v0.1.22)');
});

test('formatUpdateAvailable shows both versions and the follow-up command', () => {
  assert.equal(
    formatUpdateAvailable('0.1.22', '0.2.0'),
    'Update available: v0.1.22 → v0.2.0. Run: bitacode update'
  );
});

test('formatUpdateNotice shows the version delta and the in-app command', () => {
  assert.equal(
    formatUpdateNotice('0.1.25', '0.1.26'),
    'Update available: v0.1.25 → v0.1.26 · run /update'
  );
});

test('formatUpdateUnavailable explains a failed/offline check', () => {
  assert.match(formatUpdateUnavailable(), /offline/i);
});

test('formatInstalled reports the version delta, scope and reopen step', () => {
  assert.equal(
    formatInstalled('0.1.25', '0.1.26', 'global'),
    'Updated bitacode v0.1.25 → v0.1.26 (global). Reopen bitacode to use it.'
  );
  assert.equal(
    formatInstalled('0.1.26', '0.1.26', 'local'),
    'Installed bitacode v0.1.26 (local). Reopen bitacode to use it.'
  );
});

test('formatInstallFailure keeps one bounded line with the target and scope', () => {
  const message = formatInstallFailure(
    '0.1.26',
    'global',
    'npm install exited with code 1:\nboom failed\nmore output',
  );
  assert.match(message, /v0\.1\.26/);
  assert.match(message, /global/);
  assert.match(message, /boom failed/);
  assert.equal(message.includes('\n'), false);
  assert.ok(message.length <= 240, 'failure line stays bounded');
});
