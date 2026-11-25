import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  accountStorePath,
  activeAccount,
  addAccount,
  exportAccounts,
  importAccounts,
  loadAccounts,
  redactAccount,
  saveAccounts,
  switchAccount,
  type AccountRecord,
} from '../src/utils/accounts.js';
import { LogLevel, onLog } from '../src/utils/logger.js';

function withTempHome<T>(run: (home: string, file: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-accounts-test-'));
  const savedHome = process.env.HOME;
  const savedXdg = process.env.XDG_DATA_HOME;
  process.env.HOME = home;
  delete process.env.XDG_DATA_HOME;
  try {
    return run(home, accountStorePath(home));
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedXdg;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function record(id: string, apiKey: string): AccountRecord {
  return {
    id,
    provider: 'openai',
    label: `label-${id}`,
    apiKey,
    createdAt: '2024-01-02T03:04:05.000Z',
  };
}

function loadedAccounts(): AccountRecord[] {
  const loaded = loadAccounts();
  return loaded.ok ? loaded.value : [];
}

function activeId(): string | undefined {
  const active = activeAccount();
  return active.ok ? active.value?.id : undefined;
}

function activeLabel(): string | undefined {
  const active = activeAccount();
  return active.ok ? active.value?.label : undefined;
}

test('accountStorePath uses home by default and XDG_DATA_HOME when set', () => {
  withTempHome((home, file) => {
    assert.equal(file, path.join(home, '.local', 'share', 'bitacode', 'accounts.json'));
    const saved = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(home, 'xdg');
    try {
      assert.equal(accountStorePath(home), path.join(home, 'xdg', 'bitacode', 'accounts.json'));
    } finally {
      if (saved === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = saved;
    }
  });
});

test('a missing store loads as empty and is created with an empty account list', () => {
  withTempHome((_home, file) => {
    const loaded = loadAccounts();
    assert.deepEqual(loaded, { ok: true, value: [] });
    assert.ok(fs.existsSync(file));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).accounts, []);
    assert.deepEqual(activeAccount(), { ok: true, value: undefined });
  });
});

test('save/load round-trips all account fields', () => {
  withTempHome(() => {
    const accounts: AccountRecord[] = [
      {
        ...record('alpha', 'sk-alpha'),
        headers: { 'x-api-key': 'header-secret', Authorization: 'Bearer token' },
        baseURL: 'https://api.example.com/v1',
      },
      record('beta', 'sk-beta'),
    ];
    assert.deepEqual(saveAccounts(accounts), { ok: true, value: undefined });
    const loaded = loadAccounts();
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.ok ? loaded.value : [], accounts);
  });
});

test('a corrupt store is reported with its path and never overwritten', () => {
  withTempHome((_home, file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const before = fs.readFileSync(file, 'utf8');

    for (const result of [
      loadAccounts(),
      saveAccounts([]),
      addAccount({ provider: 'openai', label: 'work', apiKey: 'sk' }),
      switchAccount('alpha'),
      activeAccount(),
      exportAccounts(),
      exportAccounts({ includeSecrets: true }),
      importAccounts('[]'),
    ]) {
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.error, /accounts\.json/);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['accounts.json']);
  });
});

test('writes are atomic and leave no temp files behind', () => {
  withTempHome((_home, file) => {
    assert.equal(addAccount({ provider: 'openai', label: 'work', apiKey: 'sk-1' }).ok, true);
    assert.equal(addAccount({ provider: 'anthropic', label: 'other', apiKey: 'sk-2' }).ok, true);
    assert.equal(saveAccounts(loadedAccounts()).ok, true);
    const entries = fs.readdirSync(path.dirname(file));
    assert.deepEqual(entries, ['accounts.json']);
  });
});

test('invalid slugs and missing credentials are rejected', () => {
  withTempHome(() => {
    const invalidInputs = [
      { provider: 'bad provider', label: 'work', apiKey: 'sk' },
      { provider: 'openai', label: 'bad label!', apiKey: 'sk' },
      { provider: 'openai', label: 'work' },
      { provider: 'openai', label: 'work', apiKey: '' },
      { provider: 'openai', label: 'work', headers: {} },
    ];
    for (const input of invalidInputs) {
      const result = addAccount(input);
      assert.equal(result.ok, false, `expected failure for ${JSON.stringify(input)}`);
    }
    assert.equal(saveAccounts([{ ...record('bad id', 'sk'), provider: 'openai' }]).ok, false);
    assert.equal(saveAccounts([record('dup', 'a'), record('dup', 'b')]).ok, false);
    assert.equal(switchAccount('bad id').ok, false);
    assert.deepEqual(loadAccounts(), { ok: true, value: [] });
  });
});

test('header values above 8 KB are rejected while smaller values are accepted', () => {
  withTempHome(() => {
    assert.equal(
      addAccount({ provider: 'openai', label: 'huge', headers: { 'x-key': 'x'.repeat(9000) } }).ok,
      false
    );
    const ok = addAccount({ provider: 'openai', label: 'fine', headers: { 'x-key': 'x'.repeat(8192) } });
    assert.equal(ok.ok, true);
  });
});

test('the store rejects more than 64 accounts', () => {
  withTempHome(() => {
    for (let i = 0; i < 64; i++) {
      assert.equal(addAccount({ provider: 'openai', label: `acct-${i}`, apiKey: `sk-${i}` }).ok, true);
    }
    assert.equal(addAccount({ provider: 'openai', label: 'overflow', apiKey: 'sk-x' }).ok, false);
    assert.equal(loadedAccounts().length, 64);

    const tooMany = Array.from({ length: 65 }, (_, i) => record(`id-${i}`, `sk-${i}`));
    assert.equal(saveAccounts(tooMany).ok, false);
  });
});

test('load drops invalid entries and logs warnings while keeping valid ones', () => {
  withTempHome((_home, file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      activeId: 'ghost',
      accounts: [
        record('good', 'sk-good'),
        { id: 'bad id', provider: 'openai', label: 'x', apiKey: 'sk' },
        { id: 'nocreds', provider: 'openai', label: 'x' },
        { ...record('good', 'sk-duplicate'), label: 'duplicate' },
      ],
    }));

    const warnings: string[] = [];
    const unsubscribe = onLog((entry) => {
      if (entry.level === LogLevel.WARN) warnings.push(entry.message);
    });
    let loaded;
    let active;
    try {
      loaded = loadAccounts();
      active = activeAccount();
    } finally {
      unsubscribe();
    }

    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.ok ? loaded.value.map((a) => a.id) : [], ['good']);
    assert.equal(loaded.ok ? loaded.value[0].apiKey : undefined, 'sk-good');
    assert.equal(active.ok ? active.value?.id : undefined, 'good');
    assert.ok(warnings.some((message) => message.includes('dropping invalid entry')));
    assert.ok(warnings.some((message) => message.includes('dropping duplicate id')));
  });
});

test('the first account becomes active and later adds keep the choice', () => {
  withTempHome(() => {
    const first = addAccount({ provider: 'openai', label: 'first', apiKey: 'sk-first' });
    assert.equal(first.ok, true);
    assert.equal(activeId(), first.ok ? first.value.id : '');

    assert.equal(addAccount({ provider: 'anthropic', label: 'second', apiKey: 'sk-second' }).ok, true);
    assert.equal(activeLabel(), 'first');
  });
});

test('switchAccount activates an existing id and rejects unknown ids', () => {
  withTempHome(() => {
    const a = addAccount({ provider: 'openai', label: 'a', apiKey: 'sk-a' });
    const b = addAccount({ provider: 'openai', label: 'b', apiKey: 'sk-b' });
    assert.equal(a.ok && b.ok, true);
    const id = b.ok ? b.value.id : '';

    assert.deepEqual(switchAccount(id), b);
    assert.equal(activeId(), id);
    assert.equal(switchAccount('missing-account').ok, false);
    assert.equal(activeId(), id);
    assert.equal(switchAccount('../etc/passwd').ok, false);
  });
});

test('exportAccounts redacts by default and includeSecrets reveals credentials', () => {
  withTempHome((_home, file) => {
    const added = addAccount({
      provider: 'openai',
      label: 'exported',
      apiKey: 'sk-secret',
      headers: { 'x-api-key': 'header-secret', 'x-tenant': 'tenant-secret' },
      baseURL: 'https://api.example.com',
    });
    assert.equal(added.ok, true);

    const redacted = exportAccounts();
    assert.equal(redacted.ok, true);
    const redactedJson = redacted.ok ? JSON.parse(redacted.value) : [];
    assert.equal(Array.isArray(redactedJson), true);
    assert.equal(redactedJson[0].apiKey, '***');
    assert.deepEqual(redactedJson[0].headers, { 'x-api-key': '***', 'x-tenant': '***' });
    assert.equal(redactedJson[0].baseURL, 'https://api.example.com');

    const withSecrets = exportAccounts({ includeSecrets: true });
    assert.equal(withSecrets.ok, true);
    const secretJson = withSecrets.ok ? JSON.parse(withSecrets.value) : [];
    assert.equal(secretJson[0].apiKey, 'sk-secret');
    assert.equal(secretJson[0].headers['x-api-key'], 'header-secret');

    const onDisk = fs.readFileSync(file, 'utf8');
    assert.match(onDisk, /sk-secret/);
    assert.doesNotMatch(onDisk, /\*\*\*/);
  });
});

test('redactAccount keeps names and metadata without mutating the input', () => {
  const original: AccountRecord = {
    id: 'acct',
    provider: 'openai',
    label: 'work',
    apiKey: 'sk-secret',
    headers: { Authorization: 'Bearer secret' },
    baseURL: 'https://example.com',
    createdAt: '2024-01-01T00:00:00.000Z',
  };
  const redacted = redactAccount(original);
  assert.equal(redacted.apiKey, '***');
  assert.deepEqual(redacted.headers, { Authorization: '***' });
  assert.equal(redacted.baseURL, original.baseURL);
  assert.equal(redacted.createdAt, original.createdAt);
  assert.equal(redacted.id, original.id);
  assert.notEqual(redacted, original);
  assert.equal(original.apiKey, 'sk-secret');
  assert.equal(original.headers?.Authorization, 'Bearer secret');
  assert.equal(redactAccount(record('no-key', 'x')).headers, undefined);
});

test('importAccounts merges by id, first wins, and counts only new records', () => {
  withTempHome(() => {
    const first = addAccount({ provider: 'openai', label: 'existing', apiKey: 'sk-existing' });
    assert.equal(first.ok, true);
    const firstId = first.ok ? first.value.id : '';
    const json = JSON.stringify([
      { ...record(firstId, 'sk-overwrite'), label: 'overwrite' },
      record('imported-b', 'sk-b-first'),
      { ...record('imported-b', 'sk-b-second'), label: 'later' },
    ]);

    const result = importAccounts(json);
    assert.deepEqual(result, { ok: true, value: 1 });
    const accounts = loadedAccounts();
    assert.equal(accounts.length, 2);
    assert.equal(accounts.find((a) => a.id === firstId)?.apiKey, 'sk-existing');
    assert.equal(accounts.find((a) => a.id === 'imported-b')?.apiKey, 'sk-b-first');
    assert.equal(activeId(), firstId);
  });
});

test('importAccounts rejects malformed JSON without touching the store', () => {
  withTempHome((_home, file) => {
    assert.equal(addAccount({ provider: 'openai', label: 'work', apiKey: 'sk-keep' }).ok, true);
    const before = fs.readFileSync(file, 'utf8');

    for (const bad of ['{not json', '{"accounts":{}}', '"just a string"']) {
      const result = importAccounts(bad);
      assert.equal(result.ok, false);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['accounts.json']);
  });
});

test('importing into an empty store activates the first imported account', () => {
  withTempHome(() => {
    const json = JSON.stringify([record('one', 'sk-1'), record('two', 'sk-2')]);
    assert.deepEqual(importAccounts(json), { ok: true, value: 2 });
    assert.equal(activeId(), 'one');
  });
});

test('saveAccounts keeps a valid active choice and falls back when it disappears', () => {
  withTempHome(() => {
    const a = addAccount({ provider: 'openai', label: 'a', apiKey: 'sk-a' });
    const b = addAccount({ provider: 'openai', label: 'b', apiKey: 'sk-b' });
    assert.equal(a.ok && b.ok, true);
    const idA = a.ok ? a.value.id : '';
    const idB = b.ok ? b.value.id : '';

    assert.equal(switchAccount(idB).ok, true);
    assert.equal(saveAccounts([record(idA, 'sk-a'), record(idB, 'sk-b')]).ok, true);
    assert.equal(activeId(), idB);

    assert.equal(saveAccounts([record(idA, 'sk-a')]).ok, true);
    assert.equal(activeId(), idA);
  });
});

test('POSIX permissions restrict the store directory and file', { skip: process.platform === 'win32' }, () => {
  withTempHome((_home, file) => {
    assert.equal(saveAccounts([record('perm', 'sk-perm')]).ok, true);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, DIR_MODE);
    assert.equal(fs.statSync(file).mode & 0o777, FILE_MODE);
  });
});

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
