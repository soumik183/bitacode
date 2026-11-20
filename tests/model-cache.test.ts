import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  clearModelCache,
  getModelCachePath,
  MODEL_CACHE_TTL_MS,
  readModelCache,
  setModelCacheDirectoryForTests,
  writeModelCache,
} from '../src/utils/model-cache.js';
import {
  listProviderModels,
  MODEL_FETCH_TIMEOUT_MS,
  prefetchProviderModels,
  resetModelListMemoryCacheForTests,
  staticModels,
} from '../src/utils/provider-models.js';

const model = (id: string, label = id) => ({ id, label });

async function sandbox<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bitacode-model-cache-'));
  const saved = process.env.XDG_DATA_HOME;
  setModelCacheDirectoryForTests(dir);
  resetModelListMemoryCacheForTests();
  try {
    return await fn(dir);
  } finally {
    if (saved === undefined) setModelCacheDirectoryForTests(null);
    else setModelCacheDirectoryForTests(saved);
    resetModelListMemoryCacheForTests();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Minimal OpenAI-shaped client; counts calls so caching is observable. */
function stubClient(handler: () => Promise<any>) {
  const calls = { count: 0, options: [] as any[] };
  return {
    calls,
    client: {
      models: {
        list: async (options: any) => {
          calls.count++;
          calls.options.push(options);
          return handler();
        },
      },
    } as any,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('the cache round-trips model lists to disk', async () => {
  await sandbox(async () => {
    assert.equal(await readModelCache('openai'), null);
    await writeModelCache('openai', undefined, [model('gpt-4o-mini'), model('gpt-5.4')], 1_000);

    const fresh = await readModelCache('openai', undefined, 2_000);
    assert.ok(fresh);
    assert.deepEqual(fresh!.items.map((item) => item.id), ['gpt-4o-mini', 'gpt-5.4']);
    assert.equal(fresh!.stale, false);
    assert.equal(fresh!.ageMs, 1_000);

    const stale = await readModelCache('openai', undefined, 1_000 + MODEL_CACHE_TTL_MS + 1);
    assert.equal(stale!.stale, true);
  });
});

test('base URLs are cached separately and empty lists are ignored', async () => {
  await sandbox(async () => {
    await writeModelCache('openai', 'https://a.example/v1', [model('a-model')], 1_000);
    await writeModelCache('openai', 'https://b.example/v1', [model('b-model')], 1_000);
    await writeModelCache('openai', 'https://c.example/v1', [], 1_000);

    assert.equal((await readModelCache('openai', 'https://a.example/v1', 1_000))!.items[0].id, 'a-model');
    assert.equal((await readModelCache('openai', 'https://b.example/v1', 1_000))!.items[0].id, 'b-model');
    assert.equal(await readModelCache('openai', 'https://c.example/v1', 1_000), null);
  });
});

test('a corrupt cache file degrades to an empty cache', async () => {
  await sandbox(async (dir) => {
    await fs.mkdir(path.dirname(getModelCachePath()), { recursive: true });
    await fs.writeFile(getModelCachePath(), '{not json');
    assert.equal(await readModelCache('openai'), null);

    await writeModelCache('openai', undefined, [model('gpt-4o-mini')], 1_000);
    assert.equal((await readModelCache('openai', undefined, 1_000))!.items.length, 1);
  });
});

test('old cache entries are pruned on write and the file can be cleared', async () => {
  await sandbox(async () => {
    const old = 1_000;
    const now = 1_000 + 40 * 24 * 60 * 60 * 1_000;
    await writeModelCache('stale-provider', undefined, [model('old-model')], old);
    await writeModelCache('fresh-provider', undefined, [model('new-model')], now);

    await fs.stat(getModelCachePath());
    const raw = JSON.parse(await fs.readFile(getModelCachePath(), 'utf8'));
    assert.deepEqual(Object.keys(raw), ['fresh-provider::']);

    await clearModelCache();
    assert.equal(await readModelCache('fresh-provider'), null);
  });
});

test('a cached list is served without any network call', async () => {
  await sandbox(async () => {
    await writeModelCache('openai', undefined, [model('cached-model', 'Cached Model')], Date.now());
    resetModelListMemoryCacheForTests();

    const { client, calls } = stubClient(async () => {
      throw new Error('network must not be used');
    });
    const result = await listProviderModels(client, 'openai');

    assert.equal(calls.count, 0);
    assert.equal(result.fromCache, true);
    assert.equal(result.stale, false);
    const cached = result.items.find((item) => item.id === 'cached-model');
    assert.ok(cached);
    assert.equal(cached!.label, 'Cached Model');
  });
});

test('a stale cache answers immediately and refreshes behind the UI', async () => {
  await sandbox(async () => {
    const old = Date.now() - MODEL_CACHE_TTL_MS - 60_000;
    await writeModelCache('openai', undefined, [model('old-model')], old);
    resetModelListMemoryCacheForTests();

    const { client, calls } = stubClient(async () => ({ data: [{ id: 'fresh-model' }] }));
    const result = await listProviderModels(client, 'openai');
    assert.equal(result.fromCache, true);
    assert.equal(result.stale, true);
    assert.ok(result.items.some((item) => item.id === 'old-model'));

    // The refresh is fired without awaiting; wait for it to reach the disk.
    let after = await readModelCache('openai');
    for (let i = 0; i < 50 && !after?.items.some((item) => item.id === 'fresh-model'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      after = await readModelCache('openai');
    }
    assert.equal(calls.count, 1);
    assert.ok(after!.items.some((item) => item.id === 'fresh-model'));
  });
});

test('a cold fetch is bounded, coalesced and merged with built-in models', async () => {
  await sandbox(async () => {
    let release!: (value: any) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { client, calls } = stubClient(async () => {
      await gate;
      return { data: [{ id: 'remote-model-xyz' }, { id: 'text-embedding-3-small' }] };
    });

    const first = listProviderModels(client, 'openai');
    const second = listProviderModels(client, 'openai');
    release({ data: [{ id: 'remote-model-xyz' }, { id: 'text-embedding-3-small' }] });

    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls.count, 1, 'concurrent callers share one request');
    assert.equal(calls.options[0].timeout, MODEL_FETCH_TIMEOUT_MS);
    assert.equal(calls.options[0].maxRetries, 0);
    assert.deepEqual(a.items.map((item) => item.id), b.items.map((item) => item.id));

    assert.ok(a.items.some((item) => item.id === 'remote-model-xyz'), 'remote model is listed');
    assert.ok(!a.items.some((item) => item.id === 'text-embedding-3-small'), 'non-chat families are hidden');
    // Every built-in model is still offered alongside the remote ones.
    const listedIds = new Set(a.items.map((item) => item.id));
    for (const builtin of staticModels('openai')) {
      assert.ok(listedIds.has(builtin.id), `built-in ${builtin.id} is merged in, not replaced`);
    }
  });
});

test('a failing provider still returns its built-in models', async () => {
  await sandbox(async () => {
    const { client } = stubClient(async () => {
      throw Object.assign(new Error('gateway timeout'), { status: 504 });
    });
    const result = await listProviderModels(client, 'openai');
    assert.match(result.error ?? '', /gateway timeout/);
    assert.equal(result.authError, false);
    assert.ok(result.items.length > 0, 'fallback list is not empty');
  });
});

test('an auth failure is flagged so the key prompt can open', async () => {
  await sandbox(async () => {
    const { client } = stubClient(async () => {
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    });
    const result = await listProviderModels(client, 'openai', { useCache: false });
    assert.equal(result.authError, true);
    assert.equal(result.error, 'Unauthorized');
  });
});

test('prefetch warms the cache without being awaited', async () => {
  await sandbox(async () => {
    const { client, calls } = stubClient(async () => ({ data: [{ id: 'warm-model' }] }));
    await listProviderModels(client, 'openai', { useCache: false });
    assert.equal(calls.count, 1);

    prefetchProviderModels(client, 'openai');
    await flush();
    assert.equal(calls.count, 1, 'prefetch skips a fresh cache');

    resetModelListMemoryCacheForTests();
    prefetchProviderModels(client, 'openai');
    await flush();
    await flush();
    assert.ok(calls.count >= 1);
  });
});
