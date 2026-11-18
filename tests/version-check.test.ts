import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkForUpdate,
  clearUpdateCache,
  compareVersions,
  installUpdate,
} from '../src/utils/version-check.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-version-check-'));
}

function cacheFile(home: string): string {
  return path.join(home, '.config', 'bitacode', 'update-check.json');
}

function cleanup(home: string): void {
  fs.rmSync(home, { recursive: true, force: true });
}

function withFetch(impl: (...args: any[]) => any, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

/** Fake `npm` on PATH that succeeds, or fails when FAKE_NPM_FAIL=1. */
async function withFakeNpm(fn: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-fake-npm-'));
  const script = [
    '#!/bin/sh',
    'if [ "$FAKE_NPM_FAIL" = "1" ]; then',
    `  printf '\u001b[31mboom\u001b[0m failed\\n' >&2`,
    '  exit 1',
    'fi',
    `printf 'added 1 package \u001b[32mok\u001b[0m\\n'`,
    'exit 0',
    '',
  ].join('\n');
  const npmPath = path.join(dir, 'npm');
  fs.writeFileSync(npmPath, script, { mode: 0o755 });
  fs.chmodSync(npmPath, 0o755);

  const originalPath = process.env.PATH;
  const originalFail = process.env.FAKE_NPM_FAIL;
  process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ''}`;
  process.env.FAKE_NPM_FAIL = '0';
  try {
    await fn();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalFail === undefined) delete process.env.FAKE_NPM_FAIL;
    else process.env.FAKE_NPM_FAIL = originalFail;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- compareVersions -------------------------------------------------------

test('compareVersions orders numeric dot sections and differing lengths', () => {
  assert.equal(compareVersions('0.1.9', '0.1.22'), -1);
  assert.equal(compareVersions('0.1.22', '0.1.9'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.0.1', '1.2'), 1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0+build.5'), 0);
});

test('compareVersions sorts prereleases below release and orders identifiers', () => {
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-alpha'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-stage'), -1);
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1); // numeric < alphanumeric
  assert.equal(compareVersions('not a version', '1.0.0'), -1); // defensive parse
});

// --- checkForUpdate / cache ------------------------------------------------

test('checkForUpdate uses a fresh cache without hitting the network', async () => {
  const home = tempHome();
  try {
    fs.mkdirSync(path.dirname(cacheFile(home)), { recursive: true });
    fs.writeFileSync(cacheFile(home), JSON.stringify({ lastChecked: Date.now(), latest: '9.9.9' }));
    let calls = 0;
    await withFetch(async () => {
      calls++;
      throw new Error('network should not be touched');
    }, async () => {
      const info = await checkForUpdate('1.0.0', { homeDir: home, ttlMs: 60_000, timeoutMs: 500 });
      assert.deepEqual(info, { current: '1.0.0', latest: '9.9.9', updateAvailable: true });
    });
    assert.equal(calls, 0);
  } finally {
    cleanup(home);
  }
});

test('checkForUpdate forces a refetch when force is true', async () => {
  const home = tempHome();
  try {
    fs.mkdirSync(path.dirname(cacheFile(home)), { recursive: true });
    fs.writeFileSync(cacheFile(home), JSON.stringify({ lastChecked: Date.now(), latest: '9.9.9' }));
    let calls = 0;
    await withFetch(async () => {
      calls++;
      return { ok: true, json: async () => ({ version: '2.0.0' }) };
    }, async () => {
      const info = await checkForUpdate('3.0.0', { homeDir: home, force: true, timeoutMs: 500 });
      assert.deepEqual(info, { current: '3.0.0', latest: '2.0.0', updateAvailable: false });
    });
    assert.equal(calls, 1);
  } finally {
    cleanup(home);
  }
});

test('checkForUpdate refreshes a stale cache and persists the new value', async () => {
  const home = tempHome();
  try {
    fs.mkdirSync(path.dirname(cacheFile(home)), { recursive: true });
    fs.writeFileSync(cacheFile(home), JSON.stringify({ lastChecked: 0, latest: '0.0.1' }));
    await withFetch(async () => ({ ok: true, json: async () => ({ version: '0.2.0' }) }), async () => {
      const info = await checkForUpdate('0.1.9', { homeDir: home, ttlMs: 1000, timeoutMs: 500 });
      assert.deepEqual(info, { current: '0.1.9', latest: '0.2.0', updateAvailable: true });
    });
    const cached = JSON.parse(fs.readFileSync(cacheFile(home), 'utf8'));
    assert.equal(cached.latest, '0.2.0');
    assert.ok(typeof cached.lastChecked === 'number');
  } finally {
    cleanup(home);
  }
});

test('checkForUpdate refetches when the cache file is corrupt', async () => {
  const home = tempHome();
  try {
    fs.mkdirSync(path.dirname(cacheFile(home)), { recursive: true });
    fs.writeFileSync(cacheFile(home), '{not valid json');
    let calls = 0;
    await withFetch(async () => {
      calls++;
      return { ok: true, json: async () => ({ version: '1.2.3' }) };
    }, async () => {
      const info = await checkForUpdate('1.2.3', { homeDir: home, timeoutMs: 500 });
      assert.deepEqual(info, { current: '1.2.3', latest: '1.2.3', updateAvailable: false });
    });
    assert.equal(calls, 1);
  } finally {
    cleanup(home);
  }
});

test('checkForUpdate returns null on network failure or bad response', async () => {
  const home = tempHome();
  try {
    await withFetch(async () => {
      throw new Error('offline');
    }, async () => {
      assert.equal(await checkForUpdate('1.0.0', { homeDir: home, timeoutMs: 500 }), null);
    });
    assert.equal(fs.existsSync(cacheFile(home)), false);

    await withFetch(async () => ({ ok: false, status: 503 }), async () => {
      assert.equal(await checkForUpdate('1.0.0', { homeDir: home, timeoutMs: 500 }), null);
    });
    await withFetch(async () => ({ ok: true, json: async () => ({ nope: true }) }), async () => {
      assert.equal(await checkForUpdate('1.0.0', { homeDir: home, timeoutMs: 500 }), null);
    });
  } finally {
    cleanup(home);
  }
});

test('clearUpdateCache deletes the cache and is safe to repeat', () => {
  const home = tempHome();
  try {
    fs.mkdirSync(path.dirname(cacheFile(home)), { recursive: true });
    fs.writeFileSync(cacheFile(home), '{}');
    assert.equal(fs.existsSync(cacheFile(home)), true);
    clearUpdateCache(home);
    assert.equal(fs.existsSync(cacheFile(home)), false);
    assert.doesNotThrow(() => clearUpdateCache(home));
  } finally {
    cleanup(home);
  }
});

// --- installUpdate ---------------------------------------------------------

test('installUpdate reports success and strips ANSI from npm output', async () => {
  await withFakeNpm(async () => {
    const result = await installUpdate({ global: true, version: '0.2.0' });
    assert.equal(result.success, true);
    assert.match(result.message, /added 1 package ok/);
    assert.equal(result.message.includes('\u001b'), false);
  });
});

test('installUpdate reports failure with npm output', async () => {
  await withFakeNpm(async () => {
    process.env.FAKE_NPM_FAIL = '1';
    const result = await installUpdate({ global: false, version: '0.2.0', cwd: os.tmpdir() });
    assert.equal(result.success, false);
    assert.match(result.message, /exited with code 1/);
    assert.match(result.message, /boom failed/);
    assert.equal(result.message.includes('\u001b'), false);
  });
});

test('installUpdate never throws when npm cannot be spawned', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-empty-path-'));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = emptyDir;
    const result = await installUpdate();
    assert.equal(result.success, false);
    assert.match(result.message, /failed/i);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});
