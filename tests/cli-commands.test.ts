/**
 * cli.tsx calls program.parse() on import, so it cannot be imported in tests.
 * These cover the pure formatting helpers that produce its user-facing output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatInstalled,
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

test('formatUpdateNotice is a short hint for the in-app notice', () => {
  assert.equal(formatUpdateNotice('0.2.0'), 'Update available: v0.2.0. Run: bitacode update');
});

test('formatUpdateUnavailable explains a failed/offline check', () => {
  assert.match(formatUpdateUnavailable(), /offline/i);
});

test('formatInstalled reports the new version to run', () => {
  assert.equal(formatInstalled('0.2.0'), 'Installed bitacode v0.2.0. Run: bitacode');
});
