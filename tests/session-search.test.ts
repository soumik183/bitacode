/**
 * Tests for the tolerant, read-only session full-text search.
 *
 * Each test gets a fresh temporary sessions directory; no home directory or
 * XDG environment variable is touched, so these tests are side-effect free.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSearchableText, searchSessions } from '../src/utils/session-search.js';
import { getLogLevel, LogLevel, onLog, setLogLevel } from '../src/utils/logger.js';

let tempDir: string;
let sessionsDir: string;

test.beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-search-test-'));
  sessionsDir = path.join(tempDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
});

test.afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function searchOptions(): { sessionsDir: string } {
  return { sessionsDir };
}

function writeSession(id: string, overrides: Record<string, unknown> = {}): void {
  const session = {
    id,
    title: 'Untitled session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    provider: 'openai',
    model: 'gpt-test',
    completionMessages: [] as unknown[],
    ...overrides,
  };
  fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(session));
}

async function hitIds(query: string, options?: { sessionsDir?: string; limit?: number; maxFiles?: number }): Promise<string[]> {
  const result = await searchSessions(query, options ?? searchOptions());
  assert.equal(result.ok, true, 'the search itself should succeed');
  return result.ok ? result.value.map((hit) => hit.sessionId) : [];
}

test('collectSearchableText reads string content and text parts', () => {
  assert.equal(collectSearchableText('plain text'), 'plain text');
  const message = {
    role: 'user',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: 'https://example.invalid/pic.png' } },
      { type: 'text', text: 'world' },
    ],
  };
  assert.equal(collectSearchableText(message), 'hello world');
});

test('collectSearchableText includes input_json_delta parts and tool call arguments', () => {
  const message = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'calling tool' },
      { type: 'input_json_delta', partial_json: '{"query":"delta"}' },
    ],
    tool_calls: [
      { id: 'c1', function: { name: 'grep', arguments: '{"pattern":"needle"}' } },
    ],
  };
  const text = collectSearchableText(message);
  assert.match(text, /calling tool/);
  assert.match(text, /delta/);
  assert.match(text, /grep/);
  assert.match(text, /needle/);
});

test('collectSearchableText drops oversized tool noise and never throws on malformed input', () => {
  const huge = `noise ${'x'.repeat(5000)} secretneedle`;
  assert.equal(collectSearchableText({ role: 'tool', content: huge }), '');
  assert.equal(collectSearchableText({ role: 'tool', content: 'small secretneedle' }), 'small secretneedle');
  assert.equal(
    collectSearchableText({
      role: 'tool',
      content: [{ type: 'tool_result', content: [{ type: 'text', text: huge }] }],
    }),
    ''
  );

  const malformed: unknown[] = [
    null,
    undefined,
    42,
    true,
    {},
    [],
    { content: { nested: 1 } },
    { content: [null, 3, {}] },
    { content: [{ type: 'text', text: 7 }] },
  ];
  for (const value of malformed) {
    assert.doesNotThrow(() => collectSearchableText(value));
  }
});

test('empty, whitespace-only, and non-string queries return an error result', async () => {
  for (const query of ['', '   \t\n ', 42, undefined]) {
    const result = await searchSessions(query as string, searchOptions());
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /empty/i);
  }
});

test('matches message text and returns a normalized snippet with role', async () => {
  writeSession('aaaaaaaa', {
    title: 'Alpha',
    completionMessages: [{ role: 'user', content: 'before\n\t needle   after' }],
  });

  const result = await searchSessions('needle', searchOptions());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.length, 1);
  assert.equal(result.value[0].sessionId, 'aaaaaaaa');
  assert.equal(result.value[0].title, 'Alpha');
  assert.equal(result.value[0].role, 'user');
  assert.match(result.value[0].snippet, /before needle after/);
  assert.doesNotMatch(result.value[0].snippet, /[\n\t]/);
  assert.ok(result.value[0].score > 0);
});

test('all whitespace-separated terms must appear, case-insensitively', async () => {
  writeSession('aaaaaaaa', {
    title: 'Both',
    completionMessages: [{ role: 'user', content: 'Alpha beta here' }],
  });
  writeSession('bbbbbbbb', {
    title: 'Only one',
    completionMessages: [{ role: 'user', content: 'Alpha only here' }],
  });

  assert.deepEqual(await hitIds('ALPHA   BETA', searchOptions()), ['aaaaaaaa']);
  assert.deepEqual(await hitIds('beta alpha', searchOptions()), ['aaaaaaaa']);
  assert.deepEqual(await hitIds('missing alpha beta', searchOptions()), []);
});

test('a title match boosts the score above a body-only match', async () => {
  writeSession('aaaaaaaa', {
    title: 'Needle discussion',
    completionMessages: [{ role: 'user', content: 'nothing relevant here' }],
  });
  writeSession('bbbbbbbb', {
    title: 'Other topic',
    completionMessages: [{ role: 'user', content: 'a needle in the text' }],
  });

  const result = await searchSessions('needle', searchOptions());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.map((hit) => hit.sessionId), ['aaaaaaaa', 'bbbbbbbb']);
  assert.ok(result.value[0].score > result.value[1].score, 'title hit should rank first');
});

test('equal scores fall back to updatedAt descending', async () => {
  writeSession('aaaaaaaa', {
    updatedAt: '2026-01-01T00:00:00.000Z',
    completionMessages: [{ role: 'user', content: 'needle' }],
  });
  writeSession('bbbbbbbb', {
    updatedAt: '2026-05-01T00:00:00.000Z',
    completionMessages: [{ role: 'user', content: 'needle' }],
  });

  assert.deepEqual(await hitIds('needle', searchOptions()), ['bbbbbbbb', 'aaaaaaaa']);
});

test('limit caps the number of hits', async () => {
  for (const id of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']) {
    writeSession(id, { completionMessages: [{ role: 'user', content: 'needle' }] });
  }
  assert.deepEqual(await hitIds('needle', { ...searchOptions(), limit: 2 }), ['aaaaaaaa', 'bbbbbbbb']);
});

test('default limit is 20', async () => {
  for (let i = 0; i < 25; i++) {
    writeSession(String(i).padStart(8, '0'), {
      completionMessages: [{ role: 'user', content: 'needle' }],
    });
  }
  const hits = await hitIds('needle', searchOptions());
  assert.equal(hits.length, 20);
});

test('maxFiles caps how many session files are scanned', async () => {
  for (const id of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']) {
    writeSession(id, { completionMessages: [{ role: 'user', content: 'needle' }] });
  }
  assert.deepEqual(await hitIds('needle', { ...searchOptions(), maxFiles: 1 }), ['aaaaaaaa']);
});

test('a missing sessions directory is an empty, non-creating result', async () => {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  const result = await searchSessions('needle', searchOptions());
  assert.deepEqual(result, { ok: true, value: [] });
  assert.equal(fs.existsSync(sessionsDir), false, 'search must not create directories');
});

test('corrupt files are skipped silently and reported through logger.debug', async () => {
  fs.writeFileSync(path.join(sessionsDir, 'bbbbbbbb.json'), '{ this is not json');
  writeSession('aaaaaaaa', { completionMessages: [{ role: 'user', content: 'needle' }] });

  const previousLevel = getLogLevel();
  const messages: string[] = [];
  const unsubscribe = onLog((entry) => messages.push(entry.message));
  setLogLevel(LogLevel.DEBUG);
  try {
    assert.deepEqual(await hitIds('needle', searchOptions()), ['aaaaaaaa']);
    assert.ok(
      messages.some((message) => message.includes('bbbbbbbb.json')),
      'the skipped file should leave a debug trace'
    );
  } finally {
    unsubscribe();
    setLogLevel(previousLevel);
  }
});

test('only safe filenames are read (path-escape resistance)', async () => {
  const secret = 'verysecretneedle';
  const outside = (name: string): Record<string, unknown> => ({
    id: 'dddddddd',
    title: 'Outside',
    completionMessages: [{ role: 'user', content: secret }],
    marker: name,
  });

  fs.writeFileSync(path.join(tempDir, 'secrets.json'), JSON.stringify(outside('parent')));
  fs.writeFileSync(path.join(sessionsDir, 'not-valid.json'), JSON.stringify(outside('bad-name')));
  const target = path.join(tempDir, 'linked.json');
  fs.writeFileSync(target, JSON.stringify(outside('symlink-target')));
  try {
    fs.symlinkSync(target, path.join(sessionsDir, 'dddddddd.json'));
  } catch {
    // Symlinks are not available on every platform; the other cases still apply.
  }

  assert.deepEqual(await hitIds(secret, searchOptions()), []);
});

test('results are defensive copies of freshly parsed data', async () => {
  writeSession('aaaaaaaa', { completionMessages: [{ role: 'user', content: 'needle here' }] });

  const first = await searchSessions('needle', searchOptions());
  assert.equal(first.ok, true);
  if (!first.ok) return;
  first.value[0].title = 'mutated';
  first.value.push({ sessionId: 'injected', title: 'injected', snippet: 'injected', score: 0 });

  const second = await searchSessions('needle', searchOptions());
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value.length, 1);
  assert.equal(second.value[0].title, 'Untitled session');
  assert.notEqual(second.value[0].title, first.value[0].title);
});
