import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRepoOutline, resetRepoOutlineCacheForTests } from '../src/utils/repo-outline.js';

test('repo outline lists declarations per source file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-outline-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      'export function alpha() {}\nexport const beta = 1;\n',
      'utf8',
    );
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'not source', 'utf8');

    resetRepoOutlineCacheForTests();
    const outline = await buildRepoOutline(dir, { cacheTtlMs: 0 });

    assert.match(outline, /src\/a\.ts/);
    assert.match(outline, /alpha/);
    assert.match(outline, /beta/);
    assert.doesNotMatch(outline, /readme\.txt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo outline is empty for an empty workspace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-outline-empty-'));
  try {
    resetRepoOutlineCacheForTests();
    assert.equal(await buildRepoOutline(dir, { cacheTtlMs: 0 }), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
