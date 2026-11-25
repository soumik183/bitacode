import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfigWatcher, defaultWatchTargets, type WatchEvent } from '../src/utils/config-watch.js';

/** Poll instead of fixed sleeps so slow CI runners don't flake. */
async function waitFor(predicate: () => boolean, timeoutMs = 400): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function patchWatch(impl: unknown): () => void {
  const module = fs as unknown as { watch: unknown };
  const original = module.watch;
  module.watch = impl;
  return () => {
    module.watch = original;
  };
}

// --- defaultWatchTargets ----------------------------------------------------

test('defaultWatchTargets returns all project and user locations without fs access', () => {
  const targets = defaultWatchTargets({ cwd: '/work/project', home: '/home/tester' });
  const project = path.join('/work/project', '.bitacode');
  const user = path.join('/home/tester', '.config', 'bitacode');

  assert.equal(targets.length, 7);
  assert.deepEqual(
    targets.map((target) => target.path),
    [
      path.join(project, 'bitacode.jsonc'),
      path.join(project, 'permissions.json'),
      path.join(project, 'hooks.json'),
      path.join(project, 'themes'),
      path.join(project, 'agents'),
      path.join(project, 'skills'),
      path.join(user, 'bitacode.jsonc'),
    ]
  );
  assert.deepEqual(
    targets.map((target) => target.label),
    ['config', 'permissions', 'hooks', 'themes', 'agents', 'skills', 'global-config']
  );
  assert.equal(new Set(targets.map((target) => target.label)).size, targets.length);
});

test('defaultWatchTargets uses cwd and homedir when options are omitted', () => {
  const targets = defaultWatchTargets();
  assert.equal(targets[0]!.path, path.join(process.cwd(), '.bitacode', 'bitacode.jsonc'));
  assert.equal(targets[6]!.path, path.join(os.homedir(), '.config', 'bitacode', 'bitacode.jsonc'));
});

// --- start / stop -----------------------------------------------------------

test('start returns false when fs.watch is unavailable', () => {
  const restore = patchWatch(undefined);
  try {
    const watcher = createConfigWatcher([{ label: 'config', path: '/tmp/bitacode.jsonc' }], () => {});
    assert.equal(watcher.start(), false);
    assert.equal(watcher.start(), false);
    assert.doesNotThrow(() => watcher.stop());
  } finally {
    restore();
  }
});

test('start and stop are idempotent and a stopped watcher can restart', () => {
  const dir = tempDir('bitacode-watch-idempotent-');
  const config = path.join(dir, 'bitacode.jsonc');
  fs.writeFileSync(config, '{}\n');

  const original = fs.watch;
  let calls = 0;
  const restore = patchWatch((...args: any[]) => {
    calls += 1;
    return (original as any)(...args);
  });
  const watcher = createConfigWatcher([{ label: 'config', path: config }], () => {});

  try {
    assert.equal(watcher.start(), true);
    assert.equal(watcher.start(), true);
    assert.equal(calls, 1);

    watcher.stop();
    watcher.stop();
    assert.equal(watcher.start(), true);
    assert.equal(calls, 2);
  } finally {
    watcher.stop();
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing watch target does not prevent the other targets from being watched', async () => {
  const dir = tempDir('bitacode-watch-partial-');
  const good = path.join(dir, 'hooks.json');
  fs.writeFileSync(good, '{}');
  const received: WatchEvent[] = [];

  const original = fs.watch;
  const restore = patchWatch((watchPath: string, ...rest: any[]) => {
    if (String(watchPath).includes('missing')) throw new Error('watch failed');
    return (original as any)(watchPath, ...rest);
  });
  const watcher = createConfigWatcher(
    [
      { label: 'config', path: path.join(dir, 'missing', 'bitacode.jsonc') },
      { label: 'hooks', path: good },
    ],
    (event) => received.push(event),
    { debounceMs: 20 }
  );

  try {
    assert.equal(watcher.start(), true);
    fs.writeFileSync(good, '{ "updated": true }');
    const config = path.join(dir, 'missing', 'bitacode.jsonc');
    fs.mkdirSync(path.join(dir, 'missing'), { recursive: true });
    fs.writeFileSync(config, '{}');
    await waitFor(() => received.length >= 1);
    assert.equal(received[0]!.label, 'hooks');
  } finally {
    watcher.stop();
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a target with a non-existent parent is skipped without throwing', () => {
  const dir = tempDir('bitacode-watch-missing-');
  const watcher = createConfigWatcher(
    [{ label: 'config', path: path.join(dir, 'no-such-parent', 'bitacode.jsonc') }],
    () => {}
  );
  try {
    assert.doesNotThrow(() => watcher.start());
    assert.doesNotThrow(() => watcher.stop());
    assert.equal(watcher.events.length, 0);
  } finally {
    watcher.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- debounce / filtering ---------------------------------------------------

test('notify coalesces rapid events per label into one callback', async () => {
  const received: WatchEvent[] = [];
  const watcher = createConfigWatcher([], (event) => received.push(event), { debounceMs: 30 });
  try {
    watcher.notify('config', '/project/.bitacode/bitacode.jsonc');
    watcher.notify('config', '/project/.bitacode/bitacode.jsonc');
    watcher.notify('config', '/project/.bitacode/bitacode.jsonc');
    watcher.notify('hooks', '/project/.bitacode/hooks.json');

    await waitFor(() => received.length === 2);
    await settle(60);
    assert.equal(received.length, 2);
    assert.deepEqual(
      received.map((event) => event.label).sort(),
      ['config', 'hooks']
    );
    const configEvent = received.find((event) => event.label === 'config')!;
    assert.equal(configEvent.path, '/project/.bitacode/bitacode.jsonc');
    assert.equal(typeof configEvent.changedAt, 'number');
    assert.equal(watcher.events.length, 2);
  } finally {
    watcher.stop();
  }
});

test('notify ignores editor temp and autosave files', async () => {
  const received: WatchEvent[] = [];
  const watcher = createConfigWatcher([], (event) => received.push(event), { debounceMs: 20 });
  try {
    watcher.notify('config', '/project/.bitacode/bitacode.jsonc.tmp');
    watcher.notify('config', '/project/.bitacode/bitacode.jsonc~');
    watcher.notify('config', '/project/.bitacode/bitacode.jsonc.TMP');
    await settle(60);
    assert.equal(received.length, 0);

    watcher.notify('config', '/project/.bitacode/bitacode.jsonc');
    await waitFor(() => received.length === 1);
    assert.equal(received[0]!.path, '/project/.bitacode/bitacode.jsonc');
  } finally {
    watcher.stop();
  }
});

test('stop cancels pending notifications and later notify calls are ignored', async () => {
  const received: WatchEvent[] = [];
  const watcher = createConfigWatcher([], (event) => received.push(event), { debounceMs: 20 });
  watcher.notify('config', '/project/.bitacode/bitacode.jsonc');
  watcher.stop();

  await settle(60);
  watcher.notify('config', '/project/.bitacode/bitacode.jsonc');
  await settle(60);
  assert.equal(received.length, 0);
  assert.equal(watcher.events.length, 0);
});

test('a throwing onChange callback is contained and the event is still recorded', async () => {
  const watcher = createConfigWatcher([], () => { throw new Error('callback exploded'); }, { debounceMs: 20 });
  try {
    assert.doesNotThrow(() => watcher.notify('config', '/project/.bitacode/bitacode.jsonc'));
    await waitFor(() => watcher.events.length === 1);
    assert.equal(watcher.events[0]!.label, 'config');
  } finally {
    watcher.stop();
  }
});

test('events keeps only the last 50 changes', async () => {
  const watcher = createConfigWatcher([], () => {}, { debounceMs: 5 });
  try {
    for (let i = 0; i < 60; i += 1) watcher.notify(`label-${i}`, `/project/config-${i}.json`);
    await waitFor(() => watcher.events.length === 50);
    await settle(40);
    assert.equal(watcher.events.length, 50);
    assert.equal(watcher.events[0]!.label, 'label-10');
    assert.equal(watcher.events[49]!.label, 'label-59');
  } finally {
    watcher.stop();
  }
});

// --- real fs.watch integration ----------------------------------------------

test('a real file change is debounced and delivered, temp churn is filtered', async () => {
  const dir = tempDir('bitacode-watch-file-');
  const config = path.join(dir, 'bitacode.jsonc');
  fs.writeFileSync(config, '{}\n');
  const received: WatchEvent[] = [];
  const watcher = createConfigWatcher(
    [{ label: 'config', path: config }],
    (event) => received.push(event),
    { debounceMs: 40 }
  );

  try {
    assert.equal(watcher.start(), true);
    fs.writeFileSync(`${config}.tmp`, 'partial write');
    await settle(100);
    assert.equal(received.length, 0);

    fs.writeFileSync(config, '{ "model": "test" }\n');
    await waitFor(() => received.length === 1);
    assert.equal(received[0]!.label, 'config');
    assert.equal(received[0]!.path, config);
  } finally {
    watcher.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory target accepts changes to any file inside it', async () => {
  const dir = tempDir('bitacode-watch-dir-');
  const skills = path.join(dir, 'skills');
  fs.mkdirSync(skills, { recursive: true });
  const received: WatchEvent[] = [];
  const watcher = createConfigWatcher(
    [{ label: 'skills', path: skills }],
    (event) => received.push(event),
    { debounceMs: 40 }
  );

  try {
    assert.equal(watcher.start(), true);
    fs.writeFileSync(path.join(skills, 'new-skill.md'), '---\nname: demo\n---\n');
    await waitFor(() => received.length === 1);
    assert.equal(received[0]!.label, 'skills');
    assert.equal(received[0]!.path, skills);
  } finally {
    watcher.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
