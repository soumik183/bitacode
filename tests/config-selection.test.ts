import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readConfig,
  selectActiveProviderAndModel,
  writeActiveSelection,
  writeConfig,
  writeProviderApiKey,
} from '../src/config.js';

async function projectDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bitacode-selection-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const readFile = async (dir: string) =>
  JSON.parse(await fs.readFile(path.join(dir, '.bitacode', 'bitacode.jsonc'), 'utf8'));

test('an explicit selection wins regardless of provider order', () => {
  const config = {
    provider: 'openrouter',
    model: 'openrouter/free',
    providers: {
      openai: { apiKey: 'sk-openai', models: { 'gpt-4o-mini': {} } },
      openrouter: { apiKey: 'sk-or', models: { 'openrouter/free': {} } },
    },
  };
  assert.deepEqual(selectActiveProviderAndModel(config), {
    provider: 'openrouter',
    model: 'openrouter/free',
    apiKey: 'sk-or',
  });
});

test('legacy configs still resolve, preferring a provider that has a key', () => {
  const legacy = {
    providers: {
      keyless: { models: { 'ghost-model': {} } },
      keyed: { apiKey: 'sk-keyed', models: { 'real-model': {} } },
    },
  };
  assert.deepEqual(selectActiveProviderAndModel(legacy), {
    provider: 'keyed',
    model: 'real-model',
    apiKey: 'sk-keyed',
  });
});

test('a stale model name falls back to the selected provider first model', () => {
  const config = {
    provider: 'openai',
    model: 'retired-model',
    providers: { openai: { apiKey: 'sk', models: { 'gpt-4o-mini': {} } } },
  };
  assert.deepEqual(selectActiveProviderAndModel(config), {
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: 'sk',
  });
});

test('a selection pointing at a missing provider falls back to order', () => {
  const config = {
    provider: 'deleted-provider',
    model: 'x',
    providers: { openai: { apiKey: 'sk', models: { 'gpt-4o-mini': {} } } },
  };
  assert.equal(selectActiveProviderAndModel(config)?.provider, 'openai');
  assert.equal(selectActiveProviderAndModel({ providers: {} }), null);
});

test('saving a key also saves the selection when none is usable', async () => {
  await projectDir(async (dir) => {
    // A provider listed without a key is exactly the state that used to leave
    // the selection implicit after the key was entered.
    await fs.mkdir(path.join(dir, '.bitacode'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.bitacode', 'bitacode.jsonc'),
      JSON.stringify({ providers: { openrouter: { models: { 'openrouter/free': {} } } } }),
    );

    writeProviderApiKey('openrouter', 'sk-or-test', 'project', dir);
    const file = await readFile(dir);
    assert.equal(file.provider, 'openrouter', 'provider is selected with the key');
    assert.equal(file.model, 'openrouter/free', 'its first model is selected too');
    assert.deepEqual(readConfig('project', dir), {
      provider: 'openrouter',
      model: 'openrouter/free',
      apiKey: 'sk-or-test',
    });
  });
});

test('saving a second key does not steal an existing runnable selection', async () => {
  await projectDir(async (dir) => {
    writeActiveSelection('openrouter', 'openrouter/free', 'project', dir);
    writeProviderApiKey('openai', 'sk-openai', 'project', dir);
    writeProviderApiKey('openai', 'sk-openai', 'project', dir);
    const file = await readFile(dir);
    assert.equal(file.provider, 'openrouter', 'stored selection is untouched');
    assert.equal(readConfig('project', dir)?.provider, 'openrouter');
    assert.equal(file.providers.openai.apiKey, 'sk-openai');
  });
});

test('the active selection survives a rewrite that reorders providers', async () => {
  await projectDir(async (dir) => {
    writeActiveSelection('openrouter', 'openrouter/free', 'project', dir);
    // writeConfig moves the configured provider to the front of the file; the
    // selection must follow the intent instead of the new order.
    writeConfig({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-openai' }, 'project', dir);
    assert.equal(readConfig('project', dir)?.provider, 'openai');

    writeActiveSelection('openrouter', 'openrouter/free', 'project', dir);
    const file = await readFile(dir);
    assert.equal(file.provider, 'openrouter');
    assert.equal(Object.keys(file.providers)[0], 'openrouter');
    assert.equal(readConfig('project', dir)?.model, 'openrouter/free');
  });
});
