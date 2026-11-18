import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { codesearch } from '../src/tools/codesearch.js';
import { searchDocs } from '../src/tools/search-docs.js';
import { findSymbol } from '../src/tools/find-symbol.js';
import { searchHistory } from '../src/tools/search-history.js';

// ─── codesearch / search_docs: validation only (no live network) ───

test('codesearch validates an empty query without making a request', async () => {
  assert.match(await codesearch(''), /query is required/i);
  assert.match(await codesearch('   '), /query is required/i);
  assert.match(await codesearch('x'.repeat(501)), /query too long/i);
});

test('search_docs validates query and source without making a request', async () => {
  assert.match(await searchDocs(''), /query is required/i);
  assert.match(await searchDocs('   '), /query is required/i);
  assert.match(await searchDocs('x'.repeat(501)), /query too long/i);
  assert.match(await searchDocs('ts', 'bogus' as any), /invalid source/i);
});

// ─── find_symbol ───

test('find_symbol finds a known declaration and respects the kind filter', async () => {
  const testDir = path.join(process.cwd(), 'tests', 'tmp-search-tools');
  await fs.rm(testDir, { recursive: true, force: true });
  await fs.mkdir(testDir, { recursive: true });
  await fs.writeFile(
    path.join(testDir, 'symbols.ts'),
    ['export function findMe() { return 1; }', 'export class MyClass {}', 'export type Alias = string;'].join('\n'),
    'utf8',
  );

  try {
    const func = await findSymbol('findMe', 'tests/tmp-search-tools');
    assert.match(func, /symbols\.ts:1:/);
    assert.match(func, /function findMe/);

    const classMatch = await findSymbol('MyClass', 'tests/tmp-search-tools', 'class');
    assert.match(classMatch, /symbols\.ts:2:/);

    // A function name must not match when only classes are requested.
    const wrongKind = await findSymbol('findMe', 'tests/tmp-search-tools', 'class');
    assert.match(wrongKind, /No symbol/i);

    const typeMatch = await findSymbol('Alias', 'tests/tmp-search-tools', 'type');
    assert.match(typeMatch, /symbols\.ts:3:/);
  } finally {
    await fs.rm(testDir, { recursive: true, force: true });
  }
});

// ─── search_history ───

test('search_history finds title/message matches and skips corrupt files', async () => {
  const home = path.join(process.cwd(), 'tests', 'tmp-search-home');
  const sessionsDir = path.join(home, '.local', 'share', 'bitacode', 'sessions');
  await fs.rm(home, { recursive: true, force: true });
  await fs.mkdir(sessionsDir, { recursive: true });

  const valid = {
    id: 'abcd1234',
    title: 'Alpha session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    completionMessages: [
      { role: 'user', content: 'Please remember the secret needle value.' },
    ],
  };
  await fs.writeFile(path.join(sessionsDir, 'abcd1234.json'), JSON.stringify(valid), 'utf8');
  await fs.writeFile(path.join(sessionsDir, 'corrupt.json'), '{ not valid json', 'utf8');

  try {
    const byMessage = await searchHistory('needle', home);
    assert.match(byMessage, /abcd1234 — Alpha session/);
    assert.match(byMessage, /secret needle value/);

    const byTitle = await searchHistory('alpha', home);
    assert.match(byTitle, /abcd1234 — Alpha session/);

    assert.match(await searchHistory('', home), /query is required/i);
    const none = await searchHistory('does-not-exist', home);
    assert.match(none, /No matching sessions/i);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
