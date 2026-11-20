/**
 * Pure-function tests for the plugin system: manifest parsing, discovery
 * filtering, registry roundtrip and registration on a fake plugin API.
 * No plugin entry file is ever executed here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CustomCommand } from '../src/utils/custom-commands.js';
import type { HookCommand } from '../src/utils/hooks.js';
import { runHooks } from '../src/utils/hooks.js';
import {
  createPluginApi,
  discoverPlugins,
  filterEnabledPlugins,
  loadPlugins,
  normalizePluginRegistry,
  parsePluginManifest,
  readPluginRegistry,
  setPluginEnabled,
  writePluginRegistry,
  type PluginApi,
  type PluginApiSink,
  type PluginDescriptor,
} from '../src/utils/plugins.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-plugins-'));
}

function writePlugin(root: string, scopeDir: string, name: string, manifest: unknown): string {
  const dir = path.join(root, scopeDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'index.mjs'), 'export function register() {}\n');
  return dir;
}

function descriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    name: 'demo',
    version: '1.0.0',
    description: 'A demo plugin',
    entry: '/tmp/demo/index.mjs',
    dir: '/tmp/demo',
    manifestPath: '/tmp/demo/plugin.json',
    scope: 'user',
    enabled: true,
    ...overrides,
  };
}

function sink(): PluginApiSink {
  return { commands: [] as CustomCommand[], hooks: [] as HookCommand[], errors: [] as string[] };
}

// ─── manifest parsing ───

test('parsePluginManifest accepts a valid manifest with defaults', () => {
  const parsed = parsePluginManifest(
    { name: 'hello.world-1', version: '1.2.3', description: 'Greets', entry: 'index.mjs' },
    'plugin.json',
  );
  assert.ok(!('error' in parsed));
  assert.deepEqual(parsed, {
    name: 'hello.world-1',
    version: '1.2.3',
    description: 'Greets',
    entry: 'index.mjs',
    enabled: true,
  });
});

test('parsePluginManifest rejects invalid names, versions, entries and enabled flags', () => {
  const cases: unknown[] = [
    null,
    { version: '1', entry: 'index.mjs' },
    { name: 'bad name', version: '1', entry: 'index.mjs' },
    { name: 'ok', version: '', entry: 'index.mjs' },
    { name: 'ok', version: '1', entry: 'index.ts' },
    { name: 'ok', version: '1', entry: '/etc/passwd' },
    { name: 'ok', version: '1', entry: '../escape.mjs' },
    { name: 'ok', version: '1', entry: 'index.mjs', enabled: 'yes' },
  ];
  for (const raw of cases) {
    const parsed = parsePluginManifest(raw, 'plugin.json');
    assert.ok('error' in parsed, `expected an error for ${JSON.stringify(raw)}`);
    assert.match(parsed.error, /plugin.json/);
  }
});

// ─── registry ───

test('registry normalizes junk and round-trips enable/disable through a file', () => {
  const normalized = normalizePluginRegistry({
    version: 9,
    overrides: { alpha: true, beta: 'no', 'bad name': true, gamma: false },
  });
  assert.deepEqual(normalized, { version: 1, overrides: { alpha: true, gamma: false } });

  const dir = tempDir();
  try {
    const file = path.join(dir, 'registry.json');
    assert.deepEqual(readPluginRegistry(file), { version: 1, overrides: {} });

    const enabled = setPluginEnabled(normalized, 'beta', true);
    const disabled = setPluginEnabled(enabled, 'alpha', false);
    // setPluginEnabled is pure: the input is not mutated.
    assert.equal(normalized.overrides.alpha, true);
    assert.equal(writePluginRegistry(disabled, file), true);
    assert.deepEqual(readPluginRegistry(file), disabled);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── discovery filtering ───

test('discovery skips invalid plugins, honors overrides and ignores untrusted project plugins', () => {
  const root = tempDir();
  try {
    writePlugin(root, 'user', 'alpha', { name: 'alpha', version: '1', entry: 'index.mjs' });
    writePlugin(root, 'user', 'beta', { name: 'beta', version: '1', entry: 'index.mjs', enabled: false });
    writePlugin(root, 'user', 'broken', { name: 'broken', version: 1, entry: 'index.mjs' });
    writePlugin(root, 'project', 'alpha', { name: 'alpha', version: '2', entry: 'index.mjs' });
    writePlugin(root, 'project', 'gamma', { name: 'gamma', version: '1', entry: 'index.mjs' });

    const projectDir = path.join(root, 'project');
    const userDir = path.join(root, 'user');

    const untrusted = discoverPlugins({ cwd: root, trusted: false, userDir, projectDir, registry: { version: 1, overrides: {} } });
    assert.deepEqual(untrusted.plugins.map((plugin) => plugin.name), ['alpha', 'beta']);
    assert.match(untrusted.errors.join(' '), /not trusted/);
    assert.match(untrusted.errors.join(' '), /"version" must be a non-empty string/);
    assert.equal(untrusted.plugins.find((plugin) => plugin.name === 'beta')?.enabled, false);

    const trusted = discoverPlugins({ cwd: root, trusted: true, userDir, projectDir, registry: { version: 1, overrides: {} } });
    assert.deepEqual(trusted.plugins.map((plugin) => plugin.name), ['alpha', 'beta', 'gamma']);
    assert.equal(trusted.plugins.find((plugin) => plugin.name === 'alpha')?.version, '2', 'project plugin wins');
    assert.deepEqual(filterEnabledPlugins(trusted.plugins).map((plugin) => plugin.name), ['alpha', 'gamma']);

    const overridden = discoverPlugins({
      cwd: root,
      trusted: false,
      userDir,
      projectDir,
      registry: { version: 1, overrides: { beta: true } },
    });
    assert.equal(overridden.plugins.find((plugin) => plugin.name === 'beta')?.enabled, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── fake API registration ───

test('createPluginApi records commands and hooks and validates their inputs', () => {
  const out = sink();
  const api = createPluginApi(descriptor({ name: 'greet' }), out);
  api.registerCommand('hello', 'Say hello', () => 'hi');
  api.onHook('PreToolUse', () => ({ context: 'note' }));
  assert.equal(out.commands.length, 1);
  assert.equal(out.commands[0].name, 'hello');
  assert.equal(out.commands[0].description, 'Say hello');
  assert.equal(out.hooks.length, 1);
  assert.equal(out.hooks[0].event, 'PreToolUse');
  assert.equal(typeof out.hooks[0].handler, 'function');

  api.registerCommand('bad name', 'x', () => undefined);
  api.onHook('NotAnEvent' as never, () => undefined);
  assert.equal(out.errors.length, 2);
  assert.match(out.errors.join(' '), /invalid command name/);
  assert.match(out.errors.join(' '), /unknown hook event/);
});

test('loadPlugins calls register once, skips disabled plugins and never throws', async () => {
  const root = tempDir();
  try {
    const good = descriptor({ name: 'good', entry: path.join(root, 'good.mjs'), dir: root, manifestPath: path.join(root, 'good.json') });
    const off = descriptor({ name: 'off', enabled: false });
    const broken = descriptor({ name: 'broken', entry: path.join(root, 'bad.mjs') });

    let registered = 0;
    const result = await loadPlugins({
      plugins: [good, off, broken],
      importer: async (file) => {
        if (file.includes('bad.mjs')) throw new Error('import failed');
        return {
          register(api: PluginApi) {
            registered++;
            api.registerCommand('ping', 'Ping', () => 'pong');
          },
        };
      },
    });

    assert.equal(registered, 1);
    assert.deepEqual(result.loaded, ['good']);
    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0].name, 'ping');
    assert.match(result.errors.join(' '), /disabled/);
    assert.match(result.errors.join(' '), /failed to load/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a plugin hook handler runs in-process and can block a call', async () => {
  const root = tempDir();
  try {
    const outcome = await runHooks({
      event: 'PreToolUse',
      hooks: [{
        event: 'PreToolUse',
        command: 'unused',
        timeoutMs: 1_000,
        source: 'plugin:test',
        handler: () => ({ blocked: true, reason: 'nope' }),
      }],
      payload: { event: 'PreToolUse', cwd: root },
      cwd: root,
    });
    assert.equal(outcome.ran, 1);
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.reason, 'nope');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
