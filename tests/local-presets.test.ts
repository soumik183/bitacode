/**
 * Tests for the config-only local / self-hosted provider presets.
 *
 * These tests never touch the network: detection is exercised exclusively
 * through an injected `probe` function.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_PRESETS,
  presetToProviderConfig,
  mergeLocalPresets,
  detectLocalServers,
  type LocalPreset,
} from '../src/providers/local-presets.js';
import { logger } from '../src/utils/logger.js';

test('LOCAL_PRESETS has the four expected ids, endpoints and generic models', () => {
  assert.equal(LOCAL_PRESETS.length, 4);
  assert.deepEqual(LOCAL_PRESETS.map((preset) => preset.id), ['ollama', 'lmstudio', 'vllm', 'localai']);

  const endpoints: Record<string, string> = {
    ollama: 'http://127.0.0.1:11434/v1',
    lmstudio: 'http://127.0.0.1:1234/v1',
    vllm: 'http://127.0.0.1:8000/v1',
    localai: 'http://127.0.0.1:8080/v1',
  };

  for (const preset of LOCAL_PRESETS) {
    assert.equal(typeof preset.name, 'string');
    assert.ok(preset.name.trim().length > 0);
    assert.equal(preset.baseURL, endpoints[preset.id]);
    assert.equal(typeof preset.note, 'string');
    assert.ok(preset.note.includes('contextWindow'), 'note documents the assumed context window');

    const modelIds = Object.keys(preset.models);
    assert.ok(modelIds.length > 0, `${preset.id} has at least one placeholder model`);
    for (const [modelId, model] of Object.entries(preset.models)) {
      assert.ok(modelId.trim().length > 0);
      assert.equal(typeof model.name, 'string');
      assert.ok(Number.isInteger(model.contextWindow) && model.contextWindow > 0);
      assert.equal(model.inputPricePerMillion, 0);
      assert.equal(model.outputPricePerMillion, 0);
    }
  }
});

test('presetToProviderConfig maps a preset onto the runtime provider config shape', () => {
  const preset = LOCAL_PRESETS.find((entry) => entry.id === 'ollama') as LocalPreset;
  const config = presetToProviderConfig(preset);

  assert.equal(config.name, 'Ollama (local)');
  assert.equal(config.baseURL, 'http://127.0.0.1:11434/v1');
  assert.equal(config.apiKey, 'ollama', 'local servers use the preset id as a placeholder apiKey');
  assert.ok(!('note' in config), 'note is documentation, not a runtime config field');

  const models = config.models as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(models), ['ollama-default']);
  assert.equal(models['ollama-default'].name, 'Ollama default model');
  assert.equal(models['ollama-default'].contextWindow, 8192);
  assert.equal(models['ollama-default'].inputPricePerMillion, 0);
  assert.equal(models['ollama-default'].outputPricePerMillion, 0);
});

test('presetToProviderConfig tolerates malformed input and skips bad models', () => {
  assert.deepEqual(presetToProviderConfig(null as unknown as LocalPreset), {});
  assert.deepEqual(presetToProviderConfig({} as LocalPreset), {});

  const config = presetToProviderConfig({
    id: 'custom',
    name: '   ',
    baseURL: 'not-a-url',
    note: '',
    models: {
      'good-model': { name: 'Good', contextWindow: 4096, inputPricePerMillion: 0, outputPricePerMillion: 0 },
      'bad-model': null,
    },
  } as unknown as LocalPreset);

  assert.equal(config.name, 'custom', 'missing name falls back to the id');
  assert.ok(!('baseURL' in config), 'invalid baseURL is omitted rather than throwing');
  assert.equal(config.apiKey, 'custom');
  const models = config.models as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(models), ['good-model']);
  assert.equal(models['good-model'].contextWindow, 4096);
});

test('mergeLocalPresets preserves existing providers (project/user config wins)', () => {
  const existing = {
    ollama: { name: 'My Ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'mine', models: {} },
    custom: { name: 'Custom' },
  };
  const result = mergeLocalPresets(existing);

  assert.deepEqual(result.ollama, existing.ollama);
  assert.deepEqual(result.custom, existing.custom);
  assert.equal((result.ollama as { name: string }).name, 'My Ollama');
});

test('mergeLocalPresets adds only missing presets', () => {
  const result = mergeLocalPresets({});
  assert.deepEqual(Object.keys(result), ['ollama', 'lmstudio', 'vllm', 'localai']);
  for (const preset of LOCAL_PRESETS) {
    assert.deepEqual(result[preset.id], presetToProviderConfig(preset));
  }
});

test('mergeLocalPresets respects include and ignores unknown ids', () => {
  const onlyTwo = mergeLocalPresets({}, { include: ['vllm', 'does-not-exist'] });
  assert.deepEqual(Object.keys(onlyTwo), ['vllm']);

  const none = mergeLocalPresets({}, { include: [] });
  assert.deepEqual(none, {});

  const all = mergeLocalPresets({}, { include: ['ollama', 'lmstudio', 'vllm', 'localai', 'unknown'] });
  assert.deepEqual(Object.keys(all), ['ollama', 'lmstudio', 'vllm', 'localai']);
});

test('mergeLocalPresets never mutates its input and tolerates bad input', () => {
  const existing = {
    openai: { name: 'OpenAI' },
    ollama: { name: 'Local override' },
  };
  const snapshot = structuredClone(existing);
  const result = mergeLocalPresets(existing, { include: ['ollama', 'vllm'] });

  assert.deepEqual(existing, snapshot, 'input object is unchanged');
  assert.notStrictEqual(result, existing, 'a new object is returned');
  assert.deepEqual(result.ollama, { name: 'Local override' });

  const allPresets = mergeLocalPresets({});
  assert.deepEqual(mergeLocalPresets(null as unknown as Record<string, unknown>), allPresets);
  assert.deepEqual(mergeLocalPresets([] as unknown as Record<string, unknown>), allPresets);
  assert.deepEqual(mergeLocalPresets({}, null as unknown as { include?: string[] }), allPresets);
});

test('detectLocalServers uses an injected probe and returns detected ids in preset order', async () => {
  const probed: string[] = [];
  const result = await detectLocalServers({
    probe: async (url) => {
      probed.push(url);
      return url === 'http://127.0.0.1:11434/v1' || url === 'http://127.0.0.1:8000/v1';
    },
  });

  assert.deepEqual(result, ['ollama', 'vllm']);
  assert.deepEqual(probed, LOCAL_PRESETS.map((preset) => preset.baseURL));
});

test('detectLocalServers treats a rejected probe as false and logs via logger.debug', async () => {
  const originalDebug = logger.debug;
  const debugMessages: string[] = [];
  logger.debug = (message) => {
    debugMessages.push(String(message));
  };

  try {
    const result = await detectLocalServers({
      probe: async (url) => {
        if (url.includes(':1234')) throw new Error('port closed');
        return url.includes(':11434');
      },
    });

    assert.deepEqual(result, ['ollama']);
    assert.ok(
      debugMessages.some((message) => message.includes('probe rejected')),
      'a rejected probe is reported through logger.debug',
    );
  } finally {
    logger.debug = originalDebug;
  }
});

test('detectLocalServers performs no network requests by default', async () => {
  assert.deepEqual(await detectLocalServers(), []);
  assert.deepEqual(await detectLocalServers({}), []);
  assert.deepEqual(
    await detectLocalServers({ probe: undefined }),
    [],
    'an absent/invalid probe never falls back to real HTTP calls',
  );
  assert.deepEqual(
    await detectLocalServers({ probe: 'not-a-function' as unknown as (url: string) => Promise<boolean> }),
    [],
  );
});
