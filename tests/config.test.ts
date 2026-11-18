import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectConfigFromEnvironment, ensureUserConfigDirectory, getUserRuntimeConfigDirectory, getRuntimeConfigPath, readConfig, resolveApiKey, writeActiveSelection, writeConfig, writeInitConfig, writeProviderApiKey } from '../src/config.js';
import { getActiveRuntimeConfigPath, loadRuntimeConfig, resetRuntimeConfigForTests } from '../src/runtime-config.js';
import { getAllProviders } from '../src/providers/index.js';

const KEY_ENV_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'BITACODE_API_KEY',
  'BITACODE_CUSTOM_HEADERS',
];
const originalKeyEnv = new Map(KEY_ENV_VARS.map((key) => [key, process.env[key]]));

test.afterEach(() => {
  for (const key of KEY_ENV_VARS) {
    const original = originalKeyEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  resetRuntimeConfigForTests();
});

test('detectConfigFromEnvironment returns null when no key env var is set', () => {
  for (const key of KEY_ENV_VARS) delete process.env[key];

  assert.equal(detectConfigFromEnvironment(), null);
});

test('detectConfigFromEnvironment picks the provider and leaves its key in env', () => {
  for (const key of KEY_ENV_VARS) delete process.env[key];
  process.env.OPENAI_API_KEY = '  openai-secret  ';
  const openai = getAllProviders().find((provider) => provider.id === 'openai')!;

  assert.deepEqual(detectConfigFromEnvironment(), {
    provider: 'openai',
    model: openai.models[0].id,
  });
});

test('detectConfigFromEnvironment copies alias keys the app cannot resolve from env', () => {
  for (const key of KEY_ENV_VARS) delete process.env[key];
  process.env.GOOGLE_API_KEY = 'google-secret';
  const google = getAllProviders().find((provider) => provider.id === 'google')!;

  assert.deepEqual(detectConfigFromEnvironment(), {
    provider: 'google',
    model: google.models[0].id,
    apiKey: 'google-secret',
  });
});

test('detectConfigFromEnvironment respects provider priority over the generic key', () => {
  for (const key of KEY_ENV_VARS) delete process.env[key];
  process.env.ANTHROPIC_API_KEY = 'anthropic-secret';
  process.env.BITACODE_API_KEY = 'generic-secret';
  const anthropic = getAllProviders().find((provider) => provider.id === 'anthropic')!;

  assert.deepEqual(detectConfigFromEnvironment(), {
    provider: 'anthropic',
    model: anthropic.models[0].id,
  });
});

test('detectConfigFromEnvironment falls back to the first provider for a generic key', () => {
  for (const key of KEY_ENV_VARS) delete process.env[key];
  process.env.BITACODE_API_KEY = 'generic-secret';
  const first = getAllProviders()[0];

  assert.deepEqual(detectConfigFromEnvironment(), {
    provider: first.id,
    model: first.models[0].id,
  });
});

test('resolveApiKey prefers environment variable over config value', () => {
  process.env.OPENAI_API_KEY = 'env-secret';

  const apiKey = resolveApiKey({ provider: 'openai', apiKey: 'config-secret' });

  assert.equal(apiKey, 'env-secret');
});

test('resolveApiKey falls back to provider environment variable', () => {
  process.env.OPENAI_API_KEY = 'env-secret';

  const apiKey = resolveApiKey({ provider: 'openai', apiKey: undefined });

  assert.equal(apiKey, 'env-secret');
});

test('resolveApiKey falls back to BITACODE_API_KEY when provider env is absent', () => {
  process.env.BITACODE_API_KEY = 'override-secret';

  const apiKey = resolveApiKey({ provider: 'openai', apiKey: undefined });

  assert.equal(apiKey, 'override-secret');
});

test('resolveApiKey recognizes provider alias env vars', () => {
  for (const key of KEY_ENV_VARS) delete process.env[key];
  process.env.GOOGLE_API_KEY = 'google-alias';

  assert.equal(resolveApiKey({ provider: 'google', apiKey: undefined }), 'google-alias');

  process.env.GEMINI_API_KEY = 'gemini-primary';
  assert.equal(resolveApiKey({ provider: 'google', apiKey: undefined }), 'gemini-primary');
});

test('resolveApiKey does not mistake cosmetic headers for authentication', () => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.BITACODE_API_KEY;

  const apiKey = resolveApiKey({ provider: 'openrouter', apiKey: undefined });

  assert.equal(apiKey, null);
});

test('loadRuntimeConfig tolerates missing config files', async () => {
  const originalHome = process.env.HOME;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-load-test-'));
  
  try {
    process.env.HOME = tempDir;
    // Ensure we are in a directory without .bitacode/bitacode.jsonc
    const cwd = fs.mkdtempSync(path.join(tempDir, 'cwd-'));
    const originalCwd = process.cwd();
    process.chdir(cwd);

    try {
      const config = await loadRuntimeConfig(true);

      assert.deepEqual(config.mcp?.servers || {}, {});
      assert.deepEqual(config.providers || {}, {});
    } finally {
      process.chdir(originalCwd);
    }
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('getActiveRuntimeConfigPath prefers project config over user config', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-active-'));
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;

  try {
    process.chdir(cwd);
    process.env.HOME = cwd;

    const userPath = path.join(cwd, '.config', 'bitacode', 'bitacode.jsonc');
    const projectPath = path.join(cwd, '.bitacode', 'bitacode.jsonc');
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(userPath, '{"providers":{}}\n', 'utf8');
    fs.writeFileSync(projectPath, '{"providers":{}}\n', 'utf8');

    assert.equal(fs.realpathSync(getActiveRuntimeConfigPath()!), fs.realpathSync(projectPath));
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('getRuntimeConfigPath returns project-local bitacode.jsonc path', () => {
  const projectPath = getRuntimeConfigPath('project', '/tmp/demo-project');
  assert.equal(projectPath, path.join('/tmp/demo-project', '.bitacode', 'bitacode.jsonc'));
});

test('ensureUserConfigDirectory creates the shared config folder on first run', () => {
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-home-'));

  try {
    process.env.HOME = tempHome;

    const configDir = ensureUserConfigDirectory();

    assert.equal(configDir, getUserRuntimeConfigDirectory());
    assert.ok(fs.existsSync(configDir));
    assert.ok(fs.statSync(configDir).isDirectory());
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('writeInitConfig creates project runtime config and reports the path', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-init-'));

  try {
    const result = writeInitConfig('project', cwd);

    assert.equal(result.status, 'created');
    assert.equal(result.path, path.join(cwd, '.bitacode', 'bitacode.jsonc'));
    assert.ok(fs.existsSync(result.path));

    const content = fs.readFileSync(result.path, 'utf8');
    assert.ok(content.includes('"providers":'));
    assert.ok(content.includes('"servers":'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeInitConfig does not overwrite an existing file', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-init-'));
  const configPath = path.join(cwd, '.bitacode', 'bitacode.jsonc');

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{"existing":true}\n', 'utf8');

    const result = writeInitConfig('project', cwd);

    assert.equal(result.status, 'exists');
    assert.equal(fs.readFileSync(configPath, 'utf8'), '{"existing":true}\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeInitConfig can overwrite an existing file when forced', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-init-'));
  const configPath = path.join(cwd, '.bitacode', 'bitacode.jsonc');

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{"existing":true}\n', 'utf8');

    const result = writeInitConfig('project', cwd, { overwrite: true });

    assert.equal(result.status, 'overwritten');
    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('"providers":'));
    assert.ok(content.includes('"servers":'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeConfig stores the selected provider/model in bitacode.jsonc', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-config-'));

  try {
    const configPath = writeConfig({ provider: 'openai', model: 'gpt-5-mini', apiKey: 'secret' }, 'project', cwd);
    const content = fs.readFileSync(configPath, 'utf8');

    assert.ok(content.includes('"openai"'));
    assert.ok(content.includes('"gpt-5-mini"'));
    assert.ok(content.includes('"apiKey": "secret"'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeProviderApiKey saves a key without changing the active provider', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-key-'));
  const configPath = path.join(cwd, '.bitacode', 'bitacode.jsonc');

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        openai: { apiKey: 'old-key', models: { 'gpt-5-mini': {} } },
        openrouter: { models: { 'openai/gpt-4o': {} } },
      },
    }, null, 2));

    writeProviderApiKey('openrouter', ' new-key ', 'project', cwd);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    assert.deepEqual(Object.keys(saved.providers), ['openai', 'openrouter']);
    assert.equal(saved.providers.openrouter.apiKey, 'new-key');
    assert.deepEqual(saved.providers.openrouter.models, { 'openai/gpt-4o': {} });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeActiveSelection promotes a provider/model without losing keys or order', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-active-selection-'));
  const configPath = path.join(cwd, '.bitacode', 'bitacode.jsonc');

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        openai: { apiKey: 'old-key', models: { 'gpt-5-mini': { name: 'Mini' } } },
        openrouter: { apiKey: 'router-key', models: { 'openai/gpt-4o': {} } },
      },
      mcp: { servers: { demo: { type: 'http', url: 'https://example.com' } } },
    }, null, 2));

    writeActiveSelection('openrouter', 'new-model', 'project', cwd, {
      name: 'New Model',
      contextWindow: 32_000,
    });
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    assert.deepEqual(Object.keys(saved.providers), ['openrouter', 'openai']);
    assert.deepEqual(Object.keys(saved.providers.openrouter.models), ['new-model', 'openai/gpt-4o']);
    assert.equal(saved.providers.openrouter.apiKey, 'router-key');
    assert.equal(saved.providers.openrouter.models['new-model'].name, 'New Model');
    assert.equal(saved.providers.openrouter.models['new-model'].contextWindow, 32000);
    assert.equal(saved.providers.openai.apiKey, 'old-key');
    assert.deepEqual(saved.mcp, { servers: { demo: { type: 'http', url: 'https://example.com' } } });

    const active = readConfig('project', cwd);
    assert.equal(active?.provider, 'openrouter');
    assert.equal(active?.model, 'new-model');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('readConfig returns the first configured provider/model from bitacode.jsonc', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-config-'));
  const configPath = path.join(cwd, '.bitacode', 'bitacode.jsonc');

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        google: {
          models: {
            'gemini-3-flash-preview': {},
          },
        },
        openai: {
          models: {
            'gpt-5-mini': {},
          },
        },
      },
    }, null, 2));

    assert.deepEqual(readConfig('project', cwd), {
      provider: 'google',
      model: 'gemini-3-flash-preview',
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
